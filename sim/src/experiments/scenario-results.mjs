export function selectReportAgent(trials,requested=null) {
  const agents=[...new Set(trials.map(t=>t.agent).filter(a=>a?.startsWith('llm:')))];
  if(requested&&!agents.includes(requested))throw new Error(`Report agent not present: ${requested}`);
  if(!requested&&agents.length!==1)throw new Error(`Select --agent explicitly; found ${agents.length} LLM agents: ${agents.join(', ')}`);
  return requested??agents[0];
}

export function selectCaseTrials(trials,preset,mode,agent) {
  const task=`${preset.toLowerCase()}-${mode==='wait'?'i0':mode.toLowerCase()}`;
  const found=trials.filter(t=>t.task_id===task&&t.agent===(mode==='wait'?'wait':agent));
  const seen=new Set();
  for(const t of found){const key=`${t.repeat??0}:${t.model_draw??0}`;if(seen.has(key))throw new Error(`Duplicate world/draw for ${task}: ${key}; select disjoint jobs`);seen.add(key);}
  return found.sort((a,b)=>(a.repeat??0)-(b.repeat??0)||(a.model_draw??0)-(b.model_draw??0));
}

/** Only completed draws contribute to descriptive means; preserve every underlying draw. */
export function summarizeDraws(draws) {
  if(!draws.length)return {state:'not_started',draws:[{state:'not_started'}]};
  if(draws.length===1)return {...draws[0],draws};
  const done=draws.filter(c=>c.state==='done');
  const mean=xs=>{const v=xs.filter(Number.isFinite);return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;};
  const numeric=key=>Object.fromEntries([...new Set(done.flatMap(c=>Object.keys(c[key]??{})))].filter(k=>done.some(c=>Number.isFinite(c[key]?.[k])))
    .map(k=>[k,mean(done.map(c=>c[key]?.[k]))]));
  const counts=[...new Set(done.flatMap(c=>Object.keys(c.treatments?.action_counts??{})))];
  return {state:done.length===draws.length?'done':'incomplete',score:mean(done.map(c=>c.score)),draws,
    dynamic:{...numeric('dynamic'),safety_pass:done.length===draws.length&&done.every(c=>c.dynamic.safety_pass)},
    treatments:{...numeric('treatments'),action_counts:Object.fromEntries(counts.map(k=>[k,mean(done.map(c=>c.treatments?.action_counts?.[k]??0))]))}};
}
