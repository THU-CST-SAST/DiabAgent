// Shared pieces of the reference deciders (src/oracle): a smooth glucose risk cost (Kovatchev), device-aware
// candidate actions and exact rollouts of a World snapshot.
//
// Two deciders build on these:
//   omniscient.mjs  全知信息决策 — knows the true state, true parameters and every future event;
//                   its result is the best achievable outcome on that backend (an upper bound).
//   causal.mjs      因果最优决策 — uses only what the agent could observe up to now plus public priors;
//                   the best a real agent could be expected to do with the same information.
// Both choose only among actions the instance's hardware accepts (obs.action_specs), so a pump
// on a percent temp-basal grid, a pen with 1 U steps or a meter-only setup each get their own
// action set and step sizes.
import {World} from '../sim/world.mjs';
import {actionSpecs} from '../sim/actions.mjs';

const FIVE_MIN=5*60000;

/**
 * Kovatchev symmetric BG risk (Kovatchev et al. 1997/2001, the function behind LBGI/HBGI):
 * f = 1.509·((ln g)^1.084 − 5.381), r = 10·f², g in mg/dL. 0 at about 112.5 mg/dL; the log-power
 * transform makes the hypo and hyper ranges symmetric, so risk rises steeply for lows and gently
 * for highs (r ≈ 7.8 at 70 and 180 mg/dL, ≈ 22.5 at 50 and 250 mg/dL). This was previously
 * mislabeled as the Magni et al. 2007 risk, which is a different function.
 */
export function kovatchevRisk(g) {
  const v=Math.max(10,g);
  return 10*(1.509*(Math.log(v)**1.084-5.381))**2;
}
/** @deprecated Misnamed alias of kovatchevRisk (same function); kept for existing imports. */
export const magniRisk=kovatchevRisk;
/** Cost of a glucose trace: mean Kovatchev risk, with extra weight on hypoglycemia (configurable). */
export function traceCost(glucose,{hypoWeight=3,severeWeight=10}={}) {
  if(!glucose.length)return 0;
  let s=0;
  for(const g of glucose)s+=kovatchevRisk(g)*(g<54?severeWeight:g<70?hypoWeight:1);
  return s/glucose.length;
}

const quantize=(v,step)=>step?Math.round(v/step)*step:v;
const fix=v=>Number(v.toFixed(3));
const BOLUS_GRID=[0.5,1,1.5,2,3,4,5,6,8,10,12,15];

/**
 * Candidate actions at the current state, derived from the instance's action specs: bolus sizes on
 * the device step, temp basals on the pump's own grid (percent or absolute), extended bolus where
 * the pump supports it, short suspension, rescue carbs. Options can narrow or widen the set.
 */
export function candidateActions(world,{bolusGrid=BOLUS_GRID,rescueGrams=[10,20],tempMinutes=30,extended=true,suspend=true}={}) {
  const s=actionSpecs(world),out=[{type:'WAIT'}];
  if(s.BOLUS) {
    const u=s.BOLUS.units,seen=new Set();
    for(const b of bolusGrid){const v=fix(quantize(b,u.step));if(v>u.min&&v<=u.max&&!seen.has(v)){seen.add(v);out.push({type:'BOLUS',units:v});}}
  }
  if(s.TEMP_BASAL) {
    const t=s.TEMP_BASAL,d=Math.max(t.duration_minutes.min,quantize(tempMinutes,t.duration_minutes.step??1));
    const percentNative=!!t.percent.step;
    for(const f of [0,0.5,1.5,2]) {
      if(percentNative){const p=quantize(f*100,t.percent.step);if(p<=t.percent.max)out.push({type:'TEMP_BASAL',percent:p,duration_minutes:d});}
      else {const r=fix(quantize(f*world.device.scheduledBasalUph,t.rate_u_h.step));if(r<=t.rate_u_h.max)out.push({type:'TEMP_BASAL',rate_u_h:r,duration_minutes:d});}
    }
  }
  if(extended&&s.EXTENDED_BOLUS) {
    const e=s.EXTENDED_BOLUS,d=quantize(120,e.duration_minutes.step??1);
    for(const b of [2,4]){const v=fix(quantize(b,e.units.step));if(v<=e.units.max&&d<=e.duration_minutes.max)out.push({type:'EXTENDED_BOLUS',units:v,duration_minutes:d});}
  }
  if(suspend&&s.SUSPEND_PUMP) {
    const opts=s.SUSPEND_PUMP.minutes.enum??[30];
    for(const m of [30,60])if(opts.includes(m))out.push({type:'SUSPEND_PUMP',minutes:m});
  }
  if(s.INGEST_CARBS)for(const g of rescueGrams)if(g<=s.INGEST_CARBS.grams.max)out.push({type:'INGEST_CARBS',grams:g});
  return out;
}

/**
 * Exact rollout from a World snapshot: applies `plan` ([{at, action}], absolute ms, sorted) and
 * an optional `continuation(world)` policy called every 5 minutes, integrates to `until` with
 * sensors and any built-in controller running, and returns the true-glucose trace sampled every
 * 5 minutes plus its cost. Rejected actions are counted, not thrown.
 */
export function rollout(snapshot,{plan=[],until,continuation=null,cost={}}={}) {
  const w=World.restore(snapshot),glucose=[];let rejected=0,i=0,n=0;
  for(let t=w.now;t<until&&!w.terminated;) {
    while(i<plan.length&&plan[i].at<=t){if(w.apply(plan[i].action,`plan-${i}`,'oracle').status!=='applied')rejected++;i++;}
    if(continuation){const a=continuation(w);if(a&&a.type!=='WAIT'&&w.apply(a,`cont-${n++}`,'oracle').status!=='applied')rejected++;}
    const next=Math.min(until,t+FIVE_MIN,plan[i]?.at??Infinity);
    w.advanceTo(next,{sample:true});t=w.now;
    if((t-snapshot.start)%FIVE_MIN===0||t===until)glucose.push(w.physiology.glucose());
  }
  return {cost:w.terminated?Infinity:traceCost(glucose,cost),glucose,rejected,terminated:w.terminated,world:w};
}

/** Human-readable label of an action, for decision logs. */
export function actionLabel(a) {
  switch(a.type) {
    case 'WAIT':return 'WAIT';
    case 'BOLUS':return `BOLUS ${a.units} U`;
    case 'TEMP_BASAL':return `TEMP_BASAL ${a.percent!=null?a.percent+'%':a.rate_u_h+' U/h'} ${a.duration_minutes} min`;
    case 'EXTENDED_BOLUS':return `EXTENDED_BOLUS ${a.units} U / ${a.duration_minutes} min`;
    case 'SUSPEND_PUMP':return `SUSPEND_PUMP ${a.minutes} min`;
    case 'INGEST_CARBS':return `INGEST_CARBS ${a.grams} g`;
    default:return JSON.stringify(a);
  }
}
