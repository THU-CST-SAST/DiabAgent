const MINUTE=60000;

export function weeklyCampaignComplete(jobs,{expectedJobs=3}={}) {
  return Number.isInteger(expectedJobs)&&expectedJobs>=3&&jobs.length===expectedJobs&&jobs.every(job=>Number.isInteger(job.planned)&&job.planned>0
    &&Number.isInteger(job.completed)&&job.completed===job.planned);
}

export function auditWeeklyDecisions(lines,config,{complete=false}={}) {
  const valid=lines.filter(line=>line.decision_kind),start=Date.parse(config.start_time),errors=[];
  const fixed=[],extras={},historyEntries=[];
  let previous=-Infinity;
  for(const [index,line] of valid.entries()) {
    const t=Date.parse(line.sim_time),minute=(t-start)/MINUTE;
    if(!(t>previous))errors.push(`decision ${index}: non-increasing time`);
    previous=t;
    const isFixed=Number.isInteger(minute/60);
    if(line.decision_kind!==(isFixed?'fixed':'extra'))errors.push(`decision ${index}: wrong fixed/extra classification`);
    if(isFixed)fixed.push(minute);
    else {
      const day=new Date(t+config.utc_offset_minutes*MINUTE).toISOString().slice(0,10);
      extras[day]=(extras[day]??0)+1;
      if(extras[day]>6)errors.push(`decision ${index}: extra budget exceeded on ${day}`);
    }
    const boundary=Math.min(start+config.horizon_minutes*MINUTE,start+(Math.floor(minute/60)+1)*60*MINUTE);
    if(line.next_fixed_decision!==boundary)errors.push(`decision ${index}: fixed slot moved`);
    const heading='## Your complete decision history (independent of missing external records)';
    const text=String(line.observation_text??''),position=text.indexOf(heading);
    if(position<0)errors.push(`decision ${index}: own history missing`);
    const rows=new Set(text.slice(position+heading.length).split('\n').map(row=>{
      const end=row.indexOf('; follow-up ');return end<0?row:row.slice(0,end);
    }));
    // Every prior valid decision must retain exact requested action, status and applied values.
    for(const entry of historyEntries)if(!rows.has(entry)) {
      errors.push(`decision ${index}: a prior own decision/receipt is missing or changed`);break;
    }
    const receipt=line.receipt??{},action=line.parsed?.action;
    historyEntries.push(`${receipt.at??line.sim_time} [${line.decision_kind}] ${JSON.stringify(action)} => ${receipt.status??'unknown'}`
      +(receipt.applied?` ${JSON.stringify(receipt.applied)}`:''));
    if(index===0) {
      const system=line.system??'';
      if(!system.includes('Your long-term goal')||!system.includes('4–8 mmol/L'))errors.push('Numeric ongoing target not in actual system prompt');
      if(!system.includes('Fixed hourly decisions')||!system.includes('6 additional observations/decisions'))errors.push('Hourly protocol/cap not in actual system prompt');
      if(!system.includes('records may be missing or withheld'))errors.push('Missingness notice not in actual system prompt');
      if(system.includes('you are asked again right away'))errors.push('Legacy unconditional measurement wake contradicts hourly protocol');
    }
  }
  const expectedFixed=complete?config.horizon_minutes/60:valid.length?Math.floor((previous-start)/MINUTE/60)+1:0;
  if(fixed.length!==expectedFixed||fixed.some((minute,i)=>minute!==60*i))errors.push('Fixed hourly slots missing or duplicated');
  if(complete&&(!valid.length||config.horizon_minutes!==10080))errors.push('Not a complete seven-day controller trace');
  return {ok:errors.length===0,complete,valid_decisions:valid.length,fixed_decisions:fixed.length,
    extra_decisions:Object.values(extras).reduce((sum,n)=>sum+n,0),extras_by_local_date:extras,
    latest_minute:valid.length?(previous-start)/MINUTE:null,
    own_history_pairs_checked:historyEntries.length*(historyEntries.length-1)/2,errors};
}

export function weeklyScoreDistribution(rows,{expected=32,applicable=true}={}) {
  const completed=rows.filter(row=>row.status==='done'&&Number.isFinite(row.score));
  const ordered=completed.map(row=>row.score).sort((a,b)=>a-b),n=ordered.length;
  const below=ordered.filter(score=>score<.5).length;
  const p90=n?ordered[Math.ceil(.9*n)-1]:null;
  return {expected,completed:n,all_complete:n===expected,
    mean:n?ordered.reduce((sum,value)=>sum+value,0)/n:null,
    p90_nearest_rank:p90,below_half:below,below_half_fraction:n?below/n:null,
    difficulty_target_verified:applicable?n===expected&&below>=Math.ceil(.9*expected)&&p90<.5:null,
    weekly_veto_count:completed.filter(row=>row.safety_fail).length,
    zero_score_count:ordered.filter(score=>score===0).length,
    note:!applicable?'Comparator distribution only; the I2 difficulty target does not apply to this arm.':n===expected?'Difficulty only; inspect I0, WAIT, daily diagnostics and veto degeneracy before accepting scenario quality.'
      :'Incomplete matrix: no full-matrix difficulty acceptance; missing runs are not scores.'};
}
