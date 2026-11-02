import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDecisionLoopModel, compileControllerRequest, decisionContinuation } from './model.mjs';
import { assertCodeRequest, PREFIX } from './history.mjs';
import { jsonToSse } from './protocol.mjs';
import { DecisionLoopSession, REGISTRATION } from './native-session.mjs';

const binary = process.env.CODE_TEST_BINARY;
const fixtures = JSON.parse(fs.readFileSync(new URL('./CAPTURE-FIXTURES.json', import.meta.url)));
const config = { model: 'claude-opus-5-5', max_tokens: 8192, strict_tools: true, strict_tool_names: ['act', 'read_glucose_history'], tool_contract_repair: true, reasoning_effort: 'high', thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } };
const response = (input = { action: { type: 'WAIT' }, note: 'Offline fixture; no scientific action.' }) => ({ id: 'offline_direct_reply', type: 'message', role: 'assistant', model: config.model, content: [{ type: 'thinking', thinking: 'Offline thought.', signature: 'offline-signature' }, { type: 'text', text: 'Before.' }, { type: 'tool_use', id: 'offline_direct_use', name: PREFIX + 'act', input }, { type: 'text', text: 'After.' }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 } });
async function runOffline(q, provider, check, { timeoutMs = 10000, maxRequests = 1, nativeJSONFallback=false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-direct-test-'));
  let requests = 0;
  const server = http.createServer(async (request, res) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests++;
    await provider(JSON.parse(Buffer.concat(chunks)), res, requests);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const model = createDecisionLoopModel({ config, root: root + '/model', key: 'offline-dummy-not-a-credential', binary, offlineEndpoint: 'http://127.0.0.1:' + server.address().port, timeoutMs });
  let requestsAtBoundary;
  try { await check(model, root);requestsAtBoundary=requests; }
  finally { await model.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.ok(requests <= maxRequests, 'No unexpected extra model request inside a native boundary');
  if(requestsAtBoundary!=null)assert.equal(requests,requestsAtBoundary,'No model request after the consumed final proposal');
  // Every request Code starts must correspond to a native turn we consumed; nothing may follow the final act.
  for (const s of fs.readdirSync(root + '/model').filter(p => p.startsWith('session-'))) {
    const rows = fs.readFileSync(root + '/model/' + s + '/stdout.jsonl', 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    const started = rows.filter(r => r.type === 'system' && r.status === 'requesting').length;
    const completed = rows.filter(r => r.type === 'stream_event' && r.event.type === 'message_stop').length;
    assert.ok(started <= (nativeJSONFallback?maxRequests:Math.max(1, completed)), s + ': Code started a model request after the final proposal');
  }
  const sessions = fs.readdirSync(root + '/model').filter(p => p.startsWith('session-'));
  assert.ok(sessions.every(s => JSON.parse(fs.readFileSync(root + '/model/' + s + '/SESSION.json')).exit != null));
  return { root, requests };
}
const send = (res, raw) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(jsonToSse(raw)); };

for (const fixture of fixtures.cases) test('direct production boundary preserves native facts/response at ' + fixture.label, async () => {
  assert.deepEqual(compileControllerRequest(config, fixture.neutral), fixture.expected);
  const raw = response();
  await runOffline(fixture.neutral, async (body, res) => {
    assertCodeRequest(fixture.expected, body, { resumed: fixture.expected.messages.length > 1 });
    send(res, raw);
  }, async model => {
    const result = await model.complete(fixture.neutral);
    assert.equal(result.tool_call.name, 'act'); assert.deepEqual(result.tool_call.input, raw.content[2].input);
    assert.deepEqual(result.raw.content, raw.content); assert.equal(result.stop_reason, 'tool_use');
    assert.equal(result.usage.input_tokens, 14); assert.equal(result.usage.output_tokens, 3);
    assert.equal(result.raw.__code_harness.native_MCP_called, true);
    assert.equal(result.raw.__code_harness.wire_requests, null);
    assert.equal(result.provider.content[2].name, 'act'); assert.equal(result.raw.content[2].name, PREFIX + 'act');
  });
});
test('missing required tool arguments stay format failure, not a guessed action or endpoint error', async () => {
  await runOffline(fixtures.cases[0].neutral, async (_body, res) => send(res, response({ action: { type: 'WAIT' } })), async model => {
    await assert.rejects(model.complete(fixtures.cases[0].neutral), error => error.code === 'TOOL_CONTRACT' && error.failure_scope === 'trial' && /note/.test(error.message));
  });
});
test('numeric original schema bounds remain locally enforced', async () => {
  await runOffline(fixtures.cases[0].neutral, async (_body, res) => send(res, response({ action: { type: 'BOLUS', units: 10000 }, note: 'Invalid offline bound test.' })), async model => {
    await assert.rejects(model.complete(fixtures.cases[0].neutral), error => error.code === 'TOOL_CONTRACT' && /Original schema/.test(error.message));
  });
});
const malformed = raw => jsonToSse(raw).split('\n').map(line => {
  if (!line.startsWith('data: ')) return line;
  const event = JSON.parse(line.slice(6));
  if (event.delta?.type === 'input_json_delta') event.delta.partial_json = '{broken';
  return 'data: ' + JSON.stringify(event);
}).join('\n');
test('malformed raw JSON is corrected by native Code inside the decision and kept as evidence', async () => {
  const { root } = await runOffline(fixtures.cases[0].neutral, async (_body, res, n) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(n === 1 ? malformed(response()) : jsonToSse(response()));
  }, async model => {
    const result = await model.complete(fixtures.cases[0].neutral);
    assert.equal(result.tool_call.name, 'act');
    assert.deepEqual(result.raw.__code_harness.native_corrections.map(c => c.reason), ['unparsed_tool_input']);
    assert.equal(model.diagnostics.native_corrections, 1); assert.equal(model.diagnostics.sessions, 1);
  }, { maxRequests: 2 });
  assert.ok(fs.existsSync(root + '/model/session-1/COMPLETE-NATIVE-REPLY-1.json') && fs.existsSync(root + '/model/session-1/COMPLETE-NATIVE-REPLY-1-c1.json'));
});
test('native corrections are bounded by max-turns and then enter the original format path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-loop-test-'));
  let requests = 0;
  const server = http.createServer(async (request, res) => { for await (const _ of request); requests++; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(malformed(response())); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const model = createDecisionLoopModel({ config, root: root + '/model', key: 'offline-dummy-not-a-credential', binary, offlineEndpoint: 'http://127.0.0.1:' + server.address().port, timeoutMs: 15000, maxTurns: 2 });
  try { await assert.rejects(model.complete(fixtures.cases[0].neutral), error => error.code === 'TOOL_CONTRACT' && error.failure_scope === 'trial'); }
  finally { await model.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  assert.ok(requests <= 2, 'max-turns bounds native corrections');
});
test('parallel tool calls are rejected natively (nothing run) and the model re-issues one serial call', async () => {
  const bodies = [];
  const { root } = await runOffline(fixtures.cases[0].neutral, async (body, res, n) => {
    bodies.push(body);
    const raw = n === 1 ? queryReply('simulate', { action: { type: 'WAIT' }, hours: 2 }, n) : response();
    if (n === 1) raw.content.push({ ...raw.content[1], id: 'offline_parallel_second', input: { action: { type: 'WAIT' }, hours: 3 } });
    send(res, raw);
  }, async model => {
    const result = await model.complete(fixtures.cases[0].neutral);
    assert.equal(result.tool_call.name, 'act');
    assert.deepEqual(result.raw.__code_harness.native_corrections.map(c => c.reason), ['parallel_tool_calls']);
    assert.equal(model.diagnostics.sessions, 1); assert.equal(model.diagnostics.in_process_continuations, 0);
  }, { maxRequests: 2 });
  const results = bodies[1].messages.at(-1).content.filter(b => b.type === 'tool_result');
  assert.equal(results.length, 2);
  assert.ok(results.every(r => r.is_error === true && JSON.stringify(r.content).includes('exactly one tool call per reply')));
  const session = JSON.parse(fs.readFileSync(root + '/model/session-1/SESSION.json'));
  assert.deepEqual(session.turns.map(t => [t.tool, t.native_corrections]), [['act', 1]]);
});
test('persistent parallel calls are bounded by max-turns and fail the original serial contract', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-loop-test-'));
  let requests = 0;
  const server = http.createServer(async (request, res) => { for await (const _ of request); requests++; const raw = response(); raw.content.push({ ...raw.content[2], id: 'offline_second_tool_' + requests }); raw.content[2] = { ...raw.content[2], id: 'offline_first_tool_' + requests }; send(res, raw); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const model = createDecisionLoopModel({ config, root: root + '/model', key: 'offline-dummy-not-a-credential', binary, offlineEndpoint: 'http://127.0.0.1:' + server.address().port, timeoutMs: 15000, maxTurns: 2 });
  try { await assert.rejects(model.complete(fixtures.cases[0].neutral), error => error.code === 'TOOL_CONTRACT' && /Multiple/.test(error.message)); }
  finally { await model.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  assert.ok(requests <= 2, 'max-turns bounds parallel corrections');
});
test('plain text cannot become a WAIT action', async () => {
  await runOffline(fixtures.cases[0].neutral, async (_body, res) => {
    const raw = response(); raw.content = [{ type: 'text', text: 'WAIT' }]; raw.stop_reason = 'end_turn'; send(res, raw);
  }, async model => { await assert.rejects(model.complete(fixtures.cases[0].neutral), error => error.code === 'TOOL_CONTRACT'); });
});
test('wrong returned model fails closed', async () => {
  await runOffline(fixtures.cases[0].neutral, async (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(jsonToSse(response()).replaceAll('claude-opus-5-5', 'unexpected-model'));
  }, async model => { await assert.rejects(model.complete(fixtures.cases[0].neutral), /model identity mismatch/); });
});
test('complete SSE terminal does not wait for connection closure', async () => {
  await runOffline(fixtures.cases[0].neutral, async (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(jsonToSse(response()));
  }, async model => { assert.equal((await model.complete(fixtures.cases[0].neutral)).tool_call.name, 'act'); });
});
test('unadvertised native alias is natively rejected by Code and corrected inside the decision', async () => {
  await runOffline(fixtures.cases[0].neutral, async (_body, res, n) => {
    const raw = response(); if (n === 1) raw.content[2].name = 'act'; send(res, raw);
  }, async model => {
    const result = await model.complete(fixtures.cases[0].neutral);
    assert.equal(result.tool_call.name, 'act'); assert.equal(result.raw.__code_harness.native_MCP_called, true);
    assert.deepEqual(result.raw.__code_harness.native_corrections.map(c => c.reason), ['unadvertised_tool']);
  }, { maxRequests: 2 });
});
test('an empty terminal deadline permits only the existing outer budget, with no internal retry', async () => {
  await runOffline(fixtures.cases[0].neutral, async () => {}, async model => {
    await assert.rejects(model.complete(fixtures.cases[0].neutral), error => error.status === 504 && error.retryable === true
      &&error.deadline_no_native_reply_confirmed===true&&error.retryAfterMs===60000);
  }, { timeoutMs: 1500 });
});
test('a partial model stream at deadline remains nonretryable and cannot redraw a possible reply',async()=>{
  await runOffline(fixtures.cases[0].neutral,async(_body,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write('event: message_start\ndata: '+JSON.stringify({type:'message_start',message:{id:'partial_native',type:'message',
      role:'assistant',model:config.model,content:[],usage:{input_tokens:1,output_tokens:0}}})+'\n\n');
  },async model=>{
    await assert.rejects(model.complete(fixtures.cases[0].neutral),e=>e.status===504&&e.retryable===false
      &&e.deadline_no_native_reply_confirmed===false);
  },{timeoutMs:2000});
});
test('no production network proxy, fetch forwarder, extra body or inherited credential settings', () => {
  const source = fs.readFileSync(new URL('./native-session.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes("from 'node:http'") && !source.includes('fetch('));
  assert.ok(!source.includes('CLAUDE_CODE_EXTRA_BODY:JSON') && !source.includes('...process.env'));
  assert.ok(source.includes("'https://sbtunnel.xiaoaojianghu.fun'"));
  assert.ok(!fs.readFileSync(new URL('./native-mcp.mjs', import.meta.url), 'utf8').includes('fetch('));
});
test('paid invocation requires registered harness; offline endpoint cannot carry a real key', () => {
  const root = path.join(os.tmpdir(), 'never-created-' + Date.now());
  assert.throws(() => new DecisionLoopSession({ root, key: 'not-used', binary }), /Unregistered/);
  assert.throws(() => new DecisionLoopSession({ root, key: 'not-used', binary, registration: 'native-direct-controller/v1-three-day-fixed4' }), /Unregistered/);
  assert.throws(() => new DecisionLoopSession({ root, key: 'not-a-real-key-but-not-the-fixed-dummy', binary, offlineEndpoint: 'http:\/\/127.0.0.1:1' }));
  assert.equal(fs.existsSync(root), false);
});

// ---- Harness B: one native Code tool loop per controller decision ----
const queryReply = (name, input, n) => ({ id: 'offline_loop_' + n, type: 'message', role: 'assistant', model: config.model, content: [{ type: 'thinking', thinking: 'Loop thought ' + n, signature: 'loop-signature-' + n }, { type: 'tool_use', id: 'offline_loop_use_' + n, name: PREFIX + name, input }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 3 } });
const followUp = (request, result, text, isError = false) => ({ ...request, messages: [...request.messages, { role: 'assistant', content: result.text ?? '', tool_call: result.tool_call, provider: result.provider }, { role: 'user', content: text, tool_result_for: result.tool_call.id, ...(isError ? { is_error: true } : {}) }] });

test('complete JSON message without stream_event is accepted only with matching native MCP delivery',async()=>{
  const raw=response();
  await runOffline(fixtures.cases[0].neutral,async(_body,res)=>{
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(raw));
  },async model=>{const answer=await model.complete(fixtures.cases[0].neutral);
    assert.equal(answer.tool_call.name,'act');assert.deepEqual(answer.raw.content,raw.content);
    assert.equal(answer.raw.__code_harness.native_reply_source,'native-assistant-chunks/v1');
  },{maxRequests:2,nativeJSONFallback:true});
});
test('JSON query reply and exact controller result continue in one native process',async()=>{
  await runOffline(fixtures.cases[0].neutral,async(body,res)=>{
    res.writeHead(200,{'content-type':'application/json'});
    const followed=body.messages.some(m=>m.role==='assistant'&&m.content?.some(b=>b.type==='tool_use'&&b.id==='offline_loop_use_1'));
    res.end(JSON.stringify(!followed?queryReply('simulate',{action:{type:'WAIT'},hours:1},1):response()));
  },async model=>{const q=fixtures.cases[0].neutral,first=await model.complete(q);
    assert.equal(first.tool_call.name,'simulate');
    const second=await model.complete(followUp(q,first,'{"simulated":true,"risk":"offline"}'));
    assert.equal(second.tool_call.name,'act');assert.equal(model.diagnostics.sessions,1);
    assert.equal(second.raw.__code_harness.in_process_continuation,true);
  },{maxRequests:4,nativeJSONFallback:true});
});

test('query tool answer continues inside the same native Code process, then act ends it', async () => {
  const q = fixtures.cases[0].neutral, bodies = [];
  let expected2;
  const { root } = await runOffline(q, async (body, res, n) => {
    bodies.push(body);
    send(res, n === 1 ? queryReply('simulate', { action: { type: 'WAIT' }, hours: 2 }, n) : response());
  }, async model => {
    const first = await model.complete(q);
    assert.equal(first.tool_call.name, 'simulate'); assert.equal(first.raw.__code_harness.in_process_continuation, false);
    const q2 = followUp(q, first, 'Offline controller simulate answer\n(0 simulate call(s) left for this decision; now call act)');
    expected2 = compileControllerRequest(config, q2);
    const second = await model.complete(q2);
    assert.equal(second.tool_call.name, 'act'); assert.equal(second.raw.__code_harness.in_process_continuation, true);
    assert.equal(second.raw.__code_harness.native_turn, 2);
    assert.equal(model.diagnostics.sessions, 1); assert.equal(model.diagnostics.in_process_continuations, 1);
  }, { maxRequests: 2 });
  assert.equal(bodies.length, 2);
  // The second wire request is Code's own loop continuation; its visible facts must equal the controller's.
  const guard = assertCodeRequest(expected2, bodies[1], { resumed: false });
  assert.ok(guard.factual_history_preserved && guard.thinking_history_preserved);
  const sessions = fs.readdirSync(root + '/model').filter(p => p.startsWith('session-'));
  assert.deepEqual(sessions, ['session-1']);
  const session = JSON.parse(fs.readFileSync(root + '/model/session-1/SESSION.json'));
  assert.deepEqual(session.turns.map(t => t.tool), ['simulate', 'act']);
  assert.equal(session.native_MCP_receipts.length, 2);
});

test('error answers from the controller also continue natively with is_error preserved', async () => {
  const q = fixtures.cases[0].neutral, bodies = [];
  await runOffline(q, async (body, res, n) => { bodies.push(body); send(res, n === 1 ? queryReply('read_glucose_history', {}, n) : response()); }, async model => {
    const first = await model.complete(q);
    const q2 = followUp(q, first, JSON.stringify({ ok: false, error: 'offline invalid range' }), true);
    assert.equal((await model.complete(q2)).tool_call.name, 'act');
    assert.equal(model.diagnostics.sessions, 1);
  }, { maxRequests: 2 });
  const result = bodies[1].messages.at(-1).content.find(b => b.type === 'tool_result');
  assert.equal(result.is_error, true);
});

test('a request that is not the same decision continuation starts a fresh process from controller context', async () => {
  const q = fixtures.cases[0].neutral;
  await runOffline(q, async (_body, res, n) => send(res, n === 1 ? queryReply('simulate', { action: { type: 'WAIT' }, hours: 1 }, n) : response()), async model => {
    const first = await model.complete(q);
    assert.equal(first.tool_call.name, 'simulate');
    // e.g. the original controller rejected the query (budget) and moved to a correction turn instead.
    const result = await model.complete(fixtures.cases[1].neutral);
    assert.equal(result.tool_call.name, 'act'); assert.equal(result.raw.__code_harness.in_process_continuation, false);
    assert.equal(model.diagnostics.sessions, 2); assert.equal(model.diagnostics.in_process_continuations, 0);
  }, { maxRequests: 2 });
});

test('continuation detection is exact', () => {
  const q = compileControllerRequest(config, fixtures.cases[0].neutral);
  const use = { id: 'u1', name: 'simulate', input: {} }, provider = { adapter: 'anthropic', content: [{ type: 'tool_use', ...use }] };
  const next = compileControllerRequest(config, followUp(fixtures.cases[0].neutral, { tool_call: use, provider }, 'answer'));
  assert.deepEqual(decisionContinuation(q, next, 'u1'), { text: 'answer', is_error: false });
  assert.equal(decisionContinuation(q, next, 'other'), null);
  assert.equal(decisionContinuation(q, { ...next, tools: next.tools.slice(0, 2) }, 'u1'), null);
  assert.equal(decisionContinuation(q, { ...next, system: [{ type: 'text', text: 'changed' }] }, 'u1'), null);
});
