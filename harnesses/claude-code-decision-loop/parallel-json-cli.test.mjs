import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createDecisionLoopModel} from './model.mjs';
import {PREFIX} from './history.mjs';
const fixtures=JSON.parse(fs.readFileSync(new URL('./CAPTURE-FIXTURES.json',import.meta.url)));
test('official Code JSON parallel batch rejects both MCP calls without waiting for an impossible receipt',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'parallel-json-')),config={model:'claude-opus-5-5',max_tokens:8192,reasoning_effort:'high',strict_tools:true};
  let requests=0,model,failure;const observed=[];
  const server=http.createServer(async(req,res)=>{try{
    const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks));requests++;
    const results=body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='tool_result'&&['parallel_a','parallel_b'].includes(b.tool_use_id));
    observed.push({stream:body.stream,parallel_results:results.map(r=>({id:r.tool_use_id,is_error:r.is_error}))});
    if(results.length) {assert.equal(results.length,2);assert(results.every(r=>r.is_error));}
    assert(requests<=6);
    const raw={id:results.length?'single_msg':'parallel_msg',type:'message',role:'assistant',model:config.model,
      content:[{type:'thinking',thinking:'',signature:'offline_parallel_signature'},...(!results.length?['a','b'].map(id=>({type:'tool_use',id:'parallel_'+id,name:PREFIX+'simulate',input:{action:{type:'WAIT'},hours:1}})):
        [{type:'tool_use',id:'single_act',name:PREFIX+'act',input:{action:{type:'WAIT'},note:'Offline correction only'}}])],
      stop_reason:'tool_use',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(raw));
  }catch(e){failure=e;res.writeHead(400);res.end(JSON.stringify({error:{type:'invalid_request_error',message:e.message}}));}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    model=createDecisionLoopModel({config,root:root+'/Code',key:'offline-dummy-not-a-credential',binary:process.env.CODE_TEST_BINARY,
      offlineEndpoint:'http://127.0.0.1:'+server.address().port,timeoutMs:process.env.CODE_TEST_EXPECT_PARALLEL_DEADLOCK==='1'?5000:20000,maxTurns:7,
      ...(process.env.CODE_TEST_SKILL_ASSETS?{nativeSkillAssetsRoot:process.env.CODE_TEST_SKILL_ASSETS,nativeSkillEntry:'task-command-v1',nativeKnowledgeGuidance:'detailed-reference-v3'}:{})});
    if(process.env.CODE_TEST_EXPECT_PARALLEL_DEADLOCK==='1'){
      await assert.rejects(model.complete(fixtures.cases[0].neutral),e=>e.code==='CODE_NATIVE_DEADLINE');assert(observed.every(r=>r.parallel_results.length===0));
    }else{
      const result=await model.complete(fixtures.cases[0].neutral);if(failure)throw failure;
      assert(observed.some(r=>r.parallel_results.length===2));assert.equal(result.tool_call.name,'act');
      const accepted=JSON.parse(fs.readFileSync(root+'/Code/session-1/ACCEPTED-PROPOSAL-1.json'));
      assert.equal(accepted.native_corrections.length,1);assert.equal(accepted.native_corrections[0].reason,'parallel_tool_calls');
      assert.deepEqual(accepted.native_corrections[0].raw.content.filter(b=>b.type==='tool_use').map(u=>u.id),['parallel_a','parallel_b']);
      assert.equal(accepted.native_corrections[0].raw.content[0].signature,'offline_parallel_signature');
    }
  }finally{await model?.close();server.closeAllConnections();await new Promise(r=>server.close(r));console.error(JSON.stringify({root,observed}));}
});
