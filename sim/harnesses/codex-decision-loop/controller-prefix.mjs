import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseInvocations} from '../claude-code-decision-loop/runtime/src/bench/models/invocation-log.mjs';
import {parseResponsesResponse} from '../claude-code-decision-loop/runtime/src/bench/models/openai-compatible.mjs';
import {enforceToolContract} from '../claude-code-decision-loop/runtime/src/bench/models/tool-contract.mjs';
import {runLlmAgent} from '../claude-code-decision-loop/runtime/src/benchmark/llm-agent.mjs';
import {SimEnv} from '../claude-code-decision-loop/runtime/src/env/pomdp.mjs';
import {inspectCodexSession} from './session-audit.mjs';
import {codexHistory} from './model.mjs';

export const CODEX_CONTROLLER_PREFIX='codex-guarded-controller-prefix/v3';
const V2_PREFIX='codex-guarded-controller-prefix/v2';
const LEGACY_PREFIX='codex-guarded-controller-prefix/v1';
const read=f=>JSON.parse(fs.readFileSync(f)),sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const facts=r=>({system:r.system,messages:r.messages,tools:r.tools});
const world=b=>JSON.parse(JSON.stringify({config:b.manifest.config,initial_observation:b.initial_observation,trajectory:b.trajectory,evaluator_only:b.evaluator_only,metrics:b.metrics}));

function sourceProof(source,ancestors=[]){
 assert.equal(fs.realpathSync(source),source);const plan=read(source+'/PLAN.json'),status=read(source+'/STATUS.json'),trial=source+'/trial',stats=read(trial+'/stats.json');
 assert.equal(plan.model.model,'gpt-6.1-sol');assert(!plan.initial_codex_knowledge_checkpoint,'Do not mix default-provider knowledge-prefix experiments into clean controller lineage');
 const parent=plan.initial_codex_controller_prefix?inspectCodexControllerPrefix(plan.initial_codex_controller_prefix,ancestors):null;
 if(parent){assert.equal(parent.registration_sha256,plan.acceptance.controller_prefix.sha256);assert.deepEqual(read(trial+'/CONTROLLER-PREFIX.json'),{file:parent.registration_file,sha256:parent.registration_sha256,source:parent.source});assert.equal(parent.plan.fixture_sha256,plan.fixture_sha256);assert.equal(parent.plan.runtime_manifest_sha256,plan.runtime_manifest_sha256);assert.deepEqual(parent.plan.agent_options,plan.agent_options);}
 assert(status.terminal&&status.state==='interrupted'&&status.steps>0&&status.steps<864&&status.score===null);
 assert.equal(stats.parse_errors,0,'Invalid outputs need a separately certified repair-prefix contract');assert.equal(stats.env_steps,status.steps);
 const owner=read(source+'/OWNER.json');let command='';try{command=fs.readFileSync('/proc/'+owner.pid+'/cmdline','utf8');}catch{}assert(!command.includes(source+'/control/'));
 for(const file of plan.source)assert.equal(sha(source+'/'+file.file),file.sha256);assert.equal(sha(plan.binary),plan.binary_sha256);
 assert.equal(sha(source+'/control/runtime/SOURCE-MANIFEST.json'),plan.runtime_manifest_sha256);
 for(const file of read(source+'/control/runtime/SOURCE-MANIFEST.json').files)assert.equal(sha(source+'/control/runtime/'+file.path),file.sha256);
 assert.equal(sha(source+'/control/fixture.json'),plan.fixture_sha256);
 const calls=parseInvocations(fs.readFileSync(trial+'/invocations.jsonl','utf8'),{strict:true}),accepted=calls.slice(0,-1),last=calls.at(-1);
 assert(accepted.length>0);assert.equal(stats.model_calls,accepted.length);assert(last.error&&!last.response&&!last.replay);
 assert.equal(last.error.message,stats.error);
 const spent=Date.parse(last.finished)-Date.parse(last.started);assert(Number.isFinite(spent)&&spent>=0&&spent<240000);
 const dirs=fs.readdirSync(trial+'/Codex').filter(n=>/^session-\d+$/.test(n)).sort((a,b)=>Number(a.slice(8))-Number(b.slice(8)));
 const ownSessions=dirs.map(n=>trial+'/Codex/'+n),sessions=[...(parent?.sessions??[]),...ownSessions],terminal=ownSessions.at(-1);assert.equal(read(trial+'/Codex/MODEL.json').closed,true);
 for(const [index,call]of accepted.entries()){
  assert(call.response&&!call.error&&!call.replay);
  if(index<(parent?.accepted.length??0)){
   const original=parent.accepted[index];assert.deepEqual(facts(call.request),facts(original.request));assert.deepEqual(call.response.raw,original.response.raw);assert.deepEqual(call.response.usage,original.response.usage);
   assert.deepEqual(call.response.replay,{version:parent.registration.version,source:parent.source,source_invocations_sha256:sha(parent.trial+'/invocations.jsonl'),original_call:original.call,no_new_api_call:true,registered_prefix_sha256:parent.registration_sha256});
  }else assert(!call.response.replay,'Unregistered ancestor replay');
  const raw=call.response.raw,meta=raw.__codex_harness;assert.equal(raw.model,plan.model.model);assert.equal(raw.status,'completed');
  assert(meta.native_tool_called&&sessions.slice(0,-1).includes(meta.call_dir));assert.equal(raw.output.filter(o=>o.type==='function_call').length,1);
  const {__codex_harness,...original}=raw;assert.deepEqual(read(meta.call_dir+'/NATIVE-REPLY-'+meta.native_model_turn+'.json'),original);
 }
 const ownInspections=ownSessions.map(dir=>{assert(fs.existsSync(dir+'/native/EXIT.json'));return inspectCodexSession(dir,{calls,modelConfig:plan.model});});
 const ending=ownInspections.at(-1);assert(ending.guarded_without_upstream||ending.empty_gateway_error_confirmed);
 if(ending.guarded_without_upstream)assert.equal(stats.error,'Local native request guard rejected request; original evidence retained');else assert.equal(last.error.status,ending.gateway_status);
 assert(ownInspections.slice(0,-1).every(s=>s.requests>0&&!s.recovered_transport_evidence.length));
 assert.deepEqual(facts(read(terminal+'/CONTROLLER-REQUEST-1.json')),facts(last.request));
 const sameBoundary=parent&&accepted.length===parent.accepted.length&&status.steps===parent.steps;
 if(sameBoundary)assert.deepEqual(facts(last.request),facts(parent.last.request));
 const allowance=sameBoundary?parent.remaining_logical_ms:240000;
 const excluded=ending.verified_empty_gateway_elapsed_ms??0;assert(excluded<=spent);const remaining=allowance-(spent-excluded);assert(remaining>0&&remaining<=allowance);
 let nativeState=null;
 if(ending.native_budget){
  assert(ending.empty_gateway_error_confirmed,'Only a confirmed empty gateway after complete Read results may retain native state');
  const replies=fs.readdirSync(terminal).filter(n=>/^NATIVE-REPLY-\d+\.json$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0])).map(n=>read(terminal+'/'+n));
  const rows=f=>fs.readFileSync(f,'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const events=rows(terminal+'/native/stdout.jsonl'),client=rows(terminal+'/native/client.jsonl'),results=[];
  const inheritedFile=terminal+'/INITIAL-CONTROLLER-KNOWLEDGE.json';
  const inherited=fs.existsSync(inheritedFile)?parent?.native_state:null;
  if(fs.existsSync(inheritedFile))assert(inherited,'Inherited native state requires the registered direct parent');
  for(const raw of replies){
   assert.equal(raw.status,'completed');const uses=raw.output.filter(o=>o.type==='function_call');assert.equal(uses.length,1);const use=uses[0];assert.equal(use.name,'Read','Query, act, invalid and partial states require their own contracts');
   const old=inherited?.results.find(([id])=>id===use.call_id);if(old){assert.deepEqual(raw,inherited.replies.find(r=>r.id===raw.id));results.push(old);continue;}
   const event=events.find(e=>e.method==='item/tool/call'&&e.params.callId===use.call_id);assert(event);assert.deepEqual(event.params.arguments,JSON.parse(use.arguments));
   const answer=client.find(e=>e.id===event.id&&!e.method);assert(answer?.result?.success);assert.equal(answer.result.contentItems.length,1);assert.equal(answer.result.contentItems[0].type,'inputText');results.push([use.call_id,{success:true,text:answer.result.contentItems[0].text}]);
  }
  const ledger=read(terminal+'/native/NATIVE-KNOWLEDGE-LEDGER.json'),knowledge=read(terminal+'/native/KNOWLEDGE-REGISTRATION.json');
  assert.equal(replies.length,ending.native_budget);assert.equal(ending.Read_allowed,replies.length);assert(replies.length<3);
  const history=codexHistory(last.request.messages);for(const raw of replies){history.push(...structuredClone(raw.output));const use=raw.output.find(o=>o.type==='function_call');history.push({type:'function_call_output',call_id:use.call_id,output:results.find(([id])=>id===use.call_id)[1].text});}
  nativeState={expected:read(terminal+'/CONTROLLER-REQUEST-1.json'),replies,results,history,ledger,knowledge,remaining_logical_ms:remaining};
 }
 return {source,plan,trial,stats,calls,accepted,last,sessions,ownSessions,terminal,inspections:[...(parent?.inspections??[]),...ownInspections],parent,ending,native_state:nativeState,initial_logical_ms:allowance,remaining_logical_ms:remaining,remaining_native_turns:7-ending.native_budget,remaining_Reads:3-ending.Read_allowed,steps:status.steps,bundle:read(trial+'/bundle.json')};
}

const proofSummary=proof=>({accepted_controller_calls:proof.accepted.length,steps:proof.steps,remaining_native_turns:proof.remaining_native_turns,remaining_Reads:proof.remaining_Reads,remaining_logical_ms:proof.remaining_logical_ms,guarded_without_upstream:!!proof.ending.guarded_without_upstream});
export function inspectCodexControllerPrefix(file,ancestors=[]){
 const resolved=fs.realpathSync(file);assert(!ancestors.includes(resolved)&&ancestors.length<16,'Controller prefix lineage cycle or depth exceeded');
 const registration=read(file);assert([LEGACY_PREFIX,V2_PREFIX,CODEX_CONTROLLER_PREFIX].includes(registration.version));
 for(const item of registration.files){assert(!path.isAbsolute(item.file)&&!item.file.split('/').includes('..'));assert.equal(sha(registration.source+'/'+item.file),item.sha256);}
 const proof=sourceProof(registration.source,[...ancestors,resolved]),expected=proofSummary(proof);
 if(registration.version!==LEGACY_PREFIX){expected.parent_registration_sha256=proof.parent?.registration_sha256??null;expected.gateway_status=proof.ending.gateway_status??null;expected.verified_empty_gateway_elapsed_ms=proof.ending.verified_empty_gateway_elapsed_ms??0;}
 else assert(!proof.parent&&proof.ending.guarded_without_upstream);
 if(registration.version===CODEX_CONTROLLER_PREFIX){expected.completed_native_knowledge_replies=proof.native_state?.replies.length??0;expected.initial_logical_ms=proof.initial_logical_ms;}
 else assert(!proof.native_state);
 assert.deepEqual(registration.proof,expected);
 assert.equal(sha(registration.cpu.file),registration.cpu.sha256);const cpu=read(registration.cpu.file);assert.equal(cpu.source,proof.source);assert(Object.values(cpu.checks).every(v=>v===true));
 return {...proof,registration,registration_file:fs.realpathSync(file),registration_sha256:sha(file)};
}

export function retainedCodexControllerModel(model,proof,{boundary=()=>{},offline=false}={}){
 let index=0,checked=false;
 return {name:model.name,adapter:'codex',config:model.config,
  async complete(request){
   if(index<proof.accepted.length){
    const call=proof.accepted[index++];assert.deepEqual(facts(request),facts(call.request),'Registered controller prefix request changed');
    const raw=call.response.raw,parsed=parseResponsesResponse(raw);
    const result={...parsed,raw,provider:{adapter:'codex',items:structuredClone(raw.output)},usage:call.response.usage,latency_ms:Date.parse(call.finished)-Date.parse(call.started),replay:{version:proof.registration?.version??CODEX_CONTROLLER_PREFIX,source:proof.source,source_invocations_sha256:sha(proof.trial+'/invocations.jsonl'),original_call:call.call,no_new_api_call:true,registered_prefix_sha256:proof.registration_sha256??null}};
    return enforceToolContract(result,request.tools,'openai',{calls:raw.output.filter(o=>o.type==='function_call').length});
   }
   if(!checked){assert.deepEqual(facts(request),facts(proof.last.request),'Latest guarded request changed');await boundary(request);checked=true;}
   if(offline)throw new Error('OFFLINE_REGISTERED_PREFIX_BOUNDARY');
   return model.complete(request);
  },
  async close(){await model.close?.();},
  get diagnostics(){return {...(model.diagnostics??{}),historical_controller_calls:index,registered_boundary_verified:checked,registered_prefix_version:proof.registration?.version??CODEX_CONTROLLER_PREFIX};}
 };
}

export async function registerCodexControllerPrefix({source,file,cpuRoot}){
 assert(!fs.existsSync(file)&&!fs.existsSync(cpuRoot));const proof=sourceProof(fs.realpathSync(source)),fixture=read(source+'/control/fixture.json');fs.mkdirSync(cpuRoot);
 const env=new SimEnv(fixture.instance.config),client={episodeId:async()=>fixture.instance.id,current:async()=>({observation:env.observe(),step:env.step_count,done:env.done()}),step:async(_id,action,rationale,{prefix,expected_step})=>env.step({action_id:prefix+'-'+expected_step,expected_step,action,rationale})};
 let reached=false;const model=retainedCodexControllerModel({name:proof.stats.model,adapter:'codex',config:proof.plan.model},proof,{offline:true,boundary:()=>{assert.deepEqual(world(env.exportBundle()),world(proof.bundle),'Original trajectory, evaluator, metrics and configuration must reconstruct exactly');reached=true;}});
 await runLlmAgent({client,pub:fixture.pub,model,skillContextConfig:null,logsDir:cpuRoot,units:proof.plan.options.units,agentOptions:proof.plan.agent_options,maxTurns:proof.plan.max_turns,maxConsecutiveErrors:proof.plan.max_format_errors,retry:{tries:1}});
 assert(reached);const cpu={source,checked:new Date().toISOString(),checks:{all_original_controller_requests:true,all_original_complete_replies:true,all_original_native_sessions:true,original_tool_results:true,original_world_exact:true,latest_guarded_request:true,unchanged_native_Read_budget:true},steps:proof.steps,accepted_controller_calls:proof.accepted.length,upstream_API_calls:0};
 const cpuFile=cpuRoot+'/CPU-PROOF.json';fs.writeFileSync(cpuFile,JSON.stringify(cpu,null,2),{flag:'wx'});
 const files=[];for(const name of ['PLAN.json','STATUS.json','OWNER.json','trial/stats.json','trial/bundle.json','trial/invocations.jsonl','trial/transcript.jsonl','trial/Codex/MODEL.json'])files.push({file:name,sha256:sha(source+'/'+name)});
 if(proof.parent)files.push({file:'trial/CONTROLLER-PREFIX.json',sha256:sha(source+'/trial/CONTROLLER-PREFIX.json')});
 function collect(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=dir+'/'+entry.name;if(entry.isDirectory())collect(p);else if(entry.isFile())files.push({file:path.relative(source,p),sha256:sha(p)});else assert(false,'Unexpected symlink in native evidence');}}
 for(const dir of proof.ownSessions)collect(dir);
 const registration={version:CODEX_CONTROLLER_PREFIX,source,files,cpu:{file:cpuFile,sha256:sha(cpuFile)},proof:{...proofSummary(proof),parent_registration_sha256:proof.parent?.registration_sha256??null,gateway_status:proof.ending.gateway_status??null,verified_empty_gateway_elapsed_ms:proof.ending.verified_empty_gateway_elapsed_ms??0,completed_native_knowledge_replies:proof.native_state?.replies.length??0,initial_logical_ms:proof.initial_logical_ms}};
 fs.writeFileSync(file,JSON.stringify(registration,null,2),{flag:'wx'});inspectCodexControllerPrefix(file);return registration.proof;
}
