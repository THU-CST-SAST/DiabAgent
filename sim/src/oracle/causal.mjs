// 因果最优决策 (causal-optimal decision): the best decision an agent can make with only what it can
// observe up to now plus public prior knowledge. It approximates the Bayes-optimal POMDP policy
// and is the fair reference for agents (the omniscient decider, src/oracle/omniscient.mjs, is
// the unfair upper bound).
//
// Structure (one decision):
//   belief  (src/oracle/belief.mjs)   particle posterior over hidden person parameters, state,
//                                     unannounced meals, occlusion and sensor error, filtered
//                                     from the observation stream only;
//   plan    (this file)               for each hardware-legal candidate action (from
//                                     obs.action_specs: pump step sizes, percent vs absolute temp
//                                     grid, extended bolus where supported, pen steps), K
//                                     posterior particles x one sampled future each (meals,
//                                     announcements, exercise from the lifestyle prior; never the
//                                     true future) are rolled out over the lookahead with a
//                                     continuation policy that sees only what the agent would see
//                                     (CGM every 5 min, flash only at scans or alarms, meter only
//                                     at checks). Common random numbers across candidates.
//   choose                            minimum expected glucose-risk cost (Magni, hypo-weighted,
//                                     as traceCost) plus a CVaR tail term; a non-WAIT action must
//                                     beat WAIT by more than its paired standard error.
//   information                       MEASURE_BG / SCAN by value of information: the expected
//                                     cost reduction from re-weighting the same particle costs by
//                                     a hypothetical reading (preposterior analysis), against a
//                                     burden cost per measurement.
//
// Assisted care (self_care 'assisted', public: description or obs.profile.self_care): the person
// boluses announced meals with their own calculator (maybe late, maybe forgotten) and treats lows
// they see (selfCarePrior). Rollouts then include the person's bolus (future announced meals and
// boluses still pending for meals already announced, under the device's bolus gates) and low
// treatment instead of the agent's own meal dosing and rescue; while a person bolus is pending
// the agent offers no bolus and no temp above the schedule, doses a meal only after the person
// evidently missed it, and offers rescue carbs only for lows within assistedRescueHours. Full
// care is unchanged (test/fixtures/causal-full-head.json).
//
// No-leakage: the agent is built from publicDescription(spec) and sees only the observations
// SimEnv hands to the policy; the run factory ignores cfg and env (see causalAgentFactory and
// the counterfactual test in test/oracle-causal.test.mjs).
import {simulateRun} from '../viz/run.mjs';
import {buildInstanceConfig} from '../sim/instance.mjs';
import {magniRisk,traceCost,actionLabel} from './common.mjs';
import {Belief,publicDescription,trueMeal,hiddenMeal,selfCarePrior} from './belief.mjs';
import {Rng} from '../core/rng.mjs';
import * as M from './belief-model.mjs';

const MIN=60000,FIVE=5*MIN,HOUR=3600000;
const hhmm=s=>Number(s.slice(0,2))*60+Number(s.slice(3));
const round=(v,d=3)=>v==null||!Number.isFinite(v)?v:Number(v.toFixed(d));

export const CAUSAL_DEFAULTS=Object.freeze({
  particles:256,          // belief particles
  planParticles:64,       // posterior samples per decision (each with one sampled future)
  decisionMinutes:15,     // decision grid; visible events and new readings also trigger decisions
  lookaheadHours:5,
  seed:1,
  cost:{hypoWeight:3,severeWeight:10},
  riskAversion:0.1,       // weight of CVaR90 excess over the mean
  rescueBelow:85,rescueProbability:0.1,   // carbs are offered when P(min glucose < 85 within 2 h | WAIT) >= 0.1
  assistedRescueHours:1,  // ... within 1 h in assisted care (the person treats the lows they see; later lows are theirs)
  zSelect:2.0,            // a non-WAIT action must beat WAIT by z x paired SE ...
  minGain:0.02,           // ... and by at least this much (model error dominates smaller gains)
  mealFactor:0.8,         // continuation meal dose / (reported carbs / CR) until the agent's own choices are known
  measureCost:0.12,       // burden of a fingerstick, in cost units (mean risk per sample over the lookahead)
  scanCost:0.03,
  carbCostPerGram:0.01,
  // Treatment burden per action (cost units); keeps the planner from trading tiny modelled gains
  // for extra injections or snacks. Temp basals are nearly free (the pump does the work).
  actionCost:{BOLUS:0.05,EXTENDED_BOLUS:0.05,INGEST_CARBS:0.05,TEMP_BASAL:0.005,CANCEL_TEMP_BASAL:0.005,SUSPEND_PUMP:0.005,CHANGE_INFUSION_SET:0.1},
  fast:false,
});
const FAST={particles:128,planParticles:32,lookaheadHours:4};

// --- candidate actions ---------------------------------------------------------------------

const quant=(v,step,mode='down')=>{if(!step)return Number(v.toFixed(3));const f=mode==='down'?Math.floor:Math.round;return Number((f(v/step+1e-9)*step).toFixed(3));};

/**
 * Hardware-legal candidate actions from an observation's action specs (mirrors
 * common.candidateActions, but reads only obs). Bolus sizes are on the device step (pumps round
 * down like the device; pens to the pen step) and scaled to this person's settings: fractions of
 * the announced meal dose and multiples of the dose that lowers glucose by ~30 mg/dL. Temp basals
 * use the pump's own grid (percent or absolute) and duration step; extended boluses only where
 * offered; rescue carbs; information actions are returned separately.
 */
export function candidateActionsFromSpecs(specs,obs,{mealGrams=0,lowRisk=false,tempMinutes=30,includeCancel=true}={}) {
  const out=[{type:'WAIT'}],p=obs.profile,info=[];
  const seen=new Set(),push=a=>{const k=JSON.stringify(a);if(!seen.has(k)){seen.add(k);out.push(a);}};
  const dev=obs.device;
  const pumpRunning=dev.type!=='pump'||!dev.stop_reason;
  if(specs.BOLUS&&pumpRunning&&!dev.bolus_in_progress) {
    const u=specs.BOLUS.units,mdi=dev.type==='mdi',step=u.step;
    const fresh=obs.glucose&&obs.glucose.age_minutes<=30?obs.glucose.value_mg_dl:null;
    const lastBolus=dev.last_bolus?Date.parse(dev.last_bolus.time):-Infinity,now=Date.parse(obs.virtual_time);
    const blocked=(fresh!=null&&fresh<70)||now-lastBolus<15*MIN;
    if(!blocked) {
      const corr=Math.max(step||0.05,30/(p.isf_mg_dl_per_u||50));
      const sizes=[corr,2*corr,4*corr];
      if(mealGrams>0){const m=mealGrams/(p.carb_ratio_g_per_u||10);sizes.push(0.5*m,0.75*m,m,1.25*m);}
      for(const s of sizes){const v=quant(s,step,mdi?'round':'down');if(v>(u.exclusive_min?u.min:u.min-1e-9)&&v>0&&v<=u.max)push({type:'BOLUS',units:v});}
    }
  }
  if(specs.TEMP_BASAL&&pumpRunning) {
    const t=specs.TEMP_BASAL,dstep=t.duration_minutes.step??1;
    const d=Math.max(t.duration_minutes.min,Math.min(t.duration_minutes.max,Math.round(tempMinutes/dstep)*dstep||dstep));
    const percentNative=!!t.percent.step,base=dev.scheduled_basal_u_h;
    for(const f of [0,0.5,1.5,2]) {
      if(percentNative){const v=quant(f*100,t.percent.step,'round');if(v>=t.percent.min&&v<=t.percent.max)push({type:'TEMP_BASAL',percent:v,duration_minutes:d});}
      else {const v=quant(f*base,t.rate_u_h.step,'round');if(v>=t.rate_u_h.min&&v<=t.rate_u_h.max)push({type:'TEMP_BASAL',rate_u_h:v,duration_minutes:d});}
    }
    if(includeCancel&&dev.temp_basal&&specs.CANCEL_TEMP_BASAL)push({type:'CANCEL_TEMP_BASAL'});
  }
  if(specs.EXTENDED_BOLUS&&pumpRunning&&mealGrams>0&&!dev.extended_bolus) {
    const e=specs.EXTENDED_BOLUS,m=mealGrams/(p.carb_ratio_g_per_u||10),dstep=e.duration_minutes.step??1;
    const d=Math.min(e.duration_minutes.max,Math.round(120/dstep)*dstep);
    for(const f of [0.3,0.5]){const v=quant(f*m,e.units.step,'down');if(v>e.units.min&&v<=e.units.max)push({type:'EXTENDED_BOLUS',units:v,duration_minutes:d});}
  }
  if(specs.INGEST_CARBS&&lowRisk)for(const g of [8,15,25])if(g<=specs.INGEST_CARBS.grams.max)push({type:'INGEST_CARBS',grams:g});
  if(specs.MEASURE_BG)info.push({type:'MEASURE_BG'});
  if(specs.SCAN)info.push({type:'SCAN'});
  return {actions:out,info};
}

// --- rollouts -------------------------------------------------------------------------------

/**
 * Future events for one particle over [from, to): meal slots of the lifestyle prior the particle
 * has not yet resolved (eaten or not, announced or not, when, how much), exercise, routine
 * long-acting injections, routine glucose checks/scans. Drawn from rng (one stream per
 * particle and decision: common random numbers across candidates).
 */
function sampleFuture(b,p,from,now,to,r) {
  const pr=b.prior,ev=[],off=b.off;
  for(let day=M.localDay(from-DAY_GUARD,off);;) {
    const dayStart=Date.parse(`${day}T00:00:00Z`)-off*MIN;
    if(dayStart>to)break;
    for(const m of pr.meals) {
      const key=`${day}:${m.name}`,s=p.slots[key],plan=dayStart+m.minute*MIN,w0=plan-m.jitterMin*MIN,w1=plan+m.jitterMin*MIN;
      if(w1<from||w0>to)continue;
      if(s&&s.st!=='maybe'){if(s.st==='unann'&&!s.eaten&&s.at>=from)ev.push({at:s.at,type:'meal',grams:s.grams,tau:s.tau,announced:false});continue;}
      if(b.announcedSlots.has(key))continue;
      const eats=r.next()<m.probability,ann=r.next()<pr.announceP,u=r.next();
      if(!eats)continue;
      const lo=Math.max(w0,from),at=Math.floor((lo+u*(w1-lo))/MIN)*MIN;
      if(at>=to)continue;
      const {grams,tau}=hiddenMeal(pr,m,p,r);
      const reported=ann?reportOf(pr,grams,r):0;
      ev.push({at,type:'meal',grams,tau,announced:ann,reported});
      // Assisted care: the person boluses the announced meal themselves (maybe late, maybe not).
      if(b.selfCare&&ann){const sc=b.selfCare,miss=r.next()<sc.missP,d=Math.floor(r.next()*(sc.maxDelay+1));
        if(!miss)ev.push({at:at+d*MIN,type:'selfbolus',grams:reported});}
    }
    const a=pr.activity;
    if(a.probability>0) {
      const t0=dayStart+(a.minute-a.jitter)*MIN,t1=dayStart+(a.minute+a.jitter)*MIN;
      if(t1>=from&&t0<to&&!b.exerciseDays.has(day)&&r.next()<a.probability){const at=Math.floor((Math.max(t0,from)+r.next()*(t1-Math.max(t0,from)))/MIN)*MIN;
        if(at<to)ev.push({at,type:'exercise',until:at+a.duration*MIN,AC:a.AC});}
    }
    const mdi=b.desc.therapy.mdi;
    // Routines strictly after now: those at or before now are already visible (known items).
    if(mdi?.auto_basal_injection)for(const h of mdi.basal_times){const at=dayStart+hhmm(h)*MIN;if(at>now&&at<to)ev.push({at,type:'la',units:mdi.basal_dose_u,insulin:mdi.basal_insulin});}
    for(const h of b.desc.sensors.meter_routine_times){const at=dayStart+hhmm(h)*MIN;if(at>now&&at<to)ev.push({at,type:'check'});}
    if(b.flash){const [w0,w1]=b.desc.sensors.scan_window.map(hhmm);for(let m=w0;m<=w1;m+=b.desc.sensors.scan_interval_minutes){const at=dayStart+m*MIN;if(at>now&&at<to)ev.push({at,type:'check'});}}
    day=M.localDay(dayStart+DAY_GUARD*30,off);
  }
  // Assisted care: self-boluses still pending for meals announced before now (no patient_bolus
  // seen yet). Given that none happened by now, the delay is uniform over the remaining whole
  // minutes, and "forgotten" gains weight as the window runs out.
  if(b.selfCare)for(const s of b.selfPending??[]) {
    const sc=b.selfCare,e=Math.floor((now-s.at)/MIN),left=sc.maxDelay-e;   // delays e+1 .. maxDelay are still possible
    if(left<=0)continue;
    const pMiss=sc.missP/(sc.missP+(1-sc.missP)*left/(sc.maxDelay+1));
    const miss=r.next()<pMiss,d=e+1+Math.floor(r.next()*left);
    if(!miss)ev.push({at:s.at+d*MIN,type:'selfbolus',grams:s.grams});
  }
  return ev.sort((x,y)=>x.at-y.at);
}
const DAY_GUARD=3600000;
function reportOf(pr,grams,r) {
  const e=pr.carbErr.model==='normal'?Math.max(-0.9,pr.carbErr.bias+pr.carbErr.sd*r.normal()):r.symmetric(pr.carbErr.frac);
  return Math.max(5,Math.round(grams*(1+e)/5)*5);
}

/**
 * One rollout of particle p (a clone; mutated) from belief time T to now + L: known inputs in
 * [T, now), the candidate at now, then the continuation policy with the sampled future.
 * Returns {cost, gNow, tail} (cost = mean hypo-weighted Magni risk at 5-minute samples after now).
 */
function rollout(ctx,p,cand,fut,opts) {
  const b=ctx.b,P=b.P,end=ctx.now+ctx.L,cw=opts.cost,dev=ctx.dev,prof=ctx.profile,carbPenalty=opts.carbCostPerGram;
  const pumpSpec=b.pump,speed=pumpSpec?.bolus_speed_u_per_min;
  const bolusRuns=[...ctx.bolusRuns];
  // Device schedule from now: temp (user or loop), suspension, extended bolus.
  let temp=ctx.temp?{...ctx.temp}:null,suspendedUntil=ctx.suspendedUntil,stopped=ctx.stopped,ext=ctx.extended?{...ctx.extended}:null;
  let lastBolusAt=ctx.lastBolusAt,lastRescueAt=ctx.lastRescueAt,carbs=0;
  let risk=0,n=0,gNow=null,visible=null,visiblePrev=null,min2h=Infinity;
  // App-side estimates the agent and the built-in loop would see: IOB (decays with the profile
  // DIA; starts from the visible IOB) and COB (reported carbs absorbed linearly, as obs.cob).
  let iob=ctx.iob0;const cobList=[...ctx.cob0];
  const cobAt=t=>{let c=0;for(const x of cobList){const left=x.g*(1-(t-x.at)/ctx.cobWindow);if(t>=x.at&&left>0)c+=left;}return c;};
  const bolusNow=u=>{
    if(u<=0)return;
    if(!(b.pump&&Number.isFinite(speed)&&speed>0))iob+=u;   // pump boluses enter IOB through the delivered rate
    if(b.pump&&Number.isFinite(speed)&&speed>0){const m=Math.max(1,Math.ceil(u/speed));bolusRuns.push({from:tcur,until:tcur+m*MIN,rate:u/m*60});}
    else if(!(p.occl&&!p.occl.alarmed))M.bolus(p,P,u);
    lastBolusAt=tcur;
  };
  const carbsNow=(g,tau,reported=g)=>{M.addMeal(p,g,tau);if(reported>0)cobList.push({at:tcur,g:reported});};
  // Assisted care (ctx.selfCare): the person's own management, as the simulator does it
  // (World.runSelfCareQueue / selfTreatLow): a bolus-calculator dose for announced meals subject to
  // the device safety gates, and 15 g for a low they can see, then a recheck interval.
  const sc=ctx.selfCare;
  let seen=sc&&ctx.seen0?{...ctx.seen0}:null,lastSelfLowAt=sc?ctx.lastSelfLowAt:-Infinity;
  const personSees=v=>{
    seen={v,at:tcur};
    if(v<sc.lowBelow&&tcur-lastSelfLowAt>=sc.recheck*MIN){carbsNow(sc.lowGrams,ctx.rescueAbsorption);lastSelfLowAt=tcur;}
  };
  const personBolus=grams=>{
    const fresh=seen&&tcur-seen.at<=sc.freshMinutes*MIN;
    if(fresh&&seen.v<ctx.blockBolusBelow)return;          // rejected: glucose below the bolus floor
    if(tcur-lastBolusAt<ctx.bolusInterval)return;          // rejected: minimum bolus interval
    let u=grams/prof.carb_ratio_g_per_u;
    if(fresh&&seen.v>sc.correctionAbove)u+=Math.max(0,(seen.v-prof.target_mg_dl)/prof.isf_mg_dl_per_u*sc.correctionFraction-iob);
    u=Math.min(ctx.maxBolus,ctx.bolusStep?Math.round(u/ctx.bolusStep)*ctx.bolusStep:u);
    if(u>ctx.bolusMin)bolusNow(Number(u.toFixed(3)));
  };
  let tcur=ctx.T,fi=0;
  const knownItems=ctx.knownItems;let ki=0;
  const eff=t=>{let AC=0,hep=0,sens=1;for(const e of ctx.active)if(t>=e.from&&t<e.until){AC=Math.max(AC,e.AC??0);hep+=e.hep??0;sens*=e.sens??1;}
    for(const e of p._exercise??[])if(t>=e.from&&t<e.until)AC=Math.max(AC,e.AC);return {AC,hep,sens};};
  p._exercise=[];
  const applyCandidate=()=>{
    switch(cand.type) {
      case 'BOLUS':bolusNow(cand.units);break;
      case 'TEMP_BASAL':temp={rate:cand.rate_u_h??ctx.scheduled*cand.percent/100,until:tcur+cand.duration_minutes*MIN,user:true};break;
      case 'CANCEL_TEMP_BASAL':temp=null;break;
      case 'SUSPEND_PUMP':suspendedUntil=tcur+cand.minutes*MIN;break;
      case 'EXTENDED_BOLUS':ext={rate:cand.units/cand.duration_minutes*60,until:tcur+cand.duration_minutes*MIN};break;
      case 'INGEST_CARBS':carbsNow(cand.grams,ctx.rescueAbsorption);carbs+=cand.grams;lastRescueAt=tcur;break;
      case 'CHANGE_INFUSION_SET':stopped=false;p.occl=null;break;
      default:break;
    }
  };
  const loop=ctx.loop;
  while(tcur<end) {
    // Known inputs between belief time and now (already visible, not yet in the particle).
    while(ki<knownItems.length&&knownItems[ki].t<=tcur) {
      const it=knownItems[ki++];
      if(it.type==='bolus'){if(b.pump&&Number.isFinite(speed)&&speed>0){const m=Math.max(1,Math.ceil(it.units/speed));bolusRuns.push({from:it.t,until:it.t+m*MIN,rate:it.units/m*60});}else M.bolus(p,P,it.units);}
      else if(it.type==='carbs')M.addMeal(p,it.grams,it.absorption);
      else if(it.type==='meal'){const {grams,tau}=trueMeal(b.prior,it.grams,it.absorption,it.highFat,ctx.rng);M.addMeal(p,grams,tau);}
      else if(it.type==='la')M.addDepot(p,M.longActingDepotRates(it.insulin),it.units*1e6);
    }
    if(tcur===ctx.now){gNow=M.glucoseOf(p,P);applyCandidate();}
    if(tcur>=ctx.now) {
      // Sampled future events and the continuation policy.
      while(fi<fut.length&&fut[fi].at<=tcur) {
        const e=fut[fi++];
        if(e.at<ctx.now)continue;
        if(e.type==='meal'){carbsNow(e.grams,e.tau,e.announced?e.reported:0);
          // Full care: the continuation doses announced meals; assisted: the person does (selfbolus).
          if(!sc&&e.announced&&e.reported>0&&!(visible!=null&&visible<70)) {
            const u=Math.min(ctx.maxBolus,ctx.mealFactor*e.reported/prof.carb_ratio_g_per_u);bolusNow(ctx.quantBolus(u));}}
        else if(e.type==='selfbolus')personBolus(e.grams);
        else if(e.type==='exercise')p._exercise.push({from:e.at,until:e.until,AC:e.AC});
        else if(e.type==='la')M.addDepot(p,M.longActingDepotRates(e.insulin),e.units*1e6);
        else if(e.type==='check'&&!ctx.cgm){visible=readingOf(ctx,p);if(sc)personSees(visible);}
      }
      if(tcur%FIVE===0) {
        if(ctx.cgm){visiblePrev=visible;visible=readingOf(ctx,p);if(sc&&tcur>ctx.now)personSees(visible);}
        else if(ctx.flashLow&&readingOf(ctx,p)<70)visible=69;   // low alarm: scan shows a low
        if(tcur>ctx.now) {
          const g=M.glucoseOf(p,P);risk+=magniRisk(g)*(g<54?cw.severeWeight:g<70?cw.hypoWeight:1);n++;
          if(tcur-ctx.now<=ctx.rescueWindow&&g<min2h)min2h=g;
          if(ctx.trace&&(tcur-ctx.now)%(30*MIN)===0)ctx.trace.push(g);
        }
        // Continuation: rescue carbs on a visible low (assisted: the person treats it), conservative
        // corrections on visible highs.
        if(tcur>ctx.now&&visible!=null) {
          if(visible<70){if(!sc&&tcur-lastRescueAt>=40*MIN){carbsNow(15,ctx.rescueAbsorption);carbs+=15;lastRescueAt=tcur;if(!ctx.cgm)visible=null;}}
          else if(visible>200&&tcur-lastBolusAt>=2.5*HOUR&&!(b.pump&&stopped)) {
            const u=((visible-prof.target_mg_dl)/prof.isf_mg_dl_per_u-Math.max(0,iob))*0.6;
            if(u>0)bolusNow(ctx.quantBolus(Math.min(u,ctx.maxBolus)));
            if(!ctx.cgm)visible=null;
          }
        }
        // Built-in loop surrogate: oref0 determine-basal's main rule on the visible CGM value,
        // IOB and COB (eventual BG, low threshold, max_iob 3 U, max safe basal, 30-min temps).
        if(loop&&tcur>=ctx.now&&!(temp&&temp.user&&tcur<temp.until)&&visible!=null) {
          const d5=visiblePrev!=null?visible-visiblePrev:0,isf=prof.isf_mg_dl_per_u,target=prof.target_mg_dl;
          const eventual=visible+3*d5-iob*isf+cobAt(tcur)*isf/prof.carb_ratio_g_per_u,threshold=target-0.5*(target-40);
          let rate;
          if(loop==='lgs')rate=visible<ctx.lowAlarm?0:null;
          else if(visible<threshold||eventual<threshold)rate=0;
          else if(eventual<target)rate=Math.max(0,ctx.scheduled+2*(eventual-target)/isf);
          else if(iob>ctx.maxIob)rate=ctx.scheduled;
          else rate=Math.min(ctx.maxSafeBasal,ctx.scheduled+2*Math.min((eventual-target)/isf,ctx.maxIob-iob));
          temp=rate==null?null:{rate,until:tcur+30*MIN,user:false};
        }
      }
    }
    // Delivered rate over [tcur, tcur+1). IOB grows by what is commanded from now on (runs
    // started before now are already in the visible IOB).
    let uph;
    if(b.mdi)uph=0;
    else if(tcur<ctx.now)uph=ctx.rateBeforeNow;
    else if(stopped||tcur<suspendedUntil)uph=0;
    else uph=(temp&&tcur<temp.until?temp.rate:ctx.scheduled)+(ext&&tcur<ext.until?ext.rate:0);
    if(!b.mdi&&tcur>=ctx.now)iob+=(uph-ctx.scheduled)/60;
    for(const r of bolusRuns)if(tcur>=r.from&&tcur<r.until){uph+=r.rate;if(r.from>=ctx.now&&tcur>=ctx.now)iob+=r.rate/60;}
    iob-=iob*ctx.iobDecay;
    if(p.occl&&!p.occl.alarmed){p.occl.missed+=uph/60;uph=0;if(p.occl.missed>=(b.pump?.occlusion_alarm_missed_u??3)){p.occl.alarmed=true;stopped=true;}}
    const e=eff(tcur),k=p.S*M.baseMultiplier(p,tcur,b.ctx)*e.sens;
    M.stepMinute(P,p,uph,e.AC,e.hep,k);
    tcur+=MIN;
  }
  return {cost:(n?risk/n:0)+carbs*carbPenalty+(opts.actionCost[cand.type]??0),gNow,min2h};
}
function readingOf(ctx,p) {
  const g=M.glucoseOf(p,ctx.b.P);
  if(p.kf)return p.kf[0]*p.ig+p.kf[1]+p.kf[2];
  return g;
}

// --- the agent ------------------------------------------------------------------------------

const TRIGGERS=new Set(['meal_announced','exercise_started','cgm_low','cgm_urgent_low','cgm_high','flash_alarm_low','flash_alarm_high',
  'fingerstick','flash_scan','pump_occlusion_alarm','cgm_sensor_replaced','alcohol_reported','illness_reported','poor_sleep_reported','meter','scan',
  'patient_bolus','patient_treated_low']);   // the last two occur only in assisted care

/**
 * Builds the causal agent from a public description only. Returns
 * {policy: obs => {action, rationale}, log: {decisions, beliefs}}. The policy reads nothing but
 * its argument and its own memory.
 */
export function makeCausalAgent(desc,options={}) {
  const opts={...CAUSAL_DEFAULTS,...(options.fast?FAST:{}),...options,cost:{...CAUSAL_DEFAULTS.cost,...(options.cost??{})},
    actionCost:{...CAUSAL_DEFAULTS.actionCost,...(options.actionCost??{})}};
  const log={decisions:[],beliefs:[],timing:{belief_ms:0,plan_ms:0}};
  let b=null,step=0,pendingMeal=null,lastInfoAction=-Infinity,userTemp=null,lastAction=null,mealFactor=opts.mealFactor;
  const start=Date.parse(desc.start_time);
  const policy=obs=>{
    const now=Date.parse(obs.virtual_time);
    const t0=performance.now();
    if(!b) {
      b=Object.assign(new Belief(desc,obs,{particles:opts.particles,seed:opts.seed,...(opts.belief??{})}),{announcedSlots:new Set(),exerciseDays:new Set()});
      // Care mode: public (description, or the first observation's profile for older descriptions).
      // options.careMode overrides it (tests: 'none' reproduces the decider that ignores the person).
      const sc=selfCarePrior(opts.careMode??desc.self_care?.mode??obs.profile?.self_care);
      if(sc)Object.assign(b,{selfCare:sc,selfPending:[]});
    }
    b.resolveCalibration(obs);
    const {info}=b.ingest(obs);
    for(const e of obs.events??[]) {
      if(e.type==='meal_announced') {
        const m=/^meal:(\d{4}-\d{2}-\d{2}):(.+)$/.exec(e.id??'');if(m)b.announcedSlots.add(`${m[1]}:${m[2]}`);
        // Assisted: the person is expected to bolus this meal; the agent only doses it once that
        // bolus has evidently been missed (see below).
        if(b.selfCare)b.selfPending.push({at:Date.parse(e.time),grams:e.grams});
        else pendingMeal={grams:e.grams,at:Date.parse(e.time)};
      }
      if(e.type==='patient_bolus'&&b.selfCare&&b.selfPending.length) {
        const i=b.selfPending.findIndex(s=>s.grams===e.grams);b.selfPending.splice(i<0?0:i,1);
      }
      if(e.type==='exercise_started')b.exerciseDays.add(M.localDay(Date.parse(e.time),b.off));
    }
    if(b.selfCare) {
      // Window over without a patient_bolus: forgotten (or rejected); now the meal is the agent's.
      const over=b.selfPending.filter(s=>Math.floor((now-s.at)/MIN)>=b.selfCare.maxDelay);
      for(const s of over){b.selfPending.splice(b.selfPending.indexOf(s),1);pendingMeal={grams:s.grams,at:s.at};}
    }
    b.advance(now);
    log.timing.belief_ms+=performance.now()-t0;
    step++;
    const dev=obs.device,specs=obs.action_specs;
    if(userTemp&&(!dev.temp_basal||Date.parse(dev.temp_basal.ends_at)!==userTemp))userTemp=null;
    const act=(action,rationale,extra)=>{lastAction={action,at:now};b.noteAction(now,action);
      if(action.type==='TEMP_BASAL')userTemp=now+action.duration_minutes*MIN;
      if(['MEASURE_BG','SCAN','CALIBRATE_CGM'].includes(action.type))lastInfoAction=now;
      return {action,rationale,...extra};};
    // Device hygiene that needs no planning.
    if(dev.type==='pump'&&dev.stop_reason==='occlusion_alarm'&&specs.CHANGE_INFUSION_SET)return act({type:'CHANGE_INFUSION_SET'},'occlusion alarm: change infusion set');
    const cal=obs.cgm?.calibration;
    if(specs.CALIBRATE_CGM&&cal&&!obs.cgm.warming_up_until&&(cal.required_now||(cal.due_at&&Date.parse(cal.due_at)-now<=15*MIN))&&now-lastInfoAction>10*MIN)
      return act({type:'CALIBRATE_CGM'},'calibration due');
    const grid=(now-start)%(opts.decisionMinutes*MIN)===0;
    const triggered=info.some(k=>TRIGGERS.has(k))||lastAction&&['MEASURE_BG','SCAN','CALIBRATE_CGM'].includes(lastAction.action.type)&&now-lastAction.at<=10*MIN;
    if(!grid&&!triggered)return {action:{type:'WAIT'},rationale:'between decisions'};
    const t1=performance.now();
    const d=decide(b,obs,opts,{pendingMeal,userTemp,lastInfoAction,now,step,mealFactor});
    log.timing.plan_ms+=performance.now()-t1;
    if(pendingMeal&&now-pendingMeal.at>90*MIN)pendingMeal=null;
    if(d.chosen.type==='BOLUS'&&pendingMeal) {
      // The continuation doses future meals the way this agent has been dosing them (full care
      // only: in assisted care the person doses announced meals).
      const ratio=d.chosen.units/(pendingMeal.grams/(obs.profile.carb_ratio_g_per_u||10));
      if(!b.selfCare)mealFactor=Math.min(1.3,Math.max(0.4,0.5*mealFactor+0.5*ratio));
      pendingMeal=null;
    }
    log.decisions.push(d.record);log.beliefs.push(d.belief);
    return act(d.chosen,d.rationale);
  };
  return {policy,log,options:opts,belief:()=>b};
}

/** One planning decision at obs time. */
function decide(b,obs,opts,state) {
  const now=state.now,P=b.P,prof=obs.profile,dev=obs.device,specs=obs.action_specs;
  const summary=b.summary();
  const L=opts.lookaheadHours*HOUR;
  const mealGrams=state.pendingMeal&&now-state.pendingMeal.at<=90*MIN?state.pendingMeal.grams:0;
  const {actions:cands,info}=candidateActionsFromSpecs(specs,obs,{mealGrams,lowRisk:false});
  // Assisted care: while the person's own meal bolus is still expected, no agent bolus (it would
  // either double the dose or make the device reject the person's bolus by the minimum interval)
  // and no temp basal above the schedule.
  const personPending=!!b.selfCare&&b.selfPending.length>0;
  const actions=!personPending?cands:cands.filter(a=>!(a.type==='BOLUS'||a.type==='EXTENDED_BOLUS'||
    a.type==='TEMP_BASAL'&&(a.percent!=null?a.percent>100:a.rate_u_h>(dev.scheduled_basal_u_h??0)+1e-9)));
  // Context shared by all rollouts of this decision.
  const bolusSpec=specs.BOLUS?.units;
  const quantBolus=u=>bolusSpec?Math.min(bolusSpec.max,quant(u,bolusSpec.step,dev.type==='mdi'?'round':'down')):0;
  const knownItems=[];
  for(const [t,items] of b.items)if(t>=b.T&&t<=now)for(const it of items)if(['bolus','carbs','meal','la'].includes(it.type))knownItems.push({...it,t});
  knownItems.sort((x,y)=>x.t-y.t);
  const temp=dev.temp_basal?{rate:dev.temp_basal.rate_u_h,until:Date.parse(dev.temp_basal.ends_at),user:state.userTemp!=null}:null;
  const scheduled=dev.scheduled_basal_u_h??0;
  const k1=P.k1,k23=P.k2+P.k3;
  const ctx={b,now,T:b.T,L,dev,profile:prof,temp,scheduled,mealFactor:state.mealFactor,
    suspendedUntil:dev.suspended_until?Date.parse(dev.suspended_until):0,stopped:dev.type==='pump'&&!!dev.stop_reason&&dev.stop_reason!=='user_suspended',
    extended:dev.extended_bolus?{rate:(dev.extended_bolus.units-dev.extended_bolus.delivered_u)/Math.max(1,(Date.parse(dev.extended_bolus.ends_at)-now)/HOUR),until:Date.parse(dev.extended_bolus.ends_at)}:null,
    rateBeforeNow:dev.type==='pump'?(dev.current_basal_u_h??0)+(dev.extended_bolus?0:0):0,
    bolusRuns:(b.bolusRuns??[]).filter(r=>r.until>b.T),
    lastBolusAt:dev.last_bolus?Date.parse(dev.last_bolus.time):-Infinity,
    lastRescueAt:Math.max(-Infinity,...(obs.reported_carbs??[]).filter(c=>c.source==='agent_rescue_carbs').map(c=>Date.parse(c.time))),
    rescueAbsorption:b.desc.safety.rescue_absorption_minutes,maxBolus:bolusSpec?.max??0,quantBolus,
    knownItems,active:[...b.active,...knownItems.filter(i=>i.type==='exercise').map(i=>({from:i.t,until:i.t+i.minutes*MIN,AC:b.prior.activity.AC}))],
    cgm:!!obs.cgm,flashLow:b.flash&&!!b.flashAlarms,
    loop:dev.type==='pump'&&obs.cgm&&b.desc.controller.enabled!==false&&b.desc.controller.mode!=='open'?b.desc.controller.mode:null,
    lowAlarm:b.desc.alarms.low_mg_dl,maxBasal:Math.min(prof.max_basal_u_h??scheduled*4,specs.TEMP_BASAL?.rate_u_h?.max??Infinity),
    basalDepotU:scheduled*(1-P.fast)/60*(1/k1+1/k23)+scheduled*P.fast/60/k23,
    iob0:obs.iob?.total_u??0,iobDecay:1/((prof.dia_hours??5)*60/3),
    cob0:(obs.reported_carbs??[]).map(c=>({at:Date.parse(c.time),g:c.grams})),cobWindow:180*MIN,
    maxIob:3,maxSafeBasal:Math.min(prof.max_basal_u_h??Infinity,3*scheduled),
    rescueWindow:(b.selfCare?opts.assistedRescueHours:2)*HOUR,
  };
  if(b.selfCare)Object.assign(ctx,{
    selfCare:b.selfCare,
    // What the person last saw (the simulator's latest glucose), their last own low treatment, and
    // the device bolus gates their bolus is subject to.
    seen0:obs.glucose&&obs.glucose.value_mg_dl!=null?{v:obs.glucose.value_mg_dl,at:now-(obs.glucose.age_minutes??0)*MIN}:null,
    lastSelfLowAt:Math.max(-Infinity,...(obs.reported_carbs??[]).filter(c=>c.source==='patient').map(c=>Date.parse(c.time))),
    bolusInterval:(b.desc.safety.bolus_min_interval_minutes??15)*MIN,blockBolusBelow:b.desc.safety.block_bolus_below_mg_dl??70,
    bolusStep:bolusSpec?.step??0,bolusMin:bolusSpec?.min??0,
  });
  // CHANGE_INFUSION_SET as a candidate when an occlusion is plausible but not yet alarmed.
  if(specs.CHANGE_INFUSION_SET&&(summary.p_occluded??0)>0.15)actions.push({type:'CHANGE_INFUSION_SET'});
  const Kp=opts.planParticles,parts=b.sample(Kp,`plan:${now}`);
  const futs=parts.map((p,j)=>sampleFuture(b,p,b.T,now,now+L,Rng.stream(opts.seed,`future:${now}:${j}`)));
  const traces=[];
  const evaluate=(a,cand)=>{const c=new Float64Array(Kp),mins=new Float64Array(Kp);
    for(let j=0;j<Kp;j++) {
      ctx.rng=Rng.stream(opts.seed,`known:${now}:${j}`);ctx.trace=opts.debug?[]:null;
      const res=rollout(ctx,M.cloneParticle(parts[j]),cand,futs[j],opts);
      c[j]=res.cost;mins[j]=res.min2h;if(a===0)gNow[j]=res.gNow;
      if(opts.debug)(traces[a]??=[]).push(ctx.trace);
    }
    return {c,mins};};
  const gNow=new Float64Array(Kp);
  const wait=evaluate(0,actions[0]);
  // Carbohydrate is a rescue treatment: offered only when a low is plausible without it.
  const pLow=wait.mins.reduce((s,m)=>s+(m<opts.rescueBelow?1:0),0)/Kp;
  if(specs.INGEST_CARBS&&pLow>=opts.rescueProbability)for(const g of [8,15,25])if(g<=specs.INGEST_CARBS.grams.max)actions.push({type:'INGEST_CARBS',grams:g});
  const C=[wait.c];
  for(let a=1;a<actions.length;a++)C.push(evaluate(a,actions[a]).c);
  const futsDebug=opts.debug?futs.map(f=>f.filter(e=>e.type!=='check').map(e=>`${(e.at-b.start)/MIN}:${e.type}:${Math.round(e.grams??e.units??0)}${e.announced?'A':''}`).join(',')):null;
  const stats=C.map(c=>{const v=[...c],m=v.reduce((s,x)=>s+x,0)/Kp,sd=Math.sqrt(v.reduce((s,x)=>s+(x-m)**2,0)/Math.max(1,Kp-1));
    const tail=v.sort((x,y)=>y-x).slice(0,Math.max(1,Math.round(Kp*0.1))),cvar=tail.reduce((s,x)=>s+x,0)/tail.length;
    return {mean:m,sd,cvar,score:m+opts.riskAversion*(cvar-m)};});
  // Pick: best score; a non-WAIT action must beat WAIT by more than its paired standard error.
  let best=0;
  for(let a=1;a<actions.length;a++) {
    let d=0,d2=0;for(let j=0;j<Kp;j++){const x=C[0][j]-C[a][j];d+=x;d2+=x*x;}
    const md=d/Kp,se=Math.sqrt(Math.max(0,d2/Kp-md*md)/Math.max(1,Kp-1));
    stats[a].gain=md;stats[a].se=se;
    const gainScore=stats[0].score-stats[a].score;
    if(gainScore>Math.max(opts.minGain,opts.zSelect*se)&&stats[a].score<stats[best].score)best=a;
  }
  let chosen=actions[best],rationale=`causal: ${labelOf(chosen)} E[cost] ${stats[best].mean.toFixed(3)} vs WAIT ${stats[0].mean.toFixed(3)}`;
  // Value of information for measurement actions.
  const voi=[];
  for(const ia of info) {
    const ageOk=ia.type==='MEASURE_BG'?!(obs.meter?.last_reading&&now-Date.parse(obs.meter.last_reading.time)<20*MIN)
      :!(obs.flash?.last_scan&&now-Date.parse(obs.flash.last_scan.at)<15*MIN);
    if(!ageOk||now-state.lastInfoAction<10*MIN)continue;
    const v=valueOfInformation(b,parts,C,stats,gNow,ia,opts,now);
    const cost=ia.type==='SCAN'?opts.scanCost:opts.measureCost;
    voi.push({label:labelOf(ia),voi:round(v,4),cost});
    if(v>cost&&best===0||v>cost+stats[0].score-stats[best].score&&best!==0) {chosen=ia;rationale=`causal: ${ia.type} value of information ${v.toFixed(3)} > cost ${cost}`;}
  }
  const record={time:obs.virtual_time,minute:(now-b.start)/MIN,chosen:labelOf(chosen),action:chosen,expected_cost:round(stats[best].mean,4),
    alternatives:actions.map((a,i)=>({label:labelOf(a),expected_cost:round(stats[i].mean,4),sd:round(stats[i].sd,4),cvar90:round(stats[i].cvar,4),
      ...(i?{gain_vs_wait:round(stats[i].gain,4),se:round(stats[i].se,4)}:{})})),
    p_low_2h:round(pLow,3),...(voi.length?{information:voi}:{}),belief_time:new Date(b.T).toISOString(),
    ...(opts.debug?{debug:{mean_trajectories:traces.map((tr,a)=>({label:labelOf(actions[a]),g:tr[0].map((_,k)=>Math.round(tr.reduce((s,x)=>s+x[k],0)/tr.length)),
      min:tr[0].map((_,k)=>Math.round(Math.min(...tr.map(x=>x[k]))))})),futures:futsDebug.slice(0,8),meal_factor:state.mealFactor}}:{})};
  const belief={time:obs.virtual_time,minute:record.minute,belief_minute:summary.minute,
    glucose:pick(summary.glucose),sensitivity:pick(summary.sensitivity),effective_sensitivity:pick(summary.effective_sensitivity),
    gut_carbs_g:pick(summary.gut_carbs_g),...(summary.sensor_gain?{sensor_gain:pick(summary.sensor_gain)}:{}),
    ...(summary.p_occluded!=null?{p_occluded:round(summary.p_occluded,3)}:{}),ess:round(summary.ess,1)};
  return {chosen,rationale,record,belief};
}
/** Decision-log label; common.actionLabel plus the device and information actions it does not name. */
export function labelOf(a) {
  const simple={CANCEL_TEMP_BASAL:'CANCEL_TEMP_BASAL',CANCEL_EXTENDED_BOLUS:'CANCEL_EXTENDED_BOLUS',CANCEL_BOLUS:'CANCEL_BOLUS',RESUME_PUMP:'RESUME_PUMP',
    MEASURE_BG:'MEASURE_BG',SCAN:'SCAN',CALIBRATE_CGM:'CALIBRATE_CGM',CHANGE_INFUSION_SET:'CHANGE_INFUSION_SET'};
  if(simple[a.type])return simple[a.type];
  if(a.type==='TEMP_BASAL')return `TEMP_BASAL ${a.percent!=null?a.percent+'%':Number(a.rate_u_h.toFixed(3))+' U/h'} ${a.duration_minutes} min`;
  return actionLabel(a);
}
const pick=s=>({mean:round(s.mean,3),sd:round(s.sd,3),q05:round(s.q05,3),q95:round(s.q95,3)});

/**
 * Preposterior value of a measurement: for each planning particle i taken as the truth, draw the
 * reading it would produce, re-weight the other particles by that reading's likelihood and pick
 * the best action under those weights; the value is the drop in expected cost versus deciding
 * now. Leave-one-out weights avoid scoring a particle's own cost with its own reading.
 */
function valueOfInformation(b,parts,C,stats,gNow,ia,opts,now) {
  const K=parts.length,r=Rng.stream(opts.seed,`voi:${now}:${ia.type}`),A=C.length;
  const mu=new Float64Array(K),sd=new Float64Array(K);
  for(let j=0;j<K;j++) {
    if(ia.type==='MEASURE_BG'&&b.meter){const m=M.meterPredictive(b.meter,gNow[j]);mu[j]=m.mu;sd[j]=m.sd;}
    else if(parts[j].kf){const q=M.kfPredictive(parts[j].kf,parts[j].ig,1);mu[j]=q.mu;sd[j]=Math.sqrt(q.v);}
    else {mu[j]=gNow[j];sd[j]=5;}
  }
  let bestNow=Infinity;for(let a=0;a<A;a++)bestNow=Math.min(bestNow,stats[a].mean);
  let total=0;
  for(let i=0;i<K;i++) {
    const y=mu[i]+sd[i]*r.normal();
    let best=0,bestV=Infinity;
    const w=new Float64Array(K);let sw=0;
    for(let j=0;j<K;j++){if(j===i)continue;const z=(y-mu[j])/sd[j];w[j]=Math.exp(-0.5*z*z)/sd[j];sw+=w[j];}
    if(!(sw>0)){total+=Math.min(...C.map(c=>c[i]));continue;}
    for(let a=0;a<A;a++){let v=0;for(let j=0;j<K;j++)v+=w[j]*C[a][j];v/=sw;if(v<bestV){bestV=v;best=a;}}
    total+=C[best][i];
  }
  return bestNow-total/K;
}

// --- run harness ------------------------------------------------------------------------------

/**
 * A simulateRun policy factory for the causal agent. The factory signature is (cfg, env) because
 * that is what simulateRun passes; both are ignored, so the decider cannot read hidden state.
 */
export function causalAgentFactory(desc,options={}) {
  let agent=null;
  const factory=(_cfg,_env)=>{agent=makeCausalAgent(desc,options);return agent.policy;};
  return {factory,agent:()=>agent};
}

/**
 * Runs the causal decider on an instance spec through SimEnv. Returns the run record
 * (sweet-sim.run/v1, policy 'causal'), the decision log with expected costs of alternatives,
 * per-decision belief summaries, evaluation of the belief against the truth revealed after the
 * run (evaluation only), metrics and runtime.
 */
export function causalDecide(spec,{hours=24,id='run',...options}={}) {
  const t0=performance.now();
  const desc=publicDescription({...spec,...(hours?{horizon_minutes:Math.round(hours*60)}:{})});
  const {factory,agent}=causalAgentFactory(desc,options);
  const run=simulateRun(spec,{id,policy:factory,label:'causal',hours});
  const a=agent(),runtime_s=(performance.now()-t0)/1000;
  // Evaluation only (after the run): belief vs revealed truth.
  const truth=new Map(run.truth.map(([m,g])=>[m,g]));truth.set(0,buildInstanceConfig(spec).patient.initial_glucose_mg_dl);
  const cfg=buildInstanceConfig(spec);
  let covered=0,n=0,absErr=0;
  const beliefs=a.log.beliefs.map(bs=>{
    const g=truth.get(bs.belief_minute);if(g==null)return bs;
    n++;const inside=g>=bs.glucose.q05&&g<=bs.glucose.q95;if(inside)covered++;absErr+=Math.abs(g-bs.glucose.mean);
    return {...bs,revealed:{true_glucose:round(g,1),covered:inside}};
  });
  const last=a.log.beliefs.at(-1);
  const evaluation={glucose_coverage_90:n?round(covered/n,3):null,glucose_mae:n?round(absErr/n,2):null,n,
    true_sensitivity:round(cfg.physiology.sensitivity,4),final_sensitivity:last?last.sensitivity:null};
  const cost=traceCost(run.truth.map(x=>x[1]),options.cost??CAUSAL_DEFAULTS.cost);
  return {run,decisions:a.log.decisions,belief_summary:beliefs,belief_evaluation:evaluation,
    metrics:{...run.metrics,cost:round(cost,4)},
    runtime:{seconds:round(runtime_s,2),belief_s:round(a.log.timing.belief_ms/1000,2),plan_s:round(a.log.timing.plan_ms/1000,2),decisions:a.log.decisions.length},
    options:{...a.options}};
}

export {publicDescription};
