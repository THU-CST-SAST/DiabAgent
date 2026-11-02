import test from 'node:test';
import assert from 'node:assert/strict';
import {hourlyPolicy,observationOffsetMs} from '../src/bench/hourly-policy.mjs';

const start=Date.parse('2026-10-17T03:45:00Z'),MIN=60000;
function run({minutes=4320,extraLimit=6,urgent=()=>false,offsetMs=480*MIN}={}) {
  const calls=[],decisions=[];
  const wrapper=hourlyPolicy(obs=>{calls.push(obs);return {action:{type:'WAIT'},rationale:'fixture'};},
    {start,end:start+minutes*MIN,offsetMs,extraLimit,onDecision:d=>decisions.push(d)});
  for(let m=0;m<minutes;m+=5)wrapper.decide({virtual_time:new Date(start+m*MIN).toISOString(),
    events:[{type:urgent(m)?'cgm_urgent_low':'meal_record',id:`event-${m}`}],marker:m});
  return {...wrapper,calls,decisions};
}
test('three days:72policy consultations,864native steps, no hidden five-minute updates',()=>{
  const r=run();assert.equal(r.calls.length,72);assert.equal(r.stats.held_steps,792);
  assert.deepEqual(r.calls.map(o=>o.marker),Array.from({length:72},(_,i)=>60*i));
  assert.equal(r.calls[1].events.length,12);
});
test('urgent extra does not shift fixed grid and cannot bypass local-day cap',()=>{
  const r=run({urgent:m=>m%60!==0});
  assert.equal(r.stats.fixed_decisions,72);assert.equal(r.calls.length,96);
  assert.deepEqual(Object.values(r.stats.extra_decisions_by_local_day),[6,6,6,6]);
  assert.deepEqual(r.decisions.filter(d=>d.kind==='fixed').map(d=>d.elapsed_minutes),Array.from({length:72},(_,i)=>60*i));
});
test('extra budget zero disables urgent extras but not fixed slots',()=>{
  const r=run({minutes:180,extraLimit:0,urgent:()=>true});
  assert.equal(r.stats.decisions,3);assert.equal(r.stats.urgent_wakes,0);
});
test('only public urgent alarms wake; meal notices remain held',()=>{
  const r=run({minutes:120,urgent:m=>m===25});
  assert.deepEqual(r.decisions.map(d=>d.elapsed_minutes),[0,25,60]);
  assert.equal(r.calls[2].events.length,7);
});
test('duplicate or invalid clocks fail closed',()=>{
  const r=hourlyPolicy(()=>({action:{type:'WAIT'}}),{start,end:start+60*MIN});
  const obs={virtual_time:new Date(start).toISOString(),events:[]};r.decide(obs);
  assert.throws(()=>r.decide(obs),/clock/);
});
test('local-day offset comes from public clock rather than missing public.json config',()=>{
  assert.equal(observationOffsetMs({virtual_time:'2026-10-17T16:15:00Z',local_time:'2026-10-18 00:15'}),480*MIN);
  assert.throws(()=>observationOffsetMs({virtual_time:new Date(start).toISOString()}),/clock/);
});
