import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {startCodexTransport,cappedCodexBody,adaptCodexWire,classifyCodexGatewayError,redactCodexTransport,TRANSPORT_DUMMY} from '../harnesses/codex-decision-loop/transport.mjs';
const native={model:'gpt-6.1-sol',reasoning:{effort:'high'},stream:true,input:[{type:'message',role:'developer',content:[{type:'input_text',text:'Exact research system'}]}]};
test('credential redaction never truncates an embedded sk- sequence in opaque encrypted reasoning or task words',()=>{
 const cipher='gAAAAA-original-sk-opaque_long_encrypted_content',word='task-specific-protocol-bookkeeping';
 assert.equal(redactCodexTransport(cipher,'private-fixture-key'),cipher);assert.equal(redactCodexTransport(word,'private-fixture-key'),word);
 assert.equal(redactCodexTransport('before private-fixture-key after','private-fixture-key'),'before [REDACTED] after');
 assert.equal(redactCodexTransport('token=sk-synthetic_not_a_real_credential','private-fixture-key'),'token=[REDACTED]');
});
test('only a complete unambiguous error-only body qualifies for unlimited gateway wait',()=>{
 const error={type:'api_error',message:'Temporary gateway failure'};
 assert.deepEqual(classifyCodexGatewayError(JSON.stringify({error})),{empty:true,permanent:false});
 assert.equal(classifyCodexGatewayError(JSON.stringify({error,request_id:'provider-error-1'})).empty,true);
 for(const request_id of [{output:'Unadopted'},['Unadopted'],42])assert.equal(classifyCodexGatewayError(JSON.stringify({error,request_id})).empty,false);
 for(const payload of [{error,output:[{type:'message',content:'Unadopted real output'}]},{error,choices:[{message:{content:'Unadopted'}}]},{error:{...error,details:{output:'Unadopted'}}},{type:'response',error}])assert.equal(classifyCodexGatewayError(JSON.stringify(payload)).empty,false);
 assert.equal(classifyCodexGatewayError('{incomplete').empty,false);
 assert.deepEqual(classifyCodexGatewayError('error code: 524\n',524),{empty:true,permanent:false});
 for(const status of [429,500,502,503,504,524])assert.deepEqual(classifyCodexGatewayError('error code: '+status+'\n',status),{empty:true,permanent:false});
 assert.equal(classifyCodexGatewayError('error code: 524\npartial output',524).empty,false);assert.equal(classifyCodexGatewayError('error code: 524\n',502).empty,false);
 assert.equal(classifyCodexGatewayError(JSON.stringify({error:{code:'insufficient_quota',message:'Quota exceeded'}})).permanent,true);
});
test('cap adapter changes exactly one missing field; rejects changed model, effort or cap',()=>{
  const result=cappedCodexBody(native);assert.deepEqual(result,{...native,max_output_tokens:16384});assert(!Object.hasOwn(native,'max_output_tokens'));
  for(const bad of [{...native,model:'other'},{...native,reasoning:{effort:'low'}},{...native,max_output_tokens:32768},{...native,stream:false}])assert.throws(()=>cappedCodexBody(bad));
});
test('registered tool schema restoration preserves numeric enums, descriptions and strict generation after native compaction',()=>{
 const schema={type:'object',properties:{minutes:{enum:[15,30],type:'integer',description:'Original minutes'}}};
 const original={...native,tools:[{type:'function',name:'act',description:'Original act',strict:false,parameters:{type:'object',properties:{minutes:{type:'string',enum:[15,30]}}}}]};
 const {body,changes}=adaptCodexWire(original,[{name:'act',description:'Original act',strict:true,input_schema:schema}]);
 assert.deepEqual(body.tools[0].parameters,schema);assert(body.tools[0].strict);assert.deepEqual(changes,['max_output_tokens','tools.0.parameters','tools.0.strict']);
 assert.throws(()=>adaptCodexWire({...original,tools:[{...original.tools[0],name:'exec'}]},[{name:'act',description:'Original act',strict:true,input_schema:schema}]));
});
test('promote only the exact registered system, suppress provider defaults and never duplicate it',()=>{
 const {body,changes}=adaptCodexWire(native,null,{instructions:'Exact research system'});
 assert.equal(body.instructions,'Exact research system');assert.deepEqual(body.input,[]);
 assert.deepEqual(changes,['max_output_tokens','instructions','input']);assert.equal(native.input.length,1);
 assert.throws(()=>adaptCodexWire(native,null,{instructions:'Different prompt'}));
 assert.throws(()=>adaptCodexWire({...native,instructions:'Foreign system'},null,{instructions:'Exact research system'}));
});
test('native transport forwards bounded request and upstream response exactly, without leaking credentials',async()=>{
  const roots=fs.mkdtempSync(path.join(os.tmpdir(),'codex-cap-'));let seen;
  const response='event: response.created\ndata: {"test":"original"}\n\n';
  const upstream=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);seen={path:req.url,body:JSON.parse(Buffer.concat(chunks)),auth:req.headers.authorization};res.writeHead(200,{'content-type':'text/event-stream'});res.end(response);});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const bridge=await startCodexTransport({root:roots+'/transport',key:TRANSPORT_DUMMY,endpoint:'http://127.0.0.1:'+upstream.address().port+'/v1',offline:true});
  try{
    const r=await fetch(bridge.endpoint+'/responses',{method:'POST',headers:{authorization:'Bearer '+TRANSPORT_DUMMY,'content-type':'application/json'},body:JSON.stringify(native)});
    assert.equal(await r.text(),response);assert.deepEqual(seen.body,{...native,max_output_tokens:16384});assert.equal(seen.path,'/v1/responses');assert.equal(seen.auth,'Bearer '+TRANSPORT_DUMMY);
    assert.equal(fs.readFileSync(roots+'/transport/1-RESPONSE.txt','utf8'),response);
    assert.deepEqual(JSON.parse(fs.readFileSync(roots+'/transport/1-BODY-DELTA.json')).changed_fields,['max_output_tokens']);
    for(const f of fs.readdirSync(roots+'/transport'))assert(!fs.readFileSync(roots+'/transport/'+f,'utf8').includes(TRANSPORT_DUMMY));
    const bad=await fetch(bridge.endpoint+'/responses',{method:'POST',headers:{authorization:'Bearer '+TRANSPORT_DUMMY},body:JSON.stringify({...native,model:'wrong'})});assert.equal(bad.status,400);
  }finally{await bridge.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
});
test('temporary empty gateway errors wait within the same native request; quota/auth are not blindly retried',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-wait-'));let count=0;const bodies=[],waits=[];
 const statuses=[524,502,503];
 const server=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);bodies.push(Buffer.concat(chunks).toString());count++;res.writeHead(statuses[count-1]??200,{'content-type':'application/json'});res.end(count<=statuses.length?'error code: '+statuses[count-1]+'\n':JSON.stringify({done:true}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const transport=await startCodexTransport({root:root+'/retry',key:TRANSPORT_DUMMY,endpoint:'http://127.0.0.1:'+server.address().port+'/v1',offline:true,waitDelaysMs:[1],onWait:e=>waits.push(e)});
 try{const r=await fetch(transport.endpoint+'/responses',{method:'POST',headers:{authorization:'Bearer '+TRANSPORT_DUMMY},body:JSON.stringify(native)});assert.deepEqual(await r.json(),{done:true});assert.equal(count,4);assert.equal(transport.requests,1);assert.equal(new Set(bodies).size,1);assert.equal(waits.filter(e=>e.phase==='waiting').length,3);}
 finally{await transport.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
 let quotaCalls=0;const quota=http.createServer(async(req,res)=>{for await(const _ of req);quotaCalls++;res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'insufficient_quota',message:'No quota'}}));});await new Promise(r=>quota.listen(0,'127.0.0.1',r));
 const failfast=await startCodexTransport({root:root+'/quota',key:TRANSPORT_DUMMY,endpoint:'http://127.0.0.1:'+quota.address().port+'/v1',offline:true,waitDelaysMs:[1]});
 try{const r=await fetch(failfast.endpoint+'/responses',{method:'POST',headers:{authorization:'Bearer '+TRANSPORT_DUMMY},body:JSON.stringify(native)});assert.equal(r.status,429);await r.text();assert.equal(quotaCalls,1);}
 finally{await failfast.close();quota.closeAllConnections();await new Promise(r=>quota.close(r));}
});
