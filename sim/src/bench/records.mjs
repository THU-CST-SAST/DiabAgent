// Agent-visible records of an episode (what a Nightscout instance of the person would hold): sensor
// readings the agent received (real-time CGM samples, flash scan histories, fingersticks), the
// device's insulin ledger, reported carbs, notices and the treatments decided by the agent or the
// usual-care player. Built only from observations; used for the observation history window
// (history_hours), the warm-up summary (warmup_days) and per-day summaries (multi-day memory).
import {fmtG,unitLabel} from './prompt.mjs';

const DAY=86400000,HOUR=3600000;
const r1=v=>Number(v.toFixed(1));
const NOTICE_TEXT={patient_bolus:e=>`person bolused ${e.units} U`,patient_treated_low:e=>`person treated a low with ${e.grams} g`,
  exercise_started:e=>`exercise ${e.kind??''}${e.duration_minutes?` ${e.duration_minutes} min`:''}`.trim(),
  cgm_urgent_low:()=>'ALARM urgent low',cgm_low:()=>'ALARM low',cgm_high:()=>'ALARM high',pump_occlusion_alarm:()=>'ALARM pump occlusion',
  alcohol_reported:()=>'alcohol reported',illness_reported:()=>'illness reported',poor_sleep_reported:()=>'poor sleep reported',
  cgm_sensor_replaced:()=>'CGM sensor replaced'};

export class RecordBook {
  constructor({offsetMs=0}={}) {
    this.offsetMs=offsetMs;                        // local = utc + offset
    this.continuous=new Map();                     // t -> {t, v, src:'cgm'|'flash'}
    this.spot=new Map();                           // t|src -> {time, value_mg_dl, display, source:'meter'|'flash_scan'}
    this.ledger=new Map();                         // t|kind -> {t, units, kind}
    this.carbs=new Map();                          // t|source -> {t, grams, source}
    this.notices=[];                               // {t, text}
    this.actions=[];                               // {t, text, by}
    this.decisions=[];
    this.seen=new Set();
  }
  static fromObservation(obs) {
    return new RecordBook({offsetMs:Date.parse(obs.local_time.replace(' ','T')+':00Z')-Math.floor(Date.parse(obs.virtual_time)/60000)*60000});
  }
  observe(o) {
    const add=(time,v,src)=>{const t=Date.parse(time);if(Number.isFinite(t)&&Number.isFinite(v))this.continuous.set(t,{t,v,src});};
    for(const r of o.cgm_history??[])add(r.time,r.value_mg_dl,'cgm');
    if(o.cgm?.sample_time&&o.glucose?.source==='cgm')add(o.glucose.time,o.glucose.value_mg_dl,'cgm');
    const ls=o.flash?.last_scan;
    if(ls) {
      for(const r of ls.history??[])add(r.time,r.value_mg_dl,'flash');
      if(ls.value_mg_dl!=null){const time=ls.reading_time??ls.at;this.spot.set(`${time}|scan`,{time,value_mg_dl:ls.value_mg_dl,source:'flash_scan'});add(time,ls.value_mg_dl,'flash');}
    }
    const lr=o.meter?.last_reading;
    if(lr)this.spot.set(`${lr.time}|meter`,{time:lr.time,value_mg_dl:lr.value_mg_dl,display:lr.display,source:'meter'});
    for(const d of o.device?.insulin_ledger??[]){const t=Date.parse(d.time);this.ledger.set(`${t}|${d.kind}`,{t,units:d.units,kind:d.kind});}
    for(const c of o.reported_carbs??[]){const t=Date.parse(c.time);this.carbs.set(`${t}|${c.source}`,{t,grams:c.grams,source:c.source});}
    for(const e of o.events??[]) {
      const f=NOTICE_TEXT[e.type],k=`${e.time}|${e.type}|${e.id??''}`;
      if(f&&!this.seen.has(k)){this.seen.add(k);this.notices.push({t:Date.parse(e.time),text:f(e)});}
    }
  }
  addAction(time,text,by='agent',receipt=null) {
    if(receipt?.status&&receipt.status!=='applied')return;
    if(receipt?.action_id&&this.actions.some(a=>a.receipt?.action_id===receipt.action_id))return;
    this.actions.push({t:Date.parse(time),text,by,...(receipt?{receipt:structuredClone(receipt),action:structuredClone(receipt.action)}:{})});
  }

  /** Own successful receipts are independent of the external/NS record mask. */
  ownActions(from=-Infinity,to=Infinity) {
    return this.actions.filter(a=>a.by==='agent'&&a.receipt?.status==='applied'&&a.action&&a.t>=from&&a.t<=to);
  }

  addDecision(time,{action,receipt,note='',kind='event-driven',wait_minutes}) {
    this.decisions.push({time,action:structuredClone(action),status:receipt?.status??'unknown',
      applied:structuredClone(receipt?.applied??null),note,kind,wait_minutes});
  }
  decisionHistoryText(from=-Infinity) {
    const decisions=Number.isFinite(from)?this.decisions.filter(d=>Date.parse(d.time)>=from):this.decisions;
    return '## Your complete decision history (independent of missing external records)\n'
      +(decisions.length?decisions.map(d=>`${d.time} [${d.kind}] ${JSON.stringify(d.action)} => ${d.status}`
        +`${d.applied?` ${JSON.stringify(d.applied)}`:''}; follow-up ${d.wait_minutes} min; ${d.note.slice(0,100)}`).join('\n'):'(none yet)');
  }

  /** Continuous readings in [from, to) as [{time, value_mg_dl}] sorted. */
  series(from,to=Infinity) {
    return [...this.continuous.values()].filter(r=>r.t>=from&&r.t<to).sort((a,b)=>a.t-b.t).map(r=>({time:new Date(r.t).toISOString(),value_mg_dl:r.v,src:r.src}));
  }
  spotReadings(from=-Infinity) {
    return [...this.spot.values()].filter(r=>Date.parse(r.time)>=from).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
  }
  hm(t){const d=new Date(t+this.offsetMs);return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;}
  date(t){return new Date(t+this.offsetMs).toISOString().slice(0,10);}

  /**
   * Nightscout-style summary lines of [from, to): glucose statistics of the visible readings
   * (continuous sensor or fingersticks), hourly means, treatments (boluses, long-acting, rescue and
   * reported carbs, temp basals and other actions), notices. `label` heads the block.
   */
  dayLines(from,to,{units='mmol',label=null}={}) {
    const u=unitLabel(units),g=v=>fmtG(v,units),out=[`### ${label??this.date(from)}`];
    const cont=[...this.continuous.values()].filter(r=>r.t>=from&&r.t<to).map(r=>r.v);
    const spot=this.spotReadings(from).filter(r=>Date.parse(r.time)<to&&r.source==='meter');
    const vals=cont.length?cont:spot.map(r=>r.value_mg_dl);
    if(vals.length) {
      const mean=vals.reduce((a,b)=>a+b,0)/vals.length,sd=Math.sqrt(vals.reduce((a,b)=>a+(b-mean)**2,0)/vals.length);
      const pct=f=>Math.round(100*vals.filter(f).length/vals.length);
      out.push(`glucose (${cont.length?'sensor':'fingersticks'}, n ${vals.length}, ${u}): mean ${g(mean)}, SD ${g(sd)}, min ${g(Math.min(...vals))}, max ${g(Math.max(...vals))}; `
        +`in range ${pct(v=>v>=70&&v<=180)} %, below ${g(70)} ${pct(v=>v<70)} %, below ${g(54)} ${pct(v=>v<54)} %, above ${g(180)} ${pct(v=>v>180)} %`);
      if(cont.length>=24) {
        const byH=new Map();
        for(const r of this.continuous.values())if(r.t>=from&&r.t<to){const h=Math.floor((r.t-from)/HOUR);if(!byH.has(h))byH.set(h,[]);byH.get(h).push(r.v);}
        out.push(`hourly mean: ${[...byH].sort((a,b)=>a[0]-b[0]).map(([h,a])=>`${this.hm(from+h*HOUR).slice(0,2)}h ${g(a.reduce((x,y)=>x+y,0)/a.length)}`).join(', ')}`);
      } else if(spot.length)out.push(`fingersticks: ${spot.map(r=>`${this.hm(Date.parse(r.time))} ${r.display??g(r.value_mg_dl)}`).join(', ')}`);
    } else out.push('glucose: no readings');
    const led=[...this.ledger.values()].filter(e=>e.t>=from&&e.t<to);
    const sum=k=>r1(led.filter(e=>e.kind===k).reduce((s,e)=>s+e.units,0));
    const kinds=[...new Set(led.map(e=>e.kind))];
    if(kinds.length)out.push(`insulin (device log): ${kinds.map(k=>`${k} ${sum(k)} U`).join(', ')}`);
    const boluses=led.filter(e=>e.kind==='bolus').sort((a,b)=>a.t-b.t);
    const carbs=[...this.carbs.values()].filter(c=>c.t>=from&&c.t<to).sort((a,b)=>a.t-b.t);
    const items=[...boluses.map(b=>({t:b.t,text:`bolus ${r1(b.units)} U`})),
      ...carbs.map(c=>({t:c.t,text:`${c.source==='announced_meal'?'meal':'carbs'} ${c.grams} g${c.source==='announced_meal'?' (reported)':` (${c.source.replace(/_/g,' ')})`}`})),
      ...this.actions.filter(a=>{
        if(a.t<from||a.t>=to||/^WAIT\b/.test(a.text))return false;
        if(a.action?.type==='BOLUS')return !boluses.some(b=>b.t===a.t);
        if(a.action?.type==='INGEST_CARBS')return !carbs.some(c=>c.t===a.t&&c.source==='agent_rescue_carbs');
        return !/^(BOLUS|INGEST_CARBS)\b/.test(a.text);
      }).map(a=>({t:a.t,text:a.text})),
      ...this.notices.filter(n=>n.t>=from&&n.t<to&&!/^person bolused/.test(n.text)).map(n=>({t:n.t,text:n.text}))].sort((a,b)=>a.t-b.t);
    out.push(`treatments and events: ${items.length?items.map(i=>`${this.hm(i.t)} ${i.text}`).join('; '):'none'}`);
    return out;
  }

  /** Warm-up records for the system prompt: one block per day of [from, to). */
  warmupText(from,to,{units='mmol',who='usual care'}={}) {
    const days=Math.round((to-from)/DAY),out=[`## Records before this episode (Nightscout-style export of the last ${days} day${days===1?'':'s'}, managed by ${who})`,
      'Everything below is what the person\'s devices and app logged (sensor readings they received, insulin the devices delivered by their own log, carbs they reported). Use it to judge their real needs (basal, carb ratio, sensitivity, habits).'];
    for(let k=0;k<days;k++)out.push(...this.dayLines(from+k*DAY,from+(k+1)*DAY,{units,label:`${this.date(from+k*DAY)} (day ${k-days} before the episode)`}));
    return out.join('\n');
  }
}
