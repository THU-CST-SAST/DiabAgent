// Fingerstick meters, flash (scan-to-read) sensors and fingerstick-calibrated CGMs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Meter,METERS} from '../src/core/meter.mjs';
import {Cgm,CGMS} from '../src/core/cgm.mjs';
import {KNOWLEDGE} from '../src/knowledge.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';
import {World} from '../src/sim/world.mjs';

const QUIET={meals:{},activity:{enabled:false},extra_events:[]};
const act=(env,action={type:'WAIT'})=>env.step({action_id:`a${env.step_count}`,expected_step:env.step_count,action});
const MIN=60000,HOUR=3600000;

/** ISO 15197:2013 accuracy: within +-15 mg/dL below 100 mg/dL, +-15% at or above. */
function meterStats(model,seed=1,n=4000) {
  const m=new Meter({model,seed});let within=0,ard=0,signed=0;
  for(let i=0;i<n;i++) {
    const bg=40+(i*7919%3600)/10;                 // deterministic sweep over 40-400 mg/dL
    const v=m.measure(i*MIN,bg,'test').value,e=v-bg;
    if(bg<100?Math.abs(e)<=15:Math.abs(e)/bg<=0.15)within++;
    ard+=Math.abs(e)/bg;signed+=e/bg;
  }
  return {within:within/n,mard:ard/n,bias:signed/n};
}

test('meters: error statistics meet ISO 15197:2013 (95% within 15 mg/dL / 15%), except the legacy meter',()=>{
  for(const [id,spec] of Object.entries(METERS)) {
    const s=meterStats(id);
    if(id==='onetouch_ultra2_legacy') {
      assert.ok(s.within<0.95,`${id} predates ISO 15197:2013 (${s.within})`);continue;
    }
    assert.ok(s.within>=0.95,`${id}: ${(s.within*100).toFixed(1)}% within ISO limits`);
    assert.ok(s.mard>0.02&&s.mard<0.08,`${id} MARD ${s.mard}`);
    assert.ok(Math.abs(s.bias-spec.error.rel_bias)<0.015,`${id} bias ${s.bias} vs ${spec.error.rel_bias}`);
  }
  // Display clamps to the meter range; the same seed reproduces the same readings.
  const m=new Meter({model:'generic_iso15197',seed:2});
  assert.equal(m.measure(0,700,'x').display,'HI');assert.equal(m.measure(0,5,'x').display,'LO');
  const a=new Meter({model:'contour_next_one',seed:9}),b=new Meter({model:'contour_next_one',seed:9});
  assert.deepEqual([1,2,3].map(i=>a.measure(i,150,'x').value),[1,2,3].map(i=>b.measure(i,150,'x').value));
});

test('meter-only instance: MEASURE_BG reads near true glucose and becomes the visible glucose',()=>{
  const env=new SimEnv({scenario:QUIET,therapy:{pump:{model:'ideal'}},cgm:{model:null},meter:{model:'generic_iso15197'}});
  const o0=env.observe();
  assert.equal(o0.cgm,null);assert.deepEqual(o0.cgm_history,[]);assert.equal(o0.glucose,null);
  assert.ok(o0.available_actions.includes('MEASURE_BG'));assert.ok(!o0.available_actions.includes('SCAN'));
  const r=act(env,{type:'MEASURE_BG'});
  const v=r.info.action_result.applied.value_mg_dl;
  assert.ok(Math.abs(v-120)<20,`fingerstick ${v}`);
  assert.equal(r.observation.glucose.source,'meter');assert.equal(r.observation.glucose.value_mg_dl,v);
  assert.equal(r.observation.meter.readings_last_24h,1);assert.equal(env.summary().fingersticks,1);
});

test('flash sensor: no real-time readings; a scan returns the current value and 8 h of 15-min history',()=>{
  const env=new SimEnv({horizon_minutes:720,scenario:QUIET,therapy:{pump:{model:'ideal'}},
    cgm:{model:'libre_1_scan',scan_window:['23:00','23:00'],gaps:{start_probability_per_sample:0,mean_length_samples:3}},meter:{model:null}});
  env.cgm.sensor.insertedAt=env.now-2*86400000;env.cgm.sensor.readyAt=env.now-2*86400000;   // well within wear
  const seen=[];
  for(let i=0;i<9*12;i++)seen.push(act(env).observation);
  for(const o of seen) {
    assert.equal(o.cgm,null);assert.deepEqual(o.cgm_history,[]);
    assert.equal(o.glucose,null,'nothing visible without a scan');
    assert.ok(o.available_actions.includes('SCAN'));
  }
  assert.ok(!env.world.outbox.samples.some(s=>s.type==='sgv'),'flash sensors publish no sgv records');
  const r=act(env,{type:'SCAN'}),o=r.observation,scan=o.flash.last_scan;
  assert.equal(r.info.action_result.status,'applied');
  assert.ok(Number.isFinite(scan.value_mg_dl)&&Math.abs(scan.value_mg_dl-120)<40);
  assert.equal(o.glucose.source,'flash_scan');
  const times=scan.history.map(h=>Date.parse(h.time)),scanAt=Date.parse(o.flash.last_scan.at);
  assert.equal(times.length,32,'8 h at 15-min intervals');
  for(let i=1;i<times.length;i++)assert.equal(times[i]-times[i-1],15*MIN);
  assert.ok(times.every(t=>t%(15*MIN)===0&&t>scanAt-8*HOUR&&t<=scanAt));
  // Between scans the visible value does not update.
  const later=[];for(let i=0;i<6;i++)later.push(act(env).observation);
  assert.ok(later.every(x=>x.glucose.value_mg_dl===scan.value_mg_dl&&x.glucose.source==='flash_scan'));
  assert.ok(later.at(-1).glucose.age_minutes>=30);
  assert.equal(env.summary().scans,1);
});

test('flash patient routine scans within the scan window; Libre 2 alarms carry no value',()=>{
  const env=new SimEnv({scenario:QUIET,therapy:{pump:{model:'ideal'}},cgm:{model:'libre_2_scan',scan_window:['07:00','10:00'],scan_interval_minutes:60}});
  env.cgm.sensor.insertedAt=env.now-2*86400000;env.cgm.sensor.readyAt=env.now-2*86400000;
  const scans=[];
  while(!env.done()){const o=act(env).observation;scans.push(...o.events.filter(e=>e.type==='flash_scan'));}
  assert.deepEqual(scans.map(s=>new Date(Date.parse(s.time)+8*HOUR).toISOString().slice(11,16)),['07:00','08:00','09:00','10:00']);
  // Drive glucose low with a large bolus; the alarm says low but not how low.
  const low=new SimEnv({horizon_minutes:480,scenario:QUIET,therapy:{pump:{model:'ideal'}},cgm:{model:'libre_2_scan'},safety:{max_bolus_u:25}});
  low.cgm.sensor.insertedAt=low.now-2*86400000;low.cgm.sensor.readyAt=low.now-2*86400000;
  act(low,{type:'BOLUS',units:8});
  let alarm=null;
  while(!low.done()&&!alarm)alarm=act(low).observation.events.find(e=>e.type==='flash_alarm_low');
  assert.ok(alarm,'low alarm raised');
  assert.equal(alarm.value_mg_dl,undefined);assert.match(alarm.note,/scan/);
});

test('calibrated CGM: readings withheld once calibration is overdue; CALIBRATE_CGM restores them',()=>{
  const env=new SimEnv({scenario:QUIET,therapy:{pump:{model:'ideal'}},meter:{model:'contour_next_one'},
    cgm:{model:'dexcom_g5',gaps:{start_probability_per_sample:0,mean_length_samples:3}}});
  const s=env.cgm.sensor;
  s.insertedAt=env.now-86400000;s.readyAt=s.insertedAt;s.calibratedAt=env.now-12*HOUR+20*MIN;   // due in 20 min
  let o=env.observe();
  assert.ok(o.available_actions.includes('CALIBRATE_CGM'));
  assert.equal(o.cgm.calibration.required_now,false);
  for(let i=0;i<3;i++)o=act(env).observation;
  assert.equal(o.cgm.status,'ok');
  for(let i=0;i<9;i++)o=act(env).observation;
  assert.equal(o.cgm.status,'calibration_required');assert.equal(o.cgm.calibration.required_now,true);
  assert.ok(o.cgm.age_minutes>=20,'no new readings while overdue');
  assert.equal(o.cgm.trend_mg_dl_per_min,null);
  const r=act(env,{type:'CALIBRATE_CGM'});
  assert.equal(r.info.action_result.status,'applied');
  const meter=r.info.action_result.applied.meter_value_mg_dl;
  o=r.observation;
  assert.equal(o.cgm.status,'ok');assert.equal(o.cgm.age_minutes,0);
  assert.ok(Math.abs(o.cgm.value_mg_dl-meter)<15,`reading ${o.cgm.value_mg_dl} follows the calibration value ${meter}`);
  assert.equal(Date.parse(o.cgm.calibration.due_at)-Date.parse(o.cgm.calibration.last_calibrated),CGMS.dexcom_g5.calibration.interval_hours*HOUR);
  assert.equal(o.meter.readings_last_24h,1);
  // Calibration is only offered for sensors that take it.
  const g6=new World({cgm:{model:'dexcom_g6'},meter:{model:'contour_next_one'}});
  assert.ok(!g6.availableActions().includes('CALIBRATE_CGM'));
  assert.match(g6.apply({type:'CALIBRATE_CGM'},'c').reason,/not available/);
  assert.throws(()=>new World({cgm:{model:'dexcom_g5'},meter:{model:null}}),/meter/);
});

test('calibrated CGM: the patient routine calibrates at its fingerstick times and keeps readings flowing',()=>{
  const env=new SimEnv({horizon_minutes:2880,scenario:QUIET,therapy:{pump:{model:'ideal'}},meter:{model:'contour_next_one',routine_times:['07:00','19:00']},
    cgm:{model:'medtronic_guardian_3',gaps:{start_probability_per_sample:0,mean_length_samples:3}}});
  const s=env.cgm.sensor;s.insertedAt=env.now-86400000;s.readyAt=s.insertedAt;s.calibratedAt=env.now-5*HOUR;   // due 07:00 local
  let missing=0,n=0,calibrated=0;
  while(!env.done()){const o=act(env).observation;n++;if(o.cgm.age_minutes>10)missing++;calibrated+=o.events.filter(e=>e.cgm_calibrated).length;}
  assert.ok(calibrated>=3,`routine calibrations ${calibrated}`);
  assert.ok(missing/n<0.05,`readings flow (${missing}/${n} stale)`);
});

test('CGM gain is physically bounded: drift over a wear <= 0.15, effective gain within [0.75, 1.25]',()=>{
  const b=KNOWLEDGE.errorModels.padova_g6.bounds,start=Date.parse('2026-10-13T16:00:00Z');
  assert.deepEqual(b,{max_drift_over_wear:0.15,gain:[0.75,1.25]});
  for(const model of ['dexcom_g6','libre_2','libre_1_scan','medtronic_guardian_3'])for(let seed=0;seed<300;seed++) {
    const c=new Cgm({model,seed,start}),wear=CGMS[model].wear_days;
    assert.ok(Math.abs(c.sensor.a1)*wear<=0.15+1e-12,`${model} seed ${seed} a1 ${c.sensor.a1}`);
    for(const d of [0,wear/2,wear]){const g=c.gainAt(c.sensor.insertedAt+d*86400000);assert.ok(g>=0.75&&g<=1.25,`${model} gain ${g}`);}
  }
});
