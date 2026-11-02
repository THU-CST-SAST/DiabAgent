import test from 'node:test';
import assert from 'node:assert/strict';
import {PRESETS,scenarioVariants,auditScenario,fixedActionEpisode,constructScenario} from '../src/experiments/scenario-generator.mjs';
import {buildInstanceConfig} from '../src/sim/instance.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';
import {publicInfo} from '../src/export/harbor.mjs';
import {trueGrid} from '../src/bench/score.mjs';
import {runFromBundle} from '../src/viz/run.mjs';

for(const preset of Object.keys(PRESETS))test(`${preset}: all three information projections are distinct and have identical WAIT truth`,()=>{
  const r=scenarioVariants({preset}),a=auditScenario(r);
  assert.equal(a.max_truth_difference_mgdl,0);assert.equal(a.grid_points,288);
  const env=new SimEnv(buildInstanceConfig(r.variants.I2));
  const pub=JSON.stringify(publicInfo(r.variants.I2,env.config));
  assert.doesNotMatch(pub,/extra_events|minutes_before|insulin_need_increase|bias_mg_dl|true_glucose/);
});

test('information masks retain own receipts, public glucose and physical exercise, including snapshot replay',()=>{
  const r=scenarioVariants({preset:'C01'}),a=new SimEnv(buildInstanceConfig(r.variants.I0)),b=new SimEnv(buildInstanceConfig(r.variants.I2));
  for(let i=0;i<30;i++) {
    const action=i===0?{type:'INGEST_CARBS',grams:10}:{type:'WAIT'};
    const x=a.step({action_id:`x${i}`,expected_step:i,action}),y=b.step({action_id:`x${i}`,expected_step:i,action});
    assert.deepEqual(x.info.action_result,y.info.action_result);
    assert.deepEqual(x.observation.cgm_history,y.observation.cgm_history);
    assert.ok(y.observation.reported_carbs.some(c=>c.source==='agent_rescue_carbs'));
    assert.ok(!y.observation.events.some(e=>e.type.startsWith('exercise_')||e.type.startsWith('meal_')));
  }
  const c=SimEnv.restore(b.snapshot());
  assert.deepEqual(c.observe(),b.observe());
});
test('hiding historical treatment changes visible estimates, not true state; unknown is explicitly marked',()=>{
  const r=scenarioVariants({preset:'A01'}),s=structuredClone(r.variants.I0);
  s.overrides.information={mode:'I1',rules:[{category:'treatment'}]};
  const a=new SimEnv(buildInstanceConfig(r.variants.I0)),b=new SimEnv(buildInstanceConfig(s));
  assert.equal(a.physiology.glucose(),b.physiology.glucose());
  assert.notEqual(a.observe().iob.total_u,b.observe().iob.total_u);
  assert.equal(b.observe().iob.history_complete,false);assert.equal(b.observe().device.last_bolus,null);
});
test('F faults do not change true glucose; gap and bias are actual measurement changes',()=>{
  for(const preset of ['F01','F02','F03','F04']) {
    const {spec}=constructScenario({preset}),control=structuredClone(spec);
    control.overrides.cgm.forced_gaps=[];control.overrides.cgm.compression_lows=[];
    control.overrides.scenario.extra_events=control.overrides.scenario.extra_events.filter(e=>!e.type.startsWith('sensor_'));
    const a=fixedActionEpisode(spec),b=fixedActionEpisode(control);
    assert.deepEqual(trueGrid(a),trueGrid(b));
    const obs=x=>x.trajectory.map(t=>t.next_observation.cgm);
    assert.ok(JSON.stringify(obs(a))!==JSON.stringify(obs(b)),`${preset}: fault must change actual readings`);
    if(preset==='F01')assert.ok(obs(a).some(c=>c.status==='signal_loss'));
  }
});
test('extended delivery really exists before interruption; recovery clears an actual occlusion',()=>{
  const e3=new SimEnv(buildInstanceConfig(constructScenario({preset:'E03'}).spec));
  assert.ok(e3.device.extended);assert.ok(e3.device.ledger.some(d=>d.kind==='extended'&&d.units>0));
  while(e3.now-e3.start<60*60000)e3.step({action_id:`e${e3.step_count}`,expected_step:e3.step_count,action:{type:'WAIT'}});
  assert.ok(e3.device.occlusion);
  const e4=new SimEnv(buildInstanceConfig(constructScenario({preset:'E04'}).spec));assert.ok(e4.device.occlusion);
  while(e4.now-e4.start<65*60000)e4.step({action_id:`e${e4.step_count}`,expected_step:e4.step_count,action:{type:'WAIT'}});
  assert.equal(e4.device.occlusion,null);
});
test('patient and insulin are explicit independent settings, incompatible mechanisms reject early',()=>{
  const r=constructScenario({preset:'D01',patient:{age_years:45,weight_kg:80},therapy:{pump:{insulin:'lispro'}}});
  const c=buildInstanceConfig(r.spec);assert.equal(c.patient.weight_kg,80);assert.equal(c.patient.age_years,45);assert.equal(c.therapy.pump.insulin,'lispro');
  assert.throws(()=>constructScenario({preset:'F04',sensors:{cgm:'dexcom_g6'}}),/calibratable/);
  assert.throws(()=>constructScenario({preset:'E03',therapy:{pump:{model:'omnipod_dash'}}}),/extended/);
});
test('replay labels record visibility correctly and carries the five new metrics',()=>{
  const r=scenarioVariants({preset:'D01'}),a=runFromBundle(fixedActionEpisode(r.variants.I0)),b=runFromBundle(fixedActionEpisode(r.variants.I2));
  assert.ok(a.events.filter(e=>e.type==='meal').every(e=>e.announced));
  assert.ok(b.events.filter(e=>e.type==='meal').every(e=>!e.announced));
  assert.equal(a.metrics.scoring_version,'METRICS-v0.3');assert.ok(Number.isFinite(a.metrics.dynamic.gmi_percent));
  assert.ok(a.packs.includes('illness'));
});
