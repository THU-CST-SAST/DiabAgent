// Leelarathna et al., doi:10.1177/1932296819838525, Table 1.
export const COGI_VERSION='COGI-v1';
export const COGI_WEIGHTS=Object.freeze({tir:0.50,hypo:0.35,gv:0.15});
const clip=x=>Math.min(1,Math.max(0,x));

/** Fractions (not percentages), population SD in mg/dL. No safety veto. */
export function cogiFromStats({tir,tbr70,sd_mgdl}) {
  if(!Number.isFinite(tir)||tir<0||tir>1||!Number.isFinite(tbr70)||tbr70<0||tbr70>1||tir+tbr70>1+1e-12
    ||!Number.isFinite(sd_mgdl)||sd_mgdl<0)throw new Error('Invalid COGI statistics');
  const subscores={tir:100*tir,hypo:100*clip(1-tbr70/0.15),gv:100*clip((108-sd_mgdl)/90)};
  const contributions=Object.fromEntries(Object.entries(subscores).map(([k,v])=>[k,v*COGI_WEIGHTS[k]]));
  return {scoring_version:COGI_VERSION,score:Object.values(contributions).reduce((a,b)=>a+b,0),
    subscores,contributions,weights:COGI_WEIGHTS,tir_percent:100*tir,tbr70_percent:100*tbr70,sd_mgdl};
}

/** Equally spaced samples in mg/dL. Missing/invalid data is not silently dropped. */
export function cogiMetrics(values) {
  if(!Array.isArray(values))throw new Error('COGI requires an array');
  if(!values.length)return {scoring_version:COGI_VERSION,score:null,no_data:true,n:0};
  if(values.some(g=>!Number.isFinite(g)||g<=0))throw new Error('Invalid COGI glucose sample');
  const n=values.length,mean=values.reduce((a,b)=>a+b,0)/n;
  return {...cogiFromStats({tir:values.filter(g=>g>=70&&g<=180).length/n,
    tbr70:values.filter(g=>g<70).length/n,sd_mgdl:Math.sqrt(values.reduce((s,g)=>s+(g-mean)**2,0)/n)}),n};
}
