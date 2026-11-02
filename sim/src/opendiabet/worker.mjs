// Worker thread for OpenDiabet reference and expert episodes (src/opendiabet/references.mjs pool).
// Job: {spec, track, repeat, policy, dir, keep}. Writes <dir>/result.json (score, metrics, runtime,
// spec_sha256) and, when keep, <dir>/bundle.json.gz, <dir>/run.json and <dir>/decisions.json.gz.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {parentPort,workerData,isMainThread} from 'node:worker_threads';
import {runEpisode,episodeSpec} from './episodes.mjs';
import {runFromBundle} from '../viz/run.mjs';
import {runHardJob} from './hard-jobs.mjs';

/** Any pool job: plain episodes (runJob) or v1.1-hard jobs ({kind: 'hard-screen' | 'hard-episode'}). */
export const runAnyJob=job=>job.kind?runHardJob(job):runJob(job);

export function runJob(job) {
  const spec=episodeSpec(job.spec,{track:job.track,repeat:job.repeat??0,hours:job.hours??24});
  const r=runEpisode(spec,job.policy,job.options??{});
  const {bundle,decisions,...result}=r;
  Object.assign(result,{env_id:job.env_id,track:job.track,repeat:job.repeat??0,seed:spec.seed,person_seed:spec.person?.seed??null,
    spec_sha256:job.spec_sha256,trajectory_sha256:bundle.manifest.trajectory_sha256,finished:new Date().toISOString()});
  if(job.dir) {
    fs.mkdirSync(job.dir,{recursive:true});
    if(job.keep) {
      fs.writeFileSync(path.join(job.dir,'bundle.json.gz'),zlib.gzipSync(JSON.stringify(bundle),{level:9}));
      const run=runFromBundle(bundle,{id:`${job.env_id}-${job.policy}-r${job.repeat??0}`});run.policy=job.policy;
      if(result.execution_protocol)Object.assign(run,{execution_protocol:result.execution_protocol,baseline_gating:result.baseline_gating});
      fs.writeFileSync(path.join(job.dir,'run.json'),JSON.stringify(run));
      if(decisions)fs.writeFileSync(path.join(job.dir,'decisions.json.gz'),zlib.gzipSync(JSON.stringify(decisions)));
      result.files={bundle:'bundle.json.gz',run:'run.json',...(decisions?{decisions:'decisions.json.gz'}:{})};
    }
    const tmp=path.join(job.dir,`result.json.tmp-${process.pid}`);
    fs.writeFileSync(tmp,JSON.stringify(result,null,1));fs.renameSync(tmp,path.join(job.dir,'result.json'));
  }
  return result;
}

if(!isMainThread&&workerData?.role==='opendiabet-worker') {
  parentPort.on('message',({i,job})=>{
    try{parentPort.postMessage({i,result:runAnyJob(job)});}
    catch(e){parentPort.postMessage({i,error:e.stack??String(e)});}
  });
}
