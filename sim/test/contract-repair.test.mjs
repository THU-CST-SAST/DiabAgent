import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runEpisode} from '../src/bench/harness.mjs';
import {enforceToolContract,toolContractError} from '../src/bench/models/tool-contract.mjs';
import {loadScenarioVersion} from '../scripts/build-scenario-version.mjs';

async function episode(t,{repair=true,bad=1,http=false}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bounded-contract-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let calls=0;const requests=[];
  const model={name:'repair-fixture',config:{tool_contract_repair:repair,price_per_mtok:{input:1,output:1}},async complete(request) {
    requests.push(request);calls++;
    if(http)throw toolContractError('Strict request rejected: HTTP 400');
    const input=calls<=bad?{action:{type:'TEMP_BASAL',percent:50},note:'Missing duration'}
      :{action:{type:'WAIT'},note:'Continue the fixed schedule'};
    return enforceToolContract({tool_call:{id:'call-'+calls,name:'act',input},text:'',
      raw:{fixture_call:calls,input},usage:{input_tokens:10,output_tokens:5},latency_ms:1},request.tools,'openai');
  }};
  const base=structuredClone(loadScenarioVersion('v4.2').catalog.cards[0].instance_spec);
  const result=await runEpisode({instance:{id:'repair-fixture',spec:base},model,outDir:dir,hours:24,
    agentOptions:{decision_schedule:'hourly',max_extra_decisions_per_day:6,memory:'notes'},maxTurns:40});
  const status=JSON.parse(fs.readFileSync(path.join(dir,'status.json'),'utf8'));
  const lines=fs.readFileSync(path.join(dir,'transcript.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return {result,status,lines,calls,requests};
}

test('bounded repair keeps the failed raw reply and usage, does not advance time or infer duration',async t=>{
  const r=await episode(t);
  assert.equal(r.result.state,'done',JSON.stringify(r.status));assert.equal(r.calls,25);
  assert.equal(r.lines[0].sim_time,r.lines[1].sim_time);
  assert.equal(r.lines[0].env_steps,0);assert.equal(r.lines[0].parsed,null);
  assert.equal(r.lines[0].tool_call.input.action.duration_minutes,undefined);
  assert.equal(r.lines[0].response_raw.fixture_call,1);
  assert.match(r.lines[0].parse_error,/action.duration_minutes/);
  assert.match(JSON.stringify(r.requests[1].messages),/Nothing was applied and time did not advance/);
  assert.equal(r.status.stats.parse_errors,1);assert.equal(r.status.stats.api_errors,0);
  assert.equal(r.status.stats.model_calls,25);assert.equal(r.status.stats.input_tokens,250);
  assert.equal(r.status.stats.output_tokens,125);assert.equal(r.status.stats.decisions,24);
});

test('three consecutive malformed replies stop without applying any action',async t=>{
  const r=await episode(t,{bad:99});
  assert.equal(r.calls,3,JSON.stringify(r.status));assert.equal(r.status.stats.decisions,0);
  assert.ok(r.lines.every(x=>x.env_steps===0));assert.equal(r.status.stats.parse_errors,3);
  assert.ok(r.lines.every(x=>x.sim_time===r.lines[0].sim_time&&x.parsed===null));
});

test('repair is explicit opt-in; HTTP400 has no repair reply and is never replayed',async t=>{
  for(const options of [{repair:false},{http:true}]) {
    const r=await episode(t,options);
    assert.equal(r.calls,1);assert.equal(r.status.stats.decisions,0);assert.equal(r.status.stats.api_errors,1);
  }
});

test('an invalid read-only hypothetical returns feedback at the same time and never becomes a treatment',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'readonly-contract-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const requests=[];
  const invalid={action:{type:'TEMP_BASAL',percent:120,duration_minutes:120,units:2},hours:4};
  const model={name:'readonly-fixture',config:{tool_contract_repair:true},async complete(request) {
    requests.push(request);const first=requests.length===1;
    return {tool_call:{id:'call-'+requests.length,name:first?'simulate':'act',
      input:first?invalid:{action:{type:'WAIT'},note:'Continue the fixed schedule'}},
      ...(first?{tool_validation_error:'Unexpected field(s): action.units'}:{}),
      text:'',raw:{fixture_call:requests.length},usage:{input_tokens:10,output_tokens:5},latency_ms:1};
  }};
  const spec=structuredClone(loadScenarioVersion('v4.2').catalog.cards[0].instance_spec);
  const result=await runEpisode({instance:{id:'readonly-fixture',spec},model,outDir:dir,hours:24,
    agentOptions:{decision_schedule:'hourly',memory:'notes',simulate:true,simulate_calls:1},maxTurns:40});
  const status=JSON.parse(fs.readFileSync(path.join(dir,'status.json')));
  const lines=fs.readFileSync(path.join(dir,'transcript.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(result.state,'done');assert.equal(requests.length,25);
  assert.equal(requests[0].obs.virtual_time,requests[1].obs.virtual_time);
  assert.match(requests[1].messages.at(-1).content,/action.units/);
  assert.equal(status.stats.decisions,24);assert.equal(status.stats.simulate_calls,1);
  assert.equal(status.stats.api_errors,0);assert.equal(status.stats.parse_errors,0);
  assert.ok(lines.every(line=>line.parsed.action.type==='WAIT'));
  assert.equal(lines[0].simulate[0].input.action.units,2,'invalid input is retained, not silently edited');
});
