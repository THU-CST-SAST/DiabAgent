// Offline 72h fault-injection run through the official Code binary: a logical deadline, a stream cut before
// message_stop and a gateway 503 on separate decisions, plus act replies the controller-semantics
// normalization must accept. Passes only if every fault is redrawn, the world finishes 864 steps and the
// native audit is valid. No upstream API is called.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {SimEnv} from './runtime/src/env/pomdp.mjs';
import {runLlmAgent} from './runtime/src/benchmark/llm-agent.mjs';
import {createDecisionLoopModel} from './model.mjs';
import {auditDirectTrial} from './audit.mjs';
import {jsonToSse} from './protocol.mjs';
import {PREFIX} from './history.mjs';
import {createDecisionRedrawModel} from './decision-redraw.mjs';
import {ACT_NORMALIZATION} from './runtime/src/bench/models/tool-contract.mjs';

const [out,fixtureFile,planFile]=process.argv.slice(2),control=fileURLToPath(new URL('.',import.meta.url));
assert(out&&fixtureFile&&planFile,'Usage: NEW_OUTPUT FROZEN_FIXTURE FROZEN_PLAN');
fs.mkdirSync(out,{recursive:false});
const read=p=>JSON.parse(fs.readFileSync(p,'utf8')),write=(name,x)=>fs.writeFileSync(out+'/'+name,JSON.stringify(x,null,2)+'\n');
const {instance,pub}=read(fixtureFile),plan=read(planFile),env=new SimEnv(instance.config);
const config={...plan.model,act_normalization:ACT_NORMALIZATION};
const assets=process.env.CODE_TEST_SKILL_ASSETS??control+'/runtime/skills';
const TIMEOUT=20000,faults=new Map([[2,'deadline'],[3,'cut_stream'],[4,'gateway_503'],[6,'malformed_act']]);
let requests=0,decision=0,lastSession=null,injected=[],failure=null;
const server=http.createServer(async(req,res)=>{
  try{
    const chunks=[];for await(const c of req)chunks.push(c);
    const body=JSON.parse(Buffer.concat(chunks));requests++;
    const session=fs.readdirSync(out+'/Code').filter(s=>s.startsWith('session-')).sort((a,b)=>Number(a.slice(8))-Number(b.slice(8))).at(-1);
    if(session!==lastSession){lastSession=session;decision++;}
    const fault=faults.get(decision);
    if(fault&&!injected.includes(fault)){
      injected.push(fault);
      if(fault==='deadline'){await new Promise(r=>setTimeout(r,TIMEOUT+8000));res.destroy();return;}
      if(fault==='gateway_503'){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'api_error',message:'Service temporarily unavailable'}}));return;}
      if(fault==='cut_stream'){
        res.writeHead(200,{'content-type':'text/event-stream'});
        res.write('event: message_start\ndata: '+JSON.stringify({type:'message_start',message:{id:'offline_cut_'+requests,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,usage:{input_tokens:1,output_tokens:0}}})+'\n\n');
        res.write('event: content_block_start\ndata: '+JSON.stringify({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}})+'\n\n');
        res.write('event: content_block_delta\ndata: '+JSON.stringify({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'partial'}})+'\n\n');
        res.end();return;
      }
    }
    let input={action:{type:'WAIT'},note:'Offline redraw fault-injection fixture; not model performance.'};
    if(fault==='malformed_act')input={action:{type:'WAIT',note:'x'.repeat(900)},note_to_self:'Offline notes.'};
    const raw={id:'offline_native_message_'+requests,type:'message',role:'assistant',model:body.model,
      content:[{type:'thinking',thinking:'Offline fixture.',signature:'offline_signature_'+requests},{type:'tool_use',id:'offline_native_'+requests,name:PREFIX+'act',input}],
      stop_reason:'tool_use',stop_sequence:null,usage:{input_tokens:2,output_tokens:3}};
    res.writeHead(200,{'content-type':'text/event-stream'});res.end(jsonToSse(raw,body.model));
  }catch(e){failure??=e;console.error('offline server error:',e.stack);if(res.headersSent){res.destroy();return;}res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'invalid_request_error',message:e.message}}));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const events=[],client={episodeId:async()=>instance.id,current:async()=>({observation:env.observe(),step:env.step_count,done:env.done()}),
  step:async(_id,action,rationale,{prefix,expected_step})=>env.step({action_id:prefix+'-'+expected_step,expected_step,action,rationale})};
let model;
try{
  model=createDecisionLoopModel({config,root:out+'/Code',key:'offline-dummy-not-a-credential',binary:process.env.CODE_TEST_BINARY,
    offlineEndpoint:'http://127.0.0.1:'+server.address().port,nativeSkillAssetsRoot:assets,nativeSkillEntry:plan.native_skill?.entry_mode??'automatic',
    nativeKnowledgeGuidance:plan.native_skill?.guidance_revision??'legacy-v1',timeoutMs:TIMEOUT,maxTurns:7,releaseClosedSessions:true});
  model=createDecisionRedrawModel({delegate:model,sleep:async()=>{},onEvent:async e=>{events.push(e);fs.appendFileSync(out+'/DECISION-REDRAW.jsonl',JSON.stringify(e)+'\n');}});
  const stats=await runLlmAgent({client,pub,model,skillContextConfig:null,logsDir:out,units:plan.options.units,
    agentOptions:plan.agent_options,maxTurns:plan.max_turns,maxConsecutiveErrors:3,retry:{tries:1,baseDelayMs:1}});
  const diagnostics=model.diagnostics;await model.close();write('stats.json',stats);write('bundle.json',env.exportBundle());
  if(failure)throw failure;
  const audit=auditDirectTrial({dir:out,config,expectedConfig:instance.config,offlineOnly:true,nativeSkill:true,scoringVersion:pub.scoring_version});
  const rows=fs.readFileSync(out+'/transcript.jsonl','utf8').split('\n').filter(Boolean).map(JSON.parse);
  const normalized=rows.filter(r=>r.parsed&&r.tool_call?.input?.note?.length===500);
  const checks={audit_valid:audit.valid,horizon:stats.state==='done'&&env.step_count===864,
    all_faults_injected:['deadline','cut_stream','gateway_503','malformed_act'].every(f=>injected.includes(f)),
    redraws_recorded:events.length===3&&events.map(e=>e.category).join()==='deadline,transport,transport',
    diagnostics:diagnostics.decision_redraws===3&&diagnostics.decisions_redrawn===1,
    no_parse_errors:stats.parse_errors===0,malformed_act_normalized:normalized.length===1,no_api_errors:stats.api_errors===0};
  const result={checked:new Date().toISOString(),all_passed:Object.values(checks).every(Boolean),checks,requests,events,actual_upstream_API_calls:0,scripted_infrastructure_only:true,stats:{decisions:stats.decisions,parse_errors:stats.parse_errors,api_errors:stats.api_errors},audit_checks:audit.checks};
  write('RESULT.json',result);console.log(JSON.stringify({all_passed:result.all_passed,checks,requests}));assert(result.all_passed);
}finally{await model?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
