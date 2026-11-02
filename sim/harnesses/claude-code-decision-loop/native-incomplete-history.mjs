import fs from 'node:fs';
import {assertDomesticPartialIdentity} from './native-domestic-partial-binding.mjs';
import {modelIdentityMatches} from './model-identity.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const VERSION = "registered-model-bound-unsigned-native-history/v2";
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const read = p => JSON.parse(fs.readFileSync(p));
const rows = p => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const normalized = x => Array.isArray(x) ? x.map(normalized) : x && typeof x === 'object'
  ? Object.fromEntries(Object.entries(x).filter(([k, v]) => k !== 'cache_control' && !(k === 'caller' && v?.type === 'direct')).map(([k, v]) => [k, normalized(v)])) : x;

// Offline evidence only. Preparing or launching a native continuation needs separate qualification.
export function inspectIncompleteNativeHistory(proof) {
  assert.equal(proof.version, VERSION);
  assert.equal(proof.human_instruction, '2026-10-30:之前断的续上');
  assert.equal(proof.exact_model_response_continuation, false);
  const c = proof.cpu, dir = proof.session;
  const sourcePlanPath=path.resolve(c.source,'../..')+'/PLAN.json',sourcePlan=read(sourcePlanPath);
  assert(c.exact_request_and_world && c.steps >= 0);
  assert.equal(fs.realpathSync(dir), dir);
  assert.equal(path.dirname(dir), c.source + '/Code');
  assert.equal(sha(c.source + '/invocations.jsonl'), c.source_invocations_sha256);
  assert.equal(sha(c.source + '/bundle.json'), c.source_bundle_sha256);
  assert.equal(sha(dir + '/SESSION.json'), c.last_session_sha256);
  for (const name of ['SESSION.json', 'stdout.jsonl', 'LAUNCH.json', 'NATIVE-KNOWLEDGE-LEDGER.json', 'native-knowledge-boundary.json', 'mcp.json', 'mcp-tools.json', 'NATIVE-SKILL-MANIFEST.json']) assert.match(proof.files[name], /^[a-f0-9]{64}$/);
  for (const [name, digest] of Object.entries(proof.files)) {
    assert.equal(path.basename(name), name);
    assert.equal(sha(dir + '/' + name), digest);
  }
  const session = read(dir + '/SESSION.json'), launch = read(dir + '/LAUNCH.json');
  assert.equal(session.harness, 'native-skill-decision-loop/v1');
  assert(session.exit !== null && session.exit !== undefined);
  assert.equal(session.actual_HTTP ?? null, null);
  assert(!/quota|balance|credit|forbidden|unauthori[sz]ed|permission/i.test(session.error ?? ''));
  assert.equal(sha(launch.binary), '24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de');
  assert.equal(launch.max_native_retries, 0);
  const limit = launch.max_native_model_turns;
  assert(Number.isInteger(limit) && limit > 0 && limit <= 7);
  assert.equal(Number(launch.argv[launch.argv.indexOf('--max-turns') + 1]), limit);
  assert.equal(path.dirname(proof.history), dir + '/home/projects/decision-loop');
  assert.equal(sha(proof.history), proof.history_sha256);
  const history = rows(proof.history), events = rows(dir + '/stdout.jsonl');
  const expectedNames = fs.readdirSync(dir).filter(n => /^EXPECTED-CONTROLLER-REQUEST-\d+\.json$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  assert.equal(proof.expected_file, expectedNames.at(-1));
  assert.equal(sha(dir + '/' + proof.expected_file), proof.expected_sha256);
  const rawFiles = fs.readdirSync(dir).filter(n => /^COMPLETE-NATIVE-REPLY-.*\.json$/.test(n));
  assert.deepEqual([...rawFiles].sort(), c.saved.map(s => s.file).sort());
  const native = c.saved.map(s => {
    assert.equal(sha(dir + '/' + s.file), s.sha256);
    const raw = read(dir + '/' + s.file);
    assert.equal(raw.id, s.id);
    assertDomesticPartialIdentity({planModel:sourcePlan.model.model,launch,raw,sourcePlanSha:sha(sourcePlanPath),expectedPlanSha:c.source_plan_sha256});
    return raw;
  });
  assert.equal(new Set(native.map(r => r.id)).size, native.length);
  const observed = new Set(events.flatMap(e => e.type === 'stream_event' && e.event?.type === 'message_start' && modelIdentityMatches(sourcePlan.model.model,e.event.message?.model) ? [e.event.message.id] : e.type === 'assistant' && modelIdentityMatches(sourcePlan.model.model,e.message?.model) ? [e.message.id] : []));
  assert.deepEqual([...observed].sort(), native.map(r => r.id).sort());
  const partial = native.filter(r => !r.stop_reason);
  assert.equal(partial.length, 1);
  assert.equal(partial[0].id, proof.unfinished_message_id);
  assert(partial[0].content.length > 0);
  assert(partial[0].content.every(b => b.type === 'thinking' && !b.signature));
  assert(!history.some(r => r.message?.id === partial[0].id), 'Never remove a persisted provider message to retry');
  const complete = native.filter(r => r.stop_reason);
  const resultBlocks = history.flatMap(r => r.type === 'user' && Array.isArray(r.message?.content) ? r.message.content.filter(b => b.type === 'tool_result') : []);
  for (const raw of complete) {
    const actual = history.filter(r => r.type === 'assistant' && r.message?.id === raw.id).flatMap(r => r.message.content ?? []);
    assert.deepEqual(normalized(actual), normalized(raw.content), 'Original signed block contents and order must match');
    for (const b of raw.content.filter(b => b.type === 'tool_use')) assert.equal(resultBlocks.filter(r => r.tool_use_id === b.id).length, 1);
  }
  const receiptFile = dir + '/MCP-CALLS.jsonl';
  const receipts = fs.existsSync(receiptFile) ? rows(receiptFile) : [];
  assert.deepEqual(receipts, session.native_MCP_receipts);
  for (const receipt of receipts) {
    const result = resultBlocks.find(b => b.tool_use_id === receipt._meta?.['claudecode/toolUseId']);
    assert(result);
    const original = read(dir + '/results/' + receipt.rpc_id + '.json');
    const text = typeof result.content === 'string' ? result.content : result.content.map(b => { assert.equal(b.type, 'text'); return b.text; }).join('');
    assert.equal(text, original.text);
    assert.equal(!!result.is_error, !!original.is_error);
    assert(receipt.name !== 'act' || original.is_error === true);
  }
  const ledger = read(dir + '/NATIVE-KNOWLEDGE-LEDGER.json');
  assert.deepEqual(ledger, session.native_knowledge_ledger);
  const reads = ledger.attempts.filter(a => a.tool === 'Read' && a.allowed).length;
  assert(reads <= 3);
  const remaining = limit - complete.length - 1;
  assert(remaining > 0);
  assert.equal(remaining, proof.remaining_native_turns);
  assert.equal(3 - reads, proof.remaining_Reads);
  return {version: VERSION, source_session: dir, completed_native_replies: complete.length, unsigned_unfinished_attempts: 1,
    remaining_native_turns: remaining, remaining_Reads: 3 - reads, preserved_controller_receipts: receipts.length,
    original_signed_blocks_and_results_present: true, incomplete_output_retained: true,
    exact_model_response_continuation: false, production_ready: false, actual_upstream_API_calls: 0};
}

export function prepareIncompleteNativeHistory({registration, attestation, expected, destination}) {
  const proof = inspectIncompleteNativeHistory(registration);
  assert.deepEqual(proof, attestation, 'Explicit unchanged attestation required');
  const source = proof.source_session, launch = read(source + '/LAUNCH.json');
  assert.deepEqual(expected, read(source + '/' + registration.expected_file));
  assert(path.isAbsolute(destination));
  if (fs.existsSync(destination)) {
    const files=fs.readdirSync(destination);
    assert(files.every(name=>name==='INITIAL-RESUME-ALLOWANCE.json'), 'New session may contain only its validated initial allowance');
    if(files.length)assert.deepEqual(read(destination+'/INITIAL-RESUME-ALLOWANCE.json'),{remaining_native_turns:proof.remaining_native_turns});
  }
  assert(!destination.startsWith(registration.cpu.source + '/'));
  const args = [...launch.argv];
  const value = key => { assert(args.includes(key)); return args[args.indexOf(key) + 1]; };
  assert.equal(value('--tools'), 'Skill,Read');
  assert.equal(path.basename(registration.history), value('--resume') + '.jsonl');
  const system = expected.system.map(b => b.text).join('\n');
  const instructions = value('--append-system-prompt');
  assert(instructions.startsWith(system + '\n\n'));
  const boundary = read(source + '/native-knowledge-boundary.json');
  const ledger = read(source + '/NATIVE-KNOWLEDGE-LEDGER.json');
  const manifest = read(source + '/NATIVE-SKILL-MANIFEST.json');
  assert.equal(path.resolve(boundary.skill_root, '../../..'), launch.cwd);
  assert.equal(boundary.max_reads, 3);
  const settings = JSON.parse(value('--settings'));
  assert.equal(settings.hooks.PreToolUse.length, 1);
  for (const group of settings.hooks.PreToolUse) for (const hook of group.hooks) {
    assert(hook.command.includes(source + '/native-knowledge-boundary.json'));
    hook.command = hook.command.replace(source + '/native-knowledge-boundary.json', destination + '/native-knowledge-boundary.json');
  }
  if (!fs.existsSync(destination)) fs.mkdirSync(destination);
  const home = destination + '/home';
  fs.cpSync(source + '/home', home, {recursive:true});
  fs.mkdirSync(destination + '/workspace');
  fs.mkdirSync(destination + '/results');
  boundary.ledger = destination + '/NATIVE-KNOWLEDGE-LEDGER.json';
  const save = (name, data) => fs.writeFileSync(destination + '/' + name, JSON.stringify(data, null, 2) + '\n', {flag:'wx'});
  save('NATIVE-KNOWLEDGE-LEDGER.json', ledger);
  save('native-knowledge-boundary.json', boundary);
  args[args.indexOf('--settings') + 1] = JSON.stringify(settings);
  args[args.indexOf('--max-turns') + 1] = String(proof.remaining_native_turns);
  args[args.indexOf('--mcp-config') + 1] = destination + '/mcp.json';
  const tools = read(source + '/mcp-tools.json');
  tools.receipts = destination + '/MCP-CALLS.jsonl';
  tools.results = destination + '/results';
  save('mcp-tools.json', tools);
  const mcp = read(source + '/mcp.json');
  mcp.mcpServers.experiment.args[mcp.mcpServers.experiment.args.length - 1] = destination + '/mcp-tools.json';
  save('mcp.json', mcp);
  const routing = read(source + '/NATIVE-TASK-ENTRY.json');
  routing.native_model_turn_budget = proof.remaining_native_turns;
  routing.inherited_task_entry = true;
  routing.source_task_entry = source + '/NATIVE-TASK-ENTRY.json';
  save('NATIVE-TASK-ENTRY.json', routing);
  const history = home + '/projects/decision-loop/' + value('--resume') + '.jsonl';
  assert.equal(sha(history), registration.history_sha256);
  const knowledge = {version:'native-skill-decision-loop/v1',plugin:value('--plugin-dir'),root:boundary.skill_root,
    name:boundary.skill_name,ledger:boundary.ledger,assets_sha256:boundary.assets_sha256,
    guidance_revision:manifest.guidance_revision,settings,
    allowed:args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--plugin-dir')).filter(a => !a.startsWith('mcp__experiment__')),
    instructions:instructions.slice(system.length + 2)};
  const witness = {...proof,cloned_history:history,cloned_history_sha256:sha(history),source_history_sha256:registration.history_sha256,
    inherited_Read_ledger_sha256:sha(source + '/NATIVE-KNOWLEDGE-LEDGER.json'),
    new_Skill_entry_executed:false,new_tool_results_synthesized:false,ledger_inherited_without_budget_reset:true};
  save('NATIVE-INCOMPLETE-REGISTRATION.json', registration);
  save('NATIVE-INCOMPLETE-CHECKPOINT.json', witness);
  assert.deepEqual(inspectIncompleteNativeHistory(registration), attestation);
  return {proof:witness,home,cwd:launch.cwd,args,knowledge,history,receipts:tools.receipts,
    tools:tools.tools.map(t => t.name),stdin:'',resume_interrupted_turn:true};
}
