import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MASK_CASES,maskedScenario} from '../src/experiments/scenario-masks.mjs';
import {hardVariants} from '../src/experiments/scenario-hard.mjs';
import {auditScenario,fixedActionEpisode} from '../src/experiments/scenario-generator.mjs';
import {trueGrid} from '../src/bench/score.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';
import {buildInstanceConfig} from '../src/sim/instance.mjs';
import {parseResponseSse} from '../src/bench/models/http.mjs';
import {parseResponsesResponse} from '../src/bench/models/openai-compatible.mjs';
import {planJob,validateBudget} from '../src/benchmark/runner.mjs';
import {selectReportAgent,selectCaseTrials} from '../src/experiments/scenario-results.mjs';
import {traceModel,readInvocations} from '../src/bench/models/trace.mjs';

for(const [preset,source] of MASK_CASES)test(`${preset}/${source}: same R2 physics, three distinct masks, no I2 record leakage`,()=>{
 const r=maskedScenario({preset});assert.equal(auditScenario(r).max_truth_difference_mgdl,0);
 assert.deepEqual(trueGrid(fixedActionEpisode(r.variants.I0)),trueGrid(fixedActionEpisode(hardVariants({preset:source,revision:'r2'}).variants.I0)));
 const b=fixedActionEpisode(r.variants.I2);
 for(const o of [b.initial_observation,...b.trajectory.map(t=>t.next_observation)]) {
   assert.deepEqual(o.device.insulin_ledger,[]);assert.deepEqual(o.reported_carbs,[]);
   assert.equal(o.iob.total_u,0);assert.equal(o.cob.estimate_g,0);
   assert.equal(o.iob.history_complete,false);assert.equal(o.cob.history_complete,false);
   assert.equal(o.device.last_bolus,null);assert.equal(o.device.reservoir_u,null);
   assert.ok(!o.events.some(e=>['meal','exercise','life','fault','treatment'].includes(e.category)));
 }
});
test('I2 retains an applied action receipt but not a treatment ledger; action does not alter mask physics',()=>{
 const r=maskedScenario({preset:'A04'}),e=new SimEnv(buildInstanceConfig(r.variants.I2));
 const result=e.step({action_id:'mine',expected_step:0,action:{type:'INGEST_CARBS',grams:10}});
 assert.equal(result.info.action_result.status,'applied');assert.deepEqual(result.observation.reported_carbs,[]);
 const actionAt=e=>e.step_count===0?{type:'INGEST_CARBS',grams:10}:{type:'WAIT'};
 assert.deepEqual(trueGrid(fixedActionEpisode(r.variants.I0,{actionAt})),trueGrid(fixedActionEpisode(r.variants.I2,{actionAt})));
});
test('I1 hides H05 rescue record as well as narrative, but retains other available records',()=>{
 const r=maskedScenario({preset:'A03'}),a=new SimEnv(buildInstanceConfig(r.variants.I0)),b=new SimEnv(buildInstanceConfig(r.variants.I1));
 assert.ok(a.observe().reported_carbs.length>0);assert.deepEqual(b.observe().reported_carbs,[]);
 assert.ok(b.observe().device.insulin_ledger.length>0);
});
test('fixed-world model draws have independent IDs without changing repeat/seed or duplicating WAIT',()=>{
 const bench={dir:'/tmp',experiments:[{id:'i0',track:'full',task_ids:['a01-i0'],agents:['wait','llm:dummy.json'],repeats:1}],tasks:{}};
 const {trials}=planJob(bench,{modelDraws:3});assert.equal(trials.length,4);
 assert.equal(new Set(trials.map(t=>t.trial_id)).size,4);assert.ok(trials.every(t=>t.repeat===0));
 assert.deepEqual(trials.filter(t=>t.agent.startsWith('llm:')).map(t=>t.model_draw),[0,1,2]);
});
test('USD budget rejects unpriced tariff before any call, including zero tariff',()=>{
 assert.throws(()=>validateBudget(['llm:x'],10,()=>({price_per_mtok:{input:0,output:0}})),/requires verified/);
 assert.throws(()=>validateBudget([],NaN),/finite/);
 validateBudget(['llm:x'],10,()=>({price_per_mtok:{input:1,output:2}}));
});
test('report must select a model; retains all independent draws and rejects ambiguous duplicate jobs',()=>{
 const trials=[{agent:'llm:a',task_id:'a01-i0',repeat:0,model_draw:0},{agent:'llm:a',task_id:'a01-i0',repeat:0,model_draw:1},{agent:'llm:b',task_id:'a01-i0'}];
 assert.throws(()=>selectReportAgent(trials),/explicitly/);assert.equal(selectReportAgent(trials,'llm:a'),'llm:a');
 assert.equal(selectCaseTrials(trials,'A01','I0','llm:a').length,2);
 assert.throws(()=>selectCaseTrials([...trials,trials[0]],'A01','I0','llm:a'),/Duplicate/);
});
test('Responses SSE accepts only terminal payload; refuses partial/error/incomplete tool output',()=>{
 assert.equal(parseResponseSse('event: response.completed\r\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\r\n\r\ndata: [DONE]\r\n\r\n').status,'completed');
 assert.throws(()=>parseResponseSse('data: {"type":"response.output_text.delta","delta":"x"}\n\n'),/terminal/);
 assert.throws(()=>parseResponseSse('data: {"type":"error","message":"broken"}\n\n'),/broken/);
 assert.throws(()=>parseResponsesResponse({status:'incomplete',output:[{type:'function_call',name:'act',arguments:'{}'}]}),/no partial action/);
});
test('model invocation trace records actual model identity without adapter secrets/private obs',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sweet-trace-'));
 try {
   const model=traceModel({name:'test',config:{model:'glm-5.3',reasoning_effort:'low',secret:'DO-NOT-LOG'},async complete(){return {raw:{id:'resp-1',model:'glm-5.3'},usage:{input_tokens:1}};}},dir);
   await model.complete({system:'public',messages:[],tools:[],obs:{hidden:'PRIVATE-STATE'}});
   const text=fs.readFileSync(path.join(dir,'invocations.jsonl'),'utf8');assert.doesNotMatch(text,/DO-NOT-LOG|PRIVATE-STATE/);
   const [iv]=readInvocations(path.join(dir,'invocations.jsonl'));
   assert.equal(iv.response.model,'glm-5.3');assert.equal(iv.request.model,'glm-5.3');
   assert.equal(iv.request.reasoning_effort,'low');assert.equal(iv.response.usage.input_tokens,1);
 } finally{fs.rmSync(dir,{recursive:true,force:true});}
});
