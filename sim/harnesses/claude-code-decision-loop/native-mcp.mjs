import fs from 'node:fs';
import assert from 'node:assert/strict';

assert.ok(!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.CLAUDE_CODE_EXTRA_BODY, 'MCP must not inherit credentials or request overrides');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
// Every tool call waits for the parent to write results/<rpc_id>.json. Query tools (read_glucose_history /
// simulate) get the original controller's exact answer; act is never answered (the parent ends the process
// and the original controller applies it) unless the parent rejects a parallel batch. The MCP never computes
// or executes anything itself.
function awaitParentAnswer(id) {
  const file = config.results + '/' + id + '.json';
  const poll = setInterval(() => {
    if (!fs.existsSync(file)) return;
    clearInterval(poll);
    const answer = JSON.parse(fs.readFileSync(file, 'utf8'));
    respond(id, { content: [{ type: 'text', text: answer.text }], ...(answer.is_error ? { isError: true } : {}) });
  }, 10);
}
let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffered += chunk;
  while (buffered.includes('\n')) {
    const end = buffered.indexOf('\n'), line = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    if (!line.trim()) continue;
    const rpc = JSON.parse(line);
    if (rpc.id === undefined) continue;
    let result;
    if (rpc.method === 'initialize') result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'experiment', version: 'native-decision-loop-2' } };
    else if (rpc.method === 'tools/list') result = { tools: config.tools };
    else if (rpc.method === 'ping') result = {};
    else if (rpc.method === 'tools/call') {
      assert.ok(config.tools.some(t => t.name === rpc.params.name), 'Unadvertised native MCP tool');
      fs.appendFileSync(config.receipts, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, rpc_id: rpc.id, ...rpc.params }) + '\n');
      awaitParentAnswer(rpc.id);
      continue;
    } else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Unsupported method' } }) + '\n'); continue; }
    respond(rpc.id, result);
  }
});
