// Job summary (docs/BENCH.zh-CN.md §8): per experiment x track x agent the mean reward with an
// instance-clustered bootstrap 95% CI (src/bench/score.mjs bootstrapMean), TIR, TBR, severe-hypo
// rate, normalized scores against the job's own wait / patient / oref0 / causal trials on the same
// task and repeat, paired difference to wait; for daily verifiers the mean daily curve and the
// learning slope; for experiments with pairs (real vs twin) twin_reward, real_reward, transfer_gap
// and the rank agreement of agents between twin and real. Writes result.json, summary.md, summary.html.
//
// Only trials with status done (the agent itself reached the horizon) are scored by default;
// agent_failed trials (scored with WAIT fill, docs/BENCH.zh-CN.md §8.11) are counted with their
// failure reasons and included only with includeFailed (--include-failed). Per agent the summary
// reports done / agent_failed (by reason) / infra_failed / not_started and tokens / cost over all attempts.
import fs from 'node:fs';
import path from 'node:path';
import {bootstrapMean,normalizeScore,MIN_DENOMINATOR,passK} from '../bench/score.mjs';
import {agentFailure} from './failures.mjs';

export const TRIAL_STATES=['done','agent_failed','infra_failed','not_started','partial'];
/**
 * Normalized state of a trial record: done | agent_failed | infra_failed | not_started | partial
 * (running or interrupted). Legacy records: 'error' -> infra_failed; 'done' with
 * reward.agent_completed = 0 (agent crashed before failures were classified) -> agent_failed.
 */
export function trialState(rec,{hasReward=true}={}) {
  if(!rec)return 'not_started';
  switch(rec.status) {
    case 'done':return !hasReward||!rec.reward?'partial':rec.reward.agent_completed===0?'agent_failed':'done';
    case 'agent_failed':case 'infra_failed':case 'not_started':return rec.status;
    case 'error':return 'infra_failed';
    default:return 'partial';
  }
}
const tryJson=f=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return null;}};
const tryText=f=>{try{return fs.readFileSync(f,'utf8');}catch{return null;}};

export const RESULT_FORMAT='sweet-sim.benchmark-result/v1';
const mean=xs=>{const v=xs.filter(Number.isFinite);return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;};
const r4=v=>v==null||!Number.isFinite(v)?null:Number(v.toFixed(4));
const groupBy=(xs,key)=>{const m=new Map();for(const x of xs){const k=key(x);if(!m.has(k))m.set(k,[]);m.get(k).push(x);}return m;};
const ci=(rows,val,label,B)=>{const b=bootstrapMean([...groupBy(rows,r=>r.task_id).values()].map(g=>g.map(val).filter(Number.isFinite)),{B,label});
  return {mean:r4(b.mean),ci95:b.ci95.map(r4),n:b.n};};

/**
 * All trial records of a job dir (trial.json files), sorted by trial id, with `state` (trialState),
 * `failure` filled in for legacy agent failures, and `usage` {attempts, input_tokens, output_tokens,
 * cost_usd} summed over all attempts.
 */
export function loadTrials(jobDir) {
  if(!fs.existsSync(jobDir))return [];
  return fs.readdirSync(jobDir).sort().map(d=>path.join(jobDir,d)).filter(d=>fs.existsSync(path.join(d,'trial.json'))).map(dir=>{
    const t=JSON.parse(fs.readFileSync(path.join(dir,'trial.json'),'utf8'));
    t.state=trialState(t,{hasReward:fs.existsSync(path.join(dir,'verifier','reward.json'))});
    const st=t.status==='not_started'?null:t.agent_stats??tryJson(path.join(dir,'agent','status.json'));
    if(t.state==='agent_failed'&&!t.failure)t.failure={...agentFailure({proc:t.agent_result,status:st,transcript:tryText(path.join(dir,'agent','transcript.jsonl')),
      stderr:tryText(path.join(dir,'agent','stderr.txt'))}),legacy:true};
    const hist=t.attempts??[];
    t.usage={attempts:hist.length+(t.status==='not_started'?0:1),input_tokens:(st?.input_tokens??0)+hist.reduce((s,a)=>s+(a.input_tokens??0),0),
      output_tokens:(st?.output_tokens??0)+hist.reduce((s,a)=>s+(a.output_tokens??0),0),cost_usd:(st?.cost_usd??0)+hist.reduce((s,a)=>s+(a.cost_usd??0),0)};
    return t;
  });
}

/** Failure reason of a trial record for summaries. */
const reasonOf=t=>t.state==='agent_failed'?t.failure?.reason??'unknown':t.state==='not_started'?t.not_started?.reason??'pending'
  :t.state==='infra_failed'?'infra':t.state==='partial'?'interrupted':null;

/**
 * Per agent outcome counts of a job: {agent: {planned, done, agent_failed, agent_failed_by_reason,
 * infra_failed, not_started, not_started_by_reason, partial, attempts, input_tokens, output_tokens, cost_usd}}.
 * Planned trials (config.planned_trials) without a trial.json count as not_started (reason pending).
 */
export function outcomesByAgent(trials,config={}) {
  const out={};
  const row=a=>out[a]??={planned:0,done:0,agent_failed:0,agent_failed_by_reason:{},infra_failed:0,not_started:0,not_started_by_reason:{},partial:0,
    attempts:0,input_tokens:0,output_tokens:0,cost_usd:0};
  const seen=new Set();
  for(const t of trials) {
    const r=row(t.agent);seen.add(t.trial_id);r.planned++;r[t.state]++;
    if(t.state==='agent_failed')r.agent_failed_by_reason[reasonOf(t)]=(r.agent_failed_by_reason[reasonOf(t)]??0)+1;
    if(t.state==='not_started')r.not_started_by_reason[reasonOf(t)]=(r.not_started_by_reason[reasonOf(t)]??0)+1;
    r.attempts+=t.usage?.attempts??0;r.input_tokens+=t.usage?.input_tokens??0;r.output_tokens+=t.usage?.output_tokens??0;r.cost_usd+=t.usage?.cost_usd??0;
  }
  for(const [id,agent] of Object.entries(config.planned_trials??{}))if(!seen.has(id)) {
    const r=row(agent);r.planned++;r.not_started++;r.not_started_by_reason.pending=(r.not_started_by_reason.pending??0)+1;
  }
  for(const r of Object.values(out))r.cost_usd=Number(r.cost_usd.toFixed(6));
  return out;
}

/** Spearman rank correlation and Kendall tau-a of paired values (null for < 2 pairs). */
export function rankAgreement(a,b) {
  const n=a.length;if(n<2)return {spearman:null,kendall:null,n};
  const ranks=xs=>{const idx=xs.map((v,i)=>[v,i]).sort((p,q)=>p[0]-q[0]),r=new Array(n);
    for(let i=0;i<n;){let j=i;while(j+1<n&&idx[j+1][0]===idx[i][0])j++;for(let k=i;k<=j;k++)r[idx[k][1]]=(i+j)/2+1;i=j+1;}return r;};
  const ra=ranks(a),rb=ranks(b),ma=mean(ra),mb=mean(rb);
  let sab=0,saa=0,sbb=0;for(let i=0;i<n;i++){sab+=(ra[i]-ma)*(rb[i]-mb);saa+=(ra[i]-ma)**2;sbb+=(rb[i]-mb)**2;}
  let c=0,d=0;for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){const s=Math.sign(a[i]-a[j])*Math.sign(b[i]-b[j]);if(s>0)c++;else if(s<0)d++;}
  return {spearman:saa&&sbb?r4(sab/Math.sqrt(saa*sbb)):null,kendall:r4((c-d)/(n*(n-1)/2)),n};
}

/**
 * Summary object of a job (see header). opts: bench (manifest), B (bootstrap resamples), wallSeconds,
 * write, includeFailed (score agent_failed trials too; default false).
 */
export function summarizeJob(jobDir,{bench=null,B=2000,wallSeconds=null,write=true,includeFailed=false}={}) {
  const config=fs.existsSync(path.join(jobDir,'config.json'))?JSON.parse(fs.readFileSync(path.join(jobDir,'config.json'),'utf8')):{};
  if(!bench&&config.benchmark_dir&&fs.existsSync(path.join(config.benchmark_dir,'benchmark.json')))
    bench=JSON.parse(fs.readFileSync(path.join(config.benchmark_dir,'benchmark.json'),'utf8'));
  const all=loadTrials(jobDir),done=all.filter(t=>t.reward&&(t.state==='done'||includeFailed&&t.state==='agent_failed'));
  const failed=all.filter(t=>t.state==='agent_failed'||t.state==='infra_failed'),count=s=>all.filter(t=>t.state===s).length;
  const byAgent=outcomesByAgent(all,config),reasons={};
  for(const t of failed)reasons[reasonOf(t)]=(reasons[reasonOf(t)]??0)+1;
  const exps=bench?.experiments??[...groupBy(done,t=>t.experiment).keys()].map(id=>({id,track:done.find(t=>t.experiment===id)?.track}));
  const out={format:RESULT_FORMAT,job_id:config.job_id??path.basename(jobDir),benchmark:bench?.name??config.benchmark??null,
    created:new Date().toISOString(),scoring:bench?.scoring??config.scoring??null,
    include_failed:includeFailed,
    trials:{total:all.length,planned:Object.values(byAgent).reduce((s,a)=>s+a.planned,0),done:count('done'),scored:done.length,
      agent_failed:count('agent_failed'),infra_failed:count('infra_failed'),not_started:Object.values(byAgent).reduce((s,a)=>s+a.not_started,0),partial:count('partial'),
      error:failed.length,failure_reasons:reasons,
      errors:failed.map(t=>({trial_id:t.trial_id,agent:t.agent,status:t.state,reason:reasonOf(t),attempt:t.attempt??null,
        error:String(t.failure?.last_error??t.error??'').split('\n')[0].slice(0,300)}))},
    agents:byAgent,
    wall_seconds:r4(wallSeconds),trial_seconds_total:r4(all.reduce((s,t)=>s+(t.seconds??0),0)),
    bootstrap:{B,cluster:'task (instance)',ci:'percentile 95%'},experiments:[],cross_track:[]};
  for(const e of exps) {
    const rows=done.filter(t=>t.experiment===e.id);if(!rows.length)continue;
    const key=t=>`${t.task_id}/r${t.repeat}`;
    const refs=new Map();
    for(const t of rows)if(['wait','patient','oref0','causal'].includes(t.agent)){if(!refs.has(key(t)))refs.set(key(t),{});refs.get(key(t))[t.agent]=t.reward.reward;}
    const byAgent=groupBy(rows,t=>t.agent),agents=[];
    for(const [agent,ts] of byAgent) {
      const enriched=ts.map(t=>{
        const R=refs.get(key(t))??{},S=t.reward.reward;
        const modern=bench?.scoring?.version==='METRICS-v0.3';
        const n=modern?{normalized:t.reward.normalized_vs_certificate??null}:normalizeScore(S,{wait:R.wait,...(e.track==='assisted'?{}:{patient:R.patient}),oref0:R.oref0});
        const denC=Number.isFinite(R.causal)&&Number.isFinite(R.wait)?R.causal-R.wait:null;
        return {...t,S,N:n.normalized,N_causal:modern?n.normalized:denC!=null&&denC>=MIN_DENOMINATOR?(S-R.wait)/denC:null,dWait:Number.isFinite(R.wait)?S-R.wait:null};
      });
      const g=k=>mean(ts.map(t=>t.reward[k]));
      const a={agent,n:ts.length,tasks:new Set(ts.map(t=>t.task_id)).size,
        execution_protocols:[...new Set(ts.map(t=>(t.execution_protocol??t.agent_stats?.execution_protocol)?.label).filter(Boolean))],
        reward:ci(enriched,t=>t.S,`${e.id}:${agent}:S`,B),
        normalized:ci(enriched,t=>t.N,`${e.id}:${agent}:N`,B),
        normalized_causal:ci(enriched,t=>t.N_causal,`${e.id}:${agent}:Nc`,B),
        delta_vs_wait:agent==='wait'?null:ci(enriched,t=>t.dWait,`${e.id}:${agent}:dW`,B),
        tir:r4(g('tir')),tbr70:r4(g('tbr70')),tbr54:r4(g('tbr54')),tar250:r4(g('tar250')),mean_mgdl:r4(g('mean_mgdl')),
        tir_4_8:ci(enriched,t=>t.reward.tir_4_8,`${e.id}:${agent}:TIR4-8`,B),gmi_percent:r4(g('gmi_percent')),cv:r4(g('cv')),fast_roc_fraction:r4(g('fast_roc_fraction')),
        safety_pass_rate:r4(g('safety_pass')),severe_hypo_events:r4(g('severe_hypo_events')),
        pass_k:passK(ts.map(t=>({instance:t.task_id,safety_fail:!!t.reward.severe_hypo}))),
        severe_hypo_rate:r4(mean(ts.map(t=>t.reward.severe_hypo))),completed_rate:r4(mean(ts.map(t=>t.reward.completed))),
        agent_completed_rate:r4(mean(ts.map(t=>t.reward.agent_completed))),n_scored_with_fill:ts.filter(t=>t.state==='agent_failed').length,
        agent_seconds_mean:r4(mean(ts.map(t=>t.agent_result?.seconds))),trial_seconds_mean:r4(mean(ts.map(t=>t.seconds)))};
      const days=Math.max(0,...ts.map(t=>t.reward.days??0));
      if(days>0) {
        a.curve=Array.from({length:days},(_,i)=>{const k=`day_${i+1}_reward`,v=ts.map(t=>t.reward[k]).filter(Number.isFinite);
          return {day:i+1,mean:r4(mean(v)),n:v.length,ci95:ci(enriched.filter(t=>Number.isFinite(t.reward[k])),t=>t.reward[k],`${e.id}:${agent}:d${i+1}`,Math.min(B,1000)).ci95};});
        a.learning_slope=ci(enriched,t=>t.reward.learning_slope,`${e.id}:${agent}:slope`,B);
      }
      agents.push(a);
    }
    agents.sort((x,y)=>(y.reward.mean??-1)-(x.reward.mean??-1));
    const ex={id:e.id,title:e.title??e.id,track:e.track,primary_metric:e.primary_metric??'reward',tasks:new Set(rows.map(t=>t.task_id)).size,
      agents,refused:(config.refused??[]).filter(r=>r.experiment===e.id)};
    if(e.pairs?.length) {
      const perAgent=[];
      for(const [agent,ts] of byAgent) {
        const byTask=new Map(ts.map(t=>[`${t.task_id}/r${t.repeat}`,t.reward.reward])),pairs=[];
        for(const p of e.pairs)for(const r of new Set(ts.map(t=>t.repeat))) {
          const real=byTask.get(`${p.real_task}/r${r}`),twin=byTask.get(`${p.twin_task}/r${r}`);
          if(Number.isFinite(real)&&Number.isFinite(twin))pairs.push({task_id:p.pair_id,real,twin,gap:twin-real});
        }
        if(!pairs.length)continue;
        perAgent.push({agent,pairs:pairs.length,real_reward:ci(pairs,x=>x.real,`${e.id}:${agent}:real`,B),twin_reward:ci(pairs,x=>x.twin,`${e.id}:${agent}:twin`,B),
          transfer_gap:ci(pairs,x=>x.gap,`${e.id}:${agent}:gap`,B),abs_transfer_gap:r4(mean(pairs.map(x=>Math.abs(x.gap))))});
      }
      ex.pairs={n:e.pairs.length,agents:perAgent,
        rank_agreement:rankAgreement(perAgent.map(a=>a.twin_reward.mean),perAgent.map(a=>a.real_reward.mean))};
    }
    out.experiments.push(ex);
  }
  // Same instances on two tracks (e.g. exp1 full vs exp2 assisted): paired difference per agent.
  const instOf=t=>t.instance_id??t.task_id;
  for(let i=0;i<out.experiments.length;i++)for(let j=i+1;j<out.experiments.length;j++) {
    const A=out.experiments[i],Bx=out.experiments[j];if(A.track===Bx.track)continue;
    for(const agent of A.agents.map(a=>a.agent).filter(a=>Bx.agents.some(b=>b.agent===a))) {
      const ra=new Map(done.filter(t=>t.experiment===A.id&&t.agent===agent).map(t=>[`${instOf(t)}/r${t.repeat}`,t.reward.reward]));
      const diffs=done.filter(t=>t.experiment===Bx.id&&t.agent===agent&&ra.has(`${instOf(t)}/r${t.repeat}`))
        .map(t=>({task_id:instOf(t),d:t.reward.reward-ra.get(`${instOf(t)}/r${t.repeat}`)}));
      if(diffs.length)out.cross_track.push({a:A.id,b:Bx.id,agent,n:diffs.length,b_minus_a:ci(diffs,x=>x.d,`x:${A.id}:${Bx.id}:${agent}`,B)});
    }
  }
  if(write) {
    fs.writeFileSync(path.join(jobDir,'result.json'),JSON.stringify(out,null,1)+'\n');
    fs.writeFileSync(path.join(jobDir,'summary.md'),markdown(out));
    fs.writeFileSync(path.join(jobDir,'summary.html'),html(out));
  }
  return out;
}

const f3=v=>v==null?'–':Number(v).toFixed(3);
const pct=v=>v==null?'–':`${(100*v).toFixed(1)}%`;
const withCi=x=>x?.mean==null?'–':`${f3(x.mean)} [${f3(x.ci95[0])}, ${f3(x.ci95[1])}]`;

/** Markdown tables of a result object. */
export function markdown(r) {
  const T=r.trials,planned=T.planned??T.total;
  const L=[`# ${r.benchmark} — job ${r.job_id}`,'',`Trials: ${T.done}/${planned} done, ${T.agent_failed??0} agent_failed, ${T.infra_failed??T.error} infra_failed, ${T.not_started??0} not_started${T.partial?`, ${T.partial} interrupted`:''}. `+
    (r.include_failed?`agent_failed trials are INCLUDED in the scores (scored with WAIT fill; --include-failed).`:`Scores use done trials only (agent_failed trials are excluded; --include-failed to include them).`)+
    ` Scoring ${r.scoring?.version??''} (weights ${JSON.stringify(r.scoring?.weights??{})}, severe-hypo veto). 95% CIs: bootstrap over tasks.`,''];
  if(r.wall_seconds!=null)L.push(`Wall time ${r.wall_seconds.toFixed(1)} s; sum of trial times ${r.trial_seconds_total.toFixed(1)} s.`,'');
  if(r.agents&&Object.keys(r.agents).length) {
    const by=o=>Object.entries(o).map(([k,v])=>`${k} ${v}`).join(', ');
    L.push('## Trial outcomes','','| agent | planned | done | agent_failed (by reason) | infra_failed | not_started | attempts | input tokens | output tokens | cost USD |',
      '|---|---:|---:|---|---:|---|---:|---:|---:|---:|');
    for(const [a,o] of Object.entries(r.agents))L.push(`| ${a} | ${o.planned} | ${o.done} | ${o.agent_failed}${o.agent_failed?` (${by(o.agent_failed_by_reason)})`:''} | ${o.infra_failed} | ${o.not_started}${o.not_started?` (${by(o.not_started_by_reason)})`:''} | ${o.attempts} | ${o.input_tokens} | ${o.output_tokens} | ${o.cost_usd.toFixed(4)} |`);
    L.push('');
  }
  for(const e of r.experiments) {
    const protocols=e.agents.filter(a=>a.execution_protocols?.length);
    if(protocols.length)L.push('Decision protocols (recorded, not inferred):','',
      ...protocols.map(a=>`- ${a.agent}: ${a.execution_protocols.join('; ')}`),'');
    L.push(`## ${e.title} (\`${e.id}\`, track ${e.track}, ${e.tasks} tasks)`,'',
      '| agent | n | reward [95% CI] | N (vs ref) | N_causal | Δ vs wait [95% CI] | TIR | TBR<70 | TBR<54 | severe hypo | s/trial |',
      '|---|---:|---|---:|---:|---|---:|---:|---:|---:|---:|');
    for(const a of e.agents)L.push(`| ${a.agent} | ${a.n}${a.n_scored_with_fill?` (${a.n_scored_with_fill} WAIT-filled)`:''} | ${withCi(a.reward)} | ${f3(a.normalized.mean)} | ${f3(a.normalized_causal.mean)} | ${a.delta_vs_wait?withCi(a.delta_vs_wait):'–'} | ${pct(a.tir)} | ${pct(a.tbr70)} | ${pct(a.tbr54)} | ${pct(a.severe_hypo_rate)} | ${a.trial_seconds_mean?.toFixed(1)??'–'} |`);
    if(r.scoring?.version==='METRICS-v0.3') {
      L.push('','METRICS-v0.3 (legacy 70–180 TIR above is descriptive only):','',
        '| agent | safety pass | severe events / trial | TIR 4–8 [95% CI] | GMI % | CV | fast ROC fraction | pass^k |',
        '|---|---:|---:|---|---:|---:|---:|---:|');
      for(const a of e.agents)L.push(`| ${a.agent} | ${pct(a.safety_pass_rate)} | ${f3(a.severe_hypo_events)} | ${withCi(a.tir_4_8)} | ${f3(a.gmi_percent)} | ${pct(a.cv)} | ${pct(a.fast_roc_fraction)} | ${pct(a.pass_k.rate)} (k=${a.pass_k.k}) |`);
    }
    for(const x of e.refused)L.push('',`Refused: ${x.agent} (${x.reason}).`);
    const curves=e.agents.filter(a=>a.curve);
    if(curves.length) {
      const D=Math.max(...curves.map(a=>a.curve.length));
      L.push('','Daily reward (mean):','',`| agent | ${Array.from({length:D},(_,i)=>`day ${i+1}`).join(' | ')} | slope [95% CI] |`,`|---|${'---:|'.repeat(D)}---|`);
      for(const a of curves)L.push(`| ${a.agent} | ${a.curve.map(c=>f3(c.mean)).join(' | ')} | ${withCi(a.learning_slope)} |`);
    }
    if(e.pairs) {
      L.push('','Real vs twin:','','| agent | pairs | real_reward | twin_reward | transfer_gap (twin − real) |','|---|---:|---|---|---|');
      for(const a of e.pairs.agents)L.push(`| ${a.agent} | ${a.pairs} | ${withCi(a.real_reward)} | ${withCi(a.twin_reward)} | ${withCi(a.transfer_gap)} |`);
      L.push('',`Rank agreement across agents: Spearman ${f3(e.pairs.rank_agreement.spearman)}, Kendall ${f3(e.pairs.rank_agreement.kendall)} (n=${e.pairs.rank_agreement.n}).`);
    }
    L.push('');
  }
  if(r.cross_track.length) {
    L.push('## Same instances, different track','','| agent | b − a | n | mean [95% CI] |','|---|---|---:|---|');
    for(const x of r.cross_track)L.push(`| ${x.agent} | ${x.b} − ${x.a} | ${x.n} | ${withCi(x.b_minus_a)} |`);
    L.push('');
  }
  if(r.trials.errors.length)L.push('## Failed trials','',...r.trials.errors.map(e=>`- ${e.trial_id}: ${e.status??'error'}${e.reason?` (${e.reason})`:''}${e.attempt?`, attempt ${e.attempt}`:''}: ${e.error}`),'');
  return L.join('\n');
}

const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
/** Small self-contained HTML page with the same tables. */
export function html(r) {
  const md=markdown(r).split('\n');
  const out=[];let inTable=false;
  for(const line of md) {
    if(line.startsWith('|')) {
      const cells=line.slice(1,-1).split('|').map(c=>c.trim());
      if(cells.every(c=>/^-+:?$/.test(c)))continue;
      if(!inTable){out.push('<table><thead><tr>'+cells.map(c=>`<th>${esc(c)}</th>`).join('')+'</tr></thead><tbody>');inTable=true;continue;}
      out.push('<tr>'+cells.map((c,i)=>`<td${i?' class="n"':''}>${esc(c.replace(/`/g,''))}</td>`).join('')+'</tr>');continue;
    }
    if(inTable){out.push('</tbody></table>');inTable=false;}
    if(line.startsWith('# '))out.push(`<h1>${esc(line.slice(2))}</h1>`);
    else if(line.startsWith('## '))out.push(`<h2>${esc(line.slice(3).replace(/`/g,''))}</h2>`);
    else if(line.startsWith('- '))out.push(`<p class="err">${esc(line.slice(2))}</p>`);
    else if(line.trim())out.push(`<p>${esc(line.replace(/`/g,''))}</p>`);
  }
  if(inTable)out.push('</tbody></table>');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(r.benchmark)} ${esc(r.job_id)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:2em auto;max-width:1100px;padding:0 1em;color:#1f2328}
table{border-collapse:collapse;margin:.5em 0 1.2em}th,td{border-bottom:1px solid #d0d7de;padding:4px 10px;text-align:left}
td.n{font-variant-numeric:tabular-nums}th{background:#f6f8fa}h2{margin-top:1.6em}.err{color:#9a3412}
footer{color:#57606a;margin-top:2em;font-size:12px}</style></head><body>
${out.join('\n')}
<footer>sweet-sim benchmark result (${esc(RESULT_FORMAT)}). Simulation only; not medical advice.</footer></body></html>
`;
}
