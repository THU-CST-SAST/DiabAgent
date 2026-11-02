import {scoredBundle,configuredChecks} from '../claude-code-decision-loop/runtime/src/bench/evaluation-contract.mjs';
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {isDeepStrictEqual} from 'node:util';
import {parseInvocations} from '../claude-code-decision-loop/runtime/src/bench/models/invocation-log.mjs';
import {SimEnv} from '../claude-code-decision-loop/runtime/src/env/pomdp.mjs';
import * as scoring from '../claude-code-decision-loop/runtime/src/bench/score.mjs';
import {verifierReport} from '../claude-code-decision-loop/runtime/src/export/harbor/score.mjs';
import {replayWorldEvidence} from '../claude-code-decision-loop/world-replay.mjs';
import {adaptCodexWire} from './transport.mjs';
import {CODEX_VERSION} from './rpc.mjs';
import {inspectCodexKnowledgeCheckpoint} from './checkpoint.mjs';
import {inspectCodexSession} from './session-audit.mjs';
import {readCodexRequestEvidence} from './http-evidence.mjs';
import {inspectCodexControllerPrefix,CODEX_CONTROLLER_PREFIX} from './controller-prefix.mjs';
const read=f=>JSON.parse(fs.readFileSync(f)),lines=f=>fs.readFileSync(f,'utf8').split('\n').filter(Boolean).map(JSON.parse);

export function auditCodexTrial({dir,expectedConfig,offline=false,modelConfig={strict_tool_names:['act','read_glucose_history']},persist=true,transportRecovery=null,evaluation=null}){
 const expectedModel=modelConfig.model??'gpt-6.1-sol',runtime=evaluation?.runtime??{},maxTurns=runtime.max_native_turns??7,maxReads=runtime.max_reference_reads??3,version=evaluation?.scoring_version??'COGI-4-8/v1';
 const stats=read(dir+'/stats.json'),bundle=read(dir+'/bundle.json'),calls=parseInvocations(fs.readFileSync(dir+'/invocations.jsonl','utf8'),{strict:true});
 let prefix=null;if(fs.existsSync(dir+'/CONTROLLER-PREFIX.json')){const r=read(dir+'/CONTROLLER-PREFIX.json');prefix=inspectCodexControllerPrefix(r.file);assert.equal(prefix.registration_sha256,r.sha256);assert.deepEqual(prefix.plan.model.model,expectedModel);}
 const transcript=lines(dir+'/transcript.jsonl'),actions=transcript.filter(r=>r.parsed&&r.receipt),fixed=actions.filter(r=>r.decision_kind==='fixed');
 const truth=bundle.evaluator_only.states,start=Date.parse(expectedConfig.start_time);
 const replay=replayWorldEvidence(bundle,expectedConfig,c=>new SimEnv(c));
 const scoringBundle=evaluation?scoredBundle(bundle,evaluation):bundle;
 const native=verifierReport(scoringBundle,scoring,{scoring_version:version,weights:evaluation?.weights,verifier:'daily'},{episode_id:bundle.manifest.episode_id,agent_completed:stats.state==='done',agent_steps:bundle.metrics.steps,verifier_wait_steps:0});
 const independent=scoring.episodeScore(scoring.episodeMetrics(scoringBundle),evaluation?.weights??scoring.DEFAULT_WEIGHTS,{version});
 let source=true,guards=true,closed=true,budgets=true,inherited=0;const sessions=new Set(),usage=new Map(),independentSessions=[];
 for(const [index,call]of calls.entries()){
   if(index<(prefix?.accepted.length??0)){
    const original=prefix.accepted[index];assert(call.response&&!call.error);for(const field of ['system','messages','tools'])assert.deepEqual(call.request[field],original.request[field]);assert.deepEqual(call.response.raw,original.response.raw);assert.deepEqual(call.response.usage,original.response.usage);
    assert.deepEqual(call.response.replay,{version:prefix.registration.version,source:prefix.source,source_invocations_sha256:prefix.registration.files.find(f=>f.file==='trial/invocations.jsonl')?.sha256,original_call:original.call,no_new_api_call:true,registered_prefix_sha256:prefix.registration_sha256});
   }else assert(!call.replay&&!call.response?.replay,'Unregistered replay is forbidden');
   if(!call.response||call.error)continue;
   const raw=call.response.raw,meta=raw?.__codex_harness;
   if(!meta?.native_tool_called||meta.version!=='official-codex-decision-loop/v1'||raw.model!==expectedModel){source=false;continue;}
   const location=fs.realpathSync(meta.call_dir);assert(location.startsWith(fs.realpathSync(dir+'/Codex')+path.sep)||index<(prefix?.accepted.length??0)&&prefix.sessions.includes(location));sessions.add(location);
   const {__codex_harness,...original}=raw;
   assert.deepEqual(read(location+'/NATIVE-REPLY-'+meta.native_model_turn+'.json'),original);
   const originalRequest=read(location+'/CONTROLLER-REQUEST-'+meta.controller_request+'.json');
   // The existing invocation logger excludes local obs metadata and adds a diagnostic base_url.
   for(const field of ['system','messages','tools'])assert.deepEqual(originalRequest[field],call.request[field]);
   const events=lines(location+'/native/stdout.jsonl');
   const use=raw.output.find(o=>o.type==='function_call'&&o.call_id===meta.native_call_id);assert(use);
   assert(events.some(e=>e.method==='item/tool/call'&&e.params.callId===meta.native_call_id&&e.params.tool===use.name&&(e.params.namespace??null)===(use.namespace??null)&&isDeepStrictEqual(e.params.arguments,JSON.parse(use.arguments))));
 }
 const allLocations=[...(prefix?.sessions??[]),...fs.readdirSync(dir+'/Codex').filter(n=>/^session-\d+$/.test(n)).map(n=>dir+'/Codex/'+n)];
 for(const location of allLocations){
   independentSessions.push(inspectCodexSession(location,{calls:prefix?[...prefix.calls,...calls]:calls,modelConfig,transportRecovery,runtime}));
   if(fs.existsSync(location+'/INITIAL-CHECKPOINT.json')){const checkpoint=read(location+'/INITIAL-CHECKPOINT.json');const proof=inspectCodexKnowledgeCheckpoint(checkpoint.file);assert.equal(proof.registration_sha256,checkpoint.sha256);inherited+=proof.replies.length;for(let i=0;i<proof.replies.length;i++)assert.deepEqual(read(location+'/NATIVE-REPLY-'+(i+1)+'.json'),proof.replies[i]);}
   if(fs.existsSync(location+'/INITIAL-CONTROLLER-KNOWLEDGE.json')){const record=read(location+'/INITIAL-CONTROLLER-KNOWLEDGE.json'),proof=inspectCodexControllerPrefix(record.file);assert.equal(proof.registration_sha256,record.sha256);assert(proof.native_state);inherited+=proof.native_state.replies.length;for(let i=0;i<proof.native_state.replies.length;i++)assert.deepEqual(read(location+'/NATIVE-REPLY-'+(i+1)+'.json'),proof.native_state.replies[i]);}
   const launch=read(location+'/native/LAUNCH.json');assert.equal(launch.identity.version,CODEX_VERSION);
   closed&&=fs.existsSync(location+'/native/EXIT.json');
   const replies=fs.readdirSync(location).filter(n=>/^NATIVE-REPLY-\d+\.json$/.test(n)).map(n=>read(location+'/'+n));budgets&&=replies.length<=maxTurns;
   for(const raw of replies){if(usage.has(raw.id))assert.deepEqual(usage.get(raw.id),raw.usage??null);else usage.set(raw.id,raw.usage??null);}
   const ledger=read(location+'/native/NATIVE-KNOWLEDGE-LEDGER.json');budgets&&=ledger.attempts.filter(a=>a.tool==='Read'&&a.allowed).length<=maxReads;
   const registration=read(location+'/transport/REGISTRATION.json');assert.equal(registration.max_output_tokens,modelConfig.max_tokens??16384);assert.equal(registration.response_rewriting,false);
   for(const file of fs.readdirSync(location+'/transport').filter(f=>/^\d+-UPSTREAM-REQUEST\.json$/.test(f))){
     const n=file.split('-')[0],delta=read(location+'/transport/'+n+'-BODY-DELTA.json'),before=readCodexRequestEvidence(location+'/transport/'+n+'-NATIVE-REQUEST.json',delta,{recoveryManifest:transportRecovery}).value,after=readCodexRequestEvidence(location+'/transport/'+file,delta,{recoveryManifest:transportRecovery}).value,adapted=adaptCodexWire(before,registration.toolPolicy,{instructions:registration.instructions??null,model:expectedModel,maxTokens:modelConfig.max_tokens??16384,effort:modelConfig.reasoning_effort??'high'});
     assert.deepEqual(after,adapted.body);assert.equal(after.reasoning.effort,modelConfig.reasoning_effort??'high');assert.equal(after.model,expectedModel);
     const fact=read(location+'/FACTS-'+n+'.json');guards&&=fact.system_exact&&fact.factual_history_exact&&fact.native_entry_exact&&fact.only_registered_native_catalog;
     assert.deepEqual(read(location+'/transport/'+n+'-BODY-DELTA.json').changed_fields,adapted.changes);
   }
 }
 const checks={controller_done:stats.state==='done',world_replay:replay.valid,horizon:expectedConfig.horizon_minutes===4320,steps:bundle.metrics.steps===864,truth_points:truth.length===865,elapsed:bundle.metrics.elapsed_minutes===4320,completed_horizon:bundle.metrics.completed_horizon===true,fixed_hours:stats.fixed_decisions===72&&fixed.length===72,fixed_grid:fixed.every((r,i)=>Date.parse(r.sim_time)===start+i*3600000),truth_grid:truth.every((r,i)=>Date.parse(r.time)===start+i*300000&&Number.isFinite(r.true_glucose_mg_dl)),extra_cap:Object.values(stats.extra_decisions_by_local_day??{}).every(n=>n<=6),no_WAIT_tail:!bundle.trajectory.some(r=>/harness:.*remaining horizon|validator.*WAIT/i.test(r.rationale??'')),native_reward:native.reward.reward===independent.score&&native.reward.verifier_wait_steps===0,native_source:source&&sessions.size>0,exact_request_guards:guards,native_Read_budgets:budgets,sessions_closed:closed,registered_lineage:!prefix||calls.length>=prefix.accepted.length};
 if(evaluation)Object.assign(checks,configuredChecks(bundle,stats,transcript,expectedConfig,evaluation));
 const valid=Object.values(checks).every(Boolean),known=[...usage.values()].every(u=>Number.isFinite(u?.input_tokens)&&Number.isFinite(u?.output_tokens));
 const result={checked:new Date().toISOString(),valid,offline_only:offline,completed_model_trajectories:valid&&!offline?1:0,scientific_score:valid&&!offline?native.reward.reward:null,checks,independent_native_sessions:independentSessions,world_replay:replay,no_controller_replays:!prefix,historical_controller_calls:prefix?.accepted.length??0,controller_prefix:prefix?{version:prefix.registration.version,source:prefix.source,registration_sha256:prefix.registration_sha256}:null,no_native_replays:inherited===0,inherited_complete_knowledge_replies:inherited,token_usage:{response_ids:usage.size,known,input_tokens:known?[...usage.values()].reduce((n,u)=>n+u.input_tokens,0):null,output_tokens:known?[...usage.values()].reduce((n,u)=>n+u.output_tokens,0):null,not_a_bill:true}};
 if(persist){fs.writeFileSync(dir+'/CODEX-AUDIT.json',JSON.stringify(result,null,2));fs.writeFileSync(dir+'/native-reward.json',JSON.stringify(native.reward,null,2));}return result;
}
