import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {nativeTerminalFailure} from './native-failure.mjs';
import {createDecisionLoopModel} from './model.mjs';
import {PREFIX} from './history.mjs';
import {jsonToSse} from './protocol.mjs';
const fixtures=JSON.parse(fs.readFileSync(new URL('./CAPTURE-FIXTURES.json',import.meta.url)));
test('only known terminal CLI transport errors override a prior invalid tool reply',()=>{
  for(const status of [401,402,403,429,502,503])assert.equal(nativeTerminalFailure([{type:'result',is_error:true,api_error_status:status,result:'offline error'}]).status,status);
  assert.equal(nativeTerminalFailure([{type:'assistant',message:{content:'API Error502'}}]),null);
  assert.equal(nativeTerminalFailure([{type:'result',is_error:false,api_error_status:502}]),null);
  assert.equal(nativeTerminalFailure([{type:'result',is_error:true,result:'untyped format error'}]),null);
});
test('captured Code296 untyped terminal errors are classified without claiming HTTP observation',()=>{
  for(const [result,status] of [['Request timed out',504],['API Error: Connection dropped (ECONNRESET)',503],['API Error: 520 {"status":520}',520]]){
    const error=nativeTerminalFailure([{type:'result',is_error:true,result}]);
    assert.equal(error.status,status);assert.equal(error.message,result);assert.equal(error.native_reported_status,null);
    assert.equal(nativeTerminalFailure([{type:'assistant',message:{content:result}}]),null);
    assert.equal(nativeTerminalFailure([{type:'result',is_error:false,result}]),null);
  }
  for(const status of [401,402,403])assert.equal(nativeTerminalFailure([{type:'result',is_error:true,result:'API Error: '+status+' denied'}]).status,status);
});
for(const kind of ['520','reset'])test('real official Code: terminal '+kind+' retains the original bounded retry path',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'skill-terminal-'));
  let count=0,model;
  const server=http.createServer(async(request,response)=>{
    for await(const chunk of request)void chunk;count++;
    if(kind==='reset')request.socket.destroy();
    else{response.writeHead(520,{'content-type':'application/json'});response.end(JSON.stringify({error:{type:'api_error',message:'offline controlled520'}}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    model=createDecisionLoopModel({config:{model:'claude-opus-5-5',max_tokens:8192,reasoning_effort:'high',strict_tools:true},root:root+'/Code',key:'offline-dummy-not-a-credential',binary:process.env.CODE_TEST_BINARY,offlineEndpoint:'http://127.0.0.1:'+server.address().port,timeoutMs:15000,maxTurns:7});
    await assert.rejects(model.complete(fixtures.cases[0].neutral),e=>e.status===(kind==='reset'?503:520)&&e.retryable&&e.retryAfterMs===60000);
    assert.equal(count,1);assert.equal(model.diagnostics.nativeCalls,0);
  }finally{await model?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('real official Code: native parallel rejection then502 remains a retryable transport failure',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'skill-native-failure-'));
  const config={model:'claude-opus-5-5',max_tokens:8192,reasoning_effort:'high',strict_tools:true};
  let count=0,model;
  const server=http.createServer(async(request,response)=>{
    for await(const chunk of request)void chunk;
    if(++count===1) {
      response.writeHead(200,{'content-type':'text/event-stream'});
      response.end(jsonToSse({id:'offline_parallel',type:'message',role:'assistant',model:config.model,
        content:[1,2].map(n=>({type:'tool_use',id:'offline_parallel_'+n,name:PREFIX+'simulate',input:{action:{type:'WAIT'},hours:1}})),
        stop_reason:'tool_use',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}));
    } else {
      response.writeHead(502,{'content-type':'application/json'});
      response.end(JSON.stringify({error:{type:'api_error',message:'offline controlled502 after parallel rejection'}}));
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    model=createDecisionLoopModel({config,root:root+'/Code',key:'offline-dummy-not-a-credential',binary:process.env.CODE_TEST_BINARY,
      offlineEndpoint:'http://127.0.0.1:'+server.address().port,timeoutMs:15000,maxTurns:7});
    await assert.rejects(model.complete(fixtures.cases[0].neutral),error=>error.status===502&&error.retryable===true&&error.code!=='TOOL_CONTRACT');
    assert.equal(count,2);assert.equal(model.diagnostics.nativeCalls,0);
  } finally {await model?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
