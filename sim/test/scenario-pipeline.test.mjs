import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {planScenarioPipeline,buildScenarioPipeline,runScenarioPipeline} from '../src/experiments/scenario-pipeline.mjs';
import {buildInstanceConfig} from '../src/sim/instance.mjs';
import {maskedScenario} from '../src/experiments/scenario-masks.mjs';
import {LEGACY_PROMPT_REVISION,CURRENT_PROMPT_REVISION} from '../src/bench/prompt-revisions.mjs';
import {ONGOING_CONTROL_GOAL} from '../src/bench/prompt.mjs';

const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));

test('default pipeline contains the current 24 presets, not the earlier simpler A-F catalogue',()=>{
  const config=read('bench/pipelines/scenario24.example.json'),p=planScenarioPipeline(config);
  assert.deepEqual(p.counts,{requested_worlds:24,worlds:24,rejected_worlds:0,tasks:72});
  assert.equal(p.rows[0].title,'不规则快吸收大餐连续冲击');
  const expected=maskedScenario({preset:'A01',seed:20261017,backgroundSeed:20261018});
  for(const mode of ['I0','I1','I2'])assert.deepEqual(buildInstanceConfig(p.rows[0].variants[mode]),buildInstanceConfig(expected.variants[mode]));
});

test('patient x hardware x other factors x seeds are separate from information and model draws',()=>{
  const p=planScenarioPipeline({name:'matrix',scenarios:['A01'],
    patients:[{id:'light',patient:{weight_kg:60}},{id:'heavy',patient:{weight_kg:80}}],
    hardware:[{id:'aspart',therapy:{mode:'pump',pump:{model:'dana_i',insulin:'aspart'}}},{id:'fiasp',therapy:{mode:'pump',pump:{model:'dana_i',insulin:'fiasp'}}}],
    factors:[{id:'baseline'},{id:'sensitive',overrides:{physiology:{sensitivity:1.1}}}],world_seeds:[1,2],background_seeds:[null,3]});
  assert.equal(p.rows.length,32);assert.equal(p.counts.tasks,96);
  assert.equal(new Set(p.rows.map(r=>r.preset)).size,32);
  for(const row of p.rows) {
    const a=buildInstanceConfig(row.variants.I0),b=buildInstanceConfig(row.variants.I2);
    assert.equal(a.seed,b.seed);assert.equal(a.start_time,b.start_time);
    const {information:ai,...ac}=a,{information:bi,...bc}=b;assert.deepEqual(ac,bc);
  }
});

test('custom events and masks are retained, incompatible combinations are explicit',()=>{
  const c=read('bench/pipelines/custom.example.json'),p=planScenarioPipeline(c);
  assert.equal(p.rows.length,2);assert.equal(p.rows[0].construction.events[0].id,'custom-lunch');
  assert.equal(p.rows[0].variants.I1.overrides.information.rules[0].ids[0],'custom-lunch');
  const incompatible={name:'bad-hardware',scenarios:['F04'],hardware:[{id:'g6',sensors:{cgm:'dexcom_g6'}}]};
  assert.throws(()=>planScenarioPipeline(incompatible),/calibrat/);
  const skip=planScenarioPipeline({...incompatible,scenarios:['A01','F04'],on_incompatible:'skip'});
  assert.equal(skip.rows.length,1);assert.equal(skip.rejected.length,1);
  assert.throws(()=>planScenarioPipeline({world_seed:1}),/Unknown pipeline/);
  assert.throws(()=>planScenarioPipeline({factors:[{id:'leak',overrides:{information:{mode:'I0'}}}]}),/Information masks/);
  assert.throws(()=>planScenarioPipeline({scenarios:[{id:'custom'}]}),/Custom scenario/);
});

test('free end-to-end pipeline builds Harbor tasks, runs both models and WAIT, resumes, and uses native report',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scenario-pipeline-'));
  try {
    const benchmark=path.join(dir,'benchmark'),jobs=path.join(dir,'jobs');
    const {plan,audits,manifest}=buildScenarioPipeline(benchmark,{name:'pipeline-smoke',scenarios:['A01']});
    assert.equal(audits.length,1);assert.equal(audits[0].max_truth_difference_mgdl,0);assert.equal(Object.keys(manifest.tasks).length,3);
    assert.equal(audits[0].completed_horizon,true);assert.equal(audits[0].finite_grid,true);
    assert.throws(()=>buildScenarioPipeline(benchmark,{name:'pipeline-smoke'}),/No overwrite/);
    const models=['alpha','beta'].map(id=>{
      const config=path.join(dir,id+'.json');fs.writeFileSync(config,JSON.stringify({name:id,adapter:'scripted',policy:'wait',...(id==='alpha'?{max_parallel:1}:{})}));return {id,config};
    });
    const opts={benchmarkDir:benchmark,jobsDir:jobs,runId:'smoke',models,parallel:2,modelDraws:2,
      agentOptions:{simulate:false,prompt_revision:LEGACY_PROMPT_REVISION}};
    const result=await runScenarioPipeline(opts);
    assert.equal(result.length,3);assert.ok(result.every(r=>r.incomplete===0));
    assert.equal(result[0].config.parallel,1);assert.equal(result[0].config.failure_handling.max_concurrent_llm,1);
    assert.equal(result[1].config.parallel,2);assert.equal(result[1].config.failure_handling.max_concurrent_llm,2);
    assert.equal(result[0].config.agent_options.apiTries,4);
    assert.equal(result[0].config.trials_planned,6);assert.equal(result[2].config.trials_planned,1);
    for(const r of result.slice(0,2))for(const d of fs.readdirSync(r.job_dir)) {
      const agent=path.join(r.job_dir,d,'agent');if(!fs.existsSync(path.join(agent,'status.json')))continue;
      assert.equal(read(path.join(agent,'status.json')).agent_options.prompt_revision,LEGACY_PROMPT_REVISION);
      const first=JSON.parse(fs.readFileSync(path.join(agent,'transcript.jsonl'),'utf8').split('\n')[0]);
      assert.ok(!first.system.includes(ONGOING_CONTROL_GOAL));
    }
    const resumed=await runScenarioPipeline(opts);assert.ok(resumed.every(r=>r.ran===0));
    await assert.rejects(()=>runScenarioPipeline({...opts,repeats:2}),/Resume registration mismatch/);
    await assert.rejects(()=>runScenarioPipeline({...opts,agentOptions:{...opts.agentOptions,prompt_revision:CURRENT_PROMPT_REVISION}}),/Resume registration mismatch/);
    await assert.rejects(()=>runScenarioPipeline({...opts,apiTries:5}),/Resume registration mismatch/);
    const report=path.join(dir,'report'),proc=spawnSync(process.execPath,['scripts/scenario-pipeline.mjs','report','--jobs-dir',jobs,
      '--jobs',result.map(r=>path.basename(r.job_dir)).join(','),'--out',report],{encoding:'utf8',maxBuffer:4*1024*1024});
    assert.equal(proc.status,0,proc.stderr);assert.ok(fs.existsSync(path.join(report,'index.html')));
    const records=fs.readFileSync(path.join(report,'trials.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.filter(r=>r.selected).length,13);
    assert.equal(records.filter(r=>r.selected&&r.model_draw===1).length,6);
    for(const row of plan.rows)assert.ok(records.some(r=>r.instance_id===row.preset));
    const configured=await runScenarioPipeline({...opts,runId:'configured',withWait:false,apiTries:5});
    assert.ok(configured.every(r=>r.config.agent_options.apiTries===5));
    const cli=spawnSync(process.execPath,['scripts/scenario-pipeline.mjs','run','--benchmark',benchmark,'--jobs-dir',jobs,
      '--run-id','cli-retry','--models',`alpha=${models[0].config}`,'--information','I2','--no-wait','true','--api-tries','5',
      '--agent-options',JSON.stringify(opts.agentOptions)],{encoding:'utf8',maxBuffer:4*1024*1024});
    assert.equal(cli.status,0,cli.stderr);
    assert.equal(read(path.join(jobs,'cli-retry-alpha','config.json')).agent_options.apiTries,5);
    const runtime=path.join(dir,'runtime with spaces %'),scripts=path.join(runtime,'scripts');
    fs.mkdirSync(scripts,{recursive:true});fs.mkdirSync(path.join(runtime,'artifacts'));
    fs.symlinkSync(path.resolve('src'),path.join(runtime,'src'),'dir');
    for(const file of ['mvp-report.mjs','mvp-report.template.html','video/player.html','video/player.js']) {
      const dest=path.join(scripts,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join('scripts',file),dest);
    }
    const empty=path.join(dir,'empty');fs.mkdirSync(empty);
    const spacedReport=path.join(dir,'report with spaces');
    const spaced=spawnSync(process.execPath,[path.join(scripts,'mvp-report.mjs'),'--out',spacedReport,
      '--jobs-dir',jobs,'--jobs',path.basename(result[0].job_dir),'--exp3',empty,'--exp4',empty,'--oracle',empty],
      {encoding:'utf8',maxBuffer:4*1024*1024});
    assert.equal(spaced.status,0,spaced.stderr);assert.ok(fs.existsSync(path.join(spacedReport,'index.html')));
  } finally{fs.rmSync(dir,{recursive:true,force:true});}
});
