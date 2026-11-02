import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {POLICIES,simulateRun} from '../src/viz/run.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';
import {buildInstanceConfig} from '../src/sim/instance.mjs';
import {runPolicyEpisode,runPool} from '../src/bench/suite.mjs';
import {runEpisode} from '../src/opendiabet/episodes.mjs';
import {CLASSICAL_BASELINES,BASELINE_CADENCE_VERSION} from '../src/bench/hourly-policy.mjs';

const spec={seed:7,start_time:'2026-10-17T03:45:00Z',utc_offset_minutes:480,horizon_minutes:180,events:['baseline'],
  person:{type:'adult_male',sample:false},therapy:{mode:'pump',pump:{model:'dana_i',insulin:'aspart'}},
  sensors:{cgm:'dexcom_g6',meter:'contour_next_one'},self_care:'none'};
test('registered policy factories default to anchored hourly consultations; explicit5min stays reproducible',()=>{
  for(const policy of CLASSICAL_BASELINES) {
    const env=new SimEnv(buildInstanceConfig(spec)),decide=POLICIES[policy]();
    assert.equal(decide.execution_protocol.version,BASELINE_CADENCE_VERSION);
    while(!env.done()) {
      const action=decide(env.observe());
      env.step({action_id:'fixture-'+env.step_count,expected_step:env.step_count,action:action.action,rationale:action.rationale});
    }
    assert.equal(env.config.decision_interval_minutes,5);assert.equal(env.observe().elapsed_minutes,180);
    assert.ok(env.step_count>=36);assert.equal(decide.gating.fixed_decisions,3);
    const legacy=POLICIES[policy]({decision_schedule:'event-driven'});
    assert.equal(legacy.execution_protocol.kind,'policy-per-step');assert.equal(legacy.gating,null);
  }
});
test('visualization, suite and reference episode entry points all use the same standard default',()=>{
  for(const policy of CLASSICAL_BASELINES) {
    const viz=simulateRun(spec,{policy}),suite=runPolicyEpisode(spec,policy),reference=runEpisode(spec,policy);
    for(const result of [viz,reference]) {
      assert.equal(result.execution_protocol.kind,'policy-hourly');assert.equal(result.baseline_gating.fixed_decisions,3);
    }
    assert.equal(suite.baselineProtocol.kind,'policy-hourly');assert.equal(suite.baselineGating.fixed_decisions,3);
    assert.deepEqual(reference.bundle.evaluator_only.states,suite.exportBundle().evaluator_only.states);
  }
});
test('suite refuses to reuse or overwrite a historical five-minute result as the new standard',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'baseline-cache-cadence-'));
  const file=path.join(dir,'world/r0/status.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  const original='{"state":"done","execution_protocol":{"kind":"policy-per-step"}}\n';fs.writeFileSync(file,original);
  try {
    await assert.rejects(runPool([{kind:'baseline',instance:{id:'world',spec},repeat:0,hours:3,track:'full',root:dir,policy:'standard'}],{parallel:1}),/historical cadence/);
    assert.equal(fs.readFileSync(file,'utf8'),original);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
