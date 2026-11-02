// B4 "完整开源闭环": AAPS-style oref1 (determine-basal with SMB and UAM) plus the user's meal
// boluses, observation-only. The existing src/policies/oref0.mjs (temp basals only, no meal
// bolus, no SMB) stays as the B4- ablation.
//
// What is added over oref0.mjs:
//   * super micro boluses (microBolusAllowed, enableSMB_always / _with_COB / _after_carbs) and
//     unannounced-meal (UAM) predictions with deviation slopes computed from the observed CGM
//     history and the insulin activity of the visible ledger (an approximation of oref0
//     lib/meal/total.js + lib/determine-basal/cob.js, which are not vendored);
//   * a light autosens from the policy's own memory of deviations (last 8 h outside the 4 h after
//     reported carbs, >= 4 h of data; ratio = 1 + median*12/ISF/basal, clamped 0.7-1.2, like
//     oref0 lib/determine-basal/autosens.js);
//   * an activity temp target of 140 mg/dL from 60 min before to 60 min after a planned aerobic
//     session (AAPS "Activity" temp target; exercise_mode / high_temptarget_raises_sensitivity);
//   * the user layer of care.mjs (guideline user): meal boluses via the AAPS bolus wizard on
//     announced meals, hypo treatment, device hygiene, sensor fallback.
// Settings follow AAPS defaults / documentation (maxSMBBasalMinutes 30, maxUAMSMBBasalMinutes 30,
// SMB interval >= 3 min, here >= the 15-min device bolus interval); max_iob is set from the
// profile (3x hourly basal + one 60 g meal dose), as the AAPS docs suggest for new loopers (待核实).
// Sources: OpenAPS docs (oref1, SMB, UAM), AndroidAPS docs (SMB, temp targets, autosens).
//
// Applicability: pumps with a real-time CGM (N/A on pens). Without live CGM the loop is
// inactive and the scheduled basal runs; the user layer covers the gap.
import {createRequire} from 'node:module';
import {iobAt} from '../core/estimators.mjs';
import {makeCarePolicy,cgmLive,canBolus,tempBasalAction,basalMatches} from './care.mjs';
import {zoneFree} from './oref0.mjs';
const require=createRequire(import.meta.url);
const determineBasal=require('../../vendor/oref0/lib/determine-basal/determine-basal.js');
const tempFunctions=require('../../vendor/oref0/lib/basal-set-temp.js');

const FIVE_MIN=300000,MIN=60000;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));

/** Deviations (observed 15-min average delta per 5 min minus insulin BGI) over the CGM history, newest last. */
export function deviations(obs) {
  const p=obs.profile,curve=obs.insulin.rapid_iob_curve;
  const ledger=obs.device.insulin_ledger.map(d=>({at:Date.parse(d.time),units:d.units,kind:d.kind}));
  const pts=obs.cgm_history.map(r=>({at:Date.parse(r.time),v:r.value_mg_dl})).filter(x=>finite(x.v));
  const out=[];
  for(let i=3;i<pts.length;i++) {
    const a=pts[i],b=pts[i-3],dt=(a.at-b.at)/FIVE_MIN;
    if(dt<2.5||dt>3.5)continue;                    // needs a contiguous 15-min window
    const avgDelta=(a.v-b.v)/dt,act=iobAt(ledger,a.at,p.dia_hours,curve).activity;
    const bgi=-act*p.isf_mg_dl_per_u*5;
    out.push({at:a.at,dev:avgDelta-bgi,bgi,avgDelta});
  }
  return out;
}

/** Meal-data slopes like oref0 cob.js: how fast deviations fell since their peak / rose since their trough. */
export function deviationSlopes(devs) {
  if(!devs.length)return {slopeFromMaxDeviation:0,slopeFromMinDeviation:0,currentDeviation:0};
  const cur=devs.at(-1);let maxDev=cur.dev,minDev=cur.dev,sMax=0,sMin=0;
  for(let i=devs.length-2;i>=0;i--) {
    const d=devs[i],slope=(cur.dev-d.dev)/((cur.at-d.at)/FIVE_MIN);
    if(d.dev>maxDev){maxDev=d.dev;sMax=Math.min(0,slope);}
    if(d.dev<minDev){minDev=d.dev;sMin=Math.max(0,slope);}
  }
  return {slopeFromMaxDeviation:sMax,slopeFromMinDeviation:sMin,currentDeviation:cur.dev};
}

/**
 * Autosens memory: deviations collected step by step (the policy's own memory of what it saw),
 * ratio from the median deviation of the last 8 h outside the 4 h after reported carbs, once at
 * least 4 h of such data exist (oref0 autosens: ratio = 1 + median*12/ISF/basal, 0.7-1.2).
 */
export function makeAutosens({windowHours=8,minHours=4,state=null}={}) {
  const devs=new Map(state?.devs??[]),carbs=new Set(state?.carbs??[]);
  return {
    snapshot:()=>({devs:[...devs],carbs:[...carbs]}),
    update(obs,list) {
      for(const d of list)devs.set(d.at,d.dev);
      for(const c of obs.reported_carbs??[])carbs.add(Date.parse(c.time));
      const now=Date.parse(obs.virtual_time);
      for(const t of devs.keys())if(t<now-windowHours*3600000)devs.delete(t);
    },
    ratio(obs) {
      const p=obs.profile,base=obs.device.scheduled_basal_u_h??p.basal_u_h;
      if(!(base>0))return null;
      const free=[...devs].filter(([t])=>![...carbs].some(c=>t>=c&&t-c<=4*3600000)).map(([,v])=>v).sort((a,b)=>a-b);
      if(free.length<minHours*12)return null;
      const med=free[Math.floor(free.length/2)];
      return clamp(1+med*12/p.isf_mg_dl_per_u/base,0.7,1.2);
    },
  };
}

/** oref1 recommendation for an observation (null when there are fewer than 3 CGM samples). */
export function oref1Recommendation(obs,{tempTarget=null,smb=true,autosens=null}={}) {
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
  const base=obs.device.scheduled_basal_u_h??p.basal_u_h;
  const spec=obs.action_specs.BOLUS?.units;
  const target=tempTarget??p.target_mg_dl;
  const profile={current_basal:base,max_basal:p.max_basal_u_h,max_daily_basal:base,
    max_daily_safety_multiplier:3,current_basal_safety_multiplier:4,
    max_iob:Number((3*base+60/p.carb_ratio_g_per_u).toFixed(2)),               // 待核实 (AAPS docs heuristic)
    min_bg:target,max_bg:target,sens:p.isf_mg_dl_per_u,carb_ratio:p.carb_ratio_g_per_u,dia:p.dia_hours,
    curve:curve.curve,useCustomPeakTime:true,insulinPeakTime:curve.peak_minutes,
    autosens_max:1.2,autosens_min:0.7,enableUAM:true,
    enableSMB_always:smb,enableSMB_with_COB:smb,enableSMB_after_carbs:smb,enableSMB_with_temptarget:smb,
    allowSMB_with_high_temptarget:false,maxSMBBasalMinutes:30,maxUAMSMBBasalMinutes:30,SMBInterval:10,
    temptargetSet:tempTarget!=null,exercise_mode:true,high_temptarget_raises_sensitivity:true,half_basal_exercise_target:160,
    bolus_increment:spec?.step??0.1,skip_neutral_temps:false,carbsReqThreshold:1,out_units:'mg/dL',A52_risk_enable:false};
  const devs=deviations(obs),sl=deviationSlopes(devs.filter(d=>d.at>=now-3*3600000));
  if(autosens)autosens.update(obs,devs);
  const ratio=autosens?autosens.ratio(obs):null;
  const carbTimes=obs.reported_carbs.map(c=>Date.parse(c.time));
  const meal={mealCOB:obs.cob.estimate_g,carbs:obs.cob.absorbing_reported_g,lastCarbTime:Math.max(0,...carbTimes),
    slopeFromMaxDeviation:sl.slopeFromMaxDeviation,slopeFromMinDeviation:sl.slopeFromMinDeviation,currentDeviation:sl.currentDeviation,bwFound:false};
  const saved=console.error,savedWrite=process.stderr.write,log=[];console.error=(...v)=>log.push(v.join(' '));
  process.stderr.write=(chunk,encoding,callback)=>{log.push(String(chunk));(typeof encoding==='function'?encoding:callback)?.();return true;};
  try {
    const r=determineBasal({glucose:current.value,date:current.at,delta:(current.value-last.value)/Math.max(1,(current.at-last.at)/FIVE_MIN),
      short_avgdelta:avg(15),long_avgdelta:avg(40),noise:0,device:'fakecgm'},
      {rate:obs.device.current_basal_u_h,duration:temp?temp.remaining_minutes:0},iobs,profile,{ratio:ratio??1},meal,tempFunctions,smb,100,new Date(now));
    return Object.assign(zoneFree(r),{autosens:ratio??1,slopes:sl});
  } finally {console.error=saved;process.stderr.write=savedWrite;}
}

const nonfinite=r=>Object.entries(r).some(([k,v])=>k!=='autosens'&&typeof v==='number'&&!Number.isFinite(v))||/NaN|Infinity/.test(r.reason??'');

/** The loop part (care.mjs loop interface). */
export function oref1Loop({smb=true}={}) {
  const autosens=makeAutosens();
  return {
    name:smb?'B4':'B4-noSMB',
    active:obs=>obs.device.type==='pump'&&cgmLive(obs,10)&&(obs.cgm_history?.length??0)>=3,
    decide(obs,care) {
      const dev=obs.device,specs=obs.action_specs,p=obs.profile;
      if(dev.stop_reason)return null;
      const ex=care.exerciseMode(obs);
      // Assisted track: no SMB. In the simulator any device bolus blocks the person's own meal bolus
      // for the 15-min bolus interval (real pumps accept it), so SMBs every 15 min would hide the
      // person's meal boluses; the loop then works through temp basals only (UAM still on).
      const assisted=obs.profile.self_care==='assisted';
      const r=oref1Recommendation(obs,{tempTarget:ex?140:null,smb:smb&&!assisted&&!care.personPending,autosens});
      if(!r||nonfinite(r))return null;
      const reason=`${smb?'B4':'B4-noSMB'} oref1${ex?' (activity TT 140)':''}: ${r.reason??''}`.slice(0,600);
      // AAPS shows "carbs required" notifications; the user eats them (at most every 20 min).
      const now=Date.parse(obs.virtual_time);
      if(finite(r.carbsReq)&&r.carbsReq>=5&&specs.INGEST_CARBS&&now-care.st.lastRescueAt>=20*MIN) {
        care.st.lastRescueAt=now;const gr=Math.min(20,Math.round(r.carbsReq));
        return {action:{type:'INGEST_CARBS',grams:gr},rationale:`oref1 carbsReq ${r.carbsReq} g -> eat ${gr} g; ${reason}`.slice(0,700)};
      }
      if(finite(r.units)&&r.units>0&&canBolus(obs)&&!care.personPending&&!assisted) {
        const step=specs.BOLUS.units.step||0.05,u=Math.min(specs.BOLUS.units.max,Math.floor(r.units/step+1e-9)*step);
        if(u>0){const c=care.st.lastCorrection;
          if((!c||now-c.at>240*MIN)&&obs.glucose.value_mg_dl>=250)care.st.lastCorrection={at:now,bg:obs.glucose.value_mg_dl};   // anchor for the site-failure check
          return {action:{type:'BOLUS',units:Number(u.toFixed(3))},rationale:`SMB ${u} U; ${reason}`};}
      }
      if(!(finite(r.rate)&&r.duration>0)||!specs.TEMP_BASAL)return null;
      const base=dev.scheduled_basal_u_h??p.basal_u_h??0;
      let rate=clamp(r.rate,0,p.max_basal_u_h??r.rate);
      if(care.personPending)rate=Math.min(rate,base);       // assisted: no high temp while the person's bolus is pending
      if(basalMatches(obs,rate,{minLeft:10,tol:0.05}))return null;
      const a=tempBasalAction(obs,rate,Math.round(r.duration));
      return a?{action:a,rationale:reason}:null;
    },
  };
}

/** B4 policy factory: guideline user + oref1 (SMB + UAM). */
export const oref1Policy=()=>makeCarePolicy({level:'guideline',loop:oref1Loop()});
