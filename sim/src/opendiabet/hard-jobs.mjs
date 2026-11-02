// Worker-side jobs of the v1.1-hard certification (src/opendiabet/certify.mjs). A screen job
// generates one hard candidate of a cell and plays the cheap references (wait, patient, oref0) and,
// optionally, the causal decider with `fast` settings on it, reading and writing the per-candidate
// cache <cacheDir>/<track>/<env_id>/c<k>/<policy>/result.json (keyed by the spec hash, so runs resume
// and a changed generator never reuses stale results).
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {hardCandidate} from './hard.mjs';
import {runJob} from './worker.mjs';

export const specHashOf=spec=>createHash('sha256').update(JSON.stringify(spec)).digest('hex');
export const candidateDir=(cacheDir,track,envId,k,policy)=>path.join(cacheDir,track,envId,`c${k}`,policy);
/** Policy label -> {policy, options}: 'causal-fast' is the causal decider with fast settings. */
export const policyOf=label=>label==='causal-fast'?{policy:'causal',options:{causal:{fast:true}}}:label==='omniscient'?{policy:'omniscient',options:{}}:{policy:label,options:{}};

/** Cached result for exactly this spec, or null. */
export function cachedResult(dir,specSha) {
  const f=path.join(dir,'result.json');
  if(!fs.existsSync(f))return null;
  try{const r=JSON.parse(fs.readFileSync(f,'utf8'));return r.spec_sha256===specSha?r:null;}catch{return null;}
}

/** Runs (or reads) one policy on an env for a track; keep = also store bundle / run / decisions. */
export function episodeResult(env,{track,label,cacheDir,keep=false}) {
  const sha=specHashOf(env.spec),dir=cacheDir?candidateDir(cacheDir,track,env.env_id,env.hard.candidate,label):null;
  const c=dir?cachedResult(dir,sha):null;
  if(c&&(!keep||c.files))return c;
  const {policy,options}=policyOf(label);
  const r=runJob({env_id:env.env_id,spec:env.spec,spec_sha256:sha,track,policy,repeat:0,dir,keep,options});
  return {...r,label};
}

/**
 * job: {kind:'hard-screen', task, backend, setting, seedIndex, k, track, labels, cacheDir}
 * -> {env, scores: {label: S}, results: {label: compact result}}
 */
export function screenJob(job) {
  const env=hardCandidate({task:job.task,backend:job.backend,setting:job.setting,seedIndex:job.seedIndex??1,k:job.k});
  const scores={},results={};
  for(const label of job.labels) {
    const r=episodeResult(env,{track:job.track,label,cacheDir:job.cacheDir});
    scores[label]=r.score;
    results[label]={score:r.score,tir:r.tir,tbr70:r.tbr70,tbr54:r.tbr54,tar250:r.tar250,safety_fail:r.safety_fail,seconds:r.seconds};
  }
  return {env,scores,results};
}

/** job: {kind:'hard-episode', env, track, label, cacheDir, keep} -> compact result (+ files when kept). */
export function hardEpisodeJob(job) {
  const r=episodeResult(job.env,{track:job.track,label:job.label,cacheDir:job.cacheDir,keep:job.keep});
  return {env_id:job.env.env_id,k:job.env.hard.candidate,track:job.track,label:job.label,score:r.score,tir:r.tir,tbr70:r.tbr70,tbr54:r.tbr54,tar250:r.tar250,
    safety_fail:r.safety_fail,seconds:r.seconds,files:r.files??null,
    dir:job.cacheDir?candidateDir(job.cacheDir,job.track,job.env.env_id,job.env.hard.candidate,job.label):null};
}

/** Runs a v1.1-hard job; a failing candidate or episode is reported ({failed}) instead of stopping the pool. */
export function runHardJob(job) {
  if(!['hard-screen','hard-episode'].includes(job.kind))throw new Error(`unknown job kind ${job.kind}`);
  try{return job.kind==='hard-screen'?screenJob(job):hardEpisodeJob(job);}
  catch(e) {
    return {failed:String(e.stack??e).slice(0,2000),kind:job.kind,env_id:job.env?.env_id??`${job.task}-${job.backend}-${job.setting}-s${job.seedIndex??1}`,
      k:job.env?.hard?.candidate??job.k,track:job.track,label:job.label??null};
  }
}
