#!/usr/bin/env node
// MVP results browser and archive (results/mvp-2026-10-15/): collects every Harbor job under
// artifacts/benchmarks/jobs (docs/BENCH.zh-CN.md §8) plus the in-process Exp 3 / Exp 4 outputs and
// writes a compact, git-trackable folder:
//
//   index.html                 self-contained page (Chinese UI, mmol/L default, mg/dL toggle): overview of the
//                              four experiments, score tables with bootstrap CIs, Exp 3 learning / parameter-error
//                              curves, Exp 4 fit + twin-vs-real, every trial clickable -> embedded player
//   players/<experiment>.html  scripts/video/player.js page with that experiment's run records (gzip+base64 inside),
//                              plus a decision list (action, rationale; click = jump to that time)
//   trials.jsonl               one line per trial of every job (selected or superseded), reward fields, paths
//   archive/<job>/<trial>.json.gz   trial.json + reward + metrics + run.json + agent logs (actions, decisions,
//                              transcript, memory, status) - sweet-sim.trial-archive/v1
//   archive/inputs/*.json.gz   job configs/results, benchmark manifests + task.toml/public.json, Exp 3 / Exp 4
//                              in-process outputs, oracle decision logs
//   videos/                    representative MP4s (--videos records the missing ones via scripts/demo-video.mjs)
//   manifest.json              sources, selection, sizes, sha256 of the archives
//
// Selection: per experiment x agent the newest job (config.created) that has finished ALL its planned trials for it
// (else the job with the most finished trials); within it one trial per task x repeat. Older jobs' trials stay in trials.jsonl / archive with selected=false.
//
//   node scripts/mvp-report.mjs [--out results/mvp-2026-10-15] [--jobs-dir artifacts/benchmarks/jobs]
//        [--jobs a,b] [--exclude-jobs a,b] [--exp3 artifacts/exp3] [--exp4 artifacts/exp4/mvp] [--oracle artifacts/oracle]
//        [--videos] [--video-seconds 50] [--video-kbps 1500] [--max-bundle-mb 150] [--B 2000] [--title 'OpenDiabet MVP 结果']
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {bootstrapMean} from '../src/bench/score.mjs';
import {rankAgreement} from '../src/benchmark/summarize.mjs';
import {reportPrice,scoringDisplay,reportCampaignScope} from '../src/benchmark/report-display.mjs';

const argv=process.argv.slice(2),opt={};
for(let i=0;i<argv.length;i++){const a=argv[i];if(!a.startsWith('--'))continue;const k=a.slice(2),v=argv[i+1];
  if(v===undefined||v.startsWith('--'))opt[k]=true;else{opt[k]=v;i++;}}
const REPORT_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ROOT=path.resolve(opt['runtime-root']??REPORT_ROOT);
const rel=p=>path.relative(ROOT,path.resolve(p)).split(path.sep).join('/');
const OUT=path.resolve(opt.out??path.join(ROOT,'results','mvp-2026-10-15'));
const JOBS_DIR=path.resolve(opt['jobs-dir']??path.join(ROOT,'artifacts','benchmarks','jobs'));
const list=v=>v&&v!==true?String(v).split(',').map(s=>s.trim()).filter(Boolean):null;
const ONLY=list(opt.jobs),EXCLUDE=new Set(list(opt['exclude-jobs'])??[]);
const B=Number(opt.B??2000);
const readJson=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const explicitSelection=opt.selection?readJson(path.resolve(opt.selection)):null;
const selectionAllows=x=>{
  const wanted=explicitSelection?.[x.t.experiment]?.[x.t.agent];
  return wanted==null||wanted===x.job.id;
};
const tryJson=f=>{try{return fs.existsSync(f)?readJson(f):null;}catch{return null;}};
const tryText=(f,max=null)=>{try{if(!fs.existsSync(f))return null;const t=fs.readFileSync(f,'utf8');return max&&t.length>max?t.slice(-max):t;}catch{return null;}};
const jsonl=f=>{const t=tryText(f);return t==null?null:t.split('\n').filter(l=>l.trim()).map(l=>{try{return JSON.parse(l);}catch{return {unparsed:l};}});};
const sha256=buf=>crypto.createHash('sha256').update(buf).digest('hex');
const r4=v=>v==null||!Number.isFinite(v)?null:Number(v.toFixed(4));
const mean=xs=>{const v=xs.filter(Number.isFinite);return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;};
const sum=xs=>xs.filter(Number.isFinite).reduce((a,b)=>a+b,0);
const groupBy=(xs,key)=>{const m=new Map();for(const x of xs){const k=key(x);if(!m.has(k))m.set(k,[]);m.get(k).push(x);}return m;};
const gz=obj=>zlib.gzipSync(Buffer.from(typeof obj==='string'?obj:JSON.stringify(obj)),{level:9});
const WRITTEN=new Set();   // files produced by this run; stale archive/ and players/ files are pruned at the end
const writeIfChanged=(file,buf)=>{WRITTEN.add(path.resolve(file));fs.mkdirSync(path.dirname(file),{recursive:true});
  if(fs.existsSync(file)&&fs.readFileSync(file).equals(buf))return false;fs.writeFileSync(file,buf);return true;};
const dirSize=d=>{if(!fs.existsSync(d))return 0;let s=0;for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);s+=e.isDirectory()?dirSize(p):fs.statSync(p).size;}return s;};
const ci=(rows,val,label)=>{const g=[...groupBy(rows,r=>r.task_id).values()].map(x=>x.map(val).filter(Number.isFinite));
  const b=bootstrapMean(g,{B,label});return {mean:r4(b.mean),ci95:b.ci95.map(r4),n:b.n};};

// ---- labels -----------------------------------------------------------------------------------
const EXP_ORDER=['exp1-full','exp2-assisted','exp3-longitudinal','exp4-real2sim2real'];
const EXP_INFO={
  'exp1-full':{short:'实验 1 全权管理',question:'患者完全不自我管理时，智能体单独负责全部治疗决策，能否安全、有效地控制血糖？',
    setup:x=>`全权赛道（self_care: none）；bench-v0.2 中 ${x.tasks} 个环境${x.tasks<=16?'（按观测配置与泵/笔分层抽取）':''}，${x.hours} 小时，每个环境 ${x.repeats} 次重复（同一个人的不同日子）。`},
  'exp2-assisted':{short:'实验 2 辅助管理',question:'患者已自己打餐时针、处理看得到的低血糖时，智能体能否在不增加风险的前提下进一步改善？',
    setup:x=>`辅助赛道（self_care: assisted）；与实验 1 相同的 ${x.tasks} 个环境和种子，${x.hours} 小时，${x.repeats} 次重复。wait = 患者自己管理；patient 基线在此赛道不定义。`},
  'exp3-longitudinal':{short:'实验 3 长期自我改进',question:'同一个人连续多天，智能体能否积累经验、修正错配的档案（基础率 / ISF / 碳水比），控制越来越好？',
    setup:x=>`${x.tasks} 个人 × ${x.days} 天，全权赛道；档案按 20–40% 故意错配，开启 SET_PROFILE。fixed = 患者基线、档案不变；adaptive = 同一基线 + 跨天记忆 + 每天 06:00 调档；causal = 因果最优决策跨天连续运行（只在进程内结果中）。`},
  'exp4-real2sim2real':{short:'实验 4 Real → Sim → Real',question:'从个人记录重建的数字孪生上的智能体排名，能否迁移回这个"真实"的人？',
    setup:x=>`${x.persons} 个合成"真实"个体，日常治疗记录 → trace2sim 重建孪生并用留出天检验；共 ${x.pairs} 对 real / twin 任务（同一人同一未来日、同一日种子）。`},
};
const AGENT_LABEL=(agent,exp)=>{
  if(exp==='exp3-longitudinal'&&agent==='patient')return 'fixed（患者基线，档案不变）';
  if(/exp3-agent-adaptive/.test(agent))return 'adaptive（跨天记忆 + 调档）';
  const m=/^llm:(.+)$/.exec(agent);if(m)return `LLM ${path.basename(m[1]).replace(/\.json$/,'')}`;
  return {wait:'wait（不干预）',patient:'patient（患者基线）',oref0:'oref0',causal:'causal（因果最优）',oracle:'oracle（任务参考解）'}[agent]??agent;
};
const AGENT_KEY=agent=>/exp3-agent-adaptive/.test(agent)?'adaptive':/^llm:/.test(agent)?`llm:${path.basename(agent.slice(4)).replace(/\.json$/,'')}`:/^cmd:/.test(agent)?'cmd':agent;

// ---- 1. jobs and trials -------------------------------------------------------------------------
const jobs=[];
for(const d of fs.existsSync(JOBS_DIR)?fs.readdirSync(JOBS_DIR).sort():[]) {
  const dir=path.join(JOBS_DIR,d),config=tryJson(path.join(dir,'config.json'));
  if(!config||config.format!=='sweet-sim.benchmark-job/v1')continue;
  if(ONLY&&!ONLY.includes(d))continue;if(EXCLUDE.has(d))continue;
  const bench=config.benchmark_dir?tryJson(path.join(config.benchmark_dir,'benchmark.json')):null;
  jobs.push({id:d,dir,config,bench,created:config.created??'',result:tryJson(path.join(dir,'result.json'))});
}
// Mirrored jobs keep their remote paths. Reuse a local manifest only after its exact digest matches.
for(const job of jobs)if(!job.bench&&job.config.benchmark_sha256) {
  const local=jobs.find(j=>j.bench&&j.config.benchmark_sha256===job.config.benchmark_sha256
    &&fs.existsSync(path.join(j.config.benchmark_dir,'benchmark.json'))
    &&sha256(fs.readFileSync(path.join(j.config.benchmark_dir,'benchmark.json')))===job.config.benchmark_sha256);
  if(local)job.bench=local.bench;
}
const trials=[];
for(const job of jobs) {
  for(const d of fs.readdirSync(job.dir).sort()) {
    const tdir=path.join(job.dir,d),t=tryJson(path.join(tdir,'trial.json'));
    if(!t||t.format!=='sweet-sim.trial/v1')continue;
    const task=job.bench?.tasks?.[t.task_id]??{};
    const expDef=job.bench?.experiments?.find(e=>e.id===t.experiment);
    trials.push({job,dir:tdir,t,task,expDef});
  }
}
// Selection: latest job per experiment x agent; one trial per task x repeat.
const doneOf=x=>x.t.status==='done'&&x.t.reward;
const repsOf=(job,exp)=>{const rep=job.config.repeats,def=job.bench?.experiments?.find(e=>e.id===exp);return typeof rep==='number'?rep:(rep?.[exp]??def?.repeats??1);};
const drawsOf=(job,agent)=>/^llm:/.test(agent)?(job.config.model_draws??1):1;
// A job counts as complete for experiment x agent when it has a done trial for every task x repeat it
// planned (benchmark task_ids x job repeats); the newest complete job wins, so a job that is still
// running (e.g. a new mvp2-* job) only replaces the older one once it has finished. Without any
// complete job the one with the most done trials (newest on ties) is used.
const latest=new Map();
{
  const cand=new Map();
  for(const x of trials.filter(x=>doneOf(x)&&selectionAllows(x))) {
    const k=`${x.t.experiment}|${x.t.agent}`;if(!cand.has(k))cand.set(k,new Map());
    const m=cand.get(k);if(!m.has(x.job))m.set(x.job,new Set());m.get(x.job).add(`${x.t.task_id}|${x.t.repeat}|${x.t.model_draw??0}`);
  }
  const newer=(a,b)=>a.created>b.created||(a.created===b.created&&a.id>b.id);
  for(const [k,m] of cand) {
    const exp=k.split('|')[0];let best=null;
    for(const [job,done] of m) {
      const def=job.bench?.experiments?.find(e=>e.id===exp);
      const complete=def?done.size>=def.task_ids.length*repsOf(job,exp)*drawsOf(job,k.split('|')[1]):false;
      const c={job,complete,n:done.size};
      if(!best||(c.complete&&!best.complete)||(c.complete===best.complete&&(c.complete?newer(job,best.job):c.n>best.n||(c.n===best.n&&newer(job,best.job)))))best=c;
    }
    latest.set(k,best.job);
  }
}
const seen=new Set();
for(const x of trials) {
  const k=`${x.t.experiment}|${x.t.agent}`,key=`${k}|${x.t.task_id}|${x.t.repeat}|${x.t.model_draw??0}`;
  x.selected=doneOf(x)&&selectionAllows(x)&&latest.get(k)===x.job&&!seen.has(key);
  if(x.selected)seen.add(key);
}
const selected=trials.filter(x=>x.selected);
const campaignScope=reportCampaignScope(opt['campaign-scope']?readJson(path.resolve(opt['campaign-scope'])):null,
  trials.map(x=>({job_id:x.job.id,experiment:x.t.experiment,agent:x.t.agent,status:x.t.status})));
const isReusedBaseline=e=>!!campaignScope&&selected.some(x=>x.t.experiment===e)
  &&selected.filter(x=>x.t.experiment===e).every(x=>x.job.id===campaignScope.baseline_job_id&&x.t.agent==='wait');
console.error(`jobs: ${jobs.map(j=>j.id).join(', ')}; trials ${trials.length}, selected ${selected.length}`);

// ---- 2. archive ---------------------------------------------------------------------------------
const maxBundleBytes=Number(opt['max-bundle-mb']??150)*1e6;
// Sidecar bundles (SimEnv.exportBundle; bundle.json or bundle.json.gz anywhere in the trial dir, e.g. when the
// runner keeps them). Paths + sha256 always go into the trial archive / manifest; the files themselves are copied
// (gzipped) to archive/bundles/<job>/<trial>/ when the selected ones total <= --max-bundle-mb.
const findBundles=d=>{const o=[];const walk=p=>{for(const e of fs.readdirSync(p,{withFileTypes:true})){const q=path.join(p,e.name);
  if(e.isDirectory()){if(e.name!=='node_modules')walk(q);}else if(/(^|[.-])bundle\.json(\.gz)?$/.test(e.name))o.push(q);}};walk(d);return o;};
const bundleFiles=[];
for(const x of trials)for(const f of findBundles(x.dir))bundleFiles.push({x,file:f,size:fs.statSync(f).size});
const bundleBytesOf=bs=>sum(bs.map(b=>b.file.endsWith('.gz')?b.size:b.size/6));   // rough gzip ratio for plain JSON
const copySelectedOnly=bundleBytesOf(bundleFiles)>maxBundleBytes;
const includeBundles=bundleBytesOf(bundleFiles.filter(b=>!copySelectedOnly||b.x.selected))<=maxBundleBytes;
const bundleCopy=b=>{
  const buf=fs.readFileSync(b.file),gzBuf=b.file.endsWith('.gz')?buf:zlib.gzipSync(buf,{level:9});
  const info={path:rel(b.file),sha256:sha256(buf),bytes:buf.length};
  if(includeBundles&&(!copySelectedOnly||b.x.selected)) {
    const sub=path.relative(b.x.dir,b.file).split(path.sep).join('__').replace(/\.gz$/,'');
    const out=path.join(OUT,'archive','bundles',b.x.job.id,b.x.t.trial_id,`${sub}.gz`);writeIfChanged(out,gzBuf);
    Object.assign(info,{archived:path.relative(OUT,out).split(path.sep).join('/'),archived_sha256:sha256(gzBuf),archived_bytes:gzBuf.length});
  }
  return info;
};
const archiveIndex=[];
let archiveWritten=0;
for(const x of trials) {
  const a=path.join(x.dir,'agent'),v=path.join(x.dir,'verifier');
  const files={};
  for(const f of fs.existsSync(a)?fs.readdirSync(a):[]) {
    const p=path.join(a,f);if(!fs.statSync(p).isFile())continue;
    if(f.endsWith('.jsonl'))files[f]=jsonl(p);
    else if(f.endsWith('.json'))files[f]=tryJson(p);
    else if(f.endsWith('.txt'))files[f]=tryText(p,20000);
  }
  const bundles=bundleFiles.filter(b=>b.x===x).map(bundleCopy);
  x.bundles=bundles;
  const doc={format:'sweet-sim.trial-archive/v1',job_id:x.job.id,trial_id:x.t.trial_id,source_dir:rel(x.dir),
    job:{config:x.job.config,benchmark:x.job.bench?.name??null,benchmark_commit:x.job.bench?.sweet_sim_commit??null,
      benchmark_snapshot_sha256:x.job.bench?.sweet_sim_snapshot_sha256??null},
    trial:x.t,task:x.task,
    verifier:{reward:tryJson(path.join(v,'reward.json')),metrics:tryJson(path.join(v,'metrics.json')),run:tryJson(path.join(v,'run.json')),
      stderr:tryText(path.join(v,'stderr.txt'),20000)},
    agent:files,sim_log:tryText(path.join(x.dir,'sim.log'),20000),bundles};
  const out=path.join(OUT,'archive',x.job.id,`${x.t.trial_id}.json.gz`),buf=gz(doc);
  if(writeIfChanged(out,buf))archiveWritten++;
  x.archive=rel(out);x.archiveSha=sha256(buf);x.run=doc.verifier.run;x.agentFiles=files;x.metrics=doc.verifier.metrics;
  archiveIndex.push({trial:`${x.job.id}/${x.t.trial_id}`,path:path.relative(OUT,out),sha256:x.archiveSha,bytes:buf.length});
}
// Inputs: job configs/results, benchmark manifests + per-task public metadata, in-process outputs, oracle logs.
const packDir=(dir,filter=()=>true)=>{const o={};const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
  if(e.isDirectory())walk(p);else if(filter(p)){const t=fs.readFileSync(p,'utf8');o[rel(p)]=p.endsWith('.json')?(()=>{try{return JSON.parse(t);}catch{return t;}})():t;}}};
  if(fs.existsSync(dir))walk(dir);return o;};
const inputs={};
inputs.jobs=Object.fromEntries(jobs.map(j=>[j.id,{config:j.config,result:j.result,summary_md:tryText(path.join(j.dir,'summary.md'))}]));
const benchDirs=[...new Set(jobs.map(j=>j.config.benchmark_dir).filter(d=>d&&fs.existsSync(d)))];
inputs.benchmarks=Object.fromEntries(benchDirs.map(d=>{const m=readJson(path.join(d,'benchmark.json'));
  const tasks={};for(const id of Object.keys(m.tasks??{})){const td=path.join(d,m.tasks[id].dir??`tasks/${id}`);
    tasks[id]={task_toml:tryText(path.join(td,'task.toml')),public:tryJson(path.join(td,'environment','public.json')),instruction:tryText(path.join(td,'instruction.md'))};}
  return [rel(d),{manifest:m,tasks}];}));
const exp3Dir=path.resolve(opt.exp3??(()=>{ // newest artifacts/exp3*/mvp-results.json
  const c=fs.readdirSync(path.join(ROOT,'artifacts')).filter(d=>/^exp3/.test(d)).map(d=>path.join(ROOT,'artifacts',d))
    .filter(d=>fs.existsSync(path.join(d,'mvp-results.json'))).sort((a,b)=>fs.statSync(path.join(b,'mvp-results.json')).mtimeMs-fs.statSync(path.join(a,'mvp-results.json')).mtimeMs);
  return c[0]??path.join(ROOT,'artifacts','exp3');})());
const exp4Dir=path.resolve(opt.exp4??path.join(ROOT,'artifacts','exp4','mvp'));
const oracleDir=path.resolve(opt.oracle??path.join(ROOT,'artifacts','oracle'));
const inputFiles={
  'jobs-and-benchmarks':inputs,
  'exp3-inprocess':packDir(exp3Dir),
  'exp3-tasks':{[rel(path.join(ROOT,'artifacts','benchmarks','exp3-tasks.jsonl'))]:tryText(path.join(ROOT,'artifacts','benchmarks','exp3-tasks.jsonl'))},
  'exp4-inprocess':packDir(exp4Dir),
  'oracle-logs':packDir(oracleDir),
};
for(const [k,v] of Object.entries(inputFiles)){const buf=gz(v),f=path.join(OUT,'archive','inputs',`${k}.json.gz`);writeIfChanged(f,buf);
  archiveIndex.push({input:k,path:path.relative(OUT,f),sha256:sha256(buf),bytes:buf.length});}

// ---- 3. trials.jsonl ----------------------------------------------------------------------------
const playerFile=exp=>`players/${exp}.html`;
const trialLines=trials.map(x=>{const t=x.t,f=x.task.factors??null;
  return {experiment:t.experiment,track:t.track,task_id:t.task_id,instance_id:t.instance_id,factors:f,tier:x.task.tier??null,
    role:t.role,pair_id:t.pair_id,agent:t.agent,repeat:t.repeat,model_draw:t.model_draw??0,episode_seed:t.episode_seed,person_seed:t.person_seed,
    job_id:x.job.id,trial_id:t.trial_id,selected:x.selected,status:t.status,error:t.error,
    started:t.started,finished:t.finished,seconds:t.seconds,agent_seconds:t.agent_result?.seconds??null,
    reward:t.reward,cost:x.metrics?.metrics?.cost??null,
    paths:{trial_dir:rel(x.dir),archive:path.relative(OUT,path.resolve(ROOT,x.archive)),player:x.selected?`${playerFile(t.experiment)}?id=${encodeURIComponent(t.trial_id)}`:null}};});
writeIfChanged(path.join(OUT,'trials.jsonl'),Buffer.from(trialLines.map(l=>JSON.stringify(l)).join('\n')+'\n'));

// ---- 4. statistics ------------------------------------------------------------------------------
const rowOf=x=>({task_id:x.t.task_id,instance:x.t.instance_id,repeat:x.t.repeat,agent:x.t.agent,R:x.t.reward,t:x.t,x});
const experimentIds=[...new Set(selected.map(x=>x.t.experiment))].sort((a,b)=>(EXP_ORDER.indexOf(a)+1||99)-(EXP_ORDER.indexOf(b)+1||99)||a.localeCompare(b));
const stats={};
for(const e of experimentIds) {
  const rows=selected.filter(x=>x.t.experiment===e).map(rowOf);
  const waitBy=new Map(rows.filter(r=>r.agent==='wait').map(r=>[`${r.task_id}/${r.repeat}`,r.R.reward]));
  const agents=[];
  for(const [agent,rs] of groupBy(rows,r=>r.agent)) {
    const g=k=>r4(mean(rs.map(r=>r.R[k])));
    const tok=rs.map(r=>{const c=r.x.metrics?.metrics?.cost,s=r.x.agentFiles?.['status.json'];
      return {in:Math.max(c?.input_tokens??0,s?.input_tokens??s?.stats?.input_tokens??0),out:Math.max(c?.output_tokens??0,s?.output_tokens??s?.stats?.output_tokens??0),usd:Math.max(c?.usd??0,s?.cost_usd??s?.stats?.cost_usd??0)};});
    const a={agent,label:AGENT_LABEL(agent,e),key:AGENT_KEY(agent),job:rs[0].x.job.id,n:rs.length,tasks:new Set(rs.map(r=>r.task_id)).size,
      execution_protocols:[...new Set(rs.map(r=>(r.x.t.execution_protocol??r.x.t.agent_stats?.execution_protocol)?.label).filter(Boolean))],
      planned:(rs[0].x.expDef?.task_ids?.length??null)!=null?rs[0].x.expDef.task_ids.length*repsOf(rs[0].x.job,e)*drawsOf(rs[0].x.job,agent):null,
      reward:ci(rs,r=>r.R.reward,`${e}:${agent}:S`),
      normalized:ci(rs,r=>r.R.normalized,`${e}:${agent}:N`),
      delta_vs_wait:agent==='wait'?null:ci(rs.filter(r=>waitBy.has(`${r.task_id}/${r.repeat}`)),r=>r.R.reward-waitBy.get(`${r.task_id}/${r.repeat}`),`${e}:${agent}:dW`),
      tir:g('tir'),tbr70:g('tbr70'),tbr54:g('tbr54'),tar250:g('tar250'),mean_mgdl:g('mean_mgdl'),
      severe:sum(rs.map(r=>r.R.severe_hypo)),hypo_events:sum(rs.map(r=>r.R.hypo_events)),
      steps:r4(mean(rs.map(r=>r.R.agent_steps))),verifier_wait_steps:sum(rs.map(r=>r.R.verifier_wait_steps)),
      agent_completed:r4(mean(rs.map(r=>r.R.agent_completed))),
      seconds:r4(mean(rs.map(r=>r.t.seconds))),agent_seconds:r4(mean(rs.map(r=>r.t.agent_result?.seconds))),
      tokens_in:sum(tok.map(t=>t.in)),tokens_out:sum(tok.map(t=>t.out)),
      ...reportPrice(agent,r4(sum(tok.map(t=>t.usd))),rs.flatMap(r=>r.x.job.config.failure_handling?.warnings??[]))};
    const days=Math.max(0,...rs.map(r=>r.R.days??0));
    if(days>0) {
      a.curve=Array.from({length:days},(_,i)=>{const k=`day_${i+1}_reward`;const c=ci(rs.filter(r=>Number.isFinite(r.R[k])),r=>r.R[k],`${e}:${agent}:d${i+1}`);
        return {day:i+1,mean:c.mean,ci95:c.ci95,n:c.n};});
      a.learning_slope=ci(rs,r=>r.R.learning_slope,`${e}:${agent}:slope`);
    }
    agents.push(a);
  }
  agents.sort((p,q)=>(q.reward.mean??-1)-(p.reward.mean??-1));
  const ex={id:e,agents,jobs:[...new Set(rows.map(r=>r.x.job.id))],tasks:new Set(rows.map(r=>r.task_id)).size,
    title:rows[0].x.expDef?.title??e,track:rows[0].t.track};
  // Exp 4 style pairs (role real/twin).
  const pairs=rows.filter(r=>r.t.pair_id);
  if(pairs.length) {
    const perAgent=[],byPerson=new Map();
    for(const [agent,rs] of groupBy(pairs,r=>r.agent)) {
      const P=[];
      for(const [pid,g] of groupBy(rs,r=>`${r.t.pair_id}/${r.repeat}`)) {
        const real=g.find(r=>r.t.role==='real'),twin=g.find(r=>r.t.role==='twin');
        if(real&&twin)P.push({task_id:pid.split('/')[0],person:(/exp4-(p\d+)/.exec(pid)??[])[1]??pid,real:real.R.reward,twin:twin.R.reward,gap:twin.R.reward-real.R.reward,
          real_trial:real.t.trial_id,twin_trial:twin.t.trial_id});
      }
      if(!P.length)continue;
      perAgent.push({agent,label:AGENT_LABEL(agent,e),pairs:P.length,real:ci(P,p=>p.real,`${e}:${agent}:real`),twin:ci(P,p=>p.twin,`${e}:${agent}:twin`),
        gap:ci(P,p=>p.gap,`${e}:${agent}:gap`),abs_gap:r4(mean(P.map(p=>Math.abs(p.gap))))});
      for(const p of P){if(!byPerson.has(p.person))byPerson.set(p.person,new Map());const m=byPerson.get(p.person);if(!m.has(agent))m.set(agent,[]);m.get(agent).push(p);}
    }
    const persons=[...byPerson].sort().map(([person,m])=>{
      const ag=[...m].map(([agent,P])=>({agent,twin:mean(P.map(p=>p.twin)),real:mean(P.map(p=>p.real))}));
      const ra=rankAgreement(ag.map(a=>a.twin),ag.map(a=>a.real));
      const bt=Math.max(...ag.map(a=>a.twin)),br=Math.max(...ag.map(a=>a.real));
      const pick=ag.filter(a=>a.twin>=bt-1e-9);
      return {person,agents:ag.map(a=>({agent:a.agent,twin:r4(a.twin),real:r4(a.real),gap:r4(a.twin-a.real)})),kendall:ra.kendall,spearman:ra.spearman,
        best_twin:pick.map(a=>a.agent),best_real:ag.filter(a=>a.real>=br-1e-9).map(a=>a.agent),regret:r4(br-mean(pick.map(a=>a.real)))};
    });
    ex.pairs={agents:perAgent,persons,
      rank_agent_means:rankAgreement(perAgent.map(a=>a.twin.mean),perAgent.map(a=>a.real.mean)),
      kendall_mean:r4(mean(persons.map(p=>p.kendall))),best_match_rate:r4(mean(persons.map(p=>p.best_twin.some(a=>p.best_real.includes(a))?1:0))),
      regret_mean:r4(mean(persons.map(p=>p.regret)))};
  }
  stats[e]=ex;
}
// Same instance on two tracks (exp1 vs exp2).
const cross=[];
if(stats['exp1-full']&&stats['exp2-assisted'])for(const a of stats['exp1-full'].agents.map(a=>a.agent)) {
  const A=new Map(selected.filter(x=>x.t.experiment==='exp1-full'&&x.t.agent===a).map(x=>[`${x.t.instance_id}/${x.t.repeat}`,x.t.reward.reward]));
  const d=selected.filter(x=>x.t.experiment==='exp2-assisted'&&x.t.agent===a&&A.has(`${x.t.instance_id}/${x.t.repeat}`))
    .map(x=>({task_id:x.t.instance_id,d:x.t.reward.reward-A.get(`${x.t.instance_id}/${x.t.repeat}`)}));
  if(d.length)cross.push({agent:a,label:AGENT_LABEL(a,'exp1-full'),n:d.length,diff:ci(d,x=>x.d,`x:${a}`)});
}
// In-process Exp 3 and Exp 4 outputs.
const exp3=tryJson(path.join(exp3Dir,'mvp-results.json'));
const exp3InProcess=exp3?{source:rel(exp3Dir),version:exp3.version,days:exp3.days,agents:exp3.agents,curve:exp3.curve,summary:exp3.summary,
  persons:exp3.persons.map(p=>({id:p.id,mismatch:p.mismatch_factors,best_fixed:p.best_fixed?{factors:p.best_fixed.factors??null,reward:p.best_fixed.reward_mean??p.best_fixed.reward??null}:null,
    agents:Object.fromEntries(Object.entries(p.agents).map(([k,a])=>[k,{days:a.days.map(d=>({day:d.day+1,reward:d.reward,tir:d.tir,tbr70:d.tbr70})),
      errors:a.errors_by_day,runtime_s:a.runtime_s,
      changes:(a.changes??[]).map(c=>typeof c==='string'?c:`${String(c.time??'').slice(5,16).replace('T',' ')} UTC ${Object.entries(c.changes??{}).map(([k,v])=>
        `${{carb_ratio_g_per_u:'碳水比',isf_mgdl_per_u:'ISF',basal_u_per_h:'基础率'}[k]??k} ${v?.from??'?'}→${v?.to??'?'}`).join(', ')}`)}]))}))}:null;
const exp4s=tryJson(path.join(exp4Dir,'summary.json'));
const exp4InProcess=exp4s?{source:rel(exp4Dir),options:exp4s.options,fit:exp4s.fit,transfer:exp4s.transfer,wall_seconds:exp4s.wall_seconds,
  persons:Object.fromEntries(fs.readdirSync(path.join(exp4Dir,'persons')).filter(f=>/^p\d+\.json$/.test(f)).map(f=>{const p=readJson(path.join(exp4Dir,'persons',f));
    const P=p.person??{};return [f.replace('.json',''),{type:P.type??null,therapy:P.therapy??null,device:P.device??null,cgm:P.cgm??null,
      announce_probability:P.announce_probability??null,record:p.record??null}];}))}:null;

// ---- 5. players ---------------------------------------------------------------------------------
const playerTpl=fs.readFileSync(path.join(ROOT,'scripts','video','player.html'),'utf8');
const playerJs=fs.readFileSync(path.join(ROOT,'scripts','video','player.js'),'utf8');
if(/<\/script/i.test(playerJs))throw new Error('player.js contains </script; cannot inline');
const short=v=>Math.round(v*100)/100;
const compactRun=(run,x)=>({...run,id:x.t.trial_id,policy:AGENT_LABEL(x.t.agent,x.t.experiment),
  series:Object.fromEntries(Object.entries(run.series??{}).map(([k,s])=>[k,Array.isArray(s)?s.map(([m,v])=>[m,v==null?v:short(v)]):s])),
  _meta:{experiment:x.t.experiment,task_id:x.t.task_id,agent:x.t.agent,repeat:x.t.repeat,role:x.t.role,job:x.job.id,reward:x.t.reward,
    execution_protocol:x.t.execution_protocol??x.t.agent_stats?.execution_protocol??null,
    rejected:(x.agentFiles?.['actions.jsonl']??[]).filter(a=>a.status==='rejected').map(a=>({time:a.time,action:a.action,reason:a.reason,rationale:a.rationale})).slice(0,50)}});
const playerExtra=`
<div id="trialmeta" style="max-width:1280px;margin:8px auto 0;padding:0 16px;font-size:13px;color:#57606a"></div>
<div id="notes" style="max-width:1280px;margin:6px auto 24px;padding:0 16px"></div>
<style>#notes table{border-collapse:collapse;width:100%;font-size:13px;background:#fff}#notes th,#notes td{border-bottom:1px solid #e6e8eb;padding:4px 8px;text-align:left;vertical-align:top}
#notes tr.d:hover{background:#fff4d6;cursor:pointer}#notes th{background:#f6f8fa;position:sticky;top:0}#notes .w{color:#57606a}#notes .rej{color:#b42318}</style>
<script>
function renderNotes(){
  const run=cur,meta=run._meta??{},R=meta.reward??{};
  const pct=v=>v==null?'–':(100*v).toFixed(1)+'%';
  document.getElementById('trialmeta').textContent=\`\${meta.experiment??''} · 任务 \${meta.task_id??run.id} · 智能体 \${run.policy} · 重复 r\${meta.repeat??0}\${meta.role?' · '+meta.role:''} · job \${meta.job??''} · reward \${R.reward!=null?R.reward.toFixed(3):'–'} · TIR \${pct(R.tir)} · TBR<\${TH().low} \${pct(R.tbr70)} · TBR<\${TH().vlow} \${pct(R.tbr54)} · 平均 \${fmtG(R.mean_mgdl)} \${UL()}\${R.severe_hypo?' · 严重低血糖':''}\`;
  if(meta.execution_protocol?.label)document.getElementById('trialmeta').textContent+=' · '+meta.execution_protocol.label;
  const ck=m=>{const c=clock(run,m);return (run.hours>24?'D'+c.day+' ':'')+c.text;};
  const unit=t=>t==='INGEST_CARBS'?' g':t==='TEMP_BASAL'?' U/h':' U';
  const rows=run.treatments.map(([m,type,amt,why0])=>\`<tr class="d" data-m="\${m}"><td>\${ck(m)}</td><td>\${(L.action[type]??type)+(amt!=null?' '+amt+unit(type):'')}</td><td class="w">\${String(why(why0)??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</td></tr>\`).join('');
  const rej=(meta.rejected??[]).map(r=>\`<tr class="rej"><td>\${r.time?.slice(11,16)??''} UTC</td><td>\${r.action?.type??''} 被拒</td><td>\${String(r.reason??'').replace(/[&<>]/g,'')}</td></tr>\`).join('');
  document.getElementById('notes').innerHTML=\`<table><thead><tr><th style="width:90px">时间</th><th style="width:220px">操作</th><th>理由 / 决策记录（点一行跳到该时刻）</th></tr></thead><tbody>\${rows||'<tr><td colspan=3>没有操作</td></tr>'}\${rej}</tbody></table>\`;
  for(const tr of document.querySelectorAll('#notes tr.d'))tr.onclick=()=>{const s=document.getElementById('scrub');s.value=String(Math.round(Number(tr.dataset.m)/(run.hours*60)*1000));s.dispatchEvent(new Event('input'));
    window.scrollTo({top:0,behavior:'smooth'});};
}
</script>`;
function playerPage(runs,title) {
  const payload=zlib.gzipSync(Buffer.from(JSON.stringify(runs)),{level:9}).toString('base64');
  const loader=`<script id="runs-gz" type="application/octet-stream">${payload}</script>
<script id="player-src" type="text/plain">${playerJs}</script>${playerExtra}
<script>
(async()=>{
  const b=Uint8Array.from(atob(document.getElementById('runs-gz').textContent.trim()),c=>c.charCodeAt(0));
  window.RUNS=JSON.parse(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
  const s=document.createElement('script');s.textContent=document.getElementById('player-src').textContent;document.body.appendChild(s);
  renderNotes();for(const id of ['run','units'])document.getElementById(id).addEventListener('change',()=>setTimeout(renderNotes,0));
})();
</script>`;
  return playerTpl.replace('<title>Sweet Sim 仿真演示</title>',`<title>${title}</title>`)
    .replace('<script>/*RUNS*/</script>',()=>'').replace('<script src="player.js"></script>',()=>loader);
}
const players={};
for(const e of experimentIds) {
  const xs=selected.filter(x=>x.t.experiment===e&&x.run).sort((a,b)=>a.t.task_id.localeCompare(b.t.task_id)||a.t.agent.localeCompare(b.t.agent)||a.t.repeat-b.t.repeat);
  if(!xs.length)continue;
  const html=playerPage(xs.map(x=>compactRun(x.run,x)),`${isReusedBaseline(e)?campaignScope.baseline_label:EXP_INFO[e]?.short??e} 轨迹回放`);
  writeIfChanged(path.join(OUT,playerFile(e)),Buffer.from(html));players[e]={file:playerFile(e),runs:xs.length};
}

// ---- 6. videos ----------------------------------------------------------------------------------
const pickBy=(xs,f)=>xs.reduce((best,x)=>best==null||f(x)>f(best)?x:best,null);
const sel=(e,agent)=>selected.filter(x=>x.t.experiment===e&&(agent==null||x.t.agent===agent));
const videoPlan=[];
const addVideo=(x,id,title,note)=>{if(x&&x.run&&!videoPlan.some(v=>v.id===id))videoPlan.push({id,title,note,trial:`${x.job.id}/${x.t.trial_id}`,experiment:x.t.experiment,x});};
{ // Exp 1: instance with the largest causal - wait gap; causal, wait, patient on it.
  const c=sel('exp1-full','causal'),w=new Map(sel('exp1-full','wait').map(x=>[x.t.task_id,x]));
  const best=pickBy(c.filter(x=>w.has(x.t.task_id)),x=>x.t.reward.reward-w.get(x.t.task_id).t.reward.reward);
  if(best) {
    const id=best.t.task_id;
    addVideo(best,`exp1-${id.replace('exp1-','')}-causal`,`实验 1 · ${id} · causal（因果最优）`,'同一环境上 causal 与 wait 的对比（causal − wait 差距最大的环境）');
    addVideo(w.get(id),`exp1-${id.replace('exp1-','')}-wait`,`实验 1 · ${id} · wait（不干预）`,'对照：什么都不做');
  }
}
{ // Exp 2: severe-hypo case (prefer causal), else the worst trial.
  const xs=sel('exp2-assisted'),sh=xs.filter(x=>x.t.reward.severe_hypo>0);
  const x=pickBy(sh.length?sh:xs,y=>(y.t.agent==='causal'?1:0)-y.t.reward.reward);
  if(x)addVideo(x,`exp2-${x.t.instance_id}-${AGENT_KEY(x.t.agent)}-${sh.length?'severe-hypo':'worst'}`,`实验 2 · ${x.t.task_id} · ${AGENT_LABEL(x.t.agent,'exp2-assisted')}${sh.length?' · 严重低血糖':''}`,
    sh.length?`辅助赛道上的严重低血糖回合（安全否决，S = 0${sh.length>1?`；共 ${sh.length} 个`:''}）`:`${AGENT_LABEL(x.t.agent,'exp2-assisted')} 在辅助赛道上分数最低的回合（S = ${x.t.reward.reward.toFixed(3)}）`);
  const w=x&&sel('exp2-assisted','wait').find(y=>y.t.task_id===x.t.task_id);
  if(w)addVideo(w,`exp2-${w.t.instance_id}-wait`,`实验 2 · ${w.t.task_id} · wait（患者自己管理）`,'同一环境只有患者自己管理');
}
{ // Exp 3: adaptive with the biggest late-vs-early improvement, and fixed on the same person.
  const xs=sel('exp3-longitudinal').filter(x=>/adaptive/.test(x.t.agent));
  const x=pickBy(xs,y=>(y.t.reward.day_6_reward+y.t.reward.day_7_reward)-(y.t.reward.day_1_reward+y.t.reward.day_2_reward));
  if(x) {
    addVideo(x,`exp3-${x.t.instance_id}-adaptive-${x.t.reward.days??7}d`,`实验 3 · ${x.t.instance_id} · adaptive · ${x.t.reward.days??7} 天`,'跨天记忆 + 每天 06:00 调档（SET_PROFILE）的 7 天连续回合');
    addVideo(sel('exp3-longitudinal','patient').find(y=>y.t.task_id===x.t.task_id),`exp3-${x.t.instance_id}-fixed-${x.t.reward.days??7}d`,`实验 3 · ${x.t.instance_id} · fixed · ${x.t.reward.days??7} 天`,'对照：同一人档案不变');
  }
}
{ // Exp 4: twin vs real pair with the largest |gap| for causal (else any agent).
  const xs=sel('exp4-real2sim2real');const by=groupBy(xs.filter(x=>x.t.pair_id),x=>`${x.t.pair_id}|${x.t.agent}`);
  let best=null;for(const [k,g] of by){const r=g.find(y=>y.t.role==='real'),t=g.find(y=>y.t.role==='twin');if(!r||!t)continue;
    const s=Math.abs(t.t.reward.reward-r.t.reward.reward)+(r.t.agent==='causal'?10:0);if(!best||s>best.s)best={s,r,t};}
  if(best) {
    const tag=`${best.r.t.pair_id}-${AGENT_KEY(best.r.t.agent)}`;
    addVideo(best.t,`${tag}-twin`,`实验 4 · ${best.r.t.pair_id} · ${AGENT_LABEL(best.r.t.agent)} · 孪生`,'同一未来日：孪生上的表现');
    addVideo(best.r,`${tag}-real`,`实验 4 · ${best.r.t.pair_id} · ${AGENT_LABEL(best.r.t.agent)} · "真实"`,'同一未来日：隐藏的"真实"个体上的表现');
  }
}
const vdir=path.join(OUT,'videos');fs.mkdirSync(vdir,{recursive:true});
const videoFile=id=>['mp4','webm'].map(e=>path.join(vdir,`${id}.${e}`)).find(f=>fs.existsSync(f))??null;
if(opt.videos) {
  const todo=videoPlan.filter(v=>opt.videos==='force'||!videoFile(v.id));
  if(todo.length) {
    const tmp=fs.mkdtempSync(path.join(process.env.TMPDIR??'/tmp','mvp-videos-'));
    const files=todo.map(v=>{const f=path.join(tmp,`${v.id}.src.json`);fs.writeFileSync(f,JSON.stringify({...compactRun(v.x.run,v.x),id:v.id}));return f;});
    console.error(`recording ${todo.length} videos (${opt['video-seconds']??50} s each, real time) into ${tmp}`);
    const r=spawnSync(process.execPath,[path.join(ROOT,'scripts','demo-video.mjs'),'--run',files.join(','),'--seconds',String(opt['video-seconds']??50),
      '--units','mmol','--kbps',String(opt['video-kbps']??1500),'--out',tmp],{stdio:['ignore','inherit','inherit'],cwd:ROOT});
    for(const v of todo)for(const ext of ['mp4','webm']){const f=path.join(tmp,`${v.id}.${ext}`);if(fs.existsSync(f))fs.copyFileSync(f,path.join(vdir,`${v.id}.${ext}`));}
    if(r.status!==0)console.error(`demo-video exited ${r.status}`);
  }
  // Videos of earlier picks (the selection changed, e.g. after a newer job replaced a baseline) are removed.
  for(const f of fs.readdirSync(vdir))if(/\.(mp4|webm)$/.test(f)&&!videoPlan.some(v=>f===`${v.id}.mp4`||f===`${v.id}.webm`)) {
    fs.rmSync(path.join(vdir,f));console.error(`removed stale video ${f}`);}
}
const videos=videoPlan.map(v=>{const f=videoFile(v.id);return {id:v.id,title:v.title,note:v.note,trial:v.trial,experiment:v.experiment,
  file:f?path.relative(OUT,f):null,bytes:f?fs.statSync(f).size:null,player:`${playerFile(v.experiment)}?id=${encodeURIComponent(v.x.t.trial_id)}`};});
writeIfChanged(path.join(vdir,'manifest.json'),Buffer.from(JSON.stringify(videos.map(({x,...v})=>v),null,1)+'\n'));

// ---- 7. index.html ------------------------------------------------------------------------------
const expRank=e=>EXP_ORDER.indexOf(e)+1||99;
const trialRows=[...selected].sort((a,b)=>expRank(a.t.experiment)-expRank(b.t.experiment)||a.t.task_id.localeCompare(b.t.task_id)||a.t.agent.localeCompare(b.t.agent)||a.t.repeat-b.t.repeat).map(x=>{const R=x.t.reward,f=x.task.factors??{};
  return {id:x.t.trial_id,e:x.t.experiment,task:x.t.task_id,inst:x.t.instance_id,agent:x.t.agent,label:AGENT_LABEL(x.t.agent,x.t.experiment),r:x.t.repeat,
    role:x.t.role,pair:x.t.pair_id,job:x.job.id,tier:x.task.tier??null,
    f:[f.observation_profile,f.mode??x.task.device,f.person_type,(f.event_packs??[]).join('+')].filter(Boolean).join(' · ')||(x.task.device??''),
    S:r4(R.reward),N:r4(R.normalized),tir:r4(R.tir),tbr70:r4(R.tbr70),tbr54:r4(R.tbr54),tar250:r4(R.tar250),mean:r4(R.mean_mgdl),sev:R.severe_hypo??0,hypo:R.hypo_events??null,
    steps:R.agent_steps??null,vw:R.verifier_wait_steps??null,ac:R.agent_completed??null,sec:x.t.seconds,days:R.days?Array.from({length:R.days},(_,i)=>r4(R[`day_${i+1}_reward`])):null,
    slope:r4(R.learning_slope)};});
const DATA={title:typeof opt.title==='string'?opt.title:'OpenDiabet MVP 结果',generated:new Date().toISOString(),scoring:jobs.find(j=>j.config.scoring)?.config.scoring??null,
  ...(campaignScope?{campaign_scope:campaignScope}:{}),
  scoring_display:scoringDisplay(jobs.find(j=>j.config.scoring)?.config.scoring),
  jobs:jobs.map(j=>({id:j.id,benchmark:j.config.benchmark,created:j.config.created,commit:j.config.sweet_sim_commit,agents:j.config.agents,
    trials:trials.filter(x=>x.job===j).length,selected:selected.filter(x=>x.job===j).length,agent_code_sha256:j.config.agent_code?.sha256??null})),
  experiments:experimentIds.map(e=>{const st=stats[e],xs=selected.filter(x=>x.t.experiment===e),def=xs[0]?.expDef??{};
    const ctx={tasks:st.tasks,repeats:Math.max(...xs.map(x=>x.t.repeat))+1,hours:Math.round(xs[0]?.task?.hours??24),
      days:def.horizon_days??Math.max(1,...xs.map(x=>x.t.reward.days??1)),
      persons:new Set(xs.map(x=>(/exp4-(p\d+)/.exec(x.t.task_id)??[])[1]).filter(Boolean)).size,pairs:st.pairs?.agents?.[0]?.pairs??0};
    const info=EXP_INFO[e]?{...EXP_INFO[e],setup:typeof EXP_INFO[e].setup==='function'?EXP_INFO[e].setup(ctx):EXP_INFO[e].setup}:{short:def.title??e};
    if(isReusedBaseline(e))Object.assign(info,{short:campaignScope.baseline_label,
      display_id:campaignScope.baseline_origin==='current'?'无干预对照':'复用对照',
      question:'同一个物理世界在没有模型干预时如何变化？',
      setup:(campaignScope.baseline_origin==='current'?`本轮同世界${campaignScope.worlds}条WAIT轨迹；`:`复用原${campaignScope.worlds}条WAIT轨迹；`)
        +'不是本轮 I0 模型实验。归档保留原始i0任务ID，以便追溯。'});
    return {...st,info,player:players[e]?.file??null};}).sort((a,b)=>Number(isReusedBaseline(a.id))-Number(isReusedBaseline(b.id))),
  cross,exp3:exp3InProcess,exp4:exp4InProcess,trials:trialRows,videos:videos.map(({x,...v})=>v)};
const indexHtml=fs.readFileSync(path.join(REPORT_ROOT,'scripts','mvp-report.template.html'),'utf8')
  .replace('/*DATA*/null',()=>JSON.stringify(DATA).replace(/</g,'\\u003c'));
writeIfChanged(path.join(OUT,'index.html'),Buffer.from(indexHtml));

// ---- 8. README, pruning, manifest ---------------------------------------------------------------
{
  const f3=v=>v==null?'–':Number(v).toFixed(3),pc=(v,d=1)=>v==null?'–':(100*v).toFixed(d)+'%',ciS=c=>c?.mean==null?'–':`${f3(c.mean)} [${f3(c.ci95[0])}, ${f3(c.ci95[1])}]`;
  const mmol=v=>v==null?'–':(v/18.016).toFixed(1);
  const L=[`# ${DATA.title}（${path.basename(OUT)}）`,'',
    `由 \`node scripts/mvp-report.mjs\` 生成于 ${DATA.generated}。打开 [index.html](index.html) 浏览（自包含，可离线；默认 mmol/L，可切换 mg/dL）。所有结果均为仿真，不是医疗建议。`,'',
    '## 内容','',
    '| 路径 | 说明 |','|---|---|',
    '| `index.html` | 四个实验的问题、设置、得分表（按任务聚类 bootstrap 95% CI）、实验 3 曲线、实验 4 孪生拟合与迁移、全部回合（点击进入回放） |',
    '| `players/<实验>.html` | 每个实验一个回放页面（scripts/video/player.js；运行记录 gzip+base64 内嵌），下方是操作 / 理由列表，点一行跳到该时刻；`?id=<trial>&units=mmol|mgdl` |',
    '| `trials.jsonl` | 所有作业的每个回合一行（含被取代的回合，`selected` 标记是否计入统计），奖励字段与路径 |',
    '| `archive/<job>/<trial>.json.gz` | 回合完整归档（sweet-sim.trial-archive/v1）：trial.json、reward / metrics / run.json、智能体日志（actions、decisions、transcript、memory、status）、bundle 路径 + sha256 |',
    '| `archive/bundles/` | 保留下来的 sidecar bundle（gzip），仅当作业保留了 bundle 且总量不超过上限 |',
    '| `archive/inputs/*.json.gz` | 作业配置与结果、基准清单 + 每个任务的 task.toml / public.json / instruction.md、实验 3 / 4 进程内输出、oracle 决策日志 |',
    '| `videos/` | 代表性视频（`--videos` 录制，1500 kbps，mmol/L）与 `videos/manifest.json` |',
    '| `manifest.json` | 数据来源、选择规则、每个归档文件的大小与 sha256 |','',
    '选择规则：每个 实验 × 智能体 取已跑完全部计划回合的最新作业（`config.created`；都没跑完时取完成回合最多的作业），每个 任务 × 重复 一个回合；正在运行的新作业跑完之前不会替换旧结果；旧作业的回合保留在 trials.jsonl / archive 中（selected=false）。新作业（例如 `mvp2-*`）出现后重新运行脚本即可自动替换。','',
    '## 作业','','| 作业 | 基准 | 创建 | commit | 回合 | 选中 |','|---|---|---|---|---|---|',
    ...DATA.jobs.map(j=>`| ${j.id} | ${j.benchmark} | ${(j.created??'').slice(0,16)} | \`${(j.commit??'').slice(0,10)}\` | ${j.trials} | ${j.selected} |`),''];
  for(const e of experimentIds) {
    const s=stats[e];
    L.push(`## ${EXP_INFO[e]?.short??e}`,'',EXP_INFO[e]?.question??'','',
      '| 智能体 | n | S [95% CI] | ΔS vs wait | TIR 3.9–10 | TBR<3.9 | TBR<3.0 | 平均 mmol/L | 严重低血糖 |','|---|---|---|---|---|---|---|---|---|',
      ...s.agents.map(a=>`| ${a.label} | ${a.n} | ${ciS(a.reward)} | ${a.delta_vs_wait?ciS(a.delta_vs_wait):'–'} | ${pc(a.tir)} | ${pc(a.tbr70,2)} | ${pc(a.tbr54,2)} | ${mmol(a.mean_mgdl)} | ${a.severe} |`),'');
    if(e==='exp2-assisted'&&cross.length)L.push('实验 2 − 实验 1（同一环境、同一智能体）：','',...cross.map(c=>`- ${c.label}: ${ciS(c.diff)}（n=${c.n}）`),'');
    if(s.pairs)L.push(`孪生 vs 真实：Kendall τ 平均 ${f3(s.pairs.kendall_mean)}，最佳一致率 ${pc(s.pairs.best_match_rate,0)}，平均遗憾 ${f3(s.pairs.regret_mean)}。`,'',
      '| 智能体 | 配对 | 真实 S | 孪生 S | 差距 孪生−真实 |','|---|---|---|---|---|',...s.pairs.agents.map(a=>`| ${a.label} | ${a.pairs} | ${ciS(a.real)} | ${ciS(a.twin)} | ${ciS(a.gap)} |`),'');
  }
  if(exp3InProcess){const S=exp3InProcess.summary;L.push(`## 实验 3 进程内结果（${exp3InProcess.source}）`,'','| 智能体 | 平均 S | 前 2 天 | 后 2 天 | 斜率 | 参数误差 起→终 |','|---|---|---|---|---|---|',
    ...exp3InProcess.agents.map(k=>`| ${k} | ${f3(S[k]?.reward_mean)} | ${f3(S[k]?.reward_days_1_2)} | ${f3(S[k]?.reward_last_2)} | ${f3(S[k]?.learning_slope)} | ${pc(S[k]?.param_error_first)} → ${pc(S[k]?.param_error_final)} |`),'');}
  L.push('## 视频','',...videos.map(v=>`- ${v.title}：${v.file?`[${v.file}](${v.file})`:'（尚未录制）'} · [回放](${v.player})`),'',
    '## 重新生成','','```bash','node scripts/mvp-report.mjs                       # 统计、页面、归档（幂等，只重写变化的文件）',
    'node scripts/mvp-report.mjs --videos              # 另外录制缺失的视频（headless Chrome，约 1 分钟/段）','```','');
  writeIfChanged(path.join(OUT,'README.md'),Buffer.from(L.join('\n')));
}
const pruned=[];
for(const sub of ['archive','players']){const walk=d=>{if(!fs.existsSync(d))return;for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
  if(e.isDirectory()){walk(p);if(!fs.readdirSync(p).length)fs.rmdirSync(p);}else if(!WRITTEN.has(path.resolve(p))){fs.rmSync(p);pruned.push(path.relative(OUT,p));}}};walk(path.join(OUT,sub));}
if(pruned.length)console.error(`pruned ${pruned.length} stale files (${pruned.slice(0,5).join(', ')}${pruned.length>5?', ...':''})`);
const sizes={total:dirSize(OUT),archive:dirSize(path.join(OUT,'archive')),players:dirSize(path.join(OUT,'players')),videos:dirSize(vdir),
  index:fs.statSync(path.join(OUT,'index.html')).size,trials_jsonl:fs.statSync(path.join(OUT,'trials.jsonl')).size};
const manifest={format:'sweet-sim.mvp-results/v1',generated:DATA.generated,generator:'scripts/mvp-report.mjs',
  sources:{jobs_dir:rel(JOBS_DIR),jobs:DATA.jobs,exp3_inprocess:exp3InProcess?.source??null,exp4_inprocess:exp4InProcess?.source??null,oracle:rel(oracleDir)},
  selection:explicitSelection?{policy:'explicit per-experiment/agent job selection; no fallback to superseded trials',jobs:explicitSelection}
    :'per experiment x agent: newest job (config.created) that finished all planned trials for it, else the job with the most finished trials; one trial per task x repeat',
  selected:Object.fromEntries(experimentIds.map(e=>[e,stats[e].agents.map(a=>({agent:a.agent,job:a.job,n:a.n,planned:a.planned}))])),
  trials:{total:trials.length,selected:selected.length,errors:trials.filter(x=>x.t.status==='error').map(x=>`${x.job.id}/${x.t.trial_id}`)},
  bundles:{found:bundleFiles.length,bytes:sum(bundleFiles.map(b=>b.size)),copied:includeBundles&&bundleFiles.length>0,
    copied_scope:copySelectedOnly?'selected trials only':'all trials',max_mb:maxBundleBytes/1e6,
    files:trials.flatMap(x=>(x.bundles??[]).map(b=>({trial:`${x.job.id}/${x.t.trial_id}`,selected:x.selected,...b}))),
    note:bundleFiles.length?null:'No bundle.json(.gz) in these jobs (older runners deleted the sidecar journal after each trial); verifier/run.json is the replayable record and is archived.'},
  sizes,videos:videos.map(({x,...v})=>v),archive:archiveIndex};
writeIfChanged(path.join(OUT,'manifest.json'),Buffer.from(JSON.stringify(manifest,null,1)+'\n'));
console.log(JSON.stringify({out:rel(OUT),jobs:jobs.length,trials:trials.length,selected:selected.length,archive_files_written:archiveWritten,
  experiments:Object.fromEntries(experimentIds.map(e=>[e,stats[e].agents.map(a=>`${a.agent}:${a.n}`).join(' ')])),
  videos:videos.map(v=>`${v.id}${v.file?'':' (missing)'}`),sizes_mb:Object.fromEntries(Object.entries(sizes).map(([k,v])=>[k,Number((v/1e6).toFixed(2))]))},null,1));
