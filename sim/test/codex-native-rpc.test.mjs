import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {CodexRpc} from '../harnesses/codex-decision-loop/rpc.mjs';
import {startBenchmarkThread} from '../harnesses/codex-decision-loop/thread.mjs';

test('official 0.163.0: high, exact factual text, only registered tools, native query then act',
  {skip:!process.env.CODEX_TEST_BINARY,timeout:30000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-native-'));
  const wires=[];let resolveAct,rejectAct;
  const act=new Promise((resolve,reject)=>{resolveAct=resolve;rejectAct=reject;});
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    const body=JSON.parse(Buffer.concat(chunks));wires.push(body);
    const n=wires.length,name=n===1?'simulate':'act';
    const item={type:'function_call',id:'fc_'+n,call_id:'call_'+n,name,arguments:JSON.stringify(n===1?{minutes:60}:{action:{type:'WAIT'}})};
    const response={id:'resp_'+n,object:'response',status:'completed',model:'gpt-6.1-sol',output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:1}}};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const event of [{type:'response.created',response:{...response,status:'in_progress',output:[]}},
      {type:'response.output_item.added',output_index:0,item:{...item,arguments:''}},
      {type:'response.function_call_arguments.delta',output_index:0,item_id:item.id,delta:item.arguments},
      {type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}])
      res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n');
    res.end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const rpc=new CodexRpc({binary:process.env.CODEX_TEST_BINARY,root:root+'/native',key:'offline-dummy-not-a-credential',endpoint:'http://127.0.0.1:'+server.address().port+'/v1',timeoutMs:15000,
    onMessage:async m=>{
      if(m.method!=='item/tool/call')return;
      try{
        if(m.params.tool==='simulate')rpc.respond(m.id,{contentItems:[{type:'inputText',text:'ORIGINAL_QUERY_RESULT'}],success:true});
        else {assert.equal(m.params.tool,'act');resolveAct(m);}
      }catch(e){rejectAct(e);}
    }});
  let timer;
  try{
    const tools=['simulate','act'].map(name=>({name,description:'Original '+name,input_schema:{type:'object',properties:name==='simulate'?{minutes:{type:'integer'}}:{action:{type:'object'}},required:name==='simulate'?['minutes']:['action']}}));
    const thread=await startBenchmarkThread(rpc,{system:'EXACT_SYSTEM',tools});
    await rpc.request('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'EXACT_OBSERVATION'}],effort:'high'});
    await Promise.race([act,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('No native act')),15000);})]);
    assert.equal(wires.length,2);
    for(const wire of wires){
      assert.equal(wire.model,'gpt-6.1-sol');assert.equal(wire.reasoning.effort,'high');
      const additional=wire.input.filter(i=>i.type==='additional_tools').flatMap(i=>i.tools).flatMap(t=>t.tools??[t]);
      const supplied=wire.tools??additional;
      assert.deepEqual(supplied.map(t=>t.name).sort(),['act','simulate']);
      const text=wire.input.filter(i=>i.type==='message').flatMap(i=>i.content??[]).filter(i=>i.type==='input_text').map(i=>i.text);
      assert.deepEqual(text,['EXACT_SYSTEM','EXACT_OBSERVATION']);
    }
    assert(JSON.stringify(wires[1]).includes('ORIGINAL_QUERY_RESULT'));
  }finally{
    clearTimeout(timer);await rpc.close();server.closeAllConnections();await new Promise(r=>server.close(r));
  }
  assert.equal(wires.length,2,'No model request after final act');
});
