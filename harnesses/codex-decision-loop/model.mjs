import fs from 'node:fs';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {CodexRpc} from './rpc.mjs';
import {startBenchmarkThread} from './thread.mjs';
import {startCodexTransport,TRANSPORT_DUMMY} from './transport.mjs';
import {CODEX_KNOWLEDGE_TOOLS,codexNativeSkillCatalog} from './knowledge.mjs';
import {compileToolContract,enforceToolContract,toolContractError,truncatedToolReply} from '../claude-code-decision-loop/runtime/src/bench/models/tool-contract.mjs';
import {ModelError,retryableStatus} from '../claude-code-decision-loop/runtime/src/bench/models/http.mjs';
import {parseResponsesResponse} from '../claude-code-decision-loop/runtime/src/bench/models/openai-compatible.mjs';
import {nativeKnowledgeInstructions} from '../claude-code-decision-loop/native-skill.mjs';
import {inspectCodexKnowledgeCheckpoint} from './checkpoint.mjs';

export const CODEX_PARALLEL_REJECTION='Rejected: exactly one tool call per reply is accepted (parallel tool use is disabled). None of these calls was run and no budget was used. Re-issue a single tool call.';
export function codexNativeRouterErrors(body,{responses,toolNames}){
  const records=[];
  for(const raw of responses)for(const use of raw.output.filter(o=>o.type==='function_call')){
    const standardNamespace=use.namespace==null||use.namespace===''||use.namespace==='functions';
    const known=standardNamespace&&toolNames.includes(use.name);let validJSON=true;try{JSON.parse(use.arguments);}catch{validJSON=false;}
    if(known&&validJSON)continue;
    const results=body.input.filter(i=>i.type==='function_call_output'&&i.call_id===use.call_id);assert.equal(results.length,1);
    const output=typeof results[0].output==='string'?results[0].output:results[0].output.map(p=>{assert.equal(p.type,'input_text');return p.text;}).join('');
    // Official0.163 ToolName Display + registry.rs unsupported_tool_call_message.
    if(known)assert(/^failed to parse function arguments: [^\r\n]+ at line \d+ column \d+$/.test(output),'Only the official parser error is accepted for invalid original JSON');
    else assert.equal(output,'unsupported call: '+(standardNamespace?'':use.namespace)+use.name);
    records.push({response_id:raw.id,call_id:use.call_id,tool:use.name,namespace:use.namespace??null,kind:known?'malformed_original_arguments':'unsupported_tool',result:{success:false,text:output}});
  }
  return records;
}

export function codexHistory(messages){
  return messages.flatMap(m=>{
    if(m.role==='assistant'&&m.provider?.adapter==='codex')return structuredClone(m.provider.items);
    if(m.tool_result_for)return [{type:'function_call_output',call_id:m.tool_result_for,output:m.content}];
    if(m.role==='assistant')return [
      ...(m.content?[{type:'message',role:'assistant',content:[{type:'output_text',text:m.content}]}]:[]),
      ...(m.tool_call?[{type:'function_call',call_id:m.tool_call.id,name:m.tool_call.name,arguments:JSON.stringify(m.tool_call.input)}]:[])];
    assert.equal(m.role,'user');assert.equal(typeof m.content,'string');
    return [{type:'message',role:'user',content:[{type:'input_text',text:m.content}]}];
  });
}
export function codexContinuation(previous,next,id){
  if(!previous||next.messages.length!==previous.messages.length+2||!isDeepStrictEqual(previous.system,next.system)||!isDeepStrictEqual(previous.tools,next.tools)||!isDeepStrictEqual(previous.messages,next.messages.slice(0,-2)))return null;
  const [assistant,result]=next.messages.slice(-2);
  if(assistant.role!=='assistant'||assistant.tool_call?.id!==id||result.role!=='user'||result.tool_result_for!==id||typeof result.content!=='string')return null;
  return {text:result.content,is_error:!!result.is_error};
}
export const parseCodexSseResponses=text=>text.split(/\r?\n\r?\n/).flatMap(frame=>{
  const line=frame.split(/\r?\n/).filter(s=>s.startsWith('data:')).map(s=>s.slice(5).trimStart()).join('\n');
  if(!line||line==='[DONE]')return [];let event;try{event=JSON.parse(line);}catch{return [];}
  return ['response.completed','response.incomplete','response.failed'].includes(event.type)&&event.response?[event.response]:[];
});

function factualItem(item){
  if(item.type==='reasoning'){
    const normalized={...item};
    if(item.content===null||Array.isArray(item.content)&&item.content.length===0)delete normalized.content;
    // Pinned0.163 drops unknown `metadata` and clears internal passthrough for this provider.
    // Only a UUID turn annotation is diagnostic; non-empty thought and other metadata stay strict.
    for(const field of ['metadata','internal_chat_message_metadata_passthrough'])if(Object.hasOwn(item,field)){
      const value=item[field];assert(value&&typeof value==='object'&&!Array.isArray(value));assert.deepEqual(Object.keys(value),['turn_id']);
      assert(typeof value.turn_id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.turn_id));delete normalized[field];
    }
    if(item.metadata&&item.internal_chat_message_metadata_passthrough)assert.deepEqual(item.metadata,item.internal_chat_message_metadata_passthrough);
    return normalized;
  }
  if(item.type==='message')return {type:'message',role:item.role,content:typeof item.content==='string'?[{type:item.role==='assistant'?'output_text':'input_text',text:item.content}]:item.content};
  if(item.type==='function_call'){let argumentsValue;try{argumentsValue={encoding:'json',value:JSON.parse(item.arguments)};}catch{argumentsValue={encoding:'invalid-json',original:item.arguments};}return {type:item.type,call_id:item.call_id,namespace:item.namespace??null,name:item.name,arguments:argumentsValue};}
  if(item.type==='function_call_output')return {type:item.type,call_id:item.call_id,output:Array.isArray(item.output)?item.output.map(p=>{assert.equal(p.type,'input_text');return p.text;}).join(''):item.output};
  return item;
}
export function assertCodexFactualRequest(body,{request,system,knowledge,responses,knowledgeResults}){
  let systems=0,catalogs=0,entries=0,empty=0;
  const originalReasoning=new Map();
  for(const item of [...codexHistory(request.messages),...responses.flatMap(r=>r.output)])if(item.type==='reasoning'&&item.id)originalReasoning.set(item.id,item);
  for(const item of body.input.filter(i=>i.type==='reasoning'))for(const field of ['metadata','internal_chat_message_metadata_passthrough'])if(Object.hasOwn(item,field)){
    assert(item.id&&originalReasoning.has(item.id),'Unknown native reasoning metadata');assert.deepEqual(item[field],originalReasoning.get(item.id)[field],'A retained turn annotation cannot be changed');
  }
  const internal=responses.filter(r=>r.output.some(o=>o.type==='function_call'&&knowledgeResults.has(o.call_id)));
  const knowledgeOutputs=internal.flatMap(r=>r.output).map(factualItem);let internalCursor=0;
  const actual=[];
  for(const item of body.input){
    if(item.type==='additional_tools')continue;
    const normalized=factualItem(item),text=item.type==='message'&&item.content?.length===1?item.content[0].text:null;
    if(item.role==='developer'&&text===system){systems++;continue;}
    if(item.role==='developer'&&text?.startsWith('<skills_instructions>\n## Skills\n')){assert.equal(text,codexNativeSkillCatalog(knowledge));catalogs++;continue;}
    if(item.role==='user'&&Array.isArray(item.content)&&item.content.length===0){empty++;continue;}
    if(item.role==='user'&&text?.startsWith('<skill>')){
      assert.equal(text,'<skill>\n<name>blood-glucose-management</name>\n<path>'+knowledge.path+'</path>\n'+fs.readFileSync(knowledge.path,'utf8')+'\n</skill>');entries++;continue;
    }
    if(internalCursor<knowledgeOutputs.length&&isDeepStrictEqual(knowledgeOutputs[internalCursor],normalized)){internalCursor++;continue;}
    if(normalized.type==='function_call_output'&&knowledgeResults.has(normalized.call_id)){assert.equal(normalized.output,knowledgeResults.get(normalized.call_id).text);continue;}
    actual.push(normalized);
  }
  assert.equal(systems,1);assert.equal(catalogs,1);assert.equal(entries,1);assert(empty<=1);
  assert.equal(internalCursor,knowledgeOutputs.length,'Every internal original output block must remain in order');
  for(const raw of internal)for(const use of raw.output.filter(o=>o.type==='function_call'))assert.equal(body.input.filter(i=>i.type==='function_call_output'&&i.call_id===use.call_id).length,1,'Exactly one original internal tool result must remain');
  assert.deepEqual(actual,codexHistory(request.messages).map(factualItem),'Native factual history or signed output changed');
  return {system_exact:true,factual_history_exact:true,native_entry_exact:true,only_registered_native_catalog:true};
}

export function createCodexDecisionLoopModel({config,root,key,binary,skillAssetsRoot,endpoint='https://api.openai.com/v1',offline=false,timeoutMs=240000,maxTurns=7,initialCheckpoint=null,initialLogicalMs=null,initialNativeState=null,catalogFile=null,maxReferenceReads=3}){
  assert(typeof config.model==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(config.model));assert(typeof config.reasoning_effort==='string');assert(Number.isInteger(config.max_tokens)&&config.max_tokens>0);assert.equal(typeof config.strict_tools,'boolean');
  assert(Number.isInteger(maxTurns)&&maxTurns>0&&maxTurns<=256);assert(timeoutMs>0&&timeoutMs<=86400000);assert(!fs.existsSync(root));fs.mkdirSync(root);
  assert(initialLogicalMs===null||Number.isFinite(initialLogicalMs)&&initialLogicalMs>0&&initialLogicalMs<=timeoutMs&&!initialCheckpoint);
  assert(!initialNativeState||!initialCheckpoint&&initialLogicalMs===initialNativeState.state.remaining_logical_ms);
  let closed=false,busy=false,current=null,pending=null,sessionCount=0,accepted=0,continuations=0,initial=initialCheckpoint,initialAllowance=initialLogicalMs,initialNative=initialNativeState;
  const sessions=[];
  const knowledgeInstructions=nativeKnowledgeInstructions('detailed-reference-v3',{maxReads:maxReferenceReads,maxTurns});
  const safe=value=>key?String(value).split(key).join('[REDACTED]'):String(value);
  const save=(file,value)=>fs.writeFileSync(file,safe(JSON.stringify(value,null,2)));
  async function shutdown(){if(!current)return;await current.rpc?.close();await current.transport?.close();current=null;}
  const waitProposal=remaining=>new Promise((resolve,reject)=>{
    assert(!pending);let budget=Math.max(1,remaining),started=Date.now(),timer;
    const arm=()=>{started=Date.now();timer=setTimeout(()=>{pending=null;reject(Object.assign(new ModelError('Codex native logical deadline; original partial stream retained',{retryable:false}),{code:'CODEX_NATIVE_DEADLINE'}));},Math.max(1,budget));};arm();
    pending={resolve:v=>{clearTimeout(timer);pending=null;resolve(v);},reject:e=>{clearTimeout(timer);pending=null;reject(e);},snapshot:()=>budget-(Date.now()-started),restoreAndPause:value=>{budget=value;clearTimeout(timer);},resume:arm};
  });
  async function handle(message,s){
    if(message.method==='turn/completed'&&message.params.turn?.status==='failed'){
      const status=s.lastHTTP?.status??null;
      pending?.reject(new ModelError(message.params.turn.error?.message??'Native Codex turn failed',{status,retryable:retryableStatus(status)}));return;
    }
    if(message.method==='turn/completed'&&message.params.turn?.status==='completed'&&!s.held){
      const raw=s.responses.at(-1);
      if(raw&&!raw.output.some(o=>o.type==='function_call'))pending?.resolve({call:null,raw});
      return;
    }
    if(message.method!=='item/tool/call')return;
    const call=message.params;
    // Native RPC calls can precede the HTTP stream's final close by one event-loop tick.
    for(let n=0;n<200&&!s.responses.some(r=>r.output?.some(o=>o.type==='function_call'&&o.call_id===call.callId));n++)await new Promise(r=>setTimeout(r,5));
    const raw=s.responses.find(r=>r.output?.some(o=>o.type==='function_call'&&o.call_id===call.callId));
    if(!raw){pending?.reject(toolContractError('Native call has no complete original Responses envelope',undefined,{scope:'endpoint'}));return;}
    const uses=raw.output.filter(o=>o.type==='function_call');
    const use=uses.find(u=>u.call_id===call.callId);assert(use);assert.equal(use.name,call.tool);assert.equal(use.namespace??null,call.namespace??null);assert.deepEqual(JSON.parse(use.arguments),call.arguments);
    if(uses.length>1&&!uses.every(u=>['Read','Skill'].includes(u.name))){
      const result={success:false,text:CODEX_PARALLEL_REJECTION};s.knowledgeResults.set(call.callId,result);
      fs.appendFileSync(s.dir+'/POLICY-REJECTIONS.jsonl',JSON.stringify({response_id:raw.id,call_id:call.callId,tool:call.tool,result})+'\n');
      s.rpc.respond(message.id,{contentItems:[{type:'inputText',text:result.text}],success:false});return;
    }
    if(['Read','Skill'].includes(call.tool)){
      const result=s.rpc.knowledge.execute({id:call.callId,name:call.tool,input:call.arguments});
      s.knowledgeResults.set(call.callId,result);
      s.rpc.respond(message.id,{contentItems:[{type:'inputText',text:result.text}],success:result.success});return;
    }
    s.held={id:message.id,call,raw};pending?.resolve(s.held);
  }
  const model={name:config.name??config.model+' native Codex',adapter:'codex',config,
    async complete(request){
      assert(!closed&&!busy,'Closed or concurrent Codex decision');busy=true;const started=Date.now();let promise,logicalAllowance=timeoutMs;
      try{
        const answer=current?.held?codexContinuation(current.expected,request,current.held.call.callId):null;
        if(answer){continuations++;promise=waitProposal(timeoutMs-(Date.now()-started));current.expected=structuredClone(request);save(current.dir+'/CONTROLLER-REQUEST-'+(++current.controllerRequests)+'.json',request);const held=current.held;current.held=null;current.rpc.respond(held.id,{contentItems:[{type:'inputText',text:answer.text}],success:!answer.is_error});}
        else{
          if(initialAllowance!==null){logicalAllowance=initialAllowance;initialAllowance=null;}
          await shutdown();const dir=root+'/session-'+(++sessionCount);fs.mkdirSync(dir);const s={dir,expected:structuredClone(request),responses:[],held:null,knowledgeResults:new Map(),controllerRequests:1,reportedUsage:new Set()};current=s;sessions.push(s);
          save(dir+'/CONTROLLER-REQUEST.json',request);
          save(dir+'/CONTROLLER-REQUEST-1.json',request);
          const retained=initialNative;initialNative=null;
          const checkpoint=retained?.state??(initial?inspectCodexKnowledgeCheckpoint(initial,request):null);
          if(checkpoint){
            assert.deepEqual(checkpoint.expected,request,'Only the exact inspected native knowledge boundary may resume');
            initial=null;logicalAllowance=checkpoint.remaining_logical_ms;s.responses=structuredClone(checkpoint.replies);s.knowledgeResults=new Map(checkpoint.results);
            if(retained)save(dir+'/INITIAL-CONTROLLER-KNOWLEDGE.json',{file:retained.file,sha256:retained.sha256});
            else save(dir+'/INITIAL-CHECKPOINT.json',{file:checkpoint.registration_file,sha256:checkpoint.registration_sha256,source:checkpoint.source,remaining_logical_ms:logicalAllowance});
            for(let i=0;i<s.responses.length;i++)save(dir+'/NATIVE-REPLY-'+(i+1)+'.json',s.responses[i]);
          }
          const tools=[...request.tools.map(t=>({...t,input_schema:compileToolContract(t,'openai').schema})),...CODEX_KNOWLEDGE_TOOLS];
          const toolPolicy=tools.map(t=>({...t,strict:config.strict_tools&&request.tools.some(c=>c.name===t.name)&&(config.strict_tool_names==null||config.strict_tool_names.includes(t.name))}));
          s.transport=await startCodexTransport({root:dir+'/transport',key,endpoint,offline,toolPolicy,model:config.model,maxTokens:config.max_tokens,effort:config.reasoning_effort,instructions:request.system+'\n\n'+knowledgeInstructions,
            guard:(body,n)=>{assert.equal(body.model,config.model);assert(s.responses.length<maxTurns,'Native7 budget exhausted');
              for(const record of codexNativeRouterErrors(body,{responses:s.responses,toolNames:tools.map(t=>t.name)}))if(!s.knowledgeResults.has(record.call_id)){s.knowledgeResults.set(record.call_id,record.result);fs.appendFileSync(s.dir+'/NATIVE-ROUTER-ERRORS.jsonl',JSON.stringify(record)+'\n');}
              save(dir+'/FACTS-'+n+'.json',{controller_request:s.controllerRequests,...assertCodexFactualRequest(body,{request:s.expected,system:s.expected.system+'\n\n'+knowledgeInstructions,knowledge:s.rpc.knowledge,responses:s.responses,knowledgeResults:s.knowledgeResults})});},
            onFailure:error=>pending?.reject(error),
            onWait:event=>{if(event.phase==='request-start'){s.wireBudget=pending?.snapshot();return;}s.waitEvent=event;s.firstWait??=event.at;if(event.phase==='waiting')pending?.restoreAndPause(s.wireBudget);else pending?.resume();},
            onResponse:response=>{s.lastHTTP=response;s.waitEvent=null;s.firstWait=null;for(const raw of parseCodexSseResponses(response.text)){
              assert.equal(raw.model,config.model,'Provider returned a different model');
              if(raw.instructions!==undefined)assert.equal(raw.instructions,s.expected.system+'\n\n'+knowledgeInstructions,'Provider reported a foreign system prompt');
              assert(typeof raw.id==='string'&&raw.id&&Array.isArray(raw.output),'Complete native envelope identity/output required');
              if(s.responses.some(r=>r.id===raw.id))continue;s.responses.push(raw);save(dir+'/NATIVE-REPLY-'+s.responses.length+'.json',raw);
            }}});
          s.rpc=new CodexRpc({binary,root:dir+'/native',key:TRANSPORT_DUMMY,logSecrets:[key],endpoint:s.transport.endpoint,skillAssetsRoot,timeoutMs,model:config.model,catalogFile,maxReferenceReads,onMessage:m=>handle(m,s).catch(e=>pending?.reject(e))});
          if(checkpoint)s.rpc.knowledge.inherit(checkpoint);
          s.rpc.child.on('close',()=>{if(current===s)pending?.reject(new ModelError('Native Codex process exited; original stream retained',{retryable:false}));});
          const thread=await startBenchmarkThread(s.rpc,{system:request.system+'\n\n'+knowledgeInstructions,tools,model:config.model,effort:config.reasoning_effort});s.threadId=thread.thread.id;
          const history=checkpoint?checkpoint.history:codexHistory(request.messages);save(dir+'/INJECTED-FACTUAL-HISTORY.json',history);
          await s.rpc.request('thread/inject_items',{threadId:s.threadId,items:history});
          promise=waitProposal(logicalAllowance-(Date.now()-started));promise.catch(()=>{});
          await s.rpc.request('turn/start',{threadId:s.threadId,input:[{type:'skill',name:'blood-glucose-management',path:s.rpc.knowledge.path}],effort:config.reasoning_effort});
        }
        const held=await promise,raw=held.raw;
        const unreported=current.responses.filter(r=>!current.reportedUsage.has(r.id));
        const known=unreported.every(r=>Number.isFinite(r.usage?.input_tokens)&&Number.isFinite(r.usage?.output_tokens));
        const usage={...(known?{input_tokens:unreported.reduce((s,r)=>s+r.usage.input_tokens,0),output_tokens:unreported.reduce((s,r)=>s+r.usage.output_tokens,0)}:{}),native_usage_complete:known,native_response_ids:unreported.map(r=>r.id)};
        for(const r of unreported)current.reportedUsage.add(r.id);
        if(raw.status==='incomplete'&&raw.incomplete_details?.reason==='max_output_tokens')throw truncatedToolReply(raw,Date.now()-started);
        let result={...parseResponsesResponse(raw),usage,raw:{...raw,__codex_harness:{version:'official-codex-decision-loop/v1',call_dir:current.dir,native_call_id:held.call?.callId??null,native_model_turn:current.responses.length,controller_request:current.controllerRequests,native_tool_called:!!held.call,transport_version:'official-codex-output-cap-transport/v3',original_output_preserved:true}},provider:{adapter:'codex',items:structuredClone(raw.output)},latency_ms:Date.now()-started};
        try{result=enforceToolContract(result,request.tools,'openai',{calls:raw.output.filter(o=>o.type==='function_call').length});}
        catch(e){if(['simulate','read_glucose_history'].includes(result.tool_call?.name))return {...result,tool_validation_error:e.message};throw e;}
        accepted++;
        if(!['simulate','read_glucose_history'].includes(result.tool_call.name))await shutdown();
        return result;
      }catch(error){error.message=safe(error.message);if(error.body)error.body=safe(error.body);if(error.response_raw)error.response_raw=JSON.parse(safe(JSON.stringify(error.response_raw)));promise?.catch(()=>{});pending?.reject(error);await shutdown();throw error;}finally{busy=false;}
    },
    async close(){if(closed)return;closed=true;pending?.reject(new Error('Codex model closed'));await shutdown();key='';save(root+'/MODEL.json',{closed:true,sessions:sessionCount,accepted,continuations});},
    get diagnostics(){return {sessions:sessionCount,accepted,continuations,native_Codex:true,output_cap:config.max_tokens,gateway_wait:current?.waitEvent?{...current.waitEvent,first_wait_at:current.firstWait}:null};}
  };return model;
}
