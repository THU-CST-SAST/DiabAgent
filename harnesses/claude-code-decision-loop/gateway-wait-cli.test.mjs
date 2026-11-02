import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createDecisionLoopModel} from './model.mjs';
import {createGatewayWaitModel,inspectEmptyGatewayFailure} from './gateway-wait.mjs';
import {jsonToSse} from './protocol.mjs';
import {PREFIX} from './history.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./CAPTURE-FIXTURES.json',import.meta.url))).cases[0].neutral;
test('official Code waits through empty502 and preserves the next native MCP reply',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-native-')),waits=[],events=[];let count=0,model;
 const server=http.createServer(async(req,res)=>{
  for await(const c of req)void c;
  if(++count===1){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'api_error',message:'controlled gateway502'}}));return;}
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.end(jsonToSse({id:'gateway_fixture',type:'message',role:'assistant',model:'claude-opus-5-5',content:[{type:'tool_use',id:'gateway_act',name:PREFIX+'act',input:{action:{type:'WAIT'},note:'Offline transport fixture.'}}],stop_reason:'tool_use',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const delegate=createDecisionLoopModel({config:{model:'claude-opus-5-5',max_tokens:8192,reasoning_effort:'high',strict_tools:true},root:root+'/Code',key:'offline-dummy-not-a-credential',binary:process.env.CODE_TEST_BINARY,offlineEndpoint:'http://127.0.0.1:'+server.address().port,timeoutMs:15000,maxTurns:7});
  model=createGatewayWaitModel({delegate,verifyEmptyFailure:async()=>inspectEmptyGatewayFailure(root+'/Code/session-1'),onEvent:async e=>events.push(e),sleep:async ms=>waits.push(ms)});
  const reply=await model.complete(fixture);assert.equal(reply.raw.content[0].id,'gateway_act');
  assert.equal(count,2);assert.deepEqual(waits,[60000]);assert.equal(events.length,1);
  assert.equal(reply.raw.__code_harness.native_MCP_called,true);
 }finally{await model?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
