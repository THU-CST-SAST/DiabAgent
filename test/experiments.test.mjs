import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {resolveExperiment,saveDataset} from '../scripts/experiment.mjs';
import {ROOT,fixture,taskRows,read} from '../scripts/lib.mjs';
import {summarizeResults} from '../scripts/results.mjs';

const cli=(...args)=>JSON.parse(execFileSync(process.execPath,['scripts/benchmark.mjs',...args],{cwd:ROOT,encoding:'utf8',maxBuffer:2000000}));
const temporary=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'diabagent-flex-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
test('default reproduction preserves all frozen configs and original protocol',()=>{
  const e=resolveExperiment();assert.equal(e.mode,'main212');assert.equal(e.rows.length,212);
  for(const [i,row]of e.rows.entries())assert.deepEqual(row.input,fixture(taskRows()[i]));
  assert.equal(e.protocol.agent_options.fixed_interval_minutes,60);assert.equal(e.protocol.runtime.max_native_turns,7);
});
test('hardware, schedule and native budgets are configurable and prepared datasets roundtrip',t=>{
  const dir=temporary(t),e=resolveExperiment({experiment:ROOT+'examples/experiments/hcl-five-minute.json'});
  assert.equal(e.rows.length,1);assert.equal(e.rows[0].input.instance.config.controller.algorithm,'hcl');
  assert.equal(e.rows[0].input.instance.config.therapy.pump.model,'omnipod_dash');
  assert.equal(e.protocol.agent_options.fixed_interval_minutes,5);assert.equal(e.protocol.runtime.max_native_turns,10);
  saveDataset(e,dir+'/dataset');const again=resolveExperiment({dataset:dir+'/dataset'});
  assert.deepEqual(again.rows[0].input,e.rows[0].input);assert.deepEqual(again.protocol.runtime,e.protocol.runtime);
  assert.equal(again.protocol.agent_options.fixed_interval_minutes,5);
  const o=resolveExperiment({hardware:'dana-i-oref',interval:'25',limit:'1','agent-options':'{"simulate_calls":4,"memory":"none","max_extra_decisions_per_day":12}'});
  assert.equal(o.protocol.agent_options.fixed_interval_minutes,25);assert.equal(o.protocol.agent_options.simulate_calls,4);
  assert.equal(o.rows[0].input.instance.config.controller.algorithm,'oref1');
  assert.equal(o.protocol.agent_options.max_extra_decisions_per_day,12);
  assert.equal(resolveExperiment({limit:'1','history-hours':'6'}).mode,'custom');
});
test('custom scenario runs through adapter and custom harness with the native report generator',t=>{
  const dir=temporary(t);
  for(const harness of ['adapter','custom']){
    const out=dir+'/'+harness,flags=harness==='adapter'?['--harness-config','examples/harnesses/scripted.json']:['--harness-module','examples/harnesses/custom.mjs'];
    const done=cli('run','--experiment','examples/experiments/custom-scene.json','--harness',harness,...flags,'--model','offline-policy','--out',out);
    assert.equal(done.complete,1);assert.equal(done.gate,null);
    const summary=summarizeResults(out,{report:true});assert.equal(summary.counts.complete,1);assert(Number.isFinite(summary.groups[0].score));
    assert(fs.existsSync(summary.report_file));const plan=read(out+'/PLAN.json');
    assert.equal(plan.protocol.agent_options.fixed_interval_minutes,30);
    assert.equal(read(out+'/trials/'+plan.tasks[0].task_id+'/bundle.json').metrics.elapsed_minutes,360);
  }
});
test('custom task creation and scenario pipelines are runnable datasets',t=>{
  const dir=temporary(t);cli('create','--spec','examples/scenarios/custom-day.json','--out',dir+'/task');
  assert.equal(resolveExperiment({dataset:dir+'/task'}).rows[0].task_id,'custom-delayed-meal-and-exercise');
  const config=dir+'/pipeline.json';fs.writeFileSync(config,JSON.stringify({dataset:{pipeline:ROOT+'sim/bench/pipelines/custom.example.json'},selection:{limit:1}}));
  const e=resolveExperiment({experiment:config});assert.equal(e.rows.length,1);assert(e.rows[0].input.pub);
});
test('custom warmup and event-driven evaluations produce valid scores and reusable reports',t=>{
  const dir=temporary(t),spec=read(ROOT+'examples/scenarios/custom-day.json');spec.horizon_minutes=1500;
  const file=dir+'/experiment.json';fs.writeFileSync(file,JSON.stringify({dataset:{spec},agent_options:{warmup_days:1,fixed_interval_minutes:15,max_extra_decisions_per_day:0}}));
  const out=dir+'/warmup';assert.equal(cli('run','--experiment',file,'--harness','adapter','--harness-config','examples/harnesses/scripted.json','--model','offline','--out',out).complete,1);
  assert.equal(summarizeResults(out,{report:true}).counts.complete,1);
  fs.writeFileSync(file,JSON.stringify({dataset:{spec},world:{horizon_minutes:90},scoring_version:'METRICS-v0.3',agent_options:{decision_schedule:'event-driven',fixed_interval_minutes:60}}));
  const eventOut=dir+'/event';assert.equal(cli('run','--experiment',file,'--harness','adapter','--harness-config','examples/harnesses/scripted.json','--model','offline','--out',eventOut).complete,1);
  const result=summarizeResults(eventOut,{report:true});assert.equal(result.counts.complete,1);assert.equal(result.groups[0].COGI,null);assert(Number.isFinite(result.groups[0].score));
  assert(fs.readFileSync(eventOut+'/summary.csv','utf8').includes('"METRICS-v0.3"'));
});
test('custom pen hardware runs compatible baselines and explicitly marks pump-only policies',t=>{
  const dir=temporary(t),file=dir+'/experiment.json';fs.writeFileSync(file,JSON.stringify({dataset:{spec:ROOT+'examples/scenarios/custom-day.json'},hardware:'pens'}));
  cli('baselines','--experiment',file,'--interval','25','--policies','standard,oref1,hcl','--out',dir+'/baseline');
  const summary=summarizeResults(dir+'/baseline',{report:true});assert.equal(summary.counts.complete,1);assert.equal(summary.counts.not_applicable,2);
});
