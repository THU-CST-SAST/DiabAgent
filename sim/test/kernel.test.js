import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {DEFAULT_PARAMETERS as defaults,STATE_KEYS,initialState,basalFromInsulin,derivatives,rk4Step} from '../model/Deichmann2023.ts';
const reference=JSON.parse(fs.readFileSync(new URL('./fixtures/deichmann2023-reference.json',import.meta.url)));
function simulate(c) {
  const state={...initialState(defaults)};if(c.plasma){state.x1=0;state.x2=0;state.I=0;}
  const values=[state.Q1/defaults.Vg],states=[{...state}],mealAt=new Map(c.meal_mg??[]),bolusAt=new Map(c.bolus_micro_units_per_min??[]),pools=[];
  for(let minute=0;minute<c.duration_min;minute++){
    if(mealAt.has(minute))pools.push({at:minute,mg:mealAt.get(minute)});
    const Ra=pools.reduce((v,m)=>{const t=minute-m.at;return v+c.meal_f*m.mg*t*Math.exp(-t/c.meal_tau)/c.meal_tau**2;},0);
    const AC=minute>=c.activity.start&&minute<c.activity.start+c.activity.duration?c.activity.ac:0;
    for(let elapsed=0;elapsed<1;){const h=Math.min(.1,1-elapsed);rk4Step(state,h,x=>derivatives(x,defaults,{AC,Ra,...(c.plasma?{Idata:c.plasma[minute]}:{u:bolusAt.get(minute)??0,ub:basalFromInsulin(defaults)})}));elapsed+=h;}
    values.push(state.Q1/defaults.Vg);states.push({...state});
  }return {values,states};
}
test('all published parameter defaults and 48 derivative cases match pinned reference',()=>{
  for(const [file,expected]of Object.entries(reference.source_hashes))assert.equal(createHash('sha256').update(fs.readFileSync(new URL('../vendor/deichmann2023/'+file,import.meta.url))).digest('hex'),expected);
  assert.deepEqual(STATE_KEYS,reference.state_keys);
  for(const [k,v]of Object.entries({...reference.parameters,...reference.insulin_parameters}))assert.equal(defaults[k],v);
  for(const c of reference.derivatives){const state=Object.fromEntries(STATE_KEYS.map((k,i)=>[k,c.state[i]])),actual=derivatives(state,{...defaults,...c.parameters},c.input);
    STATE_KEYS.forEach((k,i)=>assert.ok(Math.abs(actual[k]-c.derivative[i])<=1e-9*Math.max(1,Math.abs(c.derivative[i])),k));}
});
for(const c of [...reference.cases,{...reference.measured_plasma,duration_min:360}])test('reference trajectory: '+(c.name??'measured plasma'),()=>{
  const actual=simulate(c),error=Math.max(...actual.values.map((g,i)=>Math.abs(g-c.glucose[i])));assert.ok(error<.01,'Glucose error '+error);
  for(const [minute,expected]of c.states)STATE_KEYS.forEach((k,i)=>assert.ok(Math.abs(actual.states[minute][k]-expected[i])<.01+Math.abs(expected[i])*1e-5,k));
});
