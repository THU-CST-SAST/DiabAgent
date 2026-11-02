import test from 'node:test';
import assert from 'node:assert/strict';
import {maskedScenario} from '../src/experiments/scenario-masks.mjs';
import {buildInstanceConfig} from '../src/sim/instance.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';
import {iobAt,cobAt} from '../src/core/estimators.mjs';
import {systemPrompt,observationText} from '../src/bench/prompt.mjs';

const envFor=(row,mode)=>new SimEnv(buildInstanceConfig(row.variants[mode]));

test('I1 withholds a real rescue intake before COB calculation, not only from the displayed list',()=>{
 const row=maskedScenario({preset:'A03'}),full=envFor(row,'I0'),partial=envFor(row,'I1');
 const a=full.observe(),b=partial.observe();
 assert.ok(a.cob.estimate_g>0);assert.equal(b.cob.estimate_g,0);
 assert.ok(a.reported_carbs.length>0);assert.deepEqual(b.reported_carbs,[]);
 assert.ok(a.iob.total_u>0);assert.equal(b.iob.total_u,a.iob.total_u);
 assert.deepEqual(full.world.physiology.snapshot(),partial.world.physiology.snapshot());
});

test('I1 withholds historical insulin before IOB calculation but retains available online delivery',()=>{
 const row=maskedScenario({preset:'A04'}),full=envFor(row,'I0'),partial=envFor(row,'I1');
 assert.ok(full.observe().iob.total_u>0);assert.equal(partial.observe().iob.total_u,0);
 const r=partial.step({action_id:'known-new-dose',expected_step:0,action:{type:'BOLUS',units:1}});
 assert.equal(r.info.action_result.status,'applied');assert.ok(r.observation.iob.total_u>0);
 assert.ok(r.observation.iob.total_u<1);
 const expected=iobAt(partial.world.visibleLedger(),partial.world.now,r.observation.profile.dia_hours,r.observation.insulin.rapid_iob_curve);
 assert.equal(r.observation.iob.total_u,expected.iob);
 assert.ok(partial.world.device.ledger.length>partial.world.visibleLedger().length);
});

test('I2 keeps numeric estimates from empty estimator inputs even with actual prior and new exposure',()=>{
 const row=maskedScenario({preset:'A03'}),full=envFor(row,'I0'),sparse=envFor(row,'I2');
 assert.ok(full.observe().iob.total_u>0);assert.ok(full.observe().cob.estimate_g>0);
 const check=env=>{
   const o=env.observe(),w=env.world;
   assert.ok(w.device.ledger.length>0);assert.ok(w.reportedCarbs.length>0);
   assert.deepEqual(w.visibleLedger(),[]);assert.deepEqual(w.visibleCarbs(),[]);
   const insulin=iobAt(w.visibleLedger(),w.now,o.profile.dia_hours,o.insulin.rapid_iob_curve);
   const carbs=cobAt(w.visibleCarbs(),w.now,w.config.estimates.cob_absorption_minutes);
   assert.equal(o.iob.total_u,insulin.iob);assert.equal(o.cob.estimate_g,carbs.cob);
   assert.deepEqual([o.iob.total_u,o.iob.bolus_u,o.iob.basal_u,o.cob.estimate_g,o.cob.absorbing_reported_g],[0,0,0,0,0]);
   assert.equal(o.iob.history_complete,false);assert.equal(o.cob.history_complete,false);
   assert.match(o.iob.note,/zero estimate does not establish zero actual/);
   assert.match(o.information.note,/withheld before estimation/);
   assert.deepEqual(o.device.insulin_ledger,[]);assert.deepEqual(o.reported_carbs,[]);
 };
 check(sparse);
 const r=sparse.step({action_id:'own-carbs',expected_step:0,action:{type:'INGEST_CARBS',grams:10}});
 assert.equal(r.info.action_result.status,'applied');check(sparse);
 const dose=sparse.step({action_id:'own-bolus',expected_step:1,action:{type:'BOLUS',units:1}});
 assert.equal(dose.info.action_result.status,'applied');check(sparse);
});

test('legacy minimal-v2 stays null, new policy is distinct and does not change physiology',()=>{
 const a=maskedScenario({preset:'A03',informationPolicy:'minimal-v2'}),b=maskedScenario({preset:'A03'});
 assert.notEqual(a.construction.protocol,b.construction.protocol);
 const legacy=envFor(a,'I2'),current=envFor(b,'I2');
 assert.equal(legacy.observe().iob.total_u,null);assert.equal(legacy.observe().cob.estimate_g,null);
 assert.equal(current.observe().iob.total_u,0);assert.equal(current.observe().cob.estimate_g,0);
 assert.deepEqual(legacy.world.physiology.snapshot(),current.world.physiology.snapshot());
 const oldPrompt=systemPrompt({obs:legacy.observe(),config:legacy.world.config});
 assert.match(oldPrompt,/IOB and COB are unknown, not zero/);
 const text=observationText(current.observe());assert.doesNotMatch(text,/undefined|IOB \?/);
});
