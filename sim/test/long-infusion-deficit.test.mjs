import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeConfig} from '../src/core/config.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';
const config=events=>normalizeConfig({horizon_minutes:4320,scenario:{extra_events:events}});
const loss=(duration=4310)=>({id:'loss',type:'infusion_deficit',at_minute:10,duration_minutes:duration,delivered_fraction:.2});
test('published multi-day infusion windows are accepted without rewriting input',()=>{
  const c=config([loss()]);assert.equal(c.scenario.extra_events[0].duration_minutes,4310);
  assert.doesNotThrow(()=>config([loss(40320)]));
  for(const n of [4,40321,NaN,Infinity])assert.throws(()=>config([loss(n)]));
});
test('long deficit remains active across days; recovery clears overlapping deficits',()=>{
  const e=new SimEnv(config([loss(),{...loss(2880),id:'second',at_minute:1440,delivered_fraction:.1},{id:'repair',type:'infusion_recovery',at_minute:3000}]));
  while((e.now-e.start)/60000<2900){e.step({action_id:'t-'+e.step_count,expected_step:e.step_count,action:{type:'WAIT'}});}
  assert.equal(e.world.deliveryFraction(),.1);
  while((e.now-e.start)/60000<3010)e.step({action_id:'repair-'+e.step_count,expected_step:e.step_count,action:{type:'WAIT'}});
  assert.equal(e.world.deliveryFraction(),1);
});
