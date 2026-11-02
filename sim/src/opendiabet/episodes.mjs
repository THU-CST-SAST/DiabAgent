// In-process reference episodes for OpenDiabet environments: the bench baselines (wait, patient,
// oref0), the causal-optimal decider (src/oracle/causal.mjs, built from the task's public
// description exactly like the `causal` Harbor agent) and the omniscient decider
// (src/oracle/omniscient.mjs, its plan replayed through SimEnv so it yields an evaluator bundle).
// Every episode is scored with the bench score on its bundle (the Harbor verifier's reward).
//
// Scoring version is pinned here rather than inherited from score.mjs. OpenDiabet v1 is a frozen,
// published set: its environments.jsonl, references.json, baselines.json and every task's
// tests/scoring.json are bench-v0.2, and the per-environment normalization N = (S - S_wait) /
// (S_ref - S_wait) is only meaningful if every policy in it was scored the same way. METRICS-v0.3
// is the default for new Harbor tasks (docs/METRICS-v0.3.zh-CN.md) and scores the same trajectory
// very differently (target 4-8 instead of 3.9-10 mmol/L, plus CV and rate-of-change penalties), and
// that document lists recomputing and recertifying the reference deciders under v0.3 as work not
// yet done. So this runner asks for bench-v0.2 explicitly; pass SCORING to move a set to v0.3 once
// its references have actually been recomputed.
import {buildInstanceConfig} from '../sim/instance.mjs';
import {SimEnv} from '../env/pomdp.mjs';
import {taskBuildSpec} from '../export/harbor.mjs';
import {POLICIES} from '../viz/run.mjs';
import {makeCausalAgent,publicDescription} from '../oracle/causal.mjs';
import {omniscientDecide} from '../oracle/omniscient.mjs';
import {episodeMetrics,episodeScore} from '../bench/score.mjs';

export const REFERENCE_POLICIES={full:['wait','patient','oref0','causal','omniscient'],assisted:['wait','oref0','causal','omniscient']};
export const CHEAP_POLICIES=['wait','patient','oref0'];
/** Scoring version the OpenDiabet v1 set is published under (see the note above). */
export const SCORING_VERSION='bench-v0.2';

/** The spec actually simulated for a track and repeat (seed + r, person seed fixed), 24 h by default. */
export function episodeSpec(spec,{track='full',repeat=0,hours=24}={}) {
  return taskBuildSpec({...spec,seed:spec.seed+repeat},{track,horizonMinutes:Math.round(hours*60)});
}

function play(env,decide,prefix) {
  while(!env.done()) {
    const d=decide(env.observe());
    env.step({action_id:`${prefix}-${env.step_count}`,expected_step:env.step_count,action:d.action,rationale:String(d.rationale??'').slice(0,4000)});
  }
  return env;
}

/**
 * Runs one episode. Returns {policy, score, raw_score, safety_fail, tir, tbr70, tbr54, tar250, mean_mgdl,
 * seconds, bundle, decisions?}. options: {causal: {...makeCausalAgent options}, omniscient: {...}}.
 */
export function runEpisode(buildSpec,policy,options={}) {
  const t0=performance.now();let env,decisions=null,extra={};
  if(policy==='causal') {
    env=new SimEnv(buildInstanceConfig(buildSpec));
    const agent=makeCausalAgent(publicDescription(buildSpec),options.causal??{});
    play(env,agent.policy,'causal');
    decisions={options:agent.options,decisions:agent.log.decisions,beliefs:agent.log.beliefs,timing:agent.log.timing};
  } else if(policy==='omniscient') {
    const r=omniscientDecide(buildSpec,{fast:true,...(options.omniscient??{})});
    const plan=r.plan.map(p=>({at:Date.parse(p.at),action:p.action,label:p.label}));let i=0;
    env=new SimEnv(buildInstanceConfig(buildSpec));
    play(env,obs=>{const t=Date.parse(obs.virtual_time);
      if(i<plan.length&&plan[i].at<=t){const e=plan[i++];return {action:e.action,rationale:`omniscient: ${e.label}`};}
      return {action:{type:'WAIT'},rationale:'omniscient: wait'};},'omniscient');
    decisions={settings:r.settings,plan:r.plan,decisions:r.decisions,stages:r.stages,verified:r.verified,runtime:r.runtime};
    extra={verified:r.verified.ok,plan_actions:r.plan.length};
  } else {
    const f=POLICIES[policy];if(!f)throw new Error(`unknown policy ${policy}`);
    const decide=f(options.agentOptions??null);
    env=play(new SimEnv(buildInstanceConfig(buildSpec)),decide,policy);
    if(decide.execution_protocol)extra={execution_protocol:decide.execution_protocol,baseline_gating:decide.gating};
  }
  const bundle=env.exportBundle(),m=episodeMetrics(bundle),s=episodeScore(m,undefined,{version:options.scoringVersion??SCORING_VERSION});
  const g=m.glucose;
  return {policy,score:s.score,raw_score:s.raw,safety_fail:!!s.safety_fail,scoring_version:options.scoringVersion??SCORING_VERSION,
    tir:g.tir,tbr70:g.tbr70,tbr54:g.tbr54,tar250:g.tar250,mean_mgdl:g.mean,
    seconds:Number(((performance.now()-t0)/1000).toFixed(2)),steps:env.step_count,...extra,bundle,decisions};
}
