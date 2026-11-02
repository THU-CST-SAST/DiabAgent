// Refactor check: the unified environment must reproduce the original sweet-sim
// VirtualPatient glucose for the same meals and treatments.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SimEnv} from '../src/env/pomdp.mjs';
// Frozen copy of the original upstream implementation (commit 441360591abe), kept only as a reference.
import {VirtualPatient} from './reference/upstream/patient.js';
import {DEFAULT_CONFIG} from './reference/upstream/config.js';

test('matches upstream VirtualPatient true glucose over 10 h with meals, bolus, temp basal and carbs',()=>{
  const start=Date.parse('2026-10-13T22:00:00Z'),minutes=600;   // 06:00-16:00 local: breakfast and lunch
  const cfg=structuredClone(DEFAULT_CONFIG);cfg.paused=true;cfg.activity.enabled=false;
  const upstream=new VirtualPatient({config:cfg,start});
  const meals=upstream.dailyEvents.filter(e=>e.type==='meal'&&e.at>=start&&e.at<start+minutes*60000);
  assert.ok(meals.length>=2);

  const env=new SimEnv({start_time:new Date(start).toISOString(),horizon_minutes:minutes,therapy:{pump:{model:'ideal',insulin:'aspart'}},cgm:{model:'ideal'},
    safety:{rescue_absorption_minutes:40},
    scenario:{meals:{},activity:{enabled:false},extra_events:meals.map(m=>({id:m.id,type:'meal',at_minute:(m.at-start)/60000,
      grams:m.carbsG,absorption_minutes:m.tau,announced_grams:null}))}});

  const plan={60:['BOLUS 2',{type:'BOLUS',units:2}],150:['BASAL 1.2 45',{type:'TEMP_BASAL',rate_u_h:1.2,duration_minutes:45}],
    330:['CARBS 20',{type:'INGEST_CARBS',grams:20}],400:['BASAL 0.0 30',{type:'TEMP_BASAL',rate_u_h:0,duration_minutes:30}]};
  let maxError=0;
  while(!env.done()) {
    const minute=(env.now-start)/60000,[cmd,action]=plan[minute]??[null,{type:'WAIT'}];
    if(cmd)upstream.applyCommand(cmd,`cmd-${minute}`);
    env.step({action_id:`a${minute}`,expected_step:env.step_count,action});
    upstream.advanceTo(env.now);
    maxError=Math.max(maxError,Math.abs(env.physiology.glucose()-upstream.state.G));
  }
  assert.equal(env.transitions.length,minutes/5);
  assert.ok(env.transitions.every(t=>t.info.action_result.status==='applied'));
  assert.ok(maxError<0.01,`max |ΔG| ${maxError} mg/dL`);
});
