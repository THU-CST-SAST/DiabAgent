// LLM bench episode runner (docs/BENCH.zh-CN.md §3–4). One episode = one instance x one repeat x
// one model (x one track): an in-process SimEnv for `hours` of simulated time, one `act` tool call
// per turn, a bounded wait between turns with the shared wake hooks (src/env/hooks.mjs
// stepWithHooks: the model's wake_on, default DEFAULT_HOOKS; thresholds only on a real-time CGM),
// and four output files in outDir:
//   transcript.jsonl (one line per turn), bundle.json (SimEnv.exportBundle), run.json (player
//   record), status.json ({state, reason, turns, ...}; written last, so "done" means complete).
// The caller decides about resuming (skip when status.json says done); runEpisode always starts the
// directory fresh.
import fs from 'node:fs';
import path from 'node:path';
import {buildInstanceConfig} from '../sim/instance.mjs';
import {SimEnv} from '../env/pomdp.mjs';
import {validateAction} from '../sim/actions.mjs';
import {runFromBundle} from '../viz/run.mjs';
import {availableHooks,HOOKS} from '../env/hooks.mjs';
import {trackSpec} from './tracks.mjs';
import {systemPrompt,optionsPromptText,fmtG,unitLabel,WAIT_MIN,KEEP_TURNS,MGDL_PER_MMOL} from './prompt.mjs';
import {parseAgentOptions,nonDefaultOptions,AGENT_OPTIONS_VERSION} from './agent-options.mjs';
import {runController,runWarmup,newStats,parseActReply,configureModel,agentView} from './controller.mjs';
import {RecordBook} from './records.mjs';
import {publicDescription} from '../oracle/belief.mjs';
import {traceModel} from './models/trace.mjs';

// 0.2: wake hooks (wake_on), tracks; 0.3: agent options (history window, decision gating, multi-day
// memory, warm-up, samples, simulate) through the shared controller (src/bench/controller.mjs).
export const HARNESS_VERSION='sweet-sim-bench-harness/0.3.0';
export const EPISODE_FILES=['transcript.jsonl','invocations.jsonl','bundle.json','run.json','status.json','metrics.json'];
const DAY=86400000;

function writeJsonAtomic(file,data) {
  const tmp=`${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp,JSON.stringify(data));
  fs.renameSync(tmp,file);
}

/**
 * Validates wake_on (agent units) against the hooks this setup offers; returns
 * {wake_on (as given), wake_on_mgdl (thresholds converted)} or {error}.
 */
export function parseWakeOn(wakeOn,{obs=null,units='mmol'}={}) {
  if(!Array.isArray(wakeOn)||wakeOn.some(h=>typeof h!=='string'))return {error:'wake_on must be an array of strings (e.g. ["meal","alarm","below:4.5"])'};
  const offered=obs?availableHooks(obs):HOOKS.map(h=>h.split(':')[0]),out=[];
  for(const raw of wakeOn) {
    const h=raw.trim().toLowerCase(),m=/^(below|above):\s*(\d+(?:\.\d+)?)$/.exec(h);
    if(m) {
      if(!offered.includes(m[1]))return {error:`wake_on "${raw}": glucose thresholds need a real-time CGM, which this setup does not have`};
      const mg=units==='mgdl'?Number(m[2]):Number(m[2])*MGDL_PER_MMOL;
      if(!(mg>=40&&mg<=400))return {error:`wake_on "${raw}": threshold must be within ${fmtG(40,units)}–${fmtG(400,units)} ${unitLabel(units)}`};
      out.push(`${m[1]}:${Number(mg.toFixed(1))}`);
    } else if(offered.includes(h)&&!['below','above'].includes(h))out.push(h);
    else return {error:`wake_on "${raw}" is not a hook; use any of ${offered.map(o=>['below','above'].includes(o)?`${o}:X`:o).join(', ')}`};
  }
  return {wake_on:wakeOn,wake_on_mgdl:[...new Set(out)]};
}

/**
 * Parses a model reply into {action, wait_minutes, note, wake_on?, wake_on_mgdl?} or {error}. Accepts
 * the `act` tool call or, as a fallback, a JSON object in the text. Validates the action against the
 * instance's action specs and wake_on against the hooks of the observation (ctx.obs, ctx.units).
 * ctx.minWait raises wait_minutes (decision gating), ctx.hidden lists action types not offered.
 */
export function parseReply(res,world,ctx={}) {
  return parseActReply(res,{validate:a=>validateAction(world,a),parseWakeOn,obs:ctx.obs??null,units:ctx.units??'mmol',
    minWait:ctx.minWait??WAIT_MIN,hidden:ctx.hidden??[],hourly:ctx.hourly===true});
}

/** In-process stepper over a SimEnv for the controller (action ids t<turn>, t<turn>-w<k>, warm<k>). */
function envStepper(env) {
  const wrap=r=>({observation:r.observation,receipt:r.info.action_result,done:env.done()});
  return {
    current:()=>({observation:env.observe(),done:env.done()}),
    step:(action,rationale,{turn,k,warmup}={})=>wrap(env.step({action_id:warmup?`warm${k}`:k?`t${turn}-w${k}`:`t${turn}`,expected_step:env.step_count,
      action,rationale:String(rationale??'').slice(0,4000)})),
  };
}

/**
 * Starts the scored episode after warm-up on the same SimEnv: clears the trajectory, evaluator
 * states, action cache and running metrics, so that the exported bundle (and every score computed
 * from it) covers only the scored period. The world (physiology, devices, sensors, scenario) runs on.
 */
export function rebaseEpisode(env) {
  const m=env.world.metrics;
  for(const k of Object.keys(m))m[k]=k==='min_glucose'?Infinity:k==='max_glucose'?-Infinity:0;
  env.transitions=[];env.evaluator=[];env.cache={};
  env.initialObservation=env.observe();env.recordEvaluator();
}

/**
 * Runs one episode. instance: {id?, factors?, spec} or a bare spec. model: from createModel().
 * Returns {state:'done'|'incomplete'|'error', reason, turns}.
 * Options: track ('full' | 'assisted': sets spec.self_care; omitted = the spec as given),
 * suite (label for status.json), retry ({tries, baseDelayMs} for API calls),
 * maxConsecutiveErrors (3), keepTurns (12; agentOptions.keep_turns wins), onTurn(line) progress callback,
 * agentOptions (src/bench/agent-options.mjs: history_hours, warmup_days, min_decision_minutes,
 * max_decisions_per_day, memory, memory_mode, keep_turns, reasoning_effort, samples, simulate, ...).
 * `hours` is the scored horizon; warmup_days are simulated before it with usual care, summarized in
 * the system prompt and excluded from the bundle (manifest.config.start_time / horizon_minutes are
 * the scored period; manifest.warmup and bench.warmup record the warm-up).
 */
export async function runEpisode({instance,repeat=0,model:shared,outDir,hours=24,agentUnits='mmol',maxTurns=200,
  suite=null,track=null,retry={},maxConsecutiveErrors=3,keepTurns=KEEP_TURNS,onTurn,agentOptions=null}={}) {
  if(!shared?.complete)throw new Error('runEpisode needs a model with complete()');
  if(!outDir)throw new Error('runEpisode needs outDir');
  const opts=parseAgentOptions({keep_turns:keepTurns,...(agentOptions??{})});
  // Stateful models (scripted policies) hand out a fresh copy per episode; API adapters are shared.
  const model=traceModel(await configureModel(shared.forEpisode?.()??shared,opts),outDir);
  const baseSpec0=instance?.spec??instance,instanceId=instance?.id??baseSpec0?.id??'instance';
  let baseSpec=track?trackSpec(baseSpec0,track):baseSpec0;
  if(opts.memory==='notes+profile')baseSpec={...baseSpec,overrides:{...(baseSpec.overrides??{}),profile_switch:{...(baseSpec.overrides?.profile_switch??{}),enabled:true}}};
  const spec=baseSpec;
  const units=agentUnits==='mgdl'||agentUnits==='mg/dL'?'mgdl':'mmol';
  fs.mkdirSync(outDir,{recursive:true});
  for(const f of EPISODE_FILES)fs.rmSync(path.join(outDir,f),{force:true});
  fs.rmSync(path.join(outDir,'invocations.jsonl'),{force:true});
  const started=new Date().toISOString();
  const optsRecord={version:AGENT_OPTIONS_VERSION,...opts};
  const baseStatus={model:model.name,suite,track,instance:instanceId,repeat,harness_version:HARNESS_VERSION,agent_units:units,hours,
    agent_options:optsRecord,agent_options_changed:nonDefaultOptions(opts)};
  writeJsonAtomic(path.join(outDir,'status.json'),{state:'running',reason:null,turns:0,started,finished:null,...baseStatus});
  const transcriptFile=path.join(outDir,'transcript.jsonl');
  fs.writeFileSync(transcriptFile,'');
  const writeLine=line=>{fs.appendFileSync(transcriptFile,JSON.stringify(line)+'\n');onTurn?.(line);};

  const stats=newStats();
  let env,state='done',reason=null,turn=0,warmup=null;
  try {
    const seed=(spec.seed??0)+repeat,H=Math.round(hours*60),W=opts.warmup_days;
    const scored=buildInstanceConfig({...spec,seed,horizon_minutes:H});
    const scoredStart=Date.parse(scored.start_time);
    const cfg=W>0?buildInstanceConfig({...spec,seed,start_time:new Date(scoredStart-W*DAY).toISOString(),horizon_minutes:H+W*1440}):scored;
    env=new SimEnv(cfg);
    const world=env.world,stepper=envStepper(env);
    const records=RecordBook.fromObservation(env.observe());
    let warmupText=null;
    if(W>0) {
      const w=await runWarmup(stepper,{untilMs:scoredStart,selfCare:cfg.self_care?.mode,records});
      if(env.world.terminated)throw new Error(`warm-up failed: ${env.error}`);
      rebaseEpisode(env);
      warmupText=records.warmupText(scoredStart-W*DAY,scoredStart,{units,who:cfg.self_care?.mode==='assisted'?'the person (self-care)':'the person (usual care)'});
      warmup={days:W,from:cfg.start_time,to:scored.start_time,steps:w.steps,policy:cfg.self_care?.mode==='assisted'?'self_care':'patient',
        summary_chars:warmupText.length};
    }
    const obs0=env.observe();
    const view0=agentView(obs0,opts);
    const system=systemPrompt({instance,obs:view0,units,config:cfg,scanTimes:world.cgm?.modality==='flash'?world.scanTimes():null,hours,prompt_revision:opts.prompt_revision})
      +optionsPromptText(opts,{days:Math.ceil(H/1440),warmupText,profileAvailable:!!obs0.action_specs.SET_PROFILE,ownRecords:obs0.information?.own_records===true});
    const desc=opts.simulate?publicDescription({...spec,seed}):null;
    const r=await runController({stepper,model,system,opts,units,validate:a=>validateAction(world,a),parseWakeOn,desc,records,
      scoredStart,horizonMinutes:H,maxTurns,maxConsecutiveErrors,retry,writeLine,stats});
    turn=r.turns;
    const stopReason={api:'api_error',format:'format_errors',max_turns:'max_turns'}[r.stopKind]??null;

    if(env.world.terminated) {state='error';reason=`simulation terminated: ${env.error??'model error'}`;}
    else if(stopReason) {
      state='incomplete';reason=stopReason;
      // Finish the remaining horizon without intervention so the episode can still be scored.
      while(!env.done()) {
        env.step({action_id:`fin-${env.step_count}`,expected_step:env.step_count,action:{type:'WAIT'},rationale:`harness: ${stopReason}; remaining horizon with WAIT`});
        stats.env_steps++;
      }
    }

    const bundle=env.exportBundle();
    if(warmup) {
      // The scored period only: scoring (src/bench/score.mjs) reads start_time and horizon_minutes.
      bundle.manifest.config={...bundle.manifest.config,start_time:scored.start_time,horizon_minutes:H};
      bundle.manifest.warmup=warmup;
    }
    bundle.bench={harness_version:HARNESS_VERSION,model:model.name,adapter:model.adapter??null,suite,instance:instanceId,repeat,
      factors:instance?.factors??null,agent_units:units,state,reason,turns:turn,agent_options:optsRecord,...(warmup?{warmup}:{})};
    writeJsonAtomic(path.join(outDir,'bundle.json'),bundle);
    const run=runFromBundle(bundle,{id:`${instanceId}/r${repeat}`});
    run.policy=model.name;
    if(instance?.factors)run.factors=instance.factors;
    writeJsonAtomic(path.join(outDir,'run.json'),run);
  } catch(e) {
    state='error';reason=String(e?.stack??e).slice(0,2000);
  }
  const decided=stats.decisions;
  const s={...stats,mean_latency_ms:turn?Math.round(stats.latency_ms/turn):null,
    mean_wait_minutes:decided>0?stats.waits_requested_minutes/decided:null};
  writeJsonAtomic(path.join(outDir,'status.json'),{state,reason,turns:turn,started,finished:new Date().toISOString(),...baseStatus,
    ...(warmup?{warmup}:{}),stats:s});
  return {state,reason,turns:turn};
}
