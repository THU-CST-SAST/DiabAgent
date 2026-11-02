import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseInvocations} from './runtime/src/bench/models/invocation-log.mjs';
import {createNativePrefixOffline} from './native-prefix-offline.mjs';
import {inspectNativePrefixBoundary} from './native-prefix-contract.mjs';
import {inspectNativeKnowledge} from './native-skill-audit.mjs';
import {compileControllerRequest} from './model.mjs';
import {nativeTerminalFailure} from './native-failure.mjs';
import {PENDING_PREFIX_VERSION,inspectPendingPrefix} from './native-pending-prefix.mjs';
import {HISTORY_PREFIX_VERSION,inspectNativeHistoryPrefix} from './native-history-prefix.mjs';
import {INCOMPLETE_PREFIX_VERSION,inspectIncompleteControllerPrefix} from './native-incomplete-prefix.mjs';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');

export function inspectNativeRegisteredPrefix(proof){
  if(proof.lineage_version===INCOMPLETE_PREFIX_VERSION)return inspectIncompleteControllerPrefix(proof,parseInvocations(fs.readFileSync(proof.source+'/invocations.jsonl','utf8'),{strict:true}));
  if(proof.lineage_version===HISTORY_PREFIX_VERSION)return inspectNativeHistoryPrefix(proof,parseInvocations(fs.readFileSync(proof.source+'/invocations.jsonl','utf8'),{strict:true}));
  if(proof.lineage_version===PENDING_PREFIX_VERSION){
    const calls=parseInvocations(fs.readFileSync(proof.source+'/invocations.jsonl','utf8'),{strict:true});
    return inspectPendingPrefix(proof,calls);
  }
  assert(['registered-native-skill-prefix/v1','registered-native-skill-prefix/v2'].includes(proof.lineage_version));
  const boundary=inspectNativePrefixBoundary(proof);
  const calls=parseInvocations(fs.readFileSync(proof.source+'/invocations.jsonl','utf8'),{strict:true});
  createNativePrefixOffline({proof,calls,env:null,loadCalls:source=>parseInvocations(fs.readFileSync(source+'/invocations.jsonl','utf8'),{strict:true})});
  if(proof.gateway_wait_recovery){
    const sourcePlan=read(proof.source+'/../../PLAN.json'),config=sourcePlan.model;
    if(proof.original_transport_owner==='unlimited_gateway_wait'){assert.equal(sourcePlan.outer_API_tries,1);assert.equal(sourcePlan.gateway_wait.unlimited,true);}
    for(const s of proof.gateway_failure_sessions??[]){
      const dir=proof.source+'/Code/'+s.name,events=fs.readFileSync(dir+'/stdout.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      assert.equal(nativeTerminalFailure(events)?.status,s.status);
      const call=calls.find(c=>c.call===s.logical_call);assert(call);
      assert.deepEqual(read(dir+'/EXPECTED-CONTROLLER-REQUEST-1.json'),compileControllerRequest(config,call.request));
    }
  }
  for(const s of proof.native_sessions){
    const events=fs.readFileSync(s.location+'/stdout.jsonl','utf8').split('\n').filter(Boolean).map(JSON.parse);
    const allowance=read(s.location+'/LAUNCH.json').max_native_model_turns;assert(allowance>=1&&allowance<=7);
    assert.deepEqual(inspectNativeKnowledge(s.location,read(s.location+'/SESSION.json'),events,allowance),s.knowledge);
  }
  if(proof.resume_query_boundary){
    const last=calls.filter(c=>c.response&&!c.error).at(-1);
    assert.equal(last.response.raw.__code_harness.call_dir,proof.resume_query_boundary.session_dir);
    assert.equal(last.response.raw.content.find(b=>b.type==='tool_use')?.name,'mcp__experiment__'+proof.last_accepted_tool);
    assert.equal(last.response.raw.__code_harness.native_turn,proof.resume_query_boundary.cursor.turns);
  }
  return {calls,accepted:calls.filter(c=>c.response&&!c.error),remaining_native_turns:boundary.new_decision_native_turn_allowance};
}

export function createNativeRegisteredPrefixModel({delegate,proof,env,dir,authorization}){
  assert(authorization&&['bounded-C04-recovery/v1','bounded-native-gateway-recovery/v1','native-gateway-wait-resume/v1'].includes(authorization.version));
  const unlimited=authorization.version==='native-gateway-wait-resume/v1';
  assert.equal(authorization.source_invocations_sha256,proof.source_invocations_sha256);
  if(unlimited)assert.equal(authorization.unlimited_temporary_gateway_wait,true);
  else assert.equal(authorization.additional_failed_call_attempts,2);
  assert.equal(authorization.minimum_backoff_ms,60000);
  assert.equal(authorization.single_continuation,true);
  if(authorization.version==='bounded-C04-recovery/v1')assert.equal(authorization.human_answer,'允许这两条各一次有界续接');
  else {
    assert.equal(authorization.task_id,proof.id);
    assert.equal(authorization.source,proof.source);
    let generation=1;for(let p=proof.parent_prefix;p;p=p.parent_prefix)generation++;
    assert(generation<=4);assert.equal(authorization.recovery_index,generation);
    assert.equal(authorization.human_instruction,unlimited?'你先跑实验吧，等待这个跟之前 merge 的处理一样，不限制等待重试次数':'以后再出现中转站问题，自行尝试或等待即可，不要被这个阻塞。');
  }
  const inspected=inspectNativeRegisteredPrefix(proof);
  const replay=createNativePrefixOffline({proof,calls:inspected.calls,env,loadCalls:source=>parseInvocations(fs.readFileSync(source+'/invocations.jsonl','utf8'),{strict:true})});
  let boundary=false,closed=false,firstAnswered=false,attempts=0,lastFailure=null;
  return {
  get name(){return delegate.name;},
  get adapter(){return delegate.adapter;},
  get config(){return delegate.config;},
  async complete(request){
    assert(!closed,'Continuation closed');
    if(!boundary){
      try{return await replay.complete(request);}catch(error){
        if(error.message!=='OFFLINE_NATIVE_PREFIX_BOUNDARY_NO_NETWORK'||!replay.diagnostics.prefix_boundary_verified)throw error;
      }
      fs.writeFileSync(dir+'/RESUME-BOUNDARY.json',JSON.stringify({checked:new Date().toISOString(),
        prefix_sha256:hash(proof),authorization,exact_CPU_state:true,steps:env.step_count,
        historical_calls:replay.diagnostics.historical_calls_reconstructed,remaining_native_turns:inspected.remaining_native_turns,
        original_transport_attempts_remaining:0},null,2)+'\n',{flag:'wx'});
      boundary=true;
    }
    if(!firstAnswered){
      assert.equal(hash({system:request.system,messages:request.messages,tools:request.tools}),proof.terminal_request_sha256);
      assert(unlimited||attempts<2,'Approved failed-call recovery allowance exhausted');
      if(lastFailure!==null)await new Promise(resolve=>setTimeout(resolve,Math.max(0,60000-(Date.now()-lastFailure))));
      assert(!closed,'Continuation closed during backoff');attempts++;
    }
    try{const response=await delegate.complete(request);firstAnswered=true;return response;}
    catch(error){
      if(error.code==='TOOL_CONTRACT'&&error.repair_result?.raw?.__code_harness?.native_direct_HTTPS)firstAnswered=true;
      else if(!firstAnswered)lastFailure=Date.now();
      throw error;
    }
  },async close(){closed=true;await replay.close();await delegate.close();},
  get diagnostics(){const {actual_upstream_API_calls,...historical}=replay.diagnostics;return {...delegate.diagnostics,...historical,
    paid_continuation_allowed:true,additional_failed_call_attempts_used:attempts,first_failed_call_answered:firstAnswered};}};
}
