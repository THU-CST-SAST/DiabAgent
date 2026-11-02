import {HourlySchedule} from './hourly-schedule.mjs';
import {URGENT_EVENTS} from '../env/hooks.mjs';
import {parseAgentOptions,gatingActive} from './agent-options.mjs';

export const CLASSICAL_BASELINES=Object.freeze(['standard','guideline','hcl','oref1']);
export const BASELINE_CADENCE_VERSION='classical-baselines/hourly-urgent-v1';

/** Resolve defaults before normalization loses whether the caller specified a schedule. */
export function baselineAgentOptions(agent,input=null) {
  const raw=typeof input==='string'?JSON.parse(input.trim()||'{}'):input??{};
  const opts=parseAgentOptions(raw);
  const explicit=Object.keys(raw).some(key=>key==='decisionSchedule'||key.replaceAll('-','_')==='decision_schedule');
  return CLASSICAL_BASELINES.includes(agent)&&!explicit&&!gatingActive(opts)
    ?parseAgentOptions({...opts,decision_schedule:'hourly'}):opts;
}

export function baselinePolicyProtocol(opts) {
  return opts.decision_schedule==='hourly'
    ?{kind:'policy-hourly',version:BASELINE_CADENCE_VERSION,fixed_interval_minutes:60,
      max_extra_decisions_per_day:opts.max_extra_decisions_per_day,
      extra_triggers:[...URGENT_EVENTS],label:`Baseline: fixed 60 min + up to ${opts.max_extra_decisions_per_day} urgent decisions per local day`}
    :{kind:'policy-per-step',fixed_interval_minutes:5,label:'Baseline: explicit native 5 min policy decisions'};
}

/** Factories still see no patient config/env; scheduling uses the public observation clock. */
export function standardBaselinePolicy(agent,factory,input=null) {
  const opts=baselineAgentOptions(agent,input),raw=factory();let hourly=null;
  if(gatingActive(opts))throw Error('In-process baselines use hourly or explicit event-driven mode; legacy gating belongs to the native agent runner');
  const decide=obs=>{
    if(opts.decision_schedule!=='hourly')return raw(obs);
    hourly??=hourlyPolicy(raw,{start:Date.parse(obs.virtual_time)-Math.round(obs.elapsed_minutes*60000),end:Infinity,
      offsetMs:observationOffsetMs(obs),extraLimit:opts.max_extra_decisions_per_day});
    return hourly.decide(obs);
  };
  decide.execution_protocol=baselinePolicyProtocol(opts);
  Object.defineProperty(decide,'gating',{get:()=>hourly?.stats??null});
  return decide;
}

export function observationOffsetMs(obs) {
  if(typeof obs.local_time!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(obs.local_time))throw Error('Missing public local clock');
  const local=Date.parse(String(obs.local_time).replace(' ','T')+':00Z');
  const utc=Date.parse(obs.virtual_time);
  if(!Number.isFinite(local)||!Number.isFinite(utc))throw Error('Missing public local clock');
  return Math.round((local-utc)/60000)*60000;
}

/** Only controller consultation changes; the simulator still advances on its original grid. */
export function hourlyPolicy(policy,{start,end,offsetMs=0,extraLimit=6,intervalMinutes=60,triggers=URGENT_EVENTS,onDecision=()=>{}}) {
  const schedule=new HourlySchedule({start,end,offsetMs,extraLimit,intervalMinutes});
  const stats={decisions:0,fixed_decisions:0,urgent_wakes:0,held_steps:0,extra_decisions_by_local_day:{}};
  let held=[],lastTime=-Infinity;
  const decide=obs=>{
    const t=Date.parse(obs.virtual_time);
    if(!Number.isFinite(t)||t<start||t>=end||t<=lastTime)throw Error('Policy clock must advance within the registered horizon');
    lastTime=t;held.push(...(obs.events??[]));
    const urgent=(obs.events??[]).some(event=>triggers.includes(event.type));
    if(!schedule.isFixed(t)&&!(urgent&&schedule.canExtra(t))) {
      stats.held_steps++;
      return {action:{type:'WAIT'},rationale:'hourly policy: not consulted; original simulator step'};
    }
    const kind=schedule.begin(t),input={...obs,events:held};
    held=[];
    const result=policy(input);
    stats.decisions++;stats.fixed_decisions=schedule.fixed;
    stats.urgent_wakes+=kind==='extra'?1:0;
    stats.extra_decisions_by_local_day={...schedule.extras};
    onDecision({time:obs.virtual_time,elapsed_minutes:(t-start)/60000,kind,action:result.action});
    return result;
  };
  return {decide,stats};
}
