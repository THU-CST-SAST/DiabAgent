// MAP fitting of a person's physiology to their recorded CGM.
//
// Objective (on training days, QC-excluded readings dropped):
//   sum_i huber((cgm_hat_i - cgm_i) / sigma_i)  with sigma_i = sigma_abs + sigma_rel * cgm_i
//   + 0.5 * sum (prior residuals)^2
// Global parameters (sensitivity, glucose effectiveness, basal glucose, carb bioavailability,
// meal absorption scale, dawn fraction, CGM gain/offset) get rule-based priors (rules.mjs).
// Latent effects, each with a zero-centred prior: per-meal carb scale (log), per-day
// sensitivity level (log), and optional unannounced meals detected from large unexplained rises.
//
// Stages: Nelder-Mead on the globals with latents off -> Levenberg-Marquardt jointly on globals
// and latents -> unannounced-meal detection and refit -> Laplace covariance at the optimum.
import {buildPlan,simulate,predictSamples,DEFAULT_ABSORPTION_MINUTES} from './replay.mjs';
import {PARAM_SPECS} from './rules.mjs';
import {nelderMead,levenbergMarquardt,normalEquations,inverse,huberLoss} from './optim.mjs';
import {toZ,fromZ,dNaturalDz,clamp,round,median,MIN_MS} from './util.mjs';

export const DEFAULT_FIT_PARAMS=Object.freeze(['sensitivity','glucose_effectiveness','basal_glucose','carb_bioavailability',
  'meal_absorption_scale','dawn_fraction','cgm_gain','cgm_offset']);

export const FIT_DEFAULTS=Object.freeze({
  fitParams:DEFAULT_FIT_PARAMS,sigmaAbs:6,sigmaRel:0.06,huberDelta:1.5,
  mealLatents:true,minLatentMealGrams:10,dayLatents:true,sessionLatents:true,
  detectUnannounced:true,detectRounds:2,riseThreshold:40,minLatentGrams:8,
  maxLatentMeals:3,             // per training day
  nmEvals:400,lmIter:25,anchorGapMinutes:180,
});

/**
 * Builds the optimisation problem. trainDays: local day keys used for the data term.
 * Returns an object with decode(x), residuals(x), predict(x) and the parameter layout.
 */
export function makeProblem(trace,qc,rules,opts={}) {
  const o={...FIT_DEFAULTS,...opts},plan=opts.plan??buildPlan(trace);
  const train=new Set(opts.trainDays??qc.usableDays);
  const fixed={...(opts.fixed??{})};
  const globals=o.fitParams.filter(k=>!(k in fixed));
  const lp=rules.latent_priors;

  const dataIdx=[];plan.samples.forEach((s,i)=>{if(train.has(s.day)&&!qc.exclude.has(s.t))dataIdx.push(i);});
  const sigma=Float64Array.from(dataIdx,i=>o.sigmaAbs+o.sigmaRel*plan.samples[i].y);
  const meals=o.mealLatents?plan.meals.filter(m=>train.has(m.day)&&m.kind==='meal'&&m.grams>=o.minLatentMealGrams):[];
  const days=o.dayLatents?plan.dayKeys.map((k,i)=>({k,i})).filter(d=>train.has(d.k)):[];
  const extra=(opts.extraMeals??[]).map(e=>({...e}));
  // CGM sensor sessions: per-session gain error, linear gain drift and offset (Padova sensor model).
  const sessionStarts=qc.sessions??[plan.samples[0]?.t??plan.t0];
  const sessionOf=new Int32Array(plan.samples.length),daysIn=new Float64Array(plan.samples.length);
  plan.samples.forEach((smp,i)=>{let k=0;while(k+1<sessionStarts.length&&sessionStarts[k+1]<=smp.t)k++;sessionOf[i]=k;daysIn[i]=(smp.t-sessionStarts[k])/86400000;});
  const sessions=o.sessionLatents?[...new Set(dataIdx.map(i=>sessionOf[i]))].sort((a,b)=>a-b):[];
  // Drift is not extrapolated past a session's last training reading (holdout days keep the
  // calibration state reached at the end of training).
  const lastTrain=new Map();for(const i of dataIdx)lastTrain.set(sessionOf[i],Math.max(lastTrain.get(sessionOf[i])??0,daysIn[i]));
  plan.samples.forEach((_,i)=>{const c=lastTrain.get(sessionOf[i]);if(c!=null&&daysIn[i]>c)daysIn[i]=c;});
  // Re-anchor glucose at the start of segments that follow long gaps.
  const anchors=[];
  for(const seg of qc.segments.slice(1)) {
    const prev=trace.cgm.findLast(r=>r.t<seg.from);
    if(prev&&seg.from-prev.t>=o.anchorGapMinutes*MIN_MS) {
      const r=trace.cgm.find(x=>x.t>=seg.from);
      if(r)anchors.push({m:Math.round((r.t-plan.t0)/MIN_MS),glucose:r.mg_dl});
    }
  }
  const nG=globals.length,nM=meals.length,nD=days.length,nS=sessions.length,nE=extra.length;
  const oM=nG,oD=oM+nM,oS=oD+nD,oE=oS+3*nS,n=oE+nE;
  const layout={globals,meals:meals.map(m=>m.i),days:days.map(d=>d.k),sessions,extra:extra.length};

  function decode(x) {
    const params={...fixed};
    globals.forEach((k,i)=>{params[k]=fromZ(x[i],PARAM_SPECS[k]);});
    for(const k of Object.keys(PARAM_SPECS))params[k]??=rules.init[k]??PARAM_SPECS[k].default;
    let mealScale=null,daySens=null;
    if(nM){mealScale=new Float64Array(plan.meals.length).fill(1);meals.forEach((m,j)=>{mealScale[m.i]=Math.exp(x[oM+j]);});}
    if(nD){daySens=new Float64Array(plan.dayKeys.length).fill(1);days.forEach((d,j)=>{daySens[d.i]=Math.exp(x[oD+j]);});}
    const extraMeals=extra.map((e,j)=>({m:e.m,grams:Math.exp(x[oE+j]),absorption:e.absorption??DEFAULT_ABSORPTION_MINUTES}));
    let gain=null,offset=null;
    if(nS) {
      const g=new Map(sessions.map((k,j)=>[k,[Math.exp(x[oS+3*j]),x[oS+3*j+1],x[oS+3*j+2]]]));
      gain=new Float64Array(plan.samples.length);offset=new Float64Array(plan.samples.length);
      for(let i=0;i<gain.length;i++){const v=g.get(sessionOf[i]);if(v){gain[i]=v[0]*Math.max(0.3,1+v[1]*daysIn[i]);offset[i]=v[2];}else gain[i]=1;}
    }
    return {params,latent:{mealScale,daySens,extraMeals,anchors},gain,offset};
  }
  function priorResiduals(x,params) {
    const out=[];
    globals.forEach(k=>{const p=rules.priors[k];if(!p)return;const v=params[k];
      out.push(p.scale==='log'?(Math.log(v)-Math.log(p.mean))/p.sd:(v-p.mean)/p.sd);});
    for(let j=0;j<nM;j++)out.push(x[oM+j]/lp.meal_log_scale_sd);
    for(let j=0;j<nD;j++)out.push(x[oD+j]/lp.day_log_sensitivity_sd);
    for(let j=0;j<nS;j++){out.push(x[oS+3*j]/lp.cgm_session_log_gain_sd);out.push(x[oS+3*j+1]/lp.cgm_drift_per_day_sd);out.push(x[oS+3*j+2]/lp.cgm_session_offset_sd);}
    extra.forEach((e,j)=>out.push((x[oE+j]-Math.log(e.grams0))/1.0));
    return out;
  }
  let sims=0;
  function run(x) {
    const {params,latent,gain,offset}=decode(x);sims++;
    const sim=simulate(plan,params,latent);
    const yhat=sim.ok?predictSamples(plan,sim,params,gain):null;
    if(yhat&&offset)for(let i=0;i<yhat.length;i++)yhat[i]+=offset[i];
    return {params,latent,sim,yhat};
  }
  function residuals(x) {
    const r=run(x),prior=priorResiduals(x,r.params);
    if(!r.yhat)return {data:null,prior};
    const data=new Float64Array(dataIdx.length);
    for(let j=0;j<dataIdx.length;j++){const i=dataIdx[j];data[j]=(r.yhat[i]-plan.samples[i].y)/sigma[j];}
    return {data,prior};
  }
  function objective(x) {
    const r=residuals(x);if(!r.data)return 1e12;
    let f=0;for(const e of r.data)f+=huberLoss(e,o.huberDelta);for(const p of r.prior)f+=0.5*p*p;return f;
  }
  const x0=new Array(n).fill(0);
  globals.forEach((k,i)=>{x0[i]=toZ(clamp(opts.start?.[k]??rules.init[k]??PARAM_SPECS[k].default,...PARAM_SPECS[k].bounds),PARAM_SPECS[k]);});
  extra.forEach((e,j)=>{x0[oE+j]=Math.log(e.grams);});
  return {plan,o,globals,meals,days,sessions,sessionStarts,extra,layout,n,nG,nM,nD,nS,nE,oM,oD,oS,oE,dataIdx,sigma,anchors,x0,decode,residuals,objective,run,sims:()=>sims};
}

/** Candidate unannounced meals: large rises of the residual (recorded - simulated) with no carbs nearby. */
export function detectUnannounced(trace,problem,x,{riseThreshold=40,maxPerDay=3}={}) {
  const {plan,dataIdx}=problem,r=problem.run(x);if(!r.yhat)return [];
  const pts=dataIdx.map(i=>({t:plan.samples[i].t,day:plan.samples[i].day,y:plan.samples[i].y,res:plan.samples[i].y-r.yhat[i]}));
  // 3-point median smoothing of the residual.
  const sm=pts.map((p,i)=>median([pts[Math.max(0,i-1)].res,p.res,pts[Math.min(pts.length-1,i+1)].res]));
  // Recorded meals (and earlier latent meals) block detection nearby; small hypo treatments do not,
  // since their latent scale cannot explain a meal-sized rise.
  const known=[...trace.carbs.filter(c=>c.kind==='meal'&&c.grams>=10).map(c=>c.t),...problem.extra.map(e=>e.t)],out=[],perDay={};
  for(let i=0;i<pts.length;i++) {
    if(out.length&&pts[i].t-out.at(-1).t<3*3600000)continue;
    let best=null;
    for(let j=i+1;j<pts.length&&pts[j].t-pts[i].t<=120*MIN_MS;j++) {
      if(pts[j].t-pts[i].t<30*MIN_MS)continue;
      const rise=sm[j]-sm[i],gRise=pts[j].y-pts[i].y;
      if(rise>=riseThreshold&&gRise>=25&&(!best||rise>best.rise))best={j,rise};
    }
    if(!best)continue;
    const onset=pts[i].t-10*MIN_MS;
    if(known.some(t=>t>=onset-60*MIN_MS&&t<=pts[best.j].t))continue;
    if((perDay[pts[i].day]??0)>=maxPerDay)continue;
    perDay[pts[i].day]=(perDay[pts[i].day]??0)+1;
    const grams=clamp(best.rise/4,5,80);
    out.push({t:onset,m:Math.round((onset-plan.t0)/MIN_MS),grams,grams0:grams,absorption:DEFAULT_ABSORPTION_MINUTES,rise:round(best.rise,1)});
  }
  return out;
}

/** Laplace (Gauss-Newton) standard deviations of the globals at x, in natural units (autocorrelation-inflated). */
function laplaceSd(problem,x) {
  const r0=problem.residuals(x);if(!r0.data)return {};
  const act=x.map((_,i)=>i);
  const {A}=normalEquations(problem.residuals,x,r0,act,{delta:problem.o.huberDelta});
  const C=inverse(A);if(!C)return {};
  // CGM errors are autocorrelated (sensor AR noise, unmodelled dynamics), so 5-minute residuals
  // are not independent: inflate by the AR(1) variance factor of the residuals.
  const e=r0.data;let num=0,den=0;for(let i=1;i<e.length;i++){num+=e[i]*e[i-1];den+=e[i-1]*e[i-1];}
  const rho=clamp(den>0?num/den:0,0,0.8),inflate=Math.sqrt((1+rho)/(1-rho));
  const out={};
  problem.globals.forEach((k,i)=>{const v=Math.sqrt(Math.max(0,C[i][i]));out[k]=inflate*v*Math.abs(dNaturalDz(x[i],PARAM_SPECS[k]));});
  return out;
}

/**
 * Fits the trace. opts: FIT_DEFAULTS fields plus {trainDays, fixed, start, laplace (default true)}.
 * Returns {params, sd, latent:{meals, days, unannounced}, x, problem, objective, stats}.
 */
export function fitTrace(trace,qc,rules,opts={}) {
  const o={...FIT_DEFAULTS,...opts},t0=Date.now(),plan=buildPlan(trace);
  let evals=0;
  // Stage 1: globals only, Nelder-Mead.
  const p1=makeProblem(trace,qc,rules,{...o,plan,mealLatents:false,dayLatents:false,extraMeals:[]});
  const nm=nelderMead(p1.objective,p1.x0,{step:0.25,maxEvals:o.nmEvals});evals+=nm.evals;
  let start=p1.decode(nm.x).params;
  // Stage 2: joint LM with latents; Stage 3: unannounced meals.
  let extraMeals=[],prob,lm,rounds=0;
  for(;;) {
    prob=makeProblem(trace,qc,rules,{...o,plan,start,extraMeals});
    // Warm start the latents from the previous round where they match.
    const x0=prob.x0.slice();
    if(lm&&lm.prob) {
      const prev=lm.prob;
      prev.meals.forEach((m,j)=>{const k=prob.meals.findIndex(q=>q.i===m.i);if(k>=0)x0[prob.oM+k]=lm.x[prev.oM+j];});
      prev.days.forEach((d,j)=>{const k=prob.days.findIndex(q=>q.k===d.k);if(k>=0)x0[prob.oD+k]=lm.x[prev.oD+j];});
      prev.sessions.forEach((sn,j)=>{const k=prob.sessions.indexOf(sn);if(k>=0){x0[prob.oS+3*k]=lm.x[prev.oS+3*j];x0[prob.oS+3*k+1]=lm.x[prev.oS+3*j+1];x0[prob.oS+3*k+2]=lm.x[prev.oS+3*j+2];}});
    }
    let res=levenbergMarquardt(prob.residuals,x0,{delta:o.huberDelta,maxIter:o.lmIter});evals+=res.evals;
    if(rounds>0) {
      // Newly explained rises can move the globals far from the previous basin: also try from the prior.
      const xb=x0.slice();prob.globals.forEach((k,i)=>{xb[i]=toZ(clamp(rules.init[k]??PARAM_SPECS[k].default,...PARAM_SPECS[k].bounds),PARAM_SPECS[k]);});
      const alt=levenbergMarquardt(prob.residuals,xb,{delta:o.huberDelta,maxIter:o.lmIter});evals+=alt.evals;
      if(alt.f<res.f)res=alt;
    }
    lm={...res,prob};
    if(!o.detectUnannounced||rounds>=o.detectRounds)break;
    // Keep latent meals the fit supports, then look for more.
    const kept=prob.extra.map((e,j)=>({...e,grams:Math.exp(res.x[prob.oE+j])})).filter(e=>e.grams>=o.minLatentGrams);
    const found=detectUnannounced(trace,prob,res.x,{riseThreshold:o.riseThreshold,maxPerDay:o.maxLatentMeals});
    rounds++;
    if(!found.length&&kept.length===prob.extra.length)break;
    extraMeals=[...kept,...found];
    start=prob.decode(res.x).params;
  }
  const x=lm.x,{params,latent}=prob.decode(x);
  const sd=o.laplace===false?{}:laplaceSd(prob,x);
  const r=prob.residuals(x);
  const mealsOut=prob.meals.map((m,j)=>({t:new Date(m.t).toISOString(),day:m.day,reported_g:m.grams,scale:round(Math.exp(x[prob.oM+j]),3),
    fitted_g:round(m.grams*Math.exp(x[prob.oM+j]),1)}));
  const daysOut=prob.days.map((d,j)=>({day:d.k,sensitivity_multiplier:round(Math.exp(x[prob.oD+j]),3)}));
  const sessionsOut=prob.sessions.map((k,j)=>({start:new Date(prob.sessionStarts[k]).toISOString(),gain:round(Math.exp(x[prob.oS+3*j]),4),
    drift_per_day:round(x[prob.oS+3*j+1],4),offset_mg_dl:round(x[prob.oS+3*j+2],2)}));
  const unannounced=prob.extra.map((e,j)=>({t:new Date(e.t).toISOString(),grams:round(Math.exp(x[prob.oE+j]),1),rise_mg_dl:e.rise}))
    .filter(e=>e.grams>=o.minLatentGrams);
  return {params,sd,latent:{meals:mealsOut,days:daysOut,sensor_sessions:sessionsOut,unannounced},x,problem:prob,
    objective:round(lm.f,3),stats:{evaluations:evals,nm_evals:nm.evals,lm_iterations:lm.iterations,detect_rounds:rounds,
      n_data:prob.dataIdx.length,n_params:prob.n,seconds:round((Date.now()-t0)/1000,2),
      rms_scaled_residual:r.data?round(Math.sqrt(r.data.reduce((s,v)=>s+v*v,0)/r.data.length),3):null}};
}

/** Simulated CGM for every trace sample under a fit (holdout days use reported carbs, no latents). */
export function predictFit(fit) {
  const r=fit.problem.run(fit.x);
  return fit.problem.plan.samples.map((s,i)=>({t:s.t,day:s.day,recorded:s.y,simulated:r.yhat?r.yhat[i]:null,plasma:r.sim.G[Math.round(s.x)]}));
}
