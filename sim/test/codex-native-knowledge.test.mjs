import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {CodexRpc} from '../harnesses/codex-decision-loop/rpc.mjs';
import {startBenchmarkThread} from '../harnesses/codex-decision-loop/thread.mjs';
import {CODEX_KNOWLEDGE_TOOLS} from '../harnesses/codex-decision-loop/knowledge.mjs';
import {startCodexTransport,TRANSPORT_DUMMY} from '../harnesses/codex-decision-loop/transport.mjs';

test('native pinned Skill injection plus original Read3 budget, no extra tools, exact cap transport',
 {skip:!process.env.CODEX_TEST_BINARY||!process.env.CODEX_TEST_SKILL_ASSETS,timeout:30000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-knowledge-'));const wires=[];let rpc,timer,resolveAct,rejectAct;
  const acted=new Promise((resolve,reject)=>{resolveAct=resolve;rejectAct=reject;});
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));wires.push(body);const n=wires.length;
    const call={type:'function_call',id:'fc_'+n,call_id:'call_'+n,name:n<=4?'Read':'act',arguments:JSON.stringify(n<=4?{file_path:rpc.knowledge.root+'/references/16-benchmark-hardware-operations.md',offset:1,limit:12}:{action:{type:'WAIT'}})};
    const response={id:'resp_'+n,object:'response',status:'completed',model:'gpt-6.1-sol',output:[call],usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:1}}};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const e of [{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...call,arguments:''}},{type:'response.function_call_arguments.delta',output_index:0,item_id:call.id,delta:call.arguments},{type:'response.output_item.done',output_index:0,item:call},{type:'response.completed',response}])res.write('event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n');res.end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const transport=await startCodexTransport({root:root+'/transport',key:TRANSPORT_DUMMY,endpoint:'http://127.0.0.1:'+server.address().port+'/v1',offline:true});
  rpc=new CodexRpc({binary:process.env.CODEX_TEST_BINARY,root:root+'/native',key:TRANSPORT_DUMMY,endpoint:transport.endpoint,skillAssetsRoot:process.env.CODEX_TEST_SKILL_ASSETS,timeoutMs:15000,onMessage:m=>{
    if(m.method!=='item/tool/call')return;
    try{
      if(m.params.tool==='act'){resolveAct(m);return;}
      const result=rpc.knowledge.execute({id:m.params.callId,name:m.params.tool,input:m.params.arguments});
      rpc.respond(m.id,{contentItems:[{type:'inputText',text:result.text}],success:result.success});
    }catch(e){rejectAct(e);}
  }});
  try{
    const thread=await startBenchmarkThread(rpc,{system:'EXACT_MAIN_PROMPT',tools:[...CODEX_KNOWLEDGE_TOOLS,{name:'act',description:'Original act',input_schema:{type:'object',properties:{action:{type:'object'}},required:['action']}}]});
    await rpc.request('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'EXACT_OBSERVATION'},{type:'skill',name:'blood-glucose-management',path:rpc.knowledge.path}],effort:'high'});
    await Promise.race([acted,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('No native act')),15000);})]);
    assert.equal(wires.length,5);assert.equal(rpc.knowledge.state.attempts.filter(r=>r.allowed).length,3);assert.equal(rpc.knowledge.state.attempts.at(-1).allowed,false);
    const entry=fs.readFileSync(rpc.knowledge.path,'utf8').replace(/^---\n[\s\S]*?\n---\n/,'').trim();
    for(const body of wires){assert.equal(body.max_output_tokens,16384);assert.equal(body.reasoning.effort,'high');assert(JSON.stringify(body).includes('EXACT_MAIN_PROMPT'));const texts=body.input.filter(x=>x.type==='message').flatMap(x=>x.content??[]).filter(x=>x.type==='input_text').map(x=>x.text).join('\n');assert(texts.includes(entry),'Native entry preserves the exact primer body');}
    assert(JSON.stringify(wires[4]).includes('Original reference budget exhausted'));
    assert(!rpc.knowledge.execute({id:'outside',name:'Read',input:{file_path:'/etc/passwd'}}).success);
  }finally{clearTimeout(timer);await rpc.close();await transport.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
