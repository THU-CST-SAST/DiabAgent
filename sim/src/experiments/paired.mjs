// Paired-variant experiments (docs/PLAN-v2.zh-CN.md 实验 1 / 实验 4): shared pieces of the builders
// (src/experiments/obs-scaling.mjs, src/experiments/backends.mjs), the in-process reference
// validation and the paired analysis (scripts/paired-analysis.mjs).
//
// Design. A paired experiment takes base environments of the frozen OpenDiabet v1 set
// (artifacts/benchmarks/opendiabet-v1/environments.jsonl) and turns each into one task per level of
// a ladder; the levels of one base share the person, the day (episode seed) and everything else
// except the factor under study. Every task carries factors/metadata {base_env, ladder, level,
// level_index}; the experiment entry of benchmark.json carries {ladder, levels, reference_level,
// expected_trend}. variants.jsonl next to benchmark.json lists every task spec.
//
// Validation (通用规则: validate the design with reference agents before running LLMs):
// runValidation plays wait / patient / oref0 / causal / omniscient in-process (worker threads,
// src/opendiabet/worker.mjs) on a subset of base environments and writes the results in the
// sweet-sim.benchmark job layout (<job>/<task>__<agent>__r0/trial.json + verifier/reward.json),
// so the same paired analysis reads LLM jobs (scripts/benchmark.mjs run) and validation jobs.
//
// Analysis (analyzePaired): per experiment x agent x level the mean of a metric over base
// environments (repeats averaged first) with a bootstrap 95% CI over base environments; paired
// differences to the reference level (CI + sign-flip permutation p); a monotonic-trend test per base
// environment (Spearman rho between level index and the metric, then mean rho with CI and a
// sign-flip permutation p over bases). Outputs plots-ready CSV, analysis.json, summary.md/html.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Rng} from '../core/rng.mjs';
import {TASK_IDS} from '../opendiabet/tasks.mjs';
import {readEnvironments} from '../opendiabet/benchmark.mjs';
import {runJobs} from '../opendiabet/references.mjs';
import {loadTrials} from '../benchmark/summarize.mjs';
import {loadBenchmark} from '../benchmark/build.mjs';

export const V1_ENVIRONMENTS='artifacts/benchmarks/opendiabet-v1/environments.jsonl';
export const specHash=spec=>createHash('sha256').update(JSON.stringify(spec)).digest('hex');
const writeJson=(f,d)=>{fs.mkdirSync(path.dirname(f),{recursive:true});const t=`${f}.tmp-${process.pid}`;fs.writeFileSync(t,JSON.stringify(d,null,1)+'\n');fs.renameSync(t,f);};
const readJson=f=>JSON.parse(fs.readFileSync(f,'utf8'));

// ---- base environments ------------------------------------------------------------------------

export const PUMP_BACKENDS=['pump_pct','pump_abs','pump_combo'];
/**
 * Stratified base selection from the v1 environments: per task (in task order, minus `excludeTasks`)
 * one pump environment (backend rotating pump_pct / pump_abs / pump_combo over tasks) and one pens
 * environment, with opposite settings (clean / randomized alternating over tasks). Every task
 * category and both families are covered; pump and pens are half each.
 */
export function selectBaseEnvs(envs,{excludeTasks=[],envIds=null}={}) {
  const byId=new Map(envs.map(e=>[e.env_id,e]));
  if(envIds) {
    return envIds.map(id=>{const e=byId.get(id);if(!e)throw new Error(`unknown base environment ${id}`);return e;});
  }
  const out=[];let k=0;
  for(const task of TASK_IDS) {
    if(excludeTasks.includes(task))continue;
    const pumpSetting=k%2?'randomized':'clean',pensSetting=k%2?'clean':'randomized';
    const pump=byId.get(`${task}-${PUMP_BACKENDS[k%3]}-${pumpSetting}-s1`),pens=byId.get(`${task}-pens-${pensSetting}-s1`);
    for(const e of [pump,pens])if(e)out.push(e);
    k++;
  }
  return out;
}
/** Evenly spaced subset of n base environments (keeps the pump / pens alternation and the task spread). */
export function subsetBases(bases,n) {
  if(!n||n>=bases.length)return [...bases];
  return Array.from({length:n},(_,i)=>bases[Math.floor(i*bases.length/n)]);
}
export const loadV1Environments=(file=V1_ENVIRONMENTS)=>readEnvironments(file);
export const baseInfo=e=>({env_id:e.env_id,task:e.task,category:e.category,backend:e.backend,family:e.family,setting:e.setting,
  person_type:e.factors.person_type,seed:e.seed,spec_sha256:specHash(e.spec)});

// ---- building ---------------------------------------------------------------------------------

/** Harbor task id of a variant: <experiment>-<base env, lower case>-<level>. */
export const variantTaskId=(experiment,envId,level)=>`${experiment}-${envId.toLowerCase()}-${String(level).toLowerCase()}`;

/**
 * Writes variants.jsonl / base-environments.jsonl and the paired-design fields into an already
 * built benchmark.json (experiments[].ladder/levels/reference_level/expected_trend, top-level
 * `paired` block). experiments: the builder's experiment entries (with .design and .tasks[].variant).
 */
export function writePairedFiles(outDir,{experiments,bases,block}) {
  const lines=[];
  for(const e of experiments)for(const t of e.tasks)lines.push(JSON.stringify({task_id:t.task_id,experiment:e.id,...t.variant,spec:t.spec,spec_sha256:specHash(t.spec)}));
  // Merge with variants of experiments built earlier into the same directory (other ladders).
  const vf=path.join(outDir,'variants.jsonl'),rebuilt=new Set(experiments.map(e=>e.id));
  const prior=fs.existsSync(vf)?fs.readFileSync(vf,'utf8').split('\n').filter(l=>l.trim()&&!rebuilt.has(JSON.parse(l).experiment)):[];
  fs.writeFileSync(vf,[...prior,...lines].join('\n')+'\n');
  const bf=path.join(outDir,'base-environments.jsonl');
  const priorBases=fs.existsSync(bf)?fs.readFileSync(bf,'utf8').split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l)):[];
  const allBases=new Map(priorBases.map(b=>[b.env_id,b]));for(const b of bases)allBases.set(b.env_id,baseInfo(b));
  fs.writeFileSync(bf,[...allBases.values()].map(b=>JSON.stringify(b)).join('\n')+'\n');
  const file=path.join(outDir,'benchmark.json'),m=readJson(file);
  for(const e of experiments) {
    const me=m.experiments.find(x=>x.id===e.id);if(!me)continue;
    Object.assign(me,{ladder:e.design.ladder,factor:e.design.factor,levels:e.design.levels,reference_level:e.design.reference_level,
      expected_trend:e.design.expected_trend??null,base_envs:bases.map(b=>b.env_id),...(e.design.notes?{design_notes:e.design.notes}:{}),
      ...(e.design.shared_layer?{shared_layer:e.design.shared_layer}:{}),...(e.design.shared_overrides?{shared_overrides:e.design.shared_overrides}:{})});
  }
  // buildBenchmark rewrites the manifest without unknown top-level keys, so the ladder index is
  // rebuilt from every paired experiment in the manifest (earlier builds keep their entries).
  const ladders=Object.fromEntries(m.experiments.filter(e=>e.ladder).map(e=>[e.id,{ladder:e.ladder,factor:e.factor,levels:e.levels.map(l=>l.level),
    reference_level:e.reference_level,expected_trend:e.expected_trend??null,...(e.shared_layer?{shared_layer:e.shared_layer.name}:{})}]));
  m.paired={...(m.paired??{}),...block,ladders,variants_file:'variants.jsonl',base_environments_file:'base-environments.jsonl'};
  writeJson(file,m);
  return m;
}

/** Common metadata / factors of a variant task. */
export function variantFields(base,{ladder,level,levelIndex,levelValue,extraFactors={},extraMetadata={}}) {
  const variant={base_env:base.env_id,ladder,level,level_index:levelIndex,level_value:levelValue};
  return {variant,
    factors:{...base.factors,...extraFactors,base_env:base.env_id,ladder,level,level_index:levelIndex,env_id:base.env_id},
    metadata:{env_id:base.env_id,base_env:base.env_id,ladder,level,level_index:levelIndex,level_value:typeof levelValue==='object'?JSON.stringify(levelValue):levelValue,
      task:base.task,task_category:base.category,base_backend:base.backend,setting:base.setting,title_en:base.title?.en??null,title_zh:base.title?.zh??null,...extraMetadata}};
}

// ---- in-process reference validation ---------------------------------------------------------

export const VALIDATION_AGENTS=['wait','patient','oref0','causal','omniscient'];
const trialIdOf=(taskId,agent,repeat=0)=>`${taskId}__${agent}__r${repeat}`;

/** Variants of a benchmark directory (variants.jsonl). */
export function loadVariants(benchDir) {
  const f=path.join(benchDir,'variants.jsonl');
  if(!fs.existsSync(f))throw new Error(`${f} not found (build the benchmark first)`);
  return fs.readFileSync(f,'utf8').split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l));
}

/**
 * Plays reference agents on the variants of `experiments` whose base env is in `bases` (ids) and
 * writes trials in the job layout under jobDir. Resumes: trials already done for the same spec
 * are skipped. agents: subset of VALIDATION_AGENTS (patient only on the full track, which all
 * paired experiments use). causalOptions default {fast: true}.
 */
export async function runValidation({benchDir,jobDir,experiments=null,bases=null,agents=['wait','patient','causal'],parallel=3,
  causalOptions={fast:true},omniscientOptions={},onProgress=null,log=()=>{}}) {
  const m=loadBenchmark(benchDir),variants=loadVariants(benchDir);
  for(const a of agents)if(!VALIDATION_AGENTS.includes(a))throw new Error(`unknown validation agent ${a} (one of ${VALIDATION_AGENTS.join(', ')})`);
  const pick=variants.filter(v=>(!experiments||experiments.includes(v.experiment))&&(!bases||bases.includes(v.base_env)));
  fs.mkdirSync(jobDir,{recursive:true});
  const cfgFile=path.join(jobDir,'config.json');
  if(!fs.existsSync(cfgFile))writeJson(cfgFile,{format:'sweet-sim.benchmark-job/v1',job_id:path.basename(jobDir),benchmark:m.name,benchmark_version:m.version,
    benchmark_dir:m.dir,runner:'in-process reference validation (src/experiments/paired.mjs runValidation)',agents,
    options:{causal:causalOptions,omniscient:{fast:true,...omniscientOptions}},created:new Date().toISOString()});
  const jobs=[];let skipped=0;
  for(const v of pick)for(const agent of agents) {
    const dir=path.join(jobDir,trialIdOf(v.task_id,agent));
    try{const t=readJson(path.join(dir,'trial.json'));if(t.status==='done'&&t.spec_sha256===v.spec_sha256&&fs.existsSync(path.join(dir,'verifier','reward.json'))){skipped++;continue;}}catch{}
    jobs.push({v,agent,dir,job:{env_id:v.task_id,spec:v.spec,spec_sha256:v.spec_sha256,track:m.tasks[v.task_id]?.track??'full',policy:agent,repeat:0,
      options:{causal:causalOptions,omniscient:omniscientOptions}}});
  }
  const cost=j=>j.agent==='omniscient'?4:j.agent==='causal'?2:1;
  jobs.sort((a,b)=>cost(b)-cost(a));
  log(`validation: ${jobs.length} episodes to run, ${skipped} already done`);
  const t0=performance.now();let done=0;
  await runJobs(jobs.map(j=>j.job),{parallel,onResult:(r,i)=>{
    const {v,agent,dir}=jobs[i],me=m.experiments.find(e=>e.id===v.experiment);
    const reward={reward:r.score,raw_reward:r.raw_score,tir:r.tir,tbr70:r.tbr70,tbr54:r.tbr54,tar250:r.tar250,mean_mgdl:r.mean_mgdl,
      severe_hypo:r.safety_fail?1:0,completed:1,agent_completed:1,agent_steps:r.steps};
    fs.mkdirSync(path.join(dir,'verifier'),{recursive:true});
    writeJson(path.join(dir,'verifier','reward.json'),reward);
    writeJson(path.join(dir,'trial.json'),{format:'sweet-sim.trial/v1',trial_id:trialIdOf(v.task_id,agent),task_id:v.task_id,experiment:v.experiment,
      track:me?.track??'full',instance_id:v.task_id,agent,repeat:0,episode_seed:r.seed,person_seed:r.person_seed,status:'done',error:null,reward,
      base_env:v.base_env,ladder:v.ladder,level:v.level,level_index:v.level_index,spec_sha256:v.spec_sha256,seconds:r.seconds,
      runner:'in-process',policy_options:agent==='causal'?causalOptions:agent==='omniscient'?{fast:true,...omniscientOptions}:null,finished:r.finished});
    done++;onProgress?.({done,total:jobs.length,agent,task_id:v.task_id,score:r.score,seconds:(performance.now()-t0)/1000});
  }});
  return {run:jobs.length,skipped};
}

// ---- paired analysis --------------------------------------------------------------------------

export const ANALYSIS_METRICS=['reward','tir','tbr70','tbr54','tar250','severe_hypo'];
const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
const r4=v=>v==null||!Number.isFinite(v)?null:Number(v.toFixed(4));

/** Average ranks (ties share the mean rank). */
function ranks(xs) {
  const idx=xs.map((v,i)=>[v,i]).sort((a,b)=>a[0]-b[0]),r=new Array(xs.length);
  for(let i=0;i<idx.length;) {let j=i;while(j+1<idx.length&&idx[j+1][0]===idx[i][0])j++;for(let k=i;k<=j;k++)r[idx[k][1]]=(i+j)/2+1;i=j+1;}
  return r;
}
/** Spearman rank correlation; 0 when either variable is constant (no trend). */
export function spearman(x,y) {
  if(x.length<2)return null;
  const rx=ranks(x),ry=ranks(y),mx=mean(rx),my=mean(ry);
  let sxy=0,sxx=0,syy=0;for(let i=0;i<x.length;i++){sxy+=(rx[i]-mx)*(ry[i]-my);sxx+=(rx[i]-mx)**2;syy+=(ry[i]-my)**2;}
  return sxx&&syy?sxy/Math.sqrt(sxx*syy):0;
}
/** Bootstrap 95% CI of the mean of xs (resampling the elements, i.e. base environments). */
export function bootstrapCI(xs,{B=2000,seed=1,label='paired'}={}) {
  const v=xs.filter(Number.isFinite),n=v.length;
  if(!n)return {mean:null,ci95:[null,null],n:0};
  const m=mean(v);if(n===1)return {mean:m,ci95:[m,m],n};
  const rng=Rng.stream(seed,label),stats=new Float64Array(B);
  for(let b=0;b<B;b++){let s=0;for(let i=0;i<n;i++)s+=v[Math.floor(rng.next()*n)];stats[b]=s/n;}
  stats.sort();const q=p=>stats[Math.min(B-1,Math.max(0,Math.round(p*(B-1))))];
  return {mean:m,ci95:[q(0.025),q(0.975)],n};
}
/** Two-sided sign-flip permutation p-value for mean(xs) = 0 (exact up to 16 values, else Monte Carlo). */
export function signFlipP(xs,{R=20000,seed=1}={}) {
  const v=xs.filter(Number.isFinite),n=v.length;
  if(!n)return null;
  const obs=Math.abs(v.reduce((a,b)=>a+b,0))-1e-12;
  if(obs<=0)return 1;
  let hit=0,total=0;
  if(n<=16){for(let mask=0;mask<1<<n;mask++){let s=0;for(let i=0;i<n;i++)s+=mask>>i&1?-v[i]:v[i];if(Math.abs(s)>=obs)hit++;total++;}}
  else {const rng=Rng.stream(seed,'signflip');for(let r=0;r<R;r++){let s=0;for(let i=0;i<n;i++)s+=rng.next()<0.5?-v[i]:v[i];if(Math.abs(s)>=obs)hit++;}total=R;hit++;total++;}
  return hit/total;
}

/**
 * Rows of jobs: one per trial (state done unless includeFailed), joined with the benchmark manifest
 * (base_env, ladder, level, level_index from the task's factors). Returns {rows, manifests}.
 */
export function loadPairedRows(jobDirs,{benchDir=null,includeFailed=false}={}) {
  const rows=[],manifests=new Map();
  for(const jobDir of [].concat(jobDirs)) {
    const cfg=fs.existsSync(path.join(jobDir,'config.json'))?readJson(path.join(jobDir,'config.json')):{};
    const bdir=benchDir??cfg.benchmark_dir;if(!bdir)throw new Error(`${jobDir}: no benchmark_dir in config.json; pass --bench`);
    if(!manifests.has(bdir))manifests.set(bdir,loadBenchmark(bdir));
    const m=manifests.get(bdir);
    for(const t of loadTrials(jobDir)) {
      if(t.state!=='done'&&!(includeFailed&&t.state==='agent_failed'))continue;
      const task=m.tasks[t.task_id],f=task?.factors;if(!f?.base_env)continue;
      const rw=t.reward??(fs.existsSync(path.join(jobDir,t.trial_id,'verifier','reward.json'))?readJson(path.join(jobDir,t.trial_id,'verifier','reward.json')):null);
      if(!rw)continue;
      rows.push({job:path.basename(jobDir),benchmark:m.name,experiment:task.experiment,agent:t.agent,task_id:t.task_id,repeat:t.repeat??0,
        base_env:f.base_env,ladder:f.ladder,level:f.level,level_index:f.level_index,state:t.state,
        ...Object.fromEntries(ANALYSIS_METRICS.map(k=>[k,Number.isFinite(rw[k])?rw[k]:null]))});
    }
  }
  return {rows,manifests:[...manifests.values()]};
}

/**
 * Paired analysis of rows (loadPairedRows). manifests give the experiment designs (levels,
 * reference_level, expected_trend). Returns {experiments: [{id, ladder, agents: [{agent, levels,
 * diffs, trend}]}]}; metric = primary metric for diffs and trend (all metrics in level stats).
 */
export function analyzePaired(rows,{manifests=[],metric='reward',B=2000}={}) {
  const designs=new Map();for(const m of manifests)for(const e of m.experiments)designs.set(e.id,e);
  const byExp=new Map();for(const r of rows){if(!byExp.has(r.experiment))byExp.set(r.experiment,[]);byExp.get(r.experiment).push(r);}
  const out=[];
  for(const [exp,rs] of [...byExp.entries()].sort()) {
    const d=designs.get(exp)??{};
    const levelOrder=[...new Map(rs.map(r=>[r.level,r.level_index])).entries()].sort((a,b)=>a[1]-b[1]);
    const ref=d.reference_level??levelOrder[0]?.[0];
    const agents=[];
    for(const agent of [...new Set(rs.map(r=>r.agent))].sort()) {
      const ar=rs.filter(r=>r.agent===agent);
      // per base x level: mean over repeats
      const cell=new Map();
      for(const r of ar){const k=`${r.base_env}\t${r.level}`;if(!cell.has(k))cell.set(k,[]);cell.get(k).push(r);}
      const val=(base,level,k)=>{const c=cell.get(`${base}\t${level}`);if(!c)return null;const v=c.map(r=>r[k]).filter(Number.isFinite);return v.length?mean(v):null;};
      const bases=[...new Set(ar.map(r=>r.base_env))].sort();
      const levels=levelOrder.map(([level,li])=>{
        const st={level,level_index:li,n_bases:0,repeats:ar.filter(r=>r.level===level).length};
        for(const k of ANALYSIS_METRICS){const b=bootstrapCI(bases.map(x=>val(x,level,k)).filter(v=>v!=null),{B,label:`${exp}:${agent}:${level}:${k}`});
          st[k]={mean:r4(b.mean),ci95:b.ci95.map(r4)};if(k===metric)st.n_bases=b.n;}
        return st;
      });
      const diffs=levelOrder.filter(([l])=>l!==ref).map(([level,li])=>{
        const ds=bases.map(x=>{const a=val(x,level,metric),b=val(x,ref,metric);return a!=null&&b!=null?a-b:null;}).filter(v=>v!=null);
        const b=bootstrapCI(ds,{B,label:`${exp}:${agent}:${level}-${ref}`});
        return {level,level_index:li,reference:ref,metric,n_bases:ds.length,mean_diff:r4(b.mean),ci95:b.ci95.map(r4),p_signflip:r4(signFlipP(ds)),
          better:ds.filter(x=>x>1e-9).length,worse:ds.filter(x=>x<-1e-9).length,ties:ds.filter(x=>Math.abs(x)<=1e-9).length};
      });
      const rhos=[];
      for(const x of bases){const pts=levelOrder.map(([l,li])=>[li,val(x,l,metric)]).filter(p=>p[1]!=null);if(pts.length>=3)rhos.push(spearman(pts.map(p=>p[0]),pts.map(p=>p[1])));}
      const rb=bootstrapCI(rhos,{B,label:`${exp}:${agent}:rho`}),p=signFlipP(rhos),exp_=d.expected_trend??null;
      const first=levels[0]?.[metric]?.mean,last=levels.at(-1)?.[metric]?.mean;
      const verdict=!rhos.length?'n/a':exp_==null?(p!=null&&p<0.05?'trend':'no_trend')
        :p!=null&&p<0.05?(Math.sign(rb.mean)===Math.sign(exp_)?'expected':'reversed'):'no_effect';
      agents.push({agent,bases:bases.length,levels,diffs,trend:{metric,n_bases:rhos.length,mean_rho:r4(rb.mean),ci95:rb.ci95.map(r4),p_signflip:r4(p),
        positive:rhos.filter(r=>r>0).length,negative:rhos.filter(r=>r<0).length,zero:rhos.filter(r=>r===0).length,
        expected_sign:exp_,first_to_last:first!=null&&last!=null?r4(last-first):null,verdict}});
    }
    out.push({id:exp,ladder:d.ladder??null,factor:d.factor??null,reference_level:ref,expected_trend:d.expected_trend??null,
      levels:levelOrder.map(([l,i])=>({level:l,level_index:i,label:(d.levels??[]).find(x=>x.level===l)?.label??null})),agents});
  }
  return {format:'sweet-sim.paired-analysis/v1',metric,bootstrap:{B,unit:'base environment'},experiments:out};
}

const csvCell=v=>v==null?'':typeof v==='string'&&/[",\n]/.test(v)?`"${v.replace(/"/g,'""')}"`:String(v);
const csv=(header,rows)=>[header.join(','),...rows.map(r=>header.map(h=>csvCell(r[h])).join(','))].join('\n')+'\n';

/** Writes levels.csv, diffs.csv, trends.csv, per_base.csv, analysis.json, summary.md, summary.html. */
export function writeAnalysis(outDir,analysis,rows) {
  fs.mkdirSync(outDir,{recursive:true});
  const L=[],D=[],T=[];
  for(const e of analysis.experiments)for(const a of e.agents) {
    for(const l of a.levels){const r={experiment:e.id,ladder:e.ladder,agent:a.agent,level:l.level,level_index:l.level_index,n_bases:l.n_bases,repeats:l.repeats};
      for(const k of ANALYSIS_METRICS){r[k]=l[k].mean;r[`${k}_lo`]=l[k].ci95[0];r[`${k}_hi`]=l[k].ci95[1];}L.push(r);}
    for(const d of a.diffs)D.push({experiment:e.id,agent:a.agent,level:d.level,level_index:d.level_index,reference:d.reference,metric:d.metric,n_bases:d.n_bases,
      mean_diff:d.mean_diff,lo:d.ci95[0],hi:d.ci95[1],p_signflip:d.p_signflip,better:d.better,worse:d.worse,ties:d.ties});
    T.push({experiment:e.id,agent:a.agent,metric:a.trend.metric,n_bases:a.trend.n_bases,mean_rho:a.trend.mean_rho,lo:a.trend.ci95[0],hi:a.trend.ci95[1],
      p_signflip:a.trend.p_signflip,positive:a.trend.positive,negative:a.trend.negative,zero:a.trend.zero,expected_sign:a.trend.expected_sign,
      first_to_last:a.trend.first_to_last,verdict:a.trend.verdict});
  }
  const lh=['experiment','ladder','agent','level','level_index','n_bases','repeats',...ANALYSIS_METRICS.flatMap(k=>[k,`${k}_lo`,`${k}_hi`])];
  fs.writeFileSync(path.join(outDir,'levels.csv'),csv(lh,L));
  fs.writeFileSync(path.join(outDir,'diffs.csv'),csv(['experiment','agent','level','level_index','reference','metric','n_bases','mean_diff','lo','hi','p_signflip','better','worse','ties'],D));
  fs.writeFileSync(path.join(outDir,'trends.csv'),csv(['experiment','agent','metric','n_bases','mean_rho','lo','hi','p_signflip','positive','negative','zero','expected_sign','first_to_last','verdict'],T));
  fs.writeFileSync(path.join(outDir,'per_base.csv'),csv(['job','experiment','agent','base_env','level','level_index','repeat','task_id',...ANALYSIS_METRICS],
    [...rows].sort((a,b)=>a.experiment.localeCompare(b.experiment)||a.agent.localeCompare(b.agent)||a.base_env.localeCompare(b.base_env)||a.level_index-b.level_index||a.repeat-b.repeat)));
  writeJson(path.join(outDir,'analysis.json'),analysis);
  const md=summaryMarkdown(analysis);
  fs.writeFileSync(path.join(outDir,'summary.md'),md);
  fs.writeFileSync(path.join(outDir,'summary.html'),summaryHtml(analysis));
  return {levels:L.length,diffs:D.length,trends:T.length};
}

const f3=v=>v==null?'–':v.toFixed(3);
const ci=c=>c?.[0]==null?'':` [${f3(c[0])}, ${f3(c[1])}]`;
/** Markdown summary: per experiment a level x agent table of the metric and the trend verdicts. */
export function summaryMarkdown(an) {
  const out=[`# Paired analysis (${an.metric}; mean over base environments, bootstrap 95% CI)`,''];
  for(const e of an.experiments) {
    out.push(`## ${e.id}${e.factor?` — ${e.factor}`:''}`,'',`Reference level: \`${e.reference_level}\`; expected trend over level order: ${e.expected_trend==null?'none (categorical)':e.expected_trend>0?'increasing':'decreasing'}.`,'');
    const agents=e.agents.map(a=>a.agent);
    out.push(`| level | ${agents.join(' | ')} |`,`|---|${agents.map(()=>'---').join('|')}|`);
    for(const l of e.levels)out.push(`| ${l.level}${l.label?` (${l.label})`:''} | ${e.agents.map(a=>{const s=a.levels.find(x=>x.level===l.level);const d=a.diffs.find(x=>x.level===l.level);
      return s?`${f3(s[an.metric].mean)}${ci(s[an.metric].ci95)}${d?` Δ${d.mean_diff>=0?'+':''}${f3(d.mean_diff)}${d.p_signflip!=null&&d.p_signflip<0.05?'*':''}`:''} (n=${s.n_bases})`:'–';}).join(' | ')} |`);
    out.push('',`| agent | mean Spearman ρ | 95% CI | p (sign-flip) | +/−/0 bases | first→last | verdict |`,'|---|---|---|---|---|---|---|');
    for(const a of e.agents){const t=a.trend;out.push(`| ${a.agent} | ${f3(t.mean_rho)} | ${ci(t.ci95).trim()} | ${t.p_signflip??'–'} | ${t.positive}/${t.negative}/${t.zero} | ${t.first_to_last==null?'–':(t.first_to_last>=0?'+':'')+f3(t.first_to_last)} | ${t.verdict} |`);}
    out.push('');
  }
  out.push('Δ = paired difference to the reference level (* p < 0.05, sign-flip permutation over base environments). Verdict: expected / reversed = significant mean ρ with / against the expected sign; no_effect = not significant; trend / no_trend for categorical ladders.','');
  return out.join('\n');
}
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
export function summaryHtml(an) {
  const md=summaryMarkdown(an).split('\n');
  // Minimal Markdown -> HTML (headings, tables, paragraphs) for the summary only.
  const html=[];let table=null;
  const flush=()=>{if(table){html.push(`<table>${table.map((r,i)=>`<tr>${r.map(c=>i?`<td>${esc(c)}</td>`:`<th>${esc(c)}</th>`).join('')}</tr>`).join('')}</table>`);table=null;}};
  for(const line of md) {
    if(line.startsWith('|')){const cells=line.slice(1,-1).split('|').map(s=>s.trim());if(cells.every(c=>/^-+$/.test(c)))continue;(table??=[]).push(cells);continue;}
    flush();
    if(line.startsWith('## '))html.push(`<h2>${esc(line.slice(3))}</h2>`);else if(line.startsWith('# '))html.push(`<h1>${esc(line.slice(2))}</h1>`);
    else if(line.trim())html.push(`<p>${esc(line).replace(/`([^`]+)`/g,'<code>$1</code>')}</p>`);
  }
  flush();
  return `<!doctype html><meta charset="utf-8"><title>Paired analysis</title><style>body{font:14px system-ui,sans-serif;margin:2em;max-width:1200px}
table{border-collapse:collapse;margin:.5em 0}td,th{border:1px solid #ccc;padding:3px 8px;text-align:left;font-variant-numeric:tabular-nums}th{background:#f4f4f4}</style>
${html.join('\n')}\n`;
}
