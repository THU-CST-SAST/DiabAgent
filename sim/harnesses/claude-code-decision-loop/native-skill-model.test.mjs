import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import test from 'node:test';
import {createDecisionLoopModel} from './model.mjs';
import {jsonToSse} from './protocol.mjs';
import {NATIVE_SKILL_VERSION} from './native-skill.mjs';
import {DecisionLoopSession} from './native-session.mjs';
import {inspectNativeHistoryRetry} from './native-history-checkpoint.mjs';

const config={model:process.env.CODE_TEST_MODEL??'claude-opus-5-5',max_tokens:Number(process.env.CODE_TEST_MAX_TOKENS??8192),strict_tools:true,strict_tool_names:['act'],tool_contract_repair:true,reasoning_effort:'high',thinking:{type:'adaptive'}};
const fixture=JSON.parse(fs.readFileSync(new URL('./CAPTURE-FIXTURES.json',import.meta.url))).cases[0].neutral;
const request={...fixture,tools:fixture.tools.filter(t=>t.name!=='read_glucose_skill')};
const binary=process.env.CODE_TEST_BINARY,assets=process.env.CODE_TEST_SKILL_ASSETS;
const guidance=process.env.CODE_TEST_KNOWLEDGE_GUIDANCE??'legacy-v1';
const entryMode=process.env.CODE_TEST_SKILL_ENTRY??'automatic';
test('redaction preserves task paths while removing known and standalone credentials',()=>{
  const safe=text=>DecisionLoopSession.prototype.safe.call({key:'offline-known-credential'},text);
  const file='/experiments/sweetbench-native-task-entry-offline-20261029/control/native-mcp.mjs';
  assert.equal(safe(file),file);
  assert.equal(safe('prefixoffline-known-credentialsuffix'),'prefix[REDACTED]suffix');
  assert.equal(safe('Bearer sk-'+'a'.repeat(64)),'Bearer [REDACTED]');
  assert.equal(safe(JSON.stringify({key:'sk-'+'b'.repeat(64)})),JSON.stringify({key:'[REDACTED]'}));
});
test('invalid guidance cannot create a model session',()=>{
  assert.throws(()=>createDecisionLoopModel({nativeKnowledgeGuidance:'typo'}),/Unknown/);
  assert.throws(()=>createDecisionLoopModel({nativeKnowledgeGuidance:'session-aware-v2'}),/requires native Skill/);
  assert.throws(()=>createDecisionLoopModel({nativeKnowledgeGuidance:'detailed-reference-v3'}),/requires native Skill/);
});
const manifest=assets?JSON.parse(fs.readFileSync(path.join(assets,'source.json'),'utf8')):null;
const entry=manifest?fs.readFileSync(path.join(assets,manifest.directory,'SKILL.md'),'utf8'):'';
const entryBody=entry.replace(/^---\n[\s\S]*?\n---\n/,'').trim();
const description=entry.match(/^description: (.+)$/m)?.[1];
const reply=(tool,input,n)=>({id:'native_test_'+n,type:'message',role:'assistant',model:config.model,
  content:[{type:'thinking',thinking:'Scripted offline infrastructure test.',signature:'offline_signature_'+n},
    {type:'tool_use',id:'native_use_'+n,name:tool,input}],stop_reason:'tool_use',stop_sequence:null,usage:{input_tokens:2,output_tokens:3}});

for(const mode of ['direct','lookup','json','budget','interrupted'])test('genuine native adapter: '+mode,{skip:!binary||!assets},async()=>{
  const lookup=['lookup','json','interrupted'].includes(mode);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-skill-adapter-'));let requests=0,failure;
  const server=http.createServer(async(req,res)=>{
    try{
      const chunks=[];for await(const c of req)chunks.push(c);
      const body=JSON.parse(Buffer.concat(chunks));requests++;
      const prior=body.messages.filter(m=>m.role==='assistant').flatMap(m=>Array.isArray(m.content)?m.content:[])
        .filter(b=>b.type==='tool_use'&&/^native_use_\d+$/.test(b.id));
      const n=mode==='json'?Math.max(0,...prior.map(b=>Number(b.id.slice('native_use_'.length))))+1:requests;
      fs.writeFileSync(root+'/request-'+requests+'.json',JSON.stringify(body));
      const text=JSON.stringify(body),names=body.tools.map(t=>t.name);
      assert.equal(text.includes('Knowledge-context boundary:'),['session-aware-v2','detailed-reference-v3'].includes(guidance));
      assert.equal(text.includes('NOT the full glucose-management or device-operation reference'),guidance==='detailed-reference-v3');
      if(guidance==='detailed-reference-v3'){
        assert(text.includes('references/16-benchmark-hardware-operations.md'));
        assert(text.includes('no action is rejected, no score is reduced'));
      }
      const bodyText=body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[])
        .flatMap(b=>b.type==='text'?[b.text]:b.type==='tool_result'?[typeof b.content==='string'?b.content:JSON.stringify(b.content)]:[]).join('\n');
      assert(names.includes('Skill')&&names.includes('Read')&&names.includes('mcp__experiment__act'));
      assert(!names.includes('mcp__experiment__read_glucose_skill'));
      assert(!names.includes('Bash')&&!names.includes('Write'));
      let tool='mcp__experiment__act',input={action:{type:'WAIT'},note:'Offline adapter test, not model performance.'};
      const plugin=root+'/model/session-1/workspace/.experiment-plugin/skills/blood-glucose-management';
      if(mode==='budget'){
        if(n<=4){tool='Read';input={file_path:plugin+'/SKILL.md',offset:1,limit:1};}
        else {
          assert.equal(n,5);
          const result=body.messages.findLast(m=>m.role==='user').content.find(b=>b.type==='tool_result');
          assert(result?.is_error);assert.match(JSON.stringify(result),/budget exhausted/);
        }
      }else if(n===1){
        assert(text.includes('sweetbench-glucose:blood-glucose-management'));
        assert(text.includes(description),'Native catalogue must expose this exact edition description');
        assert.equal(bodyText.includes(entryBody),entryMode==='task-command-v1','Entry loading must match registered native routing');
        if(lookup){tool='Skill';input={skill:'sweetbench-glucose:blood-glucose-management'};}
      }else if(n===2){
        assert(lookup&&bodyText.includes(entryBody),'Native Skill must load this exact edition body');
        tool='Read';input={file_path:plugin+'/references/07-pump-basal-bolus-and-closed-loop.md',offset:1,limit:2000};
      }else if(n===3){
        assert(lookup&&text.includes('Two closed-loop controllers in this benchmark'));
        if(mode==='interrupted'){
          res.writeHead(502,{'content-type':'application/json'});
          res.end(JSON.stringify({error:{type:'api_error',message:'Offline upstream interruption after native Read'}}));return;
        }
      }
      else assert.fail('Unexpected extra request');
      const raw=reply(tool,input,n);
      res.writeHead(200,{'content-type':mode==='json'?'application/json':'text/event-stream'});
      res.end(mode==='json'?JSON.stringify(raw):jsonToSse(raw,config.model));
    }catch(e){failure??=e;res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'invalid_request_error',message:e.message}}));}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const model=createDecisionLoopModel({config,root:root+'/model',binary,nativeSkillAssetsRoot:assets,nativeKnowledgeGuidance:guidance,nativeSkillEntry:entryMode,key:'offline-dummy-not-a-credential',
    offlineEndpoint:'http://127.0.0.1:'+server.address().port,timeoutMs:20000});
  try{
    if(mode==='interrupted'){
      await assert.rejects(model.complete(request),e=>{
        assert.equal(e.status,502);assert.equal(e.retryable,true);assert(e.native_history_retry);
        const retained=inspectNativeHistoryRetry(e.native_history_retry);
        assert.equal(retained.all_native_outputs_retained,true);assert.equal(retained.original_tool_results_present,true);
        assert.equal(retained.remaining_native_turns,5);assert.equal(retained.consumed_retained_native_turns,2);
        return true;
      });
      assert.equal(model.diagnostics.native_reference_reads,1);
    }else{
    const result=await model.complete(request);
    assert.equal(result.tool_call.name,'act');assert.equal(result.raw.__code_harness.version,NATIVE_SKILL_VERSION);
    assert.equal(result.raw.__code_harness.native_internal.length,mode==='budget'?4:lookup?2:0);
    assert.equal(model.diagnostics.native_reference_reads,mode==='budget'?3:lookup?1:0);
    assert.equal(model.diagnostics.native_reference_denials,mode==='budget'?1:0);
    assert.equal(model.diagnostics.native_skill_invocations,lookup?1:0);
    assert.equal(result.usage.output_tokens,mode==='budget'?15:lookup?9:3);
    assert.equal(result.usage.input_tokens,mode==='budget'?10:lookup?6:2);
    }
  }finally{await model.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
  if(failure)throw failure;
  if(mode==='json')assert(requests>=3&&requests<=6,'Bound native stream-to-JSON fallback separately from model turns');
  else assert.equal(requests,mode==='budget'?5:lookup?3:1);
  const session=JSON.parse(fs.readFileSync(root+'/model/session-1/SESSION.json'));
  assert(session.exit!=null);
});
