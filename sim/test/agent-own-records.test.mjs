import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RecordBook} from '../src/bench/records.mjs';
import {privateHistory,simulateWhatIf} from '../src/bench/simulate.mjs';
import {receiptText,clockOf} from '../src/bench/prompt.mjs';
import {maskedScenario} from '../src/experiments/scenario-masks.mjs';
import {buildInstanceConfig} from '../src/sim/instance.mjs';
import {publicDescription} from '../src/oracle/belief.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';
import {runEpisode} from '../src/bench/harness.mjs';

function setup(mode='I2') {
  const spec=maskedScenario({preset:'A03'}).variants[mode],env=new SimEnv(buildInstanceConfig(spec));
  const records=RecordBook.fromObservation(env.observe());records.observe(env.observe());
  const step=action=>{
    const obs=env.observe(),r=env.step({action_id:`own-${env.step_count}`,expected_step:env.step_count,action});
    records.observe(r.observation);
    const receipt={...r.info.action_result,action};
    if(action.type!=='WAIT')records.addAction(receipt.at,receiptText(receipt,{clock:clockOf(obs)}),'agent',receipt);
    return receipt;
  };
  return {env,records,step,spec,desc:publicDescription(spec)};
}

test('I2 retains structured own receipts and daily summaries, but never restores hidden NS records',()=>{
  const {env,records,step}=setup();
  assert.equal(step({type:'BOLUS',units:1.03}).status,'applied');
  assert.equal(step({type:'INGEST_CARBS',grams:10,absorption_minutes:90}).status,'applied');
  const o=env.observe();
  assert.deepEqual(o.device.insulin_ledger,[]);assert.deepEqual(o.reported_carbs,[]);
  assert.equal(o.iob.total_u,0);assert.equal(o.cob.estimate_g,0);
  assert.equal(records.ledger.size,0);assert.equal(records.carbs.size,0);
  const own=records.ownActions();assert.equal(own.length,2);
  assert.equal(own[0].action.units,1.03);assert.equal(own[0].receipt.applied.units,1);
  const history=privateHistory(o,records);
  assert.equal(history.length,2);assert.ok(history.every(e=>e.source==='own_receipt'));
  assert.equal(history[0].action.units,1);assert.equal(history[1].action.absorption_minutes,90);
  const lines=records.dayLines(env.start,env.now+1).join('\n');
  assert.match(lines,/BOLUS.*delivered 1 U/);assert.match(lines,/INGEST_CARBS.*grams=10/);
});

test('rejected actions and duplicate receipts cannot become treatment exposure',()=>{
  const {env,records,step}=setup();
  const applied=step({type:'BOLUS',units:1});
  const rejected=step({type:'BOLUS',units:2});assert.equal(rejected.status,'rejected');
  records.addAction(applied.at,'duplicate','agent',applied);
  assert.equal(records.ownActions().length,1);
  assert.deepEqual(privateHistory(env.observe(),records).map(e=>e.action.units),[1]);
});

test('visible NS and own receipts are deduplicated and replay gives the same prediction across masks',()=>{
  const full=setup('I0'),sparse=setup('I2');
  // Drop the pre-existing external history so this comparison isolates identical known actions.
  full.records.ledger.clear();full.records.carbs.clear();
  for(const a of [{type:'BOLUS',units:1.03},{type:'INGEST_CARBS',grams:10,absorption_minutes:90}]) {
    full.step(a);sparse.step(a);
  }
  const sparseHistory=privateHistory(sparse.env.observe(),sparse.records);
  const ownTimes=new Set(sparseHistory.map(e=>e.t));
  full.records.ledger=new Map([...full.records.ledger].filter(([,e])=>ownTimes.has(e.t)));
  full.records.carbs=new Map([...full.records.carbs].filter(([,e])=>ownTimes.has(e.t)));
  assert.deepEqual(privateHistory(full.env.observe(),full.records),sparseHistory);
  const args={desc:full.desc,obs:sparse.env.observe(),action:{type:'WAIT'},hours:2};
  const a=simulateWhatIf({...args,records:full.records}),b=simulateWhatIf({...args,records:sparse.records});
  assert.ok(a.ok,a.text);assert.ok(b.ok,b.text);assert.deepEqual(a.result.points,b.result.points);
  assert.equal(b.result.own_history_entries,2);assert.equal(b.result.history_entries,2);
});

test('known insulin and carbohydrate change what-if curves without changing the actual world',()=>{
  const {env,records,step,desc}=setup();
  step({type:'BOLUS',units:1});step({type:'INGEST_CARBS',grams:10,absorption_minutes:90});
  const obs=env.observe(),before=env.snapshot();
  const ask=rb=>simulateWhatIf({desc,obs,records:rb,action:{type:'WAIT'},hours:3});
  const a=ask(records);assert.ok(a.ok,a.text);assert.equal(a.result.own_history_entries,2);
  const empty=RecordBook.fromObservation(obs);empty.observe(obs);
  const b=ask(empty);assert.ok(b.ok,b.text);assert.equal(b.result.history_entries,0);
  assert.notDeepEqual(a.result.points,b.result.points);
  assert.deepEqual(env.snapshot(),before,'what-if must never write to the actual patient');
});

test('known temporary basal, suspension, extended bolus and cancellation retain their timing',()=>{
  const {env,records,step,desc}=setup();
  for(const a of [{type:'TEMP_BASAL',percent:50,duration_minutes:60},
    {type:'EXTENDED_BOLUS',units:1,duration_minutes:120},
    {type:'CANCEL_EXTENDED_BOLUS'},{type:'SUSPEND_PUMP',minutes:15},
    {type:'RESUME_PUMP'},{type:'CANCEL_TEMP_BASAL'}])assert.equal(step(a).status,'applied');
  const out=simulateWhatIf({desc,obs:env.observe(),records,action:{type:'WAIT'},hours:2});
  assert.ok(out.ok,out.text);assert.equal(out.result.own_history_entries,6);
  assert.deepEqual(out.result.history_sources.map(e=>e.type),records.ownActions().map(e=>e.action.type));
});

test('custom off-grid decision times retain a complete relative-time forecast',()=>{
  for(const own of [false,true]) {
    const {env,records,step,desc}=setup();
    env.world.advanceTo(env.now+60000);
    if(own)step({type:'INGEST_CARBS',grams:10});
    records.observe(env.observe());
    const out=simulateWhatIf({desc,obs:env.observe(),records,action:{type:'WAIT'},hours:2});
    assert.ok(out.ok,out.text);
    assert.equal(out.result.own_history_entries,own?1:0);
    assert.deepEqual(out.result.points.map(p=>p.minutes),[0,30,60,90,120]);
  }
});

test('controller sends own accepted receipts after rolling context compaction and into simulate',async()=>{
  const {spec}=setup();let i=0;const requests=[];
  const model={name:'own-records-scripted',config:{},async complete(req){
    requests.push(req.messages.at(-1).content);
    const input=i===0?{action:{type:'BOLUS',units:1.03},wait_minutes:30,wake_on:[],note:'test receipt'}
      :i===5?{action:{type:'WAIT'},hours:2}:{action:{type:'WAIT'},wait_minutes:i<5?5:240,wake_on:[],note:'test'};
    const name=i++===5?'simulate':'act';
    return {tool_call:{id:`t-${i}`,name,input},text:'',usage:{input_tokens:0,output_tokens:0}};
  }};
  const out=fs.mkdtempSync(path.join(os.tmpdir(),'own-records-'));
  try {
    await runEpisode({instance:{id:'own-receipts',spec},model,outDir:out,hours:24,agentOptions:{simulate:true,keep_turns:1}});
    assert.ok(requests.length>1,fs.readFileSync(path.join(out,'status.json'),'utf8'));
    assert.match(requests[5],/Your treatments.*BOLUS.*delivered 1 U/);
    const lines=fs.readFileSync(path.join(out,'transcript.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines.find(l=>l.simulate)?.simulate[0].result.own_history_entries,1);
    assert.ok(requests.some(s=>s.includes('Known history replayed: 1 own action receipt')));
  } finally {fs.rmSync(out,{recursive:true,force:true});}
});
