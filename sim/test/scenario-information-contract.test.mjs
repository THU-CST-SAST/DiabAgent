import test from 'node:test';
import assert from 'node:assert/strict';
import {MASK_CASES,maskedScenario,FAMILIES} from '../src/experiments/scenario-masks.mjs';
import {fixedActionEpisode} from '../src/experiments/scenario-generator.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';
import {buildInstanceConfig} from '../src/sim/instance.mjs';

test('the original 24 cases occur exactly once, four per A-F family, in sorted order',()=>{
 assert.equal(MASK_CASES.length,24);assert.equal(new Set(MASK_CASES.map(r=>r[1])).size,24);
 assert.deepEqual(MASK_CASES.map(r=>r[0]),Object.keys(FAMILIES).flatMap(f=>[1,2,3,4].map(n=>`${f}0${n}`)));
 assert.deepEqual(MASK_CASES.map(r=>r[1]).sort(),Array.from({length:24},(_,i)=>`H${String(i+1).padStart(2,'0')}`));
});

for(const [preset] of MASK_CASES)test(`${preset}: every named I1 report really exists in I0 and is withheld, not just an inert mask rule`,()=>{
 const r=maskedScenario({preset}),bundles=['I0','I1'].map(m=>fixedActionEpisode(r.variants[m]));
 const obs=b=>[b.initial_observation,...b.trajectory.map(t=>t.next_observation)];
 const events=b=>obs(b).flatMap(o=>o.events);
 const [complete,partial]=bundles.map(events);
 for(const rule of r.rules) {
   for(const id of rule.ids??[]) {
     if(id==='history:2')continue; // No notice for this record; the paired carb assertion below covers it.
     assert.ok(complete.some(e=>e.id===id),`${preset}: ${id} never became visible in I0`);
     assert.ok(!partial.some(e=>e.id===id),`${preset}: ${id} leaked into I1`);
   }
   if(rule.category==='treatment') {
     const start=Date.parse(bundles[0].initial_observation.virtual_time);
     assert.ok(bundles[0].initial_observation.device.insulin_ledger.some(d=>Date.parse(d.time)<start));
     assert.ok(!bundles[1].initial_observation.device.insulin_ledger.some(d=>Date.parse(d.time)<start));
     // Scheduled basal has no net-IOB ledger entry; explicitly create a new logged action.
     const online=new SimEnv(buildInstanceConfig(r.variants.I1));
     const receipt=online.step({action_id:'own-after-start',expected_step:0,action:{type:'BOLUS',units:1}});
     assert.equal(receipt.info.action_result.status,'applied');
     assert.ok(receipt.observation.device.insulin_ledger.some(d=>Date.parse(d.time)>=start&&d.kind==='bolus'&&d.units===1),'I1 is selective: new online delivery remains visible');
   }
 }
 if(preset==='A03') {
   assert.ok(bundles[0].initial_observation.reported_carbs.some(c=>c.grams===15));
   assert.deepEqual(bundles[1].initial_observation.reported_carbs,[]);
 }
 assert.ok(partial.length>0,`${preset}: I1 must retain some available reports, not become I2`);
});
