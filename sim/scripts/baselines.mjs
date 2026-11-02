// Classical care baselines on the OpenDiabet v1 environments (docs/BASELINES.zh-CN.md).
//
//   node scripts/baselines.mjs run [--set artifacts/benchmarks/opendiabet-v1] [--cache artifacts/opendiabet/runs]
//        [--tracks full,assisted] [--policies standard,guideline,hcl,oref1] [--envs T01,T07-pens] [--parallel 3]
//
// Plays every (track, environment, policy) episode in-process (worker threads, the same episode
// runner and bench score as the references: src/opendiabet/episodes.mjs runEpisode) and caches
// each result under <cache>/<track>/<env_id>/<policy>/result.json next to the reference policies.
// A cached result is reused only when both the environment spec hash and the hash of the
// baseline source files match (<dir>/policy.json), so the run is resumable and code changes
// invalidate stale results. Existing reference policies are never recomputed.
//
// Applicability: hcl (B3) and oref1 (B4) need a pump and a real-time CGM (sensor setup cgm or
// calibrated_cgm); elsewhere they are recorded as N/A ({na: true, reason}) and not played.
// Current default: hourly fixed slots + capped urgent extras; legacy files are retained separately.
// Output: <set>/baselines-hourly-urgent-v1.json {format, policies, applicability, code_sha256, tracks: {track:
// {env_id: {policy: score | null}}}, details}.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {runJobs,specHash} from '../src/opendiabet/references.mjs';
import {SCORING_VERSION} from '../src/opendiabet/episodes.mjs';
import {baselineAgentOptions,baselinePolicyProtocol} from '../src/bench/hourly-policy.mjs';

export const BASELINES=['standard','guideline','hcl','oref1'];
export const BASELINE_FILES=['src/policies/care.mjs','src/policies/hcl.mjs','src/policies/oref1.mjs',
  'src/viz/run.mjs','src/bench/hourly-policy.mjs','src/bench/hourly-schedule.mjs','src/bench/agent-options.mjs','src/env/hooks.mjs'];
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

/** Why a baseline does not apply to an environment (null when it applies). */
export function notApplicable(policy,env) {
  if(policy!=='hcl'&&policy!=='oref1')return null;
  if(env.family!=='pump')return 'pens: no closed loop (not applicable)';
  const s=env.factors?.sensor_setup;
  if(s!=='cgm'&&s!=='calibrated_cgm')return `no real-time CGM (${s}): closed loop not available`;
  return null;
}
export function codeHash() {
  const h=createHash('sha256');
  for(const f of BASELINE_FILES)h.update(f).update(fs.readFileSync(path.join(ROOT,f)));
  return h.digest('hex');
}
const readJson=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const parseArgs=a=>{const o={};for(let i=0;i<a.length;i++)if(a[i].startsWith('--')){const k=a[i].slice(2);o[k]=a[i+1]&&!a[i+1].startsWith('--')?a[++i]:'true';}return o;};
const list=v=>v?v.split(',').map(s=>s.trim()).filter(Boolean):null;
const log=(...a)=>console.error(`[${new Date().toISOString().slice(11,19)}]`,...a);

async function run(opt) {
  const set=opt.set??path.join('artifacts','benchmarks','opendiabet-v1');
  const cache=opt.cache??path.join('artifacts','opendiabet','runs','hourly-urgent-v1');
  const tracks=list(opt.tracks)??['full','assisted'],policies=list(opt.policies)??BASELINES;
  for(const p of policies)if(!BASELINES.includes(p))throw new Error(`unknown baseline ${p} (${BASELINES.join(', ')})`);
  const parallel=Number(opt.parallel??3);
  let envs=fs.readFileSync(path.join(set,'environments.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
  const prefixes=list(opt.envs);if(prefixes)envs=envs.filter(e=>prefixes.some(p=>e.env_id.startsWith(p)));
  const refs=fs.existsSync(path.join(set,'references.json'))?readJson(path.join(set,'references.json')):null;
  for(const e of envs)if(refs?.spec_sha256?.[e.env_id]&&refs.spec_sha256[e.env_id]!==specHash(e.spec))
    throw new Error(`${e.env_id}: environment spec differs from references.json`);
  const code=codeHash();
  const outFile=path.join(set,opt.output??'baselines-hourly-urgent-v1.json');
  const doc=fs.existsSync(outFile)?readJson(outFile):{tracks:{},details:{}};
  const jobs=[];let cachedN=0,na=0;
  const record=(track,env,policy,r)=>{
    ((doc.tracks[track]??={})[env.env_id]??={})[policy]=r.na?null:Number(r.score.toFixed(4));
    ((doc.details[track]??={})[env.env_id]??={})[policy]=r.na?{na:true,reason:r.reason}:
      {score:r.score,tir:r.tir,tbr70:r.tbr70,tbr54:r.tbr54,tar250:r.tar250,mean_mgdl:r.mean_mgdl,safety_fail:r.safety_fail,seconds:r.seconds,
        execution_protocol:r.execution_protocol,baseline_gating:r.baseline_gating};
  };
  for(const track of tracks)for(const env of envs)for(const policy of policies) {
    const why=notApplicable(policy,env);
    if(why){record(track,env,policy,{na:true,reason:why});na++;continue;}
    const dir=path.join(cache,track,env.env_id,policy),rf=path.join(dir,'result.json'),pf=path.join(dir,'policy.json');
    if(fs.existsSync(rf)&&fs.existsSync(pf)) {
      // Spec, baseline source and scoring version must all match: the same trajectory scores very
      // differently under bench-v0.2 and METRICS-v0.3, and results predating the field are v0.2.
      try{const r=readJson(rf),p=readJson(pf);
        if(r.spec_sha256===specHash(env.spec)&&p.code_sha256===code&&(r.scoring_version??'bench-v0.2')===SCORING_VERSION){record(track,env,policy,r);cachedN++;continue;}}catch{}
    }
    jobs.push({env_id:env.env_id,spec:env.spec,spec_sha256:specHash(env.spec),track,policy,repeat:0,dir,keep:false,_env:env});
  }
  log(`${envs.length} environments x ${tracks.join('+')} x ${policies.join(',')}: ${cachedN} cached, ${na} N/A, ${jobs.length} to run (${parallel} workers)`);
  const save=()=>{
    Object.assign(doc,{format:'opendiabet.baselines/v1',created:doc.created??new Date().toISOString(),updated:new Date().toISOString(),
      policies:BASELINES,code_sha256:code,files:BASELINE_FILES,
      execution_protocol:baselinePolicyProtocol(baselineAgentOptions('standard')),
      applicability:{standard:'all',guideline:'all',hcl:'pump + real-time CGM (cgm, calibrated_cgm)',oref1:'pump + real-time CGM (cgm, calibrated_cgm)'},
      doc:'docs/BASELINES.zh-CN.md'});
    const tmp=`${outFile}.tmp-${process.pid}`;fs.writeFileSync(tmp,JSON.stringify(doc,null,1)+'\n');fs.renameSync(tmp,outFile);
  };
  const t0=performance.now();let done=0;
  // Jobs carry only plain data to the workers.
  const plain=jobs.map(({_env,...j})=>j);
  await runJobs(plain,{parallel,onResult:(r,i)=>{
    const j=jobs[i];fs.writeFileSync(path.join(j.dir,'policy.json'),JSON.stringify({policy:j.policy,code_sha256:code,files:BASELINE_FILES})+'\n');
    record(j.track,j._env,j.policy,r);done++;
    if(done%20===0||done===jobs.length){save();log(`${done}/${jobs.length} (${((performance.now()-t0)/1000).toFixed(0)} s) last ${j.track}/${j.env_id}/${j.policy} S=${r.score.toFixed(3)}`);}
  }});
  save();
  log(`wrote ${outFile}`);
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
  const [cmd,...rest]=process.argv.slice(2);
  if(cmd==='run')await run(parseArgs(rest));
  else console.log('usage: node scripts/baselines.mjs run [--set DIR] [--cache DIR] [--tracks full,assisted] [--policies standard,guideline,hcl,oref1] [--envs PREFIXES] [--parallel 3]');
}
