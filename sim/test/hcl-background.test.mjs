import test from 'node:test';
import assert from 'node:assert/strict';
import {SimEnv} from '../src/env/pomdp.mjs';

const config=(patch={})=>({horizon_minutes:240,patient:{initial_glucose_mg_dl:240},therapy:{pump:{model:'dana_i',insulin:'aspart'}},cgm:{model:'ideal'},scenario:{meals:{},activity:{enabled:false},extra_events:[]},information:{mode:'I2',policy:'record-derived-v3',own_records:true},controller:{algorithm:'hcl',mode:'closed',expose_actions:true},...patch});
const step=(e,action={type:'WAIT'})=>e.step({action_id:'h'+e.step_count,expected_step:e.step_count,action});
const advance=(e,n)=>{for(let i=0;i<n;i++)step(e);};
const loop=e=>e.world.outbox.treatments.filter(r=>r.source==='loop');

test('HCL delivers device-only insulin on Dana-i, DASH and Combo using public CGM',()=>{
  for(const model of ['dana_i','omnipod_dash','accu_chek_combo']){
    const e=new SimEnv(config({therapy:{pump:{model,insulin:'aspart'}}}));advance(e,24);
    assert(loop(e).length>0,model);
    assert(loop(e).every(r=>['Correction Bolus','Temp Basal'].includes(r.eventType)));
    assert(loop(e).every(r=>(r.at-e.world.start)%300000===0));
    assert.equal(e.world.controller.lastRecommendation.algorithm,'hcl');
    assert.equal(e.observe().true_glucose_mg_dl,undefined);
    const doses=e.world.device.ledger.filter(r=>r.kind==='bolus');
    for(let i=1;i<doses.length;i++)assert(doses[i].at-doses[i-1].at>=15*60000);
    for(const r of e.world.device.ledger.filter(r=>r.source==='loop'))assert(e.observe().device.insulin_ledger.some(x=>Date.parse(x.time)===r.at&&x.units===r.units));
  }
});
test('HCL preserves manual basal priority and stops automatic delivery in open or disabled mode',()=>{
  for(const controller of [{algorithm:'hcl',mode:'open'},{algorithm:'hcl',mode:'closed',enabled:false}]){
    const e=new SimEnv(config({controller}));advance(e,12);assert.equal(loop(e).length,0);
  }
  const e=new SimEnv(config());advance(e,6);
  assert.equal(step(e,{type:'TEMP_BASAL',percent:50,duration_minutes:60}).info.action_result.status,'applied');
  const temp=structuredClone(e.world.device.temp),count=loop(e).length;
  advance(e,8);assert.deepEqual(e.world.device.temp,temp);assert.equal(loop(e).length,count);
  advance(e,6);assert(loop(e).length>count);
});
test('HCL snapshots retain auto-bolus and sample state without duplicate delivery',()=>{
  const e=new SimEnv(config());advance(e,12);const restored=SimEnv.restore(e.snapshot());
  const count=loop(restored).length;restored.world.runController();assert.equal(loop(restored).length,count);
  advance(e,24);advance(restored,24);assert.deepEqual(restored.snapshot(),e.snapshot());
});
