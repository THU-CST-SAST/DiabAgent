import test from 'node:test';
import assert from 'node:assert/strict';
import {buildInstanceConfig} from '../src/sim/instance.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';
import {publicInfo} from '../src/export/harbor.mjs';
import {systemPrompt} from '../src/bench/prompt.mjs';

const patient={sex:'female',age_years:27,height_cm:167.5,weight_kg:61.2};
const spec={seed:42,horizon_minutes:60,patient,events:['baseline']};

test('explicit demographics need no preset and survive normalization and snapshots',()=>{
  for(const sex of ['male','female'])for(const age_years of [5,16,27,81]){
    const config=buildInstanceConfig({...spec,patient:{...patient,sex,age_years}});
    assert.deepEqual(config.patient,{...patient,sex,age_years,initial_glucose_mg_dl:120});
    assert.equal(config.person.type,null);assert.equal(config.person.resolved,null);
    const env=new SimEnv(config);env.step({action_id:'wait',expected_step:0,action:{type:'WAIT'}});
    const restored=SimEnv.restore(env.snapshot());assert.deepEqual(restored.config.patient,config.patient);
    assert.deepEqual(restored.snapshot(),env.snapshot());
  }
});
test('patient demographics appear in public records and custom children are not called reference adults',()=>{
  for(const age_years of [5,27,81]){
    const input={...spec,patient:{...patient,age_years}},config=buildInstanceConfig(input),env=new SimEnv(config),pub=publicInfo(input,config);
    assert.deepEqual(pub.prompt_context.patient,{...patient,age_years});
    assert.deepEqual(pub.description.patient,{...patient,age_years});assert.equal(pub.prompt_context.person,null);
    const prompt=systemPrompt({obs:env.observe(),config});assert(prompt.includes('female (custom patient)'));
    assert(prompt.includes(`age ${age_years} y`));assert(prompt.includes('167.5 cm'));assert(prompt.includes('61.2 kg'));assert(!prompt.includes('(reference patient)'));
  }
});
test('explicit patient and final overrides take precedence over optional preset defaults',()=>{
  const config=buildInstanceConfig({...spec,person:{type:'adult_male'},overrides:{patient:{weight_kg:72.3}}});
  assert.deepEqual(config.patient,{...patient,weight_kg:72.3,initial_glucose_mg_dl:120});
  assert.equal(buildInstanceConfig({...spec,events:['menstrual']}).scenario.menstrual.enabled,true);
  assert.equal(buildInstanceConfig({...spec,patient:undefined,overrides:{patient},events:['menstrual']}).scenario.menstrual.enabled,true);
  assert.throws(()=>buildInstanceConfig({...spec,patient:{...patient,age_years:70},events:['menstrual']}),/does not apply/);
  const child=buildInstanceConfig({...spec,patient:{...patient,age_years:5},person:{type:'child_female'}});
  assert(!systemPrompt({obs:new SimEnv(child).observe(),config:child}).includes('child (6-12 y)'));
});
test('invalid demographics fail with field-specific validation',()=>{
  for(const [field,values]of Object.entries({sex:['other'],age_years:[0,121,12.5],height_cm:[49,231,NaN],weight_kg:[9,251,Infinity]}))
    for(const value of values)assert.throws(()=>buildInstanceConfig({...spec,patient:{...patient,[field]:value}}),new RegExp('patient.'+field));
  assert.throws(()=>buildInstanceConfig({...spec,patient:{...patient,weight:60}}),/Unknown config field/);
});
test('custom body weight is used for the default equilibrium basal rather than a preset body',()=>{
  const lighter=buildInstanceConfig({...spec,patient:{...patient,weight_kg:50}}),heavier=buildInstanceConfig({...spec,patient:{...patient,weight_kg:100}});
  assert.equal(heavier.profile.basal_u_h,2*lighter.profile.basal_u_h);
});
