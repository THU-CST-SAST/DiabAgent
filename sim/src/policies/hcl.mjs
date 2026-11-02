// B3 "商用闭环": a commercial-like hybrid closed loop (Control-IQ-style), observation-only.
//
// Algorithm (simplified from the public descriptions: Brown SA et al., NEJM 2019;381:1707
// (iDCL / Control-IQ); Breton MD, Kovatchev BP, Diabetes Technol Ther 2021;23:601 (real-world Control-IQ,
// 待核实); Tandem t:slim X2 Control-IQ user guide): every 5 min glucose is predicted 30 min ahead
// from the CGM value and its 25-min least-squares trend, then
//   pred < 70            -> basal 0 (suspend-like)
//   pred < 112.5         -> basal reduced proportionally
//   112.5 <= pred <= 160 -> scheduled basal
//   pred > 160           -> basal increased to deliver (pred - 110)/ISF - IOB over 1 h, at most
//                           3x the scheduled rate and the pump maximum
//   pred > 180           -> automatic correction bolus 60% of ((pred - 110)/ISF - IOB), at most
//                           6 U, at most once per hour, never in sleep or exercise activity
// Sleep activity 23:00-07:00 (112.5-120 target, no automatic boluses). Exercise activity (the
// user switches it on for a planned aerobic session, 60 min before to 60 min after): 140-160 and
// no automatic boluses. Meal boluses are the user's (calculator on announced meals, see
// care.mjs); the user layer is the guideline user (B2) minus manual corrections and temp basals
// while the loop runs.
//
// Applicability: pumps with a real-time CGM. On pens there is no loop (N/A; the runner does not
// run it). Without CGM data (warm-up, signal loss) the loop is inactive and the pump runs the
// scheduled basal; the user layer (B2) acts as open-loop therapy until readings return.
// Simplifications vs the real device: no model-based prediction with insulin-on-board dynamics,
// no TDD-adaptive gains, fixed activity windows.
import {makeCarePolicy,cgmLive,smoothedTrend,freshGlucose,localClock,canBolus,quantBolus,tempBasalAction,basalMatches} from './care.mjs';

const MIN=60000;
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
export const HCL_SETTINGS=Object.freeze({
  horizonMinutes:30,trendMinutes:25,suspendBelow:70,lowTarget:112.5,highTarget:160,correctTarget:110,
  autoBolusAbove:180,autoBolusFraction:0.6,autoBolusMaxU:6,autoBolusEveryMinutes:60,
  maxBasalFactor:3,sleep:{from:23*60,to:7*60,high:120},exercise:{low:140,high:160,suspendBelow:80},
});

/** The loop part (care.mjs loop interface). */
export function hclLoop(settings=HCL_SETTINGS,{state=null}={}) {
  const S=settings;let lastAutoBolusAt=state?.lastAutoBolusAt??-Infinity,lastSample=state?.lastSample??null;
  return {
    snapshot:()=>({lastAutoBolusAt:Number.isFinite(lastAutoBolusAt)?lastAutoBolusAt:null,lastSample}),
    name:'B3',
    active:obs=>obs.device.type==='pump'&&cgmLive(obs,10),
    decide(obs,care) {
      const now=Date.parse(obs.virtual_time),dev=obs.device,p=obs.profile,specs=obs.action_specs;
      const g=freshGlucose(obs,10);if(!g)return null;
      if(dev.stop_reason)return null;
      const sample=obs.cgm.sample_time;
      const trend=clamp(smoothedTrend(obs,S.trendMinutes)??0,-4,4),pred=g.value+trend*S.horizonMinutes;
      const {minute}=localClock(obs);
      const sleep=minute>=S.sleep.from||minute<S.sleep.to,ex=care.exerciseMode(obs);
      const low=ex?S.exercise.low:S.lowTarget,high=ex?S.exercise.high:sleep?S.sleep.high:S.highTarget;
      const suspendBelow=ex?S.exercise.suspendBelow:S.suspendBelow;
      const base=dev.scheduled_basal_u_h??p.basal_u_h??0,iob=obs.iob?.total_u??0;
      // Assisted track: no automatic boluses (in the simulator a device bolus blocks the person's
      // own meal bolus for 15 min; real pumps accept it). Basal modulation only.
      const assisted=p.self_care==='assisted';
      const tag=`B3 (pred30 ${Math.round(pred)}, ${ex?'exercise':sleep?'sleep':'normal'})`;
      // Automatic correction bolus (once per hour; not in sleep/exercise; never while the person's meal bolus is pending).
      if(!sleep&&!ex&&!assisted&&pred>S.autoBolusAbove&&now-lastAutoBolusAt>=S.autoBolusEveryMinutes*MIN&&!care.personPending&&canBolus(obs)) {
        const want=Math.min(S.autoBolusMaxU,S.autoBolusFraction*((pred-S.correctTarget)/p.isf_mg_dl_per_u-Math.max(0,iob)));
        const u=quantBolus(obs,want);
        if(u>0){lastAutoBolusAt=now;const c=care.st.lastCorrection;
          if((!c||now-c.at>240*MIN)&&g.value>=250)care.st.lastCorrection={at:now,bg:g.value};   // anchor for the site-failure check
          return {action:{type:'BOLUS',units:u},rationale:`${tag}: automatic correction 60% x ((${Math.round(pred)}-110)/${p.isf_mg_dl_per_u} - IOB ${iob.toFixed(2)})`};}
      }
      if(!specs.TEMP_BASAL||!(base>0))return null;
      let rate;
      if(pred<suspendBelow)rate=0;
      else if(pred<low)rate=base*clamp((pred-suspendBelow)/(low-suspendBelow),0,1);
      else if(pred<=high)rate=base;
      else rate=base+Math.max(0,(pred-S.correctTarget)/p.isf_mg_dl_per_u-Math.max(0,iob));
      const maxRate=Math.min(p.max_basal_u_h??Infinity,specs.TEMP_BASAL.rate_u_h?.max??Infinity,base*S.maxBasalFactor);
      rate=clamp(rate,0,maxRate);
      // Assisted: no basal above the schedule while the person's meal bolus is still expected.
      if(care.personPending)rate=Math.min(rate,base);
      const newSample=sample!==lastSample;lastSample=sample;
      if(Math.abs(rate-base)<=Math.max(0.05,0.1*base)) {
        if(dev.temp_basal&&specs.CANCEL_TEMP_BASAL&&newSample&&Math.abs((dev.current_basal_u_h??base)-base)>0.2*base)return {action:{type:'CANCEL_TEMP_BASAL'},rationale:`${tag}: back to scheduled basal`};
        return null;
      }
      // Hysteresis: keep a running temp unless the new rate differs by > 20% of the scheduled basal.
      if(basalMatches(obs,rate,{minLeft:10,tol:Math.max(0.05,0.2*base)}))return null;
      const a=tempBasalAction(obs,rate,30);
      return a?{action:a,rationale:`${tag}: basal ${rate.toFixed(2)} U/h (scheduled ${base.toFixed(2)})`}:null;
    },
  };
}

/** B3 policy factory: guideline user + Control-IQ-like loop. */
export const hclPolicy=()=>makeCarePolicy({level:'guideline',loop:hclLoop()});
