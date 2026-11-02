import fs from 'node:fs';
import assert from 'node:assert/strict';
import {SimEnv} from '../claude-code-decision-loop/runtime/src/env/pomdp.mjs';
import {runLlmAgent} from '../claude-code-decision-loop/runtime/src/benchmark/llm-agent.mjs';
import {createCodexDecisionLoopModel} from './model.mjs';
import {auditCodexTrial} from './trial-audit.mjs';
import {inspectCodexControllerPrefix,retainedCodexControllerModel} from './controller-prefix.mjs';

export async function runCodexMainTrial({root,fixture,mainPlan,key,binary,skillAssetsRoot,endpoint,offline=false,onProgress=()=>{}}){
  assert(!fs.existsSync(root));assert.equal(fixture.instance.config.information.mode,'I2');
  assert.equal(fixture.instance.config.therapy.pump.model,'dana_i');assert.equal(fixture.instance.config.controller.enabled,false);
  assert.equal(mainPlan.logical_timeout_ms,240000);assert.equal(mainPlan.max_native_turns_per_decision,7);
  assert.equal(mainPlan.agent_options.fixed_interval_minutes,60);assert.equal(mainPlan.agent_options.max_extra_decisions_per_day,6);
  assert.equal(mainPlan.model.max_tokens,16384);assert.equal(mainPlan.model.reasoning_effort,'high');
  assert.equal(mainPlan.native_skill.assets_sha256,'10f1e522b4ba24fbaa0a6d85ece7c047715f87099cd769ad13d9a2f6c8a24eb7');
  fs.mkdirSync(root);fs.writeFileSync(root+'/FIXTURE.json',JSON.stringify(fixture,null,2));
  const env=new SimEnv(fixture.instance.config),client={episodeId:async()=>fixture.instance.id,current:async()=>({observation:env.observe(),step:env.step_count,done:env.done()}),step:async(_id,action,rationale,{prefix,expected_step})=>env.step({action_id:prefix+'-'+expected_step,expected_step,action,rationale})};
  const config={...mainPlan.model,name:'GPT6.1Sol native Codex0.163 high',model:'gpt-6.1-sol',adapter:'codex'};
  const prefix=mainPlan.initial_codex_controller_prefix?inspectCodexControllerPrefix(mainPlan.initial_codex_controller_prefix):null;
  if(prefix){assert(!mainPlan.initial_codex_knowledge_checkpoint);assert.deepEqual(prefix.plan.agent_options,mainPlan.agent_options);assert.deepEqual(fixture,JSON.parse(fs.readFileSync(prefix.source+'/control/fixture.json')));fs.writeFileSync(root+'/CONTROLLER-PREFIX.json',JSON.stringify({file:prefix.registration_file,sha256:prefix.registration_sha256,source:prefix.source},null,2));}
  const nativeModel=createCodexDecisionLoopModel({config,root:root+'/Codex',key,binary,skillAssetsRoot,endpoint,offline,timeoutMs:240000,maxTurns:7,initialCheckpoint:mainPlan.initial_codex_knowledge_checkpoint??null,initialLogicalMs:prefix?.remaining_logical_ms??null,initialNativeState:prefix?.native_state?{state:prefix.native_state,file:prefix.registration_file,sha256:prefix.registration_sha256}:null});
  const model=prefix?retainedCodexControllerModel(nativeModel,prefix):nativeModel;
  key='';let stats;
  const progress=setInterval(()=>onProgress({steps:env.step_count,truth_points:env.evaluator.length,transport:model.diagnostics}),3000);
  try{
    stats=await runLlmAgent({client,pub:fixture.pub,model,skillContextConfig:null,logsDir:root,units:mainPlan.options.units,agentOptions:mainPlan.agent_options,maxTurns:mainPlan.max_turns,maxConsecutiveErrors:mainPlan.max_format_errors,retry:{tries:mainPlan.outer_API_tries,baseDelayMs:10000}});
  }finally{
    clearInterval(progress);await model.close();
    fs.writeFileSync(root+'/bundle.json',JSON.stringify(env.exportBundle(),null,2));
    if(stats)fs.writeFileSync(root+'/stats.json',JSON.stringify(stats,null,2));
    onProgress({steps:env.step_count,truth_points:env.evaluator.length,terminal:true,reason:stats?.reason??'exception'});
  }
  const audit=auditCodexTrial({dir:root,expectedConfig:fixture.instance.config,offline,modelConfig:config});
  return {stats,audit};
}
