import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {modelIdentityMatches,assertRegisteredCodeModel} from './model-identity.mjs';
import {parseInvocations} from './runtime/src/bench/models/invocation-log.mjs';
const read=p=>JSON.parse(fs.readFileSync(p)),rows=p=>fs.readFileSync(p,'utf8').split('\n').filter(Boolean).map(JSON.parse);
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const norm=v=>Array.isArray(v)?v.map(norm):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k,x])=>k!=='cache_control'&&!(k==='caller'&&x?.type==='direct')).map(([k,x])=>[k,norm(x)])):v;
export const RUNTIME_CHECKPOINT='native-runtime-session-checkpoint/v1';

export function deriveRuntimeResumeHistory({runtime,history,destination}){
 const proof=inspectNativeRuntimeCheckpoint(runtime);assert.equal(sha(history),proof.history_sha256);
 assert(history.startsWith(destination+'/')&&history!==runtime.history);
 const raw=Object.keys(runtime.files).filter(f=>/^COMPLETE-NATIVE-REPLY-.*\.json$/.test(f)&&!/-STREAM-JSON-BINDING|-BOUND-NATIVE-JSON/.test(f)).map(f=>read(runtime.session+'/'+f)).find(r=>!r.stop_reason);
 const original=fs.readFileSync(history,'utf8'),lines=original.split('\n'),removed=[];
 const kept=lines.filter((line,index)=>{if(!line)return true;const row=JSON.parse(line);if(row.message?.id!==raw.id)return true;assert.equal(row.type,'assistant');assert(!row.message.content.some(b=>b.type==='tool_use'||b.signature));removed.push({index,line});return false;});
 assert.equal(removed.length,proof.persisted_partial_rows);
 const emitted=rows(runtime.session+'/stdout.jsonl').filter(e=>e.type==='assistant'&&e.message?.id===raw.id).flatMap(e=>e.message.content??[]);
 assert.deepEqual(norm(removed.flatMap(r=>JSON.parse(r.line).message.content)),norm(removed.length?emitted:[]));
 const archive=destination+'/RUNTIME-ORIGINAL-NATIVE-HISTORY.jsonl';fs.writeFileSync(archive,original,{flag:'wx',mode:0o600});
 fs.writeFileSync(history,kept.join('\n'),{mode:0o600});
 const derivation={version:'runtime-abandoned-incomplete-message/v1',source_history:runtime.history,original_history_archive:archive,original_history_sha256:proof.history_sha256,derived_history_sha256:sha(history),unfinished_message_id:raw.id,retained_original_lines:removed,complete_provider_messages_removed:0,additional_native_budget:0,additional_Read_budget:0,exact_response_continuation:false};
 fs.writeFileSync(destination+'/RUNTIME-HISTORY-DERIVATION.json',JSON.stringify(derivation,null,2),{flag:'wx',mode:0o600});return derivation;
}

export function captureNativeRuntimeCheckpoint({sessionDir,expected,remainingLogicalMs,cpu=null,persist=true}){
 assert(Number.isFinite(remainingLogicalMs)&&remainingLogicalMs>0&&remainingLogicalMs<=240000,'Original active logical budget exhausted');
 const session=fs.realpathSync(sessionDir),launch=read(session+'/LAUNCH.json');
 const names=fs.readdirSync(session).filter(n=>/^EXPECTED-CONTROLLER-REQUEST-\d+\.json$/.test(n)).sort((a,b)=>+a.match(/\d+/)[0]-+b.match(/\d+/)[0]);
 assert(names.length);assert.deepEqual(read(session+'/'+names.at(-1)),expected);
 const history=session+'/home/projects/decision-loop/'+launch.argv[launch.argv.indexOf('--resume')+1]+'.jsonl';
 const files=Object.fromEntries(fs.readdirSync(session,{withFileTypes:true}).filter(e=>e.isFile()&&!/^RUNTIME-RECOVERY|^REGISTERED-NATIVE-RETRY/.test(e.name)).map(e=>[e.name,sha(session+'/'+e.name)]));
 const results=fs.existsSync(session+'/results')?Object.fromEntries(fs.readdirSync(session+'/results').filter(n=>n.endsWith('.json')).map(n=>[n,sha(session+'/results/'+n)])):{};
 const runtime={version:RUNTIME_CHECKPOINT,session,files,results,history,history_sha256:sha(history),expected_file:names.at(-1),expected_sha256:sha(session+'/'+names.at(-1)),remaining_logical_ms:remainingLogicalMs,cpu,exact_model_response_continuation:false};
 const registration={runtime};registration.attestation=inspectNativeRuntimeCheckpoint(runtime);
 const file=session+'/RUNTIME-RECOVERY-CHECKPOINT.json';
 if(persist){if(fs.existsSync(file))assert.deepEqual(read(file),registration);else fs.writeFileSync(file,JSON.stringify(registration,null,2),{flag:'wx',mode:0o600});}
 return registration;
}

export function inspectNativeRuntimeCheckpoint(r){
 assert.equal(r.version,RUNTIME_CHECKPOINT);assert.equal(r.exact_model_response_continuation,false);
 const dir=r.session;assert.equal(fs.realpathSync(dir),dir);
 for(const [f,h]of Object.entries(r.files)){assert.equal(path.basename(f),f);assert.equal(sha(dir+'/'+f),h);}
 for(const [f,h]of Object.entries(r.results)){assert.equal(path.basename(f),f);assert.equal(sha(dir+'/results/'+f),h);}
 assert.equal(sha(r.history),r.history_sha256);assert.equal(path.dirname(r.history),dir+'/home/projects/decision-loop');
 assert.equal(sha(dir+'/'+r.expected_file),r.expected_sha256);
 const s=read(dir+'/SESSION.json'),launch=read(dir+'/LAUNCH.json'),expected=read(dir+'/'+r.expected_file),events=rows(dir+'/stdout.jsonl'),history=rows(r.history);
 assert(s.exit!==null&&s.exit!==undefined);assert(!/quota|balance|credit|forbidden|unauthori[sz]ed|permission/i.test(s.error??''));
 assert.equal(sha(launch.binary),'24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de');assert.equal(launch.max_native_retries,0);
 assertRegisteredCodeModel(expected.model);assert.equal(launch.argv[launch.argv.indexOf('--model')+1],expected.model);
 assert.equal(launch.argv.filter(v=>v==='--model').length,1);
 const native=Object.keys(r.files).filter(f=>/^COMPLETE-NATIVE-REPLY-.*\.json$/.test(f)&&!/-STREAM-JSON-BINDING|-BOUND-NATIVE-JSON/.test(f)).map(f=>read(dir+'/'+f));
 assert(native.length>0);assert.equal(new Set(native.map(v=>v.id)).size,native.length);
 for(const raw of native){assert(raw.id&&raw.role==='assistant'&&raw.type==='message'&&modelIdentityMatches(expected.model,raw.model));}
 const observed=new Set(events.flatMap(e=>e.type==='stream_event'&&e.event?.type==='message_start'&&modelIdentityMatches(expected.model,e.event.message?.model)?[e.event.message.id]:e.type==='assistant'&&modelIdentityMatches(expected.model,e.message?.model)?[e.message.id]:[]));
 assert.deepEqual([...observed].sort(),native.map(v=>v.id).sort(),'Every actual native attempt must remain accounted for');
 const incomplete=native.filter(v=>!v.stop_reason);assert.equal(incomplete.length,1);
 const raw=incomplete[0];assert(raw.content.length>0);
 assert(raw.content.every(b=>b.type==='thinking'&&!b.signature||b.type==='text'||b.type==='tool_use'&&b.input?.__unparsedToolInput),'A complete/signed ambiguous reply is not an unfinished retry');
 const toolIds=raw.content.filter(b=>b.type==='tool_use').map(b=>{const v=b.input.__unparsedToolInput;assert(typeof v.raw==='string'&&v.len===v.raw.length);assert.throws(()=>JSON.parse(v.raw));return b.id;});
 const chunks=events.filter(e=>e.type==='assistant'&&e.message?.id===raw.id).flatMap(e=>e.message.content??[]);
 // SDK chunks may include the same invalid-JSON tool fragment; it is not an executed tool.
 assert(chunks.length<=raw.content.length);assert.deepEqual(norm(chunks),norm(raw.content.slice(0,chunks.length)));
 const persisted=history.filter(e=>e.message?.id===raw.id);assert(persisted.every(e=>e.type==='assistant'&&e.message.role==='assistant'));
 assert.deepEqual(norm(persisted.flatMap(e=>e.message.content??[])),norm(persisted.length?chunks:[]),'Retain persisted partial thinking/text verbatim, never remove it');
 assert(!history.some(e=>Array.isArray(e.message?.content)&&e.message.content.some(b=>toolIds.includes(b.id)||toolIds.includes(b.tool_use_id))));
 const receiptFile=dir+'/MCP-CALLS.jsonl',receipts=fs.existsSync(receiptFile)?rows(receiptFile):[];
 assert.deepEqual(receipts,s.native_MCP_receipts);assert(!receipts.some(q=>toolIds.includes(q._meta?.['claudecode/toolUseId'])));
 const results=history.filter(e=>e.type==='user'&&Array.isArray(e.message?.content)).flatMap(e=>e.message.content.filter(b=>b.type==='tool_result'));
 for(const complete of native.filter(v=>v.stop_reason)){
  const actual=history.filter(e=>e.type==='assistant'&&e.message?.id===complete.id).flatMap(e=>e.message.content??[]);assert.deepEqual(norm(actual),norm(complete.content));
  for(const b of complete.content.filter(b=>b.type==='tool_use'))assert.equal(results.filter(x=>x.tool_use_id===b.id).length,1);
 }
 for(const q of receipts){const result=results.find(b=>b.tool_use_id===q._meta?.['claudecode/toolUseId']);assert(result);const original=read(dir+'/results/'+q.rpc_id+'.json');const text=typeof result.content==='string'?result.content:result.content.map(b=>{assert.equal(b.type,'text');return b.text;}).join('');assert.equal(text,original.text);assert.equal(!!result.is_error,!!original.is_error);assert(q.name!=='act'||original.is_error===true);}
 const ledger=read(dir+'/NATIVE-KNOWLEDGE-LEDGER.json');assert.deepEqual(ledger,s.native_knowledge_ledger);
 const reads=ledger.attempts.filter(a=>a.tool==='Read'&&a.allowed).length,limit=launch.max_native_model_turns;assert(Number.isInteger(limit)&&limit>0&&limit<=7);assert(reads<=3);
 let reserved=0;
 for(const archive of r.empty_startup_archives??[]){
  const source=archive.source;assert.equal(fs.realpathSync(source),source);assert.notEqual(source,r.cpu.source);assert.equal(path.basename(path.dirname(source)),'trials');
  const planFile=path.resolve(source,'../..')+'/PLAN.json';assert.equal(sha(planFile),archive.plan_sha256);const plan=read(planFile),task=plan.tasks.find(t=>t.task_id===r.cpu.id);assert(task);
  for(const [f,h]of Object.entries(archive.files)){assert.equal(path.basename(f),f);assert.equal(sha(source+'/'+f),h);}
  const previous=task.registered_prefix.native_history_checkpoint.runtime;assert(!previous.empty_startup_archives);const base={...r};delete base.empty_startup_archives;base.remaining_logical_ms=previous.remaining_logical_ms;assert.deepEqual(base,previous);
  const old=parseInvocations(fs.readFileSync(r.cpu.source+'/invocations.jsonl','utf8'),{strict:true}).slice(0,-1),calls=parseInvocations(fs.readFileSync(source+'/invocations.jsonl','utf8'),{strict:true});assert.equal(calls.length,old.length+1);
  for(let i=0;i<old.length;i++){assert.deepEqual(calls[i].request,old[i].request);assert.deepEqual(calls[i].response.raw,old[i].response.raw);assert.deepEqual(calls[i].error??null,old[i].error??null);const replay=calls[i].response.replay??calls[i].replay;assert(replay?.no_new_api_call);assert.equal(replay.source_sha256,task.registered_prefix.source_invocations_sha256);}
  const last=calls.at(-1);assert(last.error&&!last.response);assert.equal(last.error.message,'Code exited without complete resumed proposal');const spent=Date.parse(last.finished)-Date.parse(last.started);assert.equal(spent,archive.logical_spent_ms);assert(spent>0);
  const bundle=read(source+'/bundle.json'),original=read(r.cpu.source+'/bundle.json');for(const k of ['trajectory','evaluator_only','metrics'])assert.deepEqual(bundle[k],original[k]);assert.equal(read(source+'/stats.json').env_steps,r.cpu.steps);
  const session=source+'/Code/session-1';assert.equal(archive.session,session);assert.deepEqual(fs.readdirSync(source+'/Code').filter(n=>/^session-\d+$/.test(n)),['session-1']);
  for(const [f,h]of Object.entries(archive.session_files)){assert.equal(path.basename(f),f);assert.equal(sha(session+'/'+f),h);}assert.equal(fs.readFileSync(session+'/stdout.jsonl','utf8').trim(),'');assert.equal(read(session+'/SESSION.json').exit.code,0);
  assert(!fs.readdirSync(session).some(f=>/^COMPLETE-NATIVE-REPLY|^ACCEPTED-PROPOSAL/.test(f)));assert.deepEqual(read(session+'/NATIVE-KNOWLEDGE-LEDGER.json').attempts,ledger.attempts);
  assert.equal(r.remaining_logical_ms,previous.remaining_logical_ms-spent);reserved++;assert.equal(archive.conservative_native_debit,1);
 }
 const remaining=limit-native.length-reserved;assert(remaining>0,'Native attempt budget exhausted');assert(r.remaining_logical_ms>0&&r.remaining_logical_ms<=240000);
 return {version:RUNTIME_CHECKPOINT,source:path.dirname(path.dirname(dir)),source_session:dir,history:r.history,history_sha256:r.history_sha256,source_session_sha256:r.files['SESSION.json'],source_invocations_sha256:r.cpu?.source_invocations_sha256??null,source_bundle_sha256:r.cpu?.source_bundle_sha256??null,steps:r.cpu?.steps??null,consumed_native_turns:native.length+reserved,remaining_native_turns:remaining,inherited_allowed_Reads:reads,remaining_allowed_Reads:3-reads,remaining_Reads:3-reads,remaining_logical_ms:r.remaining_logical_ms,completed_native_replies:native.length-1,unfinished_attempts:1+reserved,persisted_partial_rows: persisted.length,original_tool_results_present:true,source_MCP_receipts:receipts.length,source_error_status:502,no_observed_partial_output:false,human_authorized_unfinished_retry:true,exact_model_response_continuation:false,actual_upstream_API_calls:0};
}
