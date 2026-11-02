import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SimEnv} from '../src/env/pomdp.mjs';
import {oref0Policy} from '../src/policies/oref0.mjs';

// Ideal pump and CGM keep insulin and glucose accounting exact in these tests.
const QUIET={scenario:{meals:{},activity:{enabled:false},extra_events:[]},therapy:{pump:{model:'ideal'}},cgm:{model:'ideal'}};
const quiet=(over={})=>({...QUIET,...over,scenario:{...QUIET.scenario,...over.scenario}});
const meal=(id,at_minute,grams,announced_grams=grams,absorption_minutes=40)=>({id,type:'meal',at_minute,grams,absorption_minutes,announced_grams});
const act=(env,action={type:'WAIT'},id=`a${env.step_count}`)=>env.step({action_id:id,expected_step:env.step_count,action});
const run=(env,policy=()=>({type:'WAIT'}))=>{while(!env.done())act(env,policy(env));return env;};

test('quiet 24 h: 288 transitions, basal equilibrium, insulin accounting exact',()=>{
  const env=run(new SimEnv(quiet()));
  assert.equal(env.transitions.length,288);
  assert.ok(Math.abs(env.physiology.glucose()-120)<1e-6);
  const s=env.summary();
  assert.equal(s.tir_70_180,1);assert.ok(s.completed_horizon);
  assert.ok(Math.abs(s.total_insulin_u-env.config.profile.basal_u_h*24)<1e-9);assert.equal(s.long_acting_u,0);
  assert.throws(()=>act(env),/finished/);
});

test('same config is bit-identical; instances are independent; seeds change the scenario',()=>{
  const a=run(new SimEnv({seed:7})),b=new SimEnv({seed:7});
  assert.equal(b.step_count,0);run(b);
  assert.equal(a.manifest().trajectory_sha256,b.manifest().trajectory_sha256);
  const c=new SimEnv({seed:8});
  assert.notDeepEqual(c.events.map(e=>e.at),a.events.map(e=>e.at));
});

test('snapshot/restore mid-episode continues identically',()=>{
  const a=new SimEnv({seed:3});for(let i=0;i<100;i++)act(a,i===96?{type:'BOLUS',units:2}:{type:'WAIT'});
  const b=SimEnv.restore(JSON.parse(JSON.stringify(a.snapshot())));
  run(a);run(b);
  assert.equal(a.manifest().trajectory_sha256,b.manifest().trajectory_sha256);
  assert.deepEqual(a.summary(),b.summary());
});

test('announced meal interrupts off-grid, then returns on the 5-min grid',()=>{
  const env=new SimEnv(quiet({scenario:{extra_events:[meal('m',12,40)]}}));
  act(env);act(env);
  const r=act(env);
  assert.equal(r.info.elapsed_minutes,2);assert.equal(r.info.stop_reason,'event');
  assert.deepEqual(r.observation.events.map(e=>[e.type,e.grams]),[['meal_announced',40]]);
  assert.equal(r.observation.cgm.age_minutes,2);
  const next=act(env);
  assert.equal(next.observation.elapsed_minutes,15);assert.deepEqual(next.observation.events,[]);
});

test('hidden meal moves glucose but never appears in observations; announced grams can differ from intake',()=>{
  const env=run(new SimEnv(quiet({horizon_minutes:240,scenario:{extra_events:[meal('secret',30,50,null),meal('told',120,60,40)]}})));
  const text=JSON.stringify([env.initialObservation,env.transitions]);
  assert.ok(!text.includes('secret'));assert.ok(!text.includes('true_glucose'));assert.ok(!text.includes('gut_carbs'));assert.ok(!text.includes('Q1'));
  const told=env.transitions.flatMap(t=>t.next_observation.events).find(e=>e.type==='meal_announced');
  assert.equal(told.grams,40);
  assert.ok(env.summary().max_glucose>150);
  assert.ok(env.evaluator_only===undefined&&env.exportBundle().evaluator_only.events.some(e=>e.id==='secret'&&e.grams===50));
});

test('meal raises glucose; a bolus lowers it with delay, not instantly',()=>{
  const cfg=quiet({horizon_minutes:300,scenario:{extra_events:[meal('m',0,50)]}});
  const none=new SimEnv(cfg),dosed=new SimEnv(cfg);
  act(none);act(dosed,{type:'BOLUS',units:4});
  assert.ok(Math.abs(none.physiology.glucose()-dosed.physiology.glucose())<2);
  for(let i=0;i<12;i++){act(none);act(dosed);}
  const iob=dosed.observe().iob.bolus_u;
  assert.ok(iob>0&&iob<4);
  run(none);run(dosed);
  assert.ok(none.summary().max_glucose>dosed.summary().max_glucose+20);
  assert.equal(dosed.observe().iob.bolus_u,0);   // DIA 5 h ends at the horizon
});

test('temp basal expires mid-step at its exact boundary; cancel restores schedule',()=>{
  const env=new SimEnv(quiet({horizon_minutes:60}));
  const basal=env.config.profile.basal_u_h;
  act(env,{type:'TEMP_BASAL',rate_u_h:0,duration_minutes:12});
  act(env);assert.equal(env.observe().device.temp_basal.remaining_minutes,2);
  act(env);assert.equal(env.observe().device.temp_basal,null);
  assert.ok(Math.abs(env.metrics.rapid_delivered_u-basal*3/60)<1e-9);
  act(env,{type:'TEMP_BASAL',rate_u_h:2,duration_minutes:60});act(env,{type:'CANCEL_TEMP_BASAL'});
  assert.equal(env.observe().device.current_basal_u_h,basal);
  assert.ok(env.observe().iob.basal_u>0);
});

test('exercise lowers glucose relative to rest',()=>{
  const ex={id:'walk',type:'exercise',at_minute:10,duration_minutes:45,accelerometer_counts:2095,announced:true};
  const rest=run(new SimEnv(quiet({horizon_minutes:120}))),walk=run(new SimEnv(quiet({horizon_minutes:120,scenario:{extra_events:[ex]}})));
  assert.ok(walk.summary().min_glucose<rest.summary().min_glucose-5);
  assert.ok(walk.transitions.some(t=>t.next_observation.events.some(e=>e.type==='exercise_started')));
});

test('idempotent retry, conflicting reuse, stale step',()=>{
  const env=new SimEnv(quiet());
  const req={action_id:'x',expected_step:0,action:{type:'BOLUS',units:1}};
  const first=env.step(req);
  assert.deepEqual(env.step(req),first);
  assert.equal(env.metrics.bolus_u,1);
  assert.throws(()=>env.step({...req,action:{type:'WAIT'}}),/reused/);
  assert.throws(()=>env.step({...req,action_id:'y'}),/Stale/);
});

test('rejections advance time: malformed, bolus interval, low CGM gate',()=>{
  const env=new SimEnv(quiet());
  assert.equal(act(env,{type:'TEMP_BASAL',rate_u_h:NaN,duration_minutes:30}).info.action_result.status,'rejected');
  assert.equal(act(env,{type:'BOLUS',units:1}).info.action_result.status,'applied');
  const r=act(env,{type:'BOLUS',units:1});
  assert.equal(r.info.action_result.status,'rejected');assert.match(r.info.action_result.reason,/interval/);
  assert.equal(env.now-env.start,15*60000);
  const low=new SimEnv(quiet({patient:{weight_kg:66,initial_glucose_mg_dl:60}}));
  assert.equal(low.initialObservation.events[0].type,'cgm_low');
  assert.equal(act(low,{type:'BOLUS',units:1}).info.action_result.status,'rejected');
  assert.deepEqual(low.observe().events,[]);
});

test('rescue carbs raise glucose and are logged as reported carbs',()=>{
  const cfg=quiet({horizon_minutes:90}),a=new SimEnv(cfg),b=new SimEnv(cfg);
  act(a,{type:'INGEST_CARBS',grams:15});run(a);run(b);
  assert.ok(a.summary().max_glucose>b.summary().max_glucose+10);
  assert.equal(a.summary().rescue_carbs_g,15);
});

test('config validation rejects unknown fields and bad values',()=>{
  assert.throws(()=>new SimEnv({unknown:1}),/Unknown/);
  assert.throws(()=>new SimEnv({seed:1.5}),/integer/);
  assert.throws(()=>new SimEnv({start_time:'2026-10-13T16:01:00Z'}),/grid/);
  assert.throws(()=>new SimEnv({scenario:{meals:{x:{time:'25:00',carbs_g:10,carbs_jitter_g:0,time_jitter_minutes:0,absorption_minutes:30}}}}),/HH:MM/);
});

test('model failure terminates explicitly',()=>{
  const env=new SimEnv(quiet());
  env.physiology.model.computeDerivatives=()=>({Q1:NaN});
  const r=act(env);
  assert.equal(r.terminated,true);assert.equal(r.info.stop_reason,'model_error');assert.equal(env.summary().completed_horizon,false);
});

test('oref0 baseline stays finite across meal tails (upstream NaN regression)',()=>{
  for(const seed of [1,2,3]) {
    const env=new SimEnv({seed,horizon_minutes:2880});let nonfinite=0;
    while(!env.done()){const d=oref0Policy(env.observe());nonfinite+=d.nonfinite;act(env,d.action);}
    assert.equal(nonfinite,0,`seed ${seed}`);assert.ok(env.summary().completed_horizon);
  }
});
