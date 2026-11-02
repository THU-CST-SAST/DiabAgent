import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {HourlySchedule} from '../src/bench/hourly-schedule.mjs';
import {parseAgentOptions} from '../src/bench/agent-options.mjs';
import {runEpisode} from '../src/bench/harness.mjs';
import {parseActReply} from '../src/bench/controller.mjs';
import {toolSchema} from '../src/bench/prompt.mjs';
import {compileToolContract} from '../src/bench/models/tool-contract.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';
import {buildInstanceConfig} from '../src/sim/instance.mjs';
import {loadScenarioVersion} from '../scripts/build-scenario-version.mjs';

test('fixed slots survive extras; six extras per local date, renewed at local midnight',()=>{
  const start=Date.parse('2026-10-19T15:00:00Z'),h=new HourlySchedule({start,end:start+48*3600000,offsetMs:480*60000});
  assert.equal(h.begin(start),'fixed');
  for(let m=5;m<=30;m+=5)assert.equal(h.begin(start+m*60000),'extra');
  assert.equal(h.canExtra(start+35*60000),false);
  assert.throws(()=>h.begin(start+35*60000),/budget/);
  assert.equal(h.nextFixed(start+30*60000),start+3600000);
  assert.equal(h.begin(start+3600000),'fixed');
  assert.equal(h.begin(start+65*60000),'extra');
  assert.deepEqual(Object.values(h.extras),[6,1]);
  assert.throws(()=>parseAgentOptions({decision_schedule:'hourly',min_decision_minutes:60}),/legacy/);
});

test('only hourly mode makes follow-up timing optional; omission or null waits for the next fixed slot',()=>{
  const base=loadScenarioVersion('v4.2').catalog.cards[0].instance_spec;
  const obs=new SimEnv(buildInstanceConfig(base)).observe();
  const input={action:{type:'WAIT'},note:'Keep the fixed schedule'};
  const hourlyTool=toolSchema(obs,{hourly:true,notes:true}),legacy=toolSchema(obs,{notes:true});
  assert.ok(!hourlyTool.input_schema.required.includes('wait_minutes'));
  assert.ok(legacy.input_schema.required.includes('wait_minutes'));
  for(const provider of ['openai','anthropic'])assert.deepEqual(compileToolContract(hourlyTool,provider).parse(input),input);
  for(const value of [undefined,null]) {
    const reply={tool_call:{name:'act',input:{...input,...(value===undefined?{}:{wait_minutes:value})}}};
    const parsed=parseActReply(reply,{validate:()=>{},hourly:true});
    assert.equal(parsed.wait_minutes,60);
    const start=Date.parse('2026-10-19T00:00:00Z'),schedule=new HourlySchedule({start,end:start+86400000});
    const at=start+15*60000,window=schedule.window(at,parsed.wait_minutes);
    assert.equal(schedule.due(start+55*60000,window),false);
    assert.equal(schedule.due(start+60*60000,window),true);
  }
  assert.equal(parseActReply({tool_call:{name:'act',input}},{validate:()=>{}}).wait_minutes,15);
  assert.equal(parseActReply({tool_call:{name:'act',input:{...input,wait_minutes:10}}},{validate:()=>{},hourly:true}).wait_minutes,10);
});

test('seven days without follow-up requests produce exactly168 fixed calls and no timer extras',async t=>{
  const base=structuredClone(loadScenarioVersion('v4.2').catalog.cards[0].instance_spec);
  base.horizon_minutes=10080;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hourly-optional-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let calls=0;
  const model={name:'optional-hourly',config:{},async complete({tools}) {
    assert.ok(!tools.find(x=>x.name==='act').input_schema.required.includes('wait_minutes'));
    return {tool_call:{id:'optional-'+calls++,name:'act',input:{action:{type:'WAIT'},note:'Keep fixed hourly decisions'}},
      text:'',usage:{input_tokens:0,output_tokens:0}};
  }};
  const result=await runEpisode({instance:{id:'optional-hourly',spec:base},model,outDir:dir,hours:168,maxTurns:180,
    agentOptions:{decision_schedule:'hourly',max_extra_decisions_per_day:6,memory:'notes',keep_turns:1}});
  const {stats}=JSON.parse(fs.readFileSync(path.join(dir,'status.json'),'utf8'));
  assert.equal(result.state,'done');assert.equal(calls,168);assert.equal(stats.fixed_decisions,168);
  assert.ok(Object.values(stats.extra_decisions_by_local_day??{}).every(x=>x===0));
  const lines=fs.readFileSync(path.join(dir,'transcript.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(lines.every(x=>x.decision_kind==='fixed'&&x.parsed.wait_minutes===60));
  assert.match(lines[0].system,/- `wait_minutes` \(optional\)/);
  assert.doesNotMatch(lines[0].system,/"wait_minutes": 30/);
  assert.deepEqual(lines.map(x=>(Date.parse(x.sim_time)-Date.parse(lines[0].sim_time))/60000),Array.from({length:168},(_,i)=>i*60));
});

test('hourly controller keeps all fixed calls and complete own decisions across days and I2',async()=>{
  const loaded=loadScenarioVersion('v4.2'),base=structuredClone(loaded.catalog.cards[0].instance_spec);
  base.horizon_minutes=2880;
  base.overrides.information={mode:'I2',policy:'record-derived-v3',rules:[]};
  const requests=[];let i=0;
  const model={name:'hourly-fixture',config:{},async complete(req){requests.push(req);return {
    tool_call:{id:`call-${i++}`,name:'act',input:{action:{type:'WAIT'},wait_minutes:5,wake_on:['alarm','meal'],note:'Observe without treatment'}},
    text:'',usage:{input_tokens:0,output_tokens:0}};}};
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hourly-controller-'));
  try {
    const result=await runEpisode({instance:{id:'hourly',spec:base},model,outDir:dir,hours:48,maxTurns:100,
      agentOptions:{decision_schedule:'hourly',max_extra_decisions_per_day:6,memory:'notes',keep_turns:1}});
    const tx=fs.readFileSync(path.join(dir,'transcript.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    const fixed=tx.filter(t=>t.decision_kind==='fixed');
    assert.equal(fixed.length,48);
    assert.deepEqual(fixed.map(t=>(Date.parse(t.sim_time)-Date.parse(tx[0].sim_time))/60000),Array.from({length:48},(_,i)=>i*60));
    for(const used of Object.values(tx.at(-1).extra_decisions_by_local_day))assert.ok(used<=6);
    assert.match(tx[0].system,/4–8 mmol\/L/);
    assert.match(tx[0].system,/Fixed hourly decisions/);
    assert.match(tx.at(-1).observation_text,/Your complete decision history/);
    assert.ok(tx.at(-1).observation_text.includes(tx[0].sim_time));
    assert.match(tx.at(-1).observation_text,/"type":"WAIT"/);
    assert.ok(requests.length>=48);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
