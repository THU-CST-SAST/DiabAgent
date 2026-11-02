import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRegisteredPrefixModel,inspectRegisteredPrefix,prefixHash,requestFacts} from './registered-prefix.mjs';
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'registered-prefix-')),source=root+'/old',dir=root+'/new';
  fs.mkdirSync(source+'/Code/session-1',{recursive:true});fs.mkdirSync(source+'/Code/session-2');fs.mkdirSync(dir);
  const request={system:'unchanged',messages:[{role:'user',content:'observation'}],tools:[]};
  const raw={model:'claude-opus-5-5',content:[{type:'thinking',thinking:'old',signature:'old-signature'},
    {type:'tool_use',id:'old-use',name:'mcp__experiment__act',input:{action:{type:'WAIT'},note:'fixed fixture'}}],stop_reason:'tool_use',usage:{input_tokens:1,output_tokens:1},
    __code_harness:{version:'native-decision-loop/v1',native_MCP_called:true,call_dir:source+'/Code/session-1',native_turn:1}};
  const calls=[{call:1,sequence:1,started:'2026-10-27T00:00:00Z',finished:'2026-10-27T00:00:01Z',request,response:{raw}},
    {call:2,sequence:2,request,error:{status:502,message:'terminal fixture'}}];
  fs.writeFileSync(source+'/invocations.jsonl',calls.map(JSON.stringify).join('\n')+'\n');
  fs.writeFileSync(source+'/stats.json',JSON.stringify({env_steps:12}));
  const bundle={manifest:{config:{seed:1}},trajectory:[{action:'WAIT'}],evaluator_only:{states:[{truth:123}]}};
  fs.writeFileSync(source+'/bundle.json',JSON.stringify(bundle));
  const {__code_harness,...complete}=raw;fs.writeFileSync(source+'/Code/session-1/COMPLETE-NATIVE-REPLY-1.json',JSON.stringify(complete));
  const proof={source,source_invocations_sha256:sha(source+'/invocations.jsonl'),source_stats_sha256:sha(source+'/stats.json'),
    source_bundle_sha256:sha(source+'/bundle.json'),accepted_calls:1,steps:12,terminal_request_sha256:prefixHash(requestFacts(request)),
    prefix:[{original_call:1,request_sha256:prefixHash(requestFacts(request)),response_sha256:prefixHash(raw)}]};
  let live=0;
  const delegate={complete:async()=>{live++;return {live:true};},close:async()=>{},diagnostics:{}};
  const env={step_count:12,exportBundle:()=>structuredClone(bundle)};
  return {root,source,dir,request,proof,env,delegate,live:()=>live};
}
test('registered accepted replies retain signatures/replay lineage and gate the first new call on exact state',async()=>{
  const f=fixture();try {
    const m=createRegisteredPrefixModel(f),first=await m.complete(f.request);
    assert.equal(f.live(),0);assert.equal(first.provider.content[0].signature,'old-signature');
    assert.equal(first.tool_call.name,'act');assert.equal(first.replay.original_call,1);
    assert.equal(first.replay.registered_prefix_sha256,prefixHash(f.proof));
    assert((await m.complete(f.request)).live);assert.equal(f.live(),1);
    assert(JSON.parse(fs.readFileSync(f.dir+'/RESUME-BOUNDARY.json')).exact_CPU_state);
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});
test('request or reconstructed state mismatch never reaches live delegate',async()=>{
  const f=fixture();try {
    const m=createRegisteredPrefixModel(f);
    await assert.rejects(m.complete({...f.request,system:'changed'}));assert.equal(f.live(),0);
    const m2=createRegisteredPrefixModel(f);await m2.complete(f.request);f.env.step_count=13;
    await assert.rejects(m2.complete(f.request));assert.equal(f.live(),0);
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});
test('unconsumed complete native response prevents redraw and consumed turn allowance is not reset',()=>{
  const f=fixture();try {
    fs.writeFileSync(f.source+'/Code/session-2/COMPLETE-NATIVE-REPLY-1.json',JSON.stringify({content:[{type:'tool_use',name:'mcp__experiment__act',input:{action:{type:'WAIT'}}}],stop_reason:'tool_use'}));
    assert.throws(()=>inspectRegisteredPrefix(f.proof),/Unconsumed complete/);
    const invalid={content:[1,2].map(n=>({type:'tool_use',id:String(n),name:'mcp__experiment__simulate',input:{}})),stop_reason:'tool_use'};
    fs.writeFileSync(f.source+'/Code/session-2/COMPLETE-NATIVE-REPLY-1.json',JSON.stringify(invalid));
    assert.equal(inspectRegisteredPrefix(f.proof).remaining_native_turns,6);
    for(let i=2;i<=7;i++)fs.writeFileSync(f.source+'/Code/session-2/COMPLETE-NATIVE-REPLY-'+i+'.json',JSON.stringify(invalid));
    assert.throws(()=>inspectRegisteredPrefix(f.proof),/allowance exhausted/);
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});
