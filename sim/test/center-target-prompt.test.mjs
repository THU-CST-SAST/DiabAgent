import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {systemPrompt,taskDescription,CENTER_TARGET_NOTICE,SCORE_PRIORITY_NOTICE,PROMPT_REVISION} from '../src/bench/prompt.mjs';
import {CENTER_TARGET_PROMPT_REVISION as V8,SCORE_PRIORITY_PROMPT_REVISION as V7,CURRENT_PROMPT_REVISION,memoryRevision,sharedObservationRevision,resolvePromptRevision} from '../src/bench/prompt-revisions.mjs';
import {parseAgentOptions} from '../src/bench/agent-options.mjs';
import {KNOWLEDGE as K} from '../src/knowledge.mjs';
import {buildInstanceConfig} from '../src/sim/instance.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';
import {runEpisode} from '../src/bench/harness.mjs';

const cfg=buildInstanceConfig(K.instances.adult_dana_g6.spec),obs=new SimEnv(cfg).observe();
test('v8 adds only the operational center to v7 in either display unit',()=>{
  const before=JSON.stringify({cfg,obs});
  for(const units of ['mgdl','mmol']){
    const args={obs,config:cfg,units,scoring_version:'METRICS-v0.3'};
    const old=systemPrompt({...args,prompt_revision:V7}),next=systemPrompt({...args,prompt_revision:V8});
    assert.equal(next.replace(CENTER_TARGET_NOTICE+'\n',''),old);
    assert.equal(next.split(CENTER_TARGET_NOTICE).length,2);
    assert(next.indexOf(CENTER_TARGET_NOTICE)<next.indexOf('## The person'));
    assert(next.includes(SCORE_PRIORITY_NOTICE));
    assert(taskDescription({...args,prompt_revision:V8}).includes(CENTER_TARGET_NOTICE));
    assert.match(next,/S = clip\(T\(4–8\)/);
  }
  assert.equal(JSON.stringify({cfg,obs}),before);
});
test('v8 is opt-in, inherits public observation and memory, and respects legacy scoring',()=>{
  assert.equal(resolvePromptRevision(V8),V8);
  assert.equal(parseAgentOptions({prompt_revision:V8}).prompt_revision,V8);
  assert(memoryRevision(V8));assert(sharedObservationRevision(V8));
  assert.equal(PROMPT_REVISION,CURRENT_PROMPT_REVISION);
  assert(!systemPrompt({obs,config:cfg}).includes(CENTER_TARGET_NOTICE));
  const legacy=systemPrompt({obs,config:cfg,prompt_revision:V8,scoring_version:'bench-v0.2'});
  assert(!legacy.includes(CENTER_TARGET_NOTICE));assert(!legacy.includes(SCORE_PRIORITY_NOTICE));
});
test('center guidance preserves units, score honesty, safety and hardware constraints',()=>{
  assert.match(CENTER_TARGET_NOTICE,/5-6 mmol\/L \(90\.080-108\.096 mg\/dL\)/);
  assert.match(CENTER_TARGET_NOTICE,/5\.5 mmol\/L \(99\.088 mg\/dL\)/);
  for(const phrase of ['no extra within-band points','not a universal clinical recommendation','CGM error and lag','do not pursue a lower reading','would stack with active insulin','Do not dose automatically','Do not automatically give carbohydrate','without a mandatory-read gate','Preserve the supplied patient profile','not authorize changing profile settings']){
    assert(CENTER_TARGET_NOTICE.includes(phrase),phrase);
  }
});
test('v8 appears in every controller request without changing observations or tools',async()=>{
  const run=async revision=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'center-target-')),requests=[];
    const model={name:'offline-center-target',config:{},async complete(r){requests.push(r);return {
      tool_call:{id:'call-'+requests.length,name:'act',input:{action:{type:'WAIT'},wait_minutes:240,wake_on:[],note:'offline fixture'}},
      usage:{input_tokens:0,output_tokens:0}};}};
    try{
      const result=await runEpisode({instance:{spec:K.instances.adult_dana_g6.spec},model,outDir:dir,hours:24,
        agentOptions:{prompt_revision:revision,decision_schedule:'hourly',max_extra_decisions_per_day:0,memory:'notes'}});
      assert.equal(result.state,'done');assert.equal(requests.length,24);return requests;
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  };
  const old=await run(V7),next=await run(V8);
  for(let i=0;i<next.length;i++){
    assert(next[i].system.includes(CENTER_TARGET_NOTICE));
    assert.equal(next[i].system.replace(CENTER_TARGET_NOTICE+'\n',''),old[i].system);
    assert.deepEqual(next[i].messages,old[i].messages);
    assert.deepEqual(next[i].tools,old[i].tools);
  }
});
