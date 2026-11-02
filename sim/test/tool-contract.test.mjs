import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {compileToolContract,enforceToolContract,strictToolSchema} from '../src/bench/models/tool-contract.mjs';
import {createAnthropicModel} from '../src/bench/models/anthropic.mjs';
import {createOpenAICompatibleModel} from '../src/bench/models/openai-compatible.mjs';
import {completeWithRetry} from '../src/bench/models/index.mjs';
import {classifyError,TRANSIENT_REASONS} from '../src/benchmark/failures.mjs';
import {toolSchema,simulateToolSchema} from '../src/bench/prompt.mjs';
import {glucoseHistoryTool} from '../src/bench/glucose-history.mjs';
import {KNOWLEDGE} from '../src/knowledge.mjs';
import {buildInstanceConfig} from '../src/sim/instance.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';
import {probeModel} from '../src/benchmark/preflight.mjs';

const schema={type:'object',properties:{action:{oneOf:[
  {type:'object',properties:{type:{type:'string',const:'WAIT'}},required:['type'],additionalProperties:false},
  {type:'object',properties:{type:{type:'string',const:'BOLUS'},units:{type:'number',minimum:.1,maximum:4}},required:['type','units'],additionalProperties:false},
]},wait_minutes:{type:'integer',minimum:5,maximum:240},note:{type:'string',maxLength:500},note_to_self:{type:'string'}},
required:['action','wait_minutes','note'],additionalProperties:false};
const tool={name:'act',description:'one action',input_schema:schema};
const input={action:{type:'WAIT'},wait_minutes:60,note:'hold'};
const request={system:'S',messages:[{role:'user',content:'decide'}],tools:[tool]};
process.env.BENCH_CONTRACT_TEST_KEY='local-fixture-only';
const response=input=>({id:'test',model:'claude-fable-5-1',stop_reason:'tool_use',
  content:[{type:'tool_use',id:'call1',name:'act',input}],usage:{input_tokens:10,output_tokens:10}});

async function mock(t) {
  const state={requests:[],headers:[],response:response(input),status:200};
  const server=http.createServer(async(req,res)=>{
    let text='';for await(const part of req)text+=part;
    state.requests.push(JSON.parse(text));state.headers.push(req.headers);
    res.writeHead(state.status,{'content-type':'application/json'});res.end(JSON.stringify(typeof state.response==='function'?state.response(state.requests.at(-1)):state.response));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return {...state,get requests(){return state.requests;},get headers(){return state.headers;},set response(value){state.response=value;},set status(value){state.status=value;},url:`http://127.0.0.1:${server.address().port}`};
}

test('strict grammar excludes empty/wrong-layer/string actions; optional OpenAI transport nulls or omissions are equivalent',()=>{
  for(const provider of ['anthropic','openai']) {
    const contract=compileToolContract(tool,provider),valid={...input,...(provider==='openai'?{note_to_self:null}:{})};
    assert.deepEqual(contract.parse(valid),input);
    assert.deepEqual(contract.parse(input),input);
    for(const bad of [{},{...valid,action:{}},{...valid,action:'WAIT'},{...valid,action:{type:'WAIT',note:'wrong layer'}},
      {...valid,action:{type:'BOLUS',units:9}},{...valid,wait_minutes:0}])assert.throws(()=>contract.parse(bad));
  }
  assert.deepEqual(schema.properties.action.oneOf[0].required,['type']);
  assert.throws(()=>strictToolSchema({oneOf:[{type:'string'},{type:'number'}]},'anthropic'),/distinct/);
});

test('optional transport omissions preserve valid original actions and disclose wire nonconformance',()=>{
  const valid=enforceToolContract({tool_call:{name:'act',input}},[tool],'openai');
  assert.deepEqual(valid.tool_call.input,input);
  assert.deepEqual(valid.contract_validation,{wire_conformant:false,compatibility:'omitted_optional_fields'});
  assert.throws(()=>enforceToolContract({tool_call:{name:'act',input:{action:{type:'BOLUS',units:1},note:'No timing'}}},[tool],'openai'),e=>e.code==='TOOL_CONTRACT');
  assert.deepEqual(input,{action:{type:'WAIT'},wait_minutes:60,note:'hold'});
});

test('real device action, simulate and glucose history schemas compile without widening action unions',()=>{
  for(const id of ['adult_dana_g6','child_dash_g7','older_mdi_smbg']) {
    const env=new SimEnv(buildInstanceConfig({...KNOWLEDGE.instances[id].spec,seed:3}));
    const obs=env.observe();
    for(const t of [toolSchema(obs,{notes:true}),simulateToolSchema(obs),glucoseHistoryTool])for(const provider of ['anthropic','openai']) {
      const contract=compileToolContract(t,provider);
      assert.equal(contract.schema.additionalProperties,false);
      assert.ok(!JSON.stringify(contract.schema).includes('"oneOf"'));
    }
  }
});

test('Anthropic sends only native strict grammar, avoids duplicate action output grammar; thinking stays adaptive/low',async t=>{
  const srv=await mock(t);
  const model=createAnthropicModel({base_url:srv.url,api_key_env:'BENCH_CONTRACT_TEST_KEY',model:'claude-fable-5-1',strict_tools:true,
    thinking:{type:'adaptive'},reasoning_effort:'low'});
  assert.deepEqual((await model.complete(request)).tool_call.input,input);
  const body=srv.requests[0];
  assert.equal(body.tools[0].strict,true);
  assert.equal(body.tools[0].input_schema.properties.wait_minutes.minimum,undefined);
  assert.match(body.tools[0].input_schema.properties.wait_minutes.description,/minimum=5/);
  assert.deepEqual(body.tool_choice,{type:'auto',disable_parallel_tool_use:true});
  assert.equal(body.output_config.effort,'low');assert.equal(body.output_config.format,undefined);
  srv.response={id:'text',stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(input)}]};
  await assert.rejects(model.complete(request),e=>e.code==='TOOL_CONTRACT');
});

test('a relay ignoring strict mode fails once, keeps raw evidence and never fabricates an action',async t=>{
  const srv=await mock(t);srv.response=response({});
  const model=createAnthropicModel({base_url:srv.url,api_key_env:'BENCH_CONTRACT_TEST_KEY',strict_tools:true});
  await assert.rejects(completeWithRetry(model,request,{tries:4,sleepFn:()=>assert.fail('must not retry a contract violation')}),e=>{
    assert.equal(e.code,'TOOL_CONTRACT');assert.equal(e.retryable,false);assert.equal(e.response_raw.content[0].input.action,undefined);
    assert.equal(classifyError(e),'tool_contract');assert.equal(TRANSIENT_REASONS.has(classifyError(e)),false);return true;
  });
  assert.equal(srv.requests.length,1);
  srv.response={id:'text',stop_reason:'end_turn',content:[{type:'text',text:'Please wait.'}]};
  await assert.rejects(model.complete(request),e=>e.code==='TOOL_CONTRACT');
  srv.response={...response(input),stop_reason:'max_tokens'};
  await assert.rejects(model.complete(request),e=>e.code==='TOOL_CONTRACT');
});

test('Claude keeps act strict while the read-only simulate grammar is non-strict and still locally validated',async t=>{
  const srv=await mock(t);
  const config={base_url:srv.url,api_key_env:'BENCH_CONTRACT_TEST_KEY',strict_tools:true,
    strict_tool_names:['act','read_glucose_history'],thinking:{type:'adaptive'},reasoning_effort:'low'};
  const sim={name:'simulate',description:'read only',input_schema:schema};
  const model=createAnthropicModel(config);
  await model.complete({...request,tools:[tool,sim,glucoseHistoryTool]});
  assert.deepEqual(srv.requests[0].tools.map(t=>[t.name,t.strict]),[['act',true],['simulate',false],['read_glucose_history',true]]);
  srv.response={...response(input),content:[{type:'tool_use',id:'sim',name:'simulate',input:{}}]};
  await assert.rejects(model.complete({...request,tools:[tool,sim]}),e=>e.code==='TOOL_CONTRACT'&&!e.repair_result);
  assert.throws(()=>createAnthropicModel({...config,strict_tool_names:['simulate']}),/must retain act/);
});

test('OpenAI Responses and Chat send explicit strict and nullable optional fields, prohibit parallel calls',async t=>{
  const srv=await mock(t);
  for(const wire_api of ['responses','chat']) {
    const wireInput={...input,note_to_self:null};
    srv.response=wire_api==='responses'?{status:'completed',output:[{type:'function_call',name:'act',call_id:'c',arguments:JSON.stringify(wireInput)}]}
      :{choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'c',type:'function',function:{name:'act',arguments:JSON.stringify(wireInput)}}]}}]};
    const model=createOpenAICompatibleModel({base_url:srv.url,model:'test',api_key_env:null,wire_api,strict_tools:true});
    assert.deepEqual((await model.complete(request)).tool_call.input,input);
    const body=srv.requests.at(-1),sent=wire_api==='responses'?body.tools[0]:body.tools[0].function;
    assert.equal(sent.strict,true);assert.equal(body.parallel_tool_calls,false);
    assert.deepEqual(sent.parameters.required,Object.keys(schema.properties));
  }
});

test('strict mode rejects parallel calls, unknown tools, malformed exact JSON and extra_body weakening',async t=>{
  assert.throws(()=>enforceToolContract({tool_call:{name:'act',input},raw:{}},[tool],'anthropic',{calls:2}),e=>e.code==='TOOL_CONTRACT');
  assert.throws(()=>enforceToolContract({tool_call:{name:'other',input}},[tool],'anthropic'),e=>e.code==='TOOL_CONTRACT');
  const srv=await mock(t);
  srv.response={status:'completed',output:[{type:'function_call',name:'act',arguments:'```json\n'+JSON.stringify(input)+'\n```'}]};
  const config={base_url:srv.url,model:'test',api_key_env:null,wire_api:'responses',strict_tools:true};
  await assert.rejects(createOpenAICompatibleModel(config).complete(request),e=>e.code==='TOOL_CONTRACT');
  const n=srv.requests.length;
  await assert.rejects(createOpenAICompatibleModel({...config,extra_body:{tools:[]}}).complete(request),e=>e.code==='TOOL_CONTRACT');
  assert.equal(srv.requests.length,n);
});

test('an endpoint rejecting strict requests cannot silently fall back to unconstrained calls',async t=>{
  const srv=await mock(t);srv.status=400;srv.response={error:{message:'strict schemas unsupported'}};
  const models=[createAnthropicModel({base_url:srv.url,api_key_env:'BENCH_CONTRACT_TEST_KEY',strict_tools:true}),
    createOpenAICompatibleModel({base_url:srv.url,model:'test',api_key_env:null,wire_api:'responses',strict_tools:true})];
  for(const model of models)await assert.rejects(completeWithRetry(model,request,{tries:3,sleepFn:()=>assert.fail('no fallback/retry')}),e=>e.code==='TOOL_CONTRACT');
  assert.equal(srv.requests.length,2);
});

test('explicit bounded repair preserves truncated Responses usage but never exposes its partial action',async t=>{
  const srv=await mock(t);
  srv.response={status:'incomplete',incomplete_details:{reason:'max_output_tokens'},
    output:[{type:'function_call',name:'act',arguments:'{"action":{"type":"BOLUS","units":'}],usage:{input_tokens:12,output_tokens:8192}};
  const config={base_url:srv.url,model:'test',api_key_env:null,wire_api:'responses',strict_tools:true,tool_contract_repair:true};
  await assert.rejects(createOpenAICompatibleModel(config).complete(request),e=>{
    assert.equal(e.repair_result.tool_call,null);assert.equal(e.repair_result.text,'');
    assert.equal(e.repair_result.usage.output_tokens,8192);assert.equal(e.response_raw.status,'incomplete');return true;
  });
  await assert.rejects(createOpenAICompatibleModel({...config,tool_contract_repair:false}).complete(request),e=>!e.repair_result);
  srv.response={status:'failed',error:{message:'refused'},output:[]};
  await assert.rejects(createOpenAICompatibleModel(config).complete(request),e=>!e.repair_result);
});

test('Claude bounded repair names overlong memory fields; an invalid hypothetical request is returned as a tool error',async t=>{
  const srv=await mock(t);
  const model=createAnthropicModel({base_url:srv.url,api_key_env:'BENCH_CONTRACT_TEST_KEY',strict_tools:true,
    strict_tool_names:['act'],tool_contract_repair:true,thinking:{type:'adaptive'}});
  const small={...tool,input_schema:{...schema,properties:{...schema.properties,note_to_self:{type:'string',maxLength:5}}}};
  srv.response=response({...input,note_to_self:'too long'});
  await assert.rejects(model.complete({...request,tools:[small]}),e=>/note_to_self/.test(e.message)&&/5/.test(e.message)&&!!e.repair_result);
  srv.response={...response(input),content:[{type:'tool_use',id:'bad-sim',name:'simulate',input:{}}]};
  const r=await model.complete({...request,tools:[small,{...small,name:'simulate'}]});
  assert.equal(r.tool_call.name,'simulate');assert.match(r.tool_validation_error,/Missing required/);
  srv.response={...response(input),stop_reason:'max_tokens'};
  await assert.rejects(model.complete({...request,tools:[small]}),e=>e.repair_result?.tool_call===null);
});

test('Responses read-only contract errors are returned to the controller without editing treatment parameters',async t=>{
  const srv=await mock(t),config={base_url:srv.url,model:'test',api_key_env:null,wire_api:'responses',strict_tools:true,tool_contract_repair:true};
  const hypothetical={...tool,name:'simulate'},invalid={...input,action:{type:'WAIT',units:2}};
  const raw={status:'completed',output:[{type:'function_call',name:'simulate',call_id:'bad-helper',arguments:JSON.stringify(invalid)}],usage:{input_tokens:10,output_tokens:5}};
  srv.response=raw;
  const r=await createOpenAICompatibleModel(config).complete({...request,tools:[tool,hypothetical]});
  assert.match(r.tool_validation_error,/action.units/);assert.deepEqual(r.tool_call.input,invalid);
  await assert.rejects(createOpenAICompatibleModel({...config,tool_contract_repair:false}).complete({...request,tools:[tool,hypothetical]}),e=>e.code==='TOOL_CONTRACT');
  await assert.rejects(createOpenAICompatibleModel(config).complete(request),e=>e.code==='TOOL_CONTRACT'&&!e.repair_result);
  srv.response={...raw,output:[...raw.output,...raw.output]};
  await assert.rejects(createOpenAICompatibleModel(config).complete({...request,tools:[tool,hypothetical]}),e=>e.code==='TOOL_CONTRACT');
  srv.response={...raw,output:[{...raw.output[0],name:'act'}]};
  await assert.rejects(createOpenAICompatibleModel(config).complete(request),e=>e.code==='TOOL_CONTRACT'&&!!e.repair_result);
});

test('strict preflight exercises three real tool schemas, preserves links, and stops on first breach',async t=>{
  const srv=await mock(t),dir=fs.mkdtempSync(path.join(os.tmpdir(),'strict-preflight-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  srv.response=body=>{
    const name=['read_glucose_history','simulate','act'][srv.requests.length-1];
    const args=name==='act'?input:name==='simulate'?{action:{type:'WAIT'}}:{};
    return {...response(args),content:[{type:'tool_use',id:'call-'+srv.requests.length,name,input:args}]};
  };
  const config={name:'fixture',model:'claude-fable-5-1',adapter:'anthropic',base_url:srv.url,
    api_key_env:'BENCH_CONTRACT_TEST_KEY',strict_tools:true,thinking:{type:'adaptive'},reasoning_effort:'low'};
  const result=await probeModel({modelConfig:config,outDir:path.join(dir,'pass')});
  assert.equal(result.ok,true);assert.equal(result.contract_probe.requests,3);
  assert.deepEqual(result.contract_probe.steps.map(s=>s.stage),['read_glucose_history','simulate','act']);
  assert.equal(srv.requests[1].messages[2].content[0].tool_use_id,'call-1');
  assert.equal(result.usage.input_tokens,30);
  srv.response=response({});
  const failed=await probeModel({modelConfig:config,outDir:path.join(dir,'fail')});
  assert.equal(failed.ok,false);assert.equal(srv.requests.length,4);
  const trace=fs.readFileSync(path.join(dir,'fail','invocations.jsonl'),'utf8');
  assert.match(trace,/TOOL_CONTRACT/);assert.match(trace,/"event":"error"/);
  const errorEvent=trace.trim().split('\n').map(JSON.parse).find(e=>e.event==='error');
  assert.ok(errorEvent.response?.content,'raw invalid provider reply survives event logging');
  assert.ok(!trace.includes(process.env.BENCH_CONTRACT_TEST_KEY));
});

test('strict configs preserve every original experiment setting except name and explicit protocol switch',()=>{
  for(const prefix of ['gpt61-sol','glm53','claude-fable51']) {
    const load=suffix=>JSON.parse(fs.readFileSync(new URL(`../bench/models/${prefix}-memory-alerts-low${suffix}.json`,import.meta.url)));
    const old=load(''),next=load('-strict');
    assert.equal(next.strict_tools,true);assert.equal(old.strict_tools,undefined);
    delete old.name;delete next.name;delete next.strict_tools;
    assert.deepEqual(next,old);
  }
});

test('Responses strict preflight uses the same required multi-tool selection as the controller',async t=>{
  const srv=await mock(t),dir=fs.mkdtempSync(path.join(os.tmpdir(),'strict-preflight-responses-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  srv.response=body=>{
    assert.equal(body.tool_choice,'required');
    const name=['read_glucose_history','simulate','act'][srv.requests.length-1];
    const args=name==='act'?{...input,wake_on:null,note_to_self:null}:name==='simulate'?{action:{type:'WAIT'},hours:null,extra_carbs_g:null}
      :{start_time:null,end_time:null,source:null,offset:null,limit:null};
    return {model:'test',status:'completed',output:[{type:'function_call',call_id:'c'+srv.requests.length,name,arguments:JSON.stringify(args)}]};
  };
  const result=await probeModel({modelConfig:{model:'test',adapter:'openai-compatible',wire_api:'responses',base_url:srv.url,api_key_env:null,strict_tools:true},outDir:path.join(dir,'pass')});
  assert.equal(result.ok,true);assert.equal(result.contract_probe.requests,3);
});

test('existing thinking block-binding configuration sends its mandatory header without rewriting history',async t=>{
  const srv=await mock(t),thinking={type:'adaptive',block_binding:{prefix_mismatch_behavior:'drop_block'}};
  const model=createAnthropicModel({base_url:srv.url,model:'test',api_key_env:'BENCH_CONTRACT_TEST_KEY',thinking});
  const content=[{type:'thinking',thinking:'',signature:'opaque-fixture'},{type:'tool_use',id:'prior',name:'act',input}];
  const messages=[{role:'assistant',provider:{adapter:'anthropic',content}},{role:'user',tool_result_for:'prior',content:'unchanged result'}];
  await model.complete({...request,messages});
  assert.equal(srv.headers[0]['anthropic-beta'],'thinking-binding-controls-2026-08-01');
  assert.deepEqual(srv.requests[0].thinking,thinking);assert.deepEqual(srv.requests[0].messages[0].content,content);
  assert.equal(srv.requests[0].messages[1].content[0].content,'unchanged result');
});

test('preflight distinguishes unavailable effort metadata and supports an explicit echo gate',async t=>{
  const srv=await mock(t),dir=fs.mkdtempSync(path.join(os.tmpdir(),'effort-preflight-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let echo=null;
  srv.response=()=>{
    const name=['read_glucose_history','simulate','act'][(srv.requests.length-1)%3];
    const args=name==='act'?input:name==='simulate'?{action:{type:'WAIT'}}:{};
    return {...response(args),content:[{type:'tool_use',id:'call-'+srv.requests.length,name,input:args}],
      ...(echo?{reasoning:{effort:echo}}:{})};
  };
  const modelConfig={model:'claude-fable-5-1',adapter:'anthropic',base_url:srv.url,api_key_env:'BENCH_CONTRACT_TEST_KEY',
    strict_tools:true,thinking:{type:'adaptive'},reasoning_effort:'high'};
  const connectivity=await probeModel({modelConfig,outDir:path.join(dir,'connectivity')});
  assert.equal(connectivity.ok,true);assert.equal(connectivity.effort_verified,false);
  assert.equal(connectivity.effort_verification.status,'not_returned');
  const missing=await probeModel({modelConfig,outDir:path.join(dir,'missing'),requireEffortEcho:true});
  assert.equal(missing.ok,false);assert.equal(missing.contract_probe.requests,3);
  echo='low';
  const mismatch=await probeModel({modelConfig,outDir:path.join(dir,'mismatch'),requireEffortEcho:true});
  assert.equal(mismatch.ok,false);assert.equal(mismatch.effort_verification.status,'mismatch');
  echo='high';
  const matching=await probeModel({modelConfig,outDir:path.join(dir,'matching'),requireEffortEcho:true});
  assert.equal(matching.ok,true);assert.equal(matching.effort_verification.status,'verified_echo');
  assert.ok(srv.requests.every(r=>r.output_config.effort==='high'));
  const configFile=path.join(dir,'model.json');fs.writeFileSync(configFile,JSON.stringify(modelConfig));
  const script=new URL('../scripts/preflight-model.mjs',import.meta.url).pathname;
  const cli=await promisify(execFile)(process.execPath,[script,'--model',configFile,'--out',path.join(dir,'cli'),'--require-effort-echo']);
  assert.equal(JSON.parse(cli.stdout).require_effort_echo,true);
  echo=null;
  await assert.rejects(promisify(execFile)(process.execPath,[script,'--model',configFile,'--out',path.join(dir,'cli-missing'),'--require-effort-echo']),e=>{
    assert.equal(e.code,1);assert.equal(JSON.parse(e.stdout).effort_verification.status,'not_returned');return true;
  });
});
