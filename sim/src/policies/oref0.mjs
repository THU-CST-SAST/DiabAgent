// oref0 0.7.1 determine-basal as an observation-only baseline policy.
// Adapted from sweet-sim src/controller.js, with one fix: meal_data.carbs is the
// reported carbs still absorbing, the same set behind mealCOB. Upstream summed
// a 6 h window while COB came from the gut model, so COB>0 with carbs=0 made
// determine-basal emit NaN/Infinity.
import {createRequire} from 'node:module';
import {iobAt} from '../core/estimators.mjs';
const require=createRequire(import.meta.url);
const determineBasal=require('../../vendor/oref0/lib/determine-basal/determine-basal.js');
const tempFunctions=require('../../vendor/oref0/lib/basal-set-temp.js');

const FIVE_MIN=300000;

// determine-basal concatenates Date objects into its strings, which prints them in the host time zone
// ("Wed Oct 14 2026 07:10:00 GMT+0800 (China Standard Time)"). Rewritten as UTC ISO so rationales,
// trajectories and their hashes do not depend on the machine running the episode.
const LOCAL_DATE=/\b(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}(?: \([^)]*\))?/g;
const isoDate=s=>{const t=Date.parse(s.replace(/ \([^)]*\)$/,''));return Number.isFinite(t)?new Date(t).toISOString():s;};
/** Host-time-zone-free copy of a determine-basal result's strings (mutates and returns r). */
export function zoneFree(r) {
  if(r&&typeof r==='object')for(const [k,v] of Object.entries(r))if(typeof v==='string')r[k]=v.replace(LOCAL_DATE,isoDate);
  return r;
}

export function oref0Recommendation(obs) {
  const now=Date.parse(obs.virtual_time),p=obs.profile;
  const points=obs.cgm_history.map(r=>({at:Date.parse(r.time),value:r.value_mg_dl}));
  if(points.length<3)return null;
  const current=points.at(-1),last=points.at(-2);
  const avg=minutes=>{
    const old=[...points].reverse().find(r=>r.at<=now-minutes*60000)??points[0];
    return (current.value-old.value)/Math.max(1,(current.at-old.at)/FIVE_MIN);
  };
  const curve=obs.insulin.rapid_iob_curve;
  const ledger=obs.device.insulin_ledger.map(d=>({at:Date.parse(d.time),units:d.units,kind:d.kind}));
  const temp=obs.device.temp_basal;
  const lastBolusTime=Math.max(0,...ledger.filter(d=>d.kind==='bolus').map(d=>d.at));
  const iobs=Array.from({length:48},(_,i)=>{
    const r=iobAt(ledger,now+i*FIVE_MIN,p.dia_hours,curve);
    return {iob:r.iob,activity:r.activity,basaliob:r.basal_iob,bolusiob:r.bolus_iob,time:new Date(now+i*FIVE_MIN).toISOString(),
      iobWithZeroTemp:{iob:r.iob,activity:r.activity},lastBolusTime,
      lastTemp:{date:temp?Date.parse(temp.started_at):now,duration:temp?(Date.parse(temp.ends_at)-Date.parse(temp.started_at))/60000:0,rate:obs.device.current_basal_u_h}};
  });
  const profile={current_basal:p.basal_u_h,max_basal:p.max_basal_u_h,max_daily_basal:p.basal_u_h,
    max_daily_safety_multiplier:3,current_basal_safety_multiplier:4,max_iob:3,min_bg:p.target_mg_dl,max_bg:p.target_mg_dl,
    sens:p.isf_mg_dl_per_u,carb_ratio:p.carb_ratio_g_per_u,dia:p.dia_hours,curve:curve.curve,useCustomPeakTime:true,insulinPeakTime:curve.peak_minutes,
    autosens_max:1.2,autosens_min:.7,enableUAM:true,enableSMB_always:false,temptargetSet:false,
    bolus_increment:.05,skip_neutral_temps:false,carbsReqThreshold:1,out_units:'mg/dL'};
  const carbTimes=obs.reported_carbs.map(c=>Date.parse(c.time));
  const meal={mealCOB:obs.cob.estimate_g,carbs:obs.cob.absorbing_reported_g,lastCarbTime:Math.max(0,...carbTimes),
    slopeFromMaxDeviation:0,slopeFromMinDeviation:0,bwFound:false};
  // oref0 logs heavily to stderr; capture it rather than flood batch output.
  const saved=console.error,savedWrite=process.stderr.write,log=[];console.error=(...v)=>log.push(v.join(' '));
  process.stderr.write=(chunk,encoding,callback)=>{log.push(String(chunk));(typeof encoding==='function'?encoding:callback)?.();return true;};
  try {
    return zoneFree(determineBasal({glucose:current.value,date:current.at,delta:(current.value-last.value)/Math.max(1,(current.at-last.at)/FIVE_MIN),
      short_avgdelta:avg(15),long_avgdelta:avg(40),noise:0,device:'fakecgm'},
      {rate:obs.device.current_basal_u_h,duration:temp?temp.remaining_minutes:0},iobs,profile,{ratio:1},meal,tempFunctions,false,100,new Date(now)));
  } finally {console.error=saved;process.stderr.write=savedWrite;}
}

const nonfinite=r=>Object.values(r).some(v=>typeof v==='number'&&!Number.isFinite(v))||/NaN|Infinity/.test(r.reason??'');

const FRESH_MINUTES=30;              // older glucose does not justify any dosing change
const MDI_CORRECTION_ABOVE=180;     // MDI: correct only clearly high, fresh readings
const MDI_CORRECTION_MARGIN=30;     // ... down to target + margin (undershoot-averse)
const MDI_MIN_HOURS_SINCE_BOLUS=3;  // ... and never stack on a recent bolus

const wait=rationale=>({action:{type:'WAIT'},rationale,nonfinite:false});
const finite=v=>typeof v==='number'&&Number.isFinite(v);

/** Freshest visible glucose from any sensor (CGM, scan or fingerstick), or null. */
function freshGlucose(obs) {
  const g=obs.glucose;
  return g&&finite(g.value_mg_dl)&&finite(g.age_minutes)&&g.age_minutes<=FRESH_MINUTES?g:null;
}

/**
 * Pens: oref0 has no temp basals to work with. Offers at most a conservative correction bolus:
 * fresh glucose above 180 mg/dL, no bolus in the last 3 h, dose = (BG - (target + 30)) / ISF - IOB,
 * rounded down to the pen step and capped by the action spec. Never doses for meals.
 */
function mdiCorrection(obs) {
  const g=freshGlucose(obs),p=obs.profile,spec=obs.action_specs?.BOLUS?.units;
  if(!g)return wait('MDI: no recent glucose; no correction');
  if(g.value_mg_dl<MDI_CORRECTION_ABOVE)return wait(`MDI: glucose ${Math.round(g.value_mg_dl)} mg/dL below correction threshold`);
  if(!spec||!finite(p.isf_mg_dl_per_u)||!(p.isf_mg_dl_per_u>0))return wait('MDI: no bolus spec or ISF');
  const last=obs.device.last_bolus,now=Date.parse(obs.virtual_time);
  if(last&&now-Date.parse(last.time)<MDI_MIN_HOURS_SINCE_BOLUS*3600000)return wait('MDI: recent bolus; no stacking');
  const iob=finite(obs.iob?.total_u)?Math.max(0,obs.iob.total_u):0;
  const raw=(g.value_mg_dl-(p.target_mg_dl+MDI_CORRECTION_MARGIN))/p.isf_mg_dl_per_u-iob;
  const step=spec.step||0.5,units=Math.min(spec.max,Math.floor(raw/step+1e-9)*step);
  if(!(units>0)||!finite(units))return wait('MDI: correction below one pen step after IOB');
  return {action:{type:'BOLUS',units:Number(units.toFixed(3))},rationale:`MDI correction: BG ${Math.round(g.value_mg_dl)}, IOB ${iob.toFixed(2)} U`,nonfinite:false};
}

/**
 * Maps a recommendation to an environment action. Never returns a bolus on a pump.
 * Pump with a real-time CGM: oref0 temp basals. Pump without a real-time CGM (meter-only or
 * flash): oref0 on the freshest reading with flat deltas, accepted only as a reduction
 * below the scheduled basal; otherwise the scheduled basal continues (WAIT).
 * Pens: see mdiCorrection.
 * Returns {action, rationale, nonfinite, recommendation}; recommendation is the raw oref0
 * determine-basal output behind the decision, or null when oref0 was not run.
 */
export function oref0Policy(obs) {
  if(obs.device?.type!=='pump')return {...mdiCorrection(obs),recommendation:null};
  const {recommendation=null,...decision}=pumpDecision(obs);
  return {...decision,recommendation};
}

function pumpDecision(obs) {
  if(!obs.cgm) {
    const g=freshGlucose(obs);
    if(!g)return wait('oref0: no recent glucose; scheduled basal continues');
    const at=g.time;
    const r=oref0Recommendation({...obs,cgm_history:[0,5,10].map(()=>({time:at,value_mg_dl:g.value_mg_dl}))});
    if(!r||nonfinite(r))return {...wait(`oref0 (sparse glucose): ${r?.reason??'no output'}`.slice(0,500)),nonfinite:!!r,recommendation:r};
    if(!(finite(r.rate)&&r.duration>0)||r.rate>=obs.profile.basal_u_h)
      return {...wait(`oref0 (sparse glucose, reductions only): ${r.reason??'no change'}`.slice(0,500)),recommendation:r};
    return {action:{type:'TEMP_BASAL',rate_u_h:Math.max(0,r.rate),duration_minutes:Math.round(r.duration)},
      rationale:`oref0 (sparse glucose): ${r.reason??''}`.slice(0,500),nonfinite:false,recommendation:r};
  }
  if(!finite(obs.cgm.value_mg_dl))return wait('oref0: no CGM data');
  const r=oref0Recommendation(obs);
  if(!r)return wait('oref0: fewer than 3 CGM samples');
  if(nonfinite(r))return {action:{type:'WAIT'},rationale:`oref0 nonfinite output: ${r.reason??''}`.slice(0,500),nonfinite:true,recommendation:r};
  if(!(Number.isFinite(r.rate)&&r.duration>0))return {...wait(`oref0: ${r.reason??'no change'}`.slice(0,500)),recommendation:r};
  const rate=Math.min(obs.profile.max_basal_u_h,Math.max(0,r.rate));
  return {action:{type:'TEMP_BASAL',rate_u_h:rate,duration_minutes:Math.round(r.duration)},rationale:`oref0: ${r.reason??''}`.slice(0,500),nonfinite:false,recommendation:r};
}
