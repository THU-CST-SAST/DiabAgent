import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {SimEnv} from './runtime/src/env/pomdp.mjs';
import {runLlmAgent} from './runtime/src/benchmark/llm-agent.mjs';
import {createDecisionLoopModel} from './model.mjs';
import {auditDirectTrial} from './audit.mjs';
import {jsonToSse} from './protocol.mjs';
import {codeMessages,PREFIX,NATIVE_RESUME_CONTROL} from './history.mjs';
import {inspectTaskEntryMessages} from './native-task-entry.mjs';
import {createNativeRegisteredPrefixModel,inspectNativeRegisteredPrefix} from './native-registered-prefix.mjs';
import {createGatewayWaitModel,inspectEmptyGatewayFailure} from './gateway-wait.mjs';
import {inspectNativeQueryFailure} from './native-query-wait.mjs';
import {PENDING_PREFIX_VERSION,pendingPrefixCorrection} from './native-pending-prefix.mjs';
import {verifyPendingCorrection} from './native-pending-parallel.mjs';
import {PARALLEL_REJECTION} from './native-session.mjs';
import {inspectRegisteredNativeCheckpoint,inspectNativeHistoryRetry} from './native-history-checkpoint.mjs';

const [out,fixtureFile,planFile]=process.argv.slice(2),control=fileURLToPath(new URL('.',import.meta.url));
assert(out&&fixtureFile&&planFile,'Usage: NEW_OUTPUT FROZEN_FIXTURE FROZEN_PLAN');
fs.mkdirSync(out,{recursive:false});
const read=p=>JSON.parse(fs.readFileSync(p,'utf8')),write=(name,x)=>fs.writeFileSync(out+'/'+name,JSON.stringify(x,null,2)+'\n');
const {instance,pub}=read(fixtureFile),plan=read(planFile),env=new SimEnv(instance.config);
const assets=process.env.CODE_TEST_SKILL_ASSETS??control+'/runtime/skills',assetManifest=read(assets+'/source.json');
const entry=fs.readFileSync(path.join(assets,assetManifest.directory,'SKILL.md'),'utf8');
const description=entry.match(/^description: (.+)$/m)?.[1];
const entryMode=process.env.CODE_TEST_SKILL_ENTRY??'automatic';
const guidance=process.env.CODE_TEST_KNOWLEDGE_GUIDANCE??'legacy-v1';
const registeredPrefix=process.env.CODE_TEST_NATIVE_PREFIX?read(process.env.CODE_TEST_NATIVE_PREFIX):null;
const gatewayWait=process.env.CODE_TEST_GATEWAY_WAIT==='1',gatewayWaits=[];
const gatewayQuery=process.env.CODE_TEST_GATEWAY_QUERY==='1',gatewayEvents=[];
const inspectedPrefix=registeredPrefix?inspectNativeRegisteredPrefix(registeredPrefix):null;
const firstAllowance=inspectedPrefix?inspectedPrefix.remaining_native_turns:7;
const incompletePrefix=registeredPrefix?.lineage_version==='registered-unsigned-incomplete-controller-prefix/v1';
const exhaustedInheritedReads=registeredPrefix?.native_history_checkpoint?.attestation.remaining_allowed_Reads===0;
const entryBody=entry.replace(/^---\n[\s\S]*?\n---\n/,'').trim();
assert(description,'Native Skill description must be explicit');
const profileFixture=process.argv.includes('--profile-fixture');
if(profileFixture)assert.equal(env.config.profile_switch.enabled,true);
assert.equal(instance.config.horizon_minutes,4320);
const normalize=x=>Array.isArray(x)?x.map(normalize):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).filter(([k,v])=>k!=='cache_control'&&!(k==='caller'&&v?.type==='direct')).map(([k,v])=>[k,k==='content'&&typeof v==='string'?[{type:'text',text:v}]:normalize(v)])):x;
const content=m=>normalize(typeof m.content==='string'?[{type:'text',text:m.content}]:m.content);
function facts(expected,body,dir){
  const resumed=fs.existsSync(dir+'/NATIVE-RESUME-REGISTRATION.json')?read(dir+'/NATIVE-RESUME-REGISTRATION.json'):null;
  const checkpoint=resumed?inspectRegisteredNativeCheckpoint(resumed):null;
  if(checkpoint)assert.deepEqual(checkpoint,resumed.attestation);
  const inherited=checkpoint?fs.readFileSync(checkpoint.history,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(e=>e.message&&['assistant','user'].includes(e.message.role)).map(e=>e.message):[];
  const inheritedBlocks=role=>inherited.filter(m=>m.role===role).flatMap(m=>content(m));
  const taskMessages=structuredClone(body.messages);
  if(checkpoint){
    for(const m of taskMessages){
      if(m.role==='user'&&Array.isArray(m.content)&&m.content.length===3&&m.content[0].text?.startsWith('<command-message>sweetbench-glucose:blood-glucose-management</command-message>')){
        assert.deepEqual(m.content[2],{type:'text',text:NATIVE_RESUME_CONTROL});
        const root=read(dir+'/native-knowledge-boundary.json').skill_root;
        const originalBody=`Base directory for this skill: ${root}\n\n${entryBody}\n`;
        assert.equal(m.content[1].text,originalBody+'\n','Only the measured native user-join newline is projected');
        m.content[1].text=originalBody;m.content.pop();
      }
    }
  }
  const routed=entryMode==='task-command-v1'?inspectTaskEntryMessages(taskMessages,{skillName:'sweetbench-glucose:blood-glucose-management',
    skillRoot:read(dir+'/native-knowledge-boundary.json').skill_root,entryBody}).messages:body.messages;
  let projected=expected;
  if(fs.existsSync(dir+'/REGISTERED-PARALLEL-CORRECTION.json')){
    assert.equal(registeredPrefix?.lineage_version,PENDING_PREFIX_VERSION);
    const correction=read(dir+'/REGISTERED-PARALLEL-CORRECTION.json'),first=read(dir+'/EXPECTED-CONTROLLER-REQUEST-1.json');
    assert.deepEqual(correction,pendingPrefixCorrection(registeredPrefix));verifyPendingCorrection(correction,first);
    const results=correction.raw.content.filter(b=>b.type==='tool_use').map(u=>({type:'tool_result',tool_use_id:u.id,content:PARALLEL_REJECTION,is_error:true}));
    projected={...expected,messages:[...expected.messages.slice(0,first.messages.length),{role:'assistant',content:correction.raw.content},{role:'user',content:results},...expected.messages.slice(first.messages.length)]};
    const name=fs.readdirSync(dir).filter(n=>/^EXPECTED-CONTROLLER-REQUEST-/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0])).at(-1);
    assert.deepEqual(read(dir+'/'+name.replace('EXPECTED-CONTROLLER-REQUEST-','EXPECTED-NATIVE-CORRECTION-REQUEST-')),projected);
  }
  const original=codeMessages(projected.messages),actual=routed.filter(m=>m.role!=='system');
  let at=0;
  for(const m of original){
    let found=false;
    while(at<actual.length){
      const a=actual[at++],blocks=content(a);
      if(blocks.at(-1)?.text===NATIVE_RESUME_CONTROL)blocks.pop();
      if(a.role===m.role&&isDeepStrictEqual(blocks,content(m))){found=true;break;}
      const uses=blocks.filter(b=>b.type==='tool_use');
      assert((checkpoint&&blocks.length&&blocks.every(b=>inheritedBlocks(a.role).some(original=>isDeepStrictEqual(normalize(original),normalize(b)))))
        ||(a.role==='assistant'&&uses.length&&uses.every(u=>['Skill','Read'].includes(u.name)))
        ||(a.role==='user'&&blocks.some(b=>b.type==='tool_result'&&b.tool_use_id.startsWith('offline_native_'))),
      'Unexpected message before an original controller fact');
    }
    assert(found,'Original signed controller history was dropped or changed');
  }
  assert.equal(body.model,plan.model.model);assert.equal(body.max_tokens,plan.model.max_tokens);assert.equal(body.output_config.effort,plan.model.reasoning_effort);
  const system=expected.system.map(b=>b.text).join('\n');assert(body.system.some(b=>b.text?.includes(system)));
  assert(!body.tools.some(t=>t.name.endsWith('read_glucose_skill')));
}
let requests=0,guarded=0,failure,model;
const perSession=new Map(),queryCounts={simulate:0,read_glucose_history:0};
const server=http.createServer(async(req,res)=>{
  try{
    const chunks=[];for await(const c of req)chunks.push(c);
    const body=JSON.parse(Buffer.concat(chunks));requests++;
    assert.equal(JSON.stringify(body).includes('NOT the full glucose-management or device-operation reference'),guidance==='detailed-reference-v3');
    assert(JSON.stringify(body).includes(description),'Exact edition must remain discoverable in every decision');
    assert(body.tools.some(t=>t.name==='Skill')&&body.tools.some(t=>t.name==='Read'));
    write('wire-'+requests+'.json',body);
    const location=fs.readdirSync(out+'/Code').filter(s=>s.startsWith('session-')).sort((a,b)=>Number(a.slice(8))-Number(b.slice(8))).at(-1);
    const dir=out+'/Code/'+location,files=fs.readdirSync(dir).filter(n=>n.startsWith('EXPECTED-CONTROLLER-REQUEST-')).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
    const expected=read(dir+'/'+files.at(-1));facts(expected,body,dir);guarded++;
    if(gatewayWait&&requests===1){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'api_error',message:'Offline qualification temporary502'}}));return;}
    const n=(perSession.get(location)??0)+1;perSession.set(location,n);
    if(gatewayQuery&&perSession.size===2&&n===2){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'api_error',message:'Offline query continuation502'}}));return;}
    let tool='act',input={action:{type:'WAIT'},note:'Offline scripted controller qualification; not model performance.'};
    if(perSession.size===1){
      if(incompletePrefix){
        if(exhaustedInheritedReads){
          if(n===1){tool='Read';input={file_path:read(dir+'/native-knowledge-boundary.json').skill_root+'/references/16-benchmark-hardware-operations.md',offset:1,limit:5};}
          else if(n===2){tool='simulate';input={action:{type:'WAIT'},hours:1};}
          else assert.equal(n,3);
        }else{
          if(n<=2){tool='Read';input={file_path:read(dir+'/native-knowledge-boundary.json').skill_root+'/references/'+(n===1?'07-pump-basal-bolus-and-closed-loop.md':'16-benchmark-hardware-operations.md'),offset:1,limit:2000};}
          else if(n===3){tool='read_glucose_history';input={};}
          else if(n<firstAllowance){tool='simulate';input={action:{type:'WAIT'},hours:1};}
          else assert.equal(n,firstAllowance);
        }
      }else if(exhaustedInheritedReads){
        if(n===1){tool='Read';input={file_path:read(dir+'/native-knowledge-boundary.json').skill_root+'/references/16-benchmark-hardware-operations.md',offset:1,limit:5};}
        else if(n===2){tool='read_glucose_history';input={};}
        else if(n===3){tool='simulate';input={action:{type:'WAIT'},hours:1};}
        else assert.equal(n,4);
      }
      else if(n===1){tool='Skill';input={skill:'sweetbench-glucose:blood-glucose-management'};}
      else if(n===2){tool='Read';input={file_path:read(dir+'/native-knowledge-boundary.json').skill_root+'/references/07-pump-basal-bolus-and-closed-loop.md',offset:1,limit:2000};}
      else if(n===3){tool='Read';input={file_path:read(dir+'/native-knowledge-boundary.json').skill_root+'/references/16-benchmark-hardware-operations.md',offset:1,limit:2000};}
      else if(n===4){tool='read_glucose_history';input={};}
      else if(n===5){tool='simulate';input={action:{type:'WAIT'},hours:1};}
      else if(n===6&&firstAllowance===7){tool='simulate';input={action:{type:'WAIT'},hours:2};}
      else assert.equal(n,firstAllowance);
      if(n===7&&profileFixture)input={action:{type:'SET_PROFILE',target_mg_dl:100},note:'Offline legal profile-change qualification, not a model result.'};
    }else if(gatewayQuery&&perSession.size===2&&n===1){tool='simulate';input={action:{type:'WAIT'},hours:1};}
    if(Object.hasOwn(queryCounts,tool))queryCounts[tool]++;
    const raw={id:'offline_native_message_'+requests,type:'message',role:'assistant',model:body.model,
      content:[{type:'thinking',thinking:'Offline native controller fixture.',signature:'offline_native_signature_'+requests},
        {type:'tool_use',id:'offline_native_'+requests,name:['Skill','Read'].includes(tool)?tool:PREFIX+tool,input}],
      stop_reason:'tool_use',stop_sequence:null,usage:{input_tokens:2,output_tokens:3}};
    res.writeHead(200,{'content-type':'text/event-stream'});res.end(jsonToSse(raw));
  }catch(e){failure??=e;res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'invalid_request_error',message:e.message}}));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const started=Date.now(),client={episodeId:async()=>instance.id,current:async()=>({observation:env.observe(),step:env.step_count,done:env.done()}),
  step:async(_id,action,rationale,{prefix,expected_step})=>env.step({action_id:prefix+'-'+expected_step,expected_step,action,rationale})};
try{
  model=createDecisionLoopModel({config:plan.model,root:out+'/Code',key:'offline-dummy-not-a-credential',binary:process.env.CODE_TEST_BINARY,
    offlineEndpoint:'http://127.0.0.1:'+server.address().port,nativeSkillAssetsRoot:assets,nativeSkillEntry:entryMode,nativeKnowledgeGuidance:guidance,timeoutMs:20000,maxTurns:7,initialSessionMaxTurns:firstAllowance,
    initialParallelCorrection:registeredPrefix?.lineage_version===PENDING_PREFIX_VERSION?pendingPrefixCorrection(registeredPrefix):null,
    initialNativeHistoryCheckpoint:registeredPrefix?.native_history_checkpoint??null});
  if(gatewayWait)model=createGatewayWaitModel({delegate:model,unlimited:true,verifyEmptyFailure:async({error})=>{
    if(error.native_history_retry)return inspectNativeHistoryRetry(error.native_history_retry);
    if(error.native_query_retry)return inspectNativeQueryFailure(error.native_query_retry);
    const latest=fs.readdirSync(out+'/Code').filter(n=>/^session-\d+$/.test(n)).sort((a,b)=>Number(a.slice(8))-Number(b.slice(8))).at(-1);
    return inspectEmptyGatewayFailure(out+'/Code/'+latest);
  },sleep:async ms=>{gatewayWaits.push(ms);},onEvent:async e=>{gatewayEvents.push(e);fs.appendFileSync(out+'/GATEWAY-WAIT.jsonl',JSON.stringify(e)+'\n');}});
  let recoveryGeneration=1;for(let p=registeredPrefix?.parent_prefix;p;p=p.parent_prefix)recoveryGeneration++;
  if(registeredPrefix)model=createNativeRegisteredPrefixModel({delegate:model,proof:registeredPrefix,env,dir:out,
    authorization:{version:'native-gateway-wait-resume/v1',source_invocations_sha256:registeredPrefix.source_invocations_sha256,
      unlimited_temporary_gateway_wait:true,minimum_backoff_ms:60000,single_continuation:true,
      task_id:registeredPrefix.id,source:registeredPrefix.source,recovery_index:recoveryGeneration,
      human_instruction:'你先跑实验吧，等待这个跟之前 merge 的处理一样，不限制等待重试次数'}});
  const stats=await runLlmAgent({client,pub,model,skillContextConfig:null,logsDir:out,units:plan.options.units,
    agentOptions:plan.agent_options,maxTurns:plan.max_turns,maxConsecutiveErrors:plan.max_format_errors,retry:{tries:1,baseDelayMs:1}});
  await model.close();write('stats.json',stats);write('bundle.json',env.exportBundle());
  if(failure)throw failure;
  const audit=auditDirectTrial({dir:out,config:plan.model,expectedConfig:instance.config,offlineOnly:true,nativeSkill:true,registeredPrefix,scoringVersion:pub.scoring_version});
  const inheritedSessions=registeredPrefix?.native_sessions??[];
  const acceptedSourceActs=new Set((inspectedPrefix?.accepted??[]).filter(c=>c.response.raw.content.some(b=>b.type==='tool_use'&&b.name===PREFIX+'act')).map(c=>c.response.raw.__code_harness.call_dir));
  const inheritedWithoutAct=inheritedSessions.filter(s=>incompletePrefix?!acceptedSourceActs.has(s.location):!read(s.location+'/SESSION.json').turns.some(t=>t.tool==='act'));
  const recoveredQueryLocations=new Set();
  for(let p=registeredPrefix;p;p=p.parent_prefix){for(const s of p.recovered_query_failure_sessions??[])recoveredQueryLocations.add(s.location);if(p.resume_query_boundary)recoveredQueryLocations.add(p.resume_query_boundary.session_dir);}
  const historicalRejectedQuerySources=[];
  if(incompletePrefix){
    const rejectedLocations=new Set(inspectedPrefix.prior.filter(c=>c.error?.code==='TOOL_CONTRACT').map(c=>c.response.raw.__code_harness.call_dir));
    for(const s of inheritedWithoutAct)if(rejectedLocations.has(s.location)){recoveredQueryLocations.add(s.location);historicalRejectedQuerySources.push(s.location);}
  }
  if(incompletePrefix&&registeredPrefix.native_history_checkpoint.attestation.preserved_controller_receipts){
    const source=registeredPrefix.native_history_checkpoint.attestation.source_session;
    assert(inheritedWithoutAct.some(s=>s.location===source));recoveredQueryLocations.add(source);
  }
  const retainedQuerySources=new Set(gatewayEvents.filter(e=>e.native_history_resume&&e.native_history_resume.source_session.startsWith(out+'/Code/')).map(e=>e.native_history_resume.source_session).filter(d=>read(d+'/SESSION.json').turns.some(t=>['simulate','read_glucose_history'].includes(t.tool))));
  const resumedQueries=gatewayEvents.filter(e=>e.query_resume).length+retainedQuerySources.size;
  const priorKnowledge=key=>inheritedSessions.reduce((n,s)=>n+(s.knowledge[key]??0),0);
  const firstDir=out+'/Code/'+perSession.keys().next().value;
  const newReadBudget=read(firstDir+'/NATIVE-KNOWLEDGE-LEDGER.json').attempts;
  const expectedInitialSimulates=incompletePrefix?(exhaustedInheritedReads?1:firstAllowance-4):(firstAllowance===7?2:1);
  const expectedInitialHistory=incompletePrefix&&exhaustedInheritedReads?0:1;
  const checks={full_native_audit:audit.valid,wire_facts_guarded:guarded===requests,query_budgets:queryCounts.simulate===expectedInitialSimulates+(gatewayQuery?1:0)&&queryCounts.read_glucose_history===expectedInitialHistory,
    native_turn_allowance_preserved:perSession.values().next().value===firstAllowance,native_Skill:audit.native_knowledge.Skill_invocations===priorKnowledge('skill_invocations')+(exhaustedInheritedReads||incompletePrefix?0:1),
    two_native_Reads:audit.native_knowledge.reference_reads===priorKnowledge('reference_reads')+(exhaustedInheritedReads?0:2),algorithm_read:audit.native_knowledge.algorithm_reads===priorKnowledge('algorithm_reads')+(exhaustedInheritedReads?0:1),
    ...(exhaustedInheritedReads?{original_Read_cap_preserved:newReadBudget.filter(a=>a.tool==='Read'&&a.allowed).length===3&&newReadBudget.some(a=>a.tool==='Read'&&!a.allowed)}:{}),
    one_process_per_decision:perSession.size-resumedQueries+inheritedSessions.length-inheritedWithoutAct.length===stats.decisions,
    historical_query_failures_accounted:inheritedWithoutAct.length===recoveredQueryLocations.size&&inheritedWithoutAct.every(s=>recoveredQueryLocations.has(s.location)),
    original_controller_memory:!fs.existsSync(out+'/skill-context.json'),
    ...(gatewayWait?{gateway_wait_and_native_continuation:gatewayWaits.length===(gatewayQuery?2:1)&&gatewayWaits.every(ms=>ms===60000)}:{}),
    ...(gatewayQuery?{failed_query_result_and_budget_preserved:resumedQueries===1}:{}),
    ...(profileFixture?{legal_profile_config_change:audit.valid&&audit.native_world_replay.final_config_changed_by_recorded_actions}:{})};
  const result={checked:new Date().toISOString(),all_passed:Object.values(checks).every(Boolean),checks,actual_upstream_API_calls:0,
    scripted_infrastructure_only:true,completed_model_trajectories:0,initial_native_allowance:firstAllowance,skill_assets_sha256:assetManifest.sha256,native_skill_entry:entryMode,
    native_knowledge_guidance:guidance,catalogue_checked_every_request:true,profile_fixture:profileFixture,historical_rejected_query_sources:historicalRejectedQuerySources,elapsed_ms:Date.now()-started,requests,stats,audit};
  write('RESULT.json',result);console.log(JSON.stringify(result));assert(result.all_passed);
}finally{await model?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
