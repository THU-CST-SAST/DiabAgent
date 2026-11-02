// Experiment 4 (Real -> Sim -> Real), MVP on synthetic "real" people.
//
// The simulator plays reality: each "real" person is a World instance with a fixed hidden
// individual (person.seed, sampled physiology plus hidden overrides), so ground truth is known
// and sim -> real transfer can be measured exactly.
//
//   4a/4b real -> sim   the person lives `days` (14) days under usual care (patient baseline
//                       policy). Only what a Nightscout export would contain is recorded: CGM
//                       (sgv), routine fingersticks (mbg), boluses, temp basals, basal injections,
//                       reported carbs, exercise, the profile. trace2sim reconstructs a twin from
//                       days 1..days-holdout (refitAll=false, so the twin never sees the holdout)
//                       and is validated on the holdout days: replay MARD vs CGM, error vs the
//                       independent fingersticks, error vs the hidden true glucose, parameter
//                       recovery vs the hidden truth.
//   4c sim evaluation   agents (wait, patient, oref0, causal) on the twin for N future days.
//   4d sim -> real      the same agents on the hidden person with the same future day seeds
//                       (possible only because reality is simulated); twin vs real reward,
//                       transfer gap, Kendall tau of the rankings, best-on-twin == best-on-real.
//                       Retrospective check: the recorded usual-care decisions of the holdout
//                       days replayed on the twin vs the recorded ("real") glucose.
//
// Privacy (for the real-volunteer version): the twin export (trace2sim reconstructionDocument)
// holds only derived values (parameters, latent summaries, fit metrics, anonymous id); raw CGM,
// insulin and carb records never leave the volunteer's machine. With real volunteers there is no
// "real" role that an agent can act on: 4d becomes a retrospective comparison against recorded
// decisions and outcomes, and 4e a prospective advisory evaluation (agent suggestions reviewed by
// a clinician or the volunteer, ethics approval and informed consent, no automatic dosing).
import {buildInstanceConfig} from '../sim/instance.mjs';
import {SimEnv} from '../env/pomdp.mjs';
import {patientPolicy} from '../policies/patient.mjs';
import {oref0Policy} from '../policies/oref0.mjs';
import {makeCausalAgent} from '../oracle/causal.mjs';
import {publicDescription} from '../oracle/belief.mjs';
import {episodeMetrics,episodeScore} from '../bench/score.mjs';
import {reconstruct,reconstructionDocument,predictFit} from '../trace2sim/index.mjs';
import {agreement} from '../trace2sim/validate.mjs';

export const EXP4_FORMAT='sweet-sim.exp4-real2sim2real/v1';
export const EXPERIMENT_ID='exp4-real2sim2real';
const MIN=60000,DAY=86400000;
const round=(v,d=4)=>v==null||!Number.isFinite(v)?null:Number(v.toFixed(d));
const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:null;
const localDay=(ms,off)=>new Date(ms+off*MIN).toISOString().slice(0,10);

export const RECORD_START='2026-09-01T16:00:00.000Z';   // 00:00 local at UTC+8
export const DEFAULT_SMBG_TIMES=['07:15','11:45','18:15','22:30'];

/**
 * Hidden "real" persons: varied person types, pumps and pens, CGMs, a fingerstick meter with a
 * routine of 4 checks/day, unannounced meals and the person model's daily sensitivity variation.
 * `hidden` physiology is never given to trace2sim or the agents. Some persons have event packs
 * (high-fat meals, stress) that the twin's model class cannot represent: deliberate mismatch.
 */
export const PERSONS=Object.freeze([
  {id:'p1',type:'adult_male',bmi:'normal',dawn:'present',carb_counting:'typical',person_seed:4101,
    therapy:{mode:'pump',pump:{model:'dana_i',insulin:'aspart'}},cgm:'dexcom_g6',meter:'contour_next_one',
    announce_probability:0.85,events:['baseline','high_fat_meals'],hidden:{carb_bioavailability:0.85,meal_absorption_scale:1.3}},
  {id:'p2',type:'adult_female',bmi:'overweight',dawn:'absent',carb_counting:'poor',person_seed:4102,
    therapy:{mode:'mdi',mdi:{bolus_pen:'novopen_echo',bolus_insulin:'aspart',basal_pen:'tresiba_flextouch',basal_insulin:'degludec'}},
    cgm:'libre_3',meter:'accu_chek_guide',announce_probability:0.8,hidden:{carb_bioavailability:0.95,meal_absorption_scale:0.9}},
  {id:'p3',type:'adolescent_male',bmi:'normal',dawn:'present',carb_counting:'poor',person_seed:4103,
    therapy:{mode:'pump',pump:{model:'omnipod_dash',insulin:'lispro'}},cgm:'dexcom_g7',meter:'contour_next_one',
    announce_probability:0.75,events:['baseline','stress'],hidden:{carb_bioavailability:0.9,meal_absorption_scale:1.1}},
  {id:'p4',type:'older_female',bmi:'normal',dawn:'absent',carb_counting:'accurate',person_seed:4104,
    therapy:{mode:'mdi',mdi:{bolus_pen:'humalog_kwikpen',bolus_insulin:'lispro',basal_pen:'lantus_solostar',basal_insulin:'glargine_u100'}},
    cgm:'dexcom_g6',meter:'onetouch_verio_reflect',announce_probability:0.95,hidden:{carb_bioavailability:0.8,meal_absorption_scale:1.2}},
  {id:'p5',type:'child_female',bmi:'normal',dawn:'absent',carb_counting:'typical',person_seed:4105,
    therapy:{mode:'pump',pump:{model:'medtrum_nano',insulin:'aspart'}},cgm:'dexcom_g7',meter:'accu_chek_guide',
    announce_probability:0.85,events:['baseline','high_fat_meals'],hidden:{carb_bioavailability:1.0,meal_absorption_scale:0.8}},
  {id:'p6',type:'adult_male',bmi:'obese',dawn:'present',carb_counting:'typical',person_seed:4106,
    therapy:{mode:'mdi',mdi:{bolus_pen:'novopen_6',bolus_insulin:'fiasp',basal_pen:'toujeo_solostar',basal_insulin:'glargine_u300'}},
    cgm:'libre_2',meter:'contour_next_one',announce_probability:0.9,hidden:{carb_bioavailability:0.9,meal_absorption_scale:1.0}},
]);

export const AGENT_IDS=['wait','patient','oref0','causal'];
export const DEFAULTS=Object.freeze({days:14,holdoutDays:4,futureDays:3,agents:AGENT_IDS,causal:{seed:1,fast:false},
  recordSeed:null,recordStart:RECORD_START});

/** Seed of the recorded period and of future day k for a person (fixed, so tasks are reproducible). */
export const recordSeedOf=p=>p.person_seed*10+1;
export const futureSeedOf=(p,k)=>p.person_seed*100+50+k;

/** Instance spec of the hidden person (the "real" role). Same shape as any bench instance spec. */
export function realSpec(p,{seed,start_time,horizon_minutes=1440}) {
  return {id:`exp4-real-${p.id}`,seed,start_time,horizon_minutes:Math.min(horizon_minutes,10080),
    person:{type:p.type,bmi:p.bmi??'normal',dawn:p.dawn??'absent',carb_counting:p.carb_counting??'typical',sample:true,seed:p.person_seed},
    therapy:p.therapy,sensors:{cgm:p.cgm,meter:p.meter??null},controller:{mode:'open'},self_care:'none',events:[...(p.events??['baseline'])],
    overrides:{physiology:{...(p.hidden??{})},scenario:{announcement:{probability:p.announce_probability??1}},
      ...(p.meter?{meter:{routine_times:p.smbg_times??DEFAULT_SMBG_TIMES}}:{})}};
}

/** Twin spec for one future episode: the trace2sim export with the episode seed, start and horizon. */
export function twinEpisodeSpec(twinSpec,{seed,start_time,horizon_minutes=1440}) {
  return {...structuredClone(twinSpec),seed,start_time,horizon_minutes};
}

const NS_TYPES=new Set(['Meal Bolus','Correction Bolus','Temp Basal','Carb Correction','Combo Bolus','Basal Injection']);

/**
 * 4a: the hidden person lives `days` days under usual care. World runs past the config horizon
 * cap (7 days): the episode end is moved, events are generated per day. Returns
 * {nightscout, meta, smbg, truth} where truth (glucose at each CGM sample, physiology, person,
 * daily sensitivity levels) is evaluator-only.
 */
export function recordUsualCare(p,{days=DEFAULTS.days,seed=recordSeedOf(p),start_time=RECORD_START}={}) {
  const spec=realSpec(p,{seed,start_time,horizon_minutes:Math.min(days*1440,10080)});
  const cfg=buildInstanceConfig(spec),env=new SimEnv(cfg),w=env.world,c=w.config;
  env.end=env.start+days*DAY;
  const decide=patientPolicy(),entries=[],treatments=[],truthCgm=[];
  const collect=()=>{
    const out=w.drain();
    for(const s of out.samples) {
      if(s.type==='sgv'){entries.push({type:'sgv',sgv:Math.round(s.observed),date:s.at,dateString:new Date(s.at).toISOString()});truthCgm.push({t:s.at,g:s.glucose});}
      else if(s.type==='mbg')entries.push({type:'mbg',mbg:Math.round(s.observed),date:s.at,dateString:new Date(s.at).toISOString(),_true:s.glucose});
    }
    for(const t of out.treatments) {
      if(!NS_TYPES.has(t.eventType))continue;
      const doc={_id:String(t.id),eventType:t.eventType,created_at:new Date(t.at).toISOString(),enteredBy:t.source??'patient'};
      if(t.carbs!=null){doc.carbs=t.carbs;doc.absorptionTime=t.eventType==='Carb Correction'?c.safety.rescue_absorption_minutes:w.events.find(e=>e.id===t.id)?.absorption_minutes;}
      if(t.insulin!=null)doc.insulin=t.insulin;
      if(t.insulinType)doc.insulinType=t.insulinType;
      if(t.absolute!=null){doc.absolute=t.absolute;doc.duration=t.duration;}
      treatments.push(doc);
    }
  };
  collect();
  let lastRefillDay=0;
  while(!env.done()) {
    const day=Math.floor((w.now-env.start)/DAY);
    if(w.device.kind==='pump'&&day>lastRefillDay){w.device.maintenance({reservoirU:w.device.spec.reservoir_u});lastRefillDay=day;}
    const d=decide(env.observe());
    const res=env.step({action_id:`uc-${env.step_count}`,expected_step:env.step_count,action:d.action,rationale:d.rationale});
    for(const n of res.observation.events)if(n.type==='exercise_started')
      treatments.push({_id:n.id,eventType:'Exercise',created_at:n.time,duration:n.duration_minutes,intensity:'moderate',enteredBy:'patient'});
    collect();
    // Bound memory: the record lives in entries/treatments; trajectory and evaluator are not needed.
    env.cache={};env.transitions[env.transitions.length-1].next_observation=null;env.evaluator.length=0;
  }
  if(w.terminated)throw new Error(`real person ${p.id} terminated: ${w.error}`);
  const off=c.utc_offset_minutes,dayKeys=[...new Set(entries.map(e=>localDay(e.date,off)))].sort();
  const noon=k=>Date.parse(`${k}T12:00:00Z`)-off*MIN;
  const profile={defaultProfile:'Default',store:{Default:{units:'mg/dl',
    basal:[{time:'00:00',value:w.device.kind==='pump'?w.device.scheduledBasalUph:c.profile.basal_u_h}],sens:[{time:'00:00',value:c.profile.isf_mg_dl_per_u}],
    carbratio:[{time:'00:00',value:c.profile.carb_ratio_g_per_u}],target_low:[{time:'00:00',value:c.profile.target_mg_dl}],target_high:[{time:'00:00',value:c.profile.target_mg_dl}]}}};
  const meta={id:`exp4-${p.id}`,sex:c.patient.sex,age_years:c.patient.age_years,weight_kg:c.patient.weight_kg,height_cm:c.patient.height_cm,
    therapy:p.therapy,cgm_model:p.cgm,meter:p.meter??null,utc_offset_minutes:off};
  const smbg=entries.filter(e=>e.type==='mbg').map(e=>({t:e.date,mg_dl:e.mbg,true_mg_dl:e._true}));
  for(const e of entries)delete e._true;
  const meals=w.events.filter(e=>e.type==='meal'&&e.at>=env.start&&e.at<env.end);
  return {nightscout:{entries,treatments,profile},meta,smbg,days:dayKeys,n_days:days,
    truth:{physiology:{...c.physiology},person:c.person.resolved,profile:{...c.profile},cgm_true:truthCgm,
      daily_sensitivity:Object.fromEntries(dayKeys.map(k=>[k,w.sensitivityMultiplier(noon(k))])),
      meals:{total:meals.length,unannounced:meals.filter(m=>m.announced_grams==null).length},summary:w.summary()},
    spec};
}

const PARAMS=['sensitivity','carb_bioavailability','meal_absorption_scale','dawn_fraction','glucose_effectiveness','basal_glucose'];
const KERNEL_DEFAULT={glucose_effectiveness:0.0126,basal_glucose:120,carb_bioavailability:1,meal_absorption_scale:1,dawn_fraction:0};

/** Pairs a reading list with the nearest fit row within 5 minutes. */
function nearestPairs(rows,points,valueOf,simOf) {
  const out=[];let j=0;
  for(const p of points) {
    while(j+1<rows.length&&Math.abs(rows[j+1].t-p.t)<=Math.abs(rows[j].t-p.t))j++;
    const r=rows[j];if(r&&Math.abs(r.t-p.t)<=5*MIN){const s=simOf(r);if(Number.isFinite(s))out.push({recorded:valueOf(p),simulated:s});}
  }
  return out;
}
const pickAgreement=m=>m&&{n:m.n,mard:m.mard,rmse:m.rmse,bias:m.bias,tir_recorded:m.tir_recorded,tir_simulated:m.tir_simulated,tir_diff:m.tir_diff,
  mean_recorded:m.mean_recorded,mean_simulated:m.mean_simulated};

/**
 * 4b: reconstructs the twin from the first days-holdoutDays days and validates it on the
 * holdout days. Returns {result (reconstruct output), twin (export document), fit report}.
 */
export function reconstructTwin(rec,{holdoutDays=DEFAULTS.holdoutDays}={}) {
  // The record ends with one reading at local midnight of day days+1, which QC drops (partial day).
  const n=rec.n_days??rec.days.length;
  const r=reconstruct(rec.nightscout,{meta:rec.meta,holdoutFraction:holdoutDays/n,splitMode:'last',refitAll:false,id:`twin-${rec.meta.id.replace(/^exp4-/,'')}`});
  const off=rec.meta.utc_offset_minutes,ho=new Set(r.split.holdout),inHo=t=>ho.has(localDay(t,off));
  const rows=predictFit(r.fits.train).filter(x=>!r.qcInternal.exclude.has(x.t));
  const hoRows=rows.filter(x=>inHo(x.t)),smbgHo=rec.smbg.filter(s=>inHo(s.t)),trueHo=rec.truth.cgm_true.filter(s=>inHo(s.t));
  // Independent fingersticks (not used by the fit): twin-predicted plasma glucose vs SMBG, and the CGM vs SMBG reference.
  const smbg={twin_vs_smbg:pickAgreement(agreement(nearestPairs(hoRows,smbgHo,s=>s.mg_dl,x=>x.plasma))),
    cgm_vs_smbg:pickAgreement(agreement(nearestPairs(hoRows,smbgHo,s=>s.mg_dl,x=>x.recorded)))};
  // Evaluator-only: against the hidden true plasma glucose (impossible with real volunteers).
  const truth={twin_vs_true:pickAgreement(agreement(nearestPairs(hoRows,trueHo,s=>s.g,x=>x.plasma))),
    cgm_vs_true:pickAgreement(agreement(nearestPairs(hoRows,trueHo,s=>s.g,x=>x.recorded)))};
  // Parameter recovery. Sensitivity: truth x mean daily level over the training days.
  const tp=rec.truth.physiology,levels=r.split.train.map(k=>rec.truth.daily_sensitivity[k]).filter(Number.isFinite);
  const trueOf=k=>k==='sensitivity'?tp.sensitivity*(mean(levels)??1):tp[k]??KERNEL_DEFAULT[k];
  const recovery=Object.fromEntries(PARAMS.map(k=>{const est=r.fit.params[k],tru=trueOf(k);
    return [k,{true:round(tru,5),fitted:round(est,5),laplace_sd:round(r.fit.sd[k],5),
      error:k==='dawn_fraction'?round(est-tru,4):round(est/tru-1,4),error_kind:k==='dawn_fraction'?'absolute':'relative'}];}));
  const report={id:r.id,split:r.split,grade:r.validation.grade,seconds:r.seconds,
    train:pickAgreement(r.validation.train),holdout:pickAgreement(r.validation.holdout),smbg,truth,recovery,
    unannounced:{true_meals:rec.truth.meals.unannounced,fitted_latent:r.fit.latent.unannounced.length},
    warnings:r.warnings,spec_builds:!!r.config};
  return {result:r,twin:reconstructionDocument(r),report};
}

/** 4d retrospective: the recorded usual-care holdout days replayed on the twin, per day. */
export function retrospectiveCheck(r,rec) {
  const off=rec.meta.utc_offset_minutes,rows=predictFit(r.fits.train).filter(x=>!r.qcInternal.exclude.has(x.t));
  return r.split.holdout.map(day=>{
    const d=rows.filter(x=>localDay(x.t,off)===day),tru=rec.truth.cgm_true.filter(s=>localDay(s.t,off)===day);
    const m=agreement(d.map(x=>({recorded:x.recorded,simulated:x.simulated})));
    const mt=agreement(nearestPairs(d,tru,s=>s.g,x=>x.plasma));
    return {day,n:m?.n??0,cgm:pickAgreement(m),true_glucose:pickAgreement(mt)};
  });
}

// ---- agents and episodes ------------------------------------------------------------------

/** Agent factories: spec -> (obs -> {action, rationale}). The causal agent sees only publicDescription(spec). */
export function agentPolicy(id,spec,{causal=DEFAULTS.causal}={}) {
  if(id==='wait')return ()=>({action:{type:'WAIT'},rationale:'wait'});
  if(id==='patient')return patientPolicy();
  if(id==='oref0')return obs=>oref0Policy(obs);
  if(id==='causal')return makeCausalAgent(publicDescription(spec),causal).policy;
  throw new Error(`unknown agent ${id}`);
}

/** One full-track episode; returns the bench score S (§5.2) and headline metrics. */
export function runEpisode(spec,agent,opts={}) {
  const t0=performance.now(),env=new SimEnv(buildInstanceConfig(spec)),decide=agentPolicy(agent,spec,opts);
  while(!env.done()) {
    const d=decide(env.observe());
    env.step({action_id:`${agent}-${env.step_count}`,expected_step:env.step_count,action:d.action,rationale:String(d.rationale??'').slice(0,4000)});
  }
  const m=episodeMetrics(env.exportBundle()),s=episodeScore(m),g=m.glucose;
  return {agent,reward:round(s.score),raw:round(s.raw),safety_fail:s.safety_fail,tir:round(g.tir),tbr70:round(g.tbr70),tbr54:round(g.tbr54),
    tar250:round(g.tar250),mean_mgdl:round(g.mean,1),risk:round(g.kovatchev_risk_mean,3),steps:env.step_count,completed:m.completed_horizon,seconds:round((performance.now()-t0)/1000,2)};
}

// ---- transfer metrics -----------------------------------------------------------------------

const sign=(x,eps)=>Math.abs(x)<=eps?0:Math.sign(x);
/** Pair counts for Kendall's tau-b (ties within eps). */
export function kendallCounts(a,b,eps=1e-9) {
  let c=0,d=0,ta=0,tb=0;
  for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++) {
    const x=sign(a[i]-a[j],eps),y=sign(b[i]-b[j],eps);
    if(x===0&&y===0)continue;if(x===0)ta++;else if(y===0)tb++;else if(x===y)c++;else d++;
  }
  return {concordant:c,discordant:d,ties_a:ta,ties_b:tb};
}
export function tauFromCounts({concordant:c,discordant:d,ties_a:ta,ties_b:tb}) {
  const den=Math.sqrt((c+d+ta)*(c+d+tb));return den?(c-d)/den:null;
}
/** Kendall's tau-b; null when either ranking is constant. */
export const kendallTau=(a,b,eps)=>tauFromCounts(kendallCounts(a,b,eps));

/**
 * rows: [{person, agent, twin_reward, real_reward}] (rewards = mean S over the future days).
 * Returns per-agent rows with transfer_gap, per-person rank agreement and pooled summaries.
 */
export function transferMetrics(rows,{eps=1e-9}={}) {
  const persons=[...new Set(rows.map(r=>r.person))],agents=[...new Set(rows.map(r=>r.agent))];
  const per=rows.map(r=>({...r,transfer_gap:round(r.twin_reward-r.real_reward)}));
  const total={concordant:0,discordant:0,ties_a:0,ties_b:0},totalRisk={...total};
  const hasRisk=per.every(r=>Number.isFinite(r.twin_risk)&&Number.isFinite(r.real_risk));
  const byPerson=persons.map(p=>{
    const rs=per.filter(r=>r.person===p),tw=rs.map(r=>r.twin_reward),re=rs.map(r=>r.real_reward);
    const k=kendallCounts(tw,re,eps);for(const key in total)total[key]+=k[key];
    // Secondary ranking by mean glucose risk (continuous, so S ties at 1 are broken).
    const kr=hasRisk?kendallCounts(rs.map(r=>-r.twin_risk),rs.map(r=>-r.real_risk),eps):null;
    if(kr)for(const key in totalRisk)totalRisk[key]+=kr[key];
    const maxT=Math.max(...tw),maxR=Math.max(...re);
    const bestTwin=rs.filter(r=>r.twin_reward>=maxT-eps).map(r=>r.agent),bestReal=rs.filter(r=>r.real_reward>=maxR-eps).map(r=>r.agent);
    // Regret: real reward lost by deploying the twin's choice (worst case over twin ties).
    const regret=Math.max(...rs.filter(r=>bestTwin.includes(r.agent)).map(r=>maxR-r.real_reward));
    return {person:p,kendall_tau:round(tauFromCounts(k)),pairs:k,kendall_tau_risk:kr?round(tauFromCounts(kr)):null,best_on_twin:bestTwin,best_on_real:bestReal,
      best_twin_is_best_real:bestTwin.every(a=>bestReal.includes(a)),real_regret:round(regret),
      mean_abs_gap:round(mean(rs.map(r=>Math.abs(r.transfer_gap))))};
  });
  const agentMeans=agents.map(a=>{const rs=per.filter(r=>r.agent===a);
    return {agent:a,twin_reward:round(mean(rs.map(r=>r.twin_reward))),real_reward:round(mean(rs.map(r=>r.real_reward))),
      transfer_gap:round(mean(rs.map(r=>r.transfer_gap))),mean_abs_gap:round(mean(rs.map(r=>Math.abs(r.transfer_gap))))};});
  const taus=byPerson.map(p=>p.kendall_tau).filter(Number.isFinite);
  return {rows:per,by_person:byPerson,by_agent:agentMeans,
    pooled:{kendall_tau_stratified:round(tauFromCounts(total)),pairs:total,
      kendall_tau_risk_stratified:hasRisk?round(tauFromCounts(totalRisk)):null,kendall_tau_mean:round(mean(taus)),persons_with_tau:taus.length,
      kendall_tau_agent_means:round(kendallTau(agentMeans.map(a=>a.twin_reward),agentMeans.map(a=>a.real_reward),eps)),
      best_match_rate:round(mean(byPerson.map(p=>p.best_twin_is_best_real?1:0))),mean_real_regret:round(mean(byPerson.map(p=>p.real_regret))),
      mean_abs_gap:round(mean(per.map(r=>Math.abs(r.transfer_gap)))),mean_gap:round(mean(per.map(r=>r.transfer_gap)))}};
}

// ---- one person end to end -------------------------------------------------------------------

/** Paired Harbor-style tasks for one person: one real and one twin task per future day. */
export function pairedTasks(p,twinDoc,{futureDays,recordStart,days,minutes=1440,references={}}) {
  const tasks=[],pairs=[];
  for(let k=0;k<futureDays;k++) {
    const seed=futureSeedOf(p,k),start_time=new Date(Date.parse(recordStart)+(days+k)*DAY).toISOString(),pair_id=`exp4-${p.id}-d${k}`;
    const common={experiment:EXPERIMENT_ID,track:'full',pair_id,person:p.id,future_day:k,episode_seed:seed,horizon_minutes:minutes,
      scoring_version:'bench-v0.2'};
    const real={task_id:`${pair_id}-real`,spec:realSpec(p,{seed,start_time,horizon_minutes:minutes}),hours:minutes/60,verifier:'episode',
      metadata:{...common,role:'real',instance_id:`exp4-real-${p.id}`,person_seed:p.person_seed,references:references.real?.[k]??null}};
    const twin={task_id:`${pair_id}-twin`,spec:{id:twinDoc.id,...twinEpisodeSpec(twinDoc.spec,{seed,start_time,horizon_minutes:minutes})},hours:minutes/60,verifier:'episode',
      metadata:{...common,role:'twin',instance_id:twinDoc.id,twin_source:twinDoc.version,twin_grade:twinDoc.validation?.grade??null,
        references:references.twin?.[k]??null}};
    tasks.push(real,twin);pairs.push({pair_id,real_task:real.task_id,twin_task:twin.task_id});
  }
  return {tasks,pairs};
}

/**
 * Runs 4a-4d for one person. opts: DEFAULTS fields; onProgress(msg).
 * Returns a serializable result; `nightscout`/`meta` hold the synthetic person's recorded trace
 * (synthetic data; with real volunteers this would never be written).
 */
export function runPerson(p,opts={}) {
  const o={...DEFAULTS,...opts,causal:{...DEFAULTS.causal,...(opts.causal??{})}},log=o.onProgress??(()=>{});
  const T={},tic=()=>performance.now(),toc=(k,t)=>{T[k]=round((performance.now()-t)/1000,2);};
  let t=tic();const rec=recordUsualCare(p,{days:o.days,seed:o.recordSeed??recordSeedOf(p),start_time:o.recordStart});toc('record',t);
  log(`${p.id}: recorded ${rec.days.length} d (${rec.nightscout.entries.length} entries, ${rec.nightscout.treatments.length} treatments) in ${T.record}s`);
  t=tic();const {result,twin,report}=reconstructTwin(rec,{holdoutDays:o.holdoutDays});toc('reconstruct',t);
  const retro=retrospectiveCheck(result,rec);
  log(`${p.id}: twin ${twin.id} grade ${report.grade}, holdout MARD ${report.holdout?.mard} in ${T.reconstruct}s`);
  t=tic();
  const episodes=[];
  for(let k=0;k<o.futureDays;k++) {
    const seed=futureSeedOf(p,k),start_time=new Date(Date.parse(o.recordStart)+(o.days+k)*DAY).toISOString();
    const specs={real:realSpec(p,{seed,start_time,horizon_minutes:o.episodeMinutes??1440}),
      twin:twinEpisodeSpec(twin.spec,{seed,start_time,horizon_minutes:o.episodeMinutes??1440})};
    for(const agent of o.agents)for(const role of ['twin','real']) {
      const e=runEpisode(specs[role],agent,{causal:o.causal});
      episodes.push({person:p.id,role,future_day:k,seed,...e});
    }
    log(`${p.id}: future day ${k} done`);
  }
  toc('episodes',t);
  const agentRows=o.agents.map(a=>{const of=role=>mean(episodes.filter(e=>e.agent===a&&e.role===role).map(e=>e.reward));
    const risk=role=>mean(episodes.filter(e=>e.agent===a&&e.role===role).map(e=>e.risk));
    return {person:p.id,agent:a,twin_reward:round(of('twin')),real_reward:round(of('real')),twin_risk:round(risk('twin'),3),real_risk:round(risk('real'),3)};});
  const refs=role=>Array.from({length:o.futureDays},(_,k)=>Object.fromEntries(o.agents.map(a=>[a,episodes.find(e=>e.agent===a&&e.role===role&&e.future_day===k)?.reward??null])));
  const {tasks,pairs}=pairedTasks(p,twin,{futureDays:o.futureDays,recordStart:o.recordStart,days:o.days,minutes:o.episodeMinutes??1440,references:{real:refs('real'),twin:refs('twin')}});
  return {person:{id:p.id,type:p.type,therapy:p.therapy.mode,device:p.therapy.mode==='pump'?p.therapy.pump.model:p.therapy.mdi.bolus_pen,cgm:p.cgm,meter:p.meter,
      announce_probability:p.announce_probability},
    record:{days:rec.n_days,entries:rec.nightscout.entries.length,smbg:rec.smbg.length,treatments:rec.nightscout.treatments.length,
      usual_care:{tir:round(rec.truth.summary.tir_70_180),tbr70:round(rec.truth.summary.tbr_below70),mean_mgdl:round(rec.truth.summary.mean_glucose,1)},
      unannounced_meals:rec.truth.meals.unannounced,meals:rec.truth.meals.total},
    fit:report,retrospective:retro,twin,episodes,agents:agentRows,transfer:transferMetrics(agentRows).by_person[0],tasks,pairs,
    seconds:T,nightscout:rec.nightscout,meta:rec.meta};
}

/** Pools person results into the experiment summary. */
export function summarize(results,opts={}) {
  const rows=results.flatMap(r=>r.agents);
  const fit=results.map(r=>({person:r.person.id,grade:r.fit.grade,holdout_mard:r.fit.holdout?.mard,twin_vs_smbg_mard:r.fit.smbg.twin_vs_smbg?.mard,
    cgm_vs_smbg_mard:r.fit.smbg.cgm_vs_smbg?.mard,twin_vs_true_mard:r.fit.truth.twin_vs_true?.mard,
    sensitivity_error:r.fit.recovery.sensitivity.error,tir_diff:r.fit.holdout?.tir_diff}));
  const {onProgress,...o}={...DEFAULTS,...opts};
  return {format:EXP4_FORMAT,experiment:EXPERIMENT_ID,options:o,persons:results.length,
    fit,transfer:transferMetrics(rows),pairs:results.flatMap(r=>r.pairs)};
}
