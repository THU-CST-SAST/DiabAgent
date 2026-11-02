import test from 'node:test';
import assert from 'node:assert/strict';
import {modelIdentityMatches} from './model-identity.mjs';

// Regression for a Main212 Qwen world that reached 864 valid steps and was still thrown away with
// "Skill audit model identity mismatch": one of its 250 assistant events was the CLI's own
// '<synthetic>' notice, not model output. The discarded world also tripped the campaign gate, so the
// worker stopped admitting its remaining 26 worlds. The same bug had already cost an Opus and a
// DeepSeek world earlier in the campaign.
//
// This mirrors the audit's rule: '<synthetic>' is local CLI text, so it is neither an identity
// violation nor a model turn, but it must stay text-only and can never carry a tool call.
const audit=(requested,events,maxTurns)=>{
  const assistants=events.filter(e=>e.type==='assistant'&&e.message?.model);
  const synthetic=assistants.filter(e=>e.message.model==='<synthetic>');
  for(const e of synthetic)assert(e.message.content?.every(b=>b.type==='text'),'Synthetic CLI message must be text-only');
  const replies=assistants.filter(e=>e.message.model!=='<synthetic>');
  for(const e of replies)assert(modelIdentityMatches(requested,e.message.model),'Skill audit model identity mismatch');
  const turnIds=new Set(replies.map(e=>e.message.id));
  assert(turnIds.size<=maxTurns);
  return turnIds.size;
};
const reply=(id,model,content=[{type:'tool_use',id:'u'+id,name:'mcp__experiment__act',input:{}}])=>({type:'assistant',message:{id,model,content}});
const notice=text=>({type:'assistant',message:{id:'synthetic-1',model:'<synthetic>',content:[{type:'text',text}]}});

test('a CLI <synthetic> notice is not an identity violation and does not consume a native turn',()=>{
  const events=[reply('m1','qwen3.8-max'),notice('API Error: 503 Service temporarily unavailable'),reply('m2','qwen3.8-max')];
  assert.equal(audit('qwen3.8-max',events,2),2);
});

test('a different real model is still rejected',()=>{
  assert.throws(()=>audit('qwen3.8-max',[reply('m1','qwen3.8-max'),reply('m2','deepseek-v4.1-flash-1017')],7),/identity mismatch/);
});

test('the registered Opus gateway alias still matches',()=>{
  assert.equal(audit('claude-opus-5-5',[reply('m1','claude-opus-5.5'),notice('Request interrupted')],7),1);
});

test('a synthetic message carrying a tool call is rejected',()=>{
  const smuggled={type:'assistant',message:{id:'s1',model:'<synthetic>',content:[{type:'tool_use',id:'u1',name:'mcp__experiment__act',input:{action:{type:'BOLUS',units:5}}}]}};
  assert.throws(()=>audit('qwen3.8-max',[smuggled],7),/text-only/);
});

test('synthetic notices never push a session over its native turn budget',()=>{
  const events=[reply('m1','qwen3.8-max'),notice('a'),notice('b'),notice('c')];
  assert.equal(audit('qwen3.8-max',events,1),1);
});
