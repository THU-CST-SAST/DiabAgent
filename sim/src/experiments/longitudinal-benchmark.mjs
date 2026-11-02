// Experiment 3 in the unified benchmark format (docs/BENCH.zh-CN.md §8, sweet-sim.benchmark/v1):
// one Harbor task per MVP person (src/experiments/longitudinal.mjs EXP3_PERSONS), 7 days, full
// track, verifier 'daily' (day_<k>_reward, learning_slope). The mis-programmed profile is part of
// the task spec (sidecar only); the true parameters and the mismatch factors go to task.toml
// [metadata.evaluator_only] (evaluator side, never in the agent container or public.json).
//
//   exp3Tasks({days})        [{task_id, spec, hours, verifier:'daily', metadata}]
//   exp3Experiment({days})   experiment entry for buildBenchmark (src/benchmark/build.mjs)
//
// Agents: fixed = the built-in `patient` agent (identical policy); adaptive =
// `cmd:scripts/exp3-agent-adaptive.mjs` (same policy + memory + SET_PROFILE over the sim client).
import {EXP3_PERSONS,EXP3_VERSION,mismatchSpec} from './longitudinal.mjs';
import {ADAPTIVE_VERSION} from './longitudinal-agent.mjs';

export const EXP3_EXPERIMENT_ID='exp3-longitudinal';
export const EXP3_AGENTS=Object.freeze(['patient','cmd:scripts/exp3-agent-adaptive.mjs']);
const r4=v=>Number(v.toFixed(4));

export function exp3Tasks({days=7,persons=EXP3_PERSONS}={}) {
  return persons.map(p=>{
    const {spec,factors,truth}=mismatchSpec(p.spec,{days});
    return {task_id:`exp3-${p.id}`,spec,hours:days*24,verifier:'daily',
      metadata:{instance_id:p.id,experiment_version:EXP3_VERSION,
        evaluator_only:{truth_basis:truth.basis,
          true_parameters:{basal_u_h:r4(truth.basal_u_h),basal_u_day:r4(truth.basal_u_day),isf_mg_dl_per_u:r4(truth.isf_mg_dl_per_u),
            carb_ratio_g_per_u:r4(truth.carb_ratio_g_per_u),sensitivity:r4(truth.sensitivity)},
          mismatch_factors:factors}}};
  });
}

export function exp3Experiment({days=7,persons=EXP3_PERSONS,references=['wait','patient','oref0']}={}) {
  return {id:EXP3_EXPERIMENT_ID,title:'实验 3 长期自我改进 / Exp 3 longitudinal self-improvement',track:'full',repeats:1,
    description:`${persons.length} persons with deliberately mis-programmed profiles (basal/ISF/CR off by 20-40 %), ${days} days each; `+
      `SET_PROFILE enabled; fixed (patient) vs adaptive (${ADAPTIVE_VERSION}). Daily scores and learning slope from the daily verifier.`,
    agents:[...EXP3_AGENTS],primary_metric:'reward',curve_metric:'day_reward',horizon_days:days,references,
    tasks:exp3Tasks({days,persons})};
}
