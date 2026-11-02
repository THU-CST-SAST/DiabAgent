import test from 'node:test';
import assert from 'node:assert/strict';
import {assistantReplies} from '../harnesses/claude-code-decision-loop/native-assistant.mjs';
const raw={id:'msg_saved',type:'message',role:'assistant',model:'claude-opus-5.5',stop_reason:'tool_use',
  stop_sequence:null,usage:{input_tokens:12,output_tokens:4},content:[{type:'thinking',thinking:'Original.',signature:'original-signature'},
    {type:'tool_use',id:'tool_saved',name:'mcp__experiment__act',input:{action:{type:'WAIT'},note:'Original.'}}]};
const rows=raw.content.map(b=>({type:'assistant',message:{...raw,content:[b]}}));
const receipt={name:'act',arguments:raw.content[1].input,_meta:{'claudecode/toolUseId':'tool_saved'}};
test('native chunks preserve headers, signed thinking and block order exactly',()=>{
  assert.deepEqual(assistantReplies(rows,[receipt],{model:'claude-opus-5-5'}),[raw]);
});
test('a full-looking message without a matching MCP receipt remains unaccepted',()=>{
  assert.deepEqual(assistantReplies(rows,[]),[]);
  assert.deepEqual(assistantReplies(rows,[{...receipt,arguments:{action:{type:'BOLUS'}}}]),[]);
});
test('no completion fields are invented for partial assistant chunks',()=>{
  assert.deepEqual(assistantReplies(rows.map(r=>({...r,message:{...r.message,stop_reason:null}})),[receipt]),[]);
});
test('model identities and duplicate tool blocks fail closed',()=>{
  assert.deepEqual(assistantReplies(rows,[receipt],{model:'other-model'}),[]);
  assert.deepEqual(assistantReplies([...rows,rows[1]],[receipt]),[]);
});
test('inconsistent native message headers cannot be combined',()=>{
  assert.throws(()=>assistantReplies([rows[0],{...rows[1],message:{...rows[1].message,usage:{output_tokens:9}}}],[receipt]),/metadata changed/);
});
test('a completed tool cannot hide a partial thinking fragment with the same message id',()=>{
  assert.throws(()=>assistantReplies([{...rows[0],message:{...rows[0].message,stop_reason:null}},rows[1]],[receipt]),/ignored or incomplete/);
});
