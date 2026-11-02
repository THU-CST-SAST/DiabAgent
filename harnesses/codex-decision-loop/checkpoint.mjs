import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const read=f=>JSON.parse(fs.readFileSync(f)),rows=f=>fs.readFileSync(f,'utf8').split('\n').filter(Boolean).map(JSON.parse);
const sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const VERSION='codex-complete-knowledge-prefix/v1';

function inspectSource(source){
 assert.equal(fs.realpathSync(source),source);
 const plan=read(source+'/PLAN.json'),status=read(source+'/STATUS.json'),owner=read(source+'/OWNER.json');
 assert.equal(plan.model.model,'gpt-6.1-sol');assert(status.terminal&&status.steps===0&&status.score===null);
 const consumed_ms=Date.parse(status.finished)-Date.parse(status.started);assert(Number.isFinite(consumed_ms)&&consumed_ms>=0&&consumed_ms<240000);
 let command='';try{command=fs.readFileSync('/proc/'+owner.pid+'/cmdline','utf8');}catch{}
 assert(!command.includes(source+'/control/'),'Original worker must have exited');
 const trial=source+'/trial',session=trial+'/Codex/session-1',stats=read(trial+'/stats.json');
 assert.equal(stats.model_calls,0);assert.equal(stats.env_steps,0);assert.equal(stats.parse_errors,0);
 assert.equal(read(trial+'/bundle.json').metrics.steps,0);assert(read(trial+'/Codex/MODEL.json').closed);
 assert.equal(fs.readdirSync(trial+'/Codex').filter(n=>/^session-/.test(n)).length,1);
 assert.equal(read(session+'/native/LAUNCH.json').identity.version,'codex-cli 0.163.0');assert(fs.existsSync(session+'/native/EXIT.json'));
 const rawFiles=fs.readdirSync(session).filter(n=>/^NATIVE-REPLY-\d+\.json$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
 assert(rawFiles.length>0&&rawFiles.length<7);
 const replies=rawFiles.map(f=>read(session+'/'+f)),stdout=rows(session+'/native/stdout.jsonl'),client=rows(session+'/native/client.jsonl'),results=[];
 for(let i=0;i<replies.length;i++){
  const raw=replies[i];assert.equal(raw.model,'gpt-6.1-sol');assert.equal(raw.status,'completed');assert(raw.id);
  const wire=read(session+'/transport/'+(i+1)+'-RESPONSE.json');assert(wire.complete&&wire.status===200);
  const uses=raw.output.filter(o=>o.type==='function_call');assert.equal(uses.length,1);assert.equal(uses[0].name,'Read','Only fully completed Read prefixes, not act/query/partial states');
  const use=uses[0],event=stdout.find(e=>e.method==='item/tool/call'&&e.params.callId===use.call_id);assert(event);assert.deepEqual(event.params.arguments,JSON.parse(use.arguments));
  const answer=client.find(e=>e.id===event.id&&!e.method);assert(answer?.result?.success);assert.equal(answer.result.contentItems.length,1);assert.equal(answer.result.contentItems[0].type,'inputText');
  results.push([use.call_id,{success:true,text:answer.result.contentItems[0].text}]);
 }
 const next=replies.length+1,rejected=read(session+'/transport/'+next+'-REJECTED.json');
 assert(rejected.reason.startsWith('Native factual history or signed output changed'));
 assert(!fs.existsSync(session+'/transport/'+next+'-UPSTREAM-REQUEST.json'),'Rejected boundary must not have reached upstream');
 assert.equal(fs.readdirSync(session+'/transport').filter(n=>/^\d+-RESPONSE.json$/.test(n)).length,replies.length);
 const ledger=read(session+'/native/NATIVE-KNOWLEDGE-LEDGER.json'),knowledge=read(session+'/native/KNOWLEDGE-REGISTRATION.json');
 assert.equal(ledger.attempts.filter(a=>a.tool==='Read'&&a.allowed).length,replies.length);assert(replies.length<3);
 for(const [file,digest] of Object.entries(knowledge.files))assert.equal(sha(knowledge.skill_root+'/'+file),digest);
 const expected=read(session+'/CONTROLLER-REQUEST-1.json'),body=read(session+'/transport/'+next+'-NATIVE-REQUEST.json');
 // Regenerate only the harness-owned catalog/entry in the new isolated HOME. Every original
 // assistant item and tool result is injected unchanged; no previous model output is redrawn.
 const history=body.input.filter(i=>i.type!=='additional_tools'&&i.role!=='developer'&&!(i.role==='user'&&(i.content?.length===0||i.content?.[0]?.text?.startsWith('<skill>'))));
 for(const raw of replies)for(const item of raw.output){
  const retained=history.find(i=>i.id===item.id);assert(retained,'Original output item missing from native history');
  const normalize=i=>{
   if(i.type==='message')return {type:i.type,role:i.role,content:i.content};
   if(i.type==='function_call')return {type:i.type,id:i.id,call_id:i.call_id,name:i.name,namespace:i.namespace??null,arguments:JSON.parse(i.arguments)};
   const {content,...rest}=i;return content===null||Array.isArray(content)&&content.length===0?rest:i;
  };
  assert.deepEqual(normalize(retained),normalize(item),'Original output blocks or encrypted reasoning changed');
 }
 for(const [id,result]of results){const item=history.find(i=>i.type==='function_call_output'&&i.call_id===id);assert(item);assert.equal(typeof item.output==='string'?item.output:item.output.map(p=>p.text).join(''),result.text);}
 return {session,expected,replies,results,history,ledger,knowledge,remaining_native_turns:7-replies.length,remaining_Reads:3-replies.length,remaining_logical_ms:240000-consumed_ms,steps:0,provider_default_instructions_seen:replies.some(r=>!!r.instructions)};
}

export function registerCodexKnowledgeCheckpoint({source,file}){
 assert(!fs.existsSync(file));const inspected=inspectSource(source),files=[];
 for(const name of ['PLAN.json','STATUS.json','OWNER.json','trial/stats.json','trial/bundle.json','trial/Codex/MODEL.json'])files.push({file:name,sha256:sha(source+'/'+name)});
 function collect(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=dir+'/'+entry.name;if(entry.isDirectory())collect(p);else if(entry.isFile())files.push({file:path.relative(source,p),sha256:sha(p)});}}
 collect(inspected.session+'/transport');
 for(const n of fs.readdirSync(inspected.session).filter(f=>f.endsWith('.json')))files.push({file:path.relative(source,inspected.session+'/'+n),sha256:sha(inspected.session+'/'+n)});
 for(const n of ['LAUNCH.json','EXIT.json','stdout.jsonl','client.jsonl','NATIVE-KNOWLEDGE-LEDGER.json','KNOWLEDGE-REGISTRATION.json'])files.push({file:path.relative(source,inspected.session+'/native/'+n),sha256:sha(inspected.session+'/native/'+n)});
 const proof={completed_native_replies:inspected.replies.length,remaining_native_turns:inspected.remaining_native_turns,remaining_Reads:inspected.remaining_Reads,steps:0,all_controller_calls:0,original_outputs_and_tool_results_preserved:true,provider_default_prompt_compatibility_attempt:true};
 const registration={version:VERSION,source,files,proof};fs.writeFileSync(file,JSON.stringify(registration,null,2),{flag:'wx'});return proof;
}

export function inspectCodexKnowledgeCheckpoint(file,expected=null){
 const registration=read(file);assert.equal(registration.version,VERSION);
 for(const item of registration.files){assert(!path.isAbsolute(item.file)&&!item.file.split('/').includes('..'));assert.equal(sha(registration.source+'/'+item.file),item.sha256);}
 const result=inspectSource(registration.source);assert.equal(result.replies.length,registration.proof.completed_native_replies);assert.equal(result.remaining_native_turns,registration.proof.remaining_native_turns);assert.equal(result.remaining_Reads,registration.proof.remaining_Reads);
 if(expected)assert.deepEqual(result.expected,expected,'Only the exact original controller boundary may resume');
 return {...result,source:registration.source,registration_file:fs.realpathSync(file),registration_sha256:sha(file)};
}
