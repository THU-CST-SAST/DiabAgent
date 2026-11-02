import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildInstanceConfig} from '../src/sim/instance.mjs';
import {normalizeConfig} from '../src/core/config.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';

const pen={mode:'mdi',mdi:{bolus_pen:'novopen_echo',bolus_insulin:'aspart',basal_pen:'tresiba_flextouch',basal_insulin:'degludec',basal_dose_u:20,basal_times:['22:00']}};
const spec=(mdi={})=>({seed:7,horizon_minutes:120,therapy:{...pen,mdi:{...pen.mdi,...mdi}},sensors:{cgm:'dexcom_g6',meter:'contour_next_one'},
  events:['baseline'],overrides:{information:{mode:'I2',policy:'record-derived-v3',rules:[],own_records:true}}});

test('dose_memory is opt-in and absent from normalized configs by default', () => {
  assert.equal('dose_memory' in normalizeConfig({}).therapy.mdi, false);
  assert.throws(() => normalizeConfig({therapy:{mdi:{dose_memory:'yes'}}}), /dose_memory must be boolean/);
});

test('I2 hides the routine long-acting dose unless the pen has dose memory', () => {
  const hidden=new SimEnv(buildInstanceConfig(spec())).observe().device.last_basal_injection;
  const shown=new SimEnv(buildInstanceConfig(spec({dose_memory:true}))).observe().device.last_basal_injection;
  assert.equal(hidden, null);
  assert.equal(shown.units, 20);
});

test('smart-pen memory coexists with the physical five-injection budget', () => {
  const env=new SimEnv(buildInstanceConfig({...spec({dose_memory:true,max_daily_injections:5}),horizon_minutes:720}));
  assert.equal(env.observe().device.last_basal_injection.units,20);
  assert.equal(env.config.therapy.mdi.max_daily_injections,5);
  const initial=env.observe().device.injection_budget;
  for(let i=0;i<initial.available_for_agent;i++) {
    assert.equal(env.world.apply({type:'BOLUS',units:0.5},'memory-budget-'+i,'agent').status,'applied');
    for(let j=0;j<12;j++)env.step({action_id:'memory-wait-'+env.step_count,expected_step:env.step_count,action:{type:'WAIT'}});
  }
  assert.equal(env.world.apply({type:'BOLUS',units:0.5},'memory-budget-overflow','agent').status,'rejected');
  assert.equal(env.observe().device.last_basal_injection.units,20);
  assert.equal(env.observe().device.injection_budget.available_for_agent,0);
});
