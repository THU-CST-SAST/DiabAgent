import assert from 'node:assert/strict';

export const model = 'claude-opus-5-5';
export const system = 'This is a nonclinical infrastructure test. Use only the three provided infra tools. Read state, preview using the returned revision, then commit using the returned receipt. Never guess identifiers. After one successful commit, reply DONE. Do not invoke tools after success.';
const schema = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
export const tools = [
  {name:'read_state',description:'Read the current test revision.',inputSchema:schema({})},
  {name:'preview',description:'Get a commit receipt for the exact revision returned by read_state.',inputSchema:schema({revision:{type:'string'}})},
  {name:'commit',description:'Commit once with the receipt returned by preview.',inputSchema:schema({receipt:{type:'string'}})}
];
export const apiTools = tools.map(t=>({name:'mcp__infra__'+t.name,description:t.description,input_schema:t.inputSchema,strict:true}));
export const generation = {thinking:{type:'adaptive',block_binding:{prefix_mismatch_behavior:'drop_block'}},
  tool_choice:{type:'auto',disable_parallel_tool_use:true},output_config:{effort:'high'},max_tokens:1024};
export function guard(body, previous, expected={model,system,tools:apiTools,generation}) {
  assert.equal(body.model,expected.model);assert.equal(body.stream,true);
  for(const [k,v] of Object.entries(expected.generation))assert.deepEqual(body[k],v,k);
  assert.deepEqual(body.tools,expected.tools);
  const texts=typeof body.system==='string'?[body.system]:body.system.map(b=>b.text);
  assert.ok(texts.includes(expected.system),'Task system prompt must be present verbatim');
  assert.ok(body.messages.length>0);
  if(previous){
    assert.ok(body.messages.length>previous.messages.length,'Native loop must advance');
    // Code may merge consecutive user blocks, so verify receipts independently below.
  }
  return {model:true,task_system_verbatim:true,strict_tools:true,parallel_disabled:true,thinking_binding:true};
}
export function terminalFrame(text) {
  const frames=text.split(/\r?\n\r?\n/);frames.pop();
  return frames.some(frame=>{try{return ['message_stop','error'].includes(JSON.parse(frame.split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n')).type);}catch{return false;}});
}
export function jsonToSse(raw, expectedModel = model) {
  assert.equal(raw.type,'message');assert.equal(raw.role,'assistant');assert.equal(raw.model,expectedModel);
  assert.ok(raw.id&&Array.isArray(raw.content));assert.ok(['tool_use','end_turn','max_tokens','refusal'].includes(raw.stop_reason));
  const events=[{type:'message_start',message:{...raw,content:[],stop_reason:null,stop_sequence:null,usage:{...raw.usage,output_tokens:0}}}];
  raw.content.forEach((b,index)=>{
    assert.ok(['text','thinking','redacted_thinking','tool_use'].includes(b.type),'Unsupported JSON block must fail closed');
    if(b.type==='tool_use'){
      assert.ok(b.id&&b.name&&b.input&&typeof b.input==='object');
      events.push({type:'content_block_start',index,content_block:{...b,input:{}}},
        {type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify(b.input)}});
    }else if(b.type==='text')events.push({type:'content_block_start',index,content_block:{...b,text:''}},
      {type:'content_block_delta',index,delta:{type:'text_delta',text:b.text}});
    else if(b.type==='thinking')events.push({type:'content_block_start',index,content_block:{...b,thinking:'',signature:''}},
      {type:'content_block_delta',index,delta:{type:'thinking_delta',thinking:b.thinking}},
      {type:'content_block_delta',index,delta:{type:'signature_delta',signature:b.signature}});
    else events.push({type:'content_block_start',index,content_block:b});
    events.push({type:'content_block_stop',index});
  });
  events.push({type:'message_delta',delta:{stop_reason:raw.stop_reason,stop_sequence:raw.stop_sequence??null},usage:raw.usage},{type:'message_stop'});
  return events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join('');
}
