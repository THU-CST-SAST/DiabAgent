import {createHash} from 'node:crypto';

export function random(seed) {
  let a=seed>>>0;
  return ()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};
}
export const localDay=ms=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));
const at=(day,time)=>Date.parse(`${day}T${time}:00+08:00`);
export function dayEvents(day,c) {
  const seed=createHash('sha256').update(`${c.seed}:${day}`).digest().readUInt32LE(0),rng=random(seed);
  const jitter=n=>Math.round((rng()*2-1)*n),events=[];
  for(const [name,m] of Object.entries(c.meals)) events.push({id:`meal:${day}:${name}`,type:'meal',name,
    at:at(day,m.time)+jitter(m.timeJitterMinutes)*60000,carbsG:m.carbsG+jitter(m.carbsJitterG),tau:m.absorptionMinutes,
    source:'synthetic_daily_lifestyle'});
  const bedtime=at(day,c.sleep.bedtime)+jitter(c.sleep.jitterMinutes)*60000;
  let wake=at(day,c.sleep.wakeTime)+jitter(c.sleep.jitterMinutes)*60000;
  if(wake<=bedtime) wake+=86400000;
  events.push({id:`sleep:${day}`,type:'sleep',at:bedtime,until:wake,source:'context_label_no_sleep_physiology_in_original_model'},
    {id:`wake:${day}`,type:'wake',at:wake,source:'synthetic_daily_lifestyle'});
  if(c.activity.enabled&&rng()<c.activity.probability) events.push({id:`walk:${day}`,type:'exercise',at:at(day,'16:00')+jitter(60)*60000,
    until:null,durationMinutes:c.activity.durationMinutes,AC:c.activity.accelerometerCounts,source:'synthetic_aerobic_accelerometry'});
  if(c.stress.enabled&&rng()<c.stress.probability) events.push({id:`stress:${day}`,type:'stress',at:at(day,'10:00')+jitter(90)*60000,
    durationMinutes:c.stress.durationMinutes,hepaticDelta:c.stress.hepaticDeltaMgdlPerMin,source:'experimental_stress_input_not_clinically_validated'});
  return events.map(e=>({...e,until:e.until??(e.durationMinutes?e.at+e.durationMinutes*60000:undefined)})).sort((a,b)=>a.at-b.at);
}
