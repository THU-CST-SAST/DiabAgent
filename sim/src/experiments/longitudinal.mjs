// Experiment 3 (docs/EXPERIMENTS.zh-CN.md §实验3): long-horizon self-improvement. Can an agent
// that lives with the same person for many days control better by learning that person?
//
// Pieces:
//   trueParameters(cfg)        the person's true basal need, ISF and carb ratio, derived from the
//                              resolved true sensitivity exactly like src/core/person.mjs derives
//                              the (unperturbed) profile. Evaluator-only: never shown to agents.
//   mismatchSpec(spec, ...)    the same instance with a deliberately mis-programmed profile
//                              (basal / ISF / CR off by a deterministic 20-40 %), profile_switch
//                              enabled and a routine pump refill for multi-day episodes.
//   dayMetrics(env|bundle)     true-glucose metrics and the bench score S (§5.2) per episode day.
//   runLongitudinal(spec, …)   runs one multi-day episode with an agent and returns the learning
//                              curve: per-day S/TIR/TBR, the programmed profile at each day start,
//                              its error against the truth, the profile changes and the agent memory.
//   agents                     fixed:    the patient baseline with the programmed profile unchanged;
//                              adaptive: the same baseline plus a cross-day memory that estimates
//                                        corrections from its own outcomes and reprograms the profile
//                                        with SET_PROFILE every morning (src/experiments/longitudinal-agent.mjs).
import {KNOWLEDGE} from '../knowledge.mjs';
import {equilibriumBasalUph} from '../core/physiology.mjs';
import {buildInstanceConfig} from '../sim/instance.mjs';
import {SimEnv} from '../env/pomdp.mjs';
import {Rng} from '../core/rng.mjs';
import {patientPolicy} from '../policies/patient.mjs';
import {glucoseMetrics,episodeScore,dynamicMetrics} from '../bench/score.mjs';
import {adaptiveAgent} from './longitudinal-agent.mjs';

export const EXP3_VERSION='exp3-longitudinal/0.1';
const DAY_MS=86400000,GRID_MS=5*60000;
const r4=v=>v==null||!Number.isFinite(v)?null:Number(v.toFixed(4));
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function deepMerge(a,b) {
  if(!isObject(a)||!isObject(b))return structuredClone(b);
  const out={...a};
  for(const [k,v] of Object.entries(b))out[k]=k in a&&isObject(a[k])&&isObject(v)&&k!=='meals'?deepMerge(a[k],v):structuredClone(v);
  return out;
}

// ---- truth ----------------------------------------------------------------------------------

/**
 * True therapy parameters of the person in a normalized config, from the true insulin
 * sensitivity S and weight W (person.mjs scaling, without the profile mismatch):
 *   basal = equilibrium basal(W) / S,  ISF = ISF_ref * S * W_ref / W,  CR = CR_ref * S.
 * Time-varying modifiers (dawn, daily variation, cycle, illness) multiply around these.
 */
export function trueParameters(cfg) {
  const ref=KNOWLEDGE.personModel.reference,S=cfg.physiology.sensitivity,W=cfg.patient.weight_kg;
  const basal=equilibriumBasalUph(W)/S;
  return {basal_u_h:basal,basal_u_day:basal*24,isf_mg_dl_per_u:ref.profile_isf_mg_dl_per_u*S*ref.weight_kg/W,
    carb_ratio_g_per_u:ref.profile_carb_ratio_g_per_u*S,sensitivity:S,weight_kg:W,
    basis:'person.mjs scaling of the true sensitivity (no profile mismatch); modifiers (dawn, daily cv, cycle) excluded'};
}

/** Programmed parameters as the agent sees them (observation profile). Basal as daily units. */
export function programmedParameters(obs) {
  const p=obs.profile,basalDay=p.basal_u_h!=null?p.basal_u_h*24:p.basal_injection?p.basal_injection.units*p.basal_injection.times.length:null;
  return {basal_u_day:basalDay,isf_mg_dl_per_u:p.isf_mg_dl_per_u,carb_ratio_g_per_u:p.carb_ratio_g_per_u,target_mg_dl:p.target_mg_dl,
    ...(p.basal_u_h!=null?{basal_u_h:p.basal_u_h}:{basal_dose_u:p.basal_injection?.units??null})};
}

/** Relative absolute errors |prog − true| / true per parameter and their mean. */
export function parameterErrors(prog,truth) {
  const e=(a,b)=>a==null||!b?null:Math.abs(a-b)/b;
  const out={basal:e(prog.basal_u_day,truth.basal_u_day),isf:e(prog.isf_mg_dl_per_u,truth.isf_mg_dl_per_u),cr:e(prog.carb_ratio_g_per_u,truth.carb_ratio_g_per_u)};
  const v=Object.values(out).filter(Number.isFinite);
  return {...Object.fromEntries(Object.entries(out).map(([k,x])=>[k,r4(x)])),mean:r4(v.reduce((a,b)=>a+b,0)/v.length)};
}

// ---- mis-programmed instances --------------------------------------------------------------

/**
 * Deterministic profile mismatch factors for an instance: each of basal / ISF / CR is off by a
 * magnitude in [lo, hi] with a random sign (x(1+m) or x1/(1+m)), drawn from the named stream.
 */
export function mismatchFactors(seed,{lo=0.2,hi=0.4,label='exp3-mismatch'}={}) {
  const rng=Rng.stream(seed,label),f=()=>{const m=lo+(hi-lo)*rng.next();return rng.next()<0.5?1+m:1/(1+m);};
  return {basal:r4(f()),isf:r4(f()),cr:r4(f())};
}

/**
 * The instance spec with the programmed profile set to truth x factors, SET_PROFILE enabled,
 * a routine pump refill every `refillDays` (pumps) and the given horizon. Returns
 * {spec, factors, truth}. factors default to mismatchFactors(spec.seed).
 */
export function mismatchSpec(spec,{days=7,factors=null,refillDays=2,profileSwitch=true}={}) {
  const base=buildInstanceConfig({...spec,horizon_minutes:days*1440}),truth=trueParameters(base);
  const f=factors??mismatchFactors(spec.seed);
  const pump=base.therapy.mode==='pump';
  const basal=truth.basal_u_h*f.basal;
  const profile={isf_mg_dl_per_u:Math.max(5,Math.round(truth.isf_mg_dl_per_u*f.isf)),
    carb_ratio_g_per_u:Math.max(1,Math.round(truth.carb_ratio_g_per_u*f.cr*2)/2),
    ...(pump?{basal_u_h:Number(basal.toFixed(3)),max_basal_u_h:Math.max(base.profile.max_basal_u_h,Math.ceil(truth.basal_u_h*3*10)/10)}
      :{basal_u_h:Number(basal.toFixed(3))})};
  const therapy=pump?{pump:{refill_every_days:refillDays}}
    :{mdi:{basal_dose_u:Math.max(1,Math.round(basal*24/base.therapy.mdi.basal_times.length))}};
  const overrides=deepMerge(spec.overrides??{},{profile,therapy,...(profileSwitch?{profile_switch:{enabled:true}}:{})});
  return {spec:{...spec,horizon_minutes:days*1440,overrides},factors:f,truth};
}

/**
 * Experiment 3 MVP persons: four types, two on pumps and two on pens (one scanning a flash
 * sensor), each with a person draw (person.seed = seed) and a deterministic profile mismatch.
 */
export const EXP3_PERSONS=Object.freeze([
  {id:'p1-adult-male-pump',spec:{seed:3101,person:{type:'adult_male',sample:true},therapy:{mode:'pump',pump:{model:'dana_i',insulin:'aspart'}},
    sensors:{cgm:'dexcom_g6',meter:null},events:['baseline']}},
  {id:'p2-child-female-pump',spec:{seed:3102,person:{type:'child_female',sample:true},therapy:{mode:'pump',pump:{model:'omnipod_dash',insulin:'lispro'}},
    sensors:{cgm:'dexcom_g7',meter:null},events:['baseline']}},
  {id:'p3-adult-female-pens-flash',spec:{seed:3103,person:{type:'adult_female',sample:true},therapy:{mode:'mdi',mdi:{bolus_pen:'novopen_6',bolus_insulin:'aspart',
    basal_pen:'lantus_solostar',basal_insulin:'glargine_u100'}},sensors:{cgm:'libre_2_scan',meter:'accu_chek_guide'},events:['baseline']}},
  {id:'p4-older-male-pens',spec:{seed:3104,person:{type:'older_male',sample:true},therapy:{mode:'mdi',mdi:{bolus_pen:'novopen_6',bolus_insulin:'aspart',
    basal_pen:'tresiba_flextouch',basal_insulin:'degludec'}},sensors:{cgm:'dexcom_g6',meter:null},events:['baseline']}},
].map(p=>Object.freeze({...p,spec:{...p.spec,person:{...p.spec.person,seed:p.spec.seed}}})));

// ---- per-day metrics -------------------------------------------------------------------------

/** True glucose on the 5-minute grid from evaluator states: [{t, g}] (t ms). */
function gridOf(states,start,end) {
  const by=new Map();
  for(const s of states) {
    const t=Date.parse(s.time);
    if((t-start)%GRID_MS===0&&t>=start&&t<end)by.set(t,s.true_glucose_mg_dl);
  }
  return [...by].sort((a,b)=>a[0]-b[0]).map(([t,g])=>({t,g}));
}

/**
 * Per episode day k = [start + k·24 h, start + (k+1)·24 h): true-glucose metrics on the 5-minute
 * grid (bench §5.1) and the day score S with the severe-hypoglycemia veto (§5.2). Accepts a SimEnv
 * or an exported bundle. With the default start (local midnight) days are local calendar days.
 */
export function dayMetrics(source) {
  const cfg=source.manifest?.config??source.config,states=source.evaluator_only?.states??source.evaluator;
  const start=Date.parse(cfg.start_time),H=cfg.horizon_minutes*60000,grid=gridOf(states,start,start+H),days=[];
  for(let k=0;k*DAY_MS<H;k++) {
    const from=start+k*DAY_MS,to=Math.min(start+H,from+DAY_MS),g=grid.filter(p=>p.t>=from&&p.t<to).map(p=>p.g);
    const dynamic=dynamicMetrics(grid.filter(p=>p.t>=from&&p.t<to).map(p=>({m:(p.t-start)/60000,g:p.g})),{expected_samples:(to-from)/300000});
    const m=glucoseMetrics(g),s=episodeScore({glucose:m,events:m.events,dynamic});
    days.push({day:k,from:new Date(from).toISOString(),hours:(to-from)/3600000,n:m.n??0,
      reward:r4(s.score),raw:r4(s.raw),safety_fail:s.safety_fail,tir:r4(m.tir),tbr70:r4(m.tbr70),tbr54:r4(m.tbr54),
      tar180:r4(m.tar180),tar250:r4(m.tar250),mean:r4(m.mean),cv:r4(m.cv),hypo_events:dynamic.severe_hypo_events,dynamic});
  }
  return days;
}

/** Ordinary least-squares slope of ys against 0..n-1 (per day); null for < 2 points. */
export function learningSlope(ys) {
  const pts=ys.map((y,x)=>[x,y]).filter(([,y])=>Number.isFinite(y));
  if(pts.length<2)return null;
  const mx=pts.reduce((a,p)=>a+p[0],0)/pts.length,my=pts.reduce((a,p)=>a+p[1],0)/pts.length;
  const sxx=pts.reduce((a,p)=>a+(p[0]-mx)**2,0),sxy=pts.reduce((a,p)=>a+(p[0]-mx)*(p[1]-my),0);
  return r4(sxy/sxx);
}

// ---- agents and the runner ---------------------------------------------------------------------

/** Agent factories: () => {policy(obs) -> {action, rationale}, memory?()}. All observation-only. */
export const AGENTS={
  fixed:()=>{const p=patientPolicy();return {policy:p,memory:()=>null};},
  adaptive:(opts)=>adaptiveAgent(opts),
};

/**
 * Runs one multi-day episode. spec is an instance spec (use mismatchSpec for Exp3 instances);
 * agent is a name in AGENTS or a factory. Returns {env, days, profile_by_day, errors_by_day,
 * changes, memory, summary, runtime_s}. The true parameters are only used for the evaluation
 * fields (errors_by_day), after the agent has acted.
 */
export function runLongitudinal(spec,{agent='fixed',agentOptions={},truth=null,keepEnv=true}={}) {
  const t0=performance.now();
  const cfg=buildInstanceConfig(spec),env=new SimEnv(cfg),make=typeof agent==='function'?agent:AGENTS[agent];
  if(!make)throw new Error(`Unknown agent ${agent}; one of ${Object.keys(AGENTS).join(', ')}`);
  const a=make(agentOptions),profileByDay=[];
  let nextDay=env.start;
  while(!env.done()) {
    const obs=env.observe();
    if(env.now>=nextDay){profileByDay.push({day:profileByDay.length,...programmedParameters(obs)});nextDay+=DAY_MS;}
    const d=a.policy(obs);
    env.step({action_id:`${typeof agent==='string'?agent:'agent'}-${env.step_count}`,expected_step:env.step_count,action:d.action,
      rationale:String(d.rationale??'').slice(0,4000)});
  }
  profileByDay.push({day:profileByDay.length,final:true,...programmedParameters(env.observe())});
  const T=truth??trueParameters(cfg),days=dayMetrics(env);
  const errorsByDay=profileByDay.map(p=>({day:p.day,...(p.final?{final:true}:{}),...parameterErrors(p,T)}));
  const changes=env.world.profileHistory.map(h=>structuredClone(h));
  const rewards=days.map(d=>d.reward);
  const summary={days:days.length,reward_mean:r4(rewards.reduce((s,x)=>s+x,0)/days.length),
    reward_first:days[0]?.reward??null,reward_last:days.at(-1)?.reward??null,learning_slope:learningSlope(rewards),
    tir_slope:learningSlope(days.map(d=>d.tir)),param_error_first:errorsByDay[0]?.mean??null,param_error_final:errorsByDay.at(-1)?.mean??null,
    profile_changes:changes.length,mean_abs_log_change:r4(meanAbsLogChange(changes)),episode:env.summary()};
  return {env:keepEnv?env:null,days,profile_by_day:profileByDay,errors_by_day:errorsByDay,changes,memory:a.memory?.()??null,
    truth:T,summary,runtime_s:r4((performance.now()-t0)/1000)};
}

/**
 * Hindsight-best fixed profile for the fixed (patient) agent on this exact episode: coordinate
 * search over multiplicative factors of the true basal / CR / ISF, maximizing the mean daily S.
 * Evaluator-only reference (it uses the future of the episode): how good the baseline gets with
 * the best constant settings. Returns {factors, reward_mean, evaluations, table}.
 */
export function bestFixedProfile(baseSpec,{days=7,grid={basal:[0.7,0.85,1,1.15,1.3],cr:[0.7,0.85,1,1.15,1.3,1.5,1.75],isf:[0.75,1,1.33]},sweeps=2}={}) {
  const cache=new Map();
  const evalF=f=>{
    const k=JSON.stringify(f);
    if(!cache.has(k)){const {spec}=mismatchSpec(baseSpec,{days,factors:f,profileSwitch:false});cache.set(k,runLongitudinal(spec,{agent:'fixed',keepEnv:false}).summary.reward_mean);}
    return cache.get(k);
  };
  let best={basal:1,cr:1,isf:1},bestS=evalF(best);
  for(let s=0;s<sweeps;s++)for(const key of ['cr','basal','isf'])for(const v of grid[key]) {
    const f={...best,[key]:v},S=evalF(f);
    if(S>bestS+1e-9){best=f;bestS=S;}
  }
  return {factors:best,reward_mean:bestS,evaluations:cache.size,table:[...cache].map(([k,v])=>({factors:JSON.parse(k),reward_mean:v}))};
}

/** Mean |ln(to/from)| over all numeric field changes (size of profile changes). */
function meanAbsLogChange(changes) {
  const xs=[];
  for(const h of changes)for(const c of Object.values(h.changes))if(c.from>0&&c.to>0)xs.push(Math.abs(Math.log(c.to/c.from)));
  return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;
}
