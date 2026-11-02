import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {assertCodexFactualRequest,parseCodexSseResponses,CODEX_PARALLEL_REJECTION,codexNativeRouterErrors} from './model.mjs';
import {CODEX_KNOWLEDGE_TOOLS,codexKnowledgeResult} from './knowledge.mjs';
import {adaptCodexWire,classifyCodexGatewayError} from './transport.mjs';
import {inspectCodexKnowledgeCheckpoint} from './checkpoint.mjs';
import {readCodexHttpEvidence,readCodexRequestEvidence} from './http-evidence.mjs';
import {inspectCodexControllerPrefix} from './controller-prefix.mjs';
import {nativeKnowledgeInstructions,verifyNativeSkillEdition} from '../claude-code-decision-loop/native-skill.mjs';
import {compileToolContract} from '../claude-code-decision-loop/runtime/src/bench/models/tool-contract.mjs';

const read=f=>JSON.parse(fs.readFileSync(f)),rows=f=>fs.readFileSync(f,'utf8').split('\n').filter(Boolean).map(JSON.parse);
const digest=s=>createHash('sha256').update(s).digest('hex');
const facts=r=>({system:r.system,messages:r.messages,tools:r.tools});
const order=(a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]);

/** Reconstruct facts and knowledge results from original records, not stored green flags. */
export function inspectCodexSession(location,{calls,modelConfig,transportRecovery=null,runtime={}}){
 const expectedModel=modelConfig.model??'gpt-6.1-sol',maxTurns=runtime.max_native_turns??7,maxReads=runtime.max_reference_reads??3;
 const guidance=nativeKnowledgeInstructions('detailed-reference-v3',{maxReads,maxTurns});
 const replies=fs.readdirSync(location).filter(n=>/^NATIVE-REPLY-\d+\.json$/.test(n)).sort(order).map(n=>read(location+'/'+n));
 assert(replies.length<=maxTurns);
 const originalById=new Map();for(const r of replies){assert(!originalById.has(r.id));assert.equal(r.model,expectedModel);originalById.set(r.id,r);}
 const registration=read(location+'/transport/REGISTRATION.json'),knowledge=read(location+'/native/KNOWLEDGE-REGISTRATION.json');
 assert.equal(registration.model,expectedModel,'Transport was registered for another model');
 const manifest=read(knowledge.source+'/source.json');verifyNativeSkillEdition(manifest);
 assert.equal(manifest.sha256,'10f1e522b4ba24fbaa0a6d85ece7c047715f87099cd769ad13d9a2f6c8a24eb7');
 assert.equal(knowledge.assets_sha256,manifest.sha256);assert.deepEqual(knowledge.files,manifest.files);assert.equal(knowledge.max_reads,maxReads);
 for(const [file,sha]of Object.entries(knowledge.files))assert.equal(digest(fs.readFileSync(knowledge.skill_root+'/'+file)),sha);
 const inputRequests=fs.readdirSync(location).filter(n=>/^CONTROLLER-REQUEST-\d+\.json$/.test(n)).sort(order).map(n=>read(location+'/'+n));
 for(const expected of inputRequests)assert(calls.some(c=>isDeepStrictEqual(facts(c.request),facts(expected))),'Archived controller boundary is absent from the original invocation log');
 const tools=[...inputRequests[0].tools.map(t=>({...t,input_schema:compileToolContract(t,'openai').schema})),...CODEX_KNOWLEDGE_TOOLS];
 const policy=tools.map(t=>({...t,strict:modelConfig.strict_tools!==false&&inputRequests[0].tools.some(c=>c.name===t.name)&&(modelConfig.strict_tool_names==null||modelConfig.strict_tool_names.includes(t.name))}));
 assert.deepEqual(registration.toolPolicy,policy);
 const events=rows(location+'/native/stdout.jsonl'),client=rows(location+'/native/client.jsonl');
 let inherited=null;const state={attempts:[]},results=new Map();
 if(fs.existsSync(location+'/INITIAL-CHECKPOINT.json')){
  const record=read(location+'/INITIAL-CHECKPOINT.json');inherited=inspectCodexKnowledgeCheckpoint(record.file,inputRequests[0]);assert.equal(inherited.registration_sha256,record.sha256);
  state.attempts=structuredClone(inherited.ledger.attempts);for(const [id,result]of inherited.results)results.set(id,result);
  for(const raw of inherited.replies)assert.deepEqual(originalById.get(raw.id),raw);
 }
 if(fs.existsSync(location+'/INITIAL-CONTROLLER-KNOWLEDGE.json')){
  assert(!inherited);const record=read(location+'/INITIAL-CONTROLLER-KNOWLEDGE.json'),prefix=inspectCodexControllerPrefix(record.file);assert.equal(prefix.registration_sha256,record.sha256);inherited=prefix.native_state;assert(inherited);
  state.attempts=structuredClone(inherited.ledger.attempts);for(const [id,result]of inherited.results)results.set(id,result);for(const raw of inherited.replies)assert.deepEqual(originalById.get(raw.id),raw);
 }
 const rejections=fs.existsSync(location+'/POLICY-REJECTIONS.jsonl')?rows(location+'/POLICY-REJECTIONS.jsonl'):[];
 const expectedRejections=[];
 for(const event of events.filter(e=>e.method==='item/tool/call')){
  const call=event.params,raw=replies.find(r=>r.output.some(i=>i.type==='function_call'&&i.call_id===call.callId));assert(raw,'Native RPC call lacks its original complete provider envelope');
  const uses=raw.output.filter(i=>i.type==='function_call'),use=uses.find(i=>i.call_id===call.callId);
  assert.equal(call.tool,use.name);assert.equal(call.namespace??null,use.namespace??null);assert.deepEqual(call.arguments,JSON.parse(use.arguments));
  let expected=null;
  if(uses.length>1&&!uses.every(i=>['Read','Skill'].includes(i.name))){
   expected={success:false,text:CODEX_PARALLEL_REJECTION};expectedRejections.push({response_id:raw.id,call_id:call.callId,tool:call.tool,result:expected});
  }else if(['Read','Skill'].includes(call.tool)){
   const source=inherited&&call.tool==='Read'&&call.arguments.file_path?.startsWith(inherited.knowledge.skill_root+path.sep)?inherited.knowledge.skill_root:knowledge.skill_root;
   expected=codexKnowledgeResult({...knowledge,skill_root:source},state,{id:call.callId,name:call.tool,input:call.arguments});
  }
  if(expected){
   const answer=client.find(e=>e.id===event.id&&!e.method);assert(answer,'Native knowledge/policy result was not actually returned');
   assert.deepEqual(answer.result,{contentItems:[{type:'inputText',text:expected.text}],success:expected.success});
   assert(!results.has(call.callId),'Duplicate native tool result');results.set(call.callId,expected);
  }
 }
 assert.deepEqual(rejections,expectedRejections);
 const recordedLedger=read(location+'/native/NATIVE-KNOWLEDGE-LEDGER.json');
 const semanticLedger=l=>l.attempts.map(({at,...r})=>r);
 assert.deepEqual(semanticLedger(recordedLedger),semanticLedger(state));
 for(const row of recordedLedger.attempts)assert(Number.isFinite(Date.parse(row.at)),'A native ledger timestamp must be real, not fabricated by the re-auditor');
 if(inherited)assert.deepEqual(recordedLedger.attempts.slice(0,inherited.ledger.attempts.length),inherited.ledger.attempts);
 assert(state.attempts.filter(a=>a.tool==='Read'&&a.allowed).length<=maxReads);
 if(replies.length===0){
  assert.equal(inputRequests.length,1);assert.equal(state.attempts.length,0);assert(!inherited);
  const files=fs.readdirSync(location+'/transport').sort(),local=files.includes('1-REJECTED.json');let http=null;
  if(local){assert.deepEqual(files,['1-NATIVE-BYTES.txt','1-NATIVE-REQUEST.json','1-REJECTED.json','REGISTRATION.json']);assert(read(location+'/transport/1-REJECTED.json').reason.startsWith('Native factual history or signed output changed'));}
  else{
   assert.deepEqual(files,['1-BODY-DELTA.json','1-NATIVE-BYTES.txt','1-NATIVE-REQUEST.json','1-RESPONSE.json','1-RESPONSE.txt','1-UPSTREAM-REQUEST.json','REGISTRATION.json']);
   http=read(location+'/transport/1-RESPONSE.json');assert(http.complete&&[429,500,502,503,504,524].includes(http.status));assert(Number.isFinite(http.elapsed_ms)&&http.elapsed_ms>=0);
   const evidence=readCodexHttpEvidence(location+'/transport/1-RESPONSE.txt',http,{recoveryManifest:transportRecovery});assert(!evidence.recovery);const error=classifyCodexGatewayError(evidence.text,http.status);assert(error.empty&&!error.permanent);
   const delta=read(location+'/transport/1-BODY-DELTA.json'),native=readCodexRequestEvidence(location+'/transport/1-NATIVE-REQUEST.json',delta),upstream=readCodexRequestEvidence(location+'/transport/1-UPSTREAM-REQUEST.json',delta);assert.deepEqual(upstream.value,adaptCodexWire(native.value,policy,{instructions:registration.instructions,model:expectedModel,maxTokens:modelConfig.max_tokens??16384,effort:modelConfig.reasoning_effort??'high'}).body);
   assert(!events.some(e=>e.method==='item/tool/call'));
  }
  const before=read(location+'/transport/1-NATIVE-REQUEST.json');assert.deepEqual(JSON.parse(fs.readFileSync(location+'/transport/1-NATIVE-BYTES.txt','utf8')),before);
  assertCodexFactualRequest(before,{request:inputRequests[0],system:inputRequests[0].system+'\n\n'+guidance,knowledge:{root:knowledge.skill_root,path:knowledge.skill_root+'/SKILL.md'},responses:[],knowledgeResults:new Map()});
  assert(fs.existsSync(location+'/native/EXIT.json'));
  return {independent_factual_contexts:true,original_HTTP_envelopes:false,guarded_without_upstream:local,empty_gateway_error_confirmed:!local,gateway_status:http?.status??null,verified_empty_gateway_elapsed_ms:http?.elapsed_ms??0,knowledge_results_recomputed:true,native_budget:0,Read_allowed:0,requests:local?0:1,inherited_native_replies:0,recovered_transport_evidence:[]};
 }
 const witnessed=new Map(inherited?.replies.map(r=>[r.id,r])??[]),routerErrors=new Map(),recoveries=[];let requests=0,emptyGateway=null;
 const upstreamFiles=fs.readdirSync(location+'/transport').filter(n=>/^\d+-UPSTREAM-REQUEST\.json$/.test(n)).sort(order);
 for(const file of upstreamFiles){
  const n=file.match(/^\d+/)[0],delta=read(location+'/transport/'+n+'-BODY-DELTA.json');
  const native=readCodexRequestEvidence(location+'/transport/'+n+'-NATIVE-REQUEST.json',delta,{recoveryManifest:transportRecovery}),upstream=readCodexRequestEvidence(location+'/transport/'+file,delta,{recoveryManifest:transportRecovery}),bytes=readCodexRequestEvidence(location+'/transport/'+n+'-NATIVE-BYTES.txt',delta,{recoveryManifest:transportRecovery});
  const before=native.value,after=upstream.value;assert.deepEqual(bytes.value,before);
  for(const e of [native,upstream,bytes])if(e.recovery)recoveries.push(e.recovery);
  const changed=adaptCodexWire(before,policy,{instructions:registration.instructions??null,model:expectedModel,maxTokens:modelConfig.max_tokens??16384,effort:modelConfig.reasoning_effort??'high'});assert.deepEqual(after,changed.body);
  assert.equal(after.model,expectedModel);assert.equal(after.reasoning.effort,modelConfig.reasoning_effort??'high');assert.equal(after.max_output_tokens,modelConfig.max_tokens??16384);assert.equal(after.parallel_tool_calls,false);
  assert.deepEqual(read(location+'/transport/'+n+'-BODY-DELTA.json').changed_fields,changed.changes);
  const record=read(location+'/FACTS-'+n+'.json'),request=inputRequests[record.controller_request-1];assert(request);
  for(const error of codexNativeRouterErrors(before,{responses:[...witnessed.values()],toolNames:policy.map(t=>t.name)})){routerErrors.set(error.call_id,error);results.set(error.call_id,error.result);}
  const previousResults=new Map([...results].filter(([id])=>[...witnessed.values()].some(r=>r.output.some(o=>o.type==='function_call'&&o.call_id===id))));
  assertCodexFactualRequest(before,{request,system:request.system+'\n\n'+guidance,knowledge:{root:knowledge.skill_root,path:knowledge.skill_root+'/SKILL.md'},responses:[...witnessed.values()],knowledgeResults:previousResults});
  const witness=read(location+'/transport/'+n+'-RESPONSE.json'),evidence=readCodexHttpEvidence(location+'/transport/'+n+'-RESPONSE.txt',witness,{recoveryManifest:transportRecovery}),text=evidence.text;
  if(evidence.recovery)recoveries.push(evidence.recovery);
  if(witness.status!==200){
   assert.equal(file,upstreamFiles.at(-1));assert(witness.complete&&[429,500,502,503,504,524].includes(witness.status));const error=classifyCodexGatewayError(text,witness.status);assert(error.empty&&!error.permanent);assert.equal(parseCodexSseResponses(text).length,0);
   emptyGateway={empty_gateway_error_confirmed:true,gateway_status:witness.status,verified_empty_gateway_elapsed_ms:witness.elapsed_ms};requests++;continue;
  }
  const complete=parseCodexSseResponses(text);assert.equal(complete.length,1,'Exactly one complete native envelope per successful request');
  for(const raw of complete){assert.deepEqual(originalById.get(raw.id),raw,'Native reply differs from the original provider stream');if(raw.instructions!==undefined&&registration.instructions!==null)assert.equal(raw.instructions,registration.instructions);assert(!witnessed.has(raw.id),'Native response ID reused');witnessed.set(raw.id,raw);}
  requests++;
 }
 assert.deepEqual([...witnessed.keys()].sort(),[...originalById.keys()].sort(),'Every original native response must be accounted for exactly once');
 assert.deepEqual(fs.existsSync(location+'/NATIVE-ROUTER-ERRORS.jsonl')?rows(location+'/NATIVE-ROUTER-ERRORS.jsonl'):[],[...routerErrors.values()]);
 return {independent_factual_contexts:true,original_HTTP_envelopes:true,knowledge_results_recomputed:true,native_budget:replies.length,Read_allowed:state.attempts.filter(a=>a.tool==='Read'&&a.allowed).length,requests,inherited_native_replies:inherited?.replies.length??0,recovered_transport_evidence:recoveries,...emptyGateway};
}
