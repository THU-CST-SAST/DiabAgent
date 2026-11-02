// Person types (knowledge/persons.json) -> configuration layer -> kernel.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PERSONS,personLayer} from '../src/core/person.mjs';
import {normalizeConfig} from '../src/core/config.mjs';
import {equilibriumBasalUph} from '../src/core/physiology.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';
import {KNOWLEDGE} from '../src/knowledge.mjs';

const M=KNOWLEDGE.personModel;
const SEXES=['male','female'],AGE_GROUPS=['child','adolescent','adult','older'];
const spec=(type,over={})=>({type,bmi:'normal',dawn:'absent',carb_counting:'typical',sample:false,...over});
const near=(v,target,tol,label)=>assert.ok(Math.abs(v-target)<=tol,`${label}: ${v} vs ${target}±${tol}`);

test('every sex x age group has a default person type that resolves to a valid config',()=>{
  for(const sex of SEXES)for(const group of AGE_GROUPS) {
    const types=Object.entries(PERSONS).filter(([,t])=>t.sex===sex&&t.age_group===group);
    assert.equal(types.length,1,`exactly one type for ${sex} ${group}`);
    const [id,t]=types[0];
    const c=normalizeConfig({person:{type:id}});
    assert.equal(c.patient.sex,sex);assert.equal(c.patient.age_years,t.age_years);
    assert.equal(c.person.resolved.type,id);assert.equal(c.person.resolved.age_group,group);
    assert.equal(c.safety.max_bolus_u,t.max_bolus_u);
    // Meal plan follows the type (snack optional), and shares sum to the daily carbs.
    assert.deepEqual(Object.keys(c.scenario.meals).sort(),Object.keys(t.meal_plan).sort());
    const total=Object.values(c.scenario.meals).reduce((s,m)=>s+m.carbs_g,0);
    near(total,t.carbs_g_per_day.median,4,`${id} daily carbs`);
    assert.equal(c.scenario.announcement.model,'normal');
  }
  assert.throws(()=>normalizeConfig({person:{type:'martian'}}),/person.type/);
  assert.throws(()=>personLayer(spec('adult_male',{bmi:'huge'}),1),/variant/);
});

test('sensitivity mapping: true basal per kg defines sensitivity, and the kernel is at equilibrium on it',()=>{
  for(const type of Object.keys(PERSONS))for(const bmi of ['normal','overweight','obese']) {
    const {resolved:r,layer}=personLayer(spec(type,{bmi}),1),t=PERSONS[type],v=M.variants.bmi[bmi];
    near(r.weight_kg,Math.round(t.weight_kg.median*v.weight_x*10)/10,1e-9,`${type} weight`);
    const basalPerKg=t.tdd_u_per_kg_day.median*v.tdd_per_kg_x*t.basal_fraction.median;
    near(r.insulin_sensitivity,M.reference.basal_u_per_kg_day/basalPerKg,1e-9,`${type} sensitivity`);
    assert.ok(r.insulin_sensitivity>0.25&&r.insulin_sensitivity<2,`${type}/${bmi} sensitivity ${r.insulin_sensitivity} plausible`);
    near(r.true_basal_u_h,basalPerKg*r.weight_kg/24,1e-9,`${type} true basal`);
    // The kernel's equilibrium basal for this weight and sensitivity is the true basal.
    near(equilibriumBasalUph(r.weight_kg)/r.insulin_sensitivity,r.true_basal_u_h,0.01*r.true_basal_u_h,`${type} kernel equilibrium`);
    // Unsampled profile equals true needs on the profile grid; ISF falls as weight and resistance rise.
    near(layer.profile.basal_u_h,r.true_basal_u_h,0.0025+1e-9,`${type} profile basal`);
    assert.ok(layer.profile.max_basal_u_h>=layer.profile.basal_u_h);
  }
  const s=bmi=>personLayer(spec('adult_male',{bmi}),1).resolved;
  assert.ok(s('obese').insulin_sensitivity<s('overweight').insulin_sensitivity&&s('overweight').insulin_sensitivity<s('normal').insulin_sensitivity);
  assert.ok(s('obese').profile.isf_mg_dl_per_u<s('normal').profile.isf_mg_dl_per_u);
  assert.ok(s('obese').true_tdd_u_day>s('normal').true_tdd_u_day*1.5);
  // Children: more insulin per kg than adults, so lower sensitivity on the kernel scale.
  assert.ok(personLayer(spec('child_male'),1).resolved.insulin_sensitivity<s('normal').insulin_sensitivity);
});

test('a fasting day on the true basal stays at the starting glucose for every person type',()=>{
  for(const type of Object.keys(PERSONS)) {
    const {resolved:r}=personLayer(spec(type),1);
    const env=new SimEnv({person:{type},physiology:{daily_sensitivity_cv:0},scenario:{meals:{},activity:{enabled:false},extra_events:[]},
      therapy:{pump:{model:'ideal'}},cgm:{model:'ideal'},profile:{basal_u_h:r.true_basal_u_h}});
    while(!env.done())env.step({action_id:`a${env.step_count}`,expected_step:env.step_count,action:{type:'WAIT'}});
    const sm=env.summary();
    near(sm.min_glucose,120,0.5,`${type} min`);near(sm.max_glucose,120,0.5,`${type} max`);
  }
});

test('sampled persons: deterministic per seed, varied across seeds, clamped to the type ranges; variants apply',()=>{
  const a=personLayer(spec('adult_female',{sample:true}),11),b=personLayer(spec('adult_female',{sample:true}),11);
  assert.deepEqual(a,b);
  const draws=Array.from({length:60},(_,i)=>personLayer(spec('adult_female',{sample:true,dawn:'random'}),i).resolved);
  const t=PERSONS.adult_female;
  assert.ok(new Set(draws.map(d=>d.weight_kg)).size>40,'weights vary');
  for(const d of draws) {
    assert.ok(d.weight_kg>=t.weight_kg.min-0.05&&d.weight_kg<=t.weight_kg.max+0.05);
    assert.ok(d.tdd_u_per_kg_day>=t.tdd_u_per_kg_day.min&&d.tdd_u_per_kg_day<=t.tdd_u_per_kg_day.max);
    assert.ok(d.basal_fraction>=t.basal_fraction.min&&d.basal_fraction<=t.basal_fraction.max);
    assert.ok([0,M.variants.dawn.present.fraction].includes(d.dawn_fraction));
  }
  const withDawn=draws.filter(d=>d.dawn_fraction>0).length/draws.length;
  assert.ok(withDawn>0.05&&withDawn<0.95,`dawn prevalence drawn (${withDawn})`);
  // Sampling perturbs the programmed profile away from true needs (settings mismatch).
  assert.ok(draws.some(d=>Math.abs(d.profile.basal_u_h-d.true_basal_u_h)>0.02));
  // Carb counting and dawn variants.
  assert.equal(personLayer(spec('adult_male',{carb_counting:'poor'}),1).resolved.carb_estimation.sd,M.variants.carb_counting.poor.sd);
  assert.equal(personLayer(spec('adult_male',{dawn:'present'}),1).resolved.dawn_fraction,M.variants.dawn.present.fraction);
  // Explicit config fields win over the person layer.
  const c=normalizeConfig({person:{type:'adult_male'},patient:{weight_kg:90},profile:{isf_mg_dl_per_u:44}});
  assert.equal(c.patient.weight_kg,90);assert.equal(c.profile.isf_mg_dl_per_u,44);
});

test('person.seed fixes the individual independently of the episode seed',()=>{
  const p={type:'adult_female',sample:true};
  const a=normalizeConfig({seed:1,person:{...p,seed:77}}),b=normalizeConfig({seed:2,person:{...p,seed:77}});
  assert.deepEqual(a.person.resolved,b.person.resolved);assert.deepEqual(a.physiology,b.physiology);
  // Default (no person.seed) = the config seed, as before.
  assert.deepEqual(normalizeConfig({seed:77,person:p}).person.resolved,a.person.resolved);
  assert.notDeepEqual(normalizeConfig({seed:1,person:p}).person.resolved,normalizeConfig({seed:2,person:p}).person.resolved);
  assert.equal(normalizeConfig({}).person.seed,null);
  assert.throws(()=>normalizeConfig({person:{...p,seed:1.5}}),/person.seed/);
});
