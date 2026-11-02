import test from 'node:test';
import assert from 'node:assert/strict';
import {modelIdentityMatches} from '../harnesses/claude-code-decision-loop/model-identity.mjs';
import {parseCodeStream} from '../harnesses/claude-code-decision-loop/reply-parser.mjs';
const message=model=>({id:'identity_fixture',type:'message',role:'assistant',model,
  content:[{type:'thinking',thinking:'preserved',signature:'signature_exact'},
    {type:'tool_use',id:'tool_1',name:'mcp__experiment__act',input:{action:{type:'WAIT'}}}],
  stop_reason:'tool_use',usage:{input_tokens:3,output_tokens:4}});
test('only the explicitly registered returned spelling is added',()=>{
  assert(modelIdentityMatches('claude-opus-5-5','claude-opus-5.5'));
  for(const model of ['claude-opus-5-4','claude-sonnet-5.5','claude-opus-5.5-unknown','claude-opus-5-5-20261028',null])
    assert.equal(modelIdentityMatches('claude-opus-5-5',model),false);
});
test('JSON reply keeps its actual returned model, thinking/signature and tool bytes',()=>{
  const raw=message('claude-opus-5.5');
  assert.deepEqual(parseCodeStream(JSON.stringify(raw),{model:'claude-opus-5-5'}).raw,raw);
  assert.throws(()=>parseCodeStream(JSON.stringify(message('claude-sonnet-5.5')),{model:'claude-opus-5-5'}),/identity/);
});
test('SSE reply keeps returned identity without converting or rewriting the raw message',()=>{
  const raw=message('claude-opus-5.5');
  const events=[{type:'message_start',message:{...raw,content:[],stop_reason:null}},
    ...raw.content.map((content_block,index)=>({type:'content_block_start',index,content_block})),
    {type:'message_delta',delta:{stop_reason:'tool_use'},usage:raw.usage},{type:'message_stop'}];
  assert.deepEqual(parseCodeStream(events.map(e=>'data: '+JSON.stringify(e)).join('\n'),{model:'claude-opus-5-5'}).raw,raw);
});
