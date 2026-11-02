import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectNativePrefixBoundary} from './native-prefix-contract.mjs';
import {inspectRejectedNativeHistory} from './native-rejected-history.mjs';
import {inspectEmptyGatewayFailure} from './gateway-wait.mjs';
import {inspectNativeQueryFailure} from './native-query-wait.mjs';
import {PENDING_PREFIX_VERSION,createPendingPrefixOffline} from './native-pending-prefix.mjs';
import {HISTORY_PREFIX_VERSION,createNativeHistoryPrefixOffline} from './native-history-prefix.mjs';
import {inspectAuthorizedPartial} from './native-authorized-partial.mjs';
import {INCOMPLETE_PREFIX_VERSION,createIncompleteControllerPrefixOffline} from './native-incomplete-prefix.mjs';

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const facts=x=>({system:x.system,messages:x.messages,tools:x.tools});
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const prefix='mcp__experiment__';

// No network delegate exists here. Production authorization and lineage auditing are separate.
export function createNativePrefixOffline({proof,calls,env,loadCalls}) {
  if(proof.lineage_version===INCOMPLETE_PREFIX_VERSION)return createIncompleteControllerPrefixOffline({proof,calls,env});
  if(proof.lineage_version===HISTORY_PREFIX_VERSION)return createNativeHistoryPrefixOffline({proof,calls,env});
  if(proof.lineage_version===PENDING_PREFIX_VERSION)return createPendingPrefixOffline({proof,calls,env});
  proof=structuredClone(proof);calls=structuredClone(calls);
  inspectNativePrefixBoundary(proof);
  const source=fs.realpathSync(proof.source);
  const roots=[source];
  let parentCalls;
  if(proof.parent_prefix){
    assert.equal(typeof loadCalls,'function');
    parentCalls=loadCalls(proof.parent_prefix.source);
    createNativePrefixOffline({proof:proof.parent_prefix,calls:parentCalls,env:null,loadCalls});
    for(let p=proof.parent_prefix;p;p=p.parent_prefix)roots.push(fs.realpathSync(p.source));
  }
  const emptySessions=[...proof.terminal_sessions.filter(s=>!s.accepted_query_boundary),...(proof.recovered_failure_sessions??[]),...(proof.gateway_failure_sessions??[])];
  for(const s of [...(proof.recovered_failure_sessions??[]),...(proof.recovered_query_failure_sessions??[])]){
    const failed=calls.find(c=>c.call===s.failed_call),recovered=calls.find(c=>c.call===s.recovered_call);
    assert.equal(failed?.error?.status,s.status);
    assert(!failed.response);
    assert(recovered?.response&&!recovered.error);
    assert.equal(hash(failed.request),s.request_sha256);
    assert.deepEqual(facts(failed.request),facts(recovered.request));
  }
  assert.equal(source,proof.source,'Use canonical source paths');
  const checkedFile=(file,digest)=>{
    const actual=fs.realpathSync(file);
    assert(roots.some(root=>{const relative=path.relative(root,actual);return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);}),
      'Source file escaped registered lineage');
    assert.equal(sha(file),digest,'Registered file changed: '+file);
  };
  const verifyFiles=()=>{
    if(proof.parent_prefix)createNativePrefixOffline({proof:proof.parent_prefix,calls:loadCalls(proof.parent_prefix.source),env:null,loadCalls});
    if(proof.resume_query_boundary){
      const actual=inspectNativeQueryFailure(proof.resume_query_boundary);
      assert.equal(actual.evidence_sha256,proof.resume_query_boundary.evidence_sha256);
      assert.equal(actual.expected_request_sha256,proof.resume_query_boundary.expected_request_sha256);
    }
    for(const [name,key]of [['stats.json','source_stats_sha256'],['invocations.jsonl','source_invocations_sha256'],['bundle.json','source_bundle_sha256']])checkedFile(source+'/'+name,proof[key]);
    for(const s of [...proof.native_sessions,...emptySessions.map(s=>({...s,location:source+'/Code/'+s.name}))]){
      checkedFile(s.location+'/SESSION.json',s.session_sha256);
      checkedFile(s.location+'/stdout.jsonl',s.stdout_sha256);
    }
    const expectedSessions=[...proof.native_sessions.filter(s=>path.dirname(s.location)===source+'/Code').map(s=>path.basename(s.location)),...emptySessions.map(s=>s.name)].sort();
    assert.deepEqual(fs.readdirSync(source+'/Code').filter(n=>/^session-\d+$/.test(n)).sort(),expectedSessions,'Unregistered native session');
    for(const s of emptySessions){
      const dir=source+'/Code/'+s.name;
      if(s.rejected_history){assert.deepEqual(inspectRejectedNativeHistory(dir),s.rejected_history);continue;}
      if(s.accepted_query_boundary){inspectNativeQueryFailure(proof.resume_query_boundary);continue;}
      assert(!fs.readdirSync(dir).some(n=>/^COMPLETE-NATIVE-REPLY-|^ACCEPTED-PROPOSAL-/.test(n)),'Late native reply requires reconciliation, not redraw');
      const mcp=dir+'/MCP-CALLS.jsonl';
      assert(!fs.existsSync(mcp)||fs.readFileSync(mcp,'utf8').trim()==='','Late MCP receipt requires reconciliation');
      if(s.authorized_partial)inspectAuthorizedPartial(source,s);
      else if(proof.gateway_wait_recovery)inspectEmptyGatewayFailure(dir);
    }
    for(const s of proof.gateway_failure_sessions??[]){
      assert(calls.some(c=>c.call===s.logical_call));
      checkedFile(source+'/Code/'+s.name+'/EXPECTED-CONTROLLER-REQUEST-1.json',s.expected_request_sha256);
    }
    for(const s of proof.recovered_failure_sessions??[]){
      if(s.rejected_history)continue;
      const dir=source+'/Code/'+s.name,session=read(dir+'/SESSION.json');
      assert.deepEqual(session.turns,[]);
      assert.deepEqual(session.native_internal??[],[]);
      const events=fs.readFileSync(dir+'/stdout.jsonl','utf8').split('\n').filter(Boolean).map(JSON.parse);
      assert(!events.some(e=>e.type==='stream_event'||(e.type==='assistant'&&e.message?.content?.some(b=>b.type==='tool_use'||b.type==='thinking'))));
      assert(events.some(e=>e.type==='result'&&e.is_error===true&&e.api_error_status===s.status));
    }
    for(const s of proof.recovered_query_failure_sessions??[]){
      const dir=s.location,session=read(dir+'/SESSION.json');
      const accepted=calls.filter(c=>c.response&&!c.error&&c.response.raw.__code_harness?.call_dir===dir);
      assert(accepted.length>0);
      assert.equal(session.turns.length,accepted.length);
      assert.equal(session.turns.at(-1).tool,'simulate');
      const events=fs.readFileSync(dir+'/stdout.jsonl','utf8').split('\n').filter(Boolean).map(JSON.parse);
      assert(events.some(e=>e.type==='result'&&e.is_error===true&&e.api_error_status===502));
      const ids=new Set(accepted.map(c=>c.response.raw.id));
      const starts=events.filter(e=>e.type==='stream_event'&&e.event.type==='message_start');
      assert.equal(starts.length,accepted.length);
      assert(starts.every(e=>ids.has(e.event.message.id)));
      assert.equal(events.filter(e=>e.type==='stream_event'&&e.event.type==='message_stop').length,accepted.length);
      assert(events.filter(e=>e.type==='assistant'&&e.message?.model!=='<synthetic>').every(e=>ids.has(e.message?.id)));
      assert.equal(fs.readdirSync(dir).filter(n=>/^COMPLETE-NATIVE-REPLY-/.test(n)).length,accepted.length);
      assert.equal(fs.readdirSync(dir).filter(n=>/^ACCEPTED-PROPOSAL-/.test(n)).length,accepted.length);
      assert.deepEqual(session.native_internal??[],[]);
    }
  };
  verifyFiles();
  const accepted=calls.filter(c=>c.response&&!c.error);
  assert.equal(accepted.length,proof.accepted_calls);
  if(parentCalls){
    const parentAccepted=parentCalls.filter(c=>c.response&&!c.error);
    assert.equal(parentAccepted.length,proof.parent_prefix.accepted_calls);
    for(let i=0;i<parentAccepted.length;i++){
      assert.deepEqual(facts(accepted[i].request),facts(parentAccepted[i].request));
      assert.deepEqual(accepted[i].response.raw,parentAccepted[i].response.raw);
      assert.equal(accepted[i].response.replay?.no_new_api_call,true);
    }
  }
  for(let i=0;i<accepted.length;i++){
    const c=accepted[i],p=proof.prefix[i],raw=c.response.raw,meta=raw.__code_harness;
    assert.equal(c.call,p.original_call);assert.equal(hash(c.request),p.request_sha256);
    assert.equal(hash(raw),p.response_sha256);
    assert.equal(meta?.version,'native-skill-decision-loop/v1');assert.equal(meta.native_MCP_called,true);
    assert(proof.native_sessions.some(s=>s.location===meta.call_dir));
    assert(Number.isInteger(meta.native_turn)&&meta.native_turn>0&&meta.native_turn<=7);
    const file=meta.call_dir+'/ACCEPTED-PROPOSAL-'+meta.native_turn+'.json';
    checkedFile(file,p.proposal_sha256);
    const {__code_harness,...original}=raw;assert.deepEqual(read(file).raw,original);
  }
  let at=0,closed=false,boundary=false;
  return {
    async complete(request){
      assert(!closed,'Offline replay is closed');
      if(at<accepted.length){
        const c=accepted[at];assert.deepEqual(facts(request),facts(c.request));
        const raw=structuredClone(c.response.raw);
        const content=raw.content.map(b=>b.type==='tool_use'&&b.name.startsWith(prefix)?{...b,name:b.name.slice(prefix.length)}:b);
        const uses=content.filter(b=>b.type==='tool_use');assert.equal(uses.length,1);at++;
        return {tool_call:{id:uses[0].id,name:uses[0].name,input:uses[0].input},
          text:content.filter(b=>b.type==='text').map(b=>b.text).join('\n'),provider:{adapter:'anthropic',content},
          raw,stop_reason:raw.stop_reason,usage:structuredClone(c.response.usage??{}),
          replay:{source:source+'/invocations.jsonl',source_sha256:proof.source_invocations_sha256,
            original_call:c.call,registered_prefix_sha256:hash(proof),no_new_api_call:true}};
      }
      verifyFiles();assert.equal(hash(facts(request)),proof.terminal_request_sha256);
      assert.equal(env.step_count,proof.steps);
      const actual=env.exportBundle(),expected=read(source+'/bundle.json');
      assert.deepEqual(actual.manifest.config,expected.manifest.config);
      assert.deepEqual(actual.trajectory,expected.trajectory);
      assert.deepEqual(actual.evaluator_only.states,expected.evaluator_only.states);
      boundary=true;closed=true;
      const error=new Error('OFFLINE_NATIVE_PREFIX_BOUNDARY_NO_NETWORK');
      error.status=401;error.retryable=false;throw error;
    },
    async close(){closed=true;},
    get diagnostics(){return {historical_calls_reconstructed:at,prefix_boundary_verified:boundary,actual_upstream_API_calls:0,paid_continuation_allowed:false};},
  };
}
