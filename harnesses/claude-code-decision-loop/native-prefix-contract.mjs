import assert from 'node:assert/strict';
import path from 'node:path';
import {inspectAuthorizedPartial} from './native-authorized-partial.mjs';

// This gate covers only a new decision after a completed native MCP act.
// Resuming a partially completed Skill/Read/query process needs a different contract.
export function inspectNativePrefixBoundary(evidence,ancestors=[]){
  assert(evidence&&evidence.exact_request_and_CPU_boundary===true);
  assert(typeof evidence.source==='string'&&path.isAbsolute(evidence.source));
  assert.equal(path.normalize(evidence.source),evidence.source);
  assert(ancestors.length<4&&!ancestors.includes(evidence.source),'Cyclic or excessive lineage');
  const parent=evidence.parent_prefix;
  if(parent){
    assert.equal(evidence.lineage_version,'registered-native-skill-prefix/v2');
    inspectNativePrefixBoundary(parent,[...ancestors,evidence.source]);
    assert(evidence.accepted_calls>parent.accepted_calls,'A continuation must contain new accepted replies');
  }
  const query=evidence.resume_query_boundary;
  if(query){
    assert(['simulate','read_glucose_history'].includes(evidence.last_accepted_tool));
    assert.equal(evidence.last_session_ended_with_MCP_act,false);
    assert(query.cursor.turns>0&&query.cursor.turns<query.cursor.max_turns&&query.cursor.max_turns<=7);
    assert.equal(query.remaining_native_turns,query.cursor.max_turns-query.cursor.turns);
    assert.equal(path.dirname(query.session_dir),evidence.source+'/Code');
  }else{assert.equal(evidence.last_accepted_tool,'act');assert.equal(evidence.last_session_ended_with_MCP_act,true);}
  assert(Number.isInteger(evidence.accepted_calls)&&evidence.accepted_calls>0);
  assert.equal(evidence.prefix.length,evidence.accepted_calls);
  assert(Number.isInteger(evidence.steps)&&evidence.steps>0&&evidence.steps<864);
  const digest=x=>assert.match(x,/^[a-f0-9]{64}$/);
  for(const key of ['source_stats_sha256','source_invocations_sha256','source_bundle_sha256','terminal_request_sha256'])digest(evidence[key]);
  const seen=new Set();let previousCall=0;
  for(const p of evidence.prefix){
    assert(Number.isInteger(p.original_call)&&p.original_call>0&&!seen.has(p.original_call));seen.add(p.original_call);
    assert(p.original_call>previousCall,'Historical calls must retain chronological order');previousCall=p.original_call;
    for(const key of ['request_sha256','response_sha256','proposal_sha256'])digest(p[key]);
  }
  assert(Array.isArray(evidence.native_sessions)&&evidence.native_sessions.length>0);
  const locations=new Set();
  for(const s of evidence.native_sessions){
    if(path.dirname(s.location)!==evidence.source+'/Code'){
      assert(parent,'Foreign native source requires a validated parent');
      assert.deepEqual(s,parent.native_sessions.find(p=>p.location===s.location));
    }
    assert(/^session-[0-9]+$/.test(path.basename(s.location))&&!locations.has(s.location));locations.add(s.location);
    digest(s.session_sha256);digest(s.stdout_sha256);
    assert.equal(s.knowledge.explicit_task_entries,1);
    assert(Array.isArray(s.knowledge.internal)&&Array.isArray(s.knowledge.witnesses));
  }
  assert.equal(evidence.original_outer_attempts_consumed,evidence.original_transport_owner==='unlimited_gateway_wait'?1:2);
  if(evidence.original_transport_owner==='unlimited_gateway_wait')assert.equal(evidence.gateway_wait_recovery,true);
  assert.equal(evidence.remaining_original_outer_attempts,0);
  assert.equal(evidence.new_paid_recovery_authorized_by_this_audit,false);
  assert.equal(evidence.terminal_sessions.length,evidence.gateway_wait_recovery===true?1:2);
  const terminalNames=new Set();
  for(const s of [...evidence.terminal_sessions,...(evidence.recovered_failure_sessions??[]),...(evidence.gateway_failure_sessions??[])]){
    assert(/^session-[0-9]+$/.test(s.name)&&!terminalNames.has(s.name));terminalNames.add(s.name);
    if(s.accepted_query_boundary){
      const native=evidence.native_sessions.find(n=>n.location===evidence.source+'/Code/'+s.name);assert(native);
      assert.equal(native.session_sha256,s.session_sha256);assert.equal(native.stdout_sha256,s.stdout_sha256);
    }else assert(!locations.has(evidence.source+'/Code/'+s.name));
    if(s.rejected_history){
      assert((evidence.recovered_failure_sessions??[]).includes(s));
      assert.equal(s.rejected_history.kind,'historical_rejected_parallel_simulate/v1');
      assert.equal(s.rejected_history.executed_queries,0);
      assert.equal(s.rejected_history.consumed_native_turns,1);
      assert.equal(s.saved_complete,1);assert.equal(s.turns,0);
      assert(s.model_events>0&&s.mcp_receipts>1);
    }else if(s.accepted_query_boundary){
      assert(query&&query.session_dir===evidence.source+'/Code/'+s.name);
      assert.equal(s.turns,query.cursor.turns);assert.equal(s.mcp_receipts,query.cursor.receipts);assert.equal(s.saved_complete,query.cursor.turns);
    }else if(s.authorized_partial){
      assert(evidence.authorized_unfinished_retry===true);
      inspectAuthorizedPartial(evidence.source,s);
      for(const key of ['mcp_receipts','saved_complete','turns'])assert.equal(s[key],0);
      assert(s.model_events>0);
    }else for(const key of ['model_events','mcp_receipts','saved_complete','turns'])assert.equal(s[key],0);
    digest(s.session_sha256);digest(s.stdout_sha256);
  }
  for(const s of evidence.gateway_failure_sessions??[]){
    assert.equal(evidence.gateway_wait_recovery,true);
    assert(Number.isInteger(s.logical_call)&&s.logical_call>0);
    digest(s.expected_request_sha256);
    assert([429,500,502,503,504].includes(s.status));
  }
  const failedCalls=new Set();
  for(const s of [...(evidence.recovered_failure_sessions??[]),...(evidence.recovered_query_failure_sessions??[])]){
    assert(Number.isInteger(s.failed_call)&&s.failed_call>0&&!failedCalls.has(s.failed_call));
    failedCalls.add(s.failed_call);
    assert(!seen.has(s.failed_call));
    assert(Number.isInteger(s.recovered_call)&&s.recovered_call>s.failed_call&&seen.has(s.recovered_call));
    assert([429,502].includes(s.status));
    digest(s.request_sha256);
  }
  for(const s of evidence.recovered_query_failure_sessions??[]){
    assert(locations.has(s.location));
    assert.equal(s.last_accepted_tool,'simulate');
    assert.equal(s.new_unaccepted_replies,0);
  }
  return {eligible_for_offline_continuation:true,new_decision_native_turn_allowance:query?.remaining_native_turns??(evidence.authorized_unfinished_retry?6:7),
    remaining_original_outer_attempts:0,paid_continuation_allowed:false,
    reason:'Separate explicit recovery authorization and fresh file-SHA revalidation required; this gate does not grant attempts.'};
}
