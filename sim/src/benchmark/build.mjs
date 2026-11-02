// Unified benchmark builder (docs/BENCH.zh-CN.md §8, format sweet-sim.benchmark/v1).
// A benchmark = experiments x Harbor task directories + one manifest:
//
//   <outDir>/benchmark.json          manifest (§8.2)
//   <outDir>/tasks/<task_id>/        standard Harbor task (src/export/harbor.mjs exportHarborTask)
//
// Stable API (used by the experiment 1-4 builders):
//
//   buildBenchmark({name, version, title?, description?, outDir, weights?, experiments:[{
//     id, title?, track: 'full'|'assisted', repeats?: 1, agents?: [...], primary_metric?: 'reward',
//     curve_metric?: 'day_reward', horizon_days?, pairs?: [{pair_id?, real_task, twin_task}],
//     references?: false | true | ['wait','patient','oref0'],      // precompute baseline rewards per task
//     tasks: [{task_id, spec, hours?: 24, verifier?: 'episode'|'daily', factors?, metadata?: {
//       instance_id?, references?: {wait, patient, oref0, causal, omniscient}, role?: 'real'|'twin', pair_id?, ...}}]}]})
//   -> manifest (also written to <outDir>/benchmark.json)
//
// The experiment's track is applied to every task spec (self_care); task ids must be unique in
// the benchmark and already slug-safe ([a-z0-9._-]). For pairs, role/pair_id are filled into the
// [metadata] of both tasks. Repeats are not materialised as tasks: a runner sets the episode seed
// (spec.seed + r) when it starts the sidecar (SWEET_SIM_REPEAT), person.seed stays fixed.
//
// Several experiment builders share one benchmark directory: by default (clean: false) a build
// MERGES into an existing benchmark.json - experiments with the same id are replaced (their old
// task dirs removed), all other experiments and their tasks are kept. clean: true wipes tasks/ first.
// The manifest update is done under a lock file (<outDir>/.benchmark.lock) so concurrent builders
// do not lose each other's experiments.
import fs from 'node:fs';
import path from 'node:path';
import {exportHarborTask,snapshotInfo,taskBuildSpec,slug,SCORING_VERSION,VERIFIERS,DEFAULT_WEIGHTS} from '../export/harbor.mjs';
import {buildInstanceConfig} from '../sim/instance.mjs';
import {runPolicyEpisode} from '../bench/suite.mjs';
import {episodeMetrics,episodeScore,WEIGHTS_VERSION} from '../bench/score.mjs';
import {TRACKS,checkTrack} from '../bench/tracks.mjs';

export const BENCHMARK_FORMAT='sweet-sim.benchmark/v1';
export const BUILTIN_AGENTS=['wait','patient','oref0','causal','oracle'];
const DEFAULT_AGENTS={full:['wait','patient','oref0','causal','oracle'],assisted:['wait','oref0','causal','oracle']};

/**
 * Baseline rewards of a task spec on its own episode seed (repeat 0), computed in-process with
 * the bench baseline policies and the bench score: {wait, patient?, oref0}. The patient baseline is
 * not defined on the assisted track (it would bolus the announced meals twice).
 *
 * scoringVersion must be the one the task will declare: these numbers go into the task's
 * metadata.references and the verifier normalizes the agent's reward against them, so computing
 * them under the score.mjs default while the task declares another version would put the reward
 * and its normalization on two different scales.
 */
export function computeReferences(spec,{track='full',hours=24,policies=null,weights=DEFAULT_WEIGHTS,
  scoringVersion=SCORING_VERSION}={}) {
  const buildSpec=taskBuildSpec(spec,{track,horizonMinutes:Math.round(hours*60)}),out={};
  for(const p of policies??TRACKS[checkTrack(track)].baselines) {
    if(!TRACKS[track].baselines.includes(p))throw new Error(`reference ${p} is not defined on the ${track} track`);
    out[p]=episodeScore(episodeMetrics(runPolicyEpisode(buildSpec,p).exportBundle()),weights,{version:scoringVersion}).score;
  }
  return out;
}

function validate({name,experiments}) {
  if(!name||slug(name)!==name)throw new Error(`benchmark name must be slug-safe ([a-z0-9._-]): ${name}`);
  if(!Array.isArray(experiments)||!experiments.length)throw new Error('experiments required');
  const taskIds=new Set(),expIds=new Set();
  for(const e of experiments) {
    if(!e.id||slug(e.id)!==e.id)throw new Error(`experiment id must be slug-safe: ${e.id}`);
    if(expIds.has(e.id))throw new Error(`duplicate experiment id ${e.id}`);expIds.add(e.id);
    checkTrack(e.track);
    if(!Array.isArray(e.tasks)||!e.tasks.length)throw new Error(`experiment ${e.id}: tasks required`);
    for(const t of e.tasks) {
      if(!t.task_id||slug(t.task_id)!==t.task_id)throw new Error(`task_id must be slug-safe ([a-z0-9._-]): ${t.task_id}`);
      if(taskIds.has(t.task_id))throw new Error(`duplicate task_id ${t.task_id}`);taskIds.add(t.task_id);
      if(!t.spec||typeof t.spec!=='object')throw new Error(`task ${t.task_id}: spec required`);
      if(t.verifier&&!VERIFIERS.includes(t.verifier))throw new Error(`task ${t.task_id}: verifier must be one of ${VERIFIERS.join(', ')}`);
    }
    const own=new Set(e.tasks.map(t=>t.task_id));
    for(const p of e.pairs??[])for(const k of ['real_task','twin_task'])
      if(!own.has(p[k]))throw new Error(`experiment ${e.id}: pair ${k} ${p[k]} is not a task of this experiment`);
    if(e.repeats!==undefined&&!(Number.isInteger(e.repeats)&&e.repeats>=1))throw new Error(`experiment ${e.id}: repeats must be a positive integer`);
  }
}

/** Builds the benchmark directory; returns the manifest. See the header for the input format. */
export function buildBenchmark({name,version='0.1',title=null,description=null,experiments,outDir,weights={},snapshot=null,clean=false,onTask=null,
  scoringVersion=SCORING_VERSION}={}) {
  validate({name,experiments});
  outDir??=path.join('artifacts','benchmarks',name);
  const tasksDir=path.join(outDir,'tasks'),manifestFile=path.join(outDir,'benchmark.json');
  if(fs.existsSync(outDir)&&fs.readdirSync(outDir).filter(f=>!f.startsWith('.')).length&&!fs.existsSync(manifestFile))
    throw new Error(`${outDir} exists and is not a benchmark directory; refusing to overwrite`);
  const prior=!clean&&fs.existsSync(manifestFile)?JSON.parse(fs.readFileSync(manifestFile,'utf8')):null;
  if(prior&&prior.name!==name)throw new Error(`${outDir} holds benchmark ${prior.name}, not ${name}`);
  if(prior&&prior.scoring?.version!==scoringVersion)throw new Error(`Cannot merge scoring ${prior.scoring?.version} into ${scoringVersion}; use a separate benchmark directory`);
  if(clean&&fs.existsSync(tasksDir))fs.rmSync(tasksDir,{recursive:true,force:true});
  const rebuilt=new Set(experiments.map(e=>e.id));
  if(prior) {
    for(const t of experiments.flatMap(e=>e.tasks)) {
      const owner=prior.tasks?.[t.task_id]?.experiment;
      if(owner&&!rebuilt.has(owner))throw new Error(`task_id ${t.task_id} already belongs to experiment ${owner} in ${outDir}`);
    }
    for(const [id,t] of Object.entries(prior.tasks??{}))if(rebuilt.has(t.experiment))fs.rmSync(path.join(tasksDir,id),{recursive:true,force:true});
  }
  fs.mkdirSync(tasksDir,{recursive:true});
  const snap=snapshot??snapshotInfo(),w={...DEFAULT_WEIGHTS,...weights};
  const manifestExps=[],taskIndex={};let knowledge=null,kernel=null;
  for(const e of experiments) {
    const pairOf=new Map();
    (e.pairs??[]).forEach((p,i)=>{const id=p.pair_id??`pair-${i+1}`;pairOf.set(p.real_task,{pair_id:id,role:'real'});pairOf.set(p.twin_task,{pair_id:id,role:'twin'});});
    let maxHours=0;
    for(const t of e.tasks) {
      const hours=t.hours??(t.spec.horizon_minutes?t.spec.horizon_minutes/60:24);maxHours=Math.max(maxHours,hours);
      const md={...(t.metadata??{})};
      const refsWanted=e.references===true?null:Array.isArray(e.references)?e.references:undefined;
      if(refsWanted!==undefined&&!md.references)md.references=computeReferences(t.spec,{track:e.track,hours,policies:refsWanted,weights:w,scoringVersion});
      const pr=pairOf.get(t.task_id);if(pr){md.pair_id??=pr.pair_id;md.role??=pr.role;}
      const r=exportHarborTask(t.spec,{outDir:path.join(tasksDir,t.task_id),id:t.task_id,hours,track:e.track,verifier:t.verifier??'episode',
        weights:w,factors:t.factors??null,metadata:{experiment:e.id,instance_id:md.instance_id??t.task_id,...md},snapshot:snap,scoringExtra:t.scoring_extra??null,
        scoringVersion});
      knowledge??=r.metadata.knowledge_sha256;kernel??=r.metadata.kernel_sha256;
      taskIndex[t.task_id]={experiment:e.id,instance_id:r.metadata.instance_id,dir:`tasks/${t.task_id}`,name:r.name,hours,
        verifier:t.verifier??'episode',device:r.metadata.device,person_seed:r.metadata.person_seed??null,episode_seed:r.metadata.episode_seed,
        ...(md.role?{role:md.role}:{}),...(md.pair_id?{pair_id:md.pair_id}:{}),
        ...(r.metadata.references?{references:r.metadata.references}:{}),
        ...(t.factors?{factors:t.factors}:{})};
      onTask?.(t.task_id,r);
    }
    manifestExps.push({id:e.id,title:e.title??e.id,track:e.track,task_ids:e.tasks.map(t=>t.task_id),repeats:e.repeats??1,
      agents:e.agents??DEFAULT_AGENTS[e.track],primary_metric:e.primary_metric??(e.pairs?.length?'transfer_gap':'reward'),
      ...(e.curve_metric?{curve_metric:e.curve_metric}:{}),
      ...(e.horizon_days??(maxHours>24?maxHours/24:null)?{horizon_days:e.horizon_days??maxHours/24}:{}),
      ...(e.pairs?.length?{pairs:e.pairs.map((p,i)=>({pair_id:p.pair_id??`pair-${i+1}`,real_task:p.real_task,twin_task:p.twin_task}))}:{}),
      ...(e.description?{description:e.description}:{})});
  }
  const manifest={format:BENCHMARK_FORMAT,name,version,title,description,created:new Date().toISOString(),
    sweet_sim_commit:snap.git_commit,sweet_sim_git_dirty:snap.git_dirty,sweet_sim_snapshot_sha256:snap.sha256,
    knowledge_sha256:knowledge,kernel_sha256:kernel,
    scoring:{version:scoringVersion,weights:w,weights_version:WEIGHTS_VERSION,
      rule:scoringVersion==='METRICS-v0.3'
        ?'METRICS-v0.3: disjoint 4–8/2–4/<2/>12 mmol/L bins, CV>0.36 and |ROC|>2 mg/dL/min penalties; severe low <3 mmol/L >=15 min veto'
        :`${scoringVersion}: TIR 70–180 mg/dL with low/high glucose penalties and severe-hypo veto`},
    experiments:manifestExps,tasks:taskIndex};
  return withLock(path.join(outDir,'.benchmark.lock'),()=>{
    // Re-read under the lock: another builder may have added experiments meanwhile.
    const cur=!clean&&fs.existsSync(manifestFile)?JSON.parse(fs.readFileSync(manifestFile,'utf8')):null;
    if(cur) {
      const keepExps=cur.experiments.filter(e=>!rebuilt.has(e.id));
      manifest.experiments=[...keepExps,...manifestExps];
      manifest.tasks={...Object.fromEntries(Object.entries(cur.tasks??{}).filter(([,t])=>!rebuilt.has(t.experiment))),...taskIndex};
      manifest.title=title??cur.title??null;manifest.description=description??cur.description??null;
      manifest.version=version??cur.version;manifest.created=cur.created??manifest.created;manifest.updated=new Date().toISOString();
    }
    const tmp=`${manifestFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp,JSON.stringify(manifest,null,1)+'\n');fs.renameSync(tmp,manifestFile);
    return manifest;
  });
}

/** Runs fn while holding a lock directory (waits up to 60 s; a lock older than 10 min is stale). */
function withLock(lock,fn) {
  const deadline=Date.now()+60000;
  for(;;) {
    try{fs.mkdirSync(lock);break;}
    catch(e) {
      if(e.code!=='EEXIST')throw e;
      try{if(Date.now()-fs.statSync(lock).mtimeMs>600000){fs.rmSync(lock,{recursive:true,force:true});continue;}}catch{}
      if(Date.now()>deadline)throw new Error(`timed out waiting for ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
    }
  }
  try{return fn();}finally{fs.rmSync(lock,{recursive:true,force:true});}
}

/** Reads <dir>/benchmark.json (with dir attached). */
export function loadBenchmark(dir) {
  const file=path.join(dir,'benchmark.json');
  if(!fs.existsSync(file))throw new Error(`${file} not found (build the benchmark first)`);
  const m=JSON.parse(fs.readFileSync(file,'utf8'));
  if(m.format!==BENCHMARK_FORMAT)throw new Error(`${file}: unsupported format ${m.format}`);
  return {...m,dir:path.resolve(dir)};
}

/** Sanity helper for builders: the config a task spec becomes (track and horizon applied). */
export function taskConfig(spec,{track='full',hours=24}={}) {
  return buildInstanceConfig(taskBuildSpec(spec,{track,horizonMinutes:Math.round(hours*60)}));
}
