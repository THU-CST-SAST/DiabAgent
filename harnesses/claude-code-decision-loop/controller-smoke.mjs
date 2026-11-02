import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SimEnv } from './runtime/src/env/pomdp.mjs';
import { runLlmAgent } from './runtime/src/benchmark/llm-agent.mjs';
import { parseInvocations } from './runtime/src/bench/models/invocation-log.mjs';
import * as scoring from './runtime/src/bench/score.mjs';
import { verifierReport } from './runtime/src/export/harbor/score.mjs';
import { createDecisionLoopModel } from './model.mjs';
import { assertCodeRequest, PREFIX } from './history.mjs';
import { jsonToSse } from './protocol.mjs';
import { PARALLEL_REJECTION } from './native-session.mjs';
import { resolveBudget } from './standard.mjs';

const root = process.argv[2]; fs.mkdirSync(root, { recursive: false });
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const write = (name, value) => fs.writeFileSync(root + '/' + name, JSON.stringify(value, null, 2) + '\n');
const control = fileURLToPath(new URL('.', import.meta.url));
const fixturePath = control + '/fixtures/a01-child-male-typical-pump-pct-ageqty-v1-3d-v1-s20261020-bnone-i2.json';
const { instance, pub } = read(fixturePath), manifest = read(control + '/runtime/SOURCE-MANIFEST.json');
for (const item of manifest.files) assert.equal(createHash('sha256').update(fs.readFileSync(control + '/runtime/' + item.path)).digest('hex'), item.sha256);
assert.equal(instance.config.horizon_minutes, 4320);
const oldPlan = read(control + '/PREVIOUS-PLAN.json');
// Readiness for the standard budget by default; SIMULATE_CALLS / MAX_NATIVE_TURNS cover an explicit deviation.
const { simulate: simulateCalls, turns: maxTurns } = resolveBudget();
const agentOptions = { ...oldPlan.agent_options, simulate_calls: simulateCalls };
const config = oldPlan.model, env = new SimEnv(instance.config);
const client = { episodeId: async () => instance.id, current: async () => ({ observation: env.observe(), step: env.step_count, done: env.done() }), step: async (_id, action, rationale, { prefix, expected_step }) => env.step({ action_id: prefix + '-' + expected_step, expected_step, action, rationale }) };
let requests = 0, model;
const perSession = {}, parallelRejections = [];
const guards = [], start = Date.now();
write('PLAN.json', { created: new Date().toISOString(), scope: 'Offline scripted infrastructure integration only; never a model performance score or scientific completion.', fixture_sha256: createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex'), world: instance.id, upstream_API_calls: 0, original_runtime_files: manifest.files.length, tools: ['read_glucose_history', 'simulate', 'act'], native_Code_binary: process.env.CODE_TEST_BINARY });
const server = http.createServer(async (request, res) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests++;
    fs.writeFileSync(root + '/wire-' + requests + '.json', JSON.stringify(body));
    // Harness B: find the live session and the controller request for its current native turn.
    const session = fs.readdirSync(root + '/Code').filter(p => p.startsWith('session-')).sort((a, b) => +a.slice(8) - +b.slice(8)).at(-1);
    const turnFiles = fs.readdirSync(root + '/Code/' + session).filter(p => p.startsWith('EXPECTED-CONTROLLER-REQUEST-')).sort((a, b) => +a.match(/(\d+)/)[1] - +b.match(/(\d+)/)[1]);
    const turn = turnFiles.length, expected = read(root + '/Code/' + session + '/' + turnFiles.at(-1));
    const sessionResumed = read(root + '/Code/' + session + '/EXPECTED-CONTROLLER-REQUEST-1.json').messages.length > 1;
    const tail = body.messages.at(-1), rejection = tail.role === 'user' && Array.isArray(tail.content) && tail.content.some(b => b.type === 'tool_result' && JSON.stringify(b.content).includes(PARALLEL_REJECTION));
    // A native parallel-rejection turn carries Code's own error tool_results, which the controller never sees.
    if (rejection) parallelRejections.push(tail.content.filter(b => b.type === 'tool_result').length);
    else guards.push(assertCodeRequest(expected, body, { resumed: sessionResumed }));
    perSession[session] = (perSession[session] ?? 0) + 1;
    const decision = Object.keys(perSession).length;
    const parallel = decision === 13 && (perSession[session] === 1);
    const name = parallel ? 'simulate' : decision === 13 ? 'act' : decision === 1 ? ['read_glucose_history', 'simulate', 'act'][turn - 1] : decision === 5 ? ['simulate', 'act'][turn - 1] : decision === 9 && simulateCalls >= 2 ? ['simulate', 'simulate', 'act'][turn - 1] : 'act';
    assert.ok(expected.tools.some(t => t.name === name));
    const input = name === 'read_glucose_history' ? {} : name === 'simulate' ? { action: { type: 'WAIT' }, hours: 1 } : { action: { type: 'WAIT' }, note: 'Offline scripted integration WAIT; not a model reply.' };
    const raw = { id: 'offline_controller_' + requests, type: 'message', role: 'assistant', model: config.model, content: [{ type: 'thinking', thinking: 'Offline integration fixture ' + requests, signature: 'offline_signature_' + requests }, { type: 'tool_use', id: 'offline_controller_tool_' + requests, name: PREFIX + name, input }, ...(parallel ? [{ type: 'tool_use', id: 'offline_controller_parallel_' + requests, name: PREFIX + 'simulate', input: { action: { type: 'WAIT' }, hours: 2 } }] : [])], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 3 } };
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(jsonToSse(raw));
  } catch (error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: error.message } })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  model = createDecisionLoopModel({ config, root: root + '/Code', key: 'offline-dummy-not-a-credential', binary: process.env.CODE_TEST_BINARY, offlineEndpoint: 'http://127.0.0.1:' + server.address().port, timeoutMs: 15000, maxTurns });
  const stats = await runLlmAgent({ client, pub, model, skillContextConfig: oldPlan.skill_context ?? null, logsDir: root, units: oldPlan.options.units, agentOptions, maxTurns: oldPlan.max_turns, maxConsecutiveErrors: oldPlan.max_format_errors, retry: { tries: 1, baseDelayMs: 1 } });
  await model.close();
  const bundle = env.exportBundle(); write('stats.json', stats); write('bundle.json', bundle);
  const expectedContinuations = simulateCalls >= 2 ? 5 : 3;
  const invocations = parseInvocations(fs.readFileSync(root + '/invocations.jsonl', 'utf8'), { strict: true });
  const rows = fs.readFileSync(root + '/transcript.jsonl', 'utf8').trim().split('\n').map(JSON.parse), actions = rows.filter(row => row.parsed && row.receipt), fixed = actions.filter(row => row.decision_kind === 'fixed');
  const native = verifierReport(bundle, scoring, { scoring_version: 'METRICS-v0.3', verifier: 'daily' }, { episode_id: instance.id, agent_completed: stats.state === 'done', agent_steps: bundle.metrics.steps, verifier_wait_steps: 0 });
  const independent = scoring.episodeScore(scoring.episodeMetrics(bundle), scoring.DEFAULT_WEIGHTS, { version: 'METRICS-v0.3' });
  const at = Date.parse(instance.config.start_time), truth = bundle.evaluator_only.states;
  const checks = { original_controller_done: stats.state === 'done', steps: env.step_count === 864 && bundle.metrics.steps === 864, truth_points: truth.length === 865, elapsed: bundle.metrics.elapsed_minutes === 4320, complete: bundle.metrics.completed_horizon === true, fixed_hours: stats.fixed_decisions === 72 && fixed.length === 72, fixed_grid: fixed.every((row, i) => Date.parse(row.sim_time) === at + i * 3600000), truth_grid: truth.every((row, i) => Date.parse(row.time) === at + i * 300000), extra_cap: Object.values(stats.extra_decisions_by_local_day ?? {}).every(n => n <= 6), no_WAIT_tail: !bundle.trajectory.some(row => /harness:.*remaining horizon|validator.*WAIT/i.test(row.rationale ?? '')), native_reward: native.reward.reward === independent.score && native.metrics.reward.reward === native.reward.reward, no_verifier_fill: native.reward.verifier_wait_steps === 0, native_MCP: invocations.filter(row => row.response).every(row => row.response.raw.__code_harness.native_MCP_called === true), all_native_visible_inputs_guarded: guards.length === requests - parallelRejections.length && guards.every(g => g.factual_history_preserved && g.thinking_history_preserved && g.signed_history_block_binding_preserved), three_tools: ['act', 'read_glucose_history', 'simulate'].every(name => invocations.some(row => row.response?.raw?.content?.some(block => block.type === 'tool_use' && block.name === PREFIX + name))), no_format_errors: stats.parse_errors === 0, no_API_errors: stats.api_errors === 0, no_replays: invocations.every(row => !row.replay && !row.response?.replay), one_process_per_decision: Object.keys(perSession).length === stats.decisions, in_process_continuations: model.diagnostics.in_process_continuations === expectedContinuations && Object.values(perSession).filter(n => n > 1).length === (simulateCalls >= 2 ? 4 : 3), calls_equal_decisions_plus_queries: requests === stats.decisions + expectedContinuations + 1, simulate_budget: stats.simulate_calls === (simulateCalls >= 2 ? 4 : 2), parallel_batch_rejected_natively: parallelRejections.length === 1 && parallelRejections[0] === 2 && model.diagnostics.native_corrections === 1 };
  write('RESULT.json', { checked: new Date().toISOString(), offline_only: true, actual_upstream_API_calls: 0, completed_model_trajectories: 0, complete_offline_scripted_episodes: 1, all_passed: Object.values(checks).every(Boolean), checks, simulate_calls_per_decision: simulateCalls, max_native_turns: maxTurns, Code_calls: requests, Code_processes: Object.keys(perSession).length, diagnostics: model.diagnostics, elapsed_ms: Date.now() - start, native_score_is_scripted_WAIT_not_model: native.reward.reward, stats });
  console.log(JSON.stringify(read(root + '/RESULT.json')));
  assert.ok(Object.values(checks).every(Boolean));
} finally { await model?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
