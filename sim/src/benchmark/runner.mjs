// Local Harbor runner (docs/BENCH.zh-CN.md §8): runs trials of sweet-sim Harbor tasks without
// Docker but with Harbor semantics. Per trial:
//   1. start the task's sim sidecar as a local process from its environment/sim snapshot
//      (environment/sim/app/src/export/harbor/sim-entry.mjs) on an ephemeral 127.0.0.1 port, with
//      the admin token and SWEET_SIM_REPEAT=r (episode seed = spec.seed + r, person.seed fixed);
//   2. run the agent as a separate process that only gets SWEET_SIM_URL, the task's `sim` client
//      and public.json (src/benchmark/agents.mjs); its environment is built from scratch;
//   3. run tests/test.sh (the task's verifier) with LOGS_DIR=<trial>/verifier and the admin token;
//   4. keep the full simulation data (default; keepSimData false = --no-keep-sim-data opts out): the
//      evaluator bundle (SimEnv.exportBundle via the sidecar's admin export) as
//      verifier/bundle.json.gz and the sidecar journal under sim/, recorded in trial.json
//      (sim_data: paths, bytes, sha256 of the .gz file and of the bundle JSON, trajectory_sha256);
//   5. stop the sidecar and write trial.json.
//
// Job layout (Harbor job/trial convention):
//   <jobsDir>/<job_id>/config.json, result.json
//   <jobsDir>/<job_id>/<trial_id>/{trial.json, agent/..., verifier/{reward.json, metrics.json, run.json}}
// trial_id = <task_id>__<agent slug>__r<k>. Trials whose trial.json says done (and that have a
// reward.json) are skipped, so a job can be resumed by running it again with the same job id.
//
// Failure handling (docs/BENCH.zh-CN.md §8.11): trial.json status is done (the agent itself reached
// the horizon, reward.agent_completed = 1), agent_failed (crash, gave up, early exit, timeout: still
// scored with WAIT fill, scored_with_fill: true, `failure` {reason, exit_code, last_error, ...};
// reasons in src/benchmark/failures.mjs), infra_failed (sidecar / verifier / setup) or not_started
// (budget stop, auth fail-fast). A rerun of the job retries everything that is not done, up to
// maxAttempts per trial; earlier attempts are kept under <trial>/attempts/<n>/ and listed in
// trial.json `attempts`. Transient failures (rate limit, 5xx, network, infra) are retried within the
// run with backoff.
import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {readTaskToml} from './toml.mjs';
import {loadBenchmark} from './build.mjs';
import {agentProcess,prepareAgentApp,parseAgent,refusal,keyFingerprint,POLICY_AGENTS} from './agents.mjs';
import {summarizeJob,trialState} from './summarize.mjs';
import {agentFailure,TRANSIENT_REASONS,blocksModelQueue} from './failures.mjs';
import {loadModelConfig} from '../bench/models/index.mjs';
import {freezeCode} from '../export/harbor.mjs';
import {parseAgentOptions,nonDefaultOptions,AGENT_OPTIONS_VERSION} from '../bench/agent-options.mjs';
import {freezeSkillAssets,hash as skillHash} from '../bench/skill-assets.mjs';
import {executionProtocol,effectiveAgentOptions} from './execution-protocol.mjs';
import {CLASSICAL_BASELINES,BASELINE_CADENCE_VERSION} from '../bench/hourly-policy.mjs';

/**
 * Score of the days after warm-up (agent option warmup_days) from a daily verifier's reward.json
 * (day_<k>_reward, k = 1..days): {warmup_days, scored_days, reward (mean), day_rewards} or {warmup_days,
 * error} when the task has no daily rewards. The verifier's own `reward` covers the whole horizon.
 */
export function warmupScored(reward,warmupDays) {
  if(!(warmupDays>0))return null;
  const days=Object.keys(reward??{}).map(k=>/^day_(\d+)_reward$/.exec(k)).filter(Boolean).map(m=>Number(m[1])).sort((a,b)=>a-b);
  if(!days.length)return {warmup_days:warmupDays,error:'warm-up exclusion needs a task with the daily verifier (day_<k>_reward); reward covers the whole horizon'};
  const kept=days.filter(k=>k>warmupDays);
  if(!kept.length)return {warmup_days:warmupDays,error:`no days left after ${warmupDays} warm-up day(s)`};
  const rs=kept.map(k=>reward[`day_${k}_reward`]);
  return {warmup_days:warmupDays,scored_days:kept,reward:rs.reduce((a,b)=>a+b,0)/rs.length,day_rewards:rs};
}

/** Agent code roots frozen per job (the built-in agents and everything they import). */
export const AGENT_CODE_ROOTS=['src/benchmark/agent-main.mjs','src/benchmark/llm-agent.mjs'];

/**
 * Freezes the built-in agents' code into <jobDir>/agent-code (once per job, so a resumed job keeps
 * the same code even if the working tree changes). Returns {main, sha256, files}.
 */
export function freezeAgentCode(jobDir,{skillContext=false}={}) {
  const dest=path.join(jobDir,'agent-code'),meta=path.join(dest,'FROZEN.json');
  if(fs.existsSync(meta)) {
    const previous=readJson(meta);
    if(skillContext&&!previous.skill_context)throw Error('Existing job has no frozen Skill context; use a new job ID');
    return {...previous,main:path.join(dest,'src','benchmark','agent-main.mjs')};
  }
  fs.rmSync(dest,{recursive:true,force:true});
  const r=freezeCode(AGENT_CODE_ROOTS,dest);
  const skill=skillContext?freezeSkillAssets(dest):null;
  const result={sha256:skill?skillHash(r.sha256+'\n'+skill.sha256):r.sha256,
    files:r.files.length+(skill?.files??0),
    ...(skill?{skill_context:skill}:{}),
    created:new Date().toISOString()};
  writeJson(meta,result);
  return {...result,main:path.join(dest,'src','benchmark','agent-main.mjs')};
}

export const JOB_FORMAT='sweet-sim.benchmark-job/v1';
export const TRIAL_FORMAT='sweet-sim.trial/v1';
const baseEnv=()=>({PATH:process.env.PATH??'/usr/bin:/bin',...(process.env.SYSTEMROOT?{SYSTEMROOT:process.env.SYSTEMROOT}:{})});
const writeJson=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=`${file}.tmp-${process.pid}`;fs.writeFileSync(tmp,JSON.stringify(data,null,1)+'\n');fs.renameSync(tmp,file);};
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
export const trialId=(taskId,agent,repeat,modelDraw=0)=>`${taskId}__${parseAgent(agent).slug}__r${repeat}${modelDraw?`__d${modelDraw}`:''}`;

/**
 * Starts the task's sidecar; resolves {url, port, stop(), child}. The admin token goes in on stdin
 * (SWEET_SIM_ADMIN_TOKEN_STDIN=1), never in the environment: without containers the agent runs as
 * the same OS user and could read other processes' environments (`ps -E`).
 */
export function startSidecar(taskDir,{token,dataDir,repeat=0,timeoutMs=60000,logFile=null}) {
  const entry=path.join(taskDir,'environment','sim','app','src','export','harbor','sim-entry.mjs');
  if(!fs.existsSync(entry))throw new Error(`${taskDir}: no sim sidecar snapshot (environment/sim/app)`);
  fs.mkdirSync(dataDir,{recursive:true});
  const child=spawn(process.execPath,[entry],{cwd:path.join(taskDir,'environment','sim','app'),stdio:['pipe','pipe','pipe'],
    env:{...baseEnv(),SWEET_SIM_ADMIN_TOKEN_STDIN:'1',PORT:'0',HOST:'127.0.0.1',DATA_DIR:dataDir,
      INSTANCE_FILE:path.join(taskDir,'environment','sim','instance.json'),SWEET_SIM_REPEAT:String(repeat)}});
  child.stdin.on('error',()=>{});child.stdin.end(`${token}\n`);
  const log=logFile?fs.createWriteStream(logFile):null;
  return new Promise((resolve,reject)=>{
    let out='',err='',settled=false;
    const timer=setTimeout(()=>{if(!settled){settled=true;child.kill('SIGKILL');reject(new Error(`sidecar did not start within ${timeoutMs} ms: ${err}`));}},timeoutMs);
    child.stderr.on('data',d=>{err+=d;log?.write(d);});
    child.on('exit',code=>{if(!settled){settled=true;clearTimeout(timer);reject(new Error(`sidecar exited ${code}: ${err.slice(-2000)}`));}});
    child.stdout.on('data',d=>{
      out+=d;log?.write(d);
      const m=out.match(/on 127\.0\.0\.1:(\d+)/);
      if(m&&!settled) {
        settled=true;clearTimeout(timer);
        const port=Number(m[1]);
        resolve({url:`http://127.0.0.1:${port}`,port,child,
          stop:()=>new Promise(r=>{if(child.exitCode!==null||child.signalCode!==null){log?.end();return r();}child.removeAllListeners('exit');child.on('exit',()=>{log?.end();r();});child.kill();})});
      }
    });
  });
}

const sha256=buf=>crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Saves the episode's evaluator bundle from a running sidecar as <verifierDir>/bundle.json.gz.
 * Returns the trial.json sim_data record.
 */
export async function saveSimBundle(simUrl,token,verifierDir) {
  const get=async p=>{const r=await fetch(simUrl+p,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(300000)});
    if(!r.ok)throw new Error(`GET ${p}: ${r.status} ${(await r.text()).slice(0,300)}`);return r.text();};
  const {episodes}=JSON.parse(await get('/episodes'));
  if(episodes.length!==1)throw new Error(`expected exactly one episode, found ${episodes.length}`);
  const json=Buffer.from(await get(`/episodes/${episodes[0]}/export`)),gz=zlib.gzipSync(json,{level:9});
  const file=path.join(verifierDir,'bundle.json.gz');fs.writeFileSync(file,gz);
  let trajectory=null;try{trajectory=JSON.parse(json).manifest?.trajectory_sha256??null;}catch{}
  return {bundle:'verifier/bundle.json.gz',bytes:gz.length,json_bytes:json.length,sha256:sha256(gz),json_sha256:sha256(json),trajectory_sha256:trajectory};
}

/** Runs a process to completion with a timeout; stdout/stderr to files; optional stdin text. Resolves {code, signal, timed_out, seconds}. */
function runProcess({command,args,env,cwd,timeoutSec,stdoutFile,stderrFile,stdin=null}) {
  return new Promise(resolve=>{
    const t0=performance.now();
    const out=fs.openSync(stdoutFile,'w'),err=fs.openSync(stderrFile,'w');
    const child=spawn(command,args,{cwd,env,stdio:[stdin==null?'ignore':'pipe',out,err]});
    if(stdin!=null){child.stdin.on('error',()=>{});child.stdin.end(stdin);}
    let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},Math.max(1,timeoutSec)*1000);
    const finish=(code,signal)=>{clearTimeout(timer);fs.closeSync(out);fs.closeSync(err);
      resolve({code,signal,timed_out:timedOut,seconds:(performance.now()-t0)/1000});};
    child.on('exit',finish);
    child.on('error',e=>{fs.writeSync(err,String(e.stack??e));finish(-1,null);});
  });
}


const readText=f=>{try{return fs.readFileSync(f,'utf8');}catch{return null;}};
const tryJson=f=>{try{return readJson(f);}catch{return null;}};
/** Agent stats copied from agent/status.json into trial.json (tokens and cost are summed per agent by summaries). */
const AGENT_STAT_KEYS=['state','reason','error','error_status','error_scope','turns','model','input_tokens','output_tokens','cost_usd','api_errors','api_retries','parse_errors','transport_retries','steps','env_steps',
  'model_calls','decisions','simulate_calls','skill_reads','history_reads','notes_updates','profile_changes','wake_reasons','decisions_by_day','warmup','gating','warnings',
  'fixed_decisions','extra_decisions_by_local_day','execution_protocol'];
export function agentStats(status) {
  if(!status)return null;
  const out={};for(const k of AGENT_STAT_KEYS)if(status[k]!==undefined)out[k]=status[k];
  return out;
}

/**
 * Runs one trial. Returns the trial record (also written to <trialDir>/trial.json).
 * opts: taskDir, trialDir, agent, repeat (0), experiment, agentOptions ({causalFast, units, maxTurns,
 * apiTries, apiBaseDelayMs, agentOptions: LLM/agent options of src/bench/agent-options.mjs, recorded as
 * trial.json agent_options; warmup_days > 0 adds trial.json `scored` from the daily rewards}), keepSimData (true: verifier/bundle.json.gz and the sidecar journal sim/
 * are kept and recorded in trial.json sim_data; false: the journal is deleted and no bundle is
 * written), agentTimeoutSec (task.toml default), attempt (1) and attempts (history of archived
 * attempts, see archiveAttempt), keyFingerprint (recorded with auth failures).
 *
 * Outcome (trial.json status):
 *   done          the agent itself reached the horizon (reward.agent_completed = 1)
 *   agent_failed  the agent crashed, gave up, exited early or timed out; the verifier still scored the
 *                 episode with the rest filled with WAIT (scored_with_fill: true; summaries exclude it
 *                 by default); `failure` {reason, exit_code, signal, timed_out, last_error, ...}
 *   infra_failed  the sidecar, the verifier or the trial setup failed (`error`)
 */
export async function runTrial({taskDir,trialDir,agent,repeat=0,modelDraw=0,experiment=null,agentOptions={},keepSimData=true,agentTimeoutSec=null,verifierTimeoutSec=null,agentMain=undefined,
  attempt=1,attempts=[],keyFingerprint=null}) {
  taskDir=path.resolve(taskDir);trialDir=path.resolve(trialDir);
  let toml={},md={},token=null,tomlError=null;
  try {
    toml=readTaskToml(path.join(taskDir,'task.toml'));md=toml.metadata??{};
    if(!toml.verifier?.env?.SWEET_SIM_ADMIN_TOKEN)throw new Error(`${taskDir}/task.toml has no [verifier.env] SWEET_SIM_ADMIN_TOKEN`);
    // A fresh token per trial, not the one stored in task.toml: an agent running as the same OS
    // user can read the task directory, so the stored token must not open this trial's sidecar.
    token=crypto.randomBytes(24).toString('hex');
  } catch(e){tomlError=e;}
  for(const d of ['agent','verifier'])fs.rmSync(path.join(trialDir,d),{recursive:true,force:true});
  const agentDir=path.join(trialDir,'agent'),verifierDir=path.join(trialDir,'verifier'),simDir=path.join(trialDir,'sim');
  fs.mkdirSync(agentDir,{recursive:true});fs.mkdirSync(verifierDir,{recursive:true});fs.rmSync(simDir,{recursive:true,force:true});
  const record={format:TRIAL_FORMAT,trial_id:path.basename(trialDir),task_id:md.task_id??path.basename(taskDir),task_name:toml.task?.name??null,
    experiment:experiment??md.experiment??null,track:md.track??null,instance_id:md.instance_id??null,agent,repeat,model_draw:modelDraw,
    episode_seed:(md.episode_seed??0)+repeat,person_seed:md.person_seed??null,role:md.role??null,pair_id:md.pair_id??null,
    attempt,attempts,started:new Date().toISOString(),finished:null,status:'running',error:null,failure:null,scored_with_fill:null,
    agent_result:null,agent_stats:null,verifier_result:null,reward:null};
  // Per-task agent options ([metadata] agent_options_json, e.g. exp1d/1e levels) override the job's.
  if(md.agent_options_json) {
    try {
      const jobAo=agentOptions.agentOptions,base=typeof jobAo==='string'?(jobAo.trim()?JSON.parse(jobAo):{}):(jobAo??{});
      agentOptions={...agentOptions,agentOptions:{...base,...JSON.parse(md.agent_options_json)}};
    } catch(e){tomlError??=new Error(`${taskDir}/task.toml agent_options_json: ${e.message}`);}
  }
  // Agent options (src/bench/agent-options.mjs), normalized; also in agent/status.json.
  let ao=null;try{ao=parseAgentOptions(agentOptions.agentOptions??null);}catch{}
  if(ao){
    record.requested_agent_options={version:AGENT_OPTIONS_VERSION,...ao};
    ao=effectiveAgentOptions(agent,agentOptions.agentOptions??null);
    if(POLICY_AGENTS.includes(agent))agentOptions={...agentOptions,agentOptions:ao};
    record.agent_options={version:AGENT_OPTIONS_VERSION,...ao};record.agent_options_changed=nonDefaultOptions(ao);
    record.execution_protocol=executionProtocol(agent,ao);
  }
  writeJson(path.join(trialDir,'trial.json'),record);
  const t0=performance.now();let sim=null;
  try {
    if(tomlError)throw tomlError;
    sim=await startSidecar(taskDir,{token,dataDir:path.join(simDir,'data'),repeat,logFile:path.join(trialDir,'sim.log')});
    const appDir=prepareAgentApp(taskDir,agentDir,agent);
    const spec=agentProcess(agent,{appDir,agentDir,simUrl:sim.url,options:agentOptions,agentMain});
    const ar=await runProcess({...spec,env:{...baseEnv(),HOME:agentDir,...spec.env},
      timeoutSec:agentTimeoutSec??toml.agent?.timeout_sec??3600,stdoutFile:path.join(agentDir,'stdout.txt'),stderrFile:path.join(agentDir,'stderr.txt')});
    record.agent_result={exit_code:ar.code,signal:ar.signal,timed_out:ar.timed_out,seconds:Number(ar.seconds.toFixed(2))};
    const status=tryJson(path.join(agentDir,'status.json'));
    record.agent_stats=agentStats(status);
    const vr=await runProcess({command:'bash',args:[path.join(taskDir,'tests','test.sh')],cwd:verifierDir,
      // The runner saves the bundle itself (saveSimBundle, keepSimData), so the verifier does not.
      env:{...baseEnv(),HOME:verifierDir,LOGS_DIR:verifierDir,SWEET_SIM_URL:sim.url,SWEET_SIM_ADMIN_TOKEN_STDIN:'1',SWEET_SIM_SAVE_BUNDLE:'0'},stdin:`${token}\n`,
      timeoutSec:verifierTimeoutSec??toml.verifier?.timeout_sec??600,stdoutFile:path.join(verifierDir,'stdout.txt'),stderrFile:path.join(verifierDir,'stderr.txt')});
    record.verifier_result={exit_code:vr.code,timed_out:vr.timed_out,seconds:Number(vr.seconds.toFixed(2))};
    // The verifier's agent_completed (the agent itself reached the horizon) decides done vs agent_failed;
    // verifiers without it fall back to the agent's exit code and status.json.
    const rf=path.join(verifierDir,'reward.json'),reward=fs.existsSync(rf)?tryJson(rf):null;
    const completed=reward&&reward.agent_completed!==undefined?reward.agent_completed===1
      :ar.code===0&&!ar.timed_out&&(status?.state??'done')==='done';
    if(!completed) {
      record.failure={...agentFailure({proc:record.agent_result,status,transcript:readText(path.join(agentDir,'transcript.jsonl')),stderr:readText(path.join(agentDir,'stderr.txt'))}),
        agent_steps:reward?.agent_steps??null,verifier_wait_steps:reward?.verifier_wait_steps??null};
      if(record.failure.reason==='auth')record.failure.key_fingerprint=keyFingerprint;
    } else if(ar.code!==0||ar.timed_out)record.agent_warning=`agent reached the horizon but exited ${ar.timed_out?'by timeout':`with ${ar.code}`}`;
    if(vr.code!==0||!reward)throw new Error(`verifier failed (exit ${vr.code}): ${fs.readFileSync(path.join(verifierDir,'stderr.txt'),'utf8').slice(-2000)}`);
    record.reward=reward;
    record.scored_with_fill=!completed;
    if(ao?.warmup_days>0)record.scored=warmupScored(reward,ao.warmup_days);
    if(keepSimData) {
      try {
        const files=d=>fs.existsSync(d)?fs.readdirSync(d).map(f=>path.join(d,f)):[];
        record.sim_data={...await saveSimBundle(sim.url,token,verifierDir),journal:'sim/data',
          journal_files:files(path.join(simDir,'data')).map(f=>({file:path.relative(trialDir,f),bytes:fs.statSync(f).size,sha256:sha256(fs.readFileSync(f))}))};
      } catch(e){record.sim_data={error:String(e?.message??e).slice(0,1000)};}
    }
    record.status=completed?'done':'agent_failed';
  } catch(e) {
    record.status='infra_failed';record.error=String(e?.message??e).slice(0,4000);
  } finally {
    await sim?.stop();
    if(!keepSimData)fs.rmSync(simDir,{recursive:true,force:true});
  }
  record.finished=new Date().toISOString();record.seconds=Number(((performance.now()-t0)/1000).toFixed(2));
  writeJson(path.join(trialDir,'trial.json'),record);
  return record;
}

/** Normalized state of a trial dir: {state (TRIAL_STATES or 'new'), rec}. */
export function trialStateOf(trialDir) {
  const rec=tryJson(path.join(trialDir,'trial.json'));
  if(!rec)return {state:'new',rec:null};
  return {state:trialState(rec,{hasReward:fs.existsSync(path.join(trialDir,'verifier','reward.json'))}),rec};
}

/** A trial is finished when its normalized state is done (trial.json done, reward.json present, agent completed). */
export function trialDone(trialDir) {return trialStateOf(trialDir).state==='done';}

/** Attempts that count against --max-attempts: finished attempts that failed. */
const failedAttempts=hist=>(hist??[]).filter(a=>a.status==='agent_failed'||a.status==='infra_failed').length;

/**
 * Moves the current contents of a trial dir (everything but attempts/) to <trial>/attempts/<n>/ and
 * returns the attempt history including it ({attempt, status, reason, started, finished, cost_usd, ...}).
 * not_started stubs and empty dirs are not archived (their history is kept).
 */
export function archiveAttempt(trialDir) {
  const {state,rec}=trialStateOf(trialDir);
  const hist=[...(rec?.attempts??[])];
  if(state==='new'||state==='not_started') {
    if(rec)fs.rmSync(path.join(trialDir,'trial.json'),{force:true});
    return hist;
  }
  const n=Math.max(rec.attempt??0,hist.length+1,...hist.map(a=>a.attempt+1));
  const dest=path.join(trialDir,'attempts',String(n));
  fs.rmSync(dest,{recursive:true,force:true});fs.mkdirSync(dest,{recursive:true});
  for(const f of fs.readdirSync(trialDir))if(f!=='attempts')fs.renameSync(path.join(trialDir,f),path.join(dest,f));
  const stats=rec.agent_stats??agentStats(tryJson(path.join(dest,'agent','status.json')));
  const failure=rec.failure??(state==='agent_failed'?legacyFailure(rec,dest):null);
  hist.push({attempt:n,status:state,reason:failure?.reason??(state==='infra_failed'?'infra':null),dir:`attempts/${n}`,started:rec.started??null,finished:rec.finished??null,
    exit_code:rec.agent_result?.exit_code??null,last_error:String(failure?.last_error??rec.error??'').slice(0,500)||null,
    input_tokens:stats?.input_tokens??0,output_tokens:stats?.output_tokens??0,cost_usd:stats?.cost_usd??0,
    ...(failure?.key_fingerprint?{key_fingerprint:failure.key_fingerprint}:{}),reward:rec.reward?.reward??null});
  return hist;
}

/** Failure record of a trial written before failures were classified (status done, agent_completed 0). */
export function legacyFailure(rec,dir) {
  return {...agentFailure({proc:rec.agent_result,status:tryJson(path.join(dir,'agent','status.json')),
    transcript:readText(path.join(dir,'agent','transcript.jsonl')),stderr:readText(path.join(dir,'agent','stderr.txt'))}),legacy:true};
}

/** Runs async tasks with at most `parallel` in flight; results in input order. */
export async function pool(items,parallel,fn) {
  const out=new Array(items.length);let next=0;
  const worker=async()=>{while(next<items.length){const i=next++;out[i]=await fn(items[i],i);}};
  await Promise.all(Array.from({length:Math.max(1,Math.min(parallel,items.length))},worker));
  return out;
}

/**
 * Work queue with at most `parallel` items in flight, at most `maxLlm` of those with item.llm, and
 * requeueing: fn(item) may resolve {requeueMs} to run the item again after a delay (the slot is
 * freed meanwhile). Items keep their order; an item that cannot start yet does not block later ones.
 */
export function schedule(items,{parallel,maxLlm=Infinity},fn) {
  const queue=items.map(x=>({item:x,notBefore:0}));let running=0,llm=0,timer=null;
  return new Promise((resolve,reject)=>{
    const tick=()=>{
      if(timer){clearTimeout(timer);timer=null;}
      while(running<parallel) {
        const now=Date.now(),i=queue.findIndex(q=>q.notBefore<=now&&(!q.item.llm||llm<maxLlm));
        if(i<0)break;
        const q=queue.splice(i,1)[0];running++;if(q.item.llm)llm++;
        Promise.resolve().then(()=>fn(q.item)).then(res=>{
          running--;if(q.item.llm)llm--;
          if(res?.requeueMs!=null)queue.push({item:q.item,notBefore:Date.now()+res.requeueMs});
          tick();
        },reject);
      }
      if(!queue.length&&!running)return resolve();
      const waiting=queue.filter(q=>q.notBefore>Date.now());
      if(waiting.length&&running<parallel)timer=setTimeout(tick,Math.max(5,Math.min(...waiting.map(q=>q.notBefore))-Date.now()+5));
    };
    tick();
  });
}

/**
 * Plans the trials of a job: experiments x tasks x agents x repeats. `agents` (null = each
 * experiment's own list, minus placeholders like llm:<model>), `experiments` (ids; null = all),
 * `repeats` (null = each experiment's). Agents not allowed on a track are returned in `refused`.
 */
export function planJob(bench,{agents=null,experiments=null,repeats=null,modelDraws=1}={}) {
  if(!Number.isInteger(modelDraws)||modelDraws<1)throw new Error('modelDraws must be a positive integer');
  const trials=[],refused=[];
  const ordered=experiments?[...bench.experiments].sort((a,b)=>experiments.indexOf(a.id)-experiments.indexOf(b.id)):bench.experiments;
  for(const e of ordered) {
    if(experiments&&!experiments.includes(e.id))continue;
    const list=(agents??e.agents).filter(a=>!/[<>]/.test(a));
    for(const a of list) {
      parseAgent(a);
      const why=refusal(a,e.track);
      if(why){refused.push({experiment:e.id,track:e.track,agent:a,reason:why});continue;}
      for(const t of e.task_ids)for(let r=0;r<(repeats??e.repeats??1);r++)for(let d=0;d<(parseAgent(a).kind==='llm'?modelDraws:1);d++)
        trials.push({experiment:e.id,track:e.track,task_id:t,agent:a,repeat:r,model_draw:d,trial_id:trialId(t,a,r,d),task_dir:path.join(bench.dir,bench.tasks[t]?.dir??`tasks/${t}`)});
    }
  }
  return {trials,refused};
}

export const defaultParallel=()=>Math.max(1,Math.floor((os.availableParallelism?.()??os.cpus().length)/2));

/** Writes a not_started stub (budget stop, auth fail-fast) keeping the attempt history. */
function writeNotStarted(dir,t,reason,detail,attempts=[]) {
  writeJson(path.join(dir,'trial.json'),{format:TRIAL_FORMAT,trial_id:t.trial_id,task_id:t.task_id,experiment:t.experiment,track:t.track,agent:t.agent,
    repeat:t.repeat,model_draw:t.model_draw??0,attempt:null,attempts,status:'not_started',not_started:{reason,detail},finished:new Date().toISOString(),error:null,reward:null});
}

/** USD spent by the agents of a trial dir so far (all archived attempts plus the current one). */
function trialSpend(rec,dir) {
  if(!rec)return 0;
  const cur=rec.status==='not_started'?0:(rec.agent_stats??agentStats(tryJson(path.join(dir,'agent','status.json'))))?.cost_usd??0;
  return cur+(rec.attempts??[]).reduce((s,a)=>s+(a.cost_usd??0),0);
}

/**
 * Runs (or resumes) a job over a benchmark directory. Returns {job_dir, config, result, ran, skipped,
 * errors (trials that ended not done in this run), incomplete (trials of this run's plan not done), kept_failed (failed trials left as they were:
 * --no-retry-failed, max attempts, auth with an unchanged key), budget_stopped, spent_usd, wall_seconds}. opts: benchmarkDir, jobsDir (default <benchmarkDir>/../jobs), jobId (default
 * <benchmark name>), agents, experiments, repeats, parallel, agentOptions ({causalFast, units,
 * maxTurns, apiTries, apiBaseDelayMs}), fresh (delete the job dir first), keepSimData (default true;
 * see runTrial), onTrial(record, {done, total, skipped, cached, retry_in_ms}), and failure handling:
 *   maxAttempts (3)        attempts per trial; failed attempts are archived under <trial>/attempts/<n>/
 *   retryFailed (true)     rerun agent_failed / infra_failed trials of earlier runs (false: keep them)
 *   retryBackoffMs (30000) base delay of in-run retries after transient failures (x2 per attempt, max 10 min)
 *   maxConcurrentLlm       at most this many llm:<model> trials at once (default: no extra limit)
 *   budgetUsd              stop launching llm trials once the job's spend (all attempts, from the
 *                          agents' status.json cost_usd = tokens x price_per_mtok) plus the expected
 *                          cost of running llm trials reaches it; the rest are written as not_started
 *   includeFailed (false)  summaries include agent_failed trials (scored with WAIT fill)
 * Auth failures (401/403, missing key) fail fast: the agent's remaining trials are not started, and a
 * resumed job retries them only after the API key changed (fingerprint).
 */
export function validateBudget(agents,budgetUsd,readConfig=loadModelConfig) {
  if(budgetUsd==null)return;
  if(!Number.isFinite(budgetUsd)||budgetUsd<0)throw new Error('budgetUsd must be finite and nonnegative');
  for(const a of agents.filter(a=>parseAgent(a).kind==='llm')) {
    const p=readConfig(parseAgent(a).arg).price_per_mtok;
    if(!Number.isFinite(p?.input)||!Number.isFinite(p?.output)||p.input<=0||p.output<=0)
      throw new Error(`${a}: --budget-usd requires verified positive input/output price_per_mtok; unpriced is not free`);
  }
}

export async function runJob({benchmarkDir,jobsDir=null,jobId=null,agents=null,experiments=null,repeats=null,modelDraws=1,parallel=defaultParallel(),
  agentOptions={},fresh=false,keepSimData=true,onTrial=null,maxAttempts=3,retryFailed=true,retryBackoffMs=30000,maxConcurrentLlm=null,
  budgetUsd=null,includeFailed=false}) {
  const bench=loadBenchmark(benchmarkDir);
  const {trials,refused}=planJob(bench,{agents,experiments,repeats,modelDraws});
  validateBudget([...new Set(trials.map(t=>t.agent))],budgetUsd);
  jobsDir??=path.join(path.dirname(bench.dir),'jobs');
  jobId??=bench.name;
  const jobDir=path.resolve(jobsDir,jobId);
  if(fresh)fs.rmSync(jobDir,{recursive:true,force:true});
  fs.mkdirSync(jobDir,{recursive:true});
  const skillContext=trials.some(t=>parseAgent(t.agent).kind==='llm'&&!!loadModelConfig(parseAgent(t.agent).arg).skill_context);
  const frozen=freezeAgentCode(jobDir,{skillContext});
  const prev=fs.existsSync(path.join(jobDir,'config.json'))?readJson(path.join(jobDir,'config.json')):null;
  for(const trial of trials)if(CLASSICAL_BASELINES.includes(trial.agent)
    &&effectiveAgentOptions(trial.agent,agentOptions.agentOptions??null).decision_schedule==='hourly') {
    if(prev&&!fs.existsSync(path.join(jobDir,'agent-code/src/bench/hourly-policy.mjs')))
      throw Error('Existing job has historical per-step baseline code; preserve it and use a new job ID for hourly baselines');
    const prior=tryJson(path.join(jobDir,trial.trial_id,'trial.json'));
    if(prior?.status==='done'&&prior.execution_protocol?.version!==BASELINE_CADENCE_VERSION)
      throw Error('Existing completed baseline has historical cadence metadata; preserve it and use a new job ID');
  }
  const llmAgents=[...new Set(trials.map(t=>t.agent).filter(a=>parseAgent(a).kind==='llm'))];
  const warnings=[];
  for(const a of llmAgents) {
    const p=loadModelConfig(parseAgent(a).arg).price_per_mtok;
    if(!(p?.input>0&&p?.output>0))warnings.push(`${a}: tariff unpriced; token counts are available, USD totals are not a cost estimate`);
  }
  for(const w of warnings)console.error(`warning: ${w}`);
  const config={format:JOB_FORMAT,job_id:jobId,benchmark:bench.name,benchmark_version:bench.version,benchmark_dir:bench.dir,
    benchmark_sha256:sha256(fs.readFileSync(path.join(bench.dir,'benchmark.json'))),
    sweet_sim_commit:bench.sweet_sim_commit,knowledge_sha256:bench.knowledge_sha256,scoring:bench.scoring,
    created:prev?.created??new Date().toISOString(),updated:new Date().toISOString(),
    runner:'sweet-sim scripts/harbor-local.mjs (local, no Docker; Harbor job/trial layout)',
    experiments:[...new Set(trials.map(t=>t.experiment))],
    agents:[...new Set([...(prev?.agents??[]),...trials.map(t=>t.agent)])],
    repeats:repeats??Object.fromEntries(bench.experiments.map(e=>[e.id,e.repeats??1])),model_draws:modelDraws,parallel,agent_options:agentOptions,refused,
    trials_planned:trials.length,planned_trials:{...(prev?.planned_trials??{}),...Object.fromEntries(trials.map(t=>[t.trial_id,t.agent]))},
    keep_sim_data:keepSimData,agent_code:{dir:'agent-code',sha256:frozen.sha256,files:frozen.files,
      ...(frozen.skill_context?{skill_context:frozen.skill_context}:{})},
    failure_handling:{max_attempts:maxAttempts,retry_failed:retryFailed,retry_backoff_ms:retryBackoffMs,max_concurrent_llm:maxConcurrentLlm,
      budget_usd:budgetUsd,include_failed:includeFailed,...(warnings.length?{warnings}:{})}};
  writeJson(path.join(jobDir,'config.json'),config);

  // Spend so far (budget) and auth fail-fast state carried over from earlier runs.
  const fingerprints=new Map(llmAgents.map(a=>[a,keyFingerprint(a)]));
  const authBlocked=new Map();            // agent -> reason detail
  const contractBlocked=new Map();
  let spent=0,llmDone=0,llmSpent=0;
  for(const d of fs.readdirSync(jobDir)) {
    const rec=tryJson(path.join(jobDir,d,'trial.json'));if(!rec)continue;
    const s=trialSpend(rec,path.join(jobDir,d));spent+=s;
    if(parseAgent(rec.agent??'wait').kind==='llm'){llmSpent+=s;llmDone+=(rec.attempts?.length??0)+(rec.status==='not_started'?0:1);}
    const fp=rec.failure?.key_fingerprint;
    if(rec.status==='agent_failed'&&rec.failure?.reason==='auth'&&fingerprints.has(rec.agent)&&fp===fingerprints.get(rec.agent))
      authBlocked.set(rec.agent,`auth failure in ${rec.trial_id} with the same API key: ${String(rec.failure.last_error??'').slice(0,200)}`);
    if(rec.status==='agent_failed'&&blocksModelQueue(rec.failure))
      contractBlocked.set(rec.agent,`tool contract failure in ${rec.trial_id}; validate the endpoint before a new job`);
  }
  let budgetStopped=false,llmRunning=0;
  const overBudget=()=>budgetUsd!=null&&(budgetStopped||=spent+(llmDone?llmSpent/llmDone:0)*llmRunning>=budgetUsd);

  let done=0,skipped=0,ran=0;const errors=[],kept=[],t0=performance.now();
  const finish=(rec,extra={})=>{done++;onTrial?.(rec,{done,total:trials.length,skipped,cached:false,...extra});};
  const items=trials.map(t=>({...t,llm:parseAgent(t.agent).kind==='llm'}));
  await schedule(items,{parallel,maxLlm:maxConcurrentLlm??Infinity},async t=>{
    const dir=path.join(jobDir,t.trial_id),{state,rec:old}=trialStateOf(dir);
    const skip=(why)=>{skipped++;done++;if(why)kept.push({trial_id:t.trial_id,state,why});onTrial?.(old,{done,total:trials.length,skipped,cached:true,why});};
    if(state==='done')return skip(null);
    if(contractBlocked.has(t.agent)) {
      if(state==='new'||state==='not_started'){writeNotStarted(dir,t,'tool_contract',contractBlocked.get(t.agent),old?.attempts??[]);finish(tryJson(path.join(dir,'trial.json')));}
      else skip('tool contract failure; endpoint validation required');
      return;
    }
    if(state==='agent_failed'||state==='infra_failed') {
      if(!retryFailed&&!t.retrying)return skip('--no-retry-failed');
      if(failedAttempts([...(old.attempts??[]),{status:state}])>=maxAttempts)return skip(`max attempts (${maxAttempts}) reached`);
    }
    if(authBlocked.has(t.agent)) {
      if(state==='new'||state==='not_started'){writeNotStarted(dir,t,'auth',authBlocked.get(t.agent),old?.attempts??[]);finish(tryJson(path.join(dir,'trial.json')));}
      else skip(`auth failure (API key unchanged)`);
      return;
    }
    if(t.llm&&overBudget()) {
      writeNotStarted(dir,t,'budget',`--budget-usd ${budgetUsd} reached (spent ${spent.toFixed(4)} USD)`,old?.attempts??[]);
      finish(tryJson(path.join(dir,'trial.json')));return;
    }
    const attempts=archiveAttempt(dir);
    if(t.llm)llmRunning++;
    let rec;
    try {
      rec=await runTrial({taskDir:t.task_dir,trialDir:dir,agent:t.agent,repeat:t.repeat,modelDraw:t.model_draw,experiment:t.experiment,agentOptions,keepSimData,
        agentMain:frozen.main,attempt:Math.max(attempts.length,...attempts.map(a=>a.attempt))+1,attempts,keyFingerprint:fingerprints.get(t.agent)??null});
    } finally {if(t.llm)llmRunning--;}
    ran++;
    const cost=rec.agent_stats?.cost_usd??0;spent+=cost;if(t.llm){llmSpent+=cost;llmDone++;}
    if(rec.status==='done')return finish(rec);
    const reason=rec.status==='infra_failed'?'infra':rec.failure?.reason;
    if(reason==='auth')authBlocked.set(t.agent,`auth failure in ${t.trial_id}: ${String(rec.failure.last_error??'').slice(0,200)}`);
    if(blocksModelQueue(rec.failure))contractBlocked.set(t.agent,`endpoint contract failure in ${t.trial_id}; no further queued trials submitted`);
    const nFailed=failedAttempts(attempts)+1;
    if((reason==='infra'||TRANSIENT_REASONS.has(reason))&&nFailed<maxAttempts&&!(t.llm&&overBudget())) {
      const delay=Math.min(600000,retryBackoffMs*2**(nFailed-1));
      onTrial?.(rec,{done,total:trials.length,skipped,cached:false,retry_in_ms:delay});
      t.retrying=true;return {requeueMs:delay};
    }
    errors.push({trial_id:t.trial_id,status:rec.status,reason,error:rec.error??rec.failure?.last_error??null});
    finish(rec);
  });
  const wall=(performance.now()-t0)/1000;
  const result=summarizeJob(jobDir,{bench,write:true,wallSeconds:wall,includeFailed});
  const incomplete=trials.filter(t=>!trialDone(path.join(jobDir,t.trial_id))).length;
  return {job_dir:jobDir,config,result,ran,skipped,errors,incomplete,kept_failed:kept.filter(k=>k.state!=='done'),
    budget_stopped:budgetStopped,spent_usd:Number(spent.toFixed(6)),wall_seconds:wall};
}
