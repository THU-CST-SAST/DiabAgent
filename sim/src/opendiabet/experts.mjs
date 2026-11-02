// OpenDiabet expert trajectories (docs/OPENDIABET-V1.zh-CN.md §3): for every environment
// (task x backend x setting) the causal-optimal and the omniscient deciders each play N repeats
// (repeat r: episode seed = spec seed + r, the same person) on the full track. Per trajectory:
//   <outDir>/<env_id>/<decider>/r<k>/{result.json, run.json, bundle.json.gz, decisions.json.gz}
// (bundle = SimEnv.exportBundle: observations, actions with rationales, evaluator truth; decisions =
// the decider's log: causal = expected costs of every candidate action and belief summaries,
// omniscient = plan, per-decision alternatives and costs). <outDir>/index.jsonl has one line per
// trajectory; <outDir>/manifest.json the totals. Repeat 0 is copied from the reference cache when
// it holds the same spec.
import fs from 'node:fs';
import path from 'node:path';
import {runJobs,cached,specHash} from './references.mjs';

export const EXPERT_DECIDERS=['causal','omniscient'];

export async function generateExperts(envs,{perCell=2,deciders=EXPERT_DECIDERS,outDir,cacheDir=null,parallel,track='full',onProgress}={}) {
  fs.mkdirSync(outDir,{recursive:true});
  const jobs=[],rows=[],t0=performance.now();let reused=0,skipped=0;
  for(const env of envs)for(const d of deciders)for(let r=0;r<perCell;r++) {
    const dir=path.join(outDir,env.env_id,d,`r${r}`),hash=specHash(env.spec);
    const done=path.join(dir,'result.json');
    if(fs.existsSync(done)&&JSON.parse(fs.readFileSync(done,'utf8')).spec_sha256===hash&&fs.existsSync(path.join(dir,'bundle.json.gz'))){skipped++;rows.push({env,d,r,dir});continue;}
    const c=r===0&&cacheDir?cached(cacheDir,track,env,d):null;
    const src=c?path.join(cacheDir,track,env.env_id,d):null;
    if(c&&fs.existsSync(path.join(src,'bundle.json.gz'))) {
      fs.mkdirSync(dir,{recursive:true});
      for(const f of ['bundle.json.gz','run.json','decisions.json.gz','result.json'])if(fs.existsSync(path.join(src,f)))fs.copyFileSync(path.join(src,f),path.join(dir,f));
      reused++;rows.push({env,d,r,dir});continue;
    }
    jobs.push({env_id:env.env_id,spec:env.spec,spec_sha256:hash,track,policy:d,repeat:r,dir,keep:true});rows.push({env,d,r,dir});
  }
  jobs.sort((a,b)=>(b.policy==='omniscient')-(a.policy==='omniscient'));
  let done=0;
  await runJobs(jobs,{parallel,onResult:res=>onProgress?.({done:++done,total:jobs.length,result:res,seconds:(performance.now()-t0)/1000})});
  const lines=[];let bytes=0;
  for(const {env,d,r,dir} of rows) {
    const res=JSON.parse(fs.readFileSync(path.join(dir,'result.json'),'utf8'));
    const files=fs.readdirSync(dir).sort();for(const f of files)bytes+=fs.statSync(path.join(dir,f)).size;
    lines.push(JSON.stringify({env_id:env.env_id,task:env.task,backend:env.backend,setting:env.setting,category:env.category,split:env.split,
      track,decider:d,repeat:r,seed:res.seed,person_seed:res.person_seed,score:res.score,tir:res.tir,tbr70:res.tbr70,tbr54:res.tbr54,tar250:res.tar250,
      mean_mgdl:res.mean_mgdl,safety_fail:res.safety_fail,steps:res.steps,seconds:res.seconds,trajectory_sha256:res.trajectory_sha256,spec_sha256:res.spec_sha256,
      dir:path.relative(outDir,dir),files:files.filter(f=>!f.includes('.tmp'))}));
  }
  fs.writeFileSync(path.join(outDir,'index.jsonl'),lines.join('\n')+'\n');
  const manifest={format:'opendiabet.experts/v1',created:new Date().toISOString(),track,deciders,per_cell:perCell,environments:envs.length,
    trajectories:lines.length,computed:jobs.length,reused_from_references:reused,already_present:skipped,bytes,
    seconds:Number(((performance.now()-t0)/1000).toFixed(1)),
    layout:'<env_id>/<decider>/r<k>/{result.json, run.json (sweet-sim.run/v1), bundle.json.gz (SimEnv.exportBundle), decisions.json.gz}',
    repeat_rule:'repeat r: episode seed = spec.seed + r, person.seed fixed (same individual, another day)'};
  fs.writeFileSync(path.join(outDir,'manifest.json'),JSON.stringify(manifest,null,1)+'\n');
  return manifest;
}
