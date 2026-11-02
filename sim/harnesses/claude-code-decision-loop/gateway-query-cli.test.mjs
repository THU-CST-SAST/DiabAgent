import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {createDecisionLoopModel} from './model.mjs';import {createGatewayWaitModel,inspectEmptyGatewayFailure} from './gateway-wait.mjs';import {inspectNativeQueryFailure} from './native-query-wait.mjs';import {jsonToSse} from './protocol.mjs';import {PREFIX} from './history.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./CAPTURE-FIXTURES.json',import.meta.url))).cases[0].neutral;
test('official Code preserves a signed query and its result across repeated gateway failures with six turns remaining',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-query-wait-')),bodies=[],waits=[],events=[];let model;
 const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));bodies.push(body);const n=bodies.length;
  if(n===2||n===3){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'api_error',message:'Controlled query continuation502'}}));return;}
  const tool=n===1?'simulate':'act',input=n===1?{action:{type:'WAIT'},hours:1}:{action:{type:'WAIT'},note:'Offline recovered query fixture.'};
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(jsonToSse({id:'query_fixture_'+n,type:'message',role:'assistant',model:'claude-opus-5-5',
   content:[{type:'thinking',thinking:'Offline signed query.',signature:'preserve_query_signature_'+n},{type:'tool_use',id:'query_use_'+n,name:PREFIX+tool,input}],stop_reason:'tool_use',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const delegate=createDecisionLoopModel({config:{model:'claude-opus-5-5',max_tokens:8192,reasoning_effort:'high',strict_tools:true},root:dir+'/Code',key:'offline-dummy-not-a-credential',binary:process.env.CODE_TEST_BINARY,offlineEndpoint:'http://127.0.0.1:'+server.address().port,timeoutMs:15000,maxTurns:7});
  model=createGatewayWaitModel({delegate,unlimited:true,sleep:async ms=>waits.push(ms),onEvent:async e=>events.push(e),verifyEmptyFailure:async({error})=>{
   if(error.native_query_retry)return inspectNativeQueryFailure(error.native_query_retry);
   const names=fs.readdirSync(dir+'/Code').filter(n=>/^session-\d+$/.test(n)).sort((a,b)=>Number(a.slice(8))-Number(b.slice(8)));return inspectEmptyGatewayFailure(dir+'/Code/'+names.at(-1));
  }});
  const first=await model.complete(fixture);assert.equal(first.tool_call.name,'simulate');
  const next={...fixture,messages:[...fixture.messages,{role:'assistant',content:first.text??'',tool_call:first.tool_call,provider:first.provider},{role:'user',content:'Exact original simulate result retained.',tool_result_for:first.tool_call.id}]};
  const final=await model.complete(next);assert.equal(final.tool_call.name,'act');assert.equal(bodies.length,4);assert.deepEqual(waits,[60000,120000]);
  assert.equal(events[0].remaining_native_turns,6);assert(events[0].query_resume);
  for(const body of bodies.slice(2)){
   const blocks=body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]);
   assert(blocks.some(b=>b.type==='thinking'&&b.signature==='preserve_query_signature_1'));
   assert(blocks.some(b=>b.type==='tool_use'&&b.id==='query_use_1'));
   assert(JSON.stringify(body.messages).includes('Exact original simulate result retained.'));
  }
  const allowances=[1,2,3].map(n=>{const launch=JSON.parse(fs.readFileSync(dir+'/Code/session-'+n+'/LAUNCH.json'));return launch.max_native_model_turns;});
  assert.deepEqual(allowances,[7,6,6]);
 }finally{await model?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
