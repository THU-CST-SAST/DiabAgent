// Public scoring targets only; no patient state or evaluator data.
export const MGDL_PER_MMOL=18.016;
export const METRICS_TARGET=Object.freeze({low_mg_dl:4*MGDL_PER_MMOL,high_mg_dl:8*MGDL_PER_MMOL});

export function scoringTarget(version='METRICS-v0.3') {
  if(['METRICS-v0.3','COGI-4-8/v1'].includes(version))return METRICS_TARGET;
  if(['bench-v0.2','bench-v0.3','COGI-v1'].includes(version))return {low_mg_dl:70,high_mg_dl:180};
  throw Error(`Unknown scoring target version: ${version}`);
}
