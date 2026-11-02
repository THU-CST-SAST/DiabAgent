// One original task per family, one backend and seed; only patient reports differ within a pair.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {generateEnvironment, inspectEnvironment} from '../opendiabet/generate.mjs';
import {TASK_IDS} from '../opendiabet/tasks.mjs';
import {buildInstanceConfig} from '../sim/instance.mjs';
import {SimEnv} from '../env/pomdp.mjs';
import {trueGrid,episodeScore,episodeMetrics} from '../bench/score.mjs';
import {buildBenchmark} from '../benchmark/build.mjs';

export const PROTOCOL='original25-information-pairs/v1';
export const partialRule=task=>({
  T05:'Original missing lunch/snack reports',T06:'Original biased carb estimates',
  T07:'Exercise plan and onset withheld',T08:'Exercise plan and onset withheld',
  T09:'Alcohol report withheld',T10:'Illness report withheld',T11:'Poor-sleep report withheld',
  T12:'Stress is not reported',T13:'Cycle day is not reported',T14:'Prior morning-rise pattern is not reported',
  T15:'Historical and episode meal reports withheld',T16:'Historical and episode meal reports withheld',
  T17:'Historical and episode meal reports withheld',T25:'Original poor carb estimates',
}[task]??'Episode meal and composition reports withheld');

export function informationPair(task) {
  let base;
  for(let attempt=0;attempt<6;attempt++) {
    base=generateEnvironment({task,backend:'pump_pct',setting:'clean',seedIndex:1,attempt});
    if(inspectEnvironment(base).ok)break;
    if(attempt===5)throw new Error(`${task}: original mechanics could not be generated`);
  }
  const complete=structuredClone(base.spec),partial=structuredClone(base.spec);
  complete.self_care=partial.self_care='none';
  complete.overrides.scenario??={};partial.overrides.scenario??={};
  complete.overrides.scenario.announcement={...complete.overrides.scenario.announcement,information_mode:'complete'};
  partial.overrides.scenario.announcement={...partial.overrides.scenario.announcement,information_mode:'native'};
  const mask={};
  if(['T07','T08'].includes(task))mask.exercise=1;
  else if(task==='T09')mask.alcohol=1;
  else if(task==='T10')mask.illness=1;
  else if(task==='T11')mask.sleep_loss=1;
  else if(!['T05','T06','T12','T13','T14','T25'].includes(task))Object.assign(mask,{meal_announcement:1,composition:1});
  partial.overrides.scenario.masking={...partial.overrides.scenario.masking,...mask};
  if(['T15','T16','T17'].includes(task))
    for(const e of partial.overrides.initial_state?.history??[])if(e.type==='meal')e.announced_grams=null;
  return {base,complete,partial,rule:partialRule(task)};
}

const physicalEvents=env=>env.events.filter(e=>!['exercise_plan','meal_report'].includes(e.type)).map(e=>
  Object.fromEntries(Object.entries(e).filter(([k])=>!['announced','announced_grams','reported_composition','reported_exact','notice_masked','masked','late_report'].includes(k))));

export function waitEpisode(spec) {
  const env=new SimEnv(buildInstanceConfig({...spec,horizon_minutes:1440})),notices=[...env.observe().events];
  while(!env.done()) {
    const r=env.step({action_id:`audit-${env.step_count}`,expected_step:env.step_count,action:{type:'WAIT'}});
    notices.push(...r.observation.events);
  }
  const bundle=env.exportBundle();
  return {env,bundle,grid:trueGrid(bundle),notices};
}

export function auditPair(pair) {
  const a=waitEpisode(pair.complete),b=waitEpisode(pair.partial);
  assert.deepEqual(physicalEvents(a.env),physicalEvents(b.env),'Physical events differ');
  assert.deepEqual(a.grid.map(x=>x.m),b.grid.map(x=>x.m),'Evaluation times differ');
  const max=Math.max(...a.grid.map((x,i)=>Math.abs(x.g-b.grid[i].g)));
  assert.ok(max<1e-6,`Fixed-action truth differs: ${max}`);
  const count=xs=>xs.reduce((o,x)=>(o[x.type]=(o[x.type]??0)+1,o),{});
  const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
  assert.notEqual(digest(a.notices),digest(b.notices),'The information pair has no report contrast');
  return {task:pair.base.task,rule:pair.rule,seed:pair.base.seed,attempt:pair.base.attempt,
    person_type:pair.base.factors.person_type,sensor:pair.base.factors.cgm,meter:pair.base.factors.meter,
    common_grid_points:a.grid.length,max_truth_difference_mgdl:max,physical_events_sha256:digest(physicalEvents(a.env)),
    complete_notices:count(a.notices),partial_notices:count(b.notices),
    wait_score:episodeScore(episodeMetrics(a.bundle)).score,
    complete_spec_sha256:digest(pair.complete),partial_spec_sha256:digest(pair.partial)};
}

export function buildInformationPairs(outDir,{tasks=TASK_IDS,onProgress=()=>{}}={}) {
  const pairs=tasks.map(informationPair),audits=[];
  for(const pair of pairs){audits.push(auditPair(pair));onProgress(`paired physiology verified: ${pair.base.task}`);}
  const taskRows=pairs.flatMap(p=>['complete','partial'].map(mode=>({task_id:`${p.base.task.toLowerCase()}-${mode}`,spec:p[mode],hours:24,
    factors:{task:p.base.task,category:p.base.category,information:mode,backend:'pump_pct',setting:'clean'},
    metadata:{instance_id:p.base.env_id,scenario_id:p.base.task,information:mode,pair_id:p.base.task,
      title_zh:p.base.title.zh,partial_rule:p.rule,protocol:PROTOCOL}})));
  const manifest=buildBenchmark({name:'original25-information-pairs',version:'1.0',title:'Original 25 tasks: paired patient-report availability',
    description:'Simulation only; one Dana-i backend, one clean setting, one seed, full care. Task-prescribed sensors retained.',outDir,
    experiments:[{id:'paired-information',track:'full',repeats:1,references:false,tasks:taskRows}]});
  fs.writeFileSync(path.join(outDir,'pair-audit.json'),JSON.stringify({protocol:PROTOCOL,audits},null,2)+'\n');
  fs.writeFileSync(path.join(outDir,'environment-pairs.jsonl'),pairs.map(p=>JSON.stringify({task:p.base.task,title:p.base.title,
    category:p.base.category,rule:p.rule,original_spec:p.base.spec,complete:p.complete,partial:p.partial})).join('\n')+'\n');
  return {tasks:taskRows.length,pairs:pairs.length,manifest,audits};
}
