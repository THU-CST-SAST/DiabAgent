import test from 'node:test';
import assert from 'node:assert/strict';
import {SimEnv} from '../src/env/pomdp.mjs';
import {makeAutosens} from '../src/policies/oref1.mjs';
import {systemPrompt} from '../src/bench/prompt.mjs';
import {publicDescription} from '../src/oracle/belief.mjs';

const config=(patch={})=>({horizon_minutes:480,patient:{initial_glucose_mg_dl:240},
  therapy:{pump:{model:'dana_i',insulin:'aspart'}},cgm:{model:'ideal'},
  scenario:{meals:{},activity:{enabled:false},extra_events:[]},
  information:{mode:'I2',policy:'record-derived-v3',own_records:true},
  controller:{algorithm:'oref1',mode:'closed'},...patch});
const step=(env,action={type:'WAIT'})=>env.step({action_id:`t${env.step_count}`,expected_step:env.step_count,action});
const advance=(env,n)=>{for(let i=0;i<n;i++)step(env);};
const loopTreatments=env=>env.world.outbox.treatments.filter(x=>x.source==='loop');

test('oref1 is explicit opt-in; unknown algorithms fail closed',()=>{
  assert.throws(()=>new SimEnv(config({controller:{algorithm:'oops'}})),/controller.algorithm/);
  const a=new SimEnv(config({controller:{mode:'closed'}}));
  const b=new SimEnv(config({controller:{algorithm:'oref0',mode:'closed'}}));
  advance(a,24);advance(b,24);
  assert.equal(a.config.controller.algorithm,undefined);
  const explicit=b.snapshot();delete explicit.world.config.controller.algorithm;
  assert.deepEqual(a.snapshot(),explicit);
});

test('Dana-i/Aspart executes native percent basal and SMB on the five-minute grid without caregiver actions',()=>{
  const env=new SimEnv(config());advance(env,36);
  const actions=loopTreatments(env);
  assert(actions.some(x=>x.eventType==='Correction Bolus'));
  assert(actions.some(x=>x.eventType==='Temp Basal'));
  assert(actions.every(x=>(x.at-env.world.start)%(5*60000)===0));
  assert(actions.every(x=>['Temp Basal','Correction Bolus'].includes(x.eventType)));
  const recommendation=env.world.controller.lastRecommendation;
  assert.equal(recommendation.algorithm,'oref1');
  for(const {action,receipt} of recommendation.receipts){
    assert.equal(receipt.status,'applied');
    if(action.type==='TEMP_BASAL'){assert.equal(action.percent%10,0);assert.equal(action.rate_u_h,undefined);}
  }
  assert.equal(env.config.therapy.pump.model,'dana_i');assert.equal(env.config.therapy.pump.insulin,'aspart');
});

test('I2 shares loop insulin records, but does not reveal external treatment records or true physiology',()=>{
  const env=new SimEnv(config());advance(env,12);
  const recorded=env.world.device.ledger.filter(x=>x.source==='loop');assert(recorded.length>0);
  const obs=env.observe();
  for(const r of recorded)assert(obs.device.insulin_ledger.some(x=>Date.parse(x.time)===r.at&&x.units===r.units));
  assert.equal(env.world.recordHidden('treatment',null,'patient_routine'),true);
  assert.equal(env.world.recordHidden('meal',null,'announced_meal'),true);
  assert.equal(obs.true_glucose_mg_dl,undefined);
});

test('agent temp basal wins until expiration; loop then resumes',()=>{
  const env=new SimEnv(config());advance(env,6);
  const r=step(env,{type:'TEMP_BASAL',percent:50,duration_minutes:60});assert.equal(r.info.action_result.status,'applied');
  const temp=structuredClone(env.world.device.temp),before=loopTreatments(env).length;
  advance(env,8);
  assert.deepEqual(env.world.device.temp,temp);assert.equal(loopTreatments(env).length,before);
  advance(env,6);assert(loopTreatments(env).length>before);
});

test('agent and automatic boluses use one actual device minimum-interval ledger',()=>{
  const env=new SimEnv(config());advance(env,2);
  const prev=env.world.device.lastBolus;assert(prev&&prev.source==='loop');
  const result=env.world.apply({type:'BOLUS',units:.1},'too-soon','agent');
  assert.equal(result.status,'rejected');assert.match(result.reason,/bolus interval/);
  advance(env,20);
  const doses=env.world.device.ledger.filter(x=>x.kind==='bolus');
  for(let i=1;i<doses.length;i++)assert(doses[i].at-doses[i-1].at>=15*60000);
});

test('disabled, suspended, open, lost-signal and stopped-pump states never deliver automatically',()=>{
  for(const controller of [{algorithm:'oref1',mode:'closed',enabled:false},{algorithm:'oref1',mode:'open'}]){
    const env=new SimEnv(config({controller}));advance(env,12);assert.equal(loopTreatments(env).length,0);
  }
  for(const action of [{type:'SUSPEND_PUMP',minutes:60},{type:'SUSPEND_LOOP',minutes:60}]){
    const env=new SimEnv(config({controller:{algorithm:'oref1',mode:'closed',expose_actions:true}}));
    advance(env,6);const r=step(env,action);assert.equal(r.info.action_result.status,'applied');
    const count=loopTreatments(env).length;advance(env,6);assert.equal(loopTreatments(env).length,count);
  }
  const env=new SimEnv(config());advance(env,6);const observe=env.world.observe.bind(env.world);
  const count=loopTreatments(env).length;env.world.controller.oref1.lastSample=null;
  env.world.observe=()=>{const obs=observe();obs.cgm.status='signal_loss';return obs;};
  env.world.runController();assert.equal(loopTreatments(env).length,count);
});

test('snapshot restores autosens and deduplication state exactly, with no double dose on the same sample',()=>{
  const env=new SimEnv(config());advance(env,60);
  assert(env.world.controller.oref1.autosens.devs.length>0);
  const restored=SimEnv.restore(env.snapshot());
  const count=loopTreatments(restored).length;restored.world.runController();assert.equal(loopTreatments(restored).length,count);
  advance(env,18);advance(restored,18);assert.deepEqual(restored.snapshot(),env.snapshot());
  const state=JSON.parse(JSON.stringify(env.world.controller.oref1.autosens));
  assert.deepEqual(makeAutosens({state}).snapshot(),state);
});

test('public device description and agent prompt disclose oref1, SMB and ownership rules',()=>{
  const env=new SimEnv(config());
  assert.equal(publicDescription(env.config).controller.algorithm,'oref1');
  const text=systemPrompt({obs:env.observe(),config:env.config});
  for(const phrase of ['Built-in oref1','microboluses','temporary basal takes priority','share the pump ledger','remain your responsibility'])assert(text.includes(phrase),phrase);
});

test('72-hour offline device run completes 864 steps with finite truth and only legal loop receipts',()=>{
  const env=new SimEnv(config({horizon_minutes:4320}));
  while(!env.done())step(env);
  const bundle=env.exportBundle();
  assert.equal(bundle.trajectory.length,864);assert.equal(bundle.evaluator_only.states.length,865);
  assert.equal(bundle.metrics.completed_horizon,true);
  assert(bundle.evaluator_only.states.every(s=>Number.isFinite(s.true_glucose_mg_dl)));
  assert(loopTreatments(env).length>0);
  assert.equal(env.world.metrics.rejected_actions,0);
  assert(env.world.controller.oref1.autosens.devs.length>0);
});
