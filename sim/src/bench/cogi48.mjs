import {cogiFromStats,cogiMetrics} from './cogi.mjs';
import {METRICS_TARGET,MGDL_PER_MMOL} from './scoring-target.mjs';

export const COGI48_VERSION='COGI-4-8/v1';
export const isCogiVersion=version=>['COGI-v1',COGI48_VERSION].includes(version);

/** Research adaptation, not the published COGI: only the TIR band changes. */
export function cogi48FromStats({tir_4_8,tbr70,sd_mgdl}) {
  const result=cogiFromStats({tir:tir_4_8,tbr70,sd_mgdl});
  return {...result,scoring_version:COGI48_VERSION,published_cogi:false,
    tir_range_mgdl:[METRICS_TARGET.low_mg_dl,METRICS_TARGET.high_mg_dl],
    conversion_mgdl_per_mmol:MGDL_PER_MMOL};
}

/** Equally spaced true-glucose samples; no silent dropping or endpoint duplication. */
export function cogi48Metrics(values) {
  const original=cogiMetrics(values);
  if(original.no_data)return {scoring_version:COGI48_VERSION,score:null,no_data:true,n:0};
  const tir_4_8=values.filter(g=>g>=METRICS_TARGET.low_mg_dl&&g<=METRICS_TARGET.high_mg_dl).length/values.length;
  return {...cogi48FromStats({tir_4_8,tbr70:original.tbr70_percent/100,sd_mgdl:original.sd_mgdl}),n:values.length};
}
