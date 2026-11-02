// Classical care baselines (docs/BASELINES.zh-CN.md). Observation-only policies that represent
// today's real-world care, used to show where an agent adds value:
//
//   B1 standard   "按医嘱" standard open-loop therapy: fixed basal (pump schedule or the routine
//                 long-acting injection), a bolus calculator (ICR / ISF / target, IOB-aware) for
//                 announced meals, corrections at fixed checks, the 15-15 hypo rule, and the
//                 device's own prompts (occlusion alarm -> new infusion set; calibration required).
//                 No adaptation and no use of free-text events beyond meal announcements.
//   B2 guideline  "指南规则" B1 plus published clinical rules for the events visible in the
//                 observations (exercise, illness, sleep loss, alcohol, high-fat meals, CGM
//                 warm-up / gaps, missed or off-schedule long-acting doses, a pump left suspended,
//                 suspected infusion-site failure, CGM trend arrows).
//
// The closed-loop baselines (B3 hcl.mjs, B4 oref1.mjs) reuse this engine as their user layer:
// makeCarePolicy({level:'guideline', loop}) runs the algorithm `loop` whenever it is active
// (pump + live CGM) and keeps the person's tasks (meal boluses, hypo treatment, device hygiene,
// sensor fallback); manual corrections and manual temp basals are left to the algorithm then.
//
// What the policies may read: only the observation handed to them (and their own memory). They
// never see the person's parameters, the scenario, the seed or future events (see the no-leakage
// test in test/baselines.test.mjs).
//
// Assisted track (obs.profile.self_care === 'assisted'): the person boluses announced meals with
// their own calculator (possibly late, rarely forgotten) and treats the lows they see. Consistent
// with the causal decider (src/oracle/causal.mjs): while a person's meal bolus is still expected
// the baseline gives no bolus (it would double the dose or make the pump reject the person's bolus
// by the minimum bolus interval) and no temp basal above the schedule; a meal is dosed by the
// baseline only once the person evidently missed it (no patient_bolus within 20 min); the
// baseline does not treat lows < 70 itself (the person does), and B2's predictive carbs remain.
//
// Rule sources (numbers marked 待核实 are reasonable values from the cited documents or common
// clinical practice that have not been checked line by line against the source):
//   [ADA]    American Diabetes Association, Standards of Care in Diabetes-2024, sections 6
//            (glycemic goals and hypoglycemia: 15-15 rule), 7 (technology), 9 (pharmacologic
//            therapy), 14 (children).
//   [ISPAD]  ISPAD Clinical Practice Consensus Guidelines 2022: ch. 9 (insulin treatment),
//            ch. 13 (sick-day management), ch. 14 (exercise), ch. 10 (nutrition: fat/protein).
//   [R17]    Riddell MC et al. Exercise management in type 1 diabetes: a consensus statement.
//            Lancet Diabetes Endocrinol 2017;5:377-390.
//   [ES17]   Aleppo G et al. / Laffel LM et al. Endocrine Society / JDRF trend-arrow guidance
//            (J Endocr Soc 2017;1:1445; 2020;4:bvz015).
//   [D10]    Donga E et al. A single night of partial sleep deprivation induces insulin
//            resistance in T1D. Diabetes Care 2010;33:1573-1577.
//   [LAB]    Product labels: Tresiba (degludec) missed dose: take when remembered, >= 8 h
//            between doses; Lantus/Toujeo (glargine): do not take two doses to catch up.

const MIN=60000,HOUR=3600000;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));

// --- shared helpers (also used by hcl.mjs and oref1.mjs) ------------------------------------

export const BOLUS_INTERVAL_MINUTES=15;   // device minimum bolus interval (public safety default)
export const FRESH_DOSE_MINUTES=15;       // a reading older than this is not used for dosing
export const RESCUE_SETTLE_MINUTES=20;    // after the policy's own rescue carbs a reading is still rising: no meal bolus on it

/** Minute of the local day and local date from obs.local_time ("YYYY-MM-DD HH:MM"). */
export function localClock(obs) {
  const [d,t]=String(obs.local_time).split(' ');
  return {day:d,minute:Number(t.slice(0,2))*60+Number(t.slice(3,5))};
}
/** Fresh glucose {value, age, source} (any sensor), or null. */
export function freshGlucose(obs,maxAge=FRESH_DOSE_MINUTES) {
  const g=obs.glucose;
  return g&&finite(g.value_mg_dl)&&finite(g.age_minutes)&&g.age_minutes<=maxAge?{value:g.value_mg_dl,age:g.age_minutes,source:g.source}:null;
}
/** Whether a real-time CGM is delivering readings now. */
export function cgmLive(obs,maxAge=10) {
  const c=obs.cgm;
  return !!c&&c.status==='ok'&&finite(c.value_mg_dl)&&finite(c.age_minutes)&&c.age_minutes<=maxAge;
}
/** CGM trend in mg/dL/min (device trend, else a least-squares slope over the last 20 min), or null. */
export function cgmTrend(obs) {
  if(!cgmLive(obs))return null;
  if(finite(obs.cgm.trend_mg_dl_per_min))return obs.cgm.trend_mg_dl_per_min;
  return smoothedTrend(obs,20);
}
/** Least-squares CGM slope (mg/dL/min) over the last `minutes` of history (>= 4 points), or null. */
export function smoothedTrend(obs,minutes=25) {
  if(!cgmLive(obs))return null;
  const now=Date.parse(obs.virtual_time);
  const pts=(obs.cgm_history??[]).map(r=>({t:(Date.parse(r.time)-now)/MIN,v:r.value_mg_dl})).filter(p=>p.t>=-minutes-1&&finite(p.v));
  if(pts.length<3)return null;
  const mt=pts.reduce((s,p)=>s+p.t,0)/pts.length,mv=pts.reduce((s,p)=>s+p.v,0)/pts.length;
  const den=pts.reduce((s,p)=>s+(p.t-mt)**2,0);
  return den>0?pts.reduce((s,p)=>s+(p.t-mt)*(p.v-mv),0)/den:null;
}
/** Bolus units on the device grid: pumps round down (like the device), pens to the nearest step. */
export function quantBolus(obs,u) {
  const spec=obs.action_specs?.BOLUS?.units;if(!spec||!finite(u)||u<=0)return 0;
  const step=spec.step||0.05,mdi=obs.device?.type==='mdi';
  let v=(mdi?Math.round(u/step):Math.floor(u/step+1e-9))*step;
  v=Math.min(spec.max,v);
  return v>(spec.min??0)+1e-9?Number(v.toFixed(3)):0;
}
export const minutesSince=(obs,iso)=>iso?(Date.parse(obs.virtual_time)-Date.parse(iso))/MIN:Infinity;
/** Whether the device would accept a bolus now (interval, running pump, not low, nothing in progress). */
export function canBolus(obs) {
  const d=obs.device,s=obs.action_specs;
  if(!s?.BOLUS)return false;
  if(d.type==='pump'&&(d.stop_reason||d.suspended||d.bolus_in_progress))return false;
  if(minutesSince(obs,d.last_bolus?.time)<BOLUS_INTERVAL_MINUTES)return false;
  const g=freshGlucose(obs,30);
  return !(g&&g.value<70);
}
/**
 * TEMP_BASAL action for a rate in U/h on the device's own grid: percent-native pumps (Dana, Combo)
 * get a percent of the scheduled rate, absolute pumps a rate; the duration is rounded to the step.
 */
export function tempBasalAction(obs,rateUph,minutes=30) {
  const t=obs.action_specs?.TEMP_BASAL;if(!t)return null;
  const dstep=t.duration_minutes.step??1;
  const d=clamp(Math.max(dstep,Math.round(minutes/dstep)*dstep),t.duration_minutes.min,t.duration_minutes.max);
  const base=obs.device.scheduled_basal_u_h??obs.profile.basal_u_h??0;
  if(t.percent?.step) {
    const p=base>0?clamp(Math.round(rateUph/base*100/t.percent.step)*t.percent.step,t.percent.min,t.percent.max):100;
    return {type:'TEMP_BASAL',percent:p,duration_minutes:d};
  }
  const st=t.rate_u_h.step||0.05;
  return {type:'TEMP_BASAL',rate_u_h:Number(clamp(Math.round(rateUph/st)*st,t.rate_u_h.min,t.rate_u_h.max).toFixed(3)),duration_minutes:d};
}
/** Effective rate (U/h) a TEMP_BASAL action would run at. */
export function tempRateOf(obs,a) {
  const base=obs.device.scheduled_basal_u_h??0;
  return a.percent!=null?base*a.percent/100:a.rate_u_h;
}
/** Whether the running basal already matches `rate` closely enough (and lasts >= minLeft minutes). */
export function basalMatches(obs,rate,{minLeft=10,tol=0.06}={}) {
  const d=obs.device,base=d.scheduled_basal_u_h??0,cur=d.current_basal_u_h??base;
  const tolU=Math.max(tol,0.08*base);
  if(Math.abs(rate-base)<=tolU&&!d.temp_basal)return true;
  if(!d.temp_basal)return false;
  return Math.abs(cur-rate)<=tolU&&d.temp_basal.remaining_minutes>=minLeft;
}

const say=(action,rationale)=>({action,rationale});
const WAIT=r=>say({type:'WAIT'},r);

// --- the engine -----------------------------------------------------------------------------

/**
 * Stateful care policy obs -> {action, rationale}.
 * options: level 'standard' (B1) | 'guideline' (B2); loop: optional closed-loop algorithm
 * {name, active(obs, care) -> bool, decide(obs, care) -> {action, rationale} | null}.
 */
export function makeCarePolicy({level='standard',loop=null}={}) {
  const G=level==='guideline';
  const tag=loop?loop.name:G?'B2':'B1';
  const st={
    meals:[],            // meals the policy must dose: {id, grams, at, fallback}
    personPending:[],    // assisted: announced meals awaiting the person's bolus {id, grams, at}
    highFat:new Set(),   // meal ids reported as high fat / protein
    split:[],            // delayed second parts (high-fat split, rest above the max bolus) {at, units, extended, why}
    lastRescueAt:-Infinity,lastRescueReadingAt:-Infinity,rescueRecheckAt:null,lastMeasureAt:-Infinity,lastPredictiveAt:-Infinity,
    checksDone:new Set(),lastCorrection:null,lastMealAt:-Infinity,lastSiteChangeAt:-Infinity,siteChangedAt:null,
    exercise:[],         // {kind, start, end, preCarbsDone, postCorrDone, measured:Set}
    illness:false,sleepLossUntil:-Infinity,alcoholAt:null,
    laMissHandled:false,cautionUntil:-Infinity,
    measureDue:[],       // times at which B2 wants a reading on sparse sensors
    lastStepAt:null,
  };
  const care={st,level,G,get personPending(){return st.personPending.length>0;},exerciseMode:obs=>exerciseWindow(obs)};

  function exerciseWindow(obs,{before=60,after=60}={}) {
    const now=Date.parse(obs.virtual_time);
    return st.exercise.find(e=>e.kind==='aerobic'&&now>=e.start-before*MIN&&now<=e.end+after*MIN)??null;
  }

  function ingest(obs) {
    const now=Date.parse(obs.virtual_time),assisted=obs.profile?.self_care==='assisted';
    for(const e of obs.events??[]) {
      const at=Date.parse(e.time??obs.virtual_time);
      switch(e.type) {
        case 'meal_composition_reported':if(e.composition==='high_fat'&&e.id)st.highFat.add(e.id);break;
        case 'meal_announced':
          st.lastCorrection=null;st.lastMealAt=at;     // a meal explains a later high: no site-failure anchor
          if(!(e.grams>0))break;
          if(assisted)st.personPending.push({id:e.id,grams:e.grams,at});
          else st.meals.push({id:e.id,grams:e.grams,at,fallback:false});
          break;
        case 'patient_bolus':{
          if(!st.personPending.length)break;
          const i=st.personPending.findIndex(s=>s.grams===e.grams);st.personPending.splice(i<0?0:i,1);break;}
        // Free-text / life events: only the guideline user acts on them.
        case 'exercise_planned':{
          const start=Date.parse(e.planned_time),end=start+(e.duration_minutes??60)*MIN;
          if(!st.exercise.some(x=>Math.abs(x.start-start)<30*MIN))st.exercise.push({kind:e.kind??'aerobic',start,end,measured:new Set()});
          break;}
        case 'exercise_started':{
          const end=at+(e.duration_minutes??60)*MIN,x=st.exercise.find(x=>Math.abs(x.start-at)<90*MIN);
          if(x){x.start=at;x.end=end;}else st.exercise.push({kind:e.kind??'aerobic',start:at,end,measured:new Set()});
          break;}
        case 'illness_reported':st.illness=true;break;
        case 'poor_sleep_reported':st.sleepLossUntil=at+16*HOUR;break;
        case 'alcohol_reported':st.alcoholAt=at;break;
      }
    }
    if(assisted) {
      // The person's window (max delay 15 min in the documented self-care defaults) is over
      // without a patient_bolus: forgotten (or rejected); the meal is now the baseline's.
      for(const s of [...st.personPending])if(now-s.at>=20*MIN) {
        st.personPending.splice(st.personPending.indexOf(s),1);
        st.meals.push({...s,fallback:true});
      }
    }
    st.meals=st.meals.filter(m=>now-m.at<=90*MIN);    // a meal not dosed within 90 min is left to corrections
  }

  // Dose multipliers from the guideline rules (B2 only).
  function mealFactor(obs,meal) {
    if(!G)return {f:1,why:[]};
    const now=Date.parse(obs.virtual_time),why=[];let f=1;
    const ex=st.exercise.find(e=>e.kind==='aerobic'&&e.start-now<=120*MIN&&e.start-now>=-(e.end-e.start));
    if(ex){f*=0.5;why.push('exercise within 2 h: -50% [R17]');}
    const post=st.exercise.find(e=>e.kind==='aerobic'&&now>e.end&&now-e.end<=120*MIN);
    if(post){f*=0.5;why.push('within 2 h after exercise: -50% [R17]');}
    if(st.illness){f*=1.2;why.push('sick day +20% [ISPAD ch13, 待核实]');}
    if(now<st.sleepLossUntil){f*=1.1;why.push('sleep loss +10% [D10, 待核实]');}
    const {minute}=localClock(obs);
    if(st.alcoholAt&&now-st.alcoholAt<=16*HOUR&&minute>=300&&minute<=660){f*=0.8;why.push('morning after alcohol -20% [ADA/ISPAD, 待核实]');}
    if(now<st.cautionUntil){f*=0.8;why.push('off-schedule long-acting dose: -20% [待核实]');}
    return {f,why};
  }

  /** Bolus calculator: carbs/CR*f + correction to target minus bolus IOB (Bolus-Wizard style). */
  function calculator(obs,grams,{factor=1,g}) {
    const p=obs.profile,iob=Math.max(0,obs.iob?.bolus_u??obs.iob?.total_u??0);
    const carbs=grams/p.carb_ratio_g_per_u*factor;
    let corr=0,bg=null;
    if(g) {
      bg=g.value;
      const tr=G?cgmTrend(obs):null;
      if(tr!=null)bg+=clamp(tr,-3,3)*30;               // B2: trend-arrow adjustment [ES17, 待核实]
      const c=(bg-p.target_mg_dl)/p.isf_mg_dl_per_u;
      corr=c>0?Math.max(0,c-iob):c;                     // IOB offsets corrections only; a low BG trims the meal dose
    }
    return {units:Math.max(0,carbs+corr),carbs,corr,iob,bg};
  }

  function measureAction(obs,now,why) {
    const s=obs.action_specs;
    if(now-st.lastMeasureAt<10*MIN)return null;
    if(s.SCAN){st.lastMeasureAt=now;return say({type:'SCAN'},`${tag}: scan (${why})`);}
    if(s.MEASURE_BG){st.lastMeasureAt=now;return say({type:'MEASURE_BG'},`${tag}: fingerstick (${why})`);}
    return null;
  }
  const canMeasure=obs=>!!(obs.action_specs.SCAN||obs.action_specs.MEASURE_BG);

  function rescueGrams(obs) {
    if(!G)return 15;                                    // 15-15 rule [ADA]
    // B2: ~ the carbs that raise glucose by ~50 mg/dL for this person (CR/ISF), 10-20 g
    // (ISPAD: 0.3 g/kg in children; weight is not observed) [ISPAD ch11, 待核实].
    const p=obs.profile,g=Math.round(50*p.carb_ratio_g_per_u/p.isf_mg_dl_per_u/5)*5;
    return clamp(g,10,20);
  }

  return Object.assign(obs=>{
    const now=Date.parse(obs.virtual_time),dev=obs.device,specs=obs.action_specs,p=obs.profile;
    const pump=dev.type==='pump',assisted=p.self_care==='assisted',{day,minute}=localClock(obs);
    ingest(obs);
    const g=freshGlucose(obs),live=cgmLive(obs),trend=cgmTrend(obs);
    const loopOn=!!loop&&pump&&loop.active(obs,care);
    st.lastStepAt=now;

    // 1. Device hygiene: explicit device prompts (B1) and guideline checks (B2).
    if(pump&&dev.stop_reason==='occlusion_alarm'&&specs.CHANGE_INFUSION_SET) {
      st.lastSiteChangeAt=now;st.siteChangedAt=now;return say({type:'CHANGE_INFUSION_SET'},`${tag}: occlusion alarm -> new infusion set (pump manual)`);
    }
    const cal=obs.cgm?.calibration;
    if(specs.CALIBRATE_CGM&&cal&&!obs.cgm.warming_up_until&&now-st.lastMeasureAt>10*MIN&&
      (cal.required_now||G&&cal.due_at&&Date.parse(cal.due_at)-now<=15*MIN)) {
      st.lastMeasureAt=now;return say({type:'CALIBRATE_CGM'},`${tag}: CGM calibration ${cal.required_now?'required':'due'} (sensor manual)`);
    }
    if(G&&pump&&dev.suspended&&dev.stop_reason==='user_suspended'&&specs.RESUME_PUMP&&!(g&&g.value<80))
      return say({type:'RESUME_PUMP'},`${tag}: pump left suspended and glucose not low -> resume (pump manual)`);
    if(G&&pump&&specs.CHANGE_INFUSION_SET&&!dev.stop_reason&&g&&g.value>250&&st.lastCorrection&&now-st.lastSiteChangeAt>6*HOUR&&now-st.lastMealAt>=3*HOUR) {
      const c=st.lastCorrection,age=(now-c.at)/MIN;
      if(age>=90&&age<=240&&g.value>=c.bg-30) {
        st.lastSiteChangeAt=now;st.siteChangedAt=now;
        return say({type:'CHANGE_INFUSION_SET'},`${tag}: glucose ${Math.round(g.value)} did not respond to the correction ${Math.round(age)} min ago -> suspect infusion site, change set [ADA sec7 / pump education, 待核实]`);
      }
    }

    // 2. Hypoglycaemia. Full track: 15-15 rule (B1) / scaled carbs (B2); assisted: the person does it.
    // A reading is acted on once: a sparse reading stays "fresh" for 15 min, but the 15-15 rule
    // treats again only after a new (recheck) reading.
    const readingAt=obs.glucose?Date.parse(obs.glucose.time):null;
    if(!assisted&&g&&g.value<70&&now-st.lastRescueAt>=15*MIN&&readingAt>st.lastRescueReadingAt&&specs.INGEST_CARBS) {
      st.lastRescueAt=now;st.lastRescueReadingAt=readingAt;st.rescueRecheckAt=live?null:now+15*MIN;st.lastCorrection=null;
      const gr=rescueGrams(obs);
      return say({type:'INGEST_CARBS',grams:gr},`${tag}: glucose ${Math.round(g.value)} < 70 -> ${gr} g fast carbs, recheck in 15 min [ADA 15-15]`);
    }
    if(G&&live&&g&&trend!=null&&g.value<90&&trend<=-1.5&&now-st.lastPredictiveAt>=20*MIN&&now-st.lastRescueAt>=15*MIN&&specs.INGEST_CARBS) {
      st.lastPredictiveAt=now;st.lastRescueAt=now;
      return say({type:'INGEST_CARBS',grams:10},`${tag}: ${Math.round(g.value)} mg/dL falling ${trend.toFixed(1)} mg/dL/min -> 10 g [ES17 trend arrows, 待核实]`);
    }
    if(st.rescueRecheckAt&&now>=st.rescueRecheckAt) {
      st.rescueRecheckAt=null;
      const m=canMeasure(obs)&&!(g&&g.age<=5)?measureAction(obs,now,'15-15 recheck'):null;if(m)return m;
    }

    // 3. B2: long-acting dose problems (pens). The routine injection itself is the person's routine.
    if(G&&dev.type==='mdi'&&p.basal_injection&&specs.BASAL_INJECTION&&!st.laMissHandled) {
      st.laMissHandled=true;
      const last=dev.last_basal_injection,age=last?minutesSince(obs,last.time)/60:Infinity;
      const times=(p.basal_injection.times??[]).map(h=>Number(h.slice(0,2))*60+Number(h.slice(3)));
      const toNext=times.length?Math.min(...times.map(t=>((t-minute)+1440)%1440||1440))/60:24;
      const perDay=Math.max(1,times.length),interval=24/perDay;
      if(age>interval+1) {                              // the routine dose is over an hour overdue: missed
        const deg=/degludec/.test(dev.basal_insulin??'');
        const frac=deg?(toNext>=8?1:0):(toNext>=12?1:toNext>=8?0.5:0);
        const step=specs.BASAL_INJECTION.units.step||1,u=Math.round(p.basal_injection.units*frac/step)*step;
        if(u>0)return say({type:'BASAL_INJECTION',units:u},`${tag}: last long-acting dose ${age.toFixed(0)} h ago (missed); next routine dose in ${toNext.toFixed(1)} h -> make up ${u} U [LAB, 待核实]`);
      } else if(last) {
        const lm=localClock({local_time:offsetLocal(obs,last.time)}).minute;
        const off=Math.min(...times.map(t=>Math.min(Math.abs(t-lm),1440-Math.abs(t-lm))));
        if(off>=30&&age<12)st.cautionUntil=Date.parse(last.time)+24*HOUR;   // dose at an unusual time: maybe twice
      }
    }

    // 4. Meal boluses (full track: every announced meal; assisted: meals the person missed).
    if(st.meals.length&&specs.BOLUS&&!st.personPending.length) {
      const meal=st.meals[0];
      // B1 too: a bolus attempt on a user-suspended pump shows "suspended"; the person resumes it.
      if(pump&&dev.suspended&&dev.stop_reason==='user_suspended'&&specs.RESUME_PUMP&&!(g&&g.value<70))
        return say({type:'RESUME_PUMP'},`${tag}: meal bolus needed but the pump is suspended -> resume`);
      if(!g&&canMeasure(obs)&&now-st.lastMeasureAt>=10*MIN){const m=measureAction(obs,now,'before the meal bolus');if(m)return m;}
      // The policy's own rescue carbs are still raising this reading and are not part of the meal,
      // so dosing on it stacks a meal bolus onto a low that is still being treated. The meal keeps
      // its place in st.meals meanwhile (it expires after 90 min like any other) and the step falls
      // through to the loop and the other rules rather than returning.
      // (A guideline "pre-meal glucose below 90 -> bolus after the meal has started" rule was tried
      // here too and dropped: over the 200 v1 environments it cost B2 0.013 and B3 0.010 of mean S
      // through the resulting highs and removed none of the severe-hypoglycaemia vetoes.)
      const rescueSettling=now-st.lastRescueAt<RESCUE_SETTLE_MINUTES*MIN;
      if(!rescueSettling&&canBolus(obs)) {
        const {f,why}=mealFactor(obs,meal),fat=G&&st.highFat.has(meal.id);
        const fatF=fat?1.2:1;                            // fat/protein: +20% spread over 3 h [ISPAD ch10, 待核实]
        const c=calculator(obs,meal.grams,{factor:f*fatF,g});
        let now1=c.units,later=0;
        if(fat){later=c.carbs*0.4;now1=Math.max(0,c.units-later);}
        const u=quantBolus(obs,now1);
        st.meals.shift();
        if(fat&&later>0) {
          if(specs.EXTENDED_BOLUS&&pump)st.split.push({at:now+BOLUS_INTERVAL_MINUTES*MIN,units:later,extended:true,why:'high-fat: 40% extended over 3 h'});
          else st.split.push({at:now+90*MIN,units:later,extended:false,why:'high-fat: 40% second injection at +90 min'});
        }
        // A calculated dose above the device's maximum single bolus is given in two parts (the
        // pump offers the maximum; the person gives the rest after the bolus interval).
        const max=specs.BOLUS.units.max;
        if(now1>max+1e-9)st.split.push({at:now+BOLUS_INTERVAL_MINUTES*MIN,units:now1-max,extended:false,why:'rest of the calculated dose above the maximum single bolus'});
        st.split.sort((a,b)=>a.at-b.at);
        if(u>0) {
          return say({type:'BOLUS',units:u},`${tag}: ${meal.fallback?'person missed the meal bolus; ':''}calculator ${meal.grams} g / CR ${p.carb_ratio_g_per_u}`+
            ` = ${c.carbs.toFixed(2)} U, correction ${c.corr.toFixed(2)} U (BG ${c.bg==null?'n/a':Math.round(c.bg)}, IOB ${c.iob.toFixed(2)})${why.length?'; '+why.join('; '):''}${fat?'; high-fat split':''}`);
        }
      } else if(g&&g.value<70) {
        // Bolus blocked by a low: the rescue above handles it; keep the meal for the next step.
      }
    }
    // Pending second parts (high-fat split, rest above the maximum single bolus).
    if(st.split.length&&st.split[0].at<=now&&!st.personPending.length) {
      const s=st.split[0];
      if(s.extended&&specs.EXTENDED_BOLUS&&!dev.extended_bolus&&!dev.stop_reason) {
        const e=specs.EXTENDED_BOLUS,step=e.units.step||0.05,u=Math.min(e.units.max,Math.floor(s.units/step+1e-9)*step);
        const d=Math.min(e.duration_minutes.max,Math.round(180/(e.duration_minutes.step??30))*(e.duration_minutes.step??30));
        st.split.shift();
        if(u>e.units.min)return say({type:'EXTENDED_BOLUS',units:Number(u.toFixed(3)),duration_minutes:d},`${tag}: ${s.why} [ISPAD ch10, 待核实]`);
      } else if(canBolus(obs)) {
        // The rest is due a bolus interval after the first part, so the reading that guarded the
        // first part is by then older than FRESH_DOSE_MINUTES: take a new one first (as before the
        // meal bolus) and dose only on a reading that is both fresh and >= 100 mg/dL. Without a
        // reading the rest is dropped: 5-15 U are already acting and the person cannot see where
        // they are going (on a real-time CGM nothing changes, `g` is always fresh there).
        if(!g&&canMeasure(obs)) {
          const m=measureAction(obs,now,'before the rest of the dose');if(m)return m;
        }
        st.split.shift();
        if(g&&g.value>=100) {
          const u=quantBolus(obs,s.units);
          if(u>0)return say({type:'BOLUS',units:u},`${tag}: ${s.why}`);
        }
      } else if(now-s.at>60*MIN)st.split.shift();
    }

    // 5. B2 exercise handling around a planned aerobic session [R17].
    if(G) {
      for(const ex of st.exercise) {
        if(ex.kind==='aerobic'&&!ex.preCarbsDone&&now>=ex.start-15*MIN&&now<=ex.start+15*MIN) {
          if(!g&&canMeasure(obs)){const m=measureAction(obs,now,'before exercise');if(m)return m;}
          ex.preCarbsDone=true;
          if(g&&specs.INGEST_CARBS&&!assisted||g&&specs.INGEST_CARBS&&assisted&&g.value>=70) {
            const gr=g.value<90?15:g.value<125?10:0;
            if(gr)return say({type:'INGEST_CARBS',grams:gr},`${tag}: pre-exercise glucose ${Math.round(g.value)} -> ${gr} g [R17: <90 10-20 g; 90-124 10 g]`);
          }
        }
        if(ex.kind==='aerobic'&&!live&&canMeasure(obs)&&now>=ex.start+30*MIN&&now<=ex.end+90*MIN&&!ex.measured.has('during')) {
          ex.measured.add('during');const m=measureAction(obs,now,'during/after exercise');if(m)return m;
        }
        if(ex.kind==='anaerobic'&&!ex.postCorrDone&&now>=ex.end+30*MIN&&now<=ex.end+120*MIN&&!loopOn) {
          if(!g&&canMeasure(obs)&&!ex.measured.has('post')){ex.measured.add('post');const m=measureAction(obs,now,'after high-intensity exercise');if(m)return m;}
          if(g&&g.value>200&&canBolus(obs)&&!st.personPending.length) {
            ex.postCorrDone=true;
            const c=calculator(obs,0,{g}),u=quantBolus(obs,c.units*0.5);
            if(u>0){return say({type:'BOLUS',units:u},`${tag}: post-anaerobic rise ${Math.round(g.value)} -> 50% correction [R17]`);}
          }
        }
      }
    }

    // 6. The closed-loop algorithm (B3/B4), when active.
    if(loopOn) {
      const d=loop.decide(obs,care);
      if(d)return d;
    }

    // 7. Corrections at fixed checks (B1), plus B2's anytime-high rule and sick-day frequency.
    if(!loopOn&&specs.BOLUS&&!st.personPending.length) {
      const routineReading=(obs.events??[]).some(e=>(e.type==='fingerstick'||e.type==='flash_scan')&&e.source==='patient_routine');
      const slot=[600,900,1320].find(s=>minute>=s&&minute<s+30&&!st.checksDone.has(`${day}:${s}`));
      const continuous=!!obs.cgm&&!obs.cgm.calibration?.required_now;
      let check=null;
      if(slot!=null&&(continuous||live)){st.checksDone.add(`${day}:${slot}`);check=slot===1320?'bedtime':'check';}
      else if(routineReading)check=minute>=1260?'bedtime':'check';
      const sinceBolus=minutesSince(obs,dev.last_bolus?.time);
      const afterSite=st.siteChangedAt&&now-st.siteChangedAt<=60*MIN;
      if(G&&!check&&g&&(g.value>250&&sinceBolus>=150||st.illness&&g.value>180&&sinceBolus>=120||afterSite&&g.value>250))check='high';
      if(check&&g&&canBolus(obs)&&(sinceBolus>=120||afterSite)) {
        const aerobicRecent=G&&st.exercise.some(e=>e.kind==='aerobic'&&now>e.start&&now-e.end<=6*HOUR);
        const alcohol=G&&st.alcoholAt&&now-st.alcoholAt<=12*HOUR;
        const caution=G&&now<st.cautionUntil;
        let thr=check==='bedtime'?200:180,f=1;const why=[];
        if(G&&(aerobicRecent||alcohol||caution)){thr=250;f=0.5;why.push(aerobicRecent?'after exercise: conservative [R17]':alcohol?'alcohol: conservative [ADA/ISPAD, 待核实]':'possible extra long-acting dose: conservative [待核实]');}
        if(G&&st.illness){f*=1.2;why.push('sick day +20% [ISPAD ch13, 待核实]');}
        if(G&&now<st.sleepLossUntil){thr=Math.min(thr,170);f*=1.1;why.push('sleep loss [D10, 待核实]');}
        if(g.value>thr) {
          const c=calculator(obs,0,{g}),u=quantBolus(obs,c.units*f);
          if(u>0) {
            if(g.value>=200)st.lastCorrection={at:now,bg:g.value};   // anchor for the site-failure check
            if(G&&!live)st.measureDue.push(now+120*MIN);
            if(afterSite)st.siteChangedAt=null;
            return say({type:'BOLUS',units:u},`${tag}: ${check} correction BG ${Math.round(g.value)} > ${thr}: (${Math.round(c.bg)}-${p.target_mg_dl})/${p.isf_mg_dl_per_u} - IOB ${c.iob.toFixed(2)}${why.length?'; '+why.join('; '):''}`);
          }
        }
      }
    }

    // 8. B2 temp basals on pumps without a loop: exercise, overnight after exercise or alcohol, sick days.
    if(G&&pump&&!loopOn&&specs.TEMP_BASAL&&!dev.stop_reason) {
      let f=1;const why=[];
      const ex=st.exercise.find(e=>e.kind==='aerobic'&&now>=e.start-90*MIN&&now<=e.end);
      if(ex){f*=0.5;why.push('aerobic exercise: basal -50% from the notice to the end [R17]');}
      const night=minute>=1320||minute<360;
      if(night&&st.exercise.some(e=>e.kind==='aerobic'&&now>e.end&&now-e.end<=12*HOUR)){f*=0.8;why.push('night after exercise: -20% [R17]');}
      if(st.alcoholAt&&now-st.alcoholAt<=14*HOUR&&(night||minute<600)&&now>=st.alcoholAt){f*=0.8;why.push('night after alcohol: -20% [ADA/ISPAD, 待核实]');}
      if(st.illness&&g&&g.value>140){f*=1.2;why.push('sick day, glucose > 140: +20% [ISPAD ch13, 待核实]');}
      if(g&&g.value<80)f=Math.min(f,0.5);
      const base=dev.scheduled_basal_u_h??p.basal_u_h??0;
      if(Math.abs(f-1)>0.05&&base>0) {
        const rate=base*f;
        if(!basalMatches(obs,rate)){const a=tempBasalAction(obs,rate,60);if(a)return say(a,`${tag}: temp basal ${Math.round(f*100)}%: ${why.join('; ')}`);}
      }
    }

    // 9. B2 readings on sparse sensors: CGM warm-up / gaps, after corrections, nights after alcohol
    //    or exercise, and while an off-schedule long-acting dose is acting [ADA sec7; ISPAD].
    if(G&&canMeasure(obs)&&!live) {
      const last=Math.max(st.lastMeasureAt,obs.meter?.last_reading?Date.parse(obs.meter.last_reading.time):-Infinity,
        obs.flash?.last_scan?Date.parse(obs.flash.last_scan.at):-Infinity);
      const sinceRead=(now-last)/MIN;
      const gap=!!obs.cgm&&!live;
      const due=st.measureDue.findIndex(t=>t<=now);
      const riskyNight=(minute>=150&&minute<=210)&&(st.alcoholAt&&now-st.alcoholAt<=12*HOUR||st.exercise.some(e=>e.kind==='aerobic'&&now>e.end&&now-e.end<=12*HOUR));
      const caution=now<st.cautionUntil&&sinceRead>=180;
      if(due>=0){st.measureDue.splice(due,1);const m=measureAction(obs,now,'2 h after a high correction');if(m)return m;}
      if(gap&&sinceRead>=120&&!(minute<360&&sinceRead<240)){const m=measureAction(obs,now,`CGM ${obs.cgm.status}: fingerstick fallback`);if(m)return m;}
      if(riskyNight&&sinceRead>=120){const m=measureAction(obs,now,'overnight check after alcohol/exercise');if(m)return m;}
      if(caution){const m=measureAction(obs,now,'extra checks after an off-schedule long-acting dose');if(m)return m;}
    }
    // B2 bedtime snack after exercise or alcohol [R17; ADA/ISPAD, 待核实].
    if(G&&minute>=1290&&minute<1350&&!st.checksDone.has(`${day}:snack`)&&specs.INGEST_CARBS) {
      const ex=st.exercise.some(e=>e.kind==='aerobic'&&now>e.end&&now-e.end<=8*HOUR),alc=st.alcoholAt&&now-st.alcoholAt<=6*HOUR&&now>=st.alcoholAt;
      if(ex||alc) {
        if(!g&&canMeasure(obs)){const m=measureAction(obs,now,'bedtime check');if(m)return m;}
        st.checksDone.add(`${day}:snack`);
        if(g&&g.value<(alc?140:126))return say({type:'INGEST_CARBS',grams:20,absorption_minutes:120},`${tag}: bedtime ${Math.round(g.value)} after ${alc?'alcohol':'exercise'} -> 20 g slow carbs`);
      }
    }
    return WAIT(`${tag}: nothing to do`);
  },{care});
}

/** Local "YYYY-MM-DD HH:MM" of an ISO time, using the observation's own UTC offset. */
function offsetLocal(obs,iso) {
  const [d,t]=String(obs.local_time).split(' ');
  const localNow=Date.parse(`${d}T${t}:00Z`),off=localNow-Date.parse(obs.virtual_time);
  const x=new Date(Date.parse(iso)+off).toISOString();
  return `${x.slice(0,10)} ${x.slice(11,16)}`;
}

/** B1: standard open-loop therapy. */
export const standardCarePolicy=()=>makeCarePolicy({level:'standard'});
/** B2: guideline rule-based expert. */
export const guidelinePolicy=()=>makeCarePolicy({level:'guideline'});
