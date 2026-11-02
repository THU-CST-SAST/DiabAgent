// Rule-based priors from metadata and therapy statistics, and the instance-spec builder.
//
// Sensitivity follows the person model in src/core/person.mjs: the kernel's reference patient
// needs 0.208 U/kg/day of basal insulin at sensitivity 1, and sensitivity scales insulin action
// against that fixed reference, so a person's basal need per kg gives
//   sensitivity = equilibrium basal(weight) / true basal need.
// Independent hints (delivered basal, TDD x typical basal fraction, programmed basal, ISF, carb
// ratio) are combined on the log scale into a weak log-normal prior.
import {PERSONS} from '../core/person.mjs';
import {KNOWLEDGE} from '../knowledge.mjs';
import {equilibriumBasalUph} from '../core/physiology.mjs';
import {PUMPS,PENS,PEN_INSULINS} from '../core/devices.mjs';
import {PUMP_INSULINS,BOLUS_PEN_INSULINS,BASAL_PEN_INSULINS} from '../core/insulins.mjs';
import {CGMS} from '../core/cgm.mjs';
import {METERS} from '../core/meter.mjs';
import {basalTimeline,scheduledBasalAt} from './ingest.mjs';
import {MIN_MS,DAY_MS,localDayKey,localDayStart,localMinuteOfDay,hhmmToMinutes,minutesToHhmm,clamp,mean,median,sd,round} from './util.mjs';

const REF=KNOWLEDGE.personModel?.reference??{basal_u_per_kg_day:0.2082,weight_kg:66,profile_isf_mg_dl_per_u:50,profile_carb_ratio_g_per_u:10};

/** Fit parameters: optimiser transform and the kernel's default value. */
export const PARAM_SPECS=Object.freeze({
  sensitivity:{transform:'log',bounds:[0.05,20],default:1},
  glucose_effectiveness:{transform:'bounded',bounds:[0.002,0.06],default:0.0126},
  basal_glucose:{transform:'bounded',bounds:[70,220],default:120},
  carb_bioavailability:{transform:'bounded',bounds:[0.3,1.2],default:1},
  meal_absorption_scale:{transform:'bounded',bounds:[0.3,3],default:1},
  dawn_fraction:{transform:'bounded',bounds:[0,1.2],default:0},
  cgm_gain:{transform:'log',bounds:[0.6,1.4],default:1},
  cgm_offset:{transform:'linear',bounds:[-40,40],default:0},
});

export function personTypeFor(meta) {
  const a=meta.age_years,g=a<13?'child':a<18?'adolescent':a<65?'adult':'older';
  const id=`${g}_${meta.sex}`;
  return PERSONS[id]?id:Object.keys(PERSONS).find(k=>k.endsWith(meta.sex))??Object.keys(PERSONS)[0];
}

/** Integral of the delivered basal (U) over [a, b). */
function basalUnits(timeline,a,b) {
  let u=0;for(const s of timeline){const x=Math.max(a,s.from),y=Math.min(b,s.to);if(y>x)u+=s.rate_u_h*(y-x)/3600000;}
  return u;
}

/** Daily therapy statistics over usable full days. */
export function therapyStats(trace,qc) {
  const off=trace.meta.utc_offset_minutes,w=trace.meta.weight_kg;
  const days=qc.report.days.filter(d=>d.full_day&&qc.usableDays.includes(d.day)).map(d=>d.day);
  const useDays=days.length?days:qc.report.days.filter(d=>d.full_day).map(d=>d.day);
  const tl=basalTimeline(trace,trace.cgm[0].t-DAY_MS,trace.cgm.at(-1).t+DAY_MS);
  const per=useDays.map(key=>{
    const a=localDayStart(key,off),b=a+DAY_MS,inDay=t=>t>=a&&t<b;
    const bolus=trace.boluses.filter(x=>inDay(x.t)).reduce((s,x)=>s+x.units,0);
    const basal=trace.meta.therapy.mode==='pump'?basalUnits(tl,a,b):trace.basal_injections.filter(x=>inDay(x.t)).reduce((s,x)=>s+x.units,0);
    const carbs=trace.carbs.filter(x=>inDay(x.t)).reduce((s,x)=>s+x.grams,0);
    return {day:key,bolus,basal,tdd:bolus+basal,carbs};
  });
  const m=k=>per.length?mean(per.map(p=>p[k])):NaN;
  const profileBasal=trace.profile.basal.length?mean(Array.from({length:48},(_,i)=>scheduledBasalAt(trace.profile,localDayStart('2000-01-01',0)+i*30*MIN_MS,0))):NaN;
  const g=trace.cgm.map(r=>r.mg_dl);
  return {days:per.length,tdd_u:m('tdd'),basal_u:m('basal'),bolus_u:m('bolus'),carbs_g:m('carbs'),
    tdd_u_per_kg:m('tdd')/w,basal_fraction:m('basal')/m('tdd'),profile_basal_u_h:profileBasal,
    effective_carb_ratio_g_per_u:m('bolus')>0?m('carbs')/m('bolus'):NaN,
    cgm_mean:mean(g),cgm_sd:sd(g),cgm_median:median(g),per_day:per};
}

/** Dawn evidence: early-morning glucose rise without carbs/boluses and early-morning basal increase. */
export function dawnEvidence(trace) {
  const off=trace.meta.utc_offset_minutes,keys=[...new Set(trace.cgm.map(r=>localDayKey(r.t,off)))];
  const tl=basalTimeline(trace,trace.cgm[0].t-DAY_MS,trace.cgm.at(-1).t+DAY_MS);
  const near=t=>{let best=null;for(const r of trace.cgm){const d=Math.abs(r.t-t);if(d<=15*MIN_MS&&(!best||d<Math.abs(best.t-t)))best=r;}return best;};
  const rises=[],ratios=[];
  for(const key of keys) {
    const d0=localDayStart(key,off),at=h=>d0+h*3600000;
    const quiet=!trace.carbs.some(c=>c.t>=at(-1)&&c.t<at(7.5))&&!trace.boluses.some(b=>b.t>=at(1)&&b.t<at(7.5));
    const a=near(at(3)),b=near(at(7.5));
    if(quiet&&a&&b)rises.push(b.mg_dl-a.mg_dl);
    if(trace.meta.therapy.mode==='pump') {
      const night=basalUnits(tl,at(0),at(3))/3,morning=basalUnits(tl,at(4.5),at(8))/3.5;
      if(night>0&&quiet)ratios.push(morning/night);
    }
  }
  const rise=rises.length?median(rises):0,ratio=ratios.length?median(ratios):1;
  return {nights:rises.length,median_rise_mg_dl:round(rise,1),median_morning_basal_ratio:round(ratio,3),
    estimate:round(clamp(0.6*(ratio-1)+rise/200,0,0.4),3)};
}

/**
 * Priors and initial values. Returns {person_type, stats, dawn, sensitivity_components, priors, init, warnings}.
 * priors[name] = {mean, sd, scale:'log'|'linear'}: log scale means log(value) ~ N(log(mean), sd).
 */
export function rulePriors(trace,qc,opts={}) {
  const meta=trace.meta,w=meta.weight_kg,type=personTypeFor(meta),pt=PERSONS[type];
  const stats=therapyStats(trace,qc),dawn=dawnEvidence(trace),warnings=[];
  const eqDay=equilibriumBasalUph(w)*24;   // U/day of basal at sensitivity 1
  const comps=[];
  const add=(name,value,sdLog)=>{if(Number.isFinite(value)&&value>0)comps.push({name,value:round(value,4),sd_log:sdLog});};
  add('delivered_basal',eqDay/stats.basal_u,0.30);
  add('tdd_x_typical_basal_fraction',eqDay/(stats.tdd_u*(pt.basal_fraction?.median??0.42)),0.35);
  if(meta.therapy.mode==='pump')add('profile_basal',equilibriumBasalUph(w)/stats.profile_basal_u_h,0.30);
  add('profile_isf',trace.profile.isf_mg_dl_per_u*w/(REF.profile_isf_mg_dl_per_u*REF.weight_kg),0.40);
  add('profile_carb_ratio',trace.profile.carb_ratio_g_per_u/REF.profile_carb_ratio_g_per_u,0.45);
  const typeBasalPerKg=(pt.tdd_u_per_kg_day?.median??0.65)*(pt.basal_fraction?.median??0.42);
  add('person_type_median',REF.basal_u_per_kg_day/typeBasalPerKg,0.45);
  const wsum=comps.reduce((s,c)=>s+1/c.sd_log**2,0);
  const logS=comps.reduce((s,c)=>s+Math.log(c.value)/c.sd_log**2,0)/wsum;
  const sens=clamp(Math.exp(logS),0.1,10);
  // Hints are correlated (all derive from the same dosing), so the prior stays weak.
  const sensSd=opts.sensitivityPriorSd??0.35;

  // Carb-ratio realism: carbs eaten per bolus unit vs the programmed ratio.
  if(Number.isFinite(stats.effective_carb_ratio_g_per_u)&&trace.profile.carb_ratio_g_per_u) {
    const r=stats.effective_carb_ratio_g_per_u/trace.profile.carb_ratio_g_per_u;
    if(r<0.6||r>1.6)warnings.push(`recorded carbs per bolus unit (${stats.effective_carb_ratio_g_per_u.toFixed(1)} g/U) differ from the profile carb ratio by x${r.toFixed(2)}: carb records may be incomplete or boluses include corrections`);
  }
  if(stats.tdd_u_per_kg<0.2||stats.tdd_u_per_kg>2)warnings.push(`TDD ${stats.tdd_u_per_kg.toFixed(2)} U/kg/day is outside the usual T1D range`);
  if(stats.carbs_g<50)warnings.push(`only ${Math.round(stats.carbs_g)} g carbs/day recorded`);

  const priors={
    sensitivity:{mean:sens,sd:sensSd,scale:'log'},
    glucose_effectiveness:{mean:0.0126,sd:0.4,scale:'log'},
    basal_glucose:{mean:120,sd:0.15,scale:'log'},
    carb_bioavailability:{mean:0.95,sd:0.2,scale:'log'},
    meal_absorption_scale:{mean:1,sd:0.4,scale:'log'},
    dawn_fraction:{mean:dawn.estimate,sd:0.2,scale:'linear'},
    cgm_gain:{mean:1,sd:0.06,scale:'log'},
    cgm_offset:{mean:0,sd:6,scale:'linear'},
    ...(opts.priors??{}),
  };
  const init=Object.fromEntries(Object.entries(priors).map(([k,p])=>[k,clamp(p.mean,...(PARAM_SPECS[k]?.bounds??[-Infinity,Infinity]))]));
  if(init.dawn_fraction<=0.01)init.dawn_fraction=0.02;
  return {person_type:type,stats,dawn,sensitivity_components:comps,priors,init,warnings,
    latent_priors:{meal_log_scale_sd:opts.mealScaleSd??0.25,day_log_sensitivity_sd:opts.daySensitivitySd??(KNOWLEDGE.personModel?.daily_sensitivity_cv?.value??0.13),
      // Padova G6 dispersions (knowledge/sensors.json padova_g6 x typical spread): a0 sd ~0.08, a1 sd ~0.03/day, b0 sd ~4-6 mg/dL.
      cgm_session_log_gain_sd:opts.cgmGainSd??0.08,cgm_drift_per_day_sd:opts.cgmDriftSd??0.03,cgm_session_offset_sd:opts.cgmOffsetSd??6}};
}

// --- instance spec ---------------------------------------------------------------------------

const SLOTS=[['breakfast',240,630],['lunch',630,900],['snack',900,1050],['dinner',1050,1290],['late_snack',1290,1680]];

/** Typical meal plan from recorded meals (local time slots), in scenario.meals form. */
export function mealPlan(trace,qc,{absorptionScale=1,scaleOf=null}={}) {
  const off=trace.meta.utc_offset_minutes,days=Math.max(1,qc.usableDays.length||qc.report.days.length);
  const plan={};
  for(const [name,lo,hi] of SLOTS) {
    const ms=trace.carbs.filter(c=>c.kind==='meal'&&c.grams>=5).map((c,i)=>({c,i,m:(()=>{const x=localMinuteOfDay(c.t,off);return x<240?x+1440:x;})()}))
      .filter(x=>x.m>=lo&&x.m<hi&&qc.usableDays.includes(localDayKey(x.c.t,off)));
    if(!ms.length)continue;
    const perDay=new Set(ms.map(x=>localDayKey(x.c.t,off))).size,p=clamp(perDay/days,0,1);
    if(p<0.2)continue;
    const grams=ms.map(x=>x.c.grams*(scaleOf?scaleOf(x.c):1)),g=clamp(Math.round(median(grams)),5,200);
    const times=ms.map(x=>x.m);
    plan[name]={time:minutesToHhmm(median(times)),carbs_g:g,carbs_jitter_g:clamp(Math.round(sd(grams)),0,g-1),
      time_jitter_minutes:clamp(Math.round(sd(times)),0,120),
      absorption_minutes:clamp(Math.round(median(ms.map(x=>x.c.absorption_minutes??45))),5,240),
      ...(p<0.95?{probability:round(p,2)}:{})};
  }
  return plan;
}

const CGM_ALIASES={g6:'dexcom_g6',g7:'dexcom_g7',g5:'dexcom_g5',libre2:'libre_2',libre3:'libre_3',libre1:'libre_1_scan',guardian3:'medtronic_guardian_3'};

/** Device/sensor part of the spec, falling back to compatible defaults with warnings. */
export function therapyAndSensors(meta,warnings=[]) {
  const t=meta.therapy;let therapy;
  if(t.mode==='pump') {
    let model=t.pump?.model,insulin=t.pump?.insulin;
    if(!PUMPS[model]){if(model)warnings.push(`unknown pump ${model}; using ideal`);model='ideal';}
    if(!PUMP_INSULINS.includes(insulin)){if(insulin)warnings.push(`unknown pump insulin ${insulin}; using aspart`);insulin='aspart';}
    therapy={mode:'pump',pump:{model,insulin}};
  } else {
    const m={...t.mdi};
    if(!BOLUS_PEN_INSULINS.includes(m.bolus_insulin))m.bolus_insulin='aspart';
    if(!BASAL_PEN_INSULINS.includes(m.basal_insulin))m.basal_insulin='glargine_u100';
    const penFor=ins=>Object.keys(PENS).find(p=>PEN_INSULINS[p]?.includes(ins));
    if(!PEN_INSULINS[m.bolus_pen]?.includes(m.bolus_insulin))m.bolus_pen=penFor(m.bolus_insulin);
    if(!PEN_INSULINS[m.basal_pen]?.includes(m.basal_insulin))m.basal_pen=penFor(m.basal_insulin);
    therapy={mode:'mdi',mdi:{bolus_pen:m.bolus_pen,bolus_insulin:m.bolus_insulin,basal_pen:m.basal_pen,basal_insulin:m.basal_insulin}};
  }
  let cgm=meta.cgm_model??null;cgm=CGM_ALIASES[String(cgm).toLowerCase().replace(/[^a-z0-9]/g,'')]??cgm;
  if(cgm&&!CGMS[cgm]){warnings.push(`unknown CGM ${cgm}; using dexcom_g6`);cgm='dexcom_g6';}
  if(!cgm)cgm='dexcom_g6';
  let meter=meta.meter&&METERS[meta.meter]?meta.meter:null;
  if(CGMS[cgm].calibration?.required&&!meter)meter=Object.keys(METERS)[0];
  return {therapy,sensors:{cgm,meter}};
}

function seedOf(s) {let h=2166136261;for(const ch of String(s)){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);}return h>>>0;}

/**
 * Instance spec compatible with buildInstanceConfig (src/sim/instance.mjs).
 * physiology: natural parameter values; extras: {announcement, daily_sensitivity_cv, mealPlan}.
 */
export function buildSpec(trace,qc,rules,physiology,extras={}) {
  const meta=trace.meta,warnings=[];
  const {therapy,sensors}=therapyAndSensors(meta,warnings);
  const type=rules.person_type,pt=PERSONS[type];
  const prof=trace.profile,basal=Number.isFinite(rules.stats.profile_basal_u_h)?rules.stats.profile_basal_u_h:rules.stats.basal_u/24;
  const profile={};
  if(Number.isFinite(basal)&&basal>0){profile.basal_u_h=round(clamp(basal,0.01,10),3);profile.max_basal_u_h=round(clamp(Math.max(3,basal*4),profile.basal_u_h,10),2);}
  if(prof.isf_mg_dl_per_u)profile.isf_mg_dl_per_u=round(clamp(prof.isf_mg_dl_per_u,5,300),1);
  if(prof.carb_ratio_g_per_u)profile.carb_ratio_g_per_u=round(clamp(prof.carb_ratio_g_per_u,1,100),2);
  if(prof.target_mg_dl)profile.target_mg_dl=round(clamp(prof.target_mg_dl,80,180),0);
  const phys={};
  for(const k of ['sensitivity','glucose_effectiveness','basal_glucose','carb_bioavailability','meal_absorption_scale','dawn_fraction'])
    if(physiology[k]!=null)phys[k]=round(physiology[k],k==='glucose_effectiveness'?6:4);
  phys.daily_sensitivity_cv=round(clamp(extras.daily_sensitivity_cv??rules.latent_priors.day_log_sensitivity_sd,0,0.5),3);
  const overrides={
    utc_offset_minutes:clamp(Math.round(meta.utc_offset_minutes),-720,840),
    patient:{sex:meta.sex,age_years:clamp(Math.round(meta.age_years),1,120),height_cm:clamp(meta.height_cm??pt.height_cm??170,50,230),
      weight_kg:meta.weight_kg,initial_glucose_mg_dl:round(clamp(rules.stats.cgm_median,40,400),0)},
    physiology:phys,profile,
  };
  const meals=extras.mealPlan??mealPlan(trace,qc);
  if(Object.keys(meals).length)overrides.scenario={meals};
  if(extras.announcement)(overrides.scenario??={}).announcement=extras.announcement;
  if(therapy.mode==='mdi'&&trace.basal_injections.length) {
    const off=meta.utc_offset_minutes,byTime={};
    for(const d of trace.basal_injections){const k=minutesToHhmm(Math.round(localMinuteOfDay(d.t,off)/30)*30);(byTime[k]??=[]).push(d.units);}
    const times=Object.keys(byTime).filter(k=>byTime[k].length>=Math.max(1,0.5*rules.stats.days)).sort().slice(0,4);
    if(times.length)overrides.therapy={mdi:{basal_times:times,basal_dose_u:clamp(Math.round(median(times.flatMap(k=>byTime[k]))),1,200)}};
  }
  return {spec:{id:meta.id??null,seed:seedOf(meta.id??JSON.stringify(meta)),person:{type,sample:false},therapy,sensors,
    controller:{mode:'open'},events:['baseline'],overrides},warnings};
}
