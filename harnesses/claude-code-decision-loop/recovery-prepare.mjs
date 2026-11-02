import fs from 'node:fs';
import {captureNativeRuntimeCheckpoint} from './native-runtime-recovery.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {verifyRecoveryCertificate,readJson,fileSha,valueSha,targetProcesses} from './recovery-workflow.mjs';

// Instance replay is CPU-only and stops exactly at the saved failed request.
// It is not another full72h scripted qualification and cannot call a provider.
export async function prepareRecoveryRoot({source,out,certificateFile,allowUnfinished=false,inventory=targetProcesses,selectedTaskIds=null}){
  source=fs.realpathSync(source);out=path.resolve(out);out=path.join(fs.realpathSync(path.dirname(out)),path.basename(out));
  assert(!out.startsWith(source+path.sep)&&out!==source,'Recovery output must not modify the source');assert(!fs.existsSync(out),'Never overwrite a recovery attempt');
  const certificate=verifyRecoveryCertificate(readJson(certificateFile)),plan=readJson(source+'/PLAN.json'),status=readJson(source+'/STATUS.json');
  assert.deepEqual(plan.model,certificate.model,'Model contract changed; select a matching certified engine');
  assert(allowUnfinished,'Retrying an unfinished provider response requires explicit authorization');
  assert(plan.gateway_wait?.unlimited===true&&plan.outer_API_tries===1,'Only the explicitly authorized unlimited gateway policy is supported by this engine');
  const qualified=readJson(certificate.full72h[0].file);
  assert.equal(plan.native_skill.assets_sha256,qualified.skill_assets_sha256,'Skill edition changed; select a matching certified engine');
  assert.equal(plan.native_skill.entry_mode,qualified.native_skill_entry);assert.equal(plan.native_skill.guidance_revision,qualified.native_knowledge_guidance);
  const selected=plan.tasks.filter(t=>(selectedTaskIds===null||selectedTaskIds.includes(t.task_id))&&status.tasks.find(s=>s.task_id===t.task_id)?.state==='interrupted');if(selectedTaskIds)assert.equal(selected.length,new Set(selectedTaskIds).size);
  assert(selected.length,'No interrupted tasks; completed/live/unstarted tasks are not retried');
  for(const t of selected)assert(/^[a-z0-9][a-z0-9_-]*$/i.test(t.task_id)&&/^[a-z0-9][a-z0-9_-]*$/i.test(t.trial_id),'Unsafe task path');
  for(const t of selected){const stats=readJson(source+'/trials/'+t.trial_id+'/stats.json');assert.equal(stats.error_status,502,'This engine release does not support this terminal state; no automatic requalification');}
  const targets=selected.map(t=>source+'/trials/'+t.trial_id);assert.deepEqual(inventory(targets),[],'Original target process still live');
  const control=certificate.control,load=rel=>import(pathToFileURL(control+'/'+rel).href);
  const [{parseInvocations},{SimEnv},{runLlmAgent},{inspectRegisteredNativeCheckpoint},{inspectNativeKnowledge},prefixModule,{createNativePrefixOffline}]=await Promise.all([
    load('runtime/src/bench/models/invocation-log.mjs'),load('runtime/src/env/pomdp.mjs'),load('runtime/src/benchmark/llm-agent.mjs'),
    load('native-history-checkpoint.mjs'),load('native-skill-audit.mjs'),load('native-incomplete-prefix.mjs'),load('native-prefix-offline.mjs')]);
  assert(certificate.supported_prefix_versions.includes(prefixModule.INCOMPLETE_PREFIX_VERSION),'Engine has not qualified this checkpoint contract');
  fs.mkdirSync(out);fs.cpSync(control,out+'/control',{recursive:true});
  const tasks=[],checks=[];
  for(const task of selected){
    const trial=source+'/trials/'+task.trial_id,stats=readJson(trial+'/stats.json'),bundle=readJson(trial+'/bundle.json');
    assert(stats.state!=='done'&&!bundle.metrics.completed_horizon,'Completed trajectory is immutable');
    assert(![401,403].includes(stats.error_status)&&!/quota|balance|credit|permission|unauthorized|forbidden/i.test(stats.error??''),'Authentication/quota failure is not retryable');
    const calls=parseInvocations(fs.readFileSync(trial+'/invocations.jsonl','utf8'),{strict:true}),prior=calls.slice(0,-1),last=calls.at(-1);
    assert.equal(last.error?.status,502,'Unsupported terminal state; requires engineering, not automatic tests');
    assert(prior.every(c=>c.response?.raw));
    const names=fs.readdirSync(trial+'/Code').filter(n=>/^session-\d+$/.test(n)).sort((a,b)=>Number(a.slice(8))-Number(b.slice(8))),session=trial+'/Code/'+names.at(-1),launch=readJson(session+'/LAUNCH.json');
    const id=launch.argv[launch.argv.indexOf('--resume')+1];assert(/^[a-f0-9-]+$/.test(id));
    const history=session+'/home/projects/decision-loop/'+id+'.jsonl';
    const saved=fs.readdirSync(session).filter(n=>/^COMPLETE-NATIVE-REPLY-.*\.json$/.test(n)).map(file=>{const raw=readJson(session+'/'+file);return{file,id:raw.id,stop_reason:raw.stop_reason,sha256:fileSha(session+'/'+file)};});
    const partial=saved.filter(r=>!r.stop_reason);assert.equal(partial.length,1,'Saved complete/ambiguous response must not be redrawn');
    const c={source_plan_sha256:fileSha(source+'/PLAN.json'),id:task.task_id,source:trial,steps:bundle.metrics.steps,exact_request_and_world:true,last_session_sha256:fileSha(session+'/SESSION.json'),source_invocations_sha256:fileSha(trial+'/invocations.jsonl'),source_bundle_sha256:fileSha(trial+'/bundle.json'),saved};
    const files=Object.fromEntries(['SESSION.json','stdout.jsonl','LAUNCH.json','NATIVE-KNOWLEDGE-LEDGER.json','native-knowledge-boundary.json','mcp.json','mcp-tools.json','NATIVE-SKILL-MANIFEST.json'].map(n=>[n,fileSha(session+'/'+n)]));
    const expected=fs.readdirSync(session).filter(n=>/^EXPECTED-CONTROLLER-REQUEST-\d+\.json$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0])).at(-1);
    const ledger=readJson(session+'/NATIVE-KNOWLEDGE-LEDGER.json');
    const incomplete={version:'registered-model-bound-unsigned-native-history/v2',human_instruction:'2026-10-30:之前断的续上',exact_model_response_continuation:false,cpu:c,session,files,history,history_sha256:fileSha(history),expected_file:expected,expected_sha256:fileSha(session+'/'+expected),unfinished_message_id:partial[0].id,remaining_native_turns:launch.max_native_model_turns-saved.length,remaining_Reads:3-ledger.attempts.filter(a=>a.tool==='Read'&&a.allowed).length};
    const spent=Date.parse(last.finished)-Date.parse(last.started);assert(Number.isFinite(spent)&&spent>=0&&spent<plan.logical_timeout_ms,'Original logical budget exhausted');
    const registration=captureNativeRuntimeCheckpoint({sessionDir:session,expected:readJson(session+'/'+expected),remainingLogicalMs:plan.logical_timeout_ms-spent,cpu:c,persist:false});
    assert.deepEqual(inspectRegisteredNativeCheckpoint(registration),registration.attestation);
    const response_prefix=prior.map(call=>{const m=call.response.raw.__code_harness;return{original_call:call.call,request_sha256:valueSha(call.request),response_sha256:valueSha(call.response.raw),proposal_sha256:fileSha(m.call_dir+'/ACCEPTED-PROPOSAL-'+m.native_turn+'.json'),error:call.error??null};});
    const proof={lineage_version:prefixModule.INCOMPLETE_PREFIX_VERSION,id:task.task_id,source:trial,steps:c.steps,parent_prefix:task.registered_prefix??null,native_history_checkpoint:registration,exact_request_and_CPU_boundary:true,source_invocations_sha256:c.source_invocations_sha256,source_bundle_sha256:c.source_bundle_sha256,source_stats_sha256:fileSha(trial+'/stats.json'),terminal_request_sha256:valueSha({system:last.request.system,messages:last.request.messages,tools:last.request.tools}),accepted_calls:prior.filter(r=>!r.error).length,rejected_calls:prior.filter(r=>r.error).length,preserved_parse_errors:stats.parse_errors,response_prefix,prefix:response_prefix.filter(r=>!r.error).map(({error,...r})=>r),source_sessions:names.map(name=>({name,files:Object.fromEntries(fs.readdirSync(trial+'/Code/'+name,{withFileTypes:true}).filter(e=>e.isFile()).map(e=>[e.name,fileSha(trial+'/Code/'+name+'/'+e.name)]))})),native_sessions:[...new Set(prior.filter(r=>!r.error).map(r=>r.response.raw.__code_harness.call_dir))].map(location=>({location}))};
    for(const s of proof.native_sessions){const metadata=readJson(s.location+'/SESSION.json'),events=fs.readFileSync(s.location+'/stdout.jsonl','utf8').split('\n').filter(Boolean).map(JSON.parse);s.knowledge=inspectNativeKnowledge(s.location,metadata,events,readJson(s.location+'/LAUNCH.json').max_native_model_turns);}
    const fixture=readJson(source+'/control/fixtures/'+task.task_id+'.json');assert.equal(fixture.instance.config.horizon_minutes,4320);
    fs.copyFileSync(source+'/control/fixtures/'+task.task_id+'.json',out+'/control/fixtures/'+task.task_id+'.json');
    const env=new SimEnv(fixture.instance.config),model=createNativePrefixOffline({proof,calls,env,loadCalls:s=>parseInvocations(fs.readFileSync(s+'/invocations.jsonl','utf8'),{strict:true})});
    const client={episodeId:async()=>fixture.instance.id,current:async()=>({observation:env.observe(),step:env.step_count,done:env.done()}),step:async(_id,action,rationale,{prefix,expected_step})=>env.step({action_id:prefix+'-'+expected_step,expected_step,action,rationale})};
    const check=await runLlmAgent({client,pub:fixture.pub,model,skillContextConfig:null,logsDir:out+'/CPU-'+task.task_id,units:plan.options.units,agentOptions:plan.agent_options,maxTurns:plan.max_turns,maxConsecutiveErrors:plan.max_format_errors,retry:{tries:1,baseDelayMs:1}});
    assert(model.diagnostics.prefix_boundary_verified);assert.equal(check.parse_errors,stats.parse_errors);
    let generation=1;for(let p=proof.parent_prefix;p;p=p.parent_prefix)generation++;
    tasks.push({...task,trial_id:task.trial_id+'__native_resume',registered_prefix:proof,fixture_sha256:fileSha(out+'/control/fixtures/'+task.task_id+'.json'),recovery_authorization:{version:'native-gateway-wait-resume/v1',source_invocations_sha256:proof.source_invocations_sha256,unlimited_temporary_gateway_wait:true,minimum_backoff_ms:60000,single_continuation:true,task_id:task.task_id,source:trial,recovery_index:generation,human_instruction:'你先跑实验吧，等待这个跟之前 merge 的处理一样，不限制等待重试次数',unfinished_thinking_retry_instruction:incomplete.human_instruction}});
    checks.push({id:task.task_id,original_steps:env.step_count,preserved_parse_errors:check.parse_errors,remaining_native_turns:registration.attestation.remaining_native_turns,CPU_boundary_verified:true,upstream_API_calls:0});
  }
  assert.deepEqual(inventory(targets),[],'Original target appeared during preparation');
  const registered={...plan,root:out,status:'registered_not_started',created:new Date().toISOString(),tasks,parallel:Math.min(plan.parallel,tasks.length),source:certificate.source,runtime_manifest_sha256:certificate.runtime_manifest_sha256,recovery_engine_certificate_sha256:certificate.certificate_sha256,qualification:{mode:'cached_engine_and_per_instance_CPU_check',full_tests_run:0,engine_certificate:certificate.certificate_sha256,checks,actual_upstream_API_calls:0}};
  fs.writeFileSync(out+'/PLAN.json',JSON.stringify(registered,null,2)+'\n',{flag:'wx'});fs.writeFileSync(out+'/RECOVERY-CERTIFICATE.json',JSON.stringify(certificate,null,2)+'\n',{flag:'wx'});
  const ready={ready:true,tasks:tasks.length,parallel:registered.parallel,not_started:true,checks,full_tests_run:0,qualification_upstream_API_calls:0};fs.writeFileSync(out+'/READY.json',JSON.stringify(ready,null,2)+'\n',{flag:'wx'});
  return{root:out,...ready};
}
