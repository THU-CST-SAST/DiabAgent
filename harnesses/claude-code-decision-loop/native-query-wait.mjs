import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
// Only a failed segment after already accepted controller queries is eligible.
// Native Skill/Read and correction continuations require their own full native-history contract.
export function inspectNativeQueryFailure({session_dir,cursor}){
 const read=p=>JSON.parse(fs.readFileSync(p)),hash=b=>createHash('sha256').update(b).digest('hex');
 const session=read(session_dir+'/SESSION.json'),bytes=fs.readFileSync(session_dir+'/stdout.jsonl');
 const rows=bytes.toString().trim().split('\n').filter(Boolean).map(JSON.parse);
 assert(session.exit!=null);assert(cursor.turns>0&&cursor.turns<cursor.max_turns&&cursor.max_turns<=7);
 assert.equal(session.turns.length,cursor.turns);assert.equal((session.native_MCP_receipts??[]).length,cursor.receipts);
 assert.equal(cursor.receipts,cursor.turns);assert.deepEqual(session.native_internal??[],[]);
 assert(session.turns.every(t=>['simulate','read_glucose_history'].includes(t.tool)&&t.mcp&&t.native_corrections===0));
 assert(Number.isInteger(cursor.events)&&cursor.events>=0&&cursor.events<rows.length);
 const tail=rows.slice(cursor.events);
 let open=null;for(const e of rows.slice(0,cursor.events)){if(e.type==='stream_event'&&e.event?.type==='message_start')open=e.event.message?.id;if(e.type==='stream_event'&&e.event?.type==='message_stop')open=null;}
 if(open)assert.equal(read(session_dir+'/ACCEPTED-PROPOSAL-'+cursor.turns+'.json').raw.id,open);
 for(const e of tail){
  if(e.type==='stream_event'&&e.event?.type!=='ping'){
    assert(open&&['content_block_stop','message_delta','message_stop'].includes(e.event?.type),'New or partial model output cannot be redrawn');
    if(e.event.type==='message_stop')open=null;
  }
  if(e.type==='assistant')assert(e.message?.model==='<synthetic>'&&e.message?.content?.every(b=>b.type==='text'));
 }
 assert(tail.some(e=>e.type==='result'&&e.is_error));
 for(const file of fs.readdirSync(session_dir)){
  const m=file.match(/^(?:COMPLETE-NATIVE-REPLY|ACCEPTED-PROPOSAL)-(\d+)/);
  if(m)assert(+m[1]<=cursor.turns,'Unaccepted reply must not be redrawn');
 }
 const expected=session_dir+'/EXPECTED-CONTROLLER-REQUEST-'+(cursor.turns+1)+'.json';assert(fs.existsSync(expected));
 const evidence={session:hash(fs.readFileSync(session_dir+'/SESSION.json')),stdout:hash(bytes),expected:hash(fs.readFileSync(expected)),cursor};
 return {session_dir,no_unaccepted_reply:true,no_native_turn_consumed:true,no_MCP_receipt:true,
  accepted_query_turns_preserved:cursor.turns,remaining_native_turns:cursor.max_turns-cursor.turns,
  expected_request_sha256:evidence.expected,query_resume:{session_dir,cursor},
  evidence_sha256:hash(JSON.stringify(evidence))};
}
