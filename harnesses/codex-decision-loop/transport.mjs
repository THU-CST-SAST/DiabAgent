import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const TRANSPORT_DUMMY='offline-dummy-not-a-credential';
const sha=s=>createHash('sha256').update(s).digest('hex');
export const redactCodexTransport=(value,key)=>
  (key?String(value).split(key).join('[REDACTED]'):String(value)).replace(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g,'[REDACTED]');
export function classifyCodexGatewayError(text,status=null){
  if([429,500,502,503,504,524].includes(status)&&text.trim()==='error code: '+status)return {empty:true,permanent:false};
  let payload;try{payload=JSON.parse(text);}catch{return {empty:false,permanent:false};}
  const error=payload?.error;
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||!error||typeof error!=='object'||Array.isArray(error))return {empty:false,permanent:false};
  const permanent=/insufficient[_ ]quota|quota[_ ]exceeded|authentication|permission|forbidden|unauthori[sz]ed|credit[_ ]balance|insufficient[_ ]balance|insufficient credits|out of credits|余额不足|额度不足/i.test(JSON.stringify(error));
  const top=Object.keys(payload).every(k=>['error','request_id','type'].includes(k))&&(payload.type===undefined||payload.type==='error')&&(payload.request_id===undefined||payload.request_id===null||typeof payload.request_id==='string');
  const fields=Object.entries(error).every(([k,v])=>['code','type','message','param','request_id','retry_after'].includes(k)&&(v===null||['string','number','boolean'].includes(typeof v)));
  const empty=top&&fields&&!/response\.output_item|response\.completed|content_block_start|"tool_use"|"function_call"/.test(text);
  return {empty,permanent};
}

/** The native request is retained verbatim; the provider wire receives the registered cap. */
export function cappedCodexBody(native,{model='gpt-6.1-sol',maxTokens=16384}={}){
  assert.equal(native.model,model);assert.equal(native.reasoning?.effort,'high');assert.equal(native.stream,true);
  assert.equal(maxTokens,16384,'Only the registered main output cap is supported');
  assert(native.max_output_tokens===undefined||native.max_output_tokens===maxTokens,'Native cap changed');
  return {...native,max_output_tokens:maxTokens};
}

export function adaptCodexWire(native,toolPolicy=null,{instructions=null,model='gpt-6.1-sol'}={}){
  const body=structuredClone(cappedCodexBody(native,{model})),changes=native.max_output_tokens===undefined?['max_output_tokens']:[];
  if(instructions!==null){
    assert(typeof instructions==='string'&&instructions.length>0);
    const same=body.input.filter(i=>i.type==='message'&&i.role==='developer'&&i.content?.length===1&&i.content[0].text===instructions);
    assert.equal(same.length,1,'Exactly one original system message must be promoted, not duplicated');
    assert(native.instructions===undefined||native.instructions===instructions);
    body.instructions=instructions;body.input=body.input.filter(i=>i!==same[0]);changes.push('instructions','input');
  }
  if(toolPolicy){
    const seen=[];
    function visit(tools,prefix){
      for(let i=0;i<tools.length;i++){
        const tool=tools[i],at=prefix+'.'+i;
        if(tool.type==='namespace'){visit(tool.tools,at+'.tools');continue;}
        assert.equal(tool.type,'function');const policy=toolPolicy.find(t=>t.name===tool.name);assert(policy,'Unregistered native tool: '+tool.name);seen.push(tool.name);
        assert.equal(tool.description,policy.description);
        // Codex's dynamic-tool parser compacts large schemas and infers typeless numeric enums as
        // strings. Restore the original registered compiler output, never infer action parameters.
        if(JSON.stringify(tool.parameters)!==JSON.stringify(policy.input_schema)){
          tool.parameters=structuredClone(policy.input_schema);changes.push(at+'.parameters');
        }
        if(tool.strict!==policy.strict){tool.strict=policy.strict;changes.push(at+'.strict');}
      }
    }
    if(body.tools)visit(body.tools,'tools');
    for(let i=0;i<body.input.length;i++)if(body.input[i].type==='additional_tools')visit(body.input[i].tools,'input.'+i+'.tools');
    assert.deepEqual(seen.sort(),toolPolicy.map(t=>t.name).sort(),'Native tool set differs from the registered controller');
  }
  return {body,changes};
}

export async function startCodexTransport({root,key,endpoint='https://api.openai.com/v1',guard=()=>{},onResponse=()=>{},onFailure=()=>{},onWait=()=>{},offline=false,toolPolicy=null,instructions=null,waitDelaysMs=null,model='gpt-6.1-sol'}){
  assert(!fs.existsSync(root),'Transport evidence is append-only, never replace an attempt');
  const upstreamBase=new URL(endpoint);assert(!upstreamBase.username&&!upstreamBase.password&&!upstreamBase.search&&!upstreamBase.hash);
  assert(upstreamBase.protocol==='https:'||offline&&upstreamBase.protocol==='http:'&&['127.0.0.1','localhost'].includes(upstreamBase.hostname));
  assert(typeof key==='string'&&key.length>0);if(offline)assert.equal(key,TRANSPORT_DUMMY);
  fs.mkdirSync(root,{recursive:true});let closed=false,sequence=0;
  assert(!waitDelaysMs||offline,'Custom backoff is offline qualification only');
  const delays=waitDelaysMs??[60000,120000,240000,480000,600000];assert(delays.length&&delays.every(n=>Number.isInteger(n)&&n>0));
  const active=new Set(),timers=new Set(),redact=s=>redactCodexTransport(s,key);
  const save=(file,s)=>fs.writeFileSync(root+'/'+file,redact(typeof s==='string'?s:JSON.stringify(s,null,2)));
  save('REGISTRATION.json',{version:'official-codex-output-cap-transport/v3',endpoint,model,max_output_tokens:16384,body_changes:['max_output_tokens',...(toolPolicy?['restore registered function parameter schemas and strict flags']:[]),...(instructions?['promote exact registered system to instructions, without duplication']:[])],toolPolicy,instructions,native_CLI_owns_model_loop:true,response_rewriting:false,credential_transport:'memory and upstream Authorization header only'});
  const server=http.createServer(async(req,res)=>{
    const n=++sequence,started=Date.now();let native,body;
    try{
      assert(!closed);assert.equal(req.method,'POST');assert.equal(req.url,'/v1/responses');
      assert.equal(req.headers.authorization,'Bearer '+TRANSPORT_DUMMY);
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;assert(size<=16777216,'Request exceeds bounded transport input');chunks.push(chunk);}
      const bytes=Buffer.concat(chunks);save(n+'-NATIVE-BYTES.txt',bytes.toString());native=JSON.parse(bytes);save(n+'-NATIVE-REQUEST.json',native);const adapted=adaptCodexWire(native,toolPolicy,{instructions,model});body=adapted.body;guard(native,n);
      save(n+'-NATIVE-REQUEST.json',native);save(n+'-UPSTREAM-REQUEST.json',body);
      const restored=structuredClone(body);
      for(const at of adapted.changes){const keys=at.split('.');let old=native,destination=restored;for(const k of keys.slice(0,-1)){old=old[k];destination=destination[k];}const last=keys.at(-1);if(Object.hasOwn(old,last))destination[last]=old[last];else delete destination[last];}
      assert.deepEqual(restored,native);
      save(n+'-BODY-DELTA.json',{native_sha256:sha(JSON.stringify(native)),upstream_sha256:sha(JSON.stringify(body)),changed_fields:adapted.changes,inserted_cap:body.max_output_tokens,all_other_fields_exact:true});
    }catch(e){save(n+'-REJECTED.json',{reason:e.message});onFailure(Object.assign(new Error('Local native request guard rejected request; original evidence retained'),{code:'CODEX_NATIVE_REQUEST_GUARD',retryable:false}));res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'benchmark_request_guard',message:'Native request did not match the registered benchmark contract'}}));return;}
    const target=new URL(upstreamBase.href.replace(/\/$/,'')+'/responses');
    const owner=target.protocol==='https:'?https:http;
    let attempt=0,abandoned=false,retryTimer;
    res.on('close',()=>{abandoned=true;if(retryTimer){clearTimeout(retryTimer);timers.delete(retryTimer);}});
    const dispatch=()=>{
    if(closed||abandoned)return;const currentAttempt=++attempt;
    onWait({phase:'request-start',native_request:n,attempt:currentAttempt});
    const forwarded=owner.request(target,{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json',accept:'text/event-stream'}},up=>{
      if([429,500,502,503,504,524].includes(up.statusCode)){
        const chunks=[];let bytes=0;
        up.on('data',c=>{bytes+=c.length;if(bytes>1048576){up.destroy();return;}chunks.push(c);});
        up.on('error',()=>res.destroy());
        up.on('end',()=>{
          const text=Buffer.concat(chunks).toString(),classification=classifyCodexGatewayError(text,up.statusCode),permanent=classification.permanent,emptyError=classification.empty;
          save(n+'-ATTEMPT-'+currentAttempt+'.json',{status:up.statusCode,response:text,complete:true,empty_error_body_confirmed:!!emptyError,permanent:!!permanent,request_sha256:sha(JSON.stringify(body))});
          if(emptyError&&!permanent&&!closed&&!abandoned){
            const delay_ms=delays[Math.min(currentAttempt-1,delays.length-1)],event={phase:'waiting',native_request:n,attempt:currentAttempt,status:up.statusCode,delay_ms,at:new Date().toISOString()};
            fs.appendFileSync(root+'/GATEWAY-WAIT.jsonl',JSON.stringify(event)+'\n');onWait(event);
            retryTimer=setTimeout(()=>{timers.delete(retryTimer);retryTimer=null;if(closed||abandoned)return;onWait({...event,phase:'retry'});dispatch();},delay_ms);timers.add(retryTimer);return;
          }
          save(n+'-RESPONSE.txt',text);const witness={status:up.statusCode,complete:true,started_ms:started,elapsed_ms:Date.now()-started,response_bytes:bytes,response_sha256:sha(text)};save(n+'-RESPONSE.json',witness);
          try{onResponse({native,body,text,...witness});}catch(e){onFailure(e);}
          res.writeHead(up.statusCode,{'content-type':up.headers['content-type']??'application/json'});res.end(text);
        });return;
      }
      res.writeHead(up.statusCode,{'content-type':up.headers['content-type']??'application/json',...(up.headers['retry-after']?{'retry-after':up.headers['retry-after']}:{})});
      const chunks=[];let size=0,finished=false;
      const persist=complete=>{if(finished)return;finished=true;const text=Buffer.concat(chunks).toString();save(n+'-RESPONSE.txt',text);const witness={status:up.statusCode,complete,started_ms:started,elapsed_ms:Date.now()-started,response_bytes:size,response_sha256:sha(text)};save(n+'-RESPONSE.json',witness);try{onResponse({native,body,text,...witness});}catch(e){save(n+'-CALLBACK-ERROR.json',{message:e.message});onFailure(e);}};
      up.on('data',chunk=>{size+=chunk.length;chunks.push(chunk);if(size>67108864){up.destroy(new Error('Bounded response storage exceeded'));return;}res.write(chunk);});
      up.on('end',()=>{persist(true);res.end();});
      up.on('error',()=>{persist(false);res.destroy();});
      up.on('aborted',()=>{persist(false);res.destroy();});
      res.on('close',()=>{if(!up.complete)up.destroy();});
    });
    active.add(forwarded);forwarded.on('close',()=>active.delete(forwarded));
    forwarded.on('error',e=>{save(n+'-NETWORK-ERROR.json',{code:e.code??null,message:e.message,elapsed_ms:Date.now()-started});if(!res.headersSent){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'upstream_transport_error',message:'Upstream transport failed; original request evidence retained'}}));}else res.destroy();});
    forwarded.end(JSON.stringify(body));
    };dispatch();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {endpoint:'http://127.0.0.1:'+server.address().port+'/v1',get requests(){return sequence;},async close(){if(closed)return;closed=true;for(const timer of timers)clearTimeout(timer);timers.clear();for(const request of active)request.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));key='';}};
}
