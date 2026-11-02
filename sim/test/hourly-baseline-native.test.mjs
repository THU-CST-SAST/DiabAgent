import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildBenchmark} from '../src/benchmark/build.mjs';
import {runJob} from '../src/benchmark/runner.mjs';

test('all four frozen native baselines default to hourly and preserve public local clock',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hourly-native-policy-'));
  const spec={seed:7,start_time:'2026-10-17T15:45:00Z',utc_offset_minutes:480,horizon_minutes:180,events:['baseline'],
    person:{type:'adult_male',sample:false},therapy:{mode:'pump',pump:{model:'dana_i',insulin:'aspart'}},
    sensors:{cgm:'dexcom_g6',meter:'contour_next_one'},self_care:'none'};
  try {
    buildBenchmark({name:'hourly-policy-fixture',outDir:dir+'/benchmark',experiments:[{id:'i2',track:'full',references:[],tasks:[{task_id:'clock-fixture',spec,hours:3}]}]});
    const result=await runJob({benchmarkDir:dir+'/benchmark',jobsDir:dir+'/jobs',jobId:'hourly',
      agents:['standard','guideline','hcl','oref1'],parallel:2,maxAttempts:1});
    assert.equal(result.incomplete,0,JSON.stringify(result.errors));assert.equal(result.ran,4);
    for(const policy of ['standard','guideline','hcl','oref1']) {
    const trial=fs.readdirSync(dir+'/jobs/hourly').find(name=>name.includes('__'+policy));
    const root=dir+'/jobs/hourly/'+trial;
    const status=JSON.parse(fs.readFileSync(root+'/agent/status.json','utf8'));
    assert.equal(status.execution_protocol.kind,'policy-hourly');assert.equal(status.gating.fixed_decisions,3);
    assert.equal(status.steps,36);
    const decisions=fs.readFileSync(root+'/agent/decisions.jsonl','utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(decisions.filter(d=>d.kind==='fixed').map(d=>d.elapsed_minutes),[0,60,120]);
    const record=JSON.parse(fs.readFileSync(root+'/trial.json','utf8'));
    assert.equal(record.agent_options.decision_schedule,'hourly');
    assert.deepEqual(record.execution_protocol,status.execution_protocol);
    }
    const legacy=await runJob({benchmarkDir:dir+'/benchmark',jobsDir:dir+'/jobs',jobId:'five-minute',agents:['standard'],parallel:1,
      maxAttempts:1,agentOptions:{agentOptions:{decision_schedule:'event-driven'}}});
    assert.equal(legacy.incomplete,0);
    const old=fs.readdirSync(dir+'/jobs/five-minute').find(name=>name.includes('__standard'));
    const oldStatus=JSON.parse(fs.readFileSync(dir+'/jobs/five-minute/'+old+'/agent/status.json','utf8'));
    assert.equal(oldStatus.execution_protocol.kind,'policy-per-step');assert.equal(oldStatus.gating,undefined);
    const oldRecord=fs.readFileSync(dir+'/jobs/five-minute/'+old+'/trial.json','utf8');
    await assert.rejects(runJob({benchmarkDir:dir+'/benchmark',jobsDir:dir+'/jobs',jobId:'five-minute',agents:['standard'],parallel:1,maxAttempts:1}),/historical cadence/);
    assert.equal(fs.readFileSync(dir+'/jobs/five-minute/'+old+'/trial.json','utf8'),oldRecord);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
