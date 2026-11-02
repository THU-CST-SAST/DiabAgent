import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {ROOT,read,write,hash,fixture,protocol,saveReport,assertEndpoint} from './lib.mjs';
import {SimEnv} from '../sim/src/env/pomdp.mjs';
import {runLlmAgent} from '../sim/src/benchmark/llm-agent.mjs';
import {createDecisionLoopModel} from '../harnesses/claude-code-decision-loop/model.mjs';
import {NATIVE_SKILL_REGISTRATION} from '../harnesses/claude-code-decision-loop/native-skill.mjs';
import {createGatewayWaitModel,inspectEmptyGatewayFailure} from '../harnesses/claude-code-decision-loop/gateway-wait.mjs';
import {inspectNativeHistoryRetry} from '../harnesses/claude-code-decision-loop/native-history-checkpoint.mjs';
import {inspectNativeQueryFailure} from '../harnesses/claude-code-decision-loop/native-query-wait.mjs';
import {createDecisionRedrawModel} from '../harnesses/claude-code-decision-loop/decision-redraw.mjs';
import {auditDirectTrial} from '../harnesses/claude-code-decision-loop/audit.mjs';
import {createCodexDecisionLoopModel} from '../harnesses/codex-decision-loop/model.mjs';
import {auditCodexTrial} from '../harnesses/codex-decision-loop/trial-audit.mjs';
import {inspectCodexBinary} from '../harnesses/codex-decision-loop/rpc.mjs';
import {verifySkillAssets} from '../sim/src/bench/skill-assets.mjs';
import {rollingQueue} from '../harnesses/claude-code-decision-loop/rolling-queue.mjs';
import {resolveHarness} from './harness-config.mjs';
import {pathToFileURL} from 'node:url';
import {createModel} from '../sim/src/bench/models/index.mjs';
import {auditAdapterTrial} from '../harnesses/adapter-audit.mjs';

export async function runModels(rows,opt,experiment=null){
  const plan=structuredClone(experiment?.protocol??protocol()),runtime=plan.runtime??{max_native_turns:7,max_reference_reads:3,logical_timeout_ms:240000,max_turns:400,max_format_errors:3,outer_api_tries:1};
  const profile=resolveHarness(opt,plan.model??{}),native=['claude-code','codex'].includes(profile.harness),offline=profile.harness==='adapter'&&profile.config.adapter==='scripted';
  const endpoint=offline||profile.harness==='custom'&&!opt.endpoint?null:assertEndpoint(opt.endpoint??profile.config.base_url);
  assert(!native||opt.binary,'--binary required for native harnesses');const binary=native?fs.realpathSync(opt.binary):null;
  const parallel=Number(opt.parallel??1);assert(Number.isInteger(parallel)&&parallel>=1);
  const keyName=opt['key-env']??'DIABAGENT_API_KEY';assert(/^[A-Z][A-Z0-9_]*$/.test(keyName));
  let key=process.env[keyName]??'';assert(offline||profile.harness==='custom'||key.length>0,'Export your own key in '+keyName);
  const assets=ROOT+'sim/skills/main212';assert.equal(verifySkillAssets(assets).source.sha256,plan.native_skill.assets_sha256);
  const identity=!native?{adapter:profile.config.adapter??'custom',module_sha256:profile.moduleFile?hash(fs.readFileSync(profile.moduleFile)):null}:profile.harness==='codex'?inspectCodexBinary(binary):{
    version:execFileSync(binary,['--version'],{encoding:'utf8',timeout:10000}).trim(),sha256:hash(fs.readFileSync(binary))};
  if(profile.harness==='claude-code'){
    assert(/^2\.1\.296(?:\s|$)/.test(identity.version),'Claude Code 2.1.296 required');
    assert.equal(identity.sha256,process.env.CLAUDE_BINARY_SHA256??'24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de','Supply the pinned native executable');
    process.env.DIABAGENT_CODE_BASE_URL=endpoint;
  }
  const out=path.resolve(opt.out);assert(!fs.existsSync(out),'Use a NEW output directory; existing trials are never overwritten');fs.mkdirSync(out,{recursive:true});
  const config=profile.config;
  if(profile.harness==='claude-code')config.adapter='native-claude-code';
  plan.agent_options.reasoning_effort=config.reasoning_effort??plan.agent_options.reasoning_effort;
  const serialized=rows.map(({input,...row})=>{if(!input)return row;const file=out+'/dataset/fixtures/'+row.task_id+'.json';write(file,input);return {...row,fixture_file:file};});
  write(out+'/PLAN.json',{format:'diabagent.public-run/v2',harness:profile.harness,model:opt.model,config,protocol:plan,endpoint,binary_identity:identity,parallel,
    model_catalog:profile.catalogFile?{sha256:hash(fs.readFileSync(profile.catalogFile))}:null,
    experiment_mode:experiment?.mode??'main212',experiment_name:experiment?.name??'main212',
    created:new Date().toISOString(),tasks:serialized,decision_redraw:opt['decision-redraw']==='true',key_environment_name:keyName});
  const status={updated:null,terminal:false,gate:null,tasks:rows.map(r=>({task_id:r.task_id,state:'unstarted',score:null}))};
  const update=()=>{status.updated=new Date().toISOString();write(out+'/STATUS.json',status);};
  let stopping=false;const active=new Set();
  const stop=()=>{stopping=true;status.gate??={reason:'user_signal'};for(const m of active)Promise.resolve(m.close?.()).catch(()=>{});update();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);const timer=setInterval(update,5000);update();
  async function run(row,index){
    const entry=status.tasks[index],input=fixture(row),env=new SimEnv(input.instance.config),dir=out+'/trials/'+row.task_id;
    fs.mkdirSync(dir,{recursive:true});entry.state='running';entry.started=new Date().toISOString();update();
    const client={episodeId:async()=>input.instance.id,current:async()=>({observation:env.observe(),step:env.step_count,done:env.done()}),
      step:async(_id,action,rationale,{prefix,expected_step})=>env.step({action_id:prefix+'-'+expected_step,expected_step,action,rationale})};
    let model,stats;
    const event=file=>async value=>fs.appendFileSync(dir+'/'+file,JSON.stringify({at:new Date().toISOString(),...value})+'\n');
    const progress=setInterval(()=>{entry.steps=env.step_count;entry.transport=model?.diagnostics??null;update();},3000);
    try{
      if(profile.harness==='adapter')model=await createModel({...config,base_url:endpoint??config.base_url,api_key_env:keyName});
      else if(profile.harness==='custom'){
        const factory=await import(pathToFileURL(profile.moduleFile));assert(typeof factory.createHarness==='function','Export createHarness from your module');
        model=await factory.createHarness({config,root:dir+'/custom',endpoint,keyEnv:keyName,runtime});assert(typeof model.complete==='function','Harness must return a model with complete(request)');model.config={...config,...model.config,model:config.model};
      }else if(profile.harness==='codex')model=createCodexDecisionLoopModel({config,root:dir+'/Codex',key,binary,skillAssetsRoot:assets,endpoint,timeoutMs:runtime.logical_timeout_ms,maxTurns:runtime.max_native_turns,maxReferenceReads:runtime.max_reference_reads,catalogFile:profile.catalogFile});
      else{
        model=createDecisionLoopModel({config,root:dir+'/Code',key,binary,registration:NATIVE_SKILL_REGISTRATION,
          timeoutMs:runtime.logical_timeout_ms,maxTurns:runtime.max_native_turns,maxReferenceReads:runtime.max_reference_reads,nativeSkillAssetsRoot:assets,nativeSkillEntry:plan.native_skill.entry_mode??'task-command-v1',nativeKnowledgeGuidance:plan.native_skill.guidance_revision??'detailed-reference-v3',releaseClosedSessions:true});
        model=createGatewayWaitModel({delegate:model,unlimited:true,onEvent:event('GATEWAY-WAIT.jsonl'),verifyEmptyFailure:async({error})=>{
          if(error.native_history_retry)return inspectNativeHistoryRetry(error.native_history_retry);
          if(error.native_query_retry)return inspectNativeQueryFailure(error.native_query_retry);
          const names=fs.readdirSync(dir+'/Code').filter(n=>/^session-\d+$/.test(n)).sort((a,b)=>Number(a.slice(8))-Number(b.slice(8)));
          return inspectEmptyGatewayFailure(dir+'/Code/'+names.at(-1));
        }});
      }
      if(opt['decision-redraw']==='true')model=createDecisionRedrawModel({delegate:model,maxRedrawsPerDecision:4,onEvent:event('DECISION-REDRAW.jsonl')});
      active.add(model);
      stats=await runLlmAgent({client,pub:input.pub,model,skillContextConfig:native?null:config.skill_context??null,skillAssetsRoot:assets,logsDir:dir,units:plan.options.units,
        agentOptions:plan.agent_options,maxTurns:runtime.max_turns,maxConsecutiveErrors:runtime.max_format_errors,retry:{tries:runtime.outer_api_tries}});
      await model.close?.();write(dir+'/stats.json',stats);write(dir+'/bundle.json',env.exportBundle());
      const audit=!native?auditAdapterTrial({dir,expectedConfig:input.instance.config,evaluation:plan,modelConfig:config}):profile.harness==='codex'?auditCodexTrial({dir,expectedConfig:input.instance.config,modelConfig:config,evaluation:plan}):
        auditDirectTrial({dir,config,expectedConfig:input.instance.config,maxTurns:runtime.max_native_turns,maxReferenceReads:runtime.max_reference_reads,nativeSkill:true,scoringVersion:plan.scoring_version,evaluation:plan});
      Object.assign(entry,{state:audit.valid?'complete':'interrupted',audit_valid:audit.valid,score:audit.valid?audit.scientific_score:null,reason:stats.reason});
      if(stats.api_errors>0)status.gate??={reason:'native_transport_or_contract_failure',task_id:row.task_id};
    }catch(error){
      const message=key?String(error.message).split(key).join('[REDACTED]'):String(error.message);
      Object.assign(entry,{state:'interrupted',score:null,error:message});
      status.gate??={reason:'runner_or_fidelity_failure',task_id:row.task_id};
    }finally{
      clearInterval(progress);await model?.close?.();active.delete(model);
      const bundle=env.exportBundle();write(dir+'/bundle.json',bundle);if(stats)write(dir+'/stats.json',stats);
      if(env.done()&&entry.audit_valid===true)saveReport(dir,bundle,plan);
      Object.assign(entry,{steps:env.step_count,finished:new Date().toISOString()});write(dir+'/RESULT.json',entry);update();
    }
  }
  try{await rollingQueue(rows,parallel,run,()=>!stopping&&!status.gate);}
  finally{clearInterval(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);key='';status.terminal=true;update();}
  console.log(JSON.stringify({out,complete:status.tasks.filter(r=>r.state==='complete').length,total:rows.length,gate:status.gate}));
  if(status.tasks.some(r=>r.state!=='complete'))process.exitCode=1;
}
