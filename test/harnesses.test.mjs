import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {resolveHarness} from '../scripts/harness-config.mjs';
import {ROOT,read} from '../scripts/lib.mjs';
import {compileControllerRequest} from '../harnesses/claude-code-decision-loop/model.mjs';
import {parseCodeStream} from '../harnesses/claude-code-decision-loop/reply-parser.mjs';
import {benchmarkCatalog} from '../harnesses/codex-decision-loop/catalog.mjs';
import {startBenchmarkThread} from '../harnesses/codex-decision-loop/thread.mjs';
import {startCodexTransport,TRANSPORT_DUMMY} from '../harnesses/codex-decision-loop/transport.mjs';
import {createCodexDecisionLoopModel} from '../harnesses/codex-decision-loop/model.mjs';
import {nativeKnowledgeInstructions} from '../harnesses/claude-code-decision-loop/native-skill.mjs';

const model='provider/unlisted-model-v1';
test('public configuration accepts an arbitrary provider model for either harness',()=>{
  for(const harness of ['claude-code','codex']){
    const config=resolveHarness({harness,model});assert.equal(config.config.model,model);assert.equal(config.config.max_tokens,16384);
  }
  for(const bad of ['',null,'bad\nmodel',' bad','true'])assert.throws(()=>resolveHarness({harness:'codex',model:bad}));
  assert.throws(()=>resolveHarness({harness:'unknown',model}));
});
test('Code compiles and checks the selected model without changing returned identity',()=>{
  const request=read(ROOT+'harnesses/claude-code-decision-loop/CAPTURE-FIXTURES.json').cases[0].neutral;
  assert.equal(compileControllerRequest(resolveHarness({harness:'claude-code',model}).config,request).model,model);
  const raw={id:'custom-response',type:'message',role:'assistant',model,content:[{type:'tool_use',id:'call-1',name:'mcp__experiment__act',input:{action:{type:'WAIT'}}}],stop_reason:'tool_use',usage:{input_tokens:3,output_tokens:2}};
  assert.deepEqual(parseCodeStream(JSON.stringify(raw),{model}).raw,raw);
  assert.throws(()=>parseCodeStream(JSON.stringify({...raw,model:'different-model'}),{model}),/identity/);
});
test('native harness settings accept custom token, effort and reference/native-turn budgets',async t=>{
  const request=read(ROOT+'harnesses/claude-code-decision-loop/CAPTURE-FIXTURES.json').cases[0].neutral;
  const config={...resolveHarness({harness:'claude-code',model}).config,max_tokens:4096,reasoning_effort:'medium'};
  const compiled=compileControllerRequest(config,request);assert.equal(compiled.max_tokens,4096);assert.equal(compiled.output_config.effort,'medium');
  const instructions=nativeKnowledgeInstructions('detailed-reference-v3',{maxReads:5,maxTurns:12});
  assert(instructions.includes('5'));assert(instructions.includes('12'));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'diabagent-budgets-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const delegate=createCodexDecisionLoopModel({config:{...resolveHarness({harness:'codex',model}).config,max_tokens:4096,reasoning_effort:'medium'},root:root+'/model',key:TRANSPORT_DUMMY,maxTurns:12,maxReferenceReads:5,timeoutMs:360000});
  assert.equal(delegate.diagnostics.output_cap,4096);await delegate.close();
});
test('Codex uses selected model in its catalog, thread, and factory',async t=>{
  const catalog=benchmarkCatalog(model);assert.equal(catalog.models[0].slug,model);assert.equal(catalog.models[0].model_messages,null);assert.equal(catalog.models[0].base_instructions,'');
  assert.deepEqual(benchmarkCatalog('gpt-6.1-sol'),read(ROOT+'harnesses/codex-decision-loop/model-catalog.json'));
  const events=[],rpc={root:'/tmp/isolated',notify:()=>{},request:async(method,params)=>{events.push({method,params});return method==='skills/list'?{data:[]}:{thread:{id:'test-thread'}};}};
  await startBenchmarkThread(rpc,{system:'Exact benchmark system',tools:[],model});
  assert.equal(events.find(e=>e.method==='thread/start').params.model,model);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'diabagent-generic-codex-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const delegate=createCodexDecisionLoopModel({config:resolveHarness({harness:'codex',model}).config,root:root+'/model',key:TRANSPORT_DUMMY});
  assert.equal(delegate.config.model,model);await delegate.close();
  const file=root+'/catalog.json';fs.writeFileSync(file,JSON.stringify(catalog));
  assert.equal(resolveHarness({harness:'codex',model,'model-catalog':file}).catalogFile,fs.realpathSync(file));
  assert.throws(()=>resolveHarness({harness:'codex',model:'other-model','model-catalog':file}));
});
test('Codex localhost transport preserves selected model and rejects substitutions',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'diabagent-custom-wire-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let seen=null;const envelope='data: '+JSON.stringify({type:'response.completed',response:{id:'native-custom',model,status:'completed',output:[]}})+'\n\n';
  const upstream=http.createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=chunk;seen=JSON.parse(data);res.writeHead(200,{'content-type':'text/event-stream'});res.end(envelope);});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const bridge=await startCodexTransport({root:root+'/wire',key:TRANSPORT_DUMMY,endpoint:'http://127.0.0.1:'+upstream.address().port+'/v1',offline:true,model});
  try{
    const body={model,reasoning:{effort:'high'},stream:true,input:[]};
    const response=await fetch(bridge.endpoint+'/responses',{method:'POST',headers:{authorization:'Bearer '+TRANSPORT_DUMMY},body:JSON.stringify(body)});
    assert.equal(await response.text(),envelope);assert.equal(seen.model,model);assert.equal(seen.max_output_tokens,16384);
    assert.equal(read(root+'/wire/REGISTRATION.json').model,model);
    const bad=await fetch(bridge.endpoint+'/responses',{method:'POST',headers:{authorization:'Bearer '+TRANSPORT_DUMMY},body:JSON.stringify({...body,model:'different-model'})});assert.equal(bad.status,400);
  }finally{await bridge.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
});
