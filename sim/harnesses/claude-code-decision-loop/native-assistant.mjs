import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {modelIdentityMatches} from './model-identity.mjs';
import {nativeWitnessMatches} from './native-skill.mjs';

// Code can emit completed JSON replies as ordered assistant block events rather than stream_event.
// Matching native MCP delivery is the completion witness; no stop field or block is invented.
export function assistantReplies(events,receipts,{model,nativeWitnesses=[]}={}){
  const groups=new Map();
  for(const event of events){
    const m=event.type==='assistant'?event.message:null;
    if(!m?.id||m.type!=='message'||m.role!=='assistant'||!Array.isArray(m.content)||m.stop_reason!=='tool_use')continue;
    if(model&&!modelIdentityMatches(model,m.model))continue;
    const {content,...header}=m;
    let g=groups.get(m.id);
    if(!g){g={header,blocks:[],chunks:0};groups.set(m.id,g);}
    assert(isDeepStrictEqual(g.header,header),'Native assistant chunk metadata changed');
    g.blocks.push(...structuredClone(content));
    g.chunks++;
  }
  const complete=[];
  for(const g of groups.values()){
    assert.equal(events.filter(e=>e.type==='assistant'&&e.message?.id===g.header.id).length,g.chunks,
      'Native message has ignored or incomplete assistant fragments; no signed block may be dropped');
    const uses=g.blocks.filter(b=>b.type==='tool_use');
    if(!uses.length||new Set(uses.map(u=>u.id)).size!==uses.length)continue;
    if(!uses.every(u=>typeof u.id==='string'&&u.input&&typeof u.input==='object'&&!u.input.__unparsedToolInput
      &&(u.name?.startsWith('mcp__experiment__')?receipts.some(r=>r._meta?.['claudecode/toolUseId']===u.id
        &&'mcp__experiment__'+r.name===u.name&&isDeepStrictEqual(r.arguments,u.input))
        :['Skill','Read'].includes(u.name)&&nativeWitnesses.some(w=>nativeWitnessMatches(u,w)))))continue;
    complete.push({...g.header,content:g.blocks});
  }
  return complete;
}
