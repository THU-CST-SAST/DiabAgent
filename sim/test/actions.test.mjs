// Action specs per device and sensor, and validation errors.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {World} from '../src/sim/world.mjs';
import {actionSpecs,validateAction,SUSPEND_MINUTES} from '../src/sim/actions.mjs';
import {PUMPS,PENS} from '../src/core/devices.mjs';
import {KNOWLEDGE} from '../src/knowledge.mjs';

const QUIET={meals:{},activity:{enabled:false},extra_events:[]};
const pump=(model,over={})=>new World({scenario:QUIET,therapy:{pump:{model}},cgm:{model:'ideal'},...over});
const pens=(mdi={})=>new World({scenario:QUIET,therapy:{mode:'mdi',mdi},cgm:{model:'ideal'}});
const keys=w=>Object.keys(actionSpecs(w));
const rejects=(w,action,re)=>assert.throws(()=>validateAction(w,action),re);

test('pumps: action set follows device capabilities (extended bolus, bolus cancel, temp basal type)',()=>{
  for(const [id,spec] of Object.entries(PUMPS)) {
    const w=pump(id),k=keys(w),s=actionSpecs(w);
    for(const a of ['WAIT','INGEST_CARBS','BOLUS','TEMP_BASAL','CANCEL_TEMP_BASAL','SUSPEND_PUMP','RESUME_PUMP','CHANGE_INFUSION_SET'])assert.ok(k.includes(a),`${id} offers ${a}`);
    assert.ok(!k.includes('BASAL_INJECTION'),`${id} has no pens`);
    assert.equal(k.includes('EXTENDED_BOLUS'),!!spec.extended,`${id} extended`);
    assert.equal(k.includes('CANCEL_EXTENDED_BOLUS'),!!spec.extended);
    assert.equal(k.includes('CANCEL_BOLUS'),!!spec.cancel_bolus&&Number.isFinite(spec.bolus_speed_u_per_min),`${id} cancel bolus`);
    assert.equal(s.BOLUS.units.max,Math.min(w.config.safety.max_bolus_u,spec.max_bolus_u));
    if(spec.bolus_step_u)assert.equal(s.BOLUS.units.step,spec.bolus_step_u);
    assert.equal(s.TEMP_BASAL.duration_minutes.step,spec.tbr.duration_step_min);
    if(spec.tbr.type==='percent')assert.equal(s.TEMP_BASAL.percent.max,spec.tbr.max);
    assert.deepEqual(s.SUSPEND_PUMP.minutes.enum,KNOWLEDGE.aaps.disconnect_pump_minutes);
  }
  // The specific devices called out in knowledge/devices.json.
  assert.ok(keys(pump('dana_i')).includes('EXTENDED_BOLUS')&&keys(pump('dana_i')).includes('CANCEL_BOLUS'));
  assert.ok(!keys(pump('omnipod_dash')).includes('EXTENDED_BOLUS')&&keys(pump('omnipod_dash')).includes('CANCEL_BOLUS'));
  const combo=pump('accu_chek_combo');
  assert.ok(!keys(combo).includes('EXTENDED_BOLUS')&&!keys(combo).includes('CANCEL_BOLUS'));
  rejects(combo,{type:'EXTENDED_BOLUS',units:1,duration_minutes:60},/does not support extended bolus/);
  rejects(combo,{type:'CANCEL_BOLUS'},/does not support cancelling a bolus/);
  rejects(pump('ideal'),{type:'CANCEL_BOLUS'},/instantly/);
});

test('pens: bolus and basal injection on pen grids; pump actions rejected with a clear reason',()=>{
  const w=pens({bolus_pen:'humalog_junior_kwikpen',bolus_insulin:'lispro',basal_pen:'toujeo_solostar',basal_insulin:'glargine_u300'}),s=actionSpecs(w);
  assert.deepEqual(keys(w).sort(),['BASAL_INJECTION','BOLUS','INGEST_CARBS','WAIT']);
  assert.equal(s.BOLUS.units.step,PENS.humalog_junior_kwikpen.step_u);assert.equal(s.BOLUS.units.max,Math.min(PENS.humalog_junior_kwikpen.max_u,w.config.safety.max_bolus_u));
  assert.equal(s.BASAL_INJECTION.units.max,PENS.toujeo_solostar.max_u);
  for(const type of ['TEMP_BASAL','CANCEL_TEMP_BASAL','EXTENDED_BOLUS','SUSPEND_PUMP','RESUME_PUMP','CHANGE_INFUSION_SET','CANCEL_BOLUS'])
    rejects(w,{type},/not available with pens/);
  rejects(pump('dana_i'),{type:'BASAL_INJECTION',units:10},/only available with pens/);
  const r=w.apply({type:'BASAL_INJECTION',units:12},'b');
  assert.equal(r.status,'applied');assert.equal(w.summary().long_acting_u,12);
  assert.equal(w.apply({type:'BOLUS',units:2.2},'x').applied.units,2);   // 0.5 U pen
});

test('sensor actions: MEASURE_BG with a meter, SCAN with flash, CALIBRATE_CGM with calibrated CGM and meter',()=>{
  const k=over=>keys(new World({scenario:QUIET,therapy:{pump:{model:'dana_i'}},...over}));
  assert.ok(!k({}).includes('MEASURE_BG')&&!k({}).includes('SCAN')&&!k({}).includes('CALIBRATE_CGM'));
  assert.ok(k({meter:{model:'generic_iso15197'}}).includes('MEASURE_BG'));
  assert.ok(k({cgm:{model:'libre_1_scan'}}).includes('SCAN'));
  assert.ok(!k({cgm:{model:'libre_2'}}).includes('SCAN'),'real-time Libre 2 needs no scan');
  assert.ok(k({cgm:{model:'dexcom_g5'},meter:{model:'contour_next_one'}}).includes('CALIBRATE_CGM'));
  rejects(new World({scenario:QUIET}),{type:'MEASURE_BG'},/not available in this instance/);
  // Loop actions only when exposed, and only with a pump.
  assert.ok(!k({}).includes('SET_LOOP_MODE'));
  assert.ok(k({controller:{expose_actions:true}}).includes('SET_TEMP_TARGET'));
});

test('validateAction: shape, unknown fields, ranges, steps, enums and TEMP_BASAL exclusivity',()=>{
  const w=pump('dana_i');
  for(const bad of [null,[],'BOLUS',{},{type:1}])rejects(w,bad,/must be an object with a type/);
  rejects(w,{type:'TELEPORT'},/not available in this instance/);
  rejects(w,{type:'WAIT',units:1},/Unknown action field: units/);
  rejects(w,{type:'BOLUS'},/units must be in \(0, /);
  rejects(w,{type:'BOLUS',units:0},/units must be in \(0, /);
  rejects(w,{type:'BOLUS',units:Infinity},/units/);
  rejects(w,{type:'BOLUS',units:w.config.safety.max_bolus_u+1},/units/);
  rejects(w,{type:'INGEST_CARBS',grams:500},/grams/);
  rejects(w,{type:'TEMP_BASAL',duration_minutes:30},/exactly one of rate_u_h or percent/);
  rejects(w,{type:'TEMP_BASAL',rate_u_h:1,percent:150,duration_minutes:30},/exactly one/);
  rejects(w,{type:'TEMP_BASAL',percent:150,duration_minutes:30.5},/integer/);
  rejects(w,{type:'TEMP_BASAL',percent:250,duration_minutes:30},/percent must be in \[0, 200\]/);
  rejects(w,{type:'SUSPEND_PUMP',minutes:45},/minutes must be one of 15, 30, 60, 120, 180/);
  rejects(w,{type:'SUSPEND_PUMP'},/one of/);
  validateAction(w,{type:'TEMP_BASAL',percent:150,duration_minutes:30});
  validateAction(w,{type:'INGEST_CARBS',grams:15});
  // Rejections become receipts and are counted; time and state are not touched.
  const before=w.now,r=w.apply({type:'SUSPEND_PUMP',minutes:45},'s');
  assert.equal(r.status,'rejected');assert.equal(w.now,before);assert.equal(w.metrics.rejected_actions,1);
});

test('SUSPEND_PUMP uses the AAPS disconnect durations; RESUME_PUMP and CANCEL_BOLUS behave like the pump',()=>{
  assert.deepEqual(SUSPEND_MINUTES,KNOWLEDGE.aaps.disconnect_pump_minutes);
  for(const minutes of SUSPEND_MINUTES) {
    const w=pump('omnipod_dash'),r=w.apply({type:'SUSPEND_PUMP',minutes},'s');
    assert.equal(r.status,'applied');
    assert.equal(Date.parse(r.applied.suspended_until)-w.now,minutes*60000);
    assert.equal(w.observe().device.suspended,true);
    w.advanceTo(w.now+minutes*60000);
    assert.equal(w.observe().device.suspended,false,`resumes after ${minutes} min`);
  }
  const w=pump('dana_i');
  w.apply({type:'SUSPEND_PUMP',minutes:120},'s');
  assert.match(w.apply({type:'BOLUS',units:1},'b').reason,/user_suspended/);
  assert.equal(w.apply({type:'RESUME_PUMP'},'r').status,'applied');
  assert.equal(w.observe().device.suspended,false);
  // Dana-i delivers 5 U/min: a 10 U bolus takes 2 min and can be stopped part-way.
  assert.equal(w.apply({type:'BOLUS',units:10},'b2').status,'applied');
  w.advanceTo(w.now+60000);
  const c=w.apply({type:'CANCEL_BOLUS'},'c');
  assert.equal(c.status,'applied');
  assert.ok(Math.abs(c.applied.delivered_u-5)<1e-9&&Math.abs(c.applied.cancelled_u-5)<1e-9);
  assert.ok(Math.abs(w.metrics.bolus_u-5)<1e-9);
  assert.match(w.apply({type:'CANCEL_BOLUS'},'c2').reason,/No bolus in progress/);
});
