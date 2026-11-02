// Trace ingestion: one canonical in-memory format (TraceV1) plus an adapter from Nightscout
// entries/treatments/profile JSON.
//
// TraceV1 (all times epoch ms after normalisation; input may use ISO strings or epoch s/ms):
// {
//   version: 'trace2sim/1',
//   meta: {id?, sex, age_years, weight_kg, height_cm?,
//          therapy: {mode:'pump', pump:{model, insulin}} | {mode:'mdi', mdi:{bolus_pen, bolus_insulin, basal_pen, basal_insulin}},
//          cgm_model?, meter?, utc_offset_minutes? | tz? (IANA, offset taken at the trace start)},
//   cgm:   [{t, mg_dl}],                 smbg: [{t, mg_dl}],
//   carbs: [{t, grams, absorption_minutes?, kind:'meal'|'correction'}],
//   boluses: [{t, units, extended_minutes?}],             extended part spread evenly
//   basal: [{t, rate_u_h, duration_minutes}],             explicit delivered segments (optional)
//   temp_basals: [{t, rate_u_h | percent_of_profile, duration_minutes}],  later temps override earlier
//   basal_injections: [{t, units, insulin}],
//   exercise: [{t, duration_minutes, intensity:'light'|'moderate'|'vigorous'|number(%VO2max), accelerometer_counts?}],
//   events: [{t, type:'site_change'|'sensor_start'|'profile_switch'|..., ...}],
//   profile: {basal:[{start:'HH:MM', rate_u_h}], isf_mg_dl_per_u, carb_ratio_g_per_u, target_mg_dl}
// }
import {toMs,zoneOffsetMinutes,hhmmToMinutes,localMinuteOfDay,MIN_MS} from './util.mjs';

export const TRACE_VERSION='trace2sim/1';
const MMOL=18.016;
const LONG_ACTING=new Set(['glargine','glargine_u100','glargine_u300','degludec','detemir','lantus','toujeo','tresiba','levemir','basaglar','nph']);

const isObj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const num=v=>v===null||v===undefined||v===''?NaN:Number(v);

function timed(list,name,map,warnings) {
  const out=[];let bad=0;
  for(const r of list??[]) {
    const t=toMs(r.t??r.time??r.date??r.created_at);
    const v=map(r);
    if(!Number.isFinite(t)||v===null){bad++;continue;}
    out.push({...v,t});
  }
  if(bad)warnings.push(`${name}: dropped ${bad} malformed record(s)`);
  return out.sort((a,b)=>a.t-b.t);
}

/** Validates and normalises a TraceV1-like object; returns a new trace with sorted ms timestamps. */
export function normalizeTrace(input) {
  if(!isObj(input))throw new Error('trace must be an object');
  const warnings=[...(input.warnings??[])];
  const m=input.meta??{};
  if(!isObj(m))throw new Error('trace.meta must be an object');
  const meta={...m};
  if(!['male','female'].includes(meta.sex))throw new Error('meta.sex must be male or female');
  if(!(num(meta.age_years)>0))throw new Error('meta.age_years required');
  if(!(num(meta.weight_kg)>=10))throw new Error('meta.weight_kg required');
  meta.age_years=num(meta.age_years);meta.weight_kg=num(meta.weight_kg);
  if(meta.height_cm!=null)meta.height_cm=num(meta.height_cm);
  const therapy=meta.therapy??{mode:'pump'};
  if(!['pump','mdi'].includes(therapy.mode))throw new Error('meta.therapy.mode must be pump or mdi');
  meta.therapy=therapy;

  const cgm=timed(input.cgm,'cgm',r=>{const v=num(r.mg_dl??r.sgv??r.value);return Number.isFinite(v)&&v>0?{mg_dl:v}:null;},warnings);
  // Duplicate timestamps (common after re-uploads): keep the first.
  const dedup=cgm.filter((r,i)=>i===0||r.t!==cgm[i-1].t);
  if(dedup.length<cgm.length)warnings.push(`cgm: removed ${cgm.length-dedup.length} duplicate timestamp(s)`);
  if(dedup.length<12)throw new Error('trace needs at least 12 CGM readings');
  const t0=dedup[0].t;
  if(meta.utc_offset_minutes==null)meta.utc_offset_minutes=meta.tz?zoneOffsetMinutes(meta.tz,t0):0;
  if(meta.utc_offset_minutes===0&&!meta.tz&&m.utc_offset_minutes==null)warnings.push('meta: no tz/utc_offset_minutes; assuming UTC for local-time features (dawn, meal plan)');

  const profile=normalizeProfile(input.profile,warnings);
  const trace={
    version:TRACE_VERSION,meta,
    cgm:dedup,
    smbg:timed(input.smbg,'smbg',r=>{const v=num(r.mg_dl??r.value);return Number.isFinite(v)&&v>0?{mg_dl:v}:null;},warnings),
    carbs:timed(input.carbs,'carbs',r=>{const g=num(r.grams??r.carbs);if(!(g>0))return null;
      const a=num(r.absorption_minutes);return {grams:g,absorption_minutes:a>0?a:null,kind:r.kind==='correction'?'correction':'meal'};},warnings),
    boluses:timed(input.boluses,'boluses',r=>{const u=num(r.units??r.insulin);if(!(u>0))return null;
      const e=num(r.extended_minutes);return {units:u,extended_minutes:e>0?e:0};},warnings),
    basal:timed(input.basal,'basal',r=>{const v=num(r.rate_u_h),d=num(r.duration_minutes);return v>=0&&d>0?{rate_u_h:v,duration_minutes:d}:null;},warnings),
    temp_basals:timed(input.temp_basals,'temp_basals',r=>{
      const v=num(r.rate_u_h),p=num(r.percent_of_profile),d=num(r.duration_minutes);
      if(!(d>=0))return null;
      if(v>=0)return {rate_u_h:v,duration_minutes:d};
      if(p>=0)return {percent_of_profile:p,duration_minutes:d};
      return d===0?{rate_u_h:null,duration_minutes:0}:null;},warnings),
    basal_injections:timed(input.basal_injections,'basal_injections',r=>{const u=num(r.units);return u>0?{units:u,insulin:r.insulin??null}:null;},warnings),
    exercise:timed(input.exercise,'exercise',r=>{const d=num(r.duration_minutes);return d>0?{duration_minutes:d,intensity:r.intensity??'moderate',
      ...(r.accelerometer_counts!=null?{accelerometer_counts:num(r.accelerometer_counts)}:{})}:null;},warnings),
    events:timed(input.events,'events',r=>typeof r.type==='string'?{...r,t:undefined}:null,warnings),
    profile,warnings,
  };
  if(therapy.mode==='pump'&&!trace.basal.length&&!profile.basal.length)
    throw new Error('pump trace needs basal segments or a profile basal schedule');
  if(therapy.mode==='mdi'&&!trace.basal_injections.length)warnings.push('mdi trace without basal injections: long-acting insulin unknown');
  return trace;
}

function normalizeProfile(p={},warnings) {
  const out={basal:[],isf_mg_dl_per_u:null,carb_ratio_g_per_u:null,target_mg_dl:null};
  if(!p)return out;
  let basal=p.basal;
  if(typeof basal==='number')basal=[{start:'00:00',rate_u_h:basal}];
  if(Array.isArray(basal))out.basal=basal.map(b=>({start:b.start??b.time??'00:00',rate_u_h:num(b.rate_u_h??b.value)}))
    .filter(b=>b.rate_u_h>=0).sort((a,b)=>hhmmToMinutes(a.start)-hhmmToMinutes(b.start));
  if(out.basal.length&&hhmmToMinutes(out.basal[0].start)!==0)out.basal.unshift({start:'00:00',rate_u_h:out.basal.at(-1).rate_u_h});
  for(const k of ['isf_mg_dl_per_u','carb_ratio_g_per_u','target_mg_dl'])if(num(p[k])>0)out[k]=num(p[k]);
  if(!out.basal.length)warnings.push('profile: no basal schedule');
  return out;
}

/** Programmed profile basal (U/h) at an instant. */
export function scheduledBasalAt(profile,ms,off) {
  const s=profile.basal;if(!s.length)return 0;
  const m=localMinuteOfDay(ms,off);let r=s[0].rate_u_h;
  for(const b of s)if(hhmmToMinutes(b.start)<=m)r=b.rate_u_h;
  return r;
}

/**
 * Delivered basal timeline [{from, to, rate_u_h}] over [from, to): explicit basal segments win,
 * then temp basals (each ends at its duration or at the next temp, NS semantics; duration 0
 * cancels), then the profile schedule.
 */
export function basalTimeline(trace,from,to) {
  if(trace.meta.therapy.mode==='mdi')return [{from,to,rate_u_h:0}];
  const off=trace.meta.utc_offset_minutes,prof=trace.profile;
  const temps=[];
  trace.temp_basals.forEach((tb,i)=>{
    const next=trace.temp_basals[i+1]?.t??Infinity,end=Math.min(tb.t+tb.duration_minutes*MIN_MS,next);
    if(tb.duration_minutes>0&&end>tb.t)temps.push({from:tb.t,to:end,...tb});
  });
  const explicit=trace.basal.map((b,i)=>({from:b.t,to:Math.min(b.t+b.duration_minutes*MIN_MS,trace.basal[i+1]?.t??Infinity),rate:b.rate_u_h}));
  const cuts=new Set([from,to]);
  for(const x of [...temps,...explicit]){if(x.from>from&&x.from<to)cuts.add(x.from);if(x.to>from&&x.to<to)cuts.add(x.to);}
  // Profile boundaries on every local day in range.
  if(prof.basal.length>1) {
    const day0=Math.floor((from+off*MIN_MS)/86400000)*86400000-off*MIN_MS;
    for(let d=day0;d<to;d+=86400000)for(const b of prof.basal){const c=d+hhmmToMinutes(b.start)*MIN_MS;if(c>from&&c<to)cuts.add(c);}
  }
  const pts=[...cuts].sort((a,b)=>a-b),out=[];
  let ti=0,ei=0;
  for(let i=0;i<pts.length-1;i++) {
    const a=pts[i],b=pts[i+1],mid=(a+b)/2;
    while(ei<explicit.length&&explicit[ei].to<=mid)ei++;
    while(ti<temps.length&&temps[ti].to<=mid)ti++;
    const ex=ei<explicit.length&&explicit[ei].from<=mid?explicit[ei]:null;
    const tp=ti<temps.length&&temps[ti].from<=mid?temps[ti]:null;
    const sched=scheduledBasalAt(prof,mid,off);
    const rate=ex?ex.rate:tp?(tp.rate_u_h??sched*tp.percent_of_profile/100):sched;
    if(out.length&&out.at(-1).rate_u_h===rate&&out.at(-1).to===a)out.at(-1).to=b;
    else out.push({from:a,to:b,rate_u_h:rate});
  }
  return out;
}

// --- Nightscout adapter ---------------------------------------------------------------------

const tTime=t=>toMs(t.created_at??t.timestamp??t.mills??t.date);

/**
 * Converts Nightscout API documents to TraceV1 input.
 * ns: {entries:[{type:'sgv'|'mbg', sgv|mbg, date|dateString}], treatments:[...], profile?: NS profile doc(s)}
 * meta: subject/therapy metadata (sex, age_years, weight_kg, therapy, cgm_model, tz...).
 */
export function fromNightscout(ns,meta={}) {
  const warnings=[],entries=ns.entries??[],treatments=ns.treatments??[];
  const cgm=[],smbg=[];
  for(const e of entries) {
    const t=toMs(e.date??e.dateString??e.sysTime);
    if((e.type??'sgv')==='sgv'&&num(e.sgv)>0)cgm.push({t,mg_dl:num(e.sgv)});
    else if(e.type==='mbg'&&num(e.mbg)>0)smbg.push({t,mg_dl:num(e.mbg)});
  }
  const seen=new Set(),carbs=[],boluses=[],temp_basals=[],basal_injections=[],exercise=[],events=[];
  let profileSwitches=0;
  const sorted=[...treatments].map(t=>({...t,_t:tTime(t)})).filter(t=>Number.isFinite(t._t)).sort((a,b)=>a._t-b._t);
  for(const tr of sorted) {
    const key=tr._id??`${tr._t}|${tr.eventType}|${tr.insulin}|${tr.carbs}|${tr.absolute??tr.rate}|${tr.duration}`;
    if(seen.has(key))continue;seen.add(key);
    const t=tr._t,type=tr.eventType??'',insulin=num(tr.insulin),c=num(tr.carbs);
    const insulinType=String(tr.insulinType??tr.insulin_type??'').toLowerCase();
    if(type==='Temp Basal'||type==='Temporary Basal') {
      const dur=num(tr.duration??(tr.durationInMilliseconds!=null?tr.durationInMilliseconds/MIN_MS:NaN));
      const abs=num(tr.absolute??tr.rate);
      if(abs>=0)temp_basals.push({t,rate_u_h:abs,duration_minutes:dur>=0?dur:30});
      else if(Number.isFinite(num(tr.percent)))temp_basals.push({t,percent_of_profile:100+num(tr.percent),duration_minutes:dur>=0?dur:30});
      else if(dur===0)temp_basals.push({t,rate_u_h:null,duration_minutes:0});
      continue;
    }
    if(type==='Basal Injection'||(insulin>0&&LONG_ACTING.has(insulinType))) {
      if(insulin>0)basal_injections.push({t,units:insulin,insulin:insulinType||null});
      continue;
    }
    if(insulin>0) {
      const dur=num(tr.duration);
      if(type==='Combo Bolus'&&dur>0) {
        const now=num(tr.splitNow),ext=num(tr.splitExt);
        if(now>=0&&ext>=0&&now+ext>0) {
          const total=num(tr.enteredinsulin)>0?num(tr.enteredinsulin):insulin;
          if(now>0)boluses.push({t,units:total*now/(now+ext)});
          if(ext>0)boluses.push({t,units:total*ext/(now+ext),extended_minutes:dur});
        } else boluses.push({t,units:insulin,extended_minutes:dur});
      } else boluses.push({t,units:insulin});
    }
    if(c>0)carbs.push({t,grams:c,absorption_minutes:num(tr.absorptionTime)>0?num(tr.absorptionTime):null,
      kind:type==='Carb Correction'?'correction':'meal'});
    if(type==='Exercise'&&num(tr.duration)>0)exercise.push({t,duration_minutes:num(tr.duration),intensity:tr.intensity??'moderate'});
    if(type==='BG Check'&&num(tr.glucose)>0&&(tr.glucoseType??'Finger')==='Finger')
      smbg.push({t,mg_dl:String(tr.units).startsWith('mmol')?num(tr.glucose)*MMOL:num(tr.glucose)});
    if(type==='Site Change')events.push({t,type:'site_change'});
    if(type==='Sensor Start'||type==='Sensor Change')events.push({t,type:'sensor_start'});
    if(type==='Profile Switch'){profileSwitches++;events.push({t,type:'profile_switch',percentage:num(tr.percentage)||100});}
  }
  if(profileSwitches)warnings.push(`nightscout: ${profileSwitches} profile switch(es) recorded; percentage/timeshift are not applied to the basal schedule`);
  const {profile,tz}=profileFromNightscout(ns.profile,warnings);
  const outMeta={...meta};
  if(outMeta.utc_offset_minutes==null&&!outMeta.tz&&tz)outMeta.tz=tz;
  return {meta:outMeta,cgm,smbg,carbs,boluses,temp_basals,basal_injections,exercise,events,profile:meta.profile??profile,warnings};
}

/** Picks the active profile from a NS profile document (or array, latest first). */
export function profileFromNightscout(doc,warnings=[]) {
  if(!doc)return {profile:null,tz:null};
  const d=Array.isArray(doc)?[...doc].sort((a,b)=>toMs(b.startDate??b.created_at??0)-toMs(a.startDate??a.created_at??0))[0]:doc;
  const store=d.store?.[d.defaultProfile]??Object.values(d.store??{})[0]??d;
  const mmol=String(store.units??d.units??'mg/dl').toLowerCase().startsWith('mmol'),g=v=>mmol?v*MMOL:v;
  const first=v=>Array.isArray(v)?num(v[0]?.value):num(v);
  const lo=first(store.target_low),hi=first(store.target_high);
  const profile={
    basal:(Array.isArray(store.basal)?store.basal:[{time:'00:00',value:store.basal}]).map(b=>({start:b.time??'00:00',rate_u_h:num(b.value)})),
    isf_mg_dl_per_u:Number.isFinite(first(store.sens))?g(first(store.sens)):null,
    carb_ratio_g_per_u:Number.isFinite(first(store.carbratio))?first(store.carbratio):null,
    target_mg_dl:Number.isFinite(lo)?g(Number.isFinite(hi)?(lo+hi)/2:lo):null,
  };
  if(Array.isArray(store.sens)&&store.sens.length>1)warnings.push('profile: time-varying ISF reduced to its first entry');
  if(Array.isArray(store.carbratio)&&store.carbratio.length>1)warnings.push('profile: time-varying carb ratio reduced to its first entry');
  return {profile,tz:store.timezone??null};
}
