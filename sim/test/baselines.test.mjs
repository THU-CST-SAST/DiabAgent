// Classical care baselines (src/policies/care.mjs B1/B2, hcl.mjs B3, oref1.mjs B4): no leakage of
// hidden information, observation-only and hardware-legal actions, assisted-care consistency
// (no double dosing), the guideline rules that the scenarios exercise, and N/A applicability.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SimEnv} from '../src/env/pomdp.mjs';
import {buildInstanceConfig} from '../src/sim/instance.mjs';
import {KNOWLEDGE as K} from '../src/knowledge.mjs';
import {POLICIES} from '../src/viz/run.mjs';
import {quantBolus,tempBasalAction} from '../src/policies/care.mjs';
import {notApplicable} from '../scripts/baselines.mjs';

const BASELINES=['standard','guideline','hcl','oref1'];
const preset=id=>({seed:1,...K.instances[id].spec});
const deepFreeze=o=>{for(const v of Object.values(o))if(v&&typeof v==='object')deepFreeze(v);return Object.freeze(o);};

/** Plays a baseline; returns per-step {minute, action, status, reason} and the env. */
function play(spec,policy,{freeze=false}={}) {
  // These tests exercise the original algorithm mechanics, explicitly at the historical cadence.
  const env=new SimEnv(buildInstanceConfig(spec)),decide=POLICIES[policy]({decision_schedule:'event-driven'}),t0=env.start,steps=[],events=[];
  while(!env.done()) {
    const obs=env.observe();
    for(const e of obs.events)events.push({minute:(Date.parse(e.time)-t0)/60000,...e});
    const d=decide(freeze?deepFreeze(structuredClone(obs)):obs);
    const r=env.step({action_id:`${policy}-${env.step_count}`,expected_step:env.step_count,action:d.action,rationale:String(d.rationale).slice(0,4000)});
    steps.push({minute:(Date.parse(obs.virtual_time)-t0)/60000,action:d.action,status:r.info.action_result.status,reason:r.info.action_result.reason});
  }
  return {steps,events,env};
}

test('registered in the policy table used by the reference runner',()=>{
  for(const p of BASELINES)assert.equal(typeof POLICIES[p](),'function',p);
});

test('no leakage: instances sharing observations up to t make identical decisions up to t',()=>{
  const t=150;
  const base={...preset('adult_dana_g6'),horizon_minutes:420};
  const hidden={...base,overrides:{scenario:{extra_events:[
    {id:'snack',type:'meal',at_minute:t,grams:45,absorption_minutes:30,announced_grams:null},
    {id:'stress',type:'stress',at_minute:t+30,duration_minutes:60,hepatic_delta_mg_dl_per_min:0.3}]}}};
  for(const p of BASELINES) {
    const a=play(base,p),b=play(hidden,p);
    const upTo=r=>r.steps.filter(s=>s.minute<=t).map(s=>[s.minute,JSON.stringify(s.action)]);
    assert.deepEqual(upTo(b),upTo(a),`${p}: decisions before the hidden events must coincide`);
    // The hidden events change what happens afterwards (the test is not vacuous).
    const after=r=>r.env.exportBundle().evaluator_only.states.slice(-30).map(x=>x.true_glucose_mg_dl);
    assert.notDeepEqual(after(b),after(a),`${p}: hidden events had no effect`);
  }
});

test('observation-only: policies take no hidden inputs and never mutate the observation',()=>{
  // The factories take no arguments (no config, no env); a deep-frozen observation is enough.
  for(const p of BASELINES) {
    assert.equal(POLICIES[p].length,0);
    const r=play({...preset('teen_dash_fiasp_g7'),horizon_minutes:360},p,{freeze:true});
    assert.ok(r.steps.length>50);
  }
});

test('hardware-legal: every action is applied on percent / absolute pumps, pens and meter-only, both tracks',()=>{
  for(const id of ['adult_dana_g6','teen_dash_fiasp_g7','adult_combo_guardian3','older_mdi_smbg','adult_mdi_libre2_scan'])
    for(const self_care of ['none','assisted'])for(const p of BASELINES) {
      const r=play({...preset(id),self_care,horizon_minutes:480},p);
      const bad=r.steps.filter(s=>s.status!=='applied');
      assert.deepEqual(bad.map(s=>`${s.minute}:${JSON.stringify(s.action)}:${s.reason}`),[],`${id}/${self_care}/${p}`);
      const kinds=new Set(r.steps.map(s=>s.action.type));
      if(id.includes('mdi'))assert.ok(!kinds.has('TEMP_BASAL'),`${id}/${p}: temp basal on pens`);
      if(p==='standard')assert.ok(!kinds.has('TEMP_BASAL')&&!kinds.has('EXTENDED_BOLUS'),`${id}: B1 keeps the fixed basal`);
    }
});

test('B1 bolus calculator doses announced meals on the full track (IOB-aware, device grid)',()=>{
  const r=play({...preset('adult_dana_g6'),horizon_minutes:600},'standard');
  const meals=r.events.filter(e=>e.type==='meal_announced');
  assert.ok(meals.length>=1);
  for(const m of meals) {
    const b=r.steps.find(s=>s.action.type==='BOLUS'&&s.minute>=m.minute&&s.minute<=m.minute+20);
    assert.ok(b,`meal at ${m.minute} min dosed`);
  }
  const obs=new SimEnv(buildInstanceConfig(preset('older_mdi_smbg'))).observe();
  assert.equal(quantBolus(obs,2.4),Math.round(2.4/obs.action_specs.BOLUS.units.step)*obs.action_specs.BOLUS.units.step);
  const dana=new SimEnv(buildInstanceConfig(preset('adult_dana_g6'))).observe(),a=tempBasalAction(dana,dana.device.scheduled_basal_u_h*0.5,45);
  assert.ok(a.percent!=null&&a.percent%dana.action_specs.TEMP_BASAL.percent.step===0&&a.duration_minutes%15===0,JSON.stringify(a));
});

/** Plays an assisted instance; returns meal announcements, the person's boluses and the baseline's boluses. */
function assisted(policy,overrides={}) {
  const r=play({...preset('adult_dana_g6'),self_care:'assisted',horizon_minutes:600,...overrides},policy);
  return {announced:r.events.filter(e=>e.type==='meal_announced'),person:r.events.filter(e=>e.type==='patient_bolus'),
    boluses:r.steps.filter(s=>s.status==='applied'&&(s.action.type==='BOLUS'||s.action.type==='EXTENDED_BOLUS')),
    carbs:r.steps.filter(s=>s.status==='applied'&&s.action.type==='INGEST_CARBS'),steps:r.steps};
}

test('assisted: no baseline bolus while the person\'s meal bolus is pending, no meal-sized double dose',()=>{
  for(const p of BASELINES) {
    const r=assisted(p);
    assert.ok(r.announced.length>=1&&r.person.length>=1,`${p}: the person bolused`);
    for(const m of r.announced) {
      const own=r.person.find(b=>b.minute>=m.minute);
      const during=r.boluses.filter(b=>b.minute>=m.minute&&b.minute<(own?own.minute:m.minute+20));
      assert.deepEqual(during,[],`${p}: bolus while the person's bolus was pending`);
      const after=r.boluses.filter(b=>b.minute>=m.minute&&b.minute<=m.minute+90).reduce((s,b)=>s+b.action.units,0);
      assert.ok(after<0.5*(own?.units??1),`${p}: ${after} U next to the person's ${own?.units} U`);
    }
  }
});

test('assisted: a forgotten meal bolus is dosed by the baseline after the person\'s window',()=>{
  for(const p of ['standard','guideline']) {
    const r=assisted(p,{overrides:{self_care:{meal_bolus:{miss_probability:1}}}});
    assert.equal(r.person.length,0);
    const m=r.announced[0];assert.ok(m);
    const b=r.boluses.find(x=>x.minute>=m.minute+20&&x.minute<=m.minute+40);
    assert.ok(b&&b.action.units>1,`${p}: forgotten meal dosed (${JSON.stringify(b)})`);
  }
});

test('B2 guideline rules: exercise temp basal, resume a forgotten suspension, make up a missed long-acting dose',()=>{
  // Planned aerobic exercise on a pump: 50 % temp basal before the session (B1: nothing).
  const ex={...preset('adult_dana_g6'),horizon_minutes:720,overrides:{scenario:{activity:{enabled:true,probability:1,time:'17:00',time_jitter_minutes:0,
    duration_minutes:60,accelerometer_counts:3500,announced:true,advance_notice_minutes:60}}},start_time:'2026-10-14T06:00:00.000Z'};
  const g=play(ex,'guideline'),s=play(ex,'standard');
  const plan=g.events.find(e=>e.type==='exercise_planned');assert.ok(plan,'exercise planned');
  const temp=g.steps.find(x=>x.action.type==='TEMP_BASAL'&&x.minute>=plan.minute&&x.minute<=plan.minute+30);
  assert.ok(temp&&temp.action.percent<=60,`B2 temp basal ${JSON.stringify(temp)}`);
  assert.ok(!s.steps.some(x=>x.action.type==='TEMP_BASAL'));
  // Pump left suspended for hours: B2 resumes it at once; B1 only when it needs to bolus.
  const susp={...preset('adult_dana_g6'),horizon_minutes:240,overrides:{initial_state:{history_minutes:60,history:[{type:'suspend_pump',minutes_before:60,minutes:480}]}}};
  assert.equal(play(susp,'guideline').steps[0].action.type,'RESUME_PUMP');
  // Pens: the last routine long-acting dose was missed -> B2 makes it up (B1 does not).
  const miss={...preset('older_mdi_smbg'),horizon_minutes:180,overrides:{therapy:{mdi:{missed_doses_before_start:1}}}};
  const inj=play(miss,'guideline').steps.find(x=>x.action.type==='BASAL_INJECTION');
  assert.ok(inj&&inj.status==='applied',JSON.stringify(inj));
  assert.ok(!play(miss,'standard').steps.some(x=>x.action.type==='BASAL_INJECTION'));
});

test('closed loops modulate basal on pumps and are N/A on pens and without a real-time CGM',()=>{
  for(const p of ['hcl','oref1']) {
    const r=play({...preset('adult_dana_g6'),horizon_minutes:360},p);
    assert.ok(r.steps.filter(s=>s.action.type==='TEMP_BASAL'&&s.status==='applied').length>=3,`${p} adjusts the basal`);
    assert.match(notApplicable(p,{family:'pens',factors:{sensor_setup:'cgm'}}),/pens/);
    assert.match(notApplicable(p,{family:'pump',factors:{sensor_setup:'flash'}}),/real-time CGM/);
    assert.equal(notApplicable(p,{family:'pump',factors:{sensor_setup:'calibrated_cgm'}}),null);
  }
  for(const p of ['standard','guideline'])assert.equal(notApplicable(p,{family:'pens',factors:{sensor_setup:'meter_only'}}),null);
});
