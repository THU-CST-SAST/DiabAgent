// OpenDiabet references (docs/OPENDIABET-V1.zh-CN.md §2): every environment is played in-process by
// wait, patient (full track only), oref0, the causal-optimal decider and the omniscient decider
// (fast settings) on its repeat-0 seed, and scored with the bench score. Results are cached per
// (track, environment, policy) under cacheDir/<track>/<env_id>/<policy>/ (result.json; bundle, run
// record and decision log for causal / omniscient), keyed by the spec hash, so runs resume.
//
// Degenerate environments (full track: wait >= 0.98, or the best reference <= 0.02) are re-drawn
// with the next attempt (new seed; same task, backend, setting, person type and pen pair) up to
// maxRounds times; every re-draw is recorded. The cheap baselines screen first, then the expensive
// deciders run once on the final set (and a last screen on all references).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {REFERENCE_POLICIES,CHEAP_POLICIES,SCORING_VERSION} from './episodes.mjs';
import {runAnyJob} from './worker.mjs';
import {generateEnvironment,inspectEnvironment} from './generate.mjs';

export const specHash=spec=>createHash('sha256').update(JSON.stringify(spec)).digest('hex');
export const defaultParallel=()=>Math.max(1,(os.availableParallelism?.()??os.cpus().length)-1);
export const DEGENERATE={wait_at_least:0.98,best_at_most:0.02};

/** Runs jobs on worker threads (inline when parallel <= 1); results in job order. */
export async function runJobs(jobs,{parallel=defaultParallel(),onResult}={}) {
  const results=new Array(jobs.length);
  if(!jobs.length)return results;
  if(parallel<=1){jobs.forEach((j,i)=>{results[i]=runAnyJob(j);onResult?.(results[i],i);});return results;}
  let next=0,done=0;
  await new Promise((resolve,reject)=>{
    const workers=[],finish=e=>{for(const w of workers)w.terminate();e?reject(e):resolve();};
    for(let k=0;k<Math.min(parallel,jobs.length);k++) {
      const w=new Worker(new URL('./worker.mjs',import.meta.url),{workerData:{role:'opendiabet-worker'}});workers.push(w);
      const feed=()=>{if(next<jobs.length){const i=next++;w.postMessage({i,job:jobs[i]});}};
      w.on('message',m=>{
        if(m.error)return finish(new Error(`job ${jobs[m.i].env_id??jobs[m.i].env?.env_id??`${jobs[m.i].task}-${jobs[m.i].backend}-${jobs[m.i].setting}`}/${jobs[m.i].track}/${jobs[m.i].policy??jobs[m.i].label??jobs[m.i].kind} failed: ${m.error}`));
        results[m.i]=m.result;onResult?.(m.result,m.i);
        if(++done===jobs.length)finish();else feed();
      });
      w.on('error',finish);feed();
    }
  });
  return results;
}

const readJson=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const cacheDirOf=(cacheDir,track,envId,policy,repeat=0)=>path.join(cacheDir,track,envId,repeat?`${policy}-r${repeat}`:policy);
/**
 * Cached result of an episode if it was computed for this exact spec AND scored the same way.
 * The scoring version matters as much as the spec: the same trajectory scores very differently
 * under bench-v0.2 and METRICS-v0.3 (src/opendiabet/episodes.mjs SCORING_VERSION), so a cache that
 * only checked the spec would silently mix the two within one references.json. Results written
 * before the field existed were produced by the then-only version, bench-v0.2.
 */
export function cached(cacheDir,track,env,policy,repeat=0,scoringVersion=SCORING_VERSION) {
  const f=path.join(cacheDirOf(cacheDir,track,env.env_id,policy,repeat),'result.json');
  if(!fs.existsSync(f))return null;
  try {
    const r=readJson(f);
    return r.spec_sha256===specHash(env.spec)&&(r.scoring_version??'bench-v0.2')===scoringVersion?r:null;
  } catch{return null;}
}

/** Runs (or reads from cache) the given policies for envs x tracks; returns {[track]: {[env_id]: {[policy]: result}}}. */
export async function scoreEnvironments(envs,{tracks=['full'],policies=null,cacheDir,parallel,onProgress,keep=['causal','omniscient']}={}) {
  const out={},jobs=[];
  for(const track of tracks)for(const env of envs)for(const p of policies?.filter(x=>REFERENCE_POLICIES[track].includes(x))??REFERENCE_POLICIES[track]) {
    ((out[track]??={})[env.env_id]??={});
    const c=cached(cacheDir,track,env,p);
    if(c){out[track][env.env_id][p]=c;continue;}
    jobs.push({env_id:env.env_id,spec:env.spec,spec_sha256:specHash(env.spec),track,policy:p,repeat:0,dir:cacheDirOf(cacheDir,track,env.env_id,p),keep:keep.includes(p)});
  }
  // Expensive deciders first so the pool stays busy at the end.
  const cost=j=>j.policy==='omniscient'?3:j.policy==='causal'?2:1;
  jobs.sort((a,b)=>cost(b)-cost(a));
  let done=0;const t0=performance.now();
  const res=await runJobs(jobs,{parallel,onResult:r=>{done++;onProgress?.({done,total:jobs.length,result:r,seconds:(performance.now()-t0)/1000});}});
  jobs.forEach((j,i)=>{out[j.track][j.env_id][j.policy]=res[i];});
  return out;
}

const scoreOf=r=>r?.score??null;
/** Why an environment is degenerate on the full track, or null. */
export function degenerateReason(refs,{bestRule=true}={}) {
  const s=Object.fromEntries(Object.entries(refs).map(([p,r])=>[p,scoreOf(r)]).filter(([,v])=>v!==null));
  if((s.wait??0)>=DEGENERATE.wait_at_least)return 'wait_already_good';
  if(bestRule&&Math.max(...Object.values(s))<=DEGENERATE.best_at_most)return 'all_references_fail';
  return null;
}

/**
 * References for a set of environments with degenerate re-draws. Mutates nothing; returns
 * {envs (final), references: {[track]: {[env_id]: {wait, patient, oref0, causal, omniscient}}}, details, redraws}.
 */
export async function computeReferences(envs,{tracks=['full','assisted'],cacheDir,parallel,maxRounds=4,onProgress,log=()=>{}}={}) {
  let current=[...envs];const redraws=[];
  const redraw=(env,reason,scores,round)=>{
    for(let a=env.attempt+1;a<env.attempt+10;a++) {
      const next=generateEnvironment({task:env.task,backend:env.backend,setting:env.setting,seedIndex:env.seed_index,attempt:a});
      if(inspectEnvironment(next).ok) {
        redraws.push({env_id:env.env_id,round,reason,from_attempt:env.attempt,to_attempt:a,from_seed:env.seed,to_seed:next.seed,scores});
        next.redraws=[...(env.redraws??[]),{attempt:env.attempt,seed:env.seed,reason,scores}];
        return next;
      }
    }
    throw new Error(`${env.env_id}: no valid re-draw`);
  };
  // The baseline screen only drops environments the wait policy already solves; "every reference
  // fails" needs the causal and omniscient deciders too (device-fault tasks defeat the code baselines).
  const screen=async(policies,label)=>{
    for(let round=0;round<maxRounds;round++) {
      const r=await scoreEnvironments(current,{tracks:['full'],policies,cacheDir,parallel,onProgress});
      const bad=current.map(e=>[e,degenerateReason(r.full[e.env_id],{bestRule:!policies})]).filter(([,why])=>why);
      log(`${label} round ${round}: ${bad.length} degenerate`);
      if(!bad.length)return;
      if(round===maxRounds-1){for(const [e,why] of bad)e.degenerate=why;return;}
      current=current.map(e=>{const b=bad.find(([x])=>x===e);return b?redraw(e,b[1],Object.fromEntries(Object.entries(r.full[e.env_id]).map(([p,x])=>[p,x.score])),`${label}-${round}`):e;});
    }
  };
  await screen(CHEAP_POLICIES,'baselines');
  await screen(null,'all');
  const all=await scoreEnvironments(current,{tracks,cacheDir,parallel,onProgress});
  const references={},details={};
  for(const track of tracks) {
    references[track]={};details[track]={};
    for(const e of current) {
      const r=all[track][e.env_id];
      references[track][e.env_id]=Object.fromEntries(Object.entries(r).map(([p,x])=>[p,Number(x.score.toFixed(4))]));
      details[track][e.env_id]=Object.fromEntries(Object.entries(r).map(([p,x])=>[p,{score:x.score,tir:x.tir,tbr70:x.tbr70,tbr54:x.tbr54,tar250:x.tar250,
        mean_mgdl:x.mean_mgdl,safety_fail:x.safety_fail,seconds:x.seconds,...(x.verified!==undefined?{verified:x.verified}:{})}]));
    }
  }
  return {envs:current,references,details,redraws};
}

const TIERS=['hard','medium','easy'];
/** Difficulty tiers: tertiles of the causal reference on the full track (ties: omniscient, then id). */
export function assignTiers(envs,refsFull) {
  const key=e=>[refsFull[e.env_id]?.causal??0,refsFull[e.env_id]?.omniscient??0];
  const sorted=[...envs].sort((a,b)=>{const x=key(a),y=key(b);return x[0]-y[0]||x[1]-y[1]||(a.env_id<b.env_id?-1:1);});
  const tiers={};sorted.forEach((e,i)=>{tiers[e.env_id]=TIERS[Math.min(2,Math.floor(i*3/sorted.length))];});
  return tiers;
}
