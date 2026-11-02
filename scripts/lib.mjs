import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {SimEnv} from '../sim/src/env/pomdp.mjs';
import {hourlyPolicy,observationOffsetMs} from '../sim/src/bench/hourly-policy.mjs';
import {standardCarePolicy,guidelinePolicy} from '../sim/src/policies/care.mjs';
import {hclPolicy} from '../sim/src/policies/hcl.mjs';
import {oref1Policy} from '../sim/src/policies/oref1.mjs';
import {episodeMetrics,episodeScore} from '../sim/src/bench/score.mjs';
import {runFromBundle} from '../sim/src/viz/run.mjs';
import {playerPage} from '../sim/src/bench/report.mjs';

export const ROOT=fileURLToPath(new URL('../',import.meta.url));
export const DATA=ROOT+'benchmark/main212';
export const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n');fs.renameSync(temp,file);};
export const protocol=()=>read(DATA+'/protocol.json');
export const taskRows=()=>read(DATA+'/TASKS.json');
export function fixture(row){
  const bytes=fs.readFileSync(DATA+'/fixtures/'+row.task_id+'.json');
  assert.equal(hash(bytes),row.fixture_sha256,'Frozen fixture changed: '+row.task_id);
  return JSON.parse(bytes);
}
export function selectTasks({tasks,limit}={}){
  let rows=taskRows();
  if(tasks){const ids=tasks.split(',');assert.equal(new Set(ids).size,ids.length);const wanted=new Set(ids);rows=rows.filter(r=>wanted.delete(r.task_id));assert.equal(wanted.size,0,'Unknown task ID');}
  if(limit!==undefined){assert(Number.isInteger(Number(limit))&&Number(limit)>0);rows=rows.slice(0,Number(limit));}
  assert(rows.length>0);return rows;
}
export function scoreBundle(bundle){return episodeScore(episodeMetrics(bundle),undefined,{version:'COGI-4-8/v1'});}
export function saveReport(dir,bundle){
  const run=runFromBundle(bundle,{id:bundle.manifest.episode_id,scoringVersion:'COGI-4-8/v1'});
  write(dir+'/run.json',run);fs.writeFileSync(dir+'/index.html',playerPage([run]));return run;
}
export const policies={standard:standardCarePolicy,guideline:guidelinePolicy,oref1:oref1Policy,hcl:hclPolicy};
export function runBaseline(input,{policy='oref1',interval=15}={}){
  assert(Object.hasOwn(policies,policy),'Unknown baseline');assert([5,10,15,20,30,45,60,90,120].includes(interval),'Unsupported interval');
  const env=new SimEnv(input.instance.config),raw=policies[policy]();
  const schedule=interval===5?null:hourlyPolicy(raw,{start:env.start,end:env.end,offsetMs:observationOffsetMs(env.observe()),extraLimit:6,intervalMinutes:interval});
  while(!env.done()){
    const answer=schedule?schedule.decide(env.observe()):raw(env.observe());
    env.step({action_id:'baseline-'+env.step_count,expected_step:env.step_count,action:answer.action,rationale:answer.rationale});
  }
  const bundle=env.exportBundle();assert.equal(bundle.metrics.steps,864);assert.equal(bundle.evaluator_only.states.length,865);
  const score=scoreBundle(bundle);assert(Number.isFinite(score.score));
  return {bundle,result:{state:'complete',score:score.score,score_details:score,policy,interval_minutes:interval,
    fixed_interval_minutes:interval,max_extra_decisions_per_local_day:interval===5?0:6,decisions:schedule?.stats??{decisions:864},steps:864,model_calls:0}};
}
export function assertEndpoint(value){
  const u=new URL(value);assert.equal(u.protocol,'https:','Production requires HTTPS');
  assert(!u.username&&!u.password&&!u.search&&!u.hash,'Endpoint must not contain credentials/query/fragment');
  return value.replace(/\/$/,'');
}
