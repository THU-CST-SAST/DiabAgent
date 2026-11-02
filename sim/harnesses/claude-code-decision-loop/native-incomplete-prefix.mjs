import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseInvocations} from './runtime/src/bench/models/invocation-log.mjs';
import {enforceToolContract,truncatedToolReply} from './runtime/src/bench/models/tool-contract.mjs';
import {compileControllerRequest} from './model.mjs';
import {inspectRegisteredNativeCheckpoint} from './native-history-checkpoint.mjs';
import {inspectNativeRegisteredPrefix} from './native-registered-prefix.mjs';

export const INCOMPLETE_PREFIX_VERSION="registered-runtime-session-controller-prefix/v1";
const read=p=>JSON.parse(fs.readFileSync(p));
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const facts=r=>({system:r.system,messages:r.messages,tools:r.tools});

export function inspectIncompleteControllerPrefix(proof,calls){
  assert.equal(proof.lineage_version,INCOMPLETE_PREFIX_VERSION);
  assert.equal(proof.exact_request_and_CPU_boundary,true);
  assert.equal(fs.realpathSync(proof.source),proof.source);
  assert.deepEqual(calls,parseInvocations(fs.readFileSync(proof.source+'/invocations.jsonl','utf8'),{strict:true}));
  const registration=proof.native_history_checkpoint,checkpoint=inspectRegisteredNativeCheckpoint(registration);
  assert.deepEqual(checkpoint,registration.attestation);
  assert.equal(checkpoint.human_authorized_unfinished_retry,true);
  assert.equal(checkpoint.source,proof.source);
  for(const [name,key]of [['invocations.jsonl','source_invocations_sha256'],['bundle.json','source_bundle_sha256'],['stats.json','source_stats_sha256']])assert.equal(sha(proof.source+'/'+name),proof[key]);
  assert.equal(proof.source_invocations_sha256,checkpoint.source_invocations_sha256);
  assert.equal(proof.source_bundle_sha256,checkpoint.source_bundle_sha256);
  assert.equal(proof.steps,checkpoint.steps);
  assert.equal(read(proof.source+'/stats.json').parse_errors,proof.preserved_parse_errors);
  const sourcePlan=read(path.resolve(proof.source,'../..')+'/PLAN.json');
  const task=sourcePlan.tasks.find(t=>t.task_id===proof.id);assert(task);
  assert.deepEqual(task.registered_prefix??null,proof.parent_prefix??null);
  const inherited=proof.parent_prefix?inspectNativeRegisteredPrefix(proof.parent_prefix).accepted:[];
  const terminal=calls.at(-1);assert.equal(terminal.error?.status,502);
  assert.equal(terminal.response?.raw.stop_reason??null,null);
  assert.equal(hash(facts(terminal.request)),proof.terminal_request_sha256);
  assert.deepEqual(read(checkpoint.source_session+'/'+(registration.runtime??registration.incomplete).expected_file),compileControllerRequest(sourcePlan.model,terminal.request));
  const prior=calls.slice(0,-1);assert(prior.every(c=>c.response?.raw));
  assert.equal(prior.length,proof.response_prefix.length);
  const accepted=prior.filter(c=>!c.error);
  assert.equal(accepted.length,proof.accepted_calls);
  assert.equal(prior.length-accepted.length,proof.rejected_calls);
  assert.equal(proof.prefix.length,accepted.length);
  let inheritedAt=0,goodAt=0;
  for(let i=0;i<prior.length;i++){
    const call=prior[i],p=proof.response_prefix[i],raw=call.response.raw,m=raw.__code_harness;
    assert.equal(call.call,p.original_call);assert.equal(hash(call.request),p.request_sha256);assert.equal(hash(raw),p.response_sha256);
    assert.deepEqual(call.error??null,p.error);
    assert.equal(m.native_direct_HTTPS,true);
    if(call.response.replay||call.replay){
      const old=inherited[inheritedAt++];assert(old&&!call.error);
      assert.deepEqual(facts(call.request),facts(old.request));assert.deepEqual(raw,old.response.raw);
      const replay=call.response.replay??call.replay;
      assert.equal(replay.no_new_api_call,true);assert.equal(replay.source_sha256,proof.parent_prefix.source_invocations_sha256);
      assert.equal(replay.registered_prefix_sha256,hash(proof.parent_prefix));
    }else assert.equal(path.dirname(m.call_dir),proof.source+'/Code');
    const proposal=m.call_dir+'/ACCEPTED-PROPOSAL-'+m.native_turn+'.json';
    assert.equal(sha(proposal),p.proposal_sha256);
    const {__code_harness,...provider}=raw;assert.deepEqual(read(proposal).raw,provider);
    assert.deepEqual(read(m.call_dir+'/EXPECTED-CONTROLLER-REQUEST-'+m.native_turn+'.json'),compileControllerRequest(sourcePlan.model,call.request));
    if(call.error)assert.equal(call.error.code,'TOOL_CONTRACT');
    else{assert.equal(m.native_MCP_called,true);assert.deepEqual(proof.prefix[goodAt++],{original_call:p.original_call,request_sha256:p.request_sha256,response_sha256:p.response_sha256,proposal_sha256:p.proposal_sha256});}
  }
  assert.equal(inheritedAt,inherited.length);
  const names=fs.readdirSync(proof.source+'/Code').filter(n=>/^session-\d+$/.test(n)).sort();
  assert.deepEqual(names,proof.source_sessions.map(s=>s.name).sort());
  for(const s of proof.source_sessions){for(const [file,digest]of Object.entries(s.files)){assert.equal(path.basename(file),file);assert.equal(sha(proof.source+'/Code/'+s.name+'/'+file),digest);}
    for(const required of ['SESSION.json','stdout.jsonl','LAUNCH.json'])assert.match(s.files[required],/^[a-f0-9]{64}$/);}
  return {calls,accepted,prior,remaining_native_turns:checkpoint.remaining_native_turns,native_history_checkpoint:registration};
}

export function createIncompleteControllerPrefixOffline({proof,calls,env}){
  proof=structuredClone(proof);calls=structuredClone(calls);
  const inspected=inspectIncompleteControllerPrefix(proof,calls);
  let at=0,boundary=false;
  return {name:'Registered incomplete native history CPU replay',adapter:'anthropic',config:read(proof.source+'/../../PLAN.json').model,
    async complete(request){
      if(at<inspected.prior.length){
        const original=inspected.prior[at++];assert.deepEqual(facts(request),facts(original.request));
        const raw=structuredClone(original.response.raw),content=raw.content.map(b=>b.type==='tool_use'?{...b,name:b.name.replace(/^mcp__experiment__/,'')}:b),uses=content.filter(b=>b.type==='tool_use');
        const replay={source:proof.source+'/invocations.jsonl',source_sha256:proof.source_invocations_sha256,original_call:original.call,registered_prefix_sha256:hash(proof),no_new_api_call:true};
        const result={tool_call:uses[0]?{id:uses[0].id,name:uses[0].name,input:uses[0].input}:null,text:content.filter(b=>b.type==='text').map(b=>b.text).join('\n'),provider:{adapter:'anthropic',content},raw,usage:original.response.usage??{},stop_reason:raw.stop_reason,replay};
        if(raw.stop_reason==='max_tokens'){const e=truncatedToolReply(raw);assert.equal(e.message,original.error?.message);e.repair_result.replay=replay;throw e;}
        try{const valid=enforceToolContract(result,request.tools,'anthropic',{calls:uses.length});assert(!original.error);return valid;}
        catch(e){if(original.error){assert.equal(e.message,original.error.message);assert.equal(e.code,original.error.code);assert(e.repair_result);e.repair_result.replay=replay;throw e;}
          const config=read(proof.source+'/../../PLAN.json').model;if(config.tool_contract_repair&&['simulate','read_glucose_history'].includes(result.tool_call?.name))return {...result,tool_validation_error:e.message};throw e;}
      }
      assert.equal(hash(facts(request)),proof.terminal_request_sha256);assert.equal(env.step_count,proof.steps);
      const actual=env.exportBundle(),original=read(proof.source+'/bundle.json');
      for(const key of ['trajectory','evaluator_only','metrics'])assert.deepEqual(actual[key],original[key]);
      assert.deepEqual(actual.manifest.config,original.manifest.config);
      inspectIncompleteControllerPrefix(proof,calls);boundary=true;
      throw Object.assign(new Error('OFFLINE_NATIVE_PREFIX_BOUNDARY_NO_NETWORK'),{status:401,retryable:false});
    },async close(){},get diagnostics(){return {historical_calls_reconstructed:at,prefix_boundary_verified:boundary,actual_upstream_API_calls:0,paid_continuation_allowed:false};}};
}
