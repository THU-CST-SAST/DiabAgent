import {DEFAULT_SCORING_VERSION,DEFAULT_WEIGHTS} from '../bench/score.mjs';

export function scoringDisplay(scoring) {
  if(scoring?.version!==DEFAULT_SCORING_VERSION)return null;
  const w={...DEFAULT_WEIGHTS,...scoring.weights};
  const describe=units=>{
    const g=x=>units==='mmol'?String(x):(x*18.016).toFixed(3);
    return `S = clip(${w.tir}·T(${g(4)}–${g(8)}) − ${w.tbr70}·T(${g(2)}–${g(4)}) − ${w.tbr54}·T(<${g(2)}) − ${w.tar250}·T(>${g(12)}) − ${w.cv}·max(0,CV−0.36) − ${w.roc}·T(|ROC|>2 mg/dL/min), 0, 1)；浓度分箱单位${units==='mmol'?'mmol/L':'mg/dL'}，低糖分箱互不重叠。真实血糖<${g(3)}持续≥15分钟时S=0。表中TIR/TBR/TAR是辅助指标，不是主评分的分箱。括号内为按任务聚类的bootstrap 95% CI。`;
  };
  return {mmol:describe('mmol'),mgdl:describe('mgdl')};
}

export function reportPrice(agent,usd,warnings=[]) {
  if(!agent.startsWith('llm:'))return {usd:null,pricing_status:'not_applicable'};
  const unpriced=warnings.some(w=>w.startsWith(agent+':')&&w.includes('tariff unpriced'));
  if(unpriced||!Number.isFinite(usd)||usd<=0)return {usd:null,pricing_status:'unpriced'};
  return {usd,pricing_status:'estimated'};
}

/** Presentation only; retain original experiment IDs and rewards in every scientific record. */
export function reportCampaignScope(scope,trials=[]) {
  if(!scope)return null;
  if(!Array.isArray(scope.experiments)||!scope.experiments.length||!Number.isInteger(scope.worlds)||scope.worlds<1
    ||!Array.isArray(scope.models)||!scope.models.length||typeof scope.baseline_job_id!=='string')throw Error('Invalid report scope');
  const modes=new Set(scope.experiments),ids=new Set(scope.models.map(m=>m.job_id));
  if(ids.size!==scope.models.length||ids.has(scope.baseline_job_id))throw Error('Report jobs must be distinct');
  for(const t of trials) {
    if(ids.has(t.job_id)&&!modes.has(t.experiment))throw Error('Model trial is outside the declared information scope');
    if(t.job_id===scope.baseline_job_id&&t.agent!=='wait')throw Error('Reused baseline contains a model agent');
  }
  return {title:`本轮 ${scope.experiments.map(e=>e.toUpperCase()).join(' / ')} 实验`,worlds:scope.worlds,
    information:scope.experiments.map(e=>e.toUpperCase()).join(' / '),
    note:scope.baseline_origin==='current'
      ?`本轮仅运行上述信息档位的模型实验；无干预基线来自同世界本轮 ${scope.worlds} 条 WAIT，不是 I0 模型结果。仅完整七天回合计分，进行中与失败不填零。`
      :'本轮仅运行上述信息档位的模型实验；无干预基线从旧批次复用，不是本轮 I0 模型结果。仅完整七天回合计分，进行中与失败不填零。',
    baseline_origin:scope.baseline_origin??'reused',baseline_job_id:scope.baseline_job_id,
    baseline_label:scope.baseline_origin==='current'?'无干预基线（本轮）':'无干预基线（复用）',
    models:scope.models.map(m=>{
      const rows=trials.filter(t=>t.job_id===m.job_id),planned=scope.worlds*scope.experiments.length;
      return {job_id:m.job_id,label:m.label,planned,completed:rows.filter(t=>t.status==='done').length,
        running:rows.filter(t=>t.status==='running').length,
        failed:rows.filter(t=>['agent_failed','infra_failed'].includes(t.status)).length,
        not_started:Math.max(0,planned-rows.filter(t=>t.status!=='not_started').length)};
    })};
}
