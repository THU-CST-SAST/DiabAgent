// Export of a reconstruction: the instance spec (compatible with buildInstanceConfig, physiology
// through spec.overrides) plus a fit report. Only derived quantities are written; no raw CGM,
// insulin or carb records leave the caller's machine through this file.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {round} from './util.mjs';

export const RECONSTRUCTED_DIR=fileURLToPath(new URL('../../knowledge/persons/reconstructed/',import.meta.url));
export const EXPORT_VERSION='trace2sim-export/1';

/** Anonymous id derived from the trace metadata and time span (not reversible to the subject). */
export function anonymousId(trace) {
  const h=createHash('sha256').update(JSON.stringify([trace.meta.id??null,trace.meta.sex,trace.meta.age_years,trace.cgm[0].t,trace.cgm.at(-1).t])).digest('hex');
  return `r-${h.slice(0,12)}`;
}

/** Serializable document: spec + fit report (parameters, uncertainty, validation, QC summary). */
export function reconstructionDocument(result) {
  const f=result.fit,q=result.qc;
  return {
    version:EXPORT_VERSION,id:result.id,created_from:'trace2sim',
    spec:result.spec,
    fit:{params:Object.fromEntries(Object.entries(f.params).map(([k,v])=>[k,round(v,5)])),
      laplace_sd:Object.fromEntries(Object.entries(f.sd).map(([k,v])=>[k,round(v,5)])),
      bootstrap:result.bootstrap??null,priors:result.rules.priors,
      latent_summary:{meals:f.latent.meals.length,meal_scale_median:result.latentSummary.meal_scale_median,
        announcement:result.latentSummary.announcement,unannounced_meals:f.latent.unannounced.length,
        day_sensitivity:f.latent.days.map(d=>d.sensitivity_multiplier)},
      stats:f.stats},
    rules:{person_type:result.rules.person_type,therapy_stats:{...result.rules.stats,per_day:undefined},dawn:result.rules.dawn,
      sensitivity_components:result.rules.sensitivity_components},
    validation:result.validation,
    qc:{n_cgm:q.n_cgm,span_days:q.span_days,coverage:q.coverage,usable_days:q.usable_days.length,excluded:q.excluded,
      gaps:q.gaps.length,compression_lows:q.compression_lows.length,counts:q.counts},
    warnings:result.warnings,
  };
}

/** Writes <dir>/<id>.json; returns the path. dir defaults to knowledge/persons/reconstructed. */
export function writeReconstruction(result,{dir=RECONSTRUCTED_DIR,id=result.id}={}) {
  if(!/^[A-Za-z0-9_.-]+$/.test(id))throw new Error('export id must be a plain file name');
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,`${id}.json`);
  fs.writeFileSync(file,JSON.stringify(reconstructionDocument(result),null,2)+'\n');
  return file;
}
