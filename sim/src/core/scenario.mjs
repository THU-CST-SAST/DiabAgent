import {Rng,streamSeed} from './rng.mjs';

const DAY_MS=86400000;
export const localDay=(ms,offsetMin)=>new Date(ms+offsetMin*60000).toISOString().slice(0,10);
export const localAt=(day,hhmm,offsetMin)=>Date.parse(`${day}T${hhmm}:00Z`)-offsetMin*60000;
const roundTo=(v,step)=>Math.round(v/step)*step;

/**
 * Expands a scenario config into a time-ordered event list for [start, end); explicit events
 * are placed relative to origin (the episode start).
 * Days are generated from hash(seed, day), so the same calendar day yields the
 * same events regardless of horizon or start. Three things are kept separate:
 *   ingestion     - hidden; carbs enter the gut model
 *   announcement  - visible; what the patient reports (possibly misestimated)
 *   rescue carbs  - an agent action, handled by the environment
 */
export function generateEvents(scenario,{seed,start,end,utcOffsetMinutes,origin=start}) {
  const events=[];
  for(let t=start-DAY_MS;t<end+DAY_MS;t+=DAY_MS)events.push(...dayEvents(scenario,seed,localDay(t,utcOffsetMinutes),utcOffsetMinutes));
  // Explicit events are timed from the episode origin, not from this generation window.
  for(const e of scenario.extra_events)events.push(...[].concat(explicitEvent(e,origin)));
  return dedupe(events).filter(e=>e.at>=start&&e.at<end).sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
}

function dayEvents(s,seed,day,offset) {
  const rng=new Rng(streamSeed(seed,`scenario:${day}`)),jitter=n=>Math.round(rng.symmetric(n)),out=[];
  // Optional features draw from their own streams so the base meal/activity sequence never shifts:
  // skipped meals from `meal-extras`, high-fat composition from `meal-fat` (separate, so enabling
  // high-fat meals never changes which meals are skipped).
  const extras=new Rng(streamSeed(seed,`scenario:${day}:meal-extras`)),fat=new Rng(streamSeed(seed,`scenario:${day}:meal-fat`));
  for(const [name,m] of Object.entries(s.meals)) {
    const at=localAt(day,m.time,offset)+jitter(m.time_jitter_minutes)*60000;
    let grams=m.carbs_g+jitter(m.carbs_jitter_g),absorption=m.absorption_minutes,composition='standard';
    const announced=rng.next()<(m.announce_probability??s.announcement.probability);   // per-meal override, same draw
    const a=s.announcement,error=a.model==='normal'?Math.max(-0.9,a.bias+rng.normal(0,a.sd)):rng.symmetric(a.carb_error_fraction);
    if(m.probability!==undefined&&extras.next()>=m.probability)continue;   // skipped meal or snack
    if(m.high_fat_probability&&fat.next()<m.high_fat_probability) {
      // Fat/protein delay absorption and add late glucose the patient does not count as carbs
      // (Wolpert 2013: +42% insulin after a 60 g fat dinner; Smart 2013). Mapping assumed.
      absorption*=1.6;composition='high_fat';
    }
    const reported=announced?Math.max(5,roundTo(grams*(1+error),5)):null;
    if(composition==='high_fat')grams=Math.round(grams*1.2);
    out.push({id:`meal:${day}:${name}`,type:'meal',name,at,grams,absorption_minutes:absorption,composition,announced_grams:reported,
      ...(reported!==null&&composition==='high_fat'&&s.announcement.report_composition?{reported_composition:composition}:{})});
  }
  const a=s.activity;
  if(a.enabled&&rng.next()<a.probability) {
    const at=localAt(day,a.time,offset)+jitter(a.time_jitter_minutes)*60000;
    out.push({id:`exercise:${day}`,type:'exercise',at,until:at+a.duration_minutes*60000,AC:a.accelerometer_counts,announced:a.announced});
    out.push(...exercisePlan(`exercise_plan:${day}`,'aerobic',at,a));
  }
  const st=s.stress;
  if(st.enabled&&rng.next()<st.probability) {
    const at=localAt(day,st.time,offset)+jitter(st.time_jitter_minutes)*60000;
    out.push({id:`stress:${day}`,type:'stress',at,until:at+st.duration_minutes*60000,hepatic_delta:st.hepatic_delta_mg_dl_per_min,announced:false});
  }
  out.push(...lifeEvents(s,seed,day,offset));
  return out;
}

/** Optional life events, each from its own stream (see knowledge/sources.json for effect sizes). */
function lifeEvents(s,seed,day,offset) {
  const out=[],stream=name=>new Rng(streamSeed(seed,`scenario:${day}:${name}`));
  const timed=(r,cfg)=>localAt(day,cfg.time,offset)+Math.round(r.symmetric(cfg.time_jitter_minutes))*60000;
  const an=s.anaerobic;
  if(an.enabled){const r=stream('anaerobic');if(r.next()<an.probability){const at=timed(r,an);
    // High-intensity/resistance exercise tends to raise glucose (Riddell 2017): catecholamine-driven output.
    out.push({id:`anaerobic:${day}`,type:'exercise',kind:'anaerobic',at,until:at+an.duration_minutes*60000,AC:0,
      hepatic_delta:an.hepatic_delta_mg_dl_per_min,announced:an.announced});
    out.push(...exercisePlan(`anaerobic_plan:${day}`,'anaerobic',at,an));}}
  const al=s.alcohol;
  if(al.enabled){const r=stream('alcohol');if(r.next()<al.probability){const at=timed(r,al),from=at+al.onset_hours*3600000;
    out.push({id:`alcohol:${day}`,type:'alcohol',at,announced:al.announced});
    // Suppressed hepatic glucose output hours later (Turner 2001: next-morning hypoglycaemia).
    out.push({id:`alcohol_effect:${day}`,type:'alcohol_effect',at:from,until:from+al.duration_hours*3600000,hepatic_delta:al.hepatic_delta_mg_dl_per_min});}}
  const ill=s.illness;
  if(ill.enabled){const r=stream('illness');if(r.next()<ill.probability_per_day){
    const at=localAt(day,'08:00',offset),days=ill.min_days+Math.floor(r.next()*(ill.max_days-ill.min_days+1));
    out.push({id:`illness:${day}`,type:'illness',at,until:at+days*86400000,sensitivity_multiplier:1/(1+ill.insulin_need_increase),
      days,announced:ill.announced});}}
  const sl=s.sleep_loss;
  if(sl.enabled){const r=stream('sleep_loss');if(r.next()<sl.probability){const at=localAt(day,'07:00',offset);
    out.push({id:`sleep_loss:${day}`,type:'sleep_loss',at,until:at+16*3600000,sensitivity_multiplier:1-sl.sensitivity_decrease,announced:sl.announced});}}
  return out;
}

/** Advance notice of announced exercise (advance_notice_minutes > 0): a visible plan, no physiological effect. */
function exercisePlan(id,kind,at,cfg) {
  const n=cfg.advance_notice_minutes??0;
  return n>0&&cfg.announced?[{id,type:'exercise_plan',kind,at:at-n*60000,planned_at:at,duration_minutes:cfg.duration_minutes}]:[];
}

function explicitEvent(e,start) {
  const at=start+e.at_minute*60000;
  if(e.type==='meal')return {id:e.id,type:'meal',name:e.id,at,grams:e.grams,absorption_minutes:e.absorption_minutes,announced_grams:e.announced_grams};
  if(e.type==='exercise')return {id:e.id,type:'exercise',at,until:at+e.duration_minutes*60000,AC:e.accelerometer_counts,announced:e.announced,
    ...(e.kind?{kind:e.kind}:{}),...(e.hepatic_delta_mg_dl_per_min!==undefined?{hepatic_delta:e.hepatic_delta_mg_dl_per_min}:{})};
  if(e.type==='illness')return {id:e.id,type:'illness',at,until:at+e.duration_hours*3600000,sensitivity_multiplier:1/(1+e.insulin_need_increase),
    days:Number((e.duration_hours/24).toFixed(2)),announced:e.announced};
  if(e.type==='sleep_loss')return {id:e.id,type:e.type,at,until:at+e.duration_minutes*60000,sensitivity_multiplier:1-e.sensitivity_decrease,announced:e.announced};
  if(['infusion_recovery','sensor_calibration_error','record','patient_treatment'].includes(e.type))return {...e,at};
  if(['sensor_bias','sensor_drift','infusion_deficit'].includes(e.type))return {...e,at,until:at+e.duration_minutes*60000};
  if(e.type==='alcohol')return [{id:e.id,type:'alcohol',at,announced:e.announced},
    {id:`alcohol_effect:${e.id}`,type:'alcohol_effect',at:at+e.onset_hours*3600000,until:at+(e.onset_hours+e.duration_hours)*3600000,hepatic_delta:e.hepatic_delta_mg_dl_per_min}];
  return {id:e.id,type:'stress',at,until:at+e.duration_minutes*60000,hepatic_delta:e.hepatic_delta_mg_dl_per_min,announced:false};
}

function dedupe(events) {
  const seen=new Set();
  return events.filter(e=>{if(seen.has(e.id))throw new Error(`Duplicate event id ${e.id}`);seen.add(e.id);return true;});
}

// --- partial observability (v1.1-hard; scenario.masking, scenario.announcement.report_delay) ------

const MASKED_LIFE={alcohol:'alcohol',illness:'illness',sleep_loss:'sleep_loss'};
const hiddenBy=(seed,kind,id,p)=>p>0&&new Rng(streamSeed(seed,`mask:${kind}:${id}`)).next()<p;
/**
 * Withholds visible notices per scenario.masking (in place). Each decision uses its own stream
 * (seed, kind, event id), so it does not depend on the generation window and shifts no other draw.
 * What was withheld is kept on the event (`masked`, evaluator-only).
 */
export function applyMasking(events,s,seed) {
  const k=s.masking;
  if(!k||!Object.values(k).some(p=>p>0))return events;
  for(const e of events) {
    if(e.type==='meal'&&e.announced_grams!=null) {
      if(hiddenBy(seed,'meal',e.id,k.meal_announcement)) {
        e.masked={announcement:e.announced_grams,...(e.reported_composition?{composition:e.reported_composition}:{})};
        e.announced_grams=null;delete e.reported_composition;
      } else if(e.reported_composition&&hiddenBy(seed,'composition',e.id,k.composition)){e.masked={composition:e.reported_composition};delete e.reported_composition;}
    } else if(e.type==='exercise'&&e.announced&&hiddenBy(seed,'exercise',e.id,k.exercise)){e.announced=false;e.masked={announced:true};}
    else if(e.type==='exercise_plan'&&hiddenBy(seed,'exercise',e.id.replace('_plan:',':'),k.exercise)){e.notice_masked=true;e.masked={plan:true};}
    else if(MASKED_LIFE[e.type]&&e.announced&&hiddenBy(seed,e.type,e.id,k[MASKED_LIFE[e.type]])){e.announced=false;e.masked={announced:true};}
    else if(e.type==='basal_injection'&&hiddenBy(seed,'basal',e.id,k.basal_injection_notice)){e.notice_masked=true;e.masked={notice:true};}
  }
  return events;
}
/**
 * Late meal reports (scenario.announcement.report_delay): an announced meal is reported delay
 * minutes (5-min steps in [min, max]) after eating starts. The meal event loses its announcement
 * (kept as `late_report`) and a `meal_report` event carries it. Returns the report events.
 */
export function lateReports(events,s,seed) {
  const rd=s.announcement.report_delay;if(!(rd?.probability>0))return [];
  const out=[];
  for(const e of events) {
    if(e.type!=='meal'||e.announced_grams==null)continue;
    const r=new Rng(streamSeed(seed,`report-delay:${e.id}`));
    if(r.next()>=rd.probability)continue;
    const d=Math.round((rd.min_minutes+r.next()*(rd.max_minutes-rd.min_minutes))/5)*5;
    if(d<=0)continue;
    out.push({id:`meal_report:${e.id}`,type:'meal_report',meal_id:e.id,name:e.name,at:e.at+d*60000,eaten_at:e.at,grams:e.announced_grams,delay_minutes:d,
      ...(e.reported_composition?{reported_composition:e.reported_composition}:{})});
    e.late_report={delay_minutes:d,grams:e.announced_grams};e.announced_grams=null;delete e.reported_composition;
  }
  return out;
}

/** Causal patient reports only; physical inputs and random draws are never changed. */
export function completeReports(events,s) {
  if(s.announcement.information_mode!=='complete')return events;
  for(const e of events) {
    if(e.type==='meal') {
      // The high-fat proxy adds glucogenic input; do not report that extra input as dietary carbs.
      e.announced_grams=e.composition==='high_fat'?Math.round(e.grams/1.2):e.grams;
      e.reported_exact=true;
      if(e.composition==='high_fat')e.reported_composition=e.composition;
      delete e.masked;delete e.late_report;
    } else if(['exercise','alcohol','illness','sleep_loss','stress'].includes(e.type))e.announced=true;
    else if(e.type==='exercise_plan')delete e.notice_masked;
  }
  return events.filter(e=>e.type!=='meal_report');
}

/** Converts a scheduled event into the notification an agent may see, or null if hidden. */
export function visibleNotice(e,iso) {
  if(e.notice_masked)return null;
  if(e.type==='patient_treatment'&&e.announced)return {type:'patient_treatment',category:'treatment',id:e.id,
    action:e.action,result:e.treatment_result??null,source:'patient_routine',time:iso(e.at)};
  if(e.type==='record')return {type:`${e.category}_record`,category:e.category,id:e.id,text:e.text,time:iso(e.at),source:'scenario_record'};
  if(e.type==='meal_report')return {type:'meal_announced',id:e.meal_id,grams:e.grams,time:iso(e.at),eaten_at:iso(e.eaten_at),
    note:'patient-reported carbs, reported after eating started; may differ from actual intake'};
  if(e.type==='meal'&&e.announced_grams!=null)return {type:'meal_announced',id:e.id,grams:e.announced_grams,time:iso(e.at),
    ...(e.reported_exact?{accuracy:'exact'}:{}),
    note:'patient-reported carbs; may differ from actual intake'};
  if(e.type==='exercise_plan')return {type:'exercise_planned',id:e.id,kind:e.kind,planned_time:iso(e.planned_at),duration_minutes:e.duration_minutes,time:iso(e.at)};
  if(e.type==='exercise'&&e.announced)return {type:'exercise_started',id:e.id,kind:e.kind??'aerobic',duration_minutes:(e.until-e.at)/60000,time:iso(e.at)};
  if(e.type==='alcohol'&&e.announced)return {type:'alcohol_reported',id:e.id,time:iso(e.at)};
  if(e.type==='illness'&&e.announced)return {type:'illness_reported',id:e.id,expected_days:e.days,time:iso(e.at)};
  if(e.type==='sleep_loss'&&e.announced)return {type:'poor_sleep_reported',id:e.id,time:iso(e.at)};
  if(e.type==='stress'&&e.announced)return {type:'stress_reported',id:e.id,time:iso(e.at),note:'person reports acute psychological stress'};
  if(e.type==='basal_injection')return {type:'basal_injection_taken',id:e.id,units:e.units,insulin:e.insulin,time:iso(e.at),
    note:'patient routine long-acting injection'};
  return null;   // hidden: unannounced meals, stress, alcohol effect, infusion-set occlusion onset
}
