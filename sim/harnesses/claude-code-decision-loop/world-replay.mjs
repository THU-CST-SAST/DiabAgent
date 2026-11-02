import {isDeepStrictEqual} from 'node:util';

export function replayWorldEvidence(bundle,expectedConfig,createEnv){
  const serial=x=>JSON.parse(JSON.stringify(x));
  const env=createEnv(structuredClone(expectedConfig)),initial=serial(env.observe());
  for(const row of bundle.trajectory)env.step({action_id:row.action_id,expected_step:row.step,action:row.action,rationale:row.rationale});
  const replayed=serial(env.exportBundle()),checks={
    initial_observation:isDeepStrictEqual(initial,bundle.initial_observation),
    final_config_from_recorded_actions:isDeepStrictEqual(replayed.manifest.config,bundle.manifest.config),
    all_transitions:isDeepStrictEqual(replayed.trajectory,bundle.trajectory),
    all_truth_states:isDeepStrictEqual(replayed.evaluator_only.states,bundle.evaluator_only.states),
    all_metrics:isDeepStrictEqual(replayed.metrics,bundle.metrics)
  };
  return {valid:Object.values(checks).every(Boolean),checks,steps:env.step_count,
    original_config_still_equal_final:isDeepStrictEqual(serial(expectedConfig),bundle.manifest.config),
    final_config_changed_by_recorded_actions:!isDeepStrictEqual(serial(expectedConfig),replayed.manifest.config),
    scope:'Exact CPU reconstruction from original frozen config and every recorded action; no new model request or permissive config-field omission.'};
}
