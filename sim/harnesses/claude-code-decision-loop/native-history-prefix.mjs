import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseInvocations} from './runtime/src/bench/models/invocation-log.mjs';
import {compileControllerRequest} from './model.mjs';
import {inspectRegisteredNativeCheckpoint} from './native-history-checkpoint.mjs';
import {inspectNativeKnowledge} from './native-skill-audit.mjs';
import {inspectEmptyGatewayFailure} from './gateway-wait.mjs';
import {nativeTerminalFailure} from './native-failure.mjs';

export const HISTORY_PREFIX_VERSION='registered-native-history-controller-prefix/v1';
const read=p=>JSON.parse(fs.readFileSync(p)),sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const facts=r=>({system:r.system,messages:r.messages,tools:r.tools});
export function inspectNativeHistoryPrefix(proof,calls){
 assert.equal(proof.lineage_version,HISTORY_PREFIX_VERSION);assert.equal(proof.parent_prefix??null,null);
 assert.equal(fs.realpathSync(proof.source),proof.source);assert.equal(proof.exact_request_and_CPU_boundary,true);
 assert.deepEqual(calls,parseInvocations(fs.readFileSync(proof.source+'/invocations.jsonl','utf8'),{strict:true}));
 const registration=proof.native_history_checkpoint,checkpoint=inspectRegisteredNativeCheckpoint(registration);
 assert.deepEqual(checkpoint,registration.attestation);assert.equal(checkpoint.source,proof.source);
 assert.equal(proof.source_invocations_sha256,checkpoint.source_invocations_sha256);
 assert.equal(proof.source_bundle_sha256,checkpoint.source_bundle_sha256);
 assert.equal(sha(proof.source+'/stats.json'),proof.source_stats_sha256);
 const accepted=calls.filter(c=>c.response&&!c.error),failed=calls.filter(c=>c.error);
 // This first-generation contract deliberately rejects inherited/invalid controller prefixes.
 assert.equal(failed.length,1);assert.equal(calls.at(-1),failed[0]);assert(!failed[0].response);
 assert(!accepted.some(c=>c.response.replay||c.replay));assert.equal(proof.accepted_calls,accepted.length);
 assert.equal(proof.prefix.length,accepted.length);assert.equal(proof.steps,checkpoint.steps);assert(proof.steps>=0&&proof.steps<864);
 assert.equal(hash(facts(failed[0].request)),proof.terminal_request_sha256);
 const sourcePlan=read(path.resolve(proof.source,'../..')+'/PLAN.json');
 const names=fs.readdirSync(checkpoint.source_session).filter(n=>/^EXPECTED-CONTROLLER-REQUEST-\d+\.json$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
 assert.deepEqual(read(checkpoint.source_session+'/'+names.at(-1)),compileControllerRequest(sourcePlan.model,failed[0].request));
 const locations=new Set();
 for(let i=0;i<accepted.length;i++){
  const c=accepted[i],p=proof.prefix[i],raw=c.response.raw,m=raw.__code_harness;
  assert.equal(c.call,p.original_call);assert.equal(hash(c.request),p.request_sha256);assert.equal(hash(raw),p.response_sha256);
  assert.equal(m.version,'native-skill-decision-loop/v1');assert.equal(m.native_MCP_called,true);assert.equal(m.native_direct_HTTPS,true);
  assert.equal(path.dirname(m.call_dir),proof.source+'/Code');locations.add(m.call_dir);
  const file=m.call_dir+'/ACCEPTED-PROPOSAL-'+m.native_turn+'.json';assert.equal(sha(file),p.proposal_sha256);
  const {__code_harness,...original}=raw;assert.deepEqual(read(file).raw,original);
  assert.deepEqual(read(m.call_dir+'/EXPECTED-CONTROLLER-REQUEST-'+m.native_turn+'.json'),compileControllerRequest(sourcePlan.model,c.request));
 }
 assert.deepEqual(proof.native_sessions.map(s=>s.location).sort(),[...locations].sort());
 for(const s of proof.native_sessions){assert.equal(sha(s.location+'/SESSION.json'),s.session_sha256);assert.equal(sha(s.location+'/stdout.jsonl'),s.stdout_sha256);
  const session=read(s.location+'/SESSION.json'),events=fs.readFileSync(s.location+'/stdout.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(inspectNativeKnowledge(s.location,session,events,read(s.location+'/LAUNCH.json').max_native_model_turns),s.knowledge);}
 const all=new Set([...locations,checkpoint.source_session]);
 for(const s of proof.gateway_failure_sessions){
  assert.equal(path.dirname(s.location),proof.source+'/Code');assert(!all.has(s.location));all.add(s.location);
  assert.equal(sha(s.location+'/SESSION.json'),s.session_sha256);assert.equal(sha(s.location+'/stdout.jsonl'),s.stdout_sha256);
  inspectEmptyGatewayFailure(s.location);const rows=fs.readFileSync(s.location+'/stdout.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(nativeTerminalFailure(rows)?.status,s.status);assert([429,500,502,503,504].includes(s.status));
  assert.equal(sha(s.location+'/EXPECTED-CONTROLLER-REQUEST-1.json'),s.expected_request_sha256);
  const call=calls.find(c=>c.call===s.logical_call);assert(call);assert.deepEqual(read(s.location+'/EXPECTED-CONTROLLER-REQUEST-1.json'),compileControllerRequest(sourcePlan.model,call.request));
 }
 assert.deepEqual(fs.readdirSync(proof.source+'/Code').filter(n=>/^session-\d+$/.test(n)).map(n=>proof.source+'/Code/'+n).sort(),[...all].sort());
 return {calls,accepted,remaining_native_turns:checkpoint.remaining_native_turns,native_history_checkpoint:registration};
}

export function createNativeHistoryPrefixOffline({proof,calls,env}){
 proof=structuredClone(proof);calls=structuredClone(calls);const inspected=inspectNativeHistoryPrefix(proof,calls);
 let at=0,boundary=false,closed=false;
 return {async complete(request){assert(!closed);
  if(at<inspected.accepted.length){const c=inspected.accepted[at++];assert.deepEqual(facts(request),facts(c.request));
   const raw=structuredClone(c.response.raw),content=raw.content.map(b=>b.type==='tool_use'?{...b,name:b.name.replace(/^mcp__experiment__/,'')}:b),uses=content.filter(b=>b.type==='tool_use');assert.equal(uses.length,1);
   return {tool_call:{id:uses[0].id,name:uses[0].name,input:uses[0].input},text:content.filter(b=>b.type==='text').map(b=>b.text).join('\n'),provider:{adapter:'anthropic',content},raw,usage:c.response.usage??{},
    replay:{source:proof.source+'/invocations.jsonl',source_sha256:proof.source_invocations_sha256,original_call:c.call,registered_prefix_sha256:hash(proof),no_new_api_call:true}};
  }
  inspectNativeHistoryPrefix(proof,calls);assert.equal(hash(facts(request)),proof.terminal_request_sha256);assert.equal(env.step_count,proof.steps);
  const current=env.exportBundle(),original=read(proof.source+'/bundle.json');assert.deepEqual(current.manifest.config,original.manifest.config);
  for(const key of ['trajectory','evaluator_only','metrics'])assert.deepEqual(current[key],original[key]);
  boundary=true;closed=true;throw Object.assign(new Error('OFFLINE_NATIVE_PREFIX_BOUNDARY_NO_NETWORK'),{status:401,retryable:false});
 },async close(){closed=true;},get diagnostics(){return {historical_calls_reconstructed:at,prefix_boundary_verified:boundary,actual_upstream_API_calls:0,paid_continuation_allowed:false};}};
}
