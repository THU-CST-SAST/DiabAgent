import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseInvocations} from './runtime/src/bench/models/invocation-log.mjs';
import {PREFIX} from './history.mjs';
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const prefixHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const requestFacts=request=>({system:request.system,messages:request.messages,tools:request.tools});

export function inspectRegisteredPrefix(proof) {
  const original=proof.source,file=original+'/invocations.jsonl';
  assert.equal(sha(file),proof.source_invocations_sha256);
  assert.equal(sha(original+'/stats.json'),proof.source_stats_sha256);
  assert.equal(sha(original+'/bundle.json'),proof.source_bundle_sha256);
  const calls=parseInvocations(fs.readFileSync(file,'utf8'),{strict:true});
  const accepted=calls.filter(call=>call.response&&!call.error);
  assert.equal(accepted.length,proof.accepted_calls);
  const accounted=new Set(accepted.map(call=>{const {__code_harness,...raw}=call.response.raw;return prefixHash(raw);}));
  const names=fs.readdirSync(original+'/Code').filter(n=>/^session-\d+$/.test(n)).sort((a,b)=>Number(a.slice(8))-Number(b.slice(8)));
  let lastComplete=0;
  for(const name of names) {
    const dir=original+'/Code/'+name;
    const files=fs.readdirSync(dir).filter(n=>/^COMPLETE-NATIVE-REPLY-.*\.json$/.test(n));
    if(name===names.at(-1))lastComplete=files.length;
    for(const file of files) {
      const raw=read(dir+'/'+file);
      if(accounted.has(prefixHash(raw)))continue;
      const uses=raw.content?.filter(b=>b.type==='tool_use')??[];
      // These are explicitly rejected native batches/JSON, not accepted actions. A solitary complete
      // late reply must be adopted through a separately proven chronological path, never redrawn here.
      const invalid=uses.length>1||uses.some(b=>b.input?.__unparsedToolInput);
      assert(invalid,'Unconsumed complete native response requires reconciliation before any new request: '+dir+'/'+file);
    }
  }
  assert(lastComplete<7,'Original native turn allowance exhausted; no reset on continuation');
  return {calls,accepted,remaining_native_turns:7-lastComplete,last_native_complete_replies:lastComplete};
}

export function prefixResponse(entry,proof) {
  const raw=entry.response.raw,meta=raw.__code_harness;
  assert(meta?.native_MCP_called&&meta.version==='native-decision-loop/v1');
  assert(meta.call_dir.startsWith(proof.source+'/Code/'));
  const content=raw.content.map(block=>block.type==='tool_use'&&block.name.startsWith(PREFIX)?{...block,name:block.name.slice(PREFIX.length)}:block);
  const uses=content.filter(b=>b.type==='tool_use');assert.equal(uses.length,1);
  const use=uses[0],usage=raw.usage??{};
  return {tool_call:{id:use.id,name:use.name,input:use.input},text:content.filter(b=>b.type==='text').map(b=>b.text).join('\n'),
    provider:{adapter:'anthropic',content},raw,stop_reason:raw.stop_reason,
    usage:{input_tokens:(usage.input_tokens??0)+(usage.cache_creation_input_tokens??0)+(usage.cache_read_input_tokens??0),
      output_tokens:usage.output_tokens??0,cache_read_input_tokens:usage.cache_read_input_tokens??0,
      cache_creation_input_tokens:usage.cache_creation_input_tokens??0},
    latency_ms:Math.max(0,Date.parse(entry.finished)-Date.parse(entry.started)),
    replay:{source:proof.source+'/invocations.jsonl',source_sha256:proof.source_invocations_sha256,
      original_call:entry.call,registered_prefix_sha256:prefixHash(proof),no_new_api_call:true}};
}

export function createRegisteredPrefixModel({delegate,proof,env,dir}) {
  const inspected=inspectRegisteredPrefix(proof);let at=0,boundary=false,closed=false;
  return {...delegate,async complete(request) {
    assert(!closed);
    if(at<inspected.accepted.length) {
      const entry=inspected.accepted[at],registered=proof.prefix[at];
      assert.equal(prefixHash(requestFacts(request)),registered.request_sha256);
      assert.deepEqual(requestFacts(request),requestFacts(entry.request));
      assert.equal(prefixHash(entry.response.raw),registered.response_sha256);at++;
      return prefixResponse(entry,proof);
    }
    if(!boundary) {
      assert.equal(prefixHash(requestFacts(request)),proof.terminal_request_sha256);
      assert.equal(env.step_count,proof.steps);
      const actual=env.exportBundle(),expected=read(proof.source+'/bundle.json');
      assert.deepEqual(actual.manifest.config,expected.manifest.config);
      assert.deepEqual(actual.trajectory,expected.trajectory);
      assert.deepEqual(actual.evaluator_only.states,expected.evaluator_only.states);
      assert.equal(sha(proof.source+'/invocations.jsonl'),proof.source_invocations_sha256);
      boundary=true;
      fs.writeFileSync(dir+'/RESUME-BOUNDARY.json',JSON.stringify({checked:new Date().toISOString(),
        prefix_sha256:prefixHash(proof),accepted_historical_calls:at,steps:env.step_count,
        exact_CPU_state:true,remaining_initial_native_turns:inspected.remaining_native_turns,
        historical_native_corrections_preserved:true,no_historical_reply_redrawn:true},null,2)+'\n',{flag:'wx'});
    }
    return delegate.complete(request);
  },async close(){closed=true;await delegate.close();},
  get diagnostics(){return {...delegate.diagnostics,historical_calls_reconstructed:at,prefix_boundary_verified:boundary};}};
}
