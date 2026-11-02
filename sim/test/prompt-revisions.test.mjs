import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as legacy from '../src/bench/prompt-v3.mjs';
import {systemPrompt,taskDescription,observationText,toolSchema,simulateToolSchema,optionsPromptText,ONGOING_CONTROL_GOAL} from '../src/bench/prompt.mjs';
import {LEGACY_PROMPT_REVISION,CURRENT_PROMPT_REVISION} from '../src/bench/prompt-revisions.mjs';
import {parseAgentOptions,agentOptionsFromFlags} from '../src/bench/agent-options.mjs';
import {MASK_CASES,maskedScenario} from '../src/experiments/scenario-masks.mjs';
import {buildInstanceConfig} from '../src/sim/instance.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';
import {runEpisode} from '../src/bench/harness.mjs';

test('v3 template is byte-identical to the sealed previous experiment source',()=>{
  const source=fs.readFileSync(new URL('../src/bench/prompt-v3.mjs',import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'),'bac32f94bac3c6b05558609c80f15d88ee2ae780381c1bba18d149cbc3e002b6');
});

for(const [preset] of MASK_CASES)test(`${preset}: explicit v3 reproduces the legacy prompt, v4 adds only the ongoing goal`,()=>{
  const row=maskedScenario({preset,backgroundSeed:20261018});
  for(const mode of ['I0','I1','I2']) {
    const cfg=buildInstanceConfig(row.variants[mode]),obs=new SimEnv(cfg).observe();
    for(const units of ['mgdl','mmol'])for(const scoring_version of ['METRICS-v0.3','bench-v0.2']) {
      const args={obs,config:cfg,units,scoring_version},old=systemPrompt({...args,prompt_revision:LEGACY_PROMPT_REVISION});
      assert.equal(old,legacy.systemPrompt(args));
      assert.deepEqual(taskDescription({...args,prompt_revision:LEGACY_PROMPT_REVISION}),legacy.taskDescription(args));
      assert.equal(systemPrompt({...args,prompt_revision:CURRENT_PROMPT_REVISION}).replace(ONGOING_CONTROL_GOAL+'\n',''),old);
    }
    assert.equal(observationText(obs),legacy.observationText(obs));
    assert.deepEqual(toolSchema(obs),legacy.toolSchema(obs));
    assert.deepEqual(simulateToolSchema(obs,{calls:1}),legacy.simulateToolSchema(obs,{calls:1}));
    const opts=parseAgentOptions({prompt_revision:LEGACY_PROMPT_REVISION,simulate:true,simulate_calls:1});
    assert.equal(optionsPromptText(opts),legacy.optionsPromptText(opts));
  }
});

test('prompt selection is explicit, validated, and available as native CLI flags',()=>{
  assert.equal(parseAgentOptions(null).prompt_revision,CURRENT_PROMPT_REVISION);
  assert.equal(parseAgentOptions({promptRevision:LEGACY_PROMPT_REVISION}).prompt_revision,LEGACY_PROMPT_REVISION);
  assert.deepEqual(agentOptionsFromFlags({'prompt-revision':LEGACY_PROMPT_REVISION}),{prompt_revision:LEGACY_PROMPT_REVISION});
  assert.throws(()=>parseAgentOptions({prompt_revision:'typo'}),/Unknown prompt_revision/);
  assert.throws(()=>systemPrompt({prompt_revision:'typo'}),/Unknown prompt_revision/);
});

test('in-process harness passes the selected prompt revision and records it without paid API calls',async()=>{
  const outDir=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-version-'));
  const spec=maskedScenario({preset:'A01'}).variants.I2,requests=[];
  const model={name:'prompt-test',config:{},async complete(req){requests.push(req);return {
    text:'',tool_call:{id:`call-${requests.length}`,name:'act',input:{action:{type:'WAIT'},wait_minutes:240,wake_on:[],note:'test'}},
    usage:{input_tokens:0,output_tokens:0}};}};
  try {
    const result=await runEpisode({instance:{spec},model,outDir,hours:24,agentOptions:{prompt_revision:LEGACY_PROMPT_REVISION}});
    assert.equal(result.state,'done',result.reason);assert.ok(requests.length);
    assert.ok(requests.every(r=>!r.system.includes(ONGOING_CONTROL_GOAL)));
    const status=JSON.parse(fs.readFileSync(path.join(outDir,'status.json')));
    assert.equal(status.agent_options.prompt_revision,LEGACY_PROMPT_REVISION);
  } finally{fs.rmSync(outDir,{recursive:true,force:true});}
});
