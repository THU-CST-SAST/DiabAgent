import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import {createCodexDecisionLoopModel,CODEX_PARALLEL_REJECTION,codexNativeRouterErrors} from '../harnesses/codex-decision-loop/model.mjs';
import {PARALLEL_REJECTION} from '../harnesses/claude-code-decision-loop/native-session.mjs';
import {TRANSPORT_DUMMY} from '../harnesses/codex-decision-loop/transport.mjs';
import {inspectCodexSession} from '../harnesses/codex-decision-loop/session-audit.mjs';

const config={model:'gpt-6.1-sol',max_tokens:16384,strict_tools:true,reasoning_effort:'high'};
const request=JSON.parse(fs.readFileSync(new URL('../harnesses/claude-code-decision-loop/CAPTURE-FIXTURES.json',import.meta.url))).cases[0].neutral;
const enabled=!!process.env.CODEX_TEST_BINARY&&!!process.env.CODEX_TEST_SKILL_ASSETS;
const call=(n,name,input)=>({type:'function_call',id:'fc_negative_'+n,call_id:'call_negative_'+n,name,arguments:JSON.stringify(input)});
async function fixture(script,verify){
 const root=fs.mkdtempSync(os.tmpdir()+'/codex-negative-'),wires=[];let failure;
 const server=http.createServer(async(req,res)=>{
  try{
   const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));wires.push(body);
   const result=script(wires.length,body,root),response={id:'resp_negative_'+wires.length,object:'response',status:'completed',model:'gpt-6.1-sol',instructions:body.instructions,output:result.output,usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}},...result};
   res.writeHead(200,{'content-type':'text/event-stream'});
   const send=e=>res.write('event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n');
   send({type:'response.created',response:{...response,status:'in_progress',output:[]}});
   for(let i=0;i<response.output.length;i++){
    const item=response.output[i];send({type:'response.output_item.added',output_index:i,item:item.type==='function_call'?{...item,arguments:''}:item});
    if(item.type==='function_call')send({type:'response.function_call_arguments.delta',output_index:i,item_id:item.id,delta:item.arguments});
    send({type:'response.output_item.done',output_index:i,item});
   }
   send({type:response.status==='incomplete'?'response.incomplete':'response.completed',response});res.end();
  }catch(e){failure=e;if(!res.headersSent)res.writeHead(400);res.end(JSON.stringify({error:{message:'Offline fixture failed'}}));}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const model=createCodexDecisionLoopModel({config,root:root+'/model',key:TRANSPORT_DUMMY,binary:process.env.CODEX_TEST_BINARY,skillAssetsRoot:process.env.CODEX_TEST_SKILL_ASSETS,endpoint:'http://127.0.0.1:'+server.address().port+'/v1',offline:true});
 try{await verify({model,root,wires});assert.ifError(failure);}finally{await model.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
}

test('serial rejection wording matches the original Code policy',()=>assert.equal(CODEX_PARALLEL_REJECTION,PARALLEL_REJECTION));
test('native router errors cannot hide arbitrary tool results or change the native error text',()=>{
 const raw={id:'resp_unknown',output:[call('unknown','unadvertised_fixture_tool',{})]},body={input:[{type:'function_call_output',call_id:'call_negative_unknown',output:'unsupported call: unadvertised_fixture_tool'}]};
 assert.equal(codexNativeRouterErrors(body,{responses:[raw],toolNames:['act']}).length,1);
 assert.throws(()=>codexNativeRouterErrors({input:[{...body.input[0],output:'Action succeeded'}]},{responses:[raw],toolNames:['act']}));
 assert.throws(()=>codexNativeRouterErrors({input:[]},{responses:[raw],toolNames:['act']}));
});
test('parallel controller calls are rejected together, native correction retains both results and consumes one of7 turns',{skip:!enabled,timeout:20000},()=>fixture(
 n=>({output:n===1?[{type:'reasoning',id:'rs_parallel',summary:[],encrypted_content:'original-encrypted-fixture'},call('p1','simulate',{action:{type:'WAIT'},hours:1}),call('p2','simulate',{action:{type:'WAIT'},hours:2})]:[call('act','act',{action:{type:'WAIT'},note:'Offline corrected action.'})]}),
 async({model,root,wires})=>{
  const result=await model.complete(request);assert.equal(result.tool_call.name,'act');assert.equal(result.raw.__codex_harness.native_model_turn,2);assert.equal(model.diagnostics.sessions,1);assert.equal(wires.length,2);
  const errors=wires[1].input.filter(i=>i.type==='function_call_output');assert.equal(errors.length,2);assert(errors.every(i=>JSON.stringify(i.output).includes(CODEX_PARALLEL_REJECTION)));
  const records=fs.readFileSync(root+'/model/session-1/POLICY-REJECTIONS.jsonl','utf8').trim().split('\n').map(JSON.parse);assert.equal(records.length,2);assert(records.every(r=>r.result.success===false));
  assert.equal(result.usage.input_tokens,20);assert.equal(result.usage.output_tokens,10);
  assert(inspectCodexSession(root+'/model/session-1',{calls:[{request}],modelConfig:config}).independent_factual_contexts);
 }));
test('knowledge requests cannot reset native7 or Read3; the eighth request is stopped before upstream',{skip:!enabled,timeout:20000},()=>fixture(
 (n,body,root)=>({output:[call('read'+n,'Read',{file_path:root+'/model/session-1/native/home/skills/blood-glucose-management/SKILL.md',offset:1,limit:1})]}),
 async({model,root,wires})=>{
  await assert.rejects(model.complete(request),e=>e.code==='CODEX_NATIVE_REQUEST_GUARD');assert.equal(wires.length,7);assert.equal(model.diagnostics.sessions,1);
  const ledger=JSON.parse(fs.readFileSync(root+'/model/session-1/native/NATIVE-KNOWLEDGE-LEDGER.json'));assert.equal(ledger.attempts.length,7);assert.equal(ledger.attempts.filter(a=>a.allowed).length,3);
  assert.equal(fs.readdirSync(root+'/model/session-1').filter(f=>/^NATIVE-REPLY-/.test(f)).length,7);
 }));
test('numeric-string dose is retained and rejected by original schema, never coerced',{skip:!enabled,timeout:20000},()=>fixture(
 ()=>({output:[call('string','act',{action:{type:'BOLUS',units:'0.1'},note:'Offline invalid value.'})]}),
 async({model,wires})=>{await assert.rejects(model.complete(request),e=>e.code==='TOOL_CONTRACT'&&e.response_raw.output[0].arguments.includes('"units":"0.1"'));assert.equal(wires.length,1);}));
test('output-cap truncation preserves the raw response and repair result without an action',{skip:!enabled,timeout:20000},()=>fixture(
 ()=>({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[call('truncated','act',{action:{type:'WAIT'},note:'Offline incomplete response.'})]}),
 async({model,wires})=>{await assert.rejects(model.complete(request),e=>e.code==='TOOL_CONTRACT'&&e.response_raw.status==='incomplete'&&!!e.repair_result);assert.equal(wires.length,1);}));
test('pseudo tool markup in ordinary text cannot become an action',{skip:!enabled,timeout:20000},()=>fixture(
 ()=>({output:[{type:'message',id:'msg_pseudo',role:'assistant',content:[{type:'output_text',text:'<tool_call name="act">{"action":{"type":"WAIT"}}</tool_call>'}]}]}),
 async({model,wires})=>{await assert.rejects(model.complete(request),e=>e.code==='TOOL_CONTRACT');assert.equal(wires.length,1);}));
test('unadvertised tool stays in native correction loop without fabricated controller execution',{skip:!enabled,timeout:20000},()=>fixture(
 n=>({output:[n===1?call('unknown','unadvertised_fixture_tool',{}):call('corrected','act',{action:{type:'WAIT'},note:'Offline after native unknown-tool error.'})]}),
 async({model,root,wires})=>{const result=await model.complete(request);assert.equal(result.tool_call.name,'act');assert.equal(result.raw.__codex_harness.native_model_turn,2);assert.equal(wires.length,2);assert.equal(model.diagnostics.sessions,1);assert(inspectCodexSession(root+'/model/session-1',{calls:[{request}],modelConfig:config}).independent_factual_contexts);}));
test('malformed original JSON remains unmodified while the native parser supplies its real error and correction',{skip:!enabled,timeout:20000},()=>fixture(
 n=>({output:[n===1?{...call('badjson','act',{}),arguments:'{"action":'}:call('afterjson','act',{action:{type:'WAIT'},note:'Offline after native JSON rejection.'})]}),
 async({model,root,wires})=>{
  const result=await model.complete(request);assert.equal(result.tool_call.name,'act');assert.equal(result.raw.__codex_harness.native_model_turn,2);assert.equal(wires.length,2);
  const original=JSON.parse(fs.readFileSync(root+'/model/session-1/NATIVE-REPLY-1.json'));assert.equal(original.output[0].arguments,'{"action":');
  const error=wires[1].input.find(i=>i.type==='function_call_output');assert(JSON.stringify(error.output).includes('failed to parse function arguments:'));
  assert(inspectCodexSession(root+'/model/session-1',{calls:[{request}],modelConfig:config}).independent_factual_contexts);
 }));
