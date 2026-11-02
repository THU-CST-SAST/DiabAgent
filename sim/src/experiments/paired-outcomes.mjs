import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';

const mean=values=>values.length?values.reduce((sum,n)=>sum+n,0)/values.length:null;
const read=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
const identity=t=>JSON.stringify([t.instance_id,t.episode_seed,t.person_seed??null,t.repeat,t.model_draw,t.track,t.role??null]);

export function trialOutcome(trial,metrics) {
  if(!trial)return {status:'not_started',score:null};
  const reason=trial.failure?.reason??trial.agent_stats?.reason??null;
  if(trial.status!=='done')return {status:trial.status==='running'?'running':trial.status==='not_started'?'not_started':
    reason==='format'?'format_failed':reason==='server'||reason==='network'||trial.status==='infra_failed'?'infrastructure_failed':'other_failed',
    score:null,reason};
  const reward=trial.reward,dm=metrics?.metrics?.dynamic;
  const verified=trial.scored_with_fill===false&&reward?.agent_completed===1&&reward?.completed===1
    &&reward.verifier_wait_steps===0&&reward.agent_steps===2016
    &&metrics?.scoring_version==='METRICS-v0.3'&&metrics.metrics?.horizon_minutes===10080
    &&metrics.metrics?.grid_minutes===5&&metrics.metrics?.completed_horizon===true&&dm?.n===2016&&dm?.coverage===1
    &&Number.isFinite(reward.reward)&&metrics?.score?.score===reward.reward;
  if(!verified)return {status:'completion_unverified',score:null,reason:'Missing or inconsistent full seven-day/no-fill evidence'};
  return {status:'complete',score:reward.reward,tir_4_8:reward.tir_4_8,tbr70:reward.tbr70,
    tar180:reward.tar180,cv:reward.cv,safety_pass:reward.safety_pass};
}

export function comparePairedOutcomes(rows,modelIds) {
  const pairs=[];
  for(let i=0;i<modelIds.length;i++)for(let j=i+1;j<modelIds.length;j++) {
    const left=modelIds[i],right=modelIds[j];
    const shared=rows.filter(row=>row.arms[left]?.status==='complete'&&row.arms[right]?.status==='complete');
    const deltas=shared.map(row=>row.arms[left].score-row.arms[right].score);
    pairs.push({left,right,planned:rows.length,completed_pairs:shared.length,
      full_matrix:shared.length===rows.length&&rows.length>0,
      instances:shared.map(row=>row.instance_id),left_mean:mean(shared.map(row=>row.arms[left].score)),
      right_mean:mean(shared.map(row=>row.arms[right].score)),mean_delta:mean(deltas),
      left_wins:deltas.filter(n=>n>1e-12).length,right_wins:deltas.filter(n=>n< -1e-12).length,
      ties:deltas.filter(n=>Math.abs(n)<=1e-12).length});
  }
  return pairs;
}

export function summarizeDecisionBehavior(lines) {
  const result={decisions:0,parse_errors:0,history_reads:0,notes_updates:0,actions:{},receipts:{},
    accepted_bolus_units:0,accepted_carbs_g:0};
  for(const line of lines) {
    if(line.parse_error)result.parse_errors++;
    if(line.tool_call?.name==='read_glucose_history')result.history_reads++;
    if(!line.decision_kind||!line.parsed?.action)continue;
    result.decisions++;
    if(line.parsed.note_to_self)result.notes_updates++;
    const type=line.parsed.action.type,receipt=line.receipt;
    result.actions[type]=(result.actions[type]??0)+1;
    if(receipt?.status)result.receipts[receipt.status]=(result.receipts[receipt.status]??0)+1;
    // Command acceptance is not proof of physiological delivery during an infusion fault.
    if(receipt?.status==='applied'&&type==='BOLUS'&&Number.isFinite(receipt.applied?.units))result.accepted_bolus_units+=receipt.applied.units;
    if(receipt?.status==='applied'&&type==='INGEST_CARBS'&&Number.isFinite(receipt.applied?.grams))result.accepted_carbs_g+=receipt.applied.grams;
  }
  return result;
}

export function loadPairedOutcomes({jobsDir,models,baselineJob,expectedWorlds=32}) {
  const load=id=>{
    const dir=path.join(jobsDir,id),config=read(path.join(dir,'config.json'));
    if(!config)throw Error(`Missing job config: ${id}`);
    const trials=new Map();
    for(const name of fs.readdirSync(dir)) {
      const td=path.join(dir,name),t=read(path.join(td,'trial.json'));
      if(!t)continue;
      if(trials.has(t.instance_id))throw Error(`Ambiguous instance/repeat/information level in ${id}: ${t.instance_id}`);
      trials.set(t.instance_id,{trial:t,dir:td});
    }
    return {config,trials};
  };
  const baseline=load(baselineJob),jobs=models.map(m=>({...m,...load(m.job_id)}));
  if(baseline.trials.size!==expectedWorlds)throw Error('Baseline does not enumerate the expected world set');
  if(!jobs.length||!jobs[0].config.agent_code?.sha256||!baseline.config.benchmark_sha256||!baseline.config.scoring)throw Error('Missing pairing provenance');
  for(const job of jobs) {
    if(job.config.benchmark_sha256!==baseline.config.benchmark_sha256
      ||!isDeepStrictEqual(job.config.scoring,baseline.config.scoring))throw Error('Benchmark/scoring mismatch');
    if(job.config.agent_code?.sha256!==jobs[0].config.agent_code?.sha256)throw Error('Agent code mismatch');
    for(const key of job.trials.keys())if(!baseline.trials.has(key))throw Error(`Unexpected world: ${key}`);
  }
  const rows=[...baseline.trials.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([instance_id,b])=>{
    const arms={};
    for(const job of jobs) {
      const found=job.trials.get(instance_id),t=found?.trial;
      if(t&&(t.experiment!=='i2'||identity(t)!==identity(b.trial)))throw Error(`Unpaired trial identity: ${instance_id}/${job.job_id}`);
      const outcome=trialOutcome(t,found?read(path.join(found.dir,'verifier/metrics.json')):null);
      arms[job.job_id]={...outcome,trial_id:t?.trial_id??null,reason:outcome.reason??null,
        parse_errors:t?.agent_stats?.parse_errors??null};
      const tf=found&&path.join(found.dir,'agent/transcript.jsonl');
      if(tf&&fs.existsSync(tf)) {
        const text=fs.readFileSync(tf,'utf8'),lines=text.split('\n');
        if(!text.endsWith('\n'))lines.pop();
        arms[job.job_id].behavior=summarizeDecisionBehavior(lines.filter(Boolean).map(JSON.parse));
      }
    }
    return {instance_id,baseline:trialOutcome(b.trial,read(path.join(b.dir,'verifier/metrics.json'))),arms};
  });
  return {format:'sweet-sim.paired-outcomes/v1',created:new Date().toISOString(),models,
    interpretation:'Only complete/no-fill seven-day pairs are compared. Partial/failed scores are null, never zero. Paired subsets are descriptive, not full-matrix rankings. All model arms must finish for a full-matrix claim. This does not attest relay backend identity.',
    behavior_note:'Accepted bolus amounts describe applied command receipts, not verified physiological delivery. Transcripts are available only for completed trials in the compact report export.',
    jobs:jobs.map(job=>({job_id:job.job_id,label:job.label,planned:rows.length,
      statuses:rows.reduce((counts,row)=>{const s=row.arms[job.job_id].status;counts[s]=(counts[s]??0)+1;return counts;},{})})),
    pairs:comparePairedOutcomes(rows,models.map(m=>m.job_id)),rows};
}

export function pairedOutcomesMarkdown(result) {
  const fmt=n=>Number.isFinite(n)?n.toFixed(4):'--';
  const label={complete:'完整',running:'运行中',not_started:'未启动',format_failed:'格式失败',
    infrastructure_failed:'网络/基础设施失败',other_failed:'其他失败',completion_unverified:'完整性未验收'};
  const cell=arm=>arm.status==='complete'?fmt(arm.score):label[arm.status]??arm.status;
  const lines=['# 同世界配对结果','',`统计时间：${result.created}`,'',
    '分数沿用原生 METRICS-v0.3，范围 0–1。仅比较双方完整完成、没有 WAIT 补齐的七天轨迹；未完成或失败不填零。',
    '部分完成的配对只描述该子集，不能作为全场景模型排名；三组联合改动也不能归因于单个组件。','',
    '| 模型 | 计划 | 完整 | 运行中 | 格式失败 | 网络/基础设施失败 | 其他失败或未验收 | 未启动 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for(const job of result.jobs) {
    const s=job.statuses;
    lines.push(`| ${job.label} | ${job.planned} | ${s.complete??0} | ${s.running??0} | ${s.format_failed??0} | ${s.infrastructure_failed??0} | ${(s.other_failed??0)+(s.completion_unverified??0)} | ${s.not_started??0} |`);
  }
  lines.push('','| 左侧模型 / 右侧模型 | 完整配对数 | 左均分 | 右均分 | 差值（左−右） | 左胜/平/右胜 |','| --- | ---: | ---: | ---: | ---: | --- |');
  for(const p of result.pairs) {
    const name=id=>result.models.find(m=>m.job_id===id).label;
    lines.push(`| ${name(p.left)} / ${name(p.right)} | ${p.completed_pairs}/${p.planned} | ${fmt(p.left_mean)} | ${fmt(p.right_mean)} | ${fmt(p.mean_delta)} | ${p.left_wins}/${p.ties}/${p.right_wins} |`);
  }
  lines.push('','| 场景 | '+result.models.map(m=>m.label).join(' | ')+' | 无干预基线（复用） |',
    '| --- | '+result.models.map(()=>'---:').join(' | ')+' | ---: |');
  for(const row of result.rows)lines.push(`| ${row.instance_id} | ${result.models.map(m=>cell(row.arms[m.job_id])).join(' | ')} | ${cell(row.baseline)} |`);
  return lines.join('\n')+'\n';
}
