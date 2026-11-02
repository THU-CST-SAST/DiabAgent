// Belief of the causal decider (因果最优决策): a particle filter over everything an agent cannot
// see, driven only by what it can see.
//
// Inputs, and nothing else:
//   - the public description of the instance (publicDescription(spec)): devices, insulins,
//     sensors, programmed settings, person type and variants, enabled event packs, routines;
//     never the seed, the sampled person parameters, hidden events or true glucose;
//   - the observation stream (SimEnv observations, one per step), remembered by the agent.
// Priors come from the public type library (knowledge/persons.json, sensors.json, devices.json).
//
// Particle dynamics: src/oracle/belief-model.mjs (Deichmann2023 kernel, World-parity stepper).
// Known inputs are applied exactly as the agent knows them: the device ledger (boluses,
// 5-minute net basal and extended buckets of a pump; pen boluses), patient-reported carbs,
// rescue carbs, routine long-acting injections, announced exercise and life events. Hidden
// parts are particle variables: sensitivity (static, daily levels, dawn when the variant is
// random, menstrual phase), carb bioavailability and absorption speed, true grams of reported
// meals (carb-counting error, high-fat composition), unannounced meals from the lifestyle prior,
// an infusion-set occlusion when the instance has occlusion faults, the interstitial lag and the
// CGM calibration error (Kalman filter per particle).
//
// The filter is a deterministic function of the observation history and the decider seed: all
// randomness is drawn from streams keyed by virtual time. Late information (a flash scan reveals
// 8 h of stored readings; a fingerstick at an off-grid time) rewinds to a checkpoint and replays.
import {buildInstanceConfig} from '../sim/instance.mjs';
import {KNOWLEDGE as K} from '../knowledge.mjs';
import {Rng} from '../core/rng.mjs';
import {PUMPS} from '../core/devices.mjs';
import {CGMS} from '../core/cgm.mjs';
import * as M from './belief-model.mjs';

const MIN=M.MIN_MS,FIVE=5*MIN,DAY=M.DAY_MS;
const DEFAULT_ABSORPTION={breakfast:40,lunch:55,dinner:65,snack:30};
const clone=x=>structuredClone(x);
const hhmm=s=>Number(s.slice(0,2))*60+Number(s.slice(3));

// --- public description ------------------------------------------------------------------

/**
 * What an agent may know about an instance before the first observation. Derived from the spec
 * through a whitelist: no seed, no sampled person parameters (sensitivity, TDD, carbs/day, true
 * basal, dawn draw), no scenario events, no sensor draws. Programmed settings, body weight and
 * device/sensor/routine choices are things the person and their care team know.
 */
export function publicDescription(spec) {
  const cfg=buildInstanceConfig(spec),t=cfg.therapy,p=cfg.patient,pr=cfg.person;
  return deepFreeze({
    start_time:cfg.start_time,utc_offset_minutes:cfg.utc_offset_minutes,horizon_minutes:cfg.horizon_minutes,
    person:pr.type?{type:pr.type,bmi:pr.bmi,dawn:pr.dawn,carb_counting:pr.carb_counting}:null,
    patient:{sex:p.sex,age_years:p.age_years,height_cm:p.height_cm,weight_kg:p.weight_kg},
    profile:{...cfg.profile,...(t.mode==='mdi'?{basal_u_h:null}:{})},   // pens: the dose is known, not a pump rate
    therapy:t.mode==='pump'?{mode:'pump',pump:{model:t.pump.model,insulin:t.pump.insulin}}
      :{mode:'mdi',mdi:{bolus_pen:t.mdi.bolus_pen,bolus_insulin:t.mdi.bolus_insulin,basal_pen:t.mdi.basal_pen,basal_insulin:t.mdi.basal_insulin,
        basal_dose_u:t.mdi.basal_dose_u,basal_times:[...t.mdi.basal_times],auto_basal_injection:t.mdi.auto_basal_injection,
        ...(t.mdi.max_daily_injections===undefined?{}:{max_daily_injections:t.mdi.max_daily_injections})}},
    sensors:{cgm:cfg.cgm.model,meter:cfg.meter.model,meter_routine_times:[...cfg.meter.routine_times],
      scan_window:[...cfg.cgm.scan_window],scan_interval_minutes:cfg.cgm.scan_interval_minutes},
    events:[...(spec.events??['baseline'])],
    controller:{enabled:cfg.controller.enabled,mode:cfg.controller.mode,
      ...(['oref1','hcl'].includes(cfg.controller.algorithm)?{algorithm:cfg.controller.algorithm}:{})},
    // Care mode (track): whether the person boluses announced meals and treats visible lows
    // themselves. The mode is public; the behaviour parameters are priors (selfCarePrior).
    self_care:{mode:cfg.self_care?.mode??'none'},
    safety:{...cfg.safety},alarms:{...cfg.alarms},
  });
}

/**
 * Prior of the person's own management in assisted care (self_care 'assisted'), or null in full
 * care. `mode` comes from the public description or, for descriptions without it, from the first
 * observation (obs.profile.self_care). Behaviour parameters are the documented defaults of the
 * simulator config (src/core/config.mjs self_care): bolus calculator (reported carbs / CR plus a
 * correction above a threshold minus IOB), forget probability, uniform delay, low treatment.
 */
export function selfCarePrior(mode) {
  if(mode!=='assisted')return null;
  const sc=buildInstanceConfig({person:null,seed:0}).self_care,mb=sc.meal_bolus,lt=sc.low_treatment;
  return Object.freeze({missP:mb.miss_probability,maxDelay:mb.max_delay_minutes,correctionAbove:mb.correction_above_mg_dl,
    correctionFraction:mb.correction_fraction,lowBelow:lt.threshold_mg_dl,lowGrams:lt.grams,recheck:lt.recheck_minutes,freshMinutes:30});
}
function deepFreeze(o) {for(const v of Object.values(o))if(v&&typeof v==='object')deepFreeze(v);return Object.freeze(o);}

/** Lifestyle and person priors implied by the public description (public type library). */
export function priorsFor(desc) {
  const D=structuredClone,cfgDefault=buildInstanceConfig({person:null,seed:0}).scenario;
  const type=desc.person?K.persons[desc.person.type]:null,pm=K.personModel;
  const packs=new Set(desc.events);
  const highFat=packs.has('high_fat_meals')?0.3:0;
  let meals,carbsDay=null,carbErr,exerciseP;
  if(type) {
    carbsDay={median:type.carbs_g_per_day.median,sd:type.carbs_g_per_day.sd};
    meals=Object.entries(type.meal_plan).map(([name,m])=>({name,minute:hhmm(m.time),jitterMin:30,share:m.share,
      absorption:DEFAULT_ABSORPTION[name]??45,probability:m.probability??1,highFat:name==='snack'?0:highFat}));
    const cc={...type.carb_estimation,...pm.variants.carb_counting[desc.person.carb_counting]};
    carbErr={model:'normal',bias:cc.bias,sd:cc.sd};
    exerciseP=type.exercise_probability_per_day;
  } else {
    meals=Object.entries(cfgDefault.meals).map(([name,m])=>({name,minute:hhmm(m.time),jitterMin:m.time_jitter_minutes,carbs:m.carbs_g,
      carbsJitter:m.carbs_jitter_g,absorption:m.absorption_minutes,probability:m.probability??1,highFat:name==='snack'?0:highFat}));
    carbErr={model:'uniform',frac:cfgDefault.announcement.carb_error_fraction};
    exerciseP=cfgDefault.activity.probability;
  }
  const sc=cfgDefault;
  return {meals,carbsDay,carbErr,highFat,announceP:packs.has('unannounced_meals')?0.8:1,
    activity:{probability:exerciseP,minute:hhmm(sc.activity.time),jitter:sc.activity.time_jitter_minutes,duration:sc.activity.duration_minutes,AC:sc.activity.accelerometer_counts},
    anaerobic:{AC:0,hep:sc.anaerobic.hepatic_delta_mg_dl_per_min},
    alcohol:{onsetH:sc.alcohol.onset_hours,durationH:sc.alcohol.duration_hours,hep:sc.alcohol.hepatic_delta_mg_dl_per_min},
    illness:{factor:1/(1+sc.illness.insulin_need_increase)},sleep:{factor:1-sc.sleep_loss.sensitivity_decrease,hours:16},
    menstrual:packs.has('menstrual')&&desc.patient.sex==='female'&&desc.patient.age_years>=12&&desc.patient.age_years<=52?D(sc.menstrual):null,
    occlusionRate:packs.has('occlusion_faults')&&desc.therapy.mode==='pump'?0.25:0,
    dailyCv:type?pm.daily_sensitivity_cv.value:0,
    dawn:type?{mode:desc.person.dawn,fraction:pm.variants.dawn.present.fraction,prevalence:type.dawn_prevalence}:{mode:'absent',fraction:0,prevalence:0},
  };
}

/**
 * Prior of log insulin sensitivity (relative to the kernel reference patient) from the public
 * programmed settings and the person type: each of basal, ISF and carb ratio is the true need
 * times a log-normal settings mismatch (knowledge/persons.json profile_mismatch), and the type's
 * TDD/kg and basal fraction give a population prior. Precision-weighted in log space.
 */
export function sensitivityPrior(desc,profile) {
  const pm=K.personModel,ref=pm.reference,w=desc.patient.weight_kg,mm=pm.profile_mismatch,est=[];
  const basal=desc.therapy.mode==='pump'?profile.basal_u_h:desc.therapy.mdi.basal_dose_u*desc.therapy.mdi.basal_times.length/24;
  if(desc.person) {
    const t=K.persons[desc.person.type],bmi=pm.variants.bmi[desc.person.bmi];
    const tdd=t.tdd_u_per_kg_day.median*bmi.tdd_per_kg_x,bf=t.basal_fraction.median;
    est.push([Math.log(ref.basal_u_per_kg_day/(tdd*bf)),Math.hypot(t.tdd_u_per_kg_day.sd/t.tdd_u_per_kg_day.median,t.basal_fraction.sd/bf)]);
    if(basal>0)est.push([Math.log(ref.basal_u_per_kg_day*w/(24*basal)),Math.hypot(mm.basal_cv,desc.therapy.mode==='mdi'?0.05:0)]);
    if(profile.isf_mg_dl_per_u)est.push([Math.log(profile.isf_mg_dl_per_u*w/(ref.profile_isf_mg_dl_per_u*ref.weight_kg)),mm.isf_cv]);
    if(profile.carb_ratio_g_per_u)est.push([Math.log(profile.carb_ratio_g_per_u/ref.profile_carb_ratio_g_per_u),mm.carb_ratio_cv]);
  } else {
    // Reference patient: programmed basal (if any) is the equilibrium need; otherwise a vague prior at 1.
    est.push([0,0.3]);
  }
  let num=0,den=0;for(const [m,s] of est){num+=m/(s*s);den+=1/(s*s);}
  return {mean:num/den,sd:Math.max(0.05,Math.sqrt(1/den))};
}

// --- the filter ----------------------------------------------------------------------------

export const BELIEF_DEFAULTS=Object.freeze({
  particles:256,seed:1,
  // mg/dL random walk per 5 min (unmodelled disturbances; rejuvenates the glucose state). null:
  // 2 with a real-time CGM (288 updates/day would otherwise over-concentrate the posterior),
  // 1 with flash or meter only (sparse updates; more noise only widens the predictive spread).
  glucoseNoise:null,
  outlierFloor:0.02,         // robust likelihood floor
  resampleEss:0.5,
  checkpointMinutes:30,checkpointHours:12,
  agSd:0.05,absScaleSd:0.12,initialGlucose:{mean:120,sd:20},
  levelJitter:0.04,          // rejuvenation of daily sensitivity levels at resampling
  sJitter:0.003,             // rejuvenation of the (static) person sensitivity at resampling
  gainJitter:0.0,            // extra sensor-gain variance added at resampling
});

export class Belief {
  /** desc: publicDescription; obs0: the first observation. */
  constructor(desc,obs0,opts={}) {
    this.o={...BELIEF_DEFAULTS,...opts};this.desc=desc;
    this.start=Date.parse(desc.start_time);this.off=desc.utc_offset_minutes;
    this.prior=priorsFor(desc);
    const mdi=desc.therapy.mode==='mdi';this.mdi=mdi;
    this.rapid=mdi?desc.therapy.mdi.bolus_insulin:desc.therapy.pump.insulin;
    this.P=M.sharedParams({weightKg:desc.patient.weight_kg,rapidInsulin:this.rapid});
    this.pump=mdi?null:PUMPS[desc.therapy.pump.model];
    this.cgmSpec=desc.sensors.cgm?K.sensors[desc.sensors.cgm]:null;
    this.sensor=this.cgmSpec?M.sensorModel({...this.cgmSpec,wear_days:CGMS[desc.sensors.cgm].wear_days},K.errorModels):null;
    this.meter=desc.sensors.meter?K.meters[desc.sensors.meter]:null;
    this.flash=this.cgmSpec?.modality==='flash';
    if(this.o.glucoseNoise==null)this.o.glucoseNoise=this.cgmSpec?.modality==='cgm'?2:1;
    this.flashAlarms=this.flash?this.cgmSpec.alarms??null:null;
    this.ctx={off:this.off,start:this.start,menstrual:this.prior.menstrual};
    this.scheduledUph=mdi?0:obs0.device.scheduled_basal_u_h;
    this.profile={...obs0.profile};
    this.sPrior=sensitivityPrior(desc,{...desc.profile,...obs0.profile});
    // Agent memory (observations only).
    this.items=new Map();this.buckets=new Map();this.seen=new Set();this.bolusSeen=new Map();
    this.active=[];        // known time-bounded effects: {from, until, AC, hep, sens}
    this.dirty=Infinity;this.checkpoints=[];
    this.T=this.start;
    this.particles=this.initParticles();
    this.checkpoint();
    this.lastObsTime=this.start;
  }

  rng(name) {return Rng.stream(this.o.seed,`belief:${name}`);}

  initParticles() {
    const o=this.o,N=o.particles,r=this.rng('init'),P=this.P,pr=this.prior,out=[];
    let pre=null;
    if(this.mdi) {
      const m=this.desc.therapy.mdi,ins=K.insulins[m.basal_insulin],doses=new Map();
      // The same routine injections World preloads: local clock times in the 10 days before the start.
      for(let t=this.start-10*DAY;t<this.start+DAY;t+=DAY)for(const h of m.basal_times) {
        const day=M.localDay(t,this.off),at=Date.parse(`${day}T${h}:00Z`)-this.off*MIN;
        if(at<this.start&&at>=this.start-10*DAY)doses.set(`${day}:${h}`,{id:`pre:${day}:${h}`,at_minute:(at-this.start)/MIN,units:m.basal_dose_u,depot:ins.depot});
      }
      const uniq=[...doses.values()];
      pre=M.mdiPreload(P,uniq,o.initialGlucose.mean);
    }
    const tau=this.sensor?.tau;
    for(let i=0;i<N;i++) {
      const logS=this.sPrior.mean+this.sPrior.sd*r.normal(),S=Math.exp(logS);
      const g0=Math.max(40,o.initialGlucose.mean+o.initialGlucose.sd*r.normal());
      const dawnF=pr.dawn.mode==='present'?pr.dawn.fraction:pr.dawn.mode==='random'?(r.next()<pr.dawn.prevalence?pr.dawn.fraction:0):0;
      let dayLv=null;
      if(pr.dailyCv>0){const cv=pr.dailyCv,n=Math.ceil(this.desc.horizon_minutes/1440)+5;dayLv=new Float64Array(n);for(let k=0;k<n;k++)dayLv[k]=Math.exp(r.normal(0,cv)-cv*cv/2);}
      let tauIG=0;
      if(tau&&tau.median>0){tauIG=Math.min(20,Math.max(0.5,tau.median*Math.exp(r.normal(0,tau.spread*Math.log(tau.iqr[1]/tau.iqr[0])/1.349))));}
      const params={S,AG:Math.exp(o.agSd*r.normal()),absScale:Math.exp(o.absScaleSd*r.normal()),tauIG,alphaIG:tauIG>0?1-Math.exp(-1/tauIG):1,
        dawnF,dayLv,menPhase:pr.menstrual?r.next()*pr.menstrual.cycle_days:null,
        carbsDay:pr.carbsDay?Math.max(60,pr.carbsDay.median+pr.carbsDay.sd*r.normal()):null};
      let init;
      if(this.mdi) {
        const core={...pre.core,X:pre.core.X*S,Q1:g0*P.Vg,Q2:P.p4/P.p5*g0*P.Vg};
        init={core,depots:pre.depots};
      } else init=M.pumpInitialState(P,{basalUph:this.scheduledUph,glucose:g0,S});
      const p=M.makeParticle(P,params,init);
      if(this.sensor?.kind==='padova')p.kf=M.kfInit(this.sensor);
      out.push(p);
    }
    return out;
  }

  // --- memory --------------------------------------------------------------------------

  add(t,item) {
    const m=Math.floor(t/MIN)*MIN;
    if(!this.items.has(m))this.items.set(m,[]);
    this.items.get(m).push(item);
    this.touch(m);
  }
  /** Marks the belief stale from minute m if it has already processed that minute. */
  touch(m) {if(m<this.T||(m===this.T&&this.observedAt===m))this.dirty=Math.min(this.dirty,m);}
  once(key) {if(this.seen.has(key))return false;this.seen.add(key);return true;}

  /**
   * Records everything new in an observation. Returns {info: [kinds of new information]} so the
   * decider can trigger a decision on new readings or notices.
   */
  ingest(obs) {
    const now=Date.parse(obs.virtual_time),info=[];this.now=now;
    // Glucose readings: CGM history, meter, flash scan (current reading and stored history).
    for(const r of obs.cgm_history??[]) {
      const t=Date.parse(r.time);if(this.once(`cgm:${t}`)){this.add(t,{type:'cgm',value:r.value_mg_dl});info.push('cgm');}
    }
    if(obs.cgm?.display&&obs.cgm.sample_time) {
      const t=Date.parse(obs.cgm.sample_time),it=this.items.get(t)?.find(i=>i.type==='cgm');if(it)it.display=obs.cgm.display;
    }
    const mr=obs.meter?.last_reading;
    if(mr){const t=Date.parse(mr.time);if(this.once(`meter:${t}`)){this.add(t,{type:'meter',value:mr.value_mg_dl,display:mr.display});info.push('meter');}}
    const sc=obs.flash?.last_scan;
    if(sc&&this.once(`scan:${sc.at}`)) {
      info.push('scan');
      const pts=[...(sc.history??[])];if(sc.value_mg_dl!=null&&sc.reading_time)pts.push({time:sc.reading_time,value_mg_dl:sc.value_mg_dl,display:sc.display});
      for(const r of pts){const t=Date.parse(r.time);if(this.once(`cgm:${t}`))this.add(t,{type:'cgm',value:r.value_mg_dl,display:r.display??null});}
    }
    // Device ledger: boluses (exact time), basal/extended 5-minute buckets (closed ones are final).
    for(const d of obs.device.insulin_ledger??[]) {
      const t=Date.parse(d.time);
      if(d.kind==='bolus') {
        const prev=this.bolusSeen.get(t);
        if(prev===undefined){this.bolusSeen.set(t,d.units);this.add(t,{type:'bolus',units:d.units});info.push('bolus');}
        else if(Math.abs(prev-d.units)>1e-9){this.bolusSeen.set(t,d.units);const it=this.items.get(Math.floor(t/MIN)*MIN).find(i=>i.type==='bolus');
          it.units=d.units;this.touch(Math.floor(t/MIN)*MIN);}
      } else {
        const b=this.buckets.get(t)??{basal:0,extended:0},k=d.kind==='extended'?'extended':'basal';
        if(b[k]!==d.units){b[k]=d.units;this.buckets.set(t,b);this.touch(t);}
      }
    }
    for(const c of obs.reported_carbs??[]) {
      const t=Date.parse(c.time);
      if(c.source!=='announced_meal'&&this.once(`carbs:${t}:${c.source}`)){this.add(t,{type:'carbs',grams:c.grams,absorption:this.o.rescueAbsorption??this.desc.safety.rescue_absorption_minutes});info.push('carbs');}
    }
    for(const e of obs.events??[]) {
      const key=`ev:${e.type}:${e.id??''}:${e.time}`;if(!this.once(key))continue;
      const t=Date.parse(e.time);info.push(e.type);
      switch(e.type) {
        case 'meal_announced': {
          const m=/^meal:(\d{4}-\d{2}-\d{2}):(.+)$/.exec(e.id??''),name=m?.[2],slot=m?`${m[1]}:${m[2]}`:null;
          const plan=this.prior.meals.find(x=>x.name===name);
          this.add(t,{type:'meal',grams:e.grams,slot,absorption:plan?.absorption??45,highFat:plan?.highFat??0});break;
        }
        case 'exercise_started':this.add(t,{type:'exercise',kind:e.kind,minutes:e.duration_minutes});break;
        case 'alcohol_reported':this.add(t,{type:'alcohol'});break;
        case 'illness_reported':this.add(t,{type:'illness',days:e.expected_days});break;
        case 'poor_sleep_reported':this.add(t,{type:'sleep'});break;
        case 'basal_injection_taken':this.add(t,{type:'la',units:e.units,insulin:e.insulin});break;
        case 'fingerstick':if(e.cgm_calibrated)this.add(t,{type:'calib',value:e.value_mg_dl});break;
        case 'cgm_sensor_replaced':this.add(t,{type:'sensor_new',readyAt:Date.parse(e.warmup_until)});break;
        case 'pump_occlusion_alarm':this.add(t,{type:'occl_alarm'});break;
        case 'flash_alarm_low':case 'flash_alarm_high':this.add(t,{type:'flash_alarm',level:e.type.endsWith('low')?-1:1});break;
        default:break;
      }
    }
    return {info,now};
  }
  /** The agent's own actions whose effect is not in the ledger or reported carbs. */
  noteAction(t,action,obsAfter) {
    if(action.type==='CALIBRATE_CGM')this.pendingCalibration=t;
    if(action.type==='CHANGE_INFUSION_SET')this.add(t,{type:'set_change'});
  }
  /** After an own CALIBRATE_CGM, the meter reading at that time doubles as the calibration value. */
  resolveCalibration(obs) {
    if(this.pendingCalibration==null)return;
    const mr=obs.meter?.last_reading;
    if(mr&&Date.parse(mr.time)>=this.pendingCalibration){this.add(Date.parse(mr.time),{type:'calib',value:mr.value_mg_dl});this.pendingCalibration=null;}
  }

  // --- propagation ---------------------------------------------------------------------

  checkpoint() {
    this.checkpoints.push({T:this.T,particles:this.particles.map(M.cloneParticle),active:clone(this.active),occlAlarmed:this.occlAlarmed??false,bolusRuns:clone(this.bolusRuns??[])});
    const keep=this.o.checkpointHours*60/this.o.checkpointMinutes;
    if(this.checkpoints.length>keep)this.checkpoints.shift();
  }
  rewind(to) {
    let k=this.checkpoints.length-1;
    while(k>0&&this.checkpoints[k].T>to)k--;
    const c=this.checkpoints[k];
    this.checkpoints.length=k+1;
    this.T=c.T;this.particles=c.particles.map(M.cloneParticle);this.active=clone(c.active);this.occlAlarmed=c.occlAlarmed;this.bolusRuns=clone(c.bolusRuns);
    this.observedAt=null;this.kfAt=null;
    this.rewinds=(this.rewinds??0)+1;
  }

  /** Belief time the filter can reach: every input before it is final (closed ledger buckets). */
  reachable(now) {return Math.floor(now/FIVE)*FIVE;}

  advance(now) {
    if(this.dirty<Infinity){if(this.dirty<this.T)this.rewind(this.dirty);this.dirty=Infinity;}
    const target=this.reachable(now);
    while(this.T<target) {
      this.observeAt(this.T);
      this.inputsAt(this.T);
      this.stepAll(this.T);
      this.T+=MIN;
      if(this.T%FIVE===0)this.maybeResample(this.T);
      if((this.T-this.start)%(this.o.checkpointMinutes*MIN)===0)this.checkpoint();
    }
    // Readings at exactly the belief time are applied now (the next minute's inputs wait).
    this.observeAt(this.T);
  }

  /** Known pump/pen insulin rate (U/h) over [t, t+1 min): scheduled basal + ledger buckets + running boluses. */
  knownRate(t) {
    let r=this.mdi?0:this.scheduledUph;
    const b=this.buckets.get(Math.floor(t/FIVE)*FIVE);
    if(b)r+=(b.basal+b.extended)*12;
    for(const run of this.bolusRuns??[])if(t>=run.from&&t<run.until)r+=run.rate;
    return Math.max(0,r);
  }
  /** Known effects active at t: {AC, hep, sens}. */
  knownEffects(t) {
    let AC=0,hep=0,sens=1;
    for(const e of this.active)if(t>=e.from&&t<e.until){AC=Math.max(AC,e.AC??0);hep+=e.hep??0;sens*=e.sens??1;}
    return {AC,hep,sens};
  }

  /** Observations at time t (state at t). */
  observeAt(t) {
    if(this.observedAt===t)return;
    this.observedAt=t;
    const items=this.items.get(t)??[],sensor=this.sensor,ps=this.particles,P=this.P,floor=this.o.outlierFloor;
    // Sensor noise advances at every sample time of a padova sensor, read or not.
    if(t%FIVE===0&&sensor?.kind==='padova'&&this.kfAt!==t){this.kfAt=t;for(const p of ps)M.kfPredict(p.kf,sensor);}
    for(const it of items) {
      if(it.type==='sensor_new'){for(const p of ps)if(sensor?.kind==='padova')p.kf=M.kfInit(sensor,{fresh:true});this.sensorReadyAt=it.readyAt;}
    }
    let alarmNotice=null;
    for(const it of items) {
      if(it.type==='cgm'&&sensor) {
        const lo=sensor.range[0],hi=sensor.range[1],cens=it.display==='LO'||it.value<=lo?-1:it.display==='HI'||it.value>=hi?1:0;
        for(const p of ps) {
          let mu,v;
          if(sensor.kind==='padova')({mu,v}=M.kfPredictive(p.kf,p.ig,1));
          else {mu=M.glucoseOf(p,P);v=sensor.sd**2+0.25;}
          if(cens){const z=(cens<0?lo-mu:mu-hi)/Math.sqrt(v);p.logw+=Math.log(Math.max(1e-6,M.normCdf(z)));}
          else {p.logw+=M.logNormalRobust(it.value,mu,v,floor);if(sensor.kind==='padova')M.kfUpdate(p.kf,p.ig,it.value,1);}
        }
      } else if(it.type==='meter'&&this.meter) {
        for(const p of ps){const {mu,sd}=M.meterPredictive(this.meter,M.glucoseOf(p,P));p.logw+=M.logNormalRobust(it.value,mu,sd*sd,floor);}
      } else if(it.type==='flash_alarm')alarmNotice=it.level;
    }
    for(const it of items)if(it.type==='calib'&&sensor?.kind==='padova')for(const p of ps)M.kfCalibrate(p.kf,p.ig,it.value);
    // Libre 2 style alarms: edge-triggered on the sensor value, so silence is information too.
    if(this.flashAlarms&&t%FIVE===0&&t>=(this.sensorReadyAt??0)&&sensor.kind==='padova') {
      const al=this.flashAlarms;
      for(const p of ps) {
        const {mu,v}=M.kfPredictive(p.kf,p.ig,1),sd=Math.sqrt(v);
        const pLow=M.normCdf((al.low_mg_dl-mu)/sd),pHigh=1-M.normCdf((al.high_mg_dl-mu)/sd);
        let like;
        if(alarmNotice===-1)like=pLow;
        else if(alarmNotice===1)like=pHigh;
        else like=p.alarm===0?1-pLow-pHigh:p.alarm<0?1-pHigh:1-pLow;
        p.logw+=Math.log(0.97*Math.max(0,like)+0.03);
        p.alarm=alarmNotice??(mu<al.low_mg_dl?-1:mu>al.high_mg_dl?1:0);
      }
    }
  }

  /** Inputs that start at t: known treatments and events, then per-particle hidden events. */
  inputsAt(t) {
    const items=this.items.get(t)??[],ps=this.particles,P=this.P,pr=this.prior,r=this.rng(`in:${t}`);
    this.bolusRuns=(this.bolusRuns??[]).filter(b=>b.until>t);
    for(const it of items) {
      switch(it.type) {
        case 'bolus': {
          const speed=this.pump?.bolus_speed_u_per_min;
          if(this.pump&&Number.isFinite(speed)&&speed>0){const min=it.units/speed;this.bolusRuns.push({from:t,until:t+Math.max(1,Math.ceil(min))*MIN,rate:it.units/Math.max(1,Math.ceil(min))*60});}
          else for(const p of ps)if(!p.occl||p.occl.alarmed)M.bolus(p,P,it.units);else p.occl.missed+=it.units;
          break;
        }
        case 'carbs':for(const p of ps)M.addMeal(p,it.grams,it.absorption);break;
        case 'meal': {
          for(const p of ps) {
            const s=it.slot?p.slots[it.slot]:null;
            if(s&&s.st==='unann'){p.logw+=Math.log(1e-3);}   // hypothesis contradicted: the meal was announced
            if(it.slot)p.slots[it.slot]={st:'done'};
            const {grams,tau}=trueMeal(pr,it.grams,it.absorption,it.highFat,r);
            M.addMeal(p,grams,tau);
          }
          break;
        }
        case 'la':{const rates=M.longActingDepotRates(it.insulin);for(const p of ps)M.addDepot(p,rates,it.units*1e6);break;}
        case 'exercise':
          this.active.push(it.kind==='anaerobic'?{from:t,until:t+it.minutes*MIN,AC:pr.anaerobic.AC,hep:pr.anaerobic.hep}
            :{from:t,until:t+it.minutes*MIN,AC:pr.activity.AC});break;
        case 'alcohol':this.active.push({from:t+pr.alcohol.onsetH*3600000,until:t+(pr.alcohol.onsetH+pr.alcohol.durationH)*3600000,hep:pr.alcohol.hep});break;
        case 'illness':this.active.push({from:t,until:t+(it.days??3)*DAY,sens:pr.illness.factor});break;
        case 'sleep':this.active.push({from:t,until:t+pr.sleep.hours*3600000,sens:pr.sleep.factor});break;
        case 'occl_alarm':
          this.occlAlarmed=true;
          for(const p of ps){if(p.occl)p.occl.alarmed=true;else p.logw+=Math.log(0.05);}   // an alarm without an occlusion is unlikely
          break;
        case 'set_change':this.occlAlarmed=false;for(const p of ps)p.occl=null;break;
        default:break;
      }
    }
    this.hiddenEvents(t,r);
  }

  /** Per-particle hidden events: unannounced meals of the lifestyle prior, occlusion onsets. */
  hiddenEvents(t,r) {
    const pr=this.prior,ps=this.particles,local=M.localMinute(t,this.off);
    if(pr.announceP<1) {
      for(const m of pr.meals) {
        const startMin=m.minute-m.jitterMin,endMin=m.minute+m.jitterMin;
        const rel=((local-startMin)%1440+1440)%1440;
        if(rel>endMin-startMin)continue;
        const day=M.localDay(t-rel*MIN+m.jitterMin*MIN,this.off),key=`${day}:${m.name}`;
        const pU=m.probability*(1-pr.announceP);
        if(rel===0)for(const p of ps)if(!p.slots[key]) {
          if(r.next()<pU) {
            const at=t+Math.round(r.next()*(endMin-startMin))*MIN,{grams,tau}=hiddenMeal(pr,m,p,r);
            p.slots[key]={st:'unann',at,grams,tau};
          } else p.slots[key]={st:'maybe'};
        }
        for(const p of ps){const s=p.slots[key];if(s?.st==='unann'&&s.at===t){M.addMeal(p,s.grams,s.tau);s.eaten=true;}}
        if(rel===endMin-startMin)for(const p of ps){const s=p.slots[key];
          if(s?.st==='maybe'){p.logw+=Math.log(Math.max(1e-9,(1-m.probability)/(1-pU)));s.st='done';}
          else if(s?.st==='unann'&&s.eaten)s.st='done_unann';}
      }
    }
    if(pr.occlusionRate>0&&t%FIVE===0&&!this.occlAlarmed) {
      const h=pr.occlusionRate*5/1440;
      for(const p of ps)if(!p.occl&&r.next()<h)p.occl={since:t,missed:0,alarmed:false};
    }
  }

  stepAll(t) {
    const ps=this.particles,P=this.P,rate=this.knownRate(t),eff=this.knownEffects(t),noise=this.o.glucoseNoise;
    const thr=this.pump?.occlusion_alarm_missed_u??3;
    const r=t%FIVE===0&&noise>0?this.rng(`noise:${t}`):null;
    for(const p of ps) {
      let u=rate;
      if(p.occl&&!p.occl.alarmed){p.occl.missed+=rate/60;u=0;
        if(p.occl.missed>=thr){p.occl.alarmed=true;p.logw+=Math.log(1e-3);}}   // would have alarmed; we saw none
      const k=p.S*M.baseMultiplier(p,t,this.ctx)*eff.sens;
      M.stepMinute(P,p,u,eff.AC,eff.hep,k);
      if(r){const d=noise*r.normal()*P.Vg;p.s[4]=Math.max(P.Vg*20,p.s[4]+d);}
    }
  }

  maybeResample(t) {
    const ps=this.particles,N=ps.length;
    let mx=-Infinity;for(const p of ps)mx=Math.max(mx,p.logw);
    let sw=0,sw2=0;const w=ps.map(p=>Math.exp(p.logw-mx));for(const x of w){sw+=x;sw2+=x*x;}
    const ess=sw*sw/sw2;this.ess=ess;
    if(ess>=this.o.resampleEss*N){for(const p of ps)p.logw-=mx;return;}
    const r=this.rng(`resample:${t}`),idx=systematic(w,sw,N,r.next());
    const out=idx.map(i=>M.cloneParticle(ps[i]));
    // Small jitter of static parameters keeps diversity (shrinkage keeps the spread unchanged on average).
    const lvJ=this.o.levelJitter;
    for(const p of out){p.logw=0;p.S*=Math.exp(this.o.sJitter*r.normal());
      if(p.dayLv&&lvJ>0){p.dayLv=p.dayLv.slice();for(let k=0;k<p.dayLv.length;k++)p.dayLv[k]*=Math.exp(lvJ*r.normal());}
      if(p.kf&&this.o.gainJitter>0){p.kf=p.kf.slice();p.kf[4]+=this.o.gainJitter**2;}p.AG=Math.min(1.3,Math.max(0.6,p.AG*Math.exp(0.01*r.normal())));
      p.absScale=Math.min(3,Math.max(0.4,p.absScale*Math.exp(0.02*r.normal())));}
    this.particles=out;this.resamples=(this.resamples??0)+1;
  }

  // --- summaries and planning samples ----------------------------------------------------

  weights() {
    const ps=this.particles;let mx=-Infinity;for(const p of ps)mx=Math.max(mx,p.logw);
    const w=ps.map(p=>Math.exp(p.logw-mx)),s=w.reduce((a,b)=>a+b,0);return w.map(x=>x/s);
  }
  /** Weighted draw of K particle clones (systematic), deterministic per key. */
  sample(K,key) {
    const w=this.weights(),r=this.rng(`sample:${key}`),idx=systematic(w,1,K,r.next());
    return idx.map(i=>M.cloneParticle(this.particles[i]));
  }
  summary() {
    const w=this.weights(),ps=this.particles,P=this.P,T=this.T;
    const stat=f=>{const v=ps.map(f);let m=0;v.forEach((x,i)=>m+=w[i]*x);let s=0;v.forEach((x,i)=>s+=w[i]*(x-m)**2);
      const ord=v.map((x,i)=>[x,w[i]]).sort((a,b)=>a[0]-b[0]);const q=a=>{let c=0;for(const [x,wi] of ord){c+=wi;if(c>=a)return x;}return ord.at(-1)[0];};
      return {mean:m,sd:Math.sqrt(s),q05:q(0.05),q50:q(0.5),q95:q(0.95)};};
    const eff=this.knownEffects(T);
    const out={time:new Date(T).toISOString(),minute:(T-this.start)/MIN,
      glucose:stat(p=>M.glucoseOf(p,P)),sensitivity:stat(p=>p.S),
      effective_sensitivity:stat(p=>p.S*M.baseMultiplier(p,T,this.ctx)*eff.sens),gut_carbs_g:stat(p=>M.gutCarbs(p,P)),
      ess:this.ess??ps.length,particles:ps.length};
    if(this.sensor?.kind==='padova')out.sensor_gain=stat(p=>p.kf[0]);
    if(this.prior.occlusionRate>0)out.p_occluded=ps.reduce((s,p,i)=>s+(p.occl&&!p.occl.alarmed?w[i]:0),0);
    return out;
  }
}

function systematic(w,total,N,u0) {
  const out=new Array(N),step=total/N;let c=w[0],i=0,u=u0*step;
  for(let k=0;k<N;k++){while(u>c&&i<w.length-1){i++;c+=w[i];}out[k]=i;u+=step;}
  return out;
}

/** True grams and absorption of a reported meal under the carb-counting and composition priors. */
export function trueMeal(pr,reported,absorption,highFatP,r) {
  let err;
  if(pr.carbErr.model==='normal')err=Math.max(-0.5,Math.min(1.5,pr.carbErr.bias+pr.carbErr.sd*r.normal()));
  else err=r.symmetric(pr.carbErr.frac);
  let grams=reported/(1+err),tau=absorption;
  if(highFatP>0&&r.next()<highFatP){grams*=1.2;tau*=1.6;}
  return {grams:Math.max(0,grams),tau};
}
/** Grams and absorption of an unreported meal from the person's meal plan. */
export function hiddenMeal(pr,m,p,r) {
  let g;
  if(m.share!=null){const base=Math.max(5,Math.round((p.carbsDay??pr.carbsDay?.median??180)*m.share));g=base+r.symmetric(Math.round(base*0.2));}
  else g=m.carbs+r.symmetric(m.carbsJitter??0);
  let tau=m.absorption;
  if(m.highFat>0&&r.next()<m.highFat){g*=1.2;tau*=1.6;}
  return {grams:Math.max(0,g),tau};
}
