// LLM agent for the local Harbor runner: the bench harness protocol (docs/BENCH.zh-CN.md §3:
// one `act` tool call per turn, wait + wake hooks, 12-turn memory with a day log, 3 consecutive
// format errors end control) played as a black box over the task's HTTP API. Reuses the bench
// prompts (src/bench/prompt.mjs), model adapters (src/bench/models) and wake_on parsing
// (src/bench/harness.mjs parseWakeOn). Differences from the in-process harness, by construction:
// the system prompt is built from public.json (not the instance config) and actions are checked
// against observation.action_specs (not the World). If the agent stops early (API errors, format
// errors, max turns) the verifier plays the rest with WAIT, as the harness does, and the runner marks
// the trial agent_failed (src/benchmark/failures.mjs): the returned stats carry state 'incomplete',
// a classified `reason` (auth | rate_limit | server | network | api_error | format | max_turns), the
// last `error` and its HTTP `error_status`. Exceptions thrown mid-episode carry the stats so far as e.stats.
// The decision loop is the shared controller (src/bench/controller.mjs) with the agent options of
// src/bench/agent-options.mjs (history window, decision gating, multi-day memory, warm-up, samples,
// simulate). Warm-up over HTTP: the first warmup_days of the task's horizon are played by usual
// care (patient baseline, or nothing in assisted care) and summarized into the system prompt; the
// task needs a daily verifier so the runner can score the remaining days only (trial.json `scored`).
import fs from 'node:fs';
import path from 'node:path';
import {systemPrompt,optionsPromptText,publicPromptConfig,WAIT_MIN} from '../bench/prompt.mjs';
import {createModel,loadModelConfig} from '../bench/models/index.mjs';
import {traceModel} from '../bench/models/trace.mjs';
import {replayPrefix} from '../bench/models/replay-prefix.mjs';
import {parseWakeOn} from '../bench/harness.mjs';
import {parseAgentOptions,AGENT_OPTIONS_VERSION,nonDefaultOptions} from '../bench/agent-options.mjs';
import {runController,runWarmup,newStats,parseActReply,configureModel,agentView,wakeText as controllerWakeText} from '../bench/controller.mjs';
import {RecordBook} from '../bench/records.mjs';
import {MAX_WAIT_MINUTES,wakeTracker} from '../env/hooks.mjs';
import {classifyError} from './failures.mjs';
import {createSkillContext} from '../bench/skill-context.mjs';

const DAY=86400000;

/** Validates an action against observation.action_specs (same rules as src/sim/actions.mjs validateAction). */
export function validateAgainstSpecs(specs,action) {
  if(!action||typeof action!=='object'||Array.isArray(action)||typeof action.type!=='string')throw new Error('Action must be an object with a type');
  const spec=specs?.[action.type];
  if(!spec)throw new Error(`${action.type} is not available in this instance; available: ${Object.keys(specs??{}).join(', ')}`);
  for(const k of Object.keys(action))if(k!=='type'&&(!(k in spec)||k==='note'))throw new Error(`Unknown action field: ${k}`);
  for(const [k,r] of Object.entries(spec)) {
    if(k==='note')continue;
    const v=action[k];
    if(r.enum){if(!r.enum.includes(v))throw new Error(`${k} must be one of ${r.enum.join(', ')}`);continue;}
    if(v===undefined&&r.optional)continue;
    if(typeof v!=='number'||!Number.isFinite(v)||(r.exclusive_min?v<=r.min:v<r.min)||v>r.max||(r.integer&&!Number.isInteger(v)))
      throw new Error(`${k} must be ${r.integer?'an integer ':''}in ${r.exclusive_min?'(':'['}${r.min}, ${r.max}]`);
  }
  if(action.type==='TEMP_BASAL'&&(action.rate_u_h===undefined)===(action.percent===undefined))throw new Error('TEMP_BASAL needs exactly one of rate_u_h or percent');
}

/** Model reply -> {action, wait_minutes, note, wake_on?, wake_on_mgdl?} or {error} (harness parseReply semantics). */
export function parseRemoteReply(res,obs,{units='mmol',minWait=WAIT_MIN,hidden=[],hourly=false}={}) {
  return parseActReply(res,{validate:a=>validateAgainstSpecs(obs.action_specs,a),parseWakeOn,obs,units,minWait,hidden,hourly});
}

/**
 * stepWithHooks (src/env/hooks.mjs) over HTTP: applies `action`, then WAIT steps until wait_minutes
 * elapse or a subscribed hook fires on information the agent receives.
 */
export async function remoteStepWithHooks(client,id,cur,{action,rationale='',wait_minutes=30,wake_on,prefix='llm',waitRationale='waiting',onStep,wakeAfterAction}) {
  const wait=Math.max(5,Math.min(MAX_WAIT_MINUTES,Math.round(Number(wait_minutes)||5)));
  const t0=Date.parse(cur.observation.virtual_time);
  const tr=wakeTracker({wake_on,until:t0+wait*60000,lastReadingTime:cur.observation.glucose?.time??null});
  let steps=0,step=cur.step;
  let res=await client.step(id,action??{type:'WAIT'},rationale,{prefix,expected_step:step});
  steps++;step=res.info.step;const receipt=res.info.action_result;onStep?.(res);tr.observe(res.observation);
  let done=res.terminated||res.truncated;
  if(wakeAfterAction&&!done)tr.wakeAfterAction(wakeAfterAction(receipt)??null);
  while(!tr.done(Date.parse(res.observation.virtual_time),done)) {
    res=await client.step(id,{type:'WAIT'},waitRationale,{prefix,expected_step:step});
    steps++;step=res.info.step;onStep?.(res);tr.observe(res.observation);done=res.terminated||res.truncated;
  }
  return {observation:res.observation,step,done,receipt,elapsed_minutes:(Date.parse(res.observation.virtual_time)-t0)/60000,
    wake_reason:tr.wake??(done?{hook:'end'}:{hook:'timer'}),notices:tr.notices,steps};
}

/** Wake reason text and stats key (src/bench/controller.mjs wakeText). */
export const wakeText=controllerWakeText;

/** The task's sim client as a controller stepper (step ids from the prefix llm-t<turn> / warmup). */
function remoteStepper(client,id,cur0) {
  let step=cur0.step,obs=cur0.observation,done=cur0.done;
  return {
    get observation(){return obs;},
    current:async()=>({observation:obs,done}),
    async step(action,rationale,{turn,warmup}={}) {
      const res=await client.step(id,action,String(rationale??'').slice(0,4000),{prefix:warmup?'warmup':`llm-t${turn}`,expected_step:step});
      step=res.info.step;obs=res.observation;done=!!(res.terminated||res.truncated);
      return {observation:obs,receipt:res.info.action_result,done};
    },
  };
}

/**
 * Runs the LLM agent to the horizon (or until it loses control). `client`: the task's sim client
 * module; `pub`: public.json; `modelConfig`: model config path/object or a model ({complete});
 * `agentOptions`: src/bench/agent-options.mjs (object or JSON). Writes transcript.jsonl into
 * logsDir. Returns stats {state, reason, turns, agent_options, warmup?, ...}.
 */
export async function runLlmAgent(opts) {
  const stats=newStats();
  try {return await playLlm(opts,stats);}
  catch(e){e.stats=stats;throw e;}
}

async function playLlm({client,pub,modelConfig,model:given=null,skillContextConfig=null,skillAssetsRoot=undefined,units='mmol',maxTurns=200,maxConsecutiveErrors=3,keepTurns=null,retry={},logsDir,agentOptions=null},stats) {
  const opts=parseAgentOptions({...(keepTurns?{keep_turns:keepTurns}:{}),...(typeof agentOptions==='string'?JSON.parse(agentOptions||'{}'):agentOptions??{})});
  const cfg=given?null:loadModelConfig(modelConfig);
  const skillContext=createSkillContext(skillContextConfig??cfg?.skill_context,{logsDir,assetsRoot:skillAssetsRoot});
  if(cfg?.harness&&cfg.harness!=='legacy')throw Error(`Unsupported harness ${cfg.harness}; this publication supports only the original controller`);
  const shared=given??await createModel(cfg);
  const configured=await configureModel(shared.forEpisode?.()??shared,opts);
  const model=traceModel(replayPrefix(configured,{logsDir,sourceJob:cfg?.resume_response_job,fallbackJob:cfg?.resume_fallback_response_job,
    allowTransportResume:cfg?.resume_transport_errors===true,interruptedTrials:cfg?.resume_interrupted_trials??[]}),logsDir);
  const id=await client.episodeId();
  const cur0=await client.current(id);
  const obs0=cur0.observation,stepper=remoteStepper(client,id,cur0);
  const startMs=Date.parse(obs0.virtual_time)-Math.round(obs0.elapsed_minutes*60000);
  const W=opts.warmup_days,horizonTotal=pub.horizon_minutes;
  if(W>0&&horizonTotal<=W*1440)throw new Error(`warmup_days ${W} needs a task longer than ${W} days (horizon ${horizonTotal} min); use a multi-day task with the daily verifier`);
  const scoredStart=startMs+W*DAY,horizon=horizonTotal-W*1440;
  const tfile=path.join(logsDir,'transcript.jsonl');fs.writeFileSync(tfile,'');
  const writeLine=l=>fs.appendFileSync(tfile,JSON.stringify(l)+'\n');
  const records=RecordBook.fromObservation(obs0);
  const pc=pub.prompt_context??{};
  const selfCare=pub.self_care??obs0.profile?.self_care??'none';
  let warmupText=null,warmup=null;
  if(W>0) {
    const w=await runWarmup(stepper,{untilMs:scoredStart,selfCare,records});
    warmupText=records.warmupText(startMs,scoredStart,{units,who:selfCare==='assisted'?'the person (self-care)':'the person (usual care)'});
    warmup={days:W,steps:w.steps,policy:selfCare==='assisted'?'self_care':'patient',scored_from_minute:W*1440,summary_chars:warmupText.length};
  }
  const obsNow=(await stepper.current()).observation;
  const view=agentView(obsNow,opts);
  const system=systemPrompt({instance:null,obs:view,units,config:publicPromptConfig(pub),scanTimes:pc.scan_times??null,hours:Math.round(horizon/60),scoring_version:pub.scoring_version??'bench-v0.2',prompt_revision:opts.prompt_revision})
    +optionsPromptText(opts,{days:Math.ceil(horizon/1440),warmupText,profileAvailable:!!obsNow.action_specs.SET_PROFILE,ownRecords:obsNow.information?.own_records===true})
    +(skillContext?.prompt??'');
  const warnings=[];
  if(opts.memory==='notes+profile'&&!obsNow.action_specs.SET_PROFILE)warnings.push('memory notes+profile: this task does not offer SET_PROFILE (profile_switch disabled); notes only');
  if(opts.simulate&&!pub.description)warnings.push('simulate: public.json has no description; simulate calls will fail');
  let r;
  try {
    r=await runController({stepper,model,system,opts,units,skillContext,validate:a=>validateAgainstSpecs(stepper.observation.action_specs,a),
      parseWakeOn,desc:pub.description??null,records,scoredStart,horizonMinutes:horizon,scoringVersion:pub.scoring_version??'bench-v0.2',maxTurns,maxConsecutiveErrors,retry,writeLine,stats});
  } finally {await model.close?.();}
  const reason=r.stopKind==='api'?classifyError(r.errorObj):r.stopKind;
  const optsRecord={version:AGENT_OPTIONS_VERSION,...opts};
  return {state:r.stopKind?'incomplete':'done',reason,turns:r.turns,model:model.name,...stats,agent_options:optsRecord,
    agent_options_changed:nonDefaultOptions(opts),...(warmup?{warmup}:{}),...(warnings.length?{warnings}:{}),
    ...(r.stopKind?{error:r.error,error_status:r.errorObj?.status??null,error_scope:r.errorObj?.failure_scope??null}:{})};
}
