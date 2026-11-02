import fs from 'node:fs';
import {inspectNativeRuntimeCheckpoint} from './native-runtime-recovery.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { parseInvocations } from './runtime/src/bench/models/invocation-log.mjs';
import * as scoring from './runtime/src/bench/score.mjs';
import { verifierReport } from './runtime/src/export/harbor/score.mjs';
import { parseCodeStream } from './reply-parser.mjs';
import {assistantReplies} from './native-assistant.mjs';
import {nativeStreamJsonNote} from './native-note-json-binding.mjs';
import { compileControllerRequest } from './model.mjs';
import { PREFIX } from './history.mjs';
import { LOOP_TOOLS,PARALLEL_REJECTION } from './native-session.mjs';
import { STANDARD_HARNESS } from './standard.mjs';
import { prefixHash, requestFacts, inspectRegisteredPrefix } from './registered-prefix.mjs';
import {NATIVE_SKILL_VERSION} from './native-skill.mjs';
import {inspectNativeKnowledge} from './native-skill-audit.mjs';
import {inspectNativeRegisteredPrefix} from './native-registered-prefix.mjs';
import {SimEnv} from './runtime/src/env/pomdp.mjs';
import {replayWorldEvidence} from './world-replay.mjs';
import {inspectEmptyGatewayFailure} from './gateway-wait.mjs';
import {inspectNativeQueryFailure} from './native-query-wait.mjs';
import {PENDING_PREFIX_VERSION,pendingPrefixCorrection} from './native-pending-prefix.mjs';
import {verifyPendingCorrection} from './native-pending-parallel.mjs';
import {HISTORY_PREFIX_VERSION} from './native-history-prefix.mjs';
import {INCOMPLETE_PREFIX_VERSION} from './native-incomplete-prefix.mjs';
import {inspectRegisteredNativeCheckpoint,inspectNativeHistoryRetry} from './native-history-checkpoint.mjs';

// Splits Code's public stream into complete assistant messages (one per native turn, including corrections).
function streamMessages(events, model, authorizedUnsignedId=null) {
  const out = []; let frames = [];
  for (const event of events) { frames.push(event); if (event.type === 'message_stop') {
    const start=frames.find(e=>e.type==='message_start');
    if(authorizedUnsignedId&&typeof authorizedUnsignedId==='object'&&start?.message?.id===authorizedUnsignedId.id){assert.deepEqual(parseCodeStream(frames.map(e=>'data: '+JSON.stringify(e)).join('\n'),{model}).raw,authorizedUnsignedId.raw);}
    else if(authorizedUnsignedId&&start?.message?.id===authorizedUnsignedId){
      assert(!frames.some(e=>e.type==='message_delta'&&e.delta?.stop_reason));
      assert(frames.filter(e=>e.type==='content_block_start').every(e=>e.content_block.type==='thinking'&&!e.content_block.signature));
      assert(frames.filter(e=>e.type==='content_block_delta').every(e=>e.delta.type==='thinking_delta'));
    }else out.push(parseCodeStream(frames.map(e => 'data: ' + JSON.stringify(e)).join('\n'), { model }).raw);
    frames = [];
  } }
  return out;
}

const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function auditDirectTrial({ dir, config, expectedConfig, offlineOnly = false, persist = true, maxTurns = STANDARD_HARNESS.max_native_turns_per_decision, registeredPrefix = null, nativeSkill = false, scoringVersion = 'METRICS-v0.3' }) {
  if(nativeSkill&&registeredPrefix)assert.ok(['registered-native-skill-prefix/v1','registered-native-skill-prefix/v2',PENDING_PREFIX_VERSION,HISTORY_PREFIX_VERSION,INCOMPLETE_PREFIX_VERSION].includes(registeredPrefix.lineage_version));
  const stats = read(dir + '/stats.json'), bundle = read(dir + '/bundle.json');
  const calls = parseInvocations(fs.readFileSync(dir + '/invocations.jsonl', 'utf8'), { strict: true });
  const rows = fs.readFileSync(dir + '/transcript.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse), actions = rows.filter(row => row.parsed && row.receipt), fixed = actions.filter(row => row.decision_kind === 'fixed');
  const successes = calls.filter(row => row.response && !row.error);
  let contexts = true, provenance = true, publicStream = true, sessionsClosed = true, nativeCorrections = 0, continuations = 0;
  const sessionDirs = new Set();
  const inspected = registeredPrefix ? (nativeSkill?inspectNativeRegisteredPrefix(registeredPrefix):inspectRegisteredPrefix(registeredPrefix)) : null;
  let historical = 0, fresh = 0;
  const waits=fs.existsSync(dir+'/GATEWAY-WAIT.jsonl')?fs.readFileSync(dir+'/GATEWAY-WAIT.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  const queryWaitSources=new Set([...waits.filter(e=>e.query_resume).map(e=>e.session_dir),...waits.filter(e=>e.native_history_resume).map(e=>e.native_history_resume.source_session)]);
  const historySources=new Set();
  const allowedTurns = location => {
    if(fs.existsSync(location+'/NATIVE-RESUME-REGISTRATION.json')){
      const registration=read(location+'/NATIVE-RESUME-REGISTRATION.json'),checkpoint=inspectRegisteredNativeCheckpoint(registration);
      assert.deepEqual(checkpoint,registration.attestation);historySources.add(checkpoint.source_session);
      assert.equal(read(location+'/NATIVE-RESUME-CHECKPOINT.json').remaining_native_turns,checkpoint.remaining_native_turns);
      return checkpoint.remaining_native_turns;
    }
    if(fs.existsSync(location+'/QUERY-RESUME.json')){
      const evidence=read(location+'/QUERY-RESUME.json'),original=inspectNativeQueryFailure(evidence.query_resume);
      assert.equal(path.dirname(evidence.session_dir),path.dirname(location));
      assert.equal(original.evidence_sha256,evidence.evidence_sha256);
      assert.equal(original.remaining_native_turns,evidence.remaining_native_turns);
      assert.deepEqual(read(location+'/EXPECTED-CONTROLLER-REQUEST-1.json'),read(evidence.session_dir+'/EXPECTED-CONTROLLER-REQUEST-'+(evidence.query_resume.cursor.turns+1)+'.json'));
      return evidence.remaining_native_turns;
    }
    if(fs.existsSync(location+'/INITIAL-RESUME-ALLOWANCE.json')){
      assert(registeredPrefix);
      const remaining=read(location+'/INITIAL-RESUME-ALLOWANCE.json').remaining_native_turns;
      if(location.startsWith(dir+'/Code/'))assert.equal(remaining,inspected.remaining_native_turns);
      else assert(registeredPrefix.native_sessions.some(s=>s.location===location)&&remaining>=1&&remaining<=maxTurns);
      return remaining;
    }
    return registeredPrefix && location === dir + '/Code/session-1' ? inspected.remaining_native_turns : maxTurns;
  };
  const tools = new Set();
  const knowledge=new Map();
  for (const call of successes) {
    const raw = call.response.raw, meta = raw.__code_harness, uses = raw.content.filter(block => block.type === 'tool_use');
    const replay = call.replay ?? call.response.replay;
    const lineage = registeredPrefix && replay && replay.source_sha256 === registeredPrefix.source_invocations_sha256 && replay.registered_prefix_sha256 === prefixHash(registeredPrefix);
    if (lineage) {
      const expected = registeredPrefix.prefix[historical];
      assert.equal(fresh, 0); assert.ok(expected); assert.equal(replay.original_call, expected.original_call);
      assert.equal(replay.source,registeredPrefix.source+'/invocations.jsonl');
      if(nativeSkill)assert.deepEqual(requestFacts(call.request),requestFacts(inspected.accepted[historical].request));
      else assert.equal(prefixHash(requestFacts(call.request)), expected.request_sha256);
      assert.equal(prefixHash(raw), expected.response_sha256); historical++;
    } else { assert.ok(!replay, 'Unregistered replay'); fresh++; }
    const inheritedNativeSession=lineage&&nativeSkill&&registeredPrefix.native_sessions.some(s=>s.location===meta?.call_dir);
    const sourceDir = inheritedNativeSession ? path.dirname(path.dirname(meta.call_dir)) : lineage ? registeredPrefix.source : dir;
    if (meta?.version !== (nativeSkill?NATIVE_SKILL_VERSION:'native-decision-loop/v1') || !meta.native_MCP_called || !meta.call_dir.startsWith(sourceDir + '/Code/') || uses.length !== 1 || meta.native_direct_HTTPS !== (lineage ? true : !offlineOnly)) { provenance = false; continue; }
    const location = fs.realpathSync(meta.call_dir);
    assert.ok(location.startsWith(fs.realpathSync(sourceDir) + path.sep));
    const session = read(location + '/SESSION.json'), launch = read(location + '/LAUNCH.json'), expected = read(location + '/EXPECTED-CONTROLLER-REQUEST-' + meta.native_turn + '.json');
    assert.equal(expected.output_config.effort,config.reasoning_effort);assert.equal(launch.argv[launch.argv.indexOf('--effort')+1],config.reasoning_effort);
    sessionDirs.add(location); nativeCorrections += meta.native_corrections?.length ?? 0; if (meta.in_process_continuation) continuations++;
    const { __code_harness, ...original } = raw;
    const accepted = read(location + '/ACCEPTED-PROPOSAL-' + meta.native_turn + '.json');
    const use = uses[0], name = use.name.startsWith(PREFIX) ? use.name.slice(PREFIX.length) : use.name;
    tools.add(name);
    provenance &&= isDeepStrictEqual(accepted.raw, original) && session.native_MCP_receipts.some(receipt => receipt._meta?.['claudecode/toolUseId'] === use.id && receipt.name === name && isDeepStrictEqual(receipt.arguments, use.input));
    provenance &&= launch.http_forwarder === false && launch.extra_body === false && launch.max_native_retries === 0 && launch.max_native_model_turns === allowedTurns(location) && (offlineOnly && !lineage ? launch.endpoint.startsWith('http://127.0.0.1:') : launch.endpoint === (process.env.DIABAGENT_CODE_BASE_URL ?? 'https://api.anthropic.com'));
    contexts &&= isDeepStrictEqual(expected, compileControllerRequest(config, call.request));
    if(!lineage&&config.max_tokens===16384){assert.equal(expected.max_tokens,16384);assert.equal(launch.max_output_tokens,16384);}
    if(fs.existsSync(location+'/REGISTERED-PARALLEL-CORRECTION.json')){
      assert.equal(registeredPrefix?.lineage_version,PENDING_PREFIX_VERSION);
      const correction=read(location+'/REGISTERED-PARALLEL-CORRECTION.json'),first=read(location+'/EXPECTED-CONTROLLER-REQUEST-1.json');
      assert.deepEqual(correction,pendingPrefixCorrection(registeredPrefix));verifyPendingCorrection(correction,first);
      assert.equal(launch.max_native_model_turns,6);
      const results=correction.raw.content.filter(b=>b.type==='tool_use').map(u=>({type:'tool_result',tool_use_id:u.id,content:PARALLEL_REJECTION,is_error:true}));
      const projection={...expected,messages:[...expected.messages.slice(0,first.messages.length),{role:'assistant',content:correction.raw.content},{role:'user',content:results},...expected.messages.slice(first.messages.length)]};
      assert.deepEqual(read(location+'/EXPECTED-NATIVE-CORRECTION-REQUEST-'+meta.native_turn+'.json'),projection);
      const derived=read(location+'/DERIVED-PARALLEL-REJECTIONS.json');assert.equal(derived.origin,'New registered policy results; not original MCP results');
      assert.deepEqual(derived.results,results);assert.equal(derived.remaining_native_turns,6);assert.equal(derived.consumed_original_native_turns,1);
      const sid=launch.argv[launch.argv.indexOf('--resume')+1],history=fs.readFileSync(location+'/home/projects/decision-loop/'+sid+'.jsonl','utf8').split('\n').filter(Boolean).map(JSON.parse);
      assert.equal(history.filter(e=>e.type==='assistant'&&isDeepStrictEqual(e.message?.content,correction.raw.content)).length,1);
      const ids=new Set(results.map(r=>r.tool_use_id)),actual=history.flatMap(e=>Array.isArray(e.message?.content)?e.message.content:[]).filter(b=>b.type==='tool_result'&&ids.has(b.tool_use_id));
      assert.deepEqual(actual,results);
    }
    const rows = fs.readFileSync(location + '/stdout.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const initial=registeredPrefix?.native_history_checkpoint;
    const runtime=initial?.runtime??(fs.existsSync(location+'/RUNTIME-RECOVERY-CHECKPOINT.json')?read(location+'/RUNTIME-RECOVERY-CHECKPOINT.json').runtime:null);
    let authorizedUnsignedId=null;
    if(runtime&&location===runtime.session){inspectNativeRuntimeCheckpoint(runtime);const raw=Object.keys(runtime.files).filter(f=>/^COMPLETE-NATIVE-REPLY-.*\.json$/.test(f)&&!/-STREAM-JSON-BINDING|-BOUND-NATIVE-JSON/.test(f)).map(f=>read(location+'/'+f)).find(v=>!v.stop_reason);authorizedUnsignedId={id:raw.id,raw};}
    else if(registeredPrefix?.lineage_version===INCOMPLETE_PREFIX_VERSION&&location===initial?.incomplete?.session)authorizedUnsignedId=initial.incomplete.unfinished_message_id;
    if(nativeSkill){
      if(!knowledge.has(location))knowledge.set(location,inspectNativeKnowledge(location,session,rows,allowedTurns(location)));
      for(const record of meta.native_internal??[])assert(knowledge.get(location).internal.some(r=>isDeepStrictEqual(r,record)));
      const system=expected.system.map(b=>b.text).join('\n');
      const appended=launch.argv[launch.argv.indexOf('--append-system-prompt')+1];
      contexts&&=appended.startsWith(system+'\n\n');
      assert(!expected.tools.some(t=>t.name==='read_glucose_skill'));
    }
    const native = meta.native_reply_source==='native-stream-json-note/v1'
      ?streamMessages(rows.filter(event=>event.type==='stream_event').map(event=>event.event),config.model,authorizedUnsignedId).map(raw=>nativeStreamJsonNote(raw,rows,session.native_MCP_receipts)).filter(Boolean)
      :meta.native_reply_source==='native-assistant-chunks/v1'
      ?assistantReplies(rows,session.native_MCP_receipts,{model:config.model,nativeWitnesses:knowledge.get(location)?.witnesses??[]})
      :streamMessages(rows.filter(event=>event.type==='stream_event').map(event=>event.event),config.model,authorizedUnsignedId);
    publicStream &&= native.some(message => isDeepStrictEqual(message, original));
    if(nativeSkill){
      const all=[...streamMessages(rows.filter(e=>e.type==='stream_event').map(e=>e.event),config.model,authorizedUnsignedId),
        ...assistantReplies(rows,session.native_MCP_receipts,{model:config.model,nativeWitnesses:knowledge.get(location).witnesses})];
      publicStream&&=knowledge.get(location).internal.every(r=>all.some(m=>isDeepStrictEqual(m,r.raw)));
    }
    sessionsClosed &&= session.exit != null;
  }
  const truth = bundle.evaluator_only.states, start = Date.parse(bundle.manifest.config.start_time);
  assert(['METRICS-v0.3','COGI-4-8/v1'].includes(scoringVersion));
  const native = verifierReport(bundle, scoring, { scoring_version: scoringVersion, verifier: 'daily' }, { episode_id: bundle.manifest.episode_id, agent_completed: stats.state === 'done', agent_steps: bundle.metrics.steps, verifier_wait_steps: 0 });
  const independent = scoring.episodeScore(scoring.episodeMetrics(bundle), scoring.DEFAULT_WEIGHTS, { version: scoringVersion });
  const worldReplay=nativeSkill?replayWorldEvidence(bundle,expectedConfig,c=>new SimEnv(c)):null;
  const checks = { world_config: isDeepStrictEqual(bundle.manifest.config, expectedConfig), horizon: expectedConfig.horizon_minutes === 4320, original_controller_done: stats.state === 'done', steps: bundle.metrics.steps === 864, truth_points: truth.length === 865, elapsed: bundle.metrics.elapsed_minutes === 4320, complete: bundle.metrics.completed_horizon === true, fixed_hours: stats.fixed_decisions === 72 && fixed.length === 72, fixed_grid: fixed.every((row, i) => Date.parse(row.sim_time) === start + i * 3600000), truth_grid: truth.every((row, i) => Date.parse(row.time) === start + i * 300000 && Number.isFinite(row.true_glucose_mg_dl)), extra_cap: Object.values(stats.extra_decisions_by_local_day ?? {}).every(n => n <= 6), no_WAIT_tail: !bundle.trajectory.some(row => /harness:.*remaining horizon|validator.*WAIT/i.test(row.rationale ?? '')), native_reward: native.reward.reward === independent.score && native.metrics.reward.reward === native.reward.reward && native.metrics.scoring_version === scoringVersion, no_verifier_fill: native.reward.verifier_wait_steps === 0, all_successes_native_MCP: successes.length > 0 && provenance, complete_public_stream_preserved: publicStream, compiled_controller_contexts_equal: contexts, only_query_tools_continue_and_act_ends_process: [...sessionDirs].every(location => { const turns = read(location + '/SESSION.json').turns; return turns.length >= 1 && turns.length <= allowedTurns(location) && turns.slice(0, -1).every(t => LOOP_TOOLS.includes(t.tool) && t.mcp) && (registeredPrefix && (nativeSkill ? registeredPrefix.native_sessions.some(s=>s.location===location) : location.startsWith(registeredPrefix.source + '/Code/')) || !LOOP_TOOLS.includes(turns.at(-1).tool)); }), sessions_closed: sessionsClosed, registered_lineage: registeredPrefix ? historical === registeredPrefix.accepted_calls && fresh > 0 : calls.every(row => !row.replay && !row.response?.replay) };
  if(nativeSkill){checks.world_config=worldReplay.valid;checks.original_world_replays_exactly=worldReplay.valid;}
  if(queryWaitSources.size)checks.only_query_tools_continue_and_act_ends_process=[...sessionDirs].every(location=>{
    const turns=read(location+'/SESSION.json').turns;
    return turns.length>=1&&turns.length<=allowedTurns(location)&&turns.slice(0,-1).every(t=>LOOP_TOOLS.includes(t.tool)&&t.mcp)
      &&(queryWaitSources.has(location)||(registeredPrefix&&(nativeSkill?registeredPrefix.native_sessions.some(s=>s.location===location):location.startsWith(registeredPrefix.source+'/Code/')))||!LOOP_TOOLS.includes(turns.at(-1).tool));
  });
  if(fs.existsSync(dir+'/GATEWAY-WAIT.jsonl')){
    for(const event of waits){
      assert.equal(path.dirname(event.session_dir),fs.realpathSync(dir+'/Code'));
      if(event.native_history_resume){const descriptor=read(event.session_dir+'/REGISTERED-NATIVE-RETRY.json'),evidence=inspectNativeHistoryRetry(descriptor);
        assert.deepEqual(event.native_history_resume,evidence.native_history_resume);assert.equal(event.evidence_sha256,evidence.evidence_sha256);assert.equal(event.remaining_native_turns,evidence.remaining_native_turns);}
      else assert.equal((event.query_resume?inspectNativeQueryFailure(event.query_resume):inspectEmptyGatewayFailure(event.session_dir)).evidence_sha256,event.evidence_sha256);
    }
    checks.gateway_wait_evidence=waits.every(event=>event.delay_ms>=60000);
  }
  const valid = Object.values(checks).every(Boolean);
  const report = { checked: new Date().toISOString(), valid, offline_only: offlineOnly, lineage_version: registeredPrefix ? 'registered-native-prefix/v1' : null, historical_registered_calls: historical, new_native_calls: fresh, no_replays: !registeredPrefix, completed_model_trajectories: valid && !offlineOnly ? 1 : 0, scoring_version: scoringVersion, scientific_score: valid && !offlineOnly ? native.reward.reward : null, scripted_infrastructure_score_not_model: valid && offlineOnly ? native.reward.reward : null, checks, world_config_sha256: hash(expectedConfig), completed_logical_model_boundaries: successes.length, Code_processes: sessionDirs.size, in_process_continuations: continuations, native_corrections: nativeCorrections, tool_names: [...tools], actual_HTTP: null, actual_wire_requests: null, direct_request_body_not_intercepted: !offlineOnly, construction_not_live_wire_equality: true, native_metric: bundle.metrics };
  if(nativeSkill){
    if([HISTORY_PREFIX_VERSION,INCOMPLETE_PREFIX_VERSION].includes(registeredPrefix?.lineage_version)){report.lineage_version=registeredPrefix.lineage_version;report.no_replays=false;}
    if(historySources.size){report.no_replays=false;report.native_history_checkpoint_sources=[...historySources].sort();}
    report.native_world_replay=worldReplay;
    report.native_knowledge={mode:NATIVE_SKILL_VERSION,explicit_task_entries:[...knowledge.values()].reduce((n,k)=>n+k.explicit_task_entries,0),Skill_invocations:[...knowledge.values()].reduce((n,k)=>n+k.skill_invocations,0),reference_reads:[...knowledge.values()].reduce((n,k)=>n+k.reference_reads,0),algorithm_reads:[...knowledge.values()].reduce((n,k)=>n+k.algorithm_reads,0),read_paths:[...new Set([...knowledge.values()].flatMap(k=>k.read_paths))]};
  }
  if (persist) { fs.writeFileSync(dir + '/DECISION-LOOP-AUDIT.json', JSON.stringify(report, null, 2) + '\n'); fs.writeFileSync(dir + '/native-reward.json', JSON.stringify(native.reward, null, 2) + '\n'); }
  return report;
}
