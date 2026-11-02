import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {scoreRangeAlert,systemPrompt,GENERIC_MEMORY_NOTICE} from '../src/bench/prompt.mjs';
import {MEMORY_PROMPT_REVISION,CURRENT_PROMPT_REVISION} from '../src/bench/prompt-revisions.mjs';
import {parseAgentOptions} from '../src/bench/agent-options.mjs';
import {METRICS_TARGET,scoringTarget} from '../src/bench/scoring-target.mjs';
import {dynamicMetrics} from '../src/bench/score.mjs';
import {runEpisode} from '../src/bench/harness.mjs';
import {KNOWLEDGE as K} from '../src/knowledge.mjs';
import {buildInstanceConfig} from '../src/sim/instance.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';

const obs=(v,age=0)=>({glucose:{value_mg_dl:v,age_minutes:age,source:'cgm'},true_glucose_mg_dl:999});

test('score-range advisory is based only on fresh visible readings and exact inclusive score bounds',()=>{
  const {low_mg_dl:lo,high_mg_dl:hi}=METRICS_TARGET;
  assert.match(scoreRangeAlert(obs(lo-1)),/GLUCOSE ALERT: LOW/);
  assert.match(scoreRangeAlert(obs(hi+1)),/GLUCOSE ALERT: HIGH/);
  for(const v of [lo,100,hi])assert.equal(scoreRangeAlert(obs(v)),null);
  assert.match(scoreRangeAlert(obs(200),{units:'mgdl'}),/72\.064-144\.128 mg\/dL/);
  assert.match(scoreRangeAlert(obs(200)),/4-8 mmol\/L/);
  for(const o of [obs(200,16),obs(200,-1),obs(NaN),{}])assert.equal(scoreRangeAlert(o),null);
  assert.equal(scoreRangeAlert({glucose:{value_mg_dl:200}}),null);
  assert.equal(scoreRangeAlert({...obs(100),evaluator_only:{true_glucose_mg_dl:10}}),null);
  assert.match(scoreRangeAlert(obs(181),{scoring_version:'bench-v0.2',units:'mgdl'}),/70-180 mg\/dL/);
  assert.equal(scoreRangeAlert(obs(160),{scoring_version:'bench-v0.2'}),null);
  assert.throws(()=>scoringTarget('unknown'),/Unknown scoring/);
  const d=dynamicMetrics([lo-1,lo,100,hi,hi+1].map((g,i)=>({m:i*5,g})));
  assert.equal(d.bins.target,3/5);
  assert.equal(d.bins.low,1/5);
  assert.equal(d.bins.high,1/5);
});

test('memory revision adds only a generic memory notice and keeps v4 as the reproducible default',()=>{
  const cfg=buildInstanceConfig(K.instances.adult_dana_g6.spec),o=new SimEnv(cfg).observe();
  const original=systemPrompt({obs:o,config:cfg,prompt_revision:CURRENT_PROMPT_REVISION});
  const memory=systemPrompt({obs:o,config:cfg,prompt_revision:MEMORY_PROMPT_REVISION});
  assert.equal(memory,original+'\n\n## Persistent memory\n'+GENERIC_MEMORY_NOTICE);
  assert.equal(parseAgentOptions(null).prompt_revision,CURRENT_PROMPT_REVISION);
  assert.equal(parseAgentOptions(null).score_range_alerts,false);
  assert.equal(parseAgentOptions({scoreRangeAlerts:'true'}).score_range_alerts,true);
  assert.throws(()=>parseAgentOptions({score_range_alerts:'yes'}),/true or false/);
});

test('generic notes and complete own history persist across days with only one history copy per request',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'generic-memory-alert-')),requests=[];
  const model={name:'canned-memory-only',config:{},async complete(req){
    requests.push(structuredClone({messages:req.messages,obs:req.obs}));
    return {text:'',tool_call:{id:`call-${requests.length}`,name:'act',input:{action:{type:'WAIT'},wait_minutes:240,wake_on:[],
      note:'canned local fixture',...(requests.length===1?{note_to_self:'fixture memory retained'}:{})}},usage:{input_tokens:0,output_tokens:0}};
  }};
  try {
    const result=await runEpisode({instance:{spec:K.instances.adult_dana_g6.spec},model,outDir:dir,hours:48,
      agentOptions:{decision_schedule:'hourly',max_extra_decisions_per_day:0,memory:'notes',
        prompt_revision:MEMORY_PROMPT_REVISION,score_range_alerts:true}});
    assert.equal(result.state,'done');
    assert.equal(requests.length,48,'alerts never add model calls or change hourly slots');
    const header='## Your complete decision history';
    for(const r of requests)assert.equal(r.messages.map(m=>m.content).join('\n').split(header).length-1,1);
    const secondDay=requests[24];
    assert.match(secondDay.messages[0].content,/fixture memory retained/);
    assert.match(secondDay.messages.at(-1).content,/\{"type":"WAIT"\}/);
    const tx=fs.readFileSync(path.join(dir,'transcript.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(tx.at(-1).observation_text.split('=> applied').length-1,47,'all prior own decisions, not just recent turns');
    assert.ok(requests.every(r=>!JSON.stringify(r.messages).includes('Same-clock windows')));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
