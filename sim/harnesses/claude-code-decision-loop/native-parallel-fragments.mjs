import {isDeepStrictEqual} from 'node:util';
import {modelIdentityMatches} from './model-identity.mjs';

// This detects a known-invalid batch only. It never accepts an incomplete reply or executes a tool.
export function pendingParallelControllerIds(events,{model,prefix='mcp__experiment__'}={}){
  const groups=new Map();
  for(const e of events){
    const m=e.type==='assistant'?e.message:null;
    if(!m?.id||m.type!=='message'||m.role!=='assistant'||m.stop_reason!=='tool_use'
      ||!Array.isArray(m.content)||!modelIdentityMatches(model,m.model))continue;
    const uses=m.content.filter(b=>b.type==='tool_use');
    let g=groups.get(m.id);if(!g){g=new Map();groups.set(m.id,g);}
    for(const u of uses){
      if(typeof u.id!=='string'||!u.name?.startsWith(prefix)||!u.input||typeof u.input!=='object')continue;
      const old=g.get(u.id);if(old&&!isDeepStrictEqual(old,u))throw Error('Conflicting parallel tool fragment');
      g.set(u.id,u);
    }
  }
  return [...groups.values()].filter(g=>g.size>1).flatMap(g=>[...g.keys()]);
}
