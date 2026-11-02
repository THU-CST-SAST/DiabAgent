#!/usr/bin/env node
// Agent process of the local Harbor runner (src/benchmark/agents.mjs). Talks to the task only
// through the task's own `sim` client module (SWEET_SIM_CLI = <task>/environment/cli/sim.mjs, the
// HTTP API at SWEET_SIM_URL) and reads the public task facts (SWEET_SIM_PUBLIC = public.json).
// Writes AGENT_LOGS_DIR/{actions.jsonl, status.json} (and transcript.jsonl for llm). Transport
// errors talking to the sidecar (e.g. `fetch failed` on a keep-alive socket the server closed while
// the agent was thinking) are retried with backoff (src/benchmark/retry.mjs; step ids are
// idempotent) and logged to AGENT_LOGS_DIR/retries.jsonl; status.json counts them.
// Outcome (read by the runner, src/benchmark/failures.mjs): status.json state 'done' and exit 0 when
// the agent reached the horizon; state 'incomplete' (LLM gave up: API errors, format errors, max
// turns) and exit 3; state 'error' (exception) and exit 1. Not 'done' states carry a classified
// `reason` (auth, rate_limit, server, network, sim_transport, api_error, format, max_turns, crash),
// the last `error` message and `error_status` (HTTP status) when known.
//
//   node agent-main.mjs --agent wait|patient|oref0|causal [--fast]
//   node agent-main.mjs --agent llm --model <model.json> [--units mmol|mgdl] [--max-turns 200]
//        [--api-tries 3] [--api-base-delay-ms 2000]   (API retries per call before the agent gives up)
//        [--agent-options '{"history_hours":12,"min_decision_minutes":30,...}']   (src/bench/agent-options.mjs)
// Policy agents (wait, patient, oref0, causal) honour the decision-gating options: the policy is
// consulted at most every min_decision_minutes and max_decisions_per_day times per day (urgent alarms
// always), with the notices since its last decision; other steps are WAIT. warmup_days only marks the
// first days as unscored for them (they play the whole horizon themselves).
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {patientPolicy} from '../policies/patient.mjs';
import {oref0Policy} from '../policies/oref0.mjs';
import {makeCausalAgent} from '../oracle/causal.mjs';
import {withRetry} from './retry.mjs';
import {classifyError,EXIT_INCOMPLETE} from './failures.mjs';
import {parseAgentOptions,AGENT_OPTIONS_VERSION,nonDefaultOptions,gatingActive} from '../bench/agent-options.mjs';
import {URGENT_EVENTS} from '../env/hooks.mjs';
import {executionProtocol,effectiveAgentOptions} from './execution-protocol.mjs';
import {hourlyPolicy,observationOffsetMs} from '../bench/hourly-policy.mjs';

const args=process.argv.slice(2),opt={};
for(let i=0;i<args.length;i++){const k=args[i].replace(/^--/,'');opt[k]=args[i+1]===undefined||args[i+1].startsWith('--')?'true':args[++i];}
const logs=process.env.AGENT_LOGS_DIR||'.';
fs.mkdirSync(logs,{recursive:true});
const retryLog=path.join(logs,'retries.jsonl');
const client=withRetry(await import(pathToFileURL(process.env.SWEET_SIM_CLI).href),{
  onRetry:r=>{const line={time:new Date().toISOString(),...r};fs.appendFileSync(retryLog,JSON.stringify(line)+'\n');console.error(`agent: retrying ${r.fn} (attempt ${r.attempt}, ${r.delay_ms} ms): ${r.error}`);}});
const pub=JSON.parse(fs.readFileSync(process.env.SWEET_SIM_PUBLIC,'utf8'));
const requestedInput=opt['agent-options']&&opt['agent-options']!=='true'?opt['agent-options']:null;
const requestedOptions=parseAgentOptions(requestedInput);
const agentOpts=effectiveAgentOptions(opt.agent,requestedInput);
const started=new Date().toISOString();
const writeStatus=s=>fs.writeFileSync(path.join(logs,'status.json'),JSON.stringify({agent:opt.agent,started,finished:new Date().toISOString(),...s,
  execution_protocol:executionProtocol(opt.agent,agentOpts),
  transport_retries:client.retryStats.retries,...(client.retryStats.retries?{transport_retries_by_fn:client.retryStats.by_fn}:{})},null,1));

/**
 * Plays a per-step policy (obs => {action, rationale}) to the horizon over HTTP. With decision
 * gating (agent options) the policy is consulted only when allowed, with the notices held since its
 * last consultation; the other steps are WAIT.
 */
async function playPolicy(name,decide) {
  const id=await client.episodeId(),out=fs.openSync(path.join(logs,'actions.jsonl'),'w');
  let cur=await client.current(id),n=0,rejected=0,actions=0;
  const gate=gatingActive(agentOpts),DAY=86400000,o0=cur.observation;
  const start=Date.parse(o0.virtual_time)-Math.round(o0.elapsed_minutes*60000);
  const hourly=agentOpts.decision_schedule==='hourly'?hourlyPolicy(decide,{start,end:start+pub.horizon_minutes*60000,
    offsetMs:observationOffsetMs(o0),extraLimit:agentOpts.max_extra_decisions_per_day,
    onDecision:decision=>fs.appendFileSync(path.join(logs,'decisions.jsonl'),JSON.stringify(decision)+'\n')}):null;
  let last=-Infinity,held=[];const perDay=[],gstats={decisions:0,urgent_wakes:0,held_steps:0};
  const gated=obs=>{
    const t=Date.parse(obs.virtual_time),day=Math.floor((t-start)/DAY);
    held.push(...obs.events);
    const urgent=obs.events.some(e=>URGENT_EVENTS.includes(e.type));
    const ok=t-last>=agentOpts.min_decision_minutes*60000&&(agentOpts.max_decisions_per_day==null||(perDay[day]??0)<agentOpts.max_decisions_per_day);
    if(!ok&&!urgent){gstats.held_steps++;return {action:{type:'WAIT'},rationale:'decision gating: not consulted'};}
    if(!ok)gstats.urgent_wakes++;
    const d=decide({...obs,events:held});held=[];last=t;perDay[day]=(perDay[day]??0)+1;gstats.decisions++;
    return d;
  };
  try {
    while(!cur.done) {
      const d=hourly?hourly.decide(cur.observation):gate?gated(cur.observation):decide(cur.observation);
      const r=await client.step(id,d.action,String(d.rationale??'').slice(0,4000),{prefix:name,expected_step:cur.step});
      const st=r.info?.action_result?.status;
      if(d.action.type!=='WAIT'){actions++;fs.writeSync(out,JSON.stringify({step:cur.step,time:cur.observation.virtual_time,action:d.action,
        rationale:String(d.rationale??'').slice(0,300),status:st??null,reason:r.info?.action_result?.reason??null})+'\n');}
      if(st==='rejected')rejected++;
      cur={observation:r.observation,step:r.info.step,done:r.terminated||r.truncated};n++;
    }
  } finally {fs.closeSync(out);}
  return {steps:n,actions,rejected,...(hourly?{gating:hourly.stats}:gate?{gating:{...gstats,decisions_by_day:perDay}}:{})};
}

try {
  let stats;
  if(opt.agent==='wait')stats=await playPolicy('wait',()=>({action:{type:'WAIT'},rationale:'no intervention'}));
  else if(opt.agent==='patient')stats=await playPolicy('patient',patientPolicy());
  else if(opt.agent==='oref0')stats=await playPolicy('oref0',oref0Policy);
  else if(['standard','guideline','hcl','oref1'].includes(opt.agent)) {   // classical care baselines (docs/BASELINES.zh-CN.md)
    const {POLICIES}=await import('../viz/run.mjs');
    stats=await playPolicy(opt.agent,POLICIES[opt.agent]({decision_schedule:'event-driven'}));
  }
  else if(opt.agent==='causal') {
    const agent=makeCausalAgent(pub.description,{fast:opt.fast==='true'});
    stats=await playPolicy('causal',agent.policy);
    fs.writeFileSync(path.join(logs,'causal.decisions.json'),JSON.stringify({options:agent.options??null,decisions:agent.log.decisions,timing:agent.log.timing}));
  } else if(opt.agent==='llm') {
    const {runLlmAgent}=await import('./llm-agent.mjs');
    const retry={...(opt['api-tries']?{tries:Number(opt['api-tries'])}:{}),...(opt['api-base-delay-ms']?{baseDelayMs:Number(opt['api-base-delay-ms'])}:{})};
    stats=await runLlmAgent({client,pub,modelConfig:opt.model,units:opt.units??'mmol',maxTurns:Number(opt['max-turns']??200),logsDir:logs,retry,agentOptions:agentOpts});
  } else throw new Error(`unknown agent ${opt.agent}`);
  const state=stats.state??'done';
  stats.agent_options??={version:AGENT_OPTIONS_VERSION,...agentOpts};
  stats.requested_agent_options={version:AGENT_OPTIONS_VERSION,...requestedOptions};
  stats.agent_options_changed??=nonDefaultOptions(agentOpts);
  writeStatus({...stats,state});
  console.log(JSON.stringify({agent:opt.agent,...stats}));
  if(state!=='done'){console.error(`agent ${opt.agent}: stopped before the horizon (${stats.reason}): ${stats.error??''}`);process.exitCode=EXIT_INCOMPLETE;}
} catch(e) {
  writeStatus({...(e?.stats??{}),state:'error',reason:classifyError(e),error:String(e?.message??e).slice(0,1000),
    error_status:e?.status??null,error_scope:e?.failure_scope??null,stack:String(e?.stack??e).slice(0,2000)});
  console.error(`agent ${opt.agent}: ${e?.stack??e}`);
  process.exit(1);
}
