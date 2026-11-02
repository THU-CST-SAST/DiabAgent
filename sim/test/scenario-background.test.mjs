import test from 'node:test';
import assert from 'node:assert/strict';
import {backgroundClock} from '../src/experiments/scenario-background.mjs';
import {MASK_CASES,maskedScenario,CLOCK_ESTIMATE_PROTOCOL} from '../src/experiments/scenario-masks.mjs';
import {auditScenario} from '../src/experiments/scenario-generator.mjs';
import {systemPrompt,observationText,optionsPromptText} from '../src/bench/prompt.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';
import {buildInstanceConfig} from '../src/sim/instance.mjs';

test('background clock draws are deterministic, bounded, independently named, and seed-sensitive',()=>{
 const offsets=MASK_CASES.map(([p])=>backgroundClock(p,20261018).clock_offset_minutes);
 assert.ok(new Set(offsets).size>4);
 for(const [p] of MASK_CASES){
   const a=backgroundClock(p,20261018);assert.deepEqual(a,backgroundClock(p,20261018));
   assert.ok(Math.abs(a.clock_offset_minutes)<=30);assert.equal(Math.abs(a.clock_offset_minutes%5),0);
 }
 assert.notDeepEqual(offsets,MASK_CASES.map(([p])=>backgroundClock(p,20261019).clock_offset_minutes));
 assert.throws(()=>backgroundClock('A01',NaN),/seed/);
});

for(const [preset] of MASK_CASES)test(`${preset}: background clock leaves mechanisms unchanged and all masks physically aligned`,()=>{
 const base=maskedScenario({preset}),row=maskedScenario({preset,backgroundSeed:20261018});
 assert.equal(row.construction.protocol,CLOCK_ESTIMATE_PROTOCOL);
 const stripClock=spec=>{
   const s=structuredClone(spec);delete s.start_time;
   for(const e of s.overrides.scenario.extra_events)if(e.type==='record')e.text=e.text.replace(/\b\d{2}:\d{2}\b/g,'CLOCK');
   return s;
 };
 assert.deepEqual(stripClock(row.spec),stripClock(base.spec));
 for(const mode of ['I0','I1','I2'])assert.equal(row.variants[mode].start_time,row.spec.start_time);
 const otherModel=maskedScenario({preset,backgroundSeed:20261018});assert.deepEqual(row,otherModel);
 assert.equal(auditScenario(row).max_truth_difference_mgdl,0);
 for(const e of row.spec.overrides.scenario.extra_events.filter(e=>e.type==='meal'||e.type==='exercise')) {
   const plan=row.spec.overrides.scenario.extra_events.find(p=>p.id===`plan-${e.id}`);
   if(!plan)continue;
   const local=new Date(Date.parse(row.spec.start_time)+(480+e.at_minute)*60000).toISOString().slice(11,16);
   assert.ok(plan.text.includes(local),`${preset} ${e.id} plan time does not match its event`);
 }
});

test('I2 prompt consistently describes numeric record-derived estimates and no automatic calibration',()=>{
 const r=maskedScenario({preset:'A01',backgroundSeed:20261018}),cfg=buildInstanceConfig(r.variants.I2),obs=new SimEnv(cfg).observe();
 const sys=systemPrompt({obs,config:cfg,units:'mgdl'}),text=observationText(obs,{units:'mgdl'});
 assert.match(sys,/record-derived IOB\/COB estimates/);
 assert.match(sys,/records may be missing or withheld/);
 assert.doesNotMatch(sys,/IOB and COB are unknown/);
 assert.match(sys,/No automatic routine fingersticks are scheduled/);
 assert.doesNotMatch(sys,/person does routine fingersticks/);
 assert.doesNotMatch(sys,/glucose 7\.8 flat/);
 assert.match(sys,/format-only example/);assert.match(sys,/"type": "WAIT"/);
 assert.match(sys,/simulate tool.*beforehand/);
 assert.match(optionsPromptText({simulate:true,simulate_calls:1,memory:'none'}),/up to 1 times per decision/);
 assert.doesNotMatch(text,/undefined/);assert.match(text,/Record-derived estimates: IOB 0 U/);
 assert.match(text,/COB 0 g/);assert.match(text,/Current information status:/);
 assert.doesNotMatch(text,/Record availability I2|IOB caution:|COB caution:|All meal|withheld before estimation/);
 cfg.meter.routine_times=['07:00','19:00'];
 assert.match(systemPrompt({obs,config:cfg}),/routine fingersticks at 07:00, 19:00/);
});
