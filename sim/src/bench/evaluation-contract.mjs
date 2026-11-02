import {episodeMetrics,episodeScore,trueGrid} from './score.mjs';

export function scoredBundle(bundle,evaluation={}){
  const minutes=(evaluation.agent_options?.warmup_days??0)*1440;
  if(!minutes)return bundle;
  const config=bundle.manifest.config,start=Date.parse(config.start_time)+minutes*60000;
  return {...bundle,manifest:{...bundle.manifest,config:{...config,start_time:new Date(start).toISOString(),horizon_minutes:config.horizon_minutes-minutes}},
    evaluator_only:{...bundle.evaluator_only,states:bundle.evaluator_only.states.filter(s=>Date.parse(s.time)>=start),events:bundle.evaluator_only.events.filter(e=>Date.parse(e.at)>=start)},
    trajectory:bundle.trajectory.filter(r=>Date.parse(r.next_observation.virtual_time)>start)};
}
export function configuredScore(bundle,evaluation={}){
  return episodeScore(episodeMetrics(scoredBundle(bundle,evaluation)),evaluation.weights,{version:evaluation.scoring_version??'COGI-4-8/v1'});
}
export function configuredChecks(bundle,stats,transcript,expectedConfig,evaluation={}){
  const opts=evaluation.agent_options??stats.agent_options??{},start=Date.parse(expectedConfig.start_time),horizon=expectedConfig.horizon_minutes;
  const scoredStart=start+(opts.warmup_days??0)*1440*60000,interval=(opts.fixed_interval_minutes??60)*60000;
  const fixed=transcript.filter(r=>r.parsed&&r.receipt&&r.decision_kind==='fixed'),hourly=opts.decision_schedule==='hourly';
  const expectedFixed=hourly?Math.ceil((horizon-(opts.warmup_days??0)*1440)*60000/interval):0;
  const truth=bundle.evaluator_only.states,grid=trueGrid(bundle);
  return {horizon:bundle.manifest.config.horizon_minutes===horizon,
    steps:bundle.metrics.steps===bundle.trajectory.length,truth_points:truth.length===bundle.trajectory.length+1,
    elapsed:bundle.metrics.elapsed_minutes===horizon,complete:bundle.metrics.completed_horizon===true,
    completed_horizon:bundle.metrics.completed_horizon===true,
    fixed_hours:!hourly||(stats.fixed_decisions===expectedFixed&&fixed.length===expectedFixed),
    fixed_grid:!hourly||fixed.every((r,i)=>Date.parse(r.sim_time)===scoredStart+i*interval),
    truth_grid:truth.every((r,i)=>Number.isFinite(r.true_glucose_mg_dl)&&(!i||Date.parse(r.time)>Date.parse(truth[i-1].time)))&&grid.length===Math.ceil(horizon/5),
    extra_cap:!hourly||Object.values(stats.extra_decisions_by_local_day??{}).every(n=>n<=(opts.max_extra_decisions_per_day??6))};
}
