import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {createCodexDecisionLoopModel,codexHistory,assertCodexFactualRequest} from '../harnesses/codex-decision-loop/model.mjs';
import {TRANSPORT_DUMMY} from '../harnesses/codex-decision-loop/transport.mjs';
import {inspectCodexSession} from '../harnesses/codex-decision-loop/session-audit.mjs';
const config={model:'gpt-6.1-sol',max_tokens:16384,strict_tools:true,reasoning_effort:'high'};
const fixture=JSON.parse(fs.readFileSync(new URL('../harnesses/claude-code-decision-loop/CAPTURE-FIXTURES.json',import.meta.url))).cases[0].neutral;
test('history retains original Codex output blocks and tool results in order without synthetic assistant text',()=>{
  const output=[{type:'reasoning',encrypted_content:'signed-fixture'},{type:'function_call',call_id:'old',name:'act',arguments:'{"action":{"type":"WAIT"}}'}];
  const messages=[{role:'assistant',provider:{adapter:'codex',items:output}},{role:'user',tool_result_for:'old',content:'ORIGINAL_RECEIPT'}];
  assert.deepEqual(codexHistory(messages),[...output,{type:'function_call_output',call_id:'old',output:'ORIGINAL_RECEIPT'}]);
});
test('complete official CLI adapter: native Skill/Read, original controller simulate answer, act, fresh decision with full factual prefix',
 {skip:!process.env.CODEX_TEST_BINARY||!process.env.CODEX_TEST_SKILL_ASSETS,timeout:30000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-model-'));const wires=[];
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));wires.push(body);const n=wires.length;
    const name=n===1?'Read':n===2?'simulate':'act',input=n===1?{file_path:fs.realpathSync(root+'/model/session-1/native/home/skills/blood-glucose-management/references/16-benchmark-hardware-operations.md'),offset:1,limit:12}:n===2?{action:{type:'WAIT'},hours:1}:{action:{type:'WAIT'},note:'Offline native trajectory-interface fixture.'};
    const call={type:'function_call',id:'fc_'+n,call_id:'call_'+n,name,arguments:JSON.stringify(input)};
    assert(body.instructions.startsWith(fixture.system+'\n\n'));assert(!body.input.some(i=>i.role==='developer'&&i.content?.[0]?.text===body.instructions));
    const annotation={turn_id:'01a18e7b-0749-7364-8015-3a5f77327b6e'};
    const reasoning={type:'reasoning',id:'rs_'+n,summary:[],content:[],encrypted_content:'encrypted-fixture-'+n,metadata:annotation,internal_chat_message_metadata_passthrough:annotation};
    const response={id:'resp_'+n,object:'response',status:'completed',model:'gpt-6.1-sol',output:[reasoning,call],usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:1}}};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const e of [{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:reasoning},{type:'response.output_item.done',output_index:0,item:reasoning},{type:'response.output_item.added',output_index:1,item:{...call,arguments:''}},{type:'response.function_call_arguments.delta',output_index:1,item_id:call.id,delta:call.arguments},{type:'response.output_item.done',output_index:1,item:call},{type:'response.completed',response}])res.write('event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n');res.end();
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const model=createCodexDecisionLoopModel({config,root:root+'/model',key:TRANSPORT_DUMMY,binary:process.env.CODEX_TEST_BINARY,skillAssetsRoot:process.env.CODEX_TEST_SKILL_ASSETS,endpoint:'http://127.0.0.1:'+server.address().port+'/v1',offline:true});
  try{
    const query=await model.complete(fixture);assert.equal(query.tool_call.name,'simulate');assert.equal(query.usage.input_tokens,20);assert.equal(query.usage.output_tokens,10);
    const request={...fixture,messages:[...fixture.messages,{role:'assistant',content:query.text,tool_call:query.tool_call,provider:query.provider},{role:'user',tool_result_for:query.tool_call.id,content:'EXACT_CONTROLLER_SIMULATION_RESULT'}]};
    const action=await model.complete(request);assert.equal(action.tool_call.name,'act');assert.equal(model.diagnostics.sessions,1);assert.equal(model.diagnostics.continuations,1);
    const next={...request,messages:[...request.messages,{role:'assistant',content:action.text,tool_call:action.tool_call,provider:action.provider},{role:'user',tool_result_for:action.tool_call.id,content:'EXACT_NEXT_OBSERVATION_AND_RECEIPT'}]};
    const second=await model.complete(next);assert.equal(second.tool_call.name,'act');assert.equal(model.diagnostics.sessions,2);assert.equal(wires.length,4);
    assert(JSON.stringify(wires[2]).includes('EXACT_CONTROLLER_SIMULATION_RESULT'));assert(JSON.stringify(wires[3]).includes('EXACT_NEXT_OBSERVATION_AND_RECEIPT'));
    for(const wire of wires){assert.equal(wire.max_output_tokens,16384);assert.equal(wire.reasoning.effort,'high');}
    const calls=[{request:fixture},{request},{request:next}];
    const firstAudit=inspectCodexSession(root+'/model/session-1',{calls,modelConfig:config});assert.equal(firstAudit.Read_allowed,1);assert.equal(firstAudit.requests,3);
    assert(inspectCodexSession(root+'/model/session-2',{calls,modelConfig:config}).independent_factual_contexts);
    const knowledge={root:fs.realpathSync(root+'/model/session-2/native/home/skills/blood-glucose-management'),path:fs.realpathSync(root+'/model/session-2/native/home/skills/blood-glucose-management/SKILL.md')};
    const system=fs.readFileSync(root+'/model/session-2/transport/REGISTRATION.json','utf8');const registration=JSON.parse(system);
    const raw=second.raw,guard=body=>assertCodexFactualRequest(body,{request:next,system:registration.instructions,knowledge,responses:[],knowledgeResults:new Map()});
    const original=JSON.parse(fs.readFileSync(root+'/model/session-2/transport/1-NATIVE-REQUEST.json'));guard(original);
    for(const mutate of [i=>i.encrypted_content+='changed',i=>i.summary.push({type:'summary_text',text:'Fabricated reasoning'}),i=>i.metadata={turn_id:'different'},i=>i.metadata={turn_id:'01a18e7b-0749-7364-8015-3a5f77327b6f'},i=>i.metadata={turn_id:'01a18e7b-0749-7364-8015-3a5f77327b6e',semantic:'hidden'}]){
      const bad=structuredClone(original);mutate(bad.input.find(i=>i.type==='reasoning'));assert.throws(()=>guard(bad));
    }
    assert(raw.output.some(i=>i.type==='reasoning'&&i.metadata),'Original metadata remains in the unmodified reply');
  }finally{await model.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
