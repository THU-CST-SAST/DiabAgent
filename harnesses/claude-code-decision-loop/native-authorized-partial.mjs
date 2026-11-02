import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const PARTIAL_AUTHORIZATION='2026-10-30:之前断的续上';
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
export function inspectAuthorizedPartial(source,s){
  const p=s.authorized_partial;
  assert.equal(p?.version,'human-authorized-unfinished-thinking-retry/v1');
  assert.equal(p.human_instruction,PARTIAL_AUTHORIZATION);
  assert.equal(p.remaining_native_turns,6);
  assert.equal(p.exact_model_response_continuation,false);
  const dir=source+'/Code/'+s.name,session=JSON.parse(fs.readFileSync(dir+'/SESSION.json'));
  assert.equal(sha(dir+'/SESSION.json'),s.session_sha256);
  assert.equal(sha(dir+'/stdout.jsonl'),s.stdout_sha256);
  assert.match(session.error,/logical deadline/);
  assert.equal(session.actual_HTTP,null);
  assert.deepEqual(session.turns,[]);
  assert.deepEqual(session.native_internal??[],[]);
  assert.deepEqual(session.native_MCP_receipts,[]);
  assert.deepEqual(session.native_knowledge_ledger?.attempts??[],[]);
  const files=fs.readdirSync(dir);
  assert(!files.some(n=>/^(COMPLETE-NATIVE-REPLY-|ACCEPTED-PROPOSAL-|NATIVE-INTERNAL-)/.test(n)));
  assert(!fs.existsSync(dir+'/MCP-CALLS.jsonl')||!fs.readFileSync(dir+'/MCP-CALLS.jsonl','utf8').trim());
  const events=fs.readFileSync(dir+'/stdout.jsonl','utf8').split('\n').filter(Boolean).map(JSON.parse);
  const stream=events.filter(e=>e.type==='stream_event').map(e=>e.event);
  assert.equal(stream.filter(e=>e.type==='message_start').length,1);
  assert.equal(stream.find(e=>e.type==='message_start').message.id,p.unfinished_message_id);
  assert(!stream.some(e=>['message_stop','message_delta','content_block_stop'].includes(e.type)));
  assert(stream.filter(e=>e.type==='content_block_start').every(e=>e.content_block.type==='thinking'));
  assert(stream.filter(e=>e.type==='content_block_delta').every(e=>e.delta.type==='thinking_delta'&&!e.delta.thinking));
  assert(!events.some(e=>e.type==='assistant'&&e.message?.model!=='<synthetic>'));
  for(const h of p.history_files){assert(h.file.startsWith(dir+'/home/'));assert.equal(sha(h.file),h.sha256);const rows=fs.readFileSync(h.file,'utf8').split('\n').filter(Boolean).map(JSON.parse);assert(!rows.some(r=>r.message?.id===p.unfinished_message_id));}
  assert.equal(JSON.parse(fs.readFileSync(dir+'/LAUNCH.json')).max_native_model_turns,7);
  return {remaining_native_turns:6,unfinished_output_retained:true,exact_model_response_continuation:false};
}
