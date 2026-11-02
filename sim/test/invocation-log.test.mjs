import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseInvocations,readInvocations,iterateInvocations} from '../src/bench/models/invocation-log.mjs';
import {traceModel} from '../src/bench/models/trace.mjs';

const request={system:'public prompt',messages:[],tools:[]};
const raw={id:'answer',model:'fixture',status:'completed',reasoning:{effort:'low'},usage:{input_tokens:3}};
const replay={original_call:4,no_new_api_call:true};
const events=[{event:'request',sequence:1,model:'fixture',reasoning_effort:'low',request},
  {event:'response',sequence:1,response:raw,replay,contract_validation:{valid:false}},
  {event:'request',sequence:2,request},
  {event:'error',sequence:2,error:{message:'invalid field',code:'TOOL_CONTRACT'},response:raw,replay},
  {event:'request',sequence:3,request}];
const jsonl=rows=>rows.map(JSON.stringify).join('\n')+'\n';

test('event logs preserve identity, repair metadata and pending calls; legacy logs remain readable',()=>{
  const calls=parseInvocations(jsonl(events));
  assert.equal(calls.length,3);
  assert.equal(calls[0].request.model,'fixture');
  assert.deepEqual(calls[0].response.raw,raw);
  assert.deepEqual(calls[0].response.replay,replay);
  assert.deepEqual(calls[0].response.contract_validation,{valid:false});
  assert.equal(calls[1].error.code,'TOOL_CONTRACT');
  assert.deepEqual(calls[1].response.raw,raw);
  assert.deepEqual(calls[1].replay,replay);
  assert.equal(calls[2].response,undefined);
  const legacy={call:1,request,response:{raw,replay},error:{code:'TOOL_CONTRACT'}};
  assert.deepEqual(parseInvocations(jsonl([legacy]))[0],{...legacy,sequence:1});
});

test('torn lines are tolerated for display but fail closed for recovery',()=>{
  const text=jsonl(events)+'{"event":';
  assert.equal(parseInvocations(text).length,3);
  assert.throws(()=>parseInvocations(text,{strict:true}),/Invalid invocation JSON/);
  assert.throws(()=>parseInvocations(jsonl([events[1]]),{strict:true}),/missing its request/);
});

test('streaming and synchronous audits produce the same completed and pending calls',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trace-events-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'invocations.jsonl');fs.writeFileSync(file,jsonl(events));
  const calls=[];for await(const call of iterateInvocations(file))calls.push(call);
  assert.deepEqual(calls,readInvocations(file));
});

test('writer uses main events, persists request before awaiting, and retains error/replay provenance',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trace-writer-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'invocations.jsonl');let fail=false;
  const model=traceModel({config:{model:'fixture',reasoning_effort:'low',api_key:'never-log-this'},async complete(){
    const current=readInvocations(file).at(-1);
    assert.deepEqual(current.request.tools,request.tools);assert.equal(current.response,undefined);
    if(fail)throw Object.assign(Error('invalid field'),{code:'TOOL_CONTRACT',response_raw:raw,repair_result:{replay}});
    return {raw,replay,contract_validation:{valid:false}};
  }},dir);
  await model.complete(request);fail=true;await assert.rejects(model.complete(request),/invalid field/);
  const entries=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(entries.map(x=>x.event),['request','response','request','error']);
  const calls=readInvocations(file);assert.equal(calls.length,2);
  assert.deepEqual(calls[0].response.replay,replay);assert.equal(calls[0].response.contract_validation.valid,false);
  assert.equal(calls[1].error.code,'TOOL_CONTRACT');assert.deepEqual(calls[1].response.raw,raw);assert.deepEqual(calls[1].replay,replay);
  assert.ok(!fs.readFileSync(file,'utf8').includes('never-log-this'));
});
