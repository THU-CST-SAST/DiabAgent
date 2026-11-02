import test from 'node:test';
import assert from 'node:assert/strict';
import {countConfigurations,dimensions,pairwiseDesign,representativeSample,validatePopulation} from '../src/population/catalog.mjs';

test('configuration count is exact and consistent with dimensions', () => {
  const c=countConfigurations(),d=dimensions();
  assert.equal(c.persons.total,144);
  assert.equal(c.therapies.total,d.therapy.length);
  assert.equal(c.instances.person_therapy_sensors,c.persons.total*c.therapies.total*c.sensor_setups.total);
  assert.ok(c.instances.with_controller>c.instances.person_therapy_sensors);
  assert.ok(BigInt(c.instances.with_event_pack_subsets)>BigInt(c.instances.with_controller));
});

test('pairwise design is deterministic and every spec builds', () => {
  const a=pairwiseDesign({seed:3}),b=pairwiseDesign({seed:3});
  assert.deepEqual(a.instances.map(x=>x.spec),b.instances.map(x=>x.spec));
  assert.deepEqual(validatePopulation(a.instances),[]);
  const levels=f=>new Set(a.instances.map(x=>x.factors[f]).filter(v=>v!==undefined));
  assert.equal(levels('person_type').size,8);
  assert.equal(levels('pump').size,dimensions().therapy.filter(t=>t.mode==='pump').reduce((s,t)=>s.add(t.pump.model),new Set()).size);
});

test('representative sample builds and follows prevalence roughly', () => {
  const {instances}=representativeSample(600,{seed:2});
  assert.deepEqual(validatePopulation(instances),[]);
  const pump=instances.filter(x=>x.factors.mode==='pump').length/instances.length;
  assert.ok(pump>0.45&&pump<0.65,`pump share ${pump}`);
  assert.ok(instances.every(x=>x.factors.controller==='manual'||x.factors.mode==='pump'));
});
