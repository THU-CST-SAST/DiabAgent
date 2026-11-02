import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseCodeStream} from './reply-parser.mjs';

const rejection='Rejected: exactly one tool call per reply is accepted (parallel tool use is disabled). None of these calls was run and no budget was used. Re-issue a single tool call.';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const lines=p=>fs.readFileSync(p,'utf8').split('\n').filter(Boolean).map(JSON.parse);

// Historical, already rejected queries only. This does not authorize replay or new attempts.
export function inspectRejectedNativeHistory(dir){
 const session=read(dir+'/SESSION.json'),events=lines(dir+'/stdout.jsonl');
 assert.deepEqual(session.turns,[]);assert.deepEqual(session.native_internal??[],[]);
 const frames=events.filter(e=>e.type==='stream_event').map(e=>e.event);
 assert.equal(frames.filter(e=>e.type==='message_start').length,1);
 assert.equal(frames.filter(e=>e.type==='message_stop').length,1);
 assert.equal(frames.at(-1)?.type,'message_stop');
 const saved=fs.readdirSync(dir).filter(n=>/^COMPLETE-NATIVE-REPLY-|^ACCEPTED-PROPOSAL-/.test(n));
 assert.deepEqual(saved,['COMPLETE-NATIVE-REPLY-1-n1.json']);
 const raw=read(dir+'/'+saved[0]);
 assert.deepEqual(parseCodeStream(frames.map(e=>'data: '+JSON.stringify(e)+'\n').join(''),{model:'claude-opus-5-5'}).raw,raw);
 assert.equal(raw.stop_reason,'tool_use');
 const uses=raw.content.filter(b=>b.type==='tool_use');
 assert(uses.length>1&&uses.every(u=>u.name==='mcp__experiment__simulate'));
 assert.equal(new Set(uses.map(u=>u.id)).size,uses.length);
 const receipts=lines(dir+'/MCP-CALLS.jsonl');assert.equal(receipts.length,uses.length);
 assert.deepEqual(session.native_MCP_receipts,receipts);
 const results=events.filter(e=>e.type==='user').flatMap(e=>e.message?.content??[]).filter(b=>b.type==='tool_result');
 assert.equal(results.length,uses.length);
 const files=['SESSION.json','stdout.jsonl','MCP-CALLS.jsonl',saved[0]];
 for(const use of uses){
  const receipt=receipts.find(r=>r._meta?.['claudecode/toolUseId']===use.id);assert(receipt);
  assert.equal(receipt.name,'simulate');assert.deepEqual(receipt.arguments,use.input);
  assert(Number.isInteger(receipt.rpc_id));
  const file='results/'+receipt.rpc_id+'.json';files.push(file);
  assert.deepEqual(read(dir+'/'+file),{text:rejection,is_error:true});
  assert.deepEqual(results.find(r=>r.tool_use_id===use.id),{type:'tool_result',content:rejection,is_error:true,tool_use_id:use.id});
 }
 assert(events.some(e=>e.type==='result'&&e.is_error===true&&e.api_error_status===502));
 assert(events.filter(e=>e.type==='assistant'&&e.message?.model!=='<synthetic>').every(e=>e.message?.id===raw.id));
 return {kind:'historical_rejected_parallel_simulate/v1',consumed_native_turns:1,
  executed_queries:0,tool_ids:uses.map(u=>u.id),files:files.sort().map(file=>({file,
   sha256:createHash('sha256').update(fs.readFileSync(dir+'/'+file)).digest('hex')}))};
}
