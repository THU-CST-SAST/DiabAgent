// Experiment 3 adaptive agent: the self-managing patient baseline (src/policies/patient.mjs) plus a
// memory across days. Observation-only: it reads what any agent sees (glucose readings, its own
// boluses from the device ledger, reported carbs, the programmed profile), never the truth.
//
// Every morning at `adjustAt` (local) it reviews the outcomes it has seen and titrates the profile
// with one SET_PROFILE action, like a clinician's dose titration (outcome rules, not a model fit;
// in this simulator glucose relaxes quickly toward its set point, so a 4-hour "Δglucose" balance
// carries almost no information about the carb ratio, while lows and peaks do):
//   basal  overnight (01:00-04:00, from 3 h after the last bolus/meal): a low (< 70 or rescue
//          carbs) = too much; a mean below 100 (graded to 90) = too much, above 140 (graded to
//          180) = too little.
//   CR     each announced, bolused meal over the window to +4 h or the next disturbance (other
//          meal, bolus, exercise; >= 2.5 h): a low or rescue carbs from 1 h on, or a nadir below
//          85 (graded to 70) = over-bolused (CR up); otherwise a peak rise above 70 (graded to
//          130) or an end value above 180 (graded to 240) = under-bolused (CR down).
//   ISF    each correction bolus (no carbs within 3 h before), window to +3 h: a low = too strong
//          (ISF up); still above 180 at the end (graded to 240) = too weak (ISF down).
// Evidence is pooled over the last `memoryDays` reviews (each older day weighs `decay` times less)
// and is forgotten for a parameter once that parameter changes. The step is proportional to the
// net evidence (mean of graded events in [−1 under-dosed, +1 over-dosed]), capped at ±`maxStep` per
// day, after a deadband (|net| <= `deadband` = no change) and at least `minEvents` meal/correction
// events; changes below `minChange` are not sent (stability). memory() returns the JSON notebook:
// per day the evidence, the pooled estimates and the change applied.
import {patientPolicy} from '../policies/patient.mjs';

export const ADAPTIVE_VERSION='exp3-adaptive/0.2';
export const ADAPTIVE_DEFAULTS=Object.freeze({
  adjustAt:'06:00',overnight:Object.freeze(['01:00','04:00']),quietBeforeMinutes:180,
  mealWindowMinutes:240,correctionWindowMinutes:180,minWindowMinutes:150,
  // Evidence grading (mg/dL): full "too much insulin" at a nadir <= low, none above nadirOk; full
  // "too little" at a peak rise >= peakRiseMax or end >= endHighMax, none below peakRiseOk / endHigh.
  night:Object.freeze({low:90,ok:100,high:140,highMax:180}),
  meal:Object.freeze({low:70,nadirOk:85,peakRiseOk:70,peakRiseMax:130,endHigh:180,endHighMax:240,lowFromMinutes:60}),
  memoryDays:3,decay:0.5,minEvents:3,deadband:0.2,
  maxStep:Object.freeze({basal:0.15,basal_mdi:0.1,cr:0.15,isf:0.15}),
  minChange:0.03,readingToleranceMinutes:20,
});
const MIN=60000,HOUR=3600000,DAY=86400000;
const hhmm=s=>Number(s.slice(0,2))*60+Number(s.slice(3));
const r3=v=>v==null||!Number.isFinite(v)?null:Number(v.toFixed(3));
const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
/** 0 at `zero`, 1 at `one` (either direction), linear and clipped in between. */
const grade=(v,zero,one)=>clamp((v-zero)/(one-zero),0,1);

export function adaptiveAgent(options={}) {
  const o={...ADAPTIVE_DEFAULTS,...options,maxStep:{...ADAPTIVE_DEFAULTS.maxStep,...options.maxStep},
    night:{...ADAPTIVE_DEFAULTS.night,...options.night},meal:{...ADAPTIVE_DEFAULTS.meal,...options.meal}};
  const base=patientPolicy();
  const S={offset:null,start:null,readings:new Map(),boluses:new Map(),carbs:new Map(),exercise:new Set(),
    mealCursor:null,corrCursor:null,lastAdjustDate:null};
  const memory={version:ADAPTIVE_VERSION,options:o,days:[]};

  // ---- what the agent observed ----------------------------------------------------------
  function ingest(obs) {
    const t=Date.parse(obs.virtual_time);
    if(S.offset===null){S.offset=Date.parse(obs.local_time.replace(' ','T')+':00Z')-Math.floor(t/MIN)*MIN;S.start=t;S.mealCursor=S.corrCursor=t-MIN;}
    const add=(time,v)=>{const ms=Date.parse(time);if(Number.isFinite(ms)&&Number.isFinite(v))S.readings.set(ms,v);};
    for(const r of obs.cgm_history??[])add(r.time,r.value_mg_dl);
    const scan=obs.flash?.last_scan;
    if(scan){for(const r of scan.history??[])add(r.time,r.value_mg_dl);if(scan.reading_time)add(scan.reading_time,scan.value_mg_dl);}
    if(obs.meter?.last_reading)add(obs.meter.last_reading.time,obs.meter.last_reading.value_mg_dl);
    if(obs.glucose)add(obs.glucose.time,obs.glucose.value_mg_dl);
    for(const d of obs.device.insulin_ledger??[])if(d.kind==='bolus')S.boluses.set(Date.parse(d.time),d.units);
    for(const c of obs.reported_carbs??[])S.carbs.set(`${c.time}|${c.source}`,{t:Date.parse(c.time),grams:c.grams,source:c.source});
    for(const e of obs.events??[])if(e.type==='exercise_started')S.exercise.add(Date.parse(e.time));
  }
  const atLocal=(dayStartLocal,hm)=>dayStartLocal+hhmm(hm)*MIN-S.offset;   // UTC ms of local HH:MM on that local day
  const readingsIn=(a,b)=>[...S.readings].filter(([ms])=>ms>=a&&ms<=b).sort((x,y)=>x[0]-y[0]);
  const carbsIn=(a,b,pred=()=>true)=>[...S.carbs.values()].filter(c=>c.t>a&&c.t<=b&&pred(c));
  const bolusesIn=(a,b)=>[...S.boluses].filter(([ms])=>ms>a&&ms<=b);
  const isMeal=c=>c.source==='announced_meal';
  /** Earliest disturbance in (t, until]: another meal, a bolus not in `own`, or exercise. */
  function nextDisturbance(t,until,own) {
    const ts=[...carbsIn(t,until,isMeal).map(c=>c.t),...bolusesIn(t,until).filter(([ms])=>!own.has(ms)).map(([ms])=>ms),
      ...[...S.exercise].filter(ms=>ms>t&&ms<=until)];
    return ts.length?Math.min(...ts):until;
  }
  /** Readings cover [a, b] well enough (no gap > 45 min, both ends within tolerance). */
  function covered(pts,a,b) {
    if(pts.length<2)return false;
    const tol=o.readingToleranceMinutes*MIN;
    if(pts[0][0]>a+tol||pts.at(-1)[0]<b-tol)return false;
    for(let i=1;i<pts.length;i++)if(pts[i][0]-pts[i-1][0]>45*MIN)return false;
    return true;
  }

  // ---- evidence: +1 too much insulin, −1 too little, 0 fine ----------------------------------
  function overnight(dayStartLocal,now) {
    const ws0=atLocal(dayStartLocal,o.overnight[0]),we=Math.min(atLocal(dayStartLocal,o.overnight[1]),now),quiet=o.quietBeforeMinutes*MIN;
    const recent=[...bolusesIn(ws0-DAY,we).map(([ms])=>ms),...carbsIn(ws0-DAY,we,isMeal).map(c=>c.t)].filter(ms=>ms<we);
    const ws=Math.max(ws0,...recent.map(ms=>ms+quiet)),pts=readingsIn(ws,we);
    const rec={window:[new Date(ws).toISOString(),new Date(we).toISOString()],n:pts.length};
    if(carbsIn(ws,we,c=>!isMeal(c)).length>0||pts.some(([,v])=>v<70))return {...rec,low:true,evidence:1};
    if(we-ws<2*HOUR||!covered(pts,ws,we))return {...rec,evidence:null,skipped:'window too short or readings missing'};
    const mean=pts.reduce((s,p)=>s+p[1],0)/pts.length;
    return {...rec,mean:r3(mean),evidence:r3(grade(mean,o.night.ok,o.night.low)-grade(mean,o.night.high,o.night.highMax))};
  }
  function meals(from,to) {
    const out=[];
    for(const c of [...S.carbs.values()].filter(c=>isMeal(c)&&c.t>from&&c.t<=to).sort((a,b)=>a.t-b.t)) {
      const rec={time:new Date(c.t).toISOString(),grams:c.grams};
      const own=bolusesIn(c.t-MIN,c.t+15*MIN);
      if(!own.length){out.push({...rec,skipped:'no meal bolus'});continue;}
      const te=nextDisturbance(c.t,c.t+o.mealWindowMinutes*MIN,new Set(own.map(([ms])=>ms))),pts=readingsIn(c.t,te);
      Object.assign(rec,{bolus_u:own.reduce((s,[,u])=>s+u,0),window_minutes:(te-c.t)/MIN});
      if(te-c.t<o.minWindowMinutes*MIN){out.push({...rec,skipped:'window too short'});continue;}
      if(!covered(pts,c.t,te)){out.push({...rec,skipped:'readings missing'});continue;}
      const g0=pts[0][1],peak=Math.max(...pts.map(p=>p[1])),late=pts.filter(([ms])=>ms>=c.t+o.meal.lowFromMinutes*MIN);
      const nadir=Math.min(...late.map(p=>p[1])),end=pts.at(-1)[1];
      const low=carbsIn(c.t+o.meal.lowFromMinutes*MIN,te,x=>!isMeal(x)).length>0||nadir<o.meal.low;
      const over=low?1:grade(nadir,o.meal.nadirOk,o.meal.low);
      const under=over>0?0:Math.max(grade(peak-g0,o.meal.peakRiseOk,o.meal.peakRiseMax),grade(end,o.meal.endHigh,o.meal.endHighMax));
      out.push({...rec,g0:r3(g0),peak_rise:r3(peak-g0),nadir:r3(nadir),end:r3(end),low,evidence:r3(over-under)});
    }
    return out;
  }
  function corrections(from,to) {
    const out=[];
    for(const [tb,units] of bolusesIn(from,to).sort((a,b)=>a[0]-b[0])) {
      if(carbsIn(tb-o.quietBeforeMinutes*MIN,tb+MIN).length)continue;   // meal bolus or carbs still absorbing
      const te=nextDisturbance(tb,tb+o.correctionWindowMinutes*MIN,new Set([tb])),pts=readingsIn(tb,te);
      const rec={time:new Date(tb).toISOString(),units,window_minutes:(te-tb)/MIN};
      if(te-tb<o.minWindowMinutes*MIN||!covered(pts,tb,te)){out.push({...rec,skipped:'disturbed window or readings missing'});continue;}
      const low=carbsIn(tb,te).length>0||pts.some(([,v])=>v<70),end=pts.at(-1)[1];
      out.push({...rec,g0:r3(pts[0][1]),end:r3(end),low,evidence:low?1:-r3(grade(end,o.meal.endHigh,o.meal.endHighMax))});
    }
    return out;
  }

  /** Pooled evidence for one parameter: the last memoryDays reviews since the parameter last changed. */
  function pooled(field,key,today) {
    let lastChange=-1;memory.days.forEach((d,i)=>{if(d.changes[field])lastChange=i;});
    const list=[...memory.days.slice(Math.max(lastChange+1,memory.days.length-(o.memoryDays-1))).map(d=>d.evidence),today];
    let w=0,s=0,n=0;
    list.forEach((ev,i)=>{const wt=o.decay**(list.length-1-i);for(const x of ev[key]){s+=wt*x;w+=wt;n++;}});
    return n?{mean:s/w,n}:null;
  }

  function adjust(obs,now,dateStr,dayStartLocal) {
    const night=overnight(dayStartLocal,now),mealCut=now-o.mealWindowMinutes*MIN,corrCut=now-o.correctionWindowMinutes*MIN;
    const ms=meals(S.mealCursor,mealCut),cs=corrections(S.corrCursor,corrCut);   // each event reviewed once, after its window closed
    S.mealCursor=mealCut;S.corrCursor=corrCut;
    const evidence={basal:night.evidence==null?[]:[night.evidence],cr:ms.filter(m=>m.evidence!=null).map(m=>m.evidence),
      isf:cs.filter(c=>c.evidence!=null).map(c=>c.evidence)};
    const p=obs.profile,spec=obs.action_specs.SET_PROFILE,mdi=p.basal_u_h==null;
    const action={type:'SET_PROFILE'},changes={},estimates={};
    const grid=(v,s)=>s?Math.round(v/s)*s:v;
    // Positive evidence = too much insulin: basal down, CR up (weaker), ISF up (weaker).
    const params=[
      mdi?{field:'basal_dose_u',key:'basal',cur:p.basal_injection.units,dir:-1,max:o.maxStep.basal_mdi,round:v=>grid(v,spec.basal_dose_u?.step)}
        :{field:'basal_u_h',key:'basal',cur:p.basal_u_h,dir:-1,max:o.maxStep.basal,round:v=>grid(v,spec.basal_u_h?.step||0.01)},
      {field:'carb_ratio_g_per_u',key:'cr',cur:p.carb_ratio_g_per_u,dir:1,max:o.maxStep.cr,round:v=>grid(v,0.1)},
      {field:'isf_mg_dl_per_u',key:'isf',cur:p.isf_mg_dl_per_u,dir:1,max:o.maxStep.isf,round:v=>grid(v,1)},
    ];
    for(const q of params) {
      const e=pooled(q.field,q.key,evidence);estimates[q.key]=e?{net_evidence:r3(e.mean),events:e.n}:null;
      // Night evidence is one event per day; meals/corrections need minEvents before acting.
      if(!e||!spec[q.field]||(q.key!=='basal'&&e.n<o.minEvents))continue;
      const m=Math.sign(e.mean)*Math.max(0,Math.abs(clamp(e.mean,-1,1))-o.deadband)/(1-o.deadband);
      const target=q.cur*Math.exp(q.dir*m*Math.log(1+q.max));
      const v=clamp(q.round(clamp(target,spec[q.field].min,spec[q.field].max)),spec[q.field].min,spec[q.field].max);
      if(Math.abs(Math.log(v/q.cur))>=o.minChange){action[q.field]=Number(v.toFixed(3));changes[q.field]={from:q.cur,to:action[q.field]};}
    }
    memory.days.push({date:dateStr,at:obs.virtual_time,overnight:night,meals:ms,corrections:cs,evidence,estimates,
      profile_before:{basal_u_h:p.basal_u_h,basal_dose_u:p.basal_injection?.units??null,carb_ratio_g_per_u:p.carb_ratio_g_per_u,isf_mg_dl_per_u:p.isf_mg_dl_per_u},changes});
    return Object.keys(changes).length?{action,rationale:`daily profile review ${dateStr}: ${Object.entries(changes).map(([k,c])=>`${k} ${c.from}->${c.to}`).join(', ')}`}:null;
  }

  function policy(obs) {
    ingest(obs);
    const d=base(obs);
    if(d.action.type!=='WAIT'||!obs.action_specs.SET_PROFILE)return d;
    const t=Date.parse(obs.virtual_time),lm=t+S.offset,dayStartLocal=Math.floor(lm/DAY)*DAY,dateStr=new Date(dayStartLocal).toISOString().slice(0,10);
    // Reviews from the first morning after the start (the first day only collects evidence).
    if(dateStr!==S.lastAdjustDate&&lm-dayStartLocal>=hhmm(o.adjustAt)*MIN&&dayStartLocal>S.start+S.offset) {
      S.lastAdjustDate=dateStr;
      const r=adjust(obs,t,dateStr,dayStartLocal);
      if(r)return r;
    }
    return d;
  }
  return {policy,memory:()=>structuredClone(memory)};
}
