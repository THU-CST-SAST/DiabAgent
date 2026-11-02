// trace2sim: reconstruct a runnable instance from a real person's records.
//   ingest -> qc -> rules -> fit (train days) -> validate (holdout days) -> refit (all days) -> spec
import {normalizeTrace,fromNightscout} from './ingest.mjs';
import {qualityControl} from './qc.mjs';
import {rulePriors,buildSpec,mealPlan} from './rules.mjs';
import {fitTrace,predictFit} from './fit.mjs';
import {splitDays,evaluateFit,grade,bootstrap} from './validate.mjs';
import {anonymousId,reconstructionDocument,writeReconstruction} from './export.mjs';
import {buildInstanceConfig} from '../sim/instance.mjs';
import {mean,sd,median,clamp,round,localDayKey} from './util.mjs';

export {normalizeTrace,fromNightscout,qualityControl,rulePriors,buildSpec,fitTrace,predictFit,splitDays,evaluateFit,grade,bootstrap,
  reconstructionDocument,writeReconstruction};

/**
 * input: TraceV1 object, or Nightscout {entries, treatments, profile} with opts.meta.
 * opts: {meta, qc:{...}, rules:{...}, fit:{...}, holdoutFraction=0.3, splitMode='last',
 *        refitAll=true, bootstrap=0 (replicates), id}
 * Returns {id, trace, qc, rules, split, fit, validation, bootstrap, spec, config, latentSummary,
 *          warnings, fits:{train, final}} (fits hold non-serializable problem objects).
 */
export function reconstruct(input,opts={}) {
  const t0=Date.now();
  const raw=Array.isArray(input?.entries)||Array.isArray(input?.treatments)?fromNightscout(input,opts.meta??input.meta??{}):input;
  const trace=normalizeTrace(raw);
  const qc=qualityControl(trace,opts.qc);
  const rules=rulePriors(trace,qc,opts.rules);
  const split=splitDays(qc.usableDays,{holdoutFraction:opts.holdoutFraction??0.3,mode:opts.splitMode??'last'});
  if(!split.train.length)throw new Error('no usable days to fit (see qc report)');

  const trainFit=fitTrace(trace,qc,rules,{...opts.fit,trainDays:split.train});
  const validation={split,train:evaluateFit(trainFit,qc,split.train),
    holdout:split.holdout.length?evaluateFit(trainFit,qc,split.holdout):null};
  validation.grade=grade(validation.holdout??validation.train);
  if(!validation.holdout)validation.grade_basis='train (no holdout days)';

  const final=(opts.refitAll??true)&&split.holdout.length
    ?fitTrace(trace,qc,rules,{...opts.fit,trainDays:qc.usableDays,start:trainFit.params}):trainFit;
  const boot=opts.bootstrap>0?bootstrap(final,{replicates:opts.bootstrap}):null;

  // Person-level summaries of the latent effects for the spec.
  const scales=final.latent.meals.map(m=>m.scale),errs=scales.map(s=>1/s-1);
  const nAnn=final.latent.meals.length,nUn=final.latent.unannounced.length;
  const announcement=scales.length>=3?{model:'normal',bias:round(clamp(mean(errs),-0.9,0.9),3),sd:round(clamp(sd(errs),0,1.5),3),
    carb_error_fraction:0,probability:round(nAnn/(nAnn+nUn),3)}:null;
  const daySd=final.latent.days.length>=3?sd(final.latent.days.map(d=>Math.log(d.sensitivity_multiplier))):null;
  const scaleByT=new Map(final.problem.meals.map((m,j)=>[m.t,Math.exp(final.x[final.problem.oM+j])]));
  const plan=mealPlan(trace,qc,{scaleOf:c=>scaleByT.get(c.t)??1});
  const latentSummary={meal_scale_median:scales.length?round(median(scales),3):null,announcement,daily_sensitivity_cv:daySd==null?null:round(daySd,3)};
  const {spec,warnings:specWarnings}=buildSpec(trace,qc,rules,final.params,
    {announcement,daily_sensitivity_cv:daySd??undefined,mealPlan:Object.keys(plan).length?plan:undefined});
  const id=opts.id??anonymousId(trace);spec.id=id;
  const warnings=[...qc.report.warnings,...rules.warnings,...specWarnings];
  let config=null;
  try{config=buildInstanceConfig(spec);}catch(e){warnings.push(`spec does not build: ${e.message}`);}
  return {id,trace,qc:qc.report,qcInternal:qc,rules,split,
    fit:{params:final.params,sd:final.sd,latent:final.latent,stats:final.stats,train_params:trainFit.params},
    validation,bootstrap:boot,spec,config,latentSummary,warnings,seconds:round((Date.now()-t0)/1000,2),
    fits:{train:trainFit,final}};
}

/** Per-day series for plotting/inspection: recorded vs simulated CGM under the train fit. */
export function comparisonSeries(result) {
  const off=result.trace.meta.utc_offset_minutes;
  return predictFit(result.fits.train).map(r=>({t:new Date(r.t).toISOString(),day:localDayKey(r.t,off),recorded:r.recorded,
    simulated:r.simulated==null?null:round(r.simulated,1),holdout:result.split.holdout.includes(r.day)}));
}
