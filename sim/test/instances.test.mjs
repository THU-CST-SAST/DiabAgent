// Instance presets (knowledge/instances.json), compatibility rules, and the oref0 baseline on
// every therapy / sensor combination.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {KNOWLEDGE} from '../src/knowledge.mjs';
import {buildInstanceConfig,checkCompatibility} from '../src/sim/instance.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';
import {oref0Policy} from '../src/policies/oref0.mjs';

const act=(env,action)=>env.step({action_id:`a${env.step_count}`,expected_step:env.step_count,action});
const PUMP={mode:'pump',pump:{model:'dana_i',insulin:'aspart'}};
const MDI={mode:'mdi',mdi:{bolus_pen:'novopen_echo',bolus_insulin:'aspart',basal_pen:'tresiba_flextouch',basal_insulin:'degludec'}};
const finiteDeep=v=>typeof v==='number'?Number.isFinite(v):v&&typeof v==='object'?Object.values(v).every(finiteDeep):true;

test('every preset builds and runs 24 h of WAIT without error; same seed is bit-identical',()=>{
  const presets=Object.entries(KNOWLEDGE.instances);
  assert.ok(presets.length>=8);
  for(const [id,p] of presets) {
    const cfg=buildInstanceConfig({...p.spec,seed:3});
    assert.equal(cfg.horizon_minutes,1440);
    const env=new SimEnv(cfg);
    while(!env.done()){const r=act(env,{type:'WAIT'});assert.equal(r.info.action_result.status,'applied',id);}
    const s=env.summary();
    assert.equal(s.error,null,`${id}: ${s.error}`);assert.ok(s.completed_horizon,id);
    assert.ok(s.min_glucose>20&&s.max_glucose<600,`${id} glucose ${s.min_glucose}-${s.max_glucose}`);
    // Sensor habits follow from the sensors.
    if(!cfg.cgm.model)assert.ok(s.fingersticks>=3,`${id}: fingerstick routine`);
    if(cfg.cgm.model&&KNOWLEDGE.sensors[cfg.cgm.model].modality==='flash')assert.ok(s.scans>=5,`${id}: scan routine`);
    const again=new SimEnv(buildInstanceConfig({...p.spec,seed:3}));
    while(!again.done())act(again,{type:'WAIT'});
    assert.equal(again.manifest().trajectory_sha256,env.manifest().trajectory_sha256,`${id} deterministic`);
  }
});

test('checkCompatibility rejects invalid device, insulin, sensor and event combinations',()=>{
  const bad=(spec,re)=>assert.throws(()=>buildInstanceConfig({seed:1,sensors:{cgm:'dexcom_g6',meter:null},...spec}),re);
  bad({therapy:{mode:'pump',pump:{model:'dana_i',insulin:'degludec'}}},/degludec cannot be used in a pump/);
  bad({therapy:{mode:'pump',pump:{model:'dana_i',insulin:'regular_human'}}},/cannot be used in a pump/);
  bad({therapy:{mode:'pump',pump:{model:'tandem_tslim'}}},/Unknown pump/);
  bad({therapy:{mode:'mdi',mdi:{...MDI.mdi,bolus_pen:'humalog_kwikpen',bolus_insulin:'aspart'}}},/does not deliver aspart/);
  bad({therapy:{mode:'mdi',mdi:{...MDI.mdi,basal_pen:'novopen_6',basal_insulin:'aspart'}}},/not a long-acting insulin/);
  bad({therapy:{mode:'inhaled'}},/Unknown therapy mode/);
  bad({therapy:PUMP,sensors:{cgm:'dexcom_g5',meter:null}},/needs a meter for calibration/);
  bad({therapy:PUMP,sensors:{cgm:'medtronic_guardian_3'}},/needs a meter/);
  bad({therapy:PUMP,sensors:{cgm:null,meter:null}},/needs a CGM or a meter/);
  bad({therapy:PUMP,sensors:{cgm:'dexcom_g99'}},/Unknown sensor/);
  bad({therapy:PUMP,sensors:{cgm:null,meter:'acme'}},/Unknown meter/);
  // Event packs that do not apply to this person or therapy.
  bad({person:{type:'adult_male'},therapy:PUMP,events:['menstrual']},/menstrual does not apply/);
  bad({person:null,therapy:PUMP,events:['menstrual']},/menstrual does not apply/);
  bad({person:{type:'child_female'},therapy:PUMP,events:['menstrual']},/does not apply/);
  bad({person:{type:'older_female'},therapy:PUMP,events:['menstrual']},/does not apply/);
  bad({person:{type:'adult_male'},therapy:MDI,events:['occlusion_faults']},/occlusion_faults does not apply/);
  bad({therapy:PUMP,events:['zombie_apocalypse']},/Unknown event pack/);
  // Valid combinations pass.
  checkCompatibility({therapy:PUMP,sensors:{cgm:'dexcom_g5',meter:'contour_next_one'}});
  checkCompatibility({therapy:MDI,sensors:{cgm:null,meter:'generic_iso15197'}});
  for(const type of ['adult_female','adolescent_female'])
    assert.equal(buildInstanceConfig({seed:1,person:{type},therapy:PUMP,sensors:{cgm:'dexcom_g6'},events:['menstrual']}).scenario.menstrual.enabled,true);
});

test('oref0 baseline is null-safe on every therapy and sensor setup (meter-only, flash, calibrated, MDI)',()=>{
  const setups=[
    ['pump meter-only',PUMP,{cgm:null,meter:'generic_iso15197'}],
    ['pump flash',PUMP,{cgm:'libre_1_scan',meter:null}],
    ['pump calibrated',{mode:'pump',pump:{model:'accu_chek_combo',insulin:'lispro'}},{cgm:'dexcom_g5',meter:'contour_next_one'}],
    ['pump cgm',{mode:'pump',pump:{model:'omnipod_dash',insulin:'fiasp'}},{cgm:'dexcom_g7',meter:null}],
    ['mdi meter-only',MDI,{cgm:null,meter:'accu_chek_guide'}],
    ['mdi flash',MDI,{cgm:'libre_2_scan',meter:null}],
    ['mdi cgm',MDI,{cgm:'dexcom_g6',meter:null}],
  ];
  for(const [name,therapy,sensors] of setups) {
    const env=new SimEnv(buildInstanceConfig({seed:9,person:{type:'adult_male'},therapy,sensors,events:['baseline']}));
    const types=new Set();
    while(!env.done()) {
      const d=oref0Policy(env.observe());
      assert.ok(finiteDeep(d.action),`${name}: finite action ${JSON.stringify(d.action)}`);
      assert.equal(d.nonfinite,false,`${name}: ${d.rationale}`);
      types.add(d.action.type);
      const r=act(env,d.action);
      assert.equal(r.info.action_result.status,'applied',`${name}: ${JSON.stringify(d.action)} ${r.info.action_result.reason}`);
    }
    assert.equal(env.summary().error,null);
    if(therapy.mode==='mdi')assert.ok([...types].every(t=>t==='WAIT'||t==='BOLUS'),`${name}: MDI only waits or corrects`);
    else assert.ok([...types].every(t=>t==='WAIT'||t==='TEMP_BASAL'),`${name}: pump never boluses`);
  }
  // Hand-built observations: nothing visible means WAIT; a stale reading does not dose.
  const env=new SimEnv(buildInstanceConfig({seed:1,therapy:PUMP,sensors:{cgm:null,meter:'generic_iso15197'}}));
  const o=env.observe();
  assert.equal(o.cgm,null);assert.equal(o.glucose,null);
  assert.deepEqual(oref0Policy(o).action,{type:'WAIT'});
  assert.deepEqual(oref0Policy({...o,glucose:{value_mg_dl:250,age_minutes:90,time:o.virtual_time,source:'meter'}}).action,{type:'WAIT'});
  assert.deepEqual(oref0Policy({...o,glucose:{value_mg_dl:NaN,age_minutes:0,time:o.virtual_time,source:'meter'}}).action,{type:'WAIT'});
  // A fresh low fingerstick on a pump reduces basal; a fresh high one never raises it above schedule.
  const low=oref0Policy({...o,glucose:{value_mg_dl:65,age_minutes:0,time:o.virtual_time,source:'meter'}});
  assert.equal(low.action.type,'TEMP_BASAL');assert.ok(low.action.rate_u_h<o.profile.basal_u_h);
  const high=oref0Policy({...o,glucose:{value_mg_dl:260,age_minutes:0,time:o.virtual_time,source:'meter'}});
  assert.ok(high.action.type==='WAIT'||high.action.rate_u_h<o.profile.basal_u_h);
  // MDI: conservative correction only for a fresh high reading, reduced by IOB, on the pen grid.
  const m=new SimEnv(buildInstanceConfig({seed:1,therapy:MDI,sensors:{cgm:null,meter:'generic_iso15197'}})),mo=m.observe();
  const g=v=>({...mo,glucose:{value_mg_dl:v,age_minutes:2,time:mo.virtual_time,source:'meter'}});
  assert.deepEqual(oref0Policy(g(170)).action,{type:'WAIT'});
  const c=oref0Policy(g(300)).action,isf=mo.profile.isf_mg_dl_per_u,target=mo.profile.target_mg_dl;
  assert.equal(c.type,'BOLUS');
  assert.ok(c.units<=(300-target)/isf&&c.units>0&&Number.isInteger(c.units/mo.action_specs.BOLUS.units.step));
  assert.deepEqual(oref0Policy({...g(300),iob:{...mo.iob,total_u:20}}).action,{type:'WAIT'},'IOB covers the correction');
  assert.deepEqual(oref0Policy({...g(300),device:{...mo.device,last_bolus:{time:mo.virtual_time,units:1}}}).action,{type:'WAIT'},'no stacking');
});
