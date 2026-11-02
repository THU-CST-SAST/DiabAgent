// 全知信息决策 (omniscient decision): the best action sequence this backend allows when the decider
// knows everything — true state, true person parameters and every future event (meals including
// unannounced ones with their true grams, exercise, alcohol, illness, occlusions...). The World is
// deterministic given its seed, so the oracle plans on exact copies of it. Its result is the
// reference upper bound for any agent on the same instance.
//
// Algorithm (a rollout algorithm in the sense of Bertsekas, on the exact model)
//  0. Base policy: an omniscient meal-bolus policy — every true meal is bolused true grams / true
//     carb ratio x f at the last decision time at least `lead` minutes before it is eaten, less
//     insulin the oracle already gave for it. f and lead are calibrated per instance on whole-horizon
//     rollouts. The base policy only uses actions from the oracle's candidate set.
//  1. Receding-horizon search. Decision times are a grid (default 30 min) plus event-anchored times
//     (meals -30/-15/0 min, exercise/alcohol/stress/... -60/-30/0 min), on the environment's 5-min
//     step grid. At each time every legal candidate (oracleCandidates: candidateActions of that
//     state, plus CHANGE_INFUSION_SET while an occlusion is active) is screened with a
//     `lookaheadHours` rollout followed by the base policy; bolus sizes are searched coarse-then-
//     local on the candidate grid. The best `topK`, WAIT and the base policy's own action are then
//     scored on the true objective (cost from now to the horizon end + `tailHours`) and the argmin is
//     committed. Because the base action is always scored exactly, the committed plan is never worse
//     than the base policy on that objective (rollout improvement property).
//  2. Coordinate-descent refinement: sweeps over a finer grid (default 15 min plus anchors)
//     re-optimise one decision at a time with all other decisions fixed, on the same exact
//     objective, so each accepted change lowers it. (A coarse greedy pass followed by refinement
//     was both faster and better than a fine greedy pass: fine-grid greedy over-acts.)
//  3. The plan is executed in a real SimEnv through simulateRun (policy label 'omniscient'), so the
//     run record and metrics are comparable with other policies; the realised true-glucose trace is
//     checked against the planned one (determinism).
// Rollouts mirror SimEnv.step exactly (same step boundaries, sensor sampling, action ids). Any
// built-in controller keeps running in every rollout: the oracle acts on top of the backend through
// the same validated World.apply, so pump steps, percent/absolute temp grids, pens without temp
// basal and safety gates (bolus interval, low-glucose bolus block) all hold.
import {World} from '../sim/world.mjs';
import {buildInstanceConfig} from '../sim/instance.mjs';
import {actionSpecs} from '../sim/actions.mjs';
import {simulateRun} from '../viz/run.mjs';
import {KNOWLEDGE} from '../knowledge.mjs';
import {candidateActions,traceCost,actionLabel} from './common.mjs';

const MIN=60000,FIVE=5*MIN;
const FINE_BOLUS=[...Array.from({length:20},(_,i)=>(i+1)*0.5),11,12,13,14,15,17.5,20,25];
const ANCHORS={meal:[-30,-15,0],exercise:[-60,-30,0],alcohol:[-60,-30,0],alcohol_effect:[0],stress:[-30,0],illness:[0],sleep_loss:[0],occlusion:[0,15,30]};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export const OMNISCIENT_DEFAULTS=Object.freeze({
  hours:null,             // horizon (default: the spec's horizon_minutes, else 24 h)
  decisionMinutes:15,     // decision grid of the refinement sweeps (multiple of 5)
  greedyMinutes:30,       // decision grid of the receding-horizon pass (decisionMinutes when refineSweeps=0)
  anchors:true,           // add event-anchored decision times
  lookaheadHours:3,       // screening rollout per candidate
  topK:2,                 // screened candidates scored on the full objective (plus WAIT and the base action)
  tailHours:2,            // objective extends this far past the horizon (no end-of-horizon gaming)
  refineSweeps:1,         // coordinate-descent sweeps over the committed plan
  cost:{hypoWeight:3,severeWeight:10},   // traceCost weights
  calibrate:true,         // fit the base policy's dose factor and pre-bolus lead per instance
  doseFactor:1,leadMinutes:15,           // base policy settings when calibrate=false
  candidates:{},          // options forwarded to candidateActions
});
export const FAST_SETTINGS=Object.freeze({decisionMinutes:30,refineSweeps:0});

/**
 * Candidate actions the oracle may take at this state: candidateActions() with a finer bolus grid
 * (0.5 U up to 10 U, then coarser; quantized to the device step), plus CHANGE_INFUSION_SET while
 * an occlusion is active on a pump. Every entry is within the instance's action specs.
 */
export function oracleCandidates(world,opts={}) {
  const out=candidateActions(world,{bolusGrid:FINE_BOLUS,...opts});
  if(world.device.kind==='pump'&&world.device.occlusion&&actionSpecs(world).CHANGE_INFUSION_SET)out.push({type:'CHANGE_INFUSION_SET'});
  return out;
}

// --- exact, SimEnv-faithful stepping on a bare World -----------------------------------------

/** One SimEnv.step on a World: apply, advance to the next tick/visible event/sensor change, sample. */
function step(w,action,id,boundary,grid) {
  w.notices=[];
  const receipt=action&&action.type!=='WAIT'?w.apply(action,id):null;
  const nextTick=(Math.floor(w.now/grid)+1)*grid;
  const sensorChange=w.cgm&&w.cgm.nextExpiry()>w.now?w.cgm.nextExpiry():Infinity;
  w.advanceTo(Math.min(nextTick,boundary,w.nextVisibleEventAt(),sensorChange));
  w.sampleIfDue();
  return receipt;
}

/**
 * Plays plan entries (sorted, absolute ms; at most one applied per step, as a policy would) from
 * a state {world: snapshot, step} up to `until`. Returns the true-glucose samples on the 5-min
 * grid (relative to the episode start) after the state time, receipts of entries marked `own`,
 * and the final World.
 */
function play(state,plan,{until,envEnd,grid,origin}) {
  const w=World.restore(state.world);let n=state.step,i=0;
  while(i<plan.length&&plan[i].at<w.now)i++;
  const samples=[],receipts=[];
  while(w.now<until&&!w.terminated) {
    let entry=null;
    if(i<plan.length&&plan[i].at<=w.now)entry=plan[i++];
    const r=step(w,entry?.action,`p-${n}`,Math.min(w.now<envEnd?envEnd:Infinity,until),grid);n++;
    if(entry?.own)receipts.push({entry,status:r?.status??'applied',reason:r?.reason});
    if((w.now-origin)%FIVE===0)samples.push(w.physiology.glucose());
  }
  return {world:w,step:n,samples,receipts,terminated:w.terminated};
}

// --- base policy: omniscient meal boluses ----------------------------------------------------

function trueCarbRatio(cfg) {
  const s=cfg.person?.resolved?.insulin_sensitivity??cfg.physiology?.sensitivity??1;
  return KNOWLEDGE.personModel.reference.profile_carb_ratio_g_per_u*s;
}

/**
 * Base-policy boluses at decision times in [from, until). Meal m is due from b(m) (the last decision
 * time at or before m - lead) until 60 min after it is eaten; its dose is grams / trueCR * f less
 * own bolus units allocated to it (own boluses from 90 min before to 30 min after a meal fill the
 * meals in time order). Doses due together are summed and snapped to the candidate bolus grid; a
 * time occupied by an own entry, or within the bolus interval of an own bolus, is skipped.
 */
function basePlan(ctx,own,{from,until,minDue=-Infinity}) {
  const {meals,times,cr,f,lead,bolusUnits,interval}=ctx;
  const rem=new Map(meals.map(m=>[m.id,m.grams/cr*f]));
  for(const b of own) {
    if(b.action.type!=='BOLUS'&&b.action.type!=='EXTENDED_BOLUS')continue;
    let u=b.action.units;
    const near=meals.filter(m=>m.at>=b.at-30*MIN&&m.at<=b.at+90*MIN);
    for(const m of near){const take=Math.min(u,rem.get(m.id));rem.set(m.id,rem.get(m.id)-take);u-=take;}
    if(near.length&&u>0)rem.set(near.at(-1).id,rem.get(near.at(-1).id)-u);
  }
  const busy=new Set(own.map(e=>e.at)),bolusAt=own.filter(e=>e.action.type==='BOLUS').map(e=>e.at),out=[],given=new Set();
  for(const t of times) {
    if(t<from||t>=until||busy.has(t)||bolusAt.some(x=>Math.abs(t-x)<interval))continue;
    let u=0;const due=[];
    for(const m of meals) {
      const b=ctx.due(m);
      if(given.has(m.id)||b<minDue||b>t||t>m.at+60*MIN||rem.get(m.id)<=0)continue;
      u+=rem.get(m.id);due.push(m.id);
    }
    if(!due.length)continue;
    const snap=bolusUnits.reduce((best,v)=>Math.abs(v-u)<Math.abs(best-u)?v:best,0);
    due.forEach(id=>given.add(id));
    if(snap>0){out.push({at:t,action:{type:'BOLUS',units:snap},base:true});bolusAt.push(t);}
  }
  return out;
}

const merge=(...lists)=>lists.flat().sort((a,b)=>a.at-b.at||(b.own?1:0)-(a.own?1:0));

// --- the decider -----------------------------------------------------------------------------

/**
 * Omniscient decision for an instance spec. Returns
 *   {run, plan, decisions, metrics, cost, objective, stages, base, runtime, settings, verified}
 *   plan: [{at (ISO), minute, action, label}]   actions applied, in order (every one accepted)
 *   decisions: [{time, minute, chosen, action, cost, alternatives:[{label, cost, scope}] sorted}]
 *   cost: traceCost of true glucose over the horizon (same basis as runCost(run) for baselines)
 *   objective: cost over horizon + tail, the quantity the oracle minimises
 */
export function omniscientDecide(spec,options={}) {
  const t0=performance.now();
  const o={...OMNISCIENT_DEFAULTS,...(options.fast?FAST_SETTINGS:{}),...options,cost:{...OMNISCIENT_DEFAULTS.cost,...options.cost}};
  const hours=o.hours??(spec.horizon_minutes?spec.horizon_minutes/60:24);
  const fullSpec={...spec,horizon_minutes:Math.round(hours*60)};
  const cfg=buildInstanceConfig(fullSpec),w0=new World(cfg);
  const grid=cfg.decision_interval_minutes*60000,origin=w0.start,envEnd=w0.start+cfg.horizon_minutes*60000;
  const Ls=Math.round(o.lookaheadHours*12)*FIVE,dm=Math.max(5,Math.round(o.decisionMinutes/5)*5)*MIN;
  const E=envEnd+Math.round(o.tailHours*12)*FIVE;
  w0.ensureEvents(E);
  const events=w0.events.filter(e=>e.at<E);
  const s0={world:w0.snapshot(),step:0,time:origin};
  const cost=samples=>traceCost(samples,o.cost);
  const nH=Math.round((envEnd-origin)/FIVE);
  let rollouts=0,simMinutes=0,reused=0;
  const run=(state,plan,until)=>{rollouts++;simMinutes+=(until-state.time)/MIN;return play(state,plan,{until,envEnd,grid,origin});};
  const sig=plan=>JSON.stringify(plan.map(e=>[e.at,e.action]));
  // Last committed full rollout: a later decision whose candidate plan equals its suffix reuses it.
  let memo=null;

  // Decision times: grid plus event anchors on the 5-min step grid within [start, end); the base
  // policy also acts on the grid in the tail.
  const timesFor=step=>{
    const set=new Set();
    for(let t=origin;t<envEnd;t+=step)set.add(t);
    if(o.anchors)for(const e of events)for(const d of ANCHORS[e.type]??[]) {
      const t=Math.floor((e.at+d*MIN-origin)/FIVE)*FIVE+origin;
      if(t>=origin&&t<envEnd)set.add(t);
    }
    return [...set].sort((a,b)=>a-b);
  };
  const gm=Math.max(5,Math.round((o.greedyMinutes??o.decisionMinutes)/5)*5)*MIN;
  const T=timesFor(dm),Tg=o.refineSweeps>0?timesFor(gm):T;
  const tail=[];for(let t=origin+Math.ceil((envEnd-origin)/dm)*dm;t<E;t+=dm)tail.push(t);
  const bolusUnits=oracleCandidates(w0,o.candidates).filter(a=>a.type==='BOLUS').map(a=>a.units).sort((a,b)=>a-b);
  const ctx={meals:events.filter(e=>e.type==='meal'),times:[...Tg,...tail],cr:trueCarbRatio(cfg),f:o.doseFactor,lead:o.leadMinutes*MIN,
    bolusUnits,interval:cfg.safety.bolus_min_interval_minutes*MIN};
  ctx.due=m=>{const target=m.at-ctx.lead;let b=ctx.times[0];for(const t of ctx.times){if(t<=target)b=t;else break;}return b;};
  const objective=r=>r.terminated?Infinity:cost(r.samples);

  // 0. Calibrate the base policy on whole-objective rollouts.
  let baseCost;
  {
    const g=o.calibrate?{f:[0.35,0.45,0.55,0.65,0.75,0.85,1,1.15,1.3],l:[0,15,30,45]}:{f:[o.doseFactor],l:[o.leadMinutes]};
    let best=null;
    for(const f of g.f)for(const l of g.l) {
      Object.assign(ctx,{f,lead:l*MIN});
      const r=run(s0,basePlan(ctx,[],{from:origin,until:E}),E),j=objective(r);
      if(!best||j<best.j)best={f,l,j,h:cost(r.samples.slice(0,nH))};
    }
    Object.assign(ctx,{f:best.f,lead:best.l*MIN});baseCost={objective:best.j,horizon:best.h};
  }

  /**
   * Scores candidates for decision time tau from `state` (World at tau) with the other own entries fixed.
   * nextFrom: earliest time the base policy may act; minDue: base covers meals due from then on.
   */
  function decide(state,tau,others,{nextFrom,minDue,current=null}) {
    const w=World.restore(state.world),cands=oracleCandidates(w,o.candidates);
    const fixed=others.filter(e=>e.at!==tau);
    const planFor=a=>{
      const own=merge(fixed,a.type==='WAIT'?[]:[{at:tau,action:a,own:true,slot:true}]);
      return merge(own.filter(e=>e.at>=tau),basePlan(ctx,own,{from:nextFrom,until:E,minDue}));
    };
    // The base policy's action at this slot (what it would do here), always scored exactly.
    const baseHere=basePlan(ctx,fixed,{from:tau,until:tau+1,minDue})[0]?.action??{type:'WAIT'};
    if(baseHere.type==='BOLUS'&&!cands.some(a=>same(a,baseHere)))cands.push(baseHere);
    const screened=new Map();
    const memoSig=memo&&memo.tau<tau?sig(memo.plan.filter(e=>e.at>=tau)):null;
    const score=(a,until)=>{
      const plan=planFor(a);
      if(memoSig&&sig(plan)===memoSig) {
        reused++;
        const samples=memo.samples.slice((tau-memo.tau)/FIVE).slice(0,(until-tau)/FIVE);
        return {action:a,label:actionLabel(a),cost:cost(samples),ok:true,plan,samples};
      }
      const r=run(state,plan,until);
      const ok=!r.receipts.some(x=>x.status!=='applied');           // illegal here, or breaks a fixed entry
      return {action:a,label:actionLabel(a),cost:ok?objective(r):Infinity,ok,plan,samples:r.samples};
    };
    const screenUntil=Math.min(tau+Ls,E),exact=screenUntil>=E;
    const screen=a=>{const key=JSON.stringify(a);if(!screened.has(key))screened.set(key,score(a,screenUntil));return screened.get(key);};
    for(const a of cands)if(a.type!=='BOLUS')screen(a);
    const boluses=cands.filter(a=>a.type==='BOLUS').sort((a,b)=>a.units-b.units);
    if(boluses.length) {
      // Coarse pass over 6 sizes, then local descent on the grid around the best.
      const idx=[...new Set(Array.from({length:6},(_,i)=>Math.round(i*(boluses.length-1)/5)))];
      if(screen(boluses[idx[0]]).ok) {
        const val=i=>screen(boluses[i]).cost;
        let bi=idx.reduce((b,i)=>val(i)<val(b)?i:b,idx[0]);
        for(let moved=true;moved;){moved=false;for(const j of [bi-1,bi+1])if(j>=0&&j<boluses.length&&val(j)<val(bi)){bi=j;moved=true;break;}}
      }
      if(baseHere.type==='BOLUS')screen(baseHere);
    }
    const list=[...screened.values()].filter(x=>x.ok).sort((a,b)=>a.cost-b.cost);
    let finals;
    if(exact)finals=list.map(x=>({...x,scope:'full'}));
    else {
      const must=[{type:'WAIT'},baseHere,...(current?[current]:[])];
      const pick=[...list.slice(0,o.topK).map(x=>x.action)];
      for(const a of must)if(!pick.some(p=>same(p,a))&&list.some(x=>same(x.action,a)))pick.push(a);
      finals=pick.map(a=>({...score(a,E),scope:'full'}));
      for(const x of list)if(!pick.some(p=>same(p,x.action)))finals.push({...x,scope:'screen'});
    }
    const full=finals.filter(x=>x.scope==='full'&&x.ok).sort((a,b)=>a.cost-b.cost||(a.action.type==='WAIT'?-1:b.action.type==='WAIT'?1:0));
    const rest=finals.filter(x=>x.scope==='screen').sort((a,b)=>a.cost-b.cost);
    const strip=({plan,samples,...x})=>x;
    // commit(action) records the committed choice's full rollout for reuse at the next decision.
    const commit=a=>{const e=full.find(x=>same(x.action,a));memo=e?{tau,plan:e.plan,samples:e.samples}:null;};
    return {best:full[0]&&strip(full[0]),alternatives:[...full,...rest].map(strip),commit};
  }

  const advance=(state,own,tau)=>{
    if(state.time===tau)return state;
    const r=run(state,own.filter(e=>e.at>=state.time),tau);
    return {world:r.world.snapshot(),step:r.step,time:tau};
  };
  const replay=plan=>{
    const own=[...plan.values()].sort((a,b)=>a.at-b.at);
    const r=run(s0,merge(own,basePlan(ctx,own,{from:envEnd,until:E,minDue:envEnd})),E);
    return {r,j:objective(r),h:cost(r.samples.slice(0,nH)),applied:r.receipts.filter(x=>x.status==='applied').map(x=>x.entry)};
  };

  // 1. Receding-horizon rollout search.
  const chosen=new Map(),log=new Map();
  let state=s0;
  for(let k=0;k<Tg.length;k++) {
    const own=[...chosen.values()].sort((a,b)=>a.at-b.at);
    state=advance(state,own,Tg[k]);
    const d=decide(state,Tg[k],own,{nextFrom:Tg[k+1]??envEnd,minDue:-Infinity});
    if(d.best.action.type!=='WAIT')chosen.set(Tg[k],{at:Tg[k],action:d.best.action,own:true});
    d.commit(d.best.action);delete d.commit;
    log.set(Tg[k],d);
  }
  let current=replay(chosen),plan=new Map(current.applied.map(e=>[e.at,e]));
  const stages={base:baseCost,greedy:{objective:current.j,horizon:current.h},sweeps:[]};

  // 2. Coordinate descent: one slot at a time, the rest of the plan fixed, exact objective.
  for(let s=0;s<o.refineSweeps;s++) {
    const next=new Map(plan),sweepLog=new Map();let st=s0,changed=0;
    for(let k=0;k<T.length;k++) {
      const tau=T[k],own=[...next.values()].sort((a,b)=>a.at-b.at);
      st=advance(st,own,tau);
      const cur=next.get(tau)?.action??{type:'WAIT'};
      const d=decide(st,tau,own,{nextFrom:envEnd,minDue:envEnd,current:cur});
      const curEval=d.alternatives.find(x=>x.scope==='full'&&same(x.action,cur));
      let keep=cur;
      if(d.best&&!same(d.best.action,cur)&&(!curEval||d.best.cost<curEval.cost-1e-12)) {
        changed++;keep=d.best.action;
        if(keep.type==='WAIT')next.delete(tau);else next.set(tau,{at:tau,action:keep,own:true});
      }
      d.commit(keep);delete d.commit;
      sweepLog.set(tau,d);
    }
    memo=null;
    const cand=replay(next);
    stages.sweeps.push({sweep:s+1,changed,objective:cand.j,horizon:cand.h,kept:cand.j<current.j});
    if(!(cand.j<current.j))break;
    current=cand;plan=new Map(cand.applied.map(e=>[e.at,e]));
    for(const [t,d] of sweepLog)log.set(t,d);
    if(!changed)break;
  }

  // 3. Execute through the real environment and check the trajectory against the plan.
  const final=[...plan.values()].sort((a,b)=>a.at-b.at);
  const factory=()=>{let i=0;return obs=>{
    const t=Date.parse(obs.virtual_time);
    if(i<final.length&&final[i].at<=t) {
      const e=final[i++],d=log.get(e.at),wait=d?.alternatives.find(x=>x.action.type==='WAIT'&&x.scope==='full');
      return {action:e.action,rationale:`omniscient: ${actionLabel(e.action)}${d?` (cost ${d.best.cost.toFixed(4)}${wait?` vs WAIT ${wait.cost.toFixed(4)}`:''})`:''}`};
    }
    return {action:{type:'WAIT'},rationale:'omniscient: wait'};
  };};
  const runRecord=simulateRun(fullSpec,{id:o.id??'omniscient',policy:factory,label:'omniscient',hours});
  const truth=runRecord.truth.filter(([m])=>m%5===0).map(([,g])=>g),planned=current.r.samples.slice(0,nH);
  const maxDiff=Math.max(0,...truth.map((g,i)=>Math.abs(g-planned[i])));
  const verified={samples:truth.length,max_abs_diff_mg_dl:Number(maxDiff.toFixed(3)),treatments:runRecord.treatments.length,planned:final.length,
    ok:truth.length===planned.length&&maxDiff<=0.5+1e-9&&runRecord.treatments.length===final.length};

  const iso=t=>new Date(t).toISOString(),minute=t=>Math.round((t-origin)/MIN);
  const r4=v=>Number.isFinite(v)?Number(v.toFixed(4)):null;
  return {
    run:runRecord,
    plan:final.map(e=>({at:iso(e.at),minute:minute(e.at),action:e.action,label:actionLabel(e.action)})),
    decisions:[...log.keys()].sort((a,b)=>a-b).map(t=>{const d=log.get(t),a=plan.get(t)?.action??{type:'WAIT'};
      return {time:iso(t),minute:minute(t),chosen:actionLabel(a),action:a,cost:r4(d.alternatives.find(x=>x.scope==='full'&&same(x.action,a))?.cost),
        alternatives:d.alternatives.map(x=>({label:x.label,action:x.action,cost:r4(x.cost),scope:x.scope}))};}),
    metrics:runRecord.metrics,
    cost:current.h,objective:current.j,
    stages,
    base:{true_carb_ratio_g_per_u:Number(ctx.cr.toFixed(3)),dose_factor:ctx.f,lead_minutes:ctx.lead/MIN},
    runtime:{seconds:Number(((performance.now()-t0)/1000).toFixed(2)),rollouts,reused,simulated_hours:Math.round(simMinutes/60),decision_times:{greedy:Tg.length,refine:o.refineSweeps>0?T.length:0}},
    settings:{hours,decisionMinutes:dm/MIN,greedyMinutes:Tg===T?dm/MIN:gm/MIN,lookaheadHours:Ls/3600000,topK:o.topK,tailHours:(E-envEnd)/3600000,refineSweeps:o.refineSweeps,anchors:o.anchors,cost:o.cost},
    verified,
  };
}

/** Cost of a run record on the oracle's basis: traceCost of true glucose on the 5-min grid of the horizon. */
export function runCost(run,weights) {
  return traceCost(run.truth.filter(([m])=>m%5===0).map(([,g])=>g),{...OMNISCIENT_DEFAULTS.cost,...weights});
}
