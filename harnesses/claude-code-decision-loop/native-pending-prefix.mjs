import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {inspectPendingParallelReply} from './native-pending-parallel.mjs';
import {inspectNativeKnowledge} from './native-skill-audit.mjs';
import {compileControllerRequest} from './model.mjs';
import {parseInvocations} from './runtime/src/bench/models/invocation-log.mjs';
export const PENDING_PREFIX_VERSION='registered-native-skill-prefix/pending-parallel-v1';
const read=p=>JSON.parse(fs.readFileSync(p)),sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const facts=x=>({system:x.system,messages:x.messages,tools:x.tools});
const lines=p=>fs.readFileSync(p,'utf8').split('\n').filter(Boolean).map(JSON.parse);

export function inspectPendingPrefix(proof,calls){
 assert.equal(proof.lineage_version,PENDING_PREFIX_VERSION);assert.equal(proof.parent_prefix??null,null);
 const source=fs.realpathSync(proof.source);assert.equal(source,proof.source);assert.equal(proof.exact_request_and_CPU_boundary,true);
 assert.deepEqual(calls,parseInvocations(fs.readFileSync(source+'/invocations.jsonl','utf8'),{strict:true}));
 for(const [name,key]of [['stats.json','source_stats_sha256'],['bundle.json','source_bundle_sha256'],['invocations.jsonl','source_invocations_sha256']])assert.equal(sha(source+'/'+name),proof[key]);
 assert.equal(proof.accepted_calls,proof.prefix.length);assert(proof.steps>0&&proof.steps<864);
 const accepted=calls.filter(c=>c.response&&!c.error),failed=calls.filter(c=>c.error);
 assert.equal(accepted.length,proof.accepted_calls);assert.equal(failed.length,1);assert.equal(calls.at(-1),failed[0]);
 assert.equal(failed[0].error.code,'CODE_NATIVE_DEADLINE');assert.equal(failed[0].error.status,504);
 assert.equal(hash(facts(failed[0].request)),proof.terminal_request_sha256);
 const pending=inspectPendingParallelReply(proof.pending_parallel.source);assert.deepEqual(pending,proof.pending_parallel);
 assert.equal(path.dirname(pending.source),source+'/Code');assert.deepEqual(read(proof.pending_parallel_manifest).proof,pending);
 const config=read(path.resolve(source,'../..')+'/PLAN.json').model;
 assert.deepEqual(read(pending.source+'/EXPECTED-CONTROLLER-REQUEST-1.json'),compileControllerRequest(config,failed[0].request));
 const locations=new Set();
 for(let i=0;i<accepted.length;i++){
  const call=accepted[i],p=proof.prefix[i],raw=call.response.raw,m=raw.__code_harness;
  assert.equal(call.call,p.original_call);assert.equal(hash(call.request),p.request_sha256);assert.equal(hash(raw),p.response_sha256);
  assert.equal(m.version,'native-skill-decision-loop/v1');assert.equal(m.native_MCP_called,true);assert.equal(m.native_direct_HTTPS,true);
  const location=fs.realpathSync(m.call_dir);assert.equal(path.dirname(location),source+'/Code');locations.add(location);
  const file=location+'/ACCEPTED-PROPOSAL-'+m.native_turn+'.json';assert.equal(sha(file),p.proposal_sha256);
  const {__code_harness,...original}=raw;assert.deepEqual(read(file).raw,original);
  assert.deepEqual(read(location+'/EXPECTED-CONTROLLER-REQUEST-'+m.native_turn+'.json'),compileControllerRequest(config,call.request));
 }
 assert.equal(accepted.at(-1).response.raw.content.find(b=>b.type==='tool_use').name,'mcp__experiment__act');
 assert.deepEqual(proof.native_sessions.map(s=>s.location).sort(),[...locations].sort());
 for(const s of proof.native_sessions){assert.equal(sha(s.location+'/SESSION.json'),s.session_sha256);assert.equal(sha(s.location+'/stdout.jsonl'),s.stdout_sha256);
  assert.deepEqual(inspectNativeKnowledge(s.location,read(s.location+'/SESSION.json'),lines(s.location+'/stdout.jsonl'),7),s.knowledge);}
 assert.deepEqual(fs.readdirSync(source+'/Code').filter(n=>/^session-\d+$/.test(n)).sort(),[...[...locations].map(p=>path.basename(p)),path.basename(pending.source)].sort());
 assert.equal(read(source+'/bundle.json').metrics.steps,proof.steps);
 return {accepted,calls,remaining_native_turns:6,pending};
}

export function pendingPrefixCorrection(proof){
 return {...proof.pending_parallel,source_manifest:proof.pending_parallel_manifest};
}

export function createPendingPrefixOffline({proof,calls,env}){
 proof=structuredClone(proof);calls=structuredClone(calls);const inspected=inspectPendingPrefix(proof,calls);
 let at=0,closed=false,boundary=false;
 return {async complete(request){assert(!closed);
  if(at<inspected.accepted.length){const c=inspected.accepted[at++];assert.deepEqual(facts(request),facts(c.request));const raw=structuredClone(c.response.raw),
    content=raw.content.map(b=>b.type==='tool_use'?{...b,name:b.name.replace(/^mcp__experiment__/,'')}:b),uses=content.filter(b=>b.type==='tool_use');assert.equal(uses.length,1);
   return {tool_call:{id:uses[0].id,name:uses[0].name,input:uses[0].input},text:content.filter(b=>b.type==='text').map(b=>b.text).join('\n'),
    provider:{adapter:'anthropic',content},raw,usage:c.response.usage??{},stop_reason:raw.stop_reason,
    replay:{source:proof.source+'/invocations.jsonl',source_sha256:proof.source_invocations_sha256,original_call:c.call,registered_prefix_sha256:hash(proof),no_new_api_call:true}};
  }
  inspectPendingPrefix(proof,calls);assert.equal(hash(facts(request)),proof.terminal_request_sha256);assert.equal(env.step_count,proof.steps);
  const actual=env.exportBundle(),original=read(proof.source+'/bundle.json');assert.deepEqual(actual.manifest.config,original.manifest.config);
  for(const k of ['trajectory','evaluator_only','metrics'])assert.deepEqual(actual[k],original[k]);
  boundary=true;closed=true;throw Object.assign(new Error('OFFLINE_NATIVE_PREFIX_BOUNDARY_NO_NETWORK'),{status:401,retryable:false});
 },async close(){closed=true;},get diagnostics(){return {historical_calls_reconstructed:at,prefix_boundary_verified:boundary,actual_upstream_API_calls:0,paid_continuation_allowed:false};}};
}
