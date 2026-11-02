import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SimEnv} from '../src/env/pomdp.mjs';
import {buildInstanceConfig} from '../src/sim/instance.mjs';
import {HARD_PRESETS,hardVariants,buildHardScenarios} from '../src/experiments/scenario-hard.mjs';
import {auditScenario,fixedActionEpisode} from '../src/experiments/scenario-generator.mjs';
import {trueGrid,readJson} from '../src/bench/score.mjs';
import {publicInfo} from '../src/export/harbor.mjs';

const quiet=extra=>({seed:41,cgm:{model:'ideal'},meter:{model:'generic_iso15197',routine_times:[]},
  scenario:{meals:{},extra_events:extra,activity:{enabled:false},stress:{enabled:false}},horizon_minutes:240,controller:{enabled:false}});
const step=(e,a={type:'WAIT'})=>e.step({action_id:`x${e.step_count}`,expected_step:e.step_count,action:a});
const until=(e,m)=>{while((e.now-e.start)/60000<m&&!e.done())step(e);};

test('silent underdelivery changes tissue exposure, not pump ledger; replacement clears it without resetting physiology',()=>{
  const a=new SimEnv(quiet([{id:'leak',type:'infusion_deficit',at_minute:0,duration_minutes:180,delivered_fraction:.2}])),b=new SimEnv(quiet([]));
  step(a,{type:'BOLUS',units:3});step(b,{type:'BOLUS',units:3});until(a,90);until(b,90);
  assert.deepEqual(a.observe().device.insulin_ledger,b.observe().device.insulin_ledger);
  assert.equal(a.observe().device.suspended,false);assert.ok(a.physiology.glucose()>b.physiology.glucose()+10);
  assert.equal(a.world.deliveryFraction(),.2);
  const before=a.physiology.snapshot();const r=a.apply({type:'CHANGE_INFUSION_SET'},'replace');
  assert.equal(r.status,'applied');assert.equal(a.world.deliveryFraction(),1);assert.deepEqual(a.physiology.snapshot(),before);
  assert.ok(!JSON.stringify(a.observe()).includes('actual_delivery_fraction'));
});
test('sensor drift ramps, leaves true glucose untouched and expires',()=>{
  const a=new SimEnv(quiet([{id:'drift',type:'sensor_drift',at_minute:0,duration_minutes:120,bias_mg_dl:60,ramp_minutes:30}])),b=new SimEnv(quiet([]));
  assert.equal(a.observe().glucose.value_mg_dl,b.observe().glucose.value_mg_dl);
  until(a,30);until(b,30);assert.ok(Math.abs(a.observe().glucose.value_mg_dl-b.observe().glucose.value_mg_dl-60)<1e-9);
  assert.equal(a.physiology.glucose(),b.physiology.glucose());
  until(a,125);until(b,125);assert.equal(a.observe().glucose.value_mg_dl,b.observe().glucose.value_mg_dl);
});
test('alcohol report precedes a delayed physical effect; no immediate hepatic input',()=>{
  const a=new SimEnv(quiet([{id:'drink',type:'alcohol',at_minute:0,onset_hours:1,duration_hours:2,hepatic_delta_mg_dl_per_min:-.5,announced:true}])),b=new SimEnv(quiet([]));
  assert.ok(a.observe().events.some(e=>e.type==='alcohol_reported'));
  until(a,55);until(b,55);assert.equal(a.physiology.glucose(),b.physiology.glucose());
  until(a,150);until(b,150);assert.ok(a.physiology.glucose()<b.physiology.glucose()-10);
});
for(const preset of Object.keys(HARD_PRESETS))test(`${preset}: frozen compound inputs, distinct projections, invariant WAIT physiology`,()=>{
  const r=hardVariants({preset}),a=auditScenario(r);assert.equal(a.max_truth_difference_mgdl,0);
  const cfg=buildInstanceConfig(r.variants.I2),pub=JSON.stringify(publicInfo(r.variants.I2,cfg));
  assert.doesNotMatch(pub,/delivered_fraction|extra_events|bias_mg_dl|true_glucose/);
});
test('same non-WAIT script is physically identical across record masks, including site replacement',()=>{
  const r=hardVariants({preset:'H15'}),actionAt=e=>(e.now-e.start)/60000===90?{type:'CHANGE_INFUSION_SET'}:{type:'WAIT'};
  assert.deepEqual(trueGrid(fixedActionEpisode(r.variants.I0,{actionAt})),trueGrid(fixedActionEpisode(r.variants.I2,{actionAt})));
});
test('hard builder never overwrites a directory',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'sweet-hard-'));try{assert.throws(()=>buildHardScenarios(d),/No overwrite/);}finally{fs.rmSync(d,{recursive:true});}
});
test('R2 load envelope is deterministic and retains all compound families with invariant physics',()=>{
 for(const preset of Object.keys(HARD_PRESETS)) {
   const r=hardVariants({preset,revision:'r2'}),events=r.spec.overrides.scenario.extra_events;
   assert.ok(events.filter(e=>e.type==='meal').reduce((s,e)=>s+e.grams,0)<=244);
   assert.ok(events.filter(e=>e.type==='meal').every(e=>e.absorption_minutes>=60));
   assert.ok(events.filter(e=>e.type==='exercise').every(e=>e.duration_minutes<=60&&e.accelerometer_counts<=2095));
   assert.equal(auditScenario(r).max_truth_difference_mgdl,0);
   assert.equal(r.construction.protocol,'scenario-compound/v3-hard-r2');
 }
});
test('all 24 V2 WAIT physical trajectories match the independent sealed archive',{skip:!process.env.SWEET_V2_ARCHIVE},()=>{
  const root=path.join(process.env.SWEET_V2_ARCHIVE,'jobs/scenario24-wait-20261017');
  assert.ok(fs.existsSync(root),'sealed V2 evidence required for this local regression');
  let n=0;
  for(const d of fs.readdirSync(root))if(fs.existsSync(path.join(root,d,'trial.json'))) {
    const b=readJson(path.join(root,d,'verifier/bundle.json.gz')),e=new SimEnv(b.manifest.config);
    while(!e.done())step(e);
    assert.deepEqual(trueGrid(e.exportBundle()),trueGrid(b),d);n++;
  }
  assert.equal(n,24);
});
