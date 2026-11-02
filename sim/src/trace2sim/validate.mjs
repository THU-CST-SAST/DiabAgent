// Train/holdout split by local day, agreement metrics between simulated and recorded CGM,
// quality grade, and an optional (cheap) day-level bootstrap of the global parameters.
import {levenbergMarquardt} from './optim.mjs';
import {predictFit} from './fit.mjs';
import {PARAM_SPECS} from './rules.mjs';
import {fromZ,mean,sd,quantile,round,prng} from './util.mjs';

/**
 * Splits usable days into train and holdout.
 * mode 'last' holds out the last fraction of days (forecast-like), 'interleaved' every k-th day.
 */
export function splitDays(usableDays,{holdoutFraction=0.3,mode='last'}={}) {
  const days=[...usableDays].sort(),n=days.length;
  if(n<2)return {train:days,holdout:[]};
  const h=Math.max(1,Math.min(n-1,Math.round(n*holdoutFraction)));
  if(mode==='interleaved'){const k=Math.max(2,Math.round(n/h));const holdout=days.filter((_,i)=>i%k===k-1).slice(0,h);return {train:days.filter(d=>!holdout.includes(d)),holdout};}
  return {train:days.slice(0,n-h),holdout:days.slice(n-h)};
}

/** Agreement metrics for paired (recorded, simulated) CGM values in mg/dL. */
export function agreement(pairs) {
  const p=pairs.filter(x=>Number.isFinite(x.recorded)&&Number.isFinite(x.simulated));
  if(!p.length)return null;
  const rec=p.map(x=>x.recorded),sim=p.map(x=>x.simulated),err=p.map(x=>x.simulated-x.recorded);
  const tir=a=>a.filter(v=>v>=70&&v<=180).length/a.length;
  const tbr=a=>a.filter(v=>v<70).length/a.length;
  return {n:p.length,
    mard:round(mean(p.map(x=>Math.abs(x.simulated-x.recorded)/x.recorded)),4),
    rmse:round(Math.sqrt(mean(err.map(e=>e*e))),2),
    bias:round(mean(err),2),
    within_20pct:round(mean(p.map(x=>Math.abs(x.simulated-x.recorded)<=Math.max(20,0.2*x.recorded)?1:0)),4),
    tir_recorded:round(tir(rec),4),tir_simulated:round(tir(sim),4),tir_diff:round(tir(sim)-tir(rec),4),
    tbr_recorded:round(tbr(rec),4),tbr_simulated:round(tbr(sim),4),
    mean_recorded:round(mean(rec),1),mean_simulated:round(mean(sim),1),mean_diff:round(mean(sim)-mean(rec),1),
    sd_recorded:round(sd(rec),1),sd_simulated:round(sd(sim),1),sd_diff:round(sd(sim)-sd(rec),1)};
}

/** A: holdout MARD <= 10% and |TIR diff| <= 5 pp; B: <= 15% and <= 10 pp; otherwise C. */
export function grade(m) {
  if(!m)return 'C';
  const tir=Math.abs(m.tir_diff);
  return m.mard<=0.10&&tir<=0.05?'A':m.mard<=0.15&&tir<=0.10?'B':'C';
}

/** Metrics of a fit on the given days (QC-excluded readings dropped). */
export function evaluateFit(fit,qc,days) {
  const set=new Set(days);
  return agreement(predictFit(fit).filter(r=>set.has(r.day)&&!qc.exclude.has(r.t)));
}

/**
 * Day-level bootstrap: resamples training days with replacement and refits the globals by LM
 * from the MAP estimate with latents held at their MAP values. Returns per-parameter sd and 90% CI.
 */
export function bootstrap(fit,{replicates=8,seed=1,maxIter=6}={}) {
  const prob=fit.problem,rnd=prng(seed);
  const dayOf=prob.dataIdx.map(i=>prob.plan.samples[i].day),days=[...new Set(dayOf)],draws=[];
  const active=prob.globals.map((_,i)=>i);
  for(let b=0;b<replicates;b++) {
    const count={};for(let i=0;i<days.length;i++){const d=days[Math.floor(rnd()*days.length)];count[d]=(count[d]??0)+1;}
    const weights=Float64Array.from(dayOf,d=>count[d]??0);
    const res=levenbergMarquardt(prob.residuals,fit.x,{delta:prob.o.huberDelta,maxIter,weights,active});
    draws.push(Object.fromEntries(prob.globals.map((k,i)=>[k,fromZ(res.x[i],PARAM_SPECS[k])])));
  }
  return Object.fromEntries(prob.globals.map(k=>{const v=draws.map(d=>d[k]);
    return [k,{sd:round(sd(v),5),ci90:[round(quantile(v,0.05),5),round(quantile(v,0.95),5)]}];}));
}
