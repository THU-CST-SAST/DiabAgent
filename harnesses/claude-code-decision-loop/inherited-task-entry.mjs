import assert from 'node:assert/strict';

// Resuming preserves the original automatic entry. A later model-selected Skill call may
// legitimately reload it; every additional body needs its own new successful Skill use.
export function verifyInheritedTaskEntries({history,entries,sourceEntries,successfulFreshSkillIds}){
 assert(sourceEntries.length>=1);assert(entries.length>=sourceEntries.length);
 assert.deepEqual(entries.slice(0,sourceEntries.length),sourceEntries,'Original task entry records changed');
 const allowed=new Set(successfulFreshSkillIds),uses=[];
 for(let i=0;i<history.length;i++){
  const content=history[i].message?.content;if(history[i].type!=='assistant'||!Array.isArray(content))continue;
  for(const b of content)if(b.type==='tool_use'&&b.name==='Skill'&&allowed.has(b.id))uses.push({id:b.id,position:i});
 }
 const claimed=new Set();
 for(const entry of entries.slice(sourceEntries.length)){
  const position=history.indexOf(entry);assert(position>=0);
  const use=uses.find(u=>u.position<position&&!claimed.has(u.id));assert(use,'Extra task entry lacks a new successful model-selected Skill call');claimed.add(use.id);
 }
 return {inherited_entries:sourceEntries.length,model_selected_reloads:entries.length-sourceEntries.length};
}
