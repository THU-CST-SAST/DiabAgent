import fs from 'node:fs';
import {inspectNativeRuntimeCheckpoint,deriveRuntimeResumeHistory} from './native-runtime-recovery.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseInvocations} from './runtime/src/bench/models/invocation-log.mjs';
import {nativeTerminalFailure} from './native-failure.mjs';
import {verifyNativeSkillEdition} from './native-skill.mjs';
import {inspectEmptyGatewayFailure} from './gateway-wait.mjs';
import {inspectIncompleteNativeHistory,prepareIncompleteNativeHistory} from './native-incomplete-history.mjs';
import {assertRegisteredCodeModel,modelIdentityMatches} from './model-identity.mjs';

export const HISTORY_CHECKPOINT_VERSION='registered-native-history-checkpoint/v1';
export const SEGMENT_CHECKPOINT_VERSION='registered-native-segment-checkpoint/v1';
const read=p=>JSON.parse(fs.readFileSync(p)),sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const lines=p=>fs.readFileSync(p,'utf8').split('\n').filter(Boolean).map(JSON.parse);
const text=x=>typeof x==='string'?x:Array.isArray(x)&&x.every(b=>b.type==='text')?x.map(b=>b.text).join(''):null;
const normalized=x=>Array.isArray(x)?x.map(normalized):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).filter(([k,v])=>k!=='cache_control'&&!(k==='caller'&&v?.type==='direct')).map(([k,v])=>[k,normalized(v)])):x;

export function inspectRegisteredNativeCheckpoint(registration,ancestors=[]){
 if(registration.runtime){assert(!registration.incomplete&&!registration.segment&&!registration.observation&&!registration.cpu);return inspectNativeRuntimeCheckpoint(registration.runtime);}
 if(registration.incomplete){
  assert(!registration.segment&&!registration.observation&&!registration.cpu);
  const r=registration.incomplete,p=inspectIncompleteNativeHistory(r),dir=p.source_session;
  assert(!ancestors.includes(dir)&&ancestors.length<8);
  return {...p,source:r.cpu.source,history:r.history,history_sha256:r.history_sha256,
   source_invocations_sha256:r.cpu.source_invocations_sha256,source_bundle_sha256:r.cpu.source_bundle_sha256,
   source_session_sha256:r.cpu.last_session_sha256,steps:r.cpu.steps,
   consumed_native_turns:p.completed_native_replies+p.unsigned_unfinished_attempts,
   inherited_allowed_Reads:3-p.remaining_Reads,remaining_allowed_Reads:p.remaining_Reads,
   no_observed_partial_output:false,human_authorized_unfinished_retry:true,
   original_tool_results_present:true,source_error_status:502};
 }
 if(!registration.segment)return inspectNativeHistoryCheckpoint(registration);
 const s=registration.segment,dir=fs.realpathSync(s.source_session);assert.equal(dir,s.source_session);assert(!ancestors.includes(dir)&&ancestors.length<8,'Cyclic native segment chain');assert.equal(path.dirname(dir),s.code_root);
 for(const [file,key]of [['SESSION.json','session_sha256'],['stdout.jsonl','stdout_sha256'],['LAUNCH.json','launch_sha256'],['NATIVE-KNOWLEDGE-LEDGER.json','ledger_sha256'],['native-knowledge-boundary.json','boundary_sha256'],['mcp-tools.json','mcp_tools_sha256']])assert.equal(sha(dir+'/'+file),s[key]);
 const session=read(dir+'/SESSION.json'),launch=read(dir+'/LAUNCH.json'),events=lines(dir+'/stdout.jsonl'),boundary=read(dir+'/native-knowledge-boundary.json'),ledger=read(dir+'/NATIVE-KNOWLEDGE-LEDGER.json');
 assert(session.exit!==null&&session.exit!==undefined);assert.equal(session.harness,'native-skill-decision-loop/v1');assert.equal(sha(launch.binary),'24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de');
 if(session.offline_only){assert.equal(s.allow_offline,true);assert.equal(new URL(launch.endpoint).hostname,'127.0.0.1');}else assert.equal(launch.official_Code_direct_HTTP??session.official_Code_direct_HTTP,true);
 const failure=nativeTerminalFailure(events);assert(failure&&[429,500,502,503,504].includes(failure.status));assert(!/quota|balance|credit|forbidden|unauthori[sz]ed|permission/i.test(session.error??''));
 const max=launch.max_native_model_turns;assert(Number.isInteger(max)&&max>0&&max<=7);assert.equal(Number(launch.argv[launch.argv.indexOf('--max-turns')+1]),max);assert.equal(launch.max_native_retries,0);
 const model=launch.argv[launch.argv.indexOf('--model')+1];assert(launch.argv.includes('--model'));assertRegisteredCodeModel(model);
 const matches=m=>modelIdentityMatches(model,m);
 assert.equal(path.dirname(s.history),dir+'/home/projects/decision-loop');assert.equal(sha(s.history),s.history_sha256);const history=lines(s.history);
 assert.equal(sha(s.expected_request_file),s.expected_request_sha256);assert.equal(path.dirname(s.expected_request_file),dir);
 const rawFiles=fs.readdirSync(dir).filter(n=>/^COMPLETE-NATIVE-REPLY-.*\.json$/.test(n)),native=new Map();
 for(const file of rawFiles){const raw=read(dir+'/'+file);assert(raw.id&&matches(raw.model)&&raw.stop_reason);if(native.has(raw.id))assert.deepEqual(native.get(raw.id),raw);else native.set(raw.id,raw);}
 const seen=new Set(events.flatMap(e=>e.type==='assistant'&&matches(e.message?.model)?[e.message.id]:e.type==='stream_event'&&e.event?.type==='message_start'&&matches(e.event.message?.model)?[e.event.message.id]:[]));assert.deepEqual([...seen].sort(),[...native.keys()].sort());assert(native.size>0&&native.size<max);
 const ordered=[...native.values()].sort((a,b)=>history.findIndex(e=>e.message?.id===a.id)-history.findIndex(e=>e.message?.id===b.id)),blocks=history.filter(e=>e.type==='assistant'&&matches(e.message?.model)).flatMap(e=>e.message.content??[]);let cursor=0;
 const results=history.filter(e=>e.type==='user'&&Array.isArray(e.message?.content)).flatMap(e=>e.message.content.filter(b=>b.type==='tool_result'));
 for(const raw of ordered){assert(history.some(e=>e.message?.id===raw.id));for(const b of raw.content){while(cursor<blocks.length&&hash(normalized(blocks[cursor]))!==hash(normalized(b)))cursor++;assert(cursor<blocks.length,'Native signed block lost');cursor++;if(b.type==='tool_use')assert(results.some(r=>r.tool_use_id===b.id),'Native tool result not persisted; do not redraw');}}
 const receipts=fs.existsSync(dir+'/MCP-CALLS.jsonl')?lines(dir+'/MCP-CALLS.jsonl'):[];assert.deepEqual(receipts,session.native_MCP_receipts);
 for(const r of receipts){const result=results.find(b=>b.tool_use_id===r._meta?.['claudecode/toolUseId']);assert(result);const original=read(dir+'/results/'+r.rpc_id+'.json');assert.equal(text(result.content),original.text);assert.equal(!!result.is_error,!!original.is_error);if(r.name==='act')assert.equal(original.is_error,true,'A potentially executed act cannot be retried');}
 assert.deepEqual(ledger,session.native_knowledge_ledger);assert.equal(boundary.max_reads,3);verifyNativeSkillEdition({files:boundary.files,sha256:boundary.assets_sha256,derivation:boundary.derivation});for(const [rel,digest]of Object.entries(boundary.files))assert.equal(sha(boundary.skill_root+'/'+rel),digest);
 const reads=ledger.attempts.filter(a=>a.tool==='Read'&&a.allowed).length;assert(reads<=3);const parentFile=dir+'/NATIVE-RESUME-REGISTRATION.json';let parent=null;
 if(fs.existsSync(parentFile)){assert.equal(sha(parentFile),s.parent_registration_sha256);const previous=read(parentFile);parent=inspectRegisteredNativeCheckpoint(previous,[...ancestors,dir]);assert.deepEqual(parent,previous.attestation);assert.equal(parent.remaining_native_turns,max);const inherited=read(parent.source_session+'/NATIVE-KNOWLEDGE-LEDGER.json').attempts;assert.deepEqual(ledger.attempts.slice(0,inherited.length),inherited);}
 else assert.equal(s.parent_registration_sha256,null);
 return {version:SEGMENT_CHECKPOINT_VERSION,source:path.dirname(s.code_root),source_session:dir,history:s.history,history_sha256:s.history_sha256,source_session_sha256:s.session_sha256,source_launch_sha256:s.launch_sha256,source_boundary_sha256:s.boundary_sha256,source_ledger_sha256:s.ledger_sha256,source_mcp_tools_sha256:s.mcp_tools_sha256,consumed_native_turns:native.size,remaining_native_turns:max-native.size,inherited_allowed_Reads:reads,remaining_allowed_Reads:3-reads,source_MCP_receipts:receipts.length,source_error_status:failure.status,no_observed_partial_output:true,original_tool_results_present:true,parent_remaining_native_turns:parent?.remaining_native_turns??null,production_ready:false,new_paid_recovery_authorized_by_this_audit:false,actual_upstream_API_calls:0};
}

export function captureNativeSegmentCheckpoint({sessionDir,codeRoot,expected,allowOffline=false}){
 const launch=read(sessionDir+'/LAUNCH.json'),history=sessionDir+'/home/projects/decision-loop/'+launch.argv[launch.argv.indexOf('--resume')+1]+'.jsonl';
 const names=fs.readdirSync(sessionDir).filter(n=>/^EXPECTED-CONTROLLER-REQUEST-\d+\.json$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0])),file=sessionDir+'/'+names.at(-1);assert.deepEqual(read(file),expected);
 const segment={source_session:sessionDir,code_root:codeRoot,allow_offline:allowOffline,history,history_sha256:sha(history),expected_request_file:file,expected_request_sha256:sha(file),session_sha256:sha(sessionDir+'/SESSION.json'),stdout_sha256:sha(sessionDir+'/stdout.jsonl'),launch_sha256:sha(sessionDir+'/LAUNCH.json'),ledger_sha256:sha(sessionDir+'/NATIVE-KNOWLEDGE-LEDGER.json'),boundary_sha256:sha(sessionDir+'/native-knowledge-boundary.json'),mcp_tools_sha256:sha(sessionDir+'/mcp-tools.json'),parent_registration_sha256:fs.existsSync(sessionDir+'/NATIVE-RESUME-REGISTRATION.json')?sha(sessionDir+'/NATIVE-RESUME-REGISTRATION.json'):null};
 const registration={segment};registration.attestation=inspectRegisteredNativeCheckpoint(registration);return registration;
}

export function inspectNativeHistoryRetry(evidence){
 assert(evidence&&evidence.registration&&evidence.expected);
 const proof=inspectRegisteredNativeCheckpoint(evidence.registration);
 assert.deepEqual(proof,evidence.registration.attestation);
 const dir=fs.realpathSync(evidence.failed_session);assert.equal(dir,evidence.failed_session);
 assert.equal(sha(dir+'/SESSION.json'),evidence.failed_session_sha256);
 assert.equal(sha(dir+'/stdout.jsonl'),evidence.failed_stdout_sha256);
 if(dir!==proof.source_session)inspectEmptyGatewayFailure(dir);
 const names=fs.readdirSync(proof.source_session).filter(n=>/^EXPECTED-CONTROLLER-REQUEST-\d+\.json$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
 assert.deepEqual(read(proof.source_session+'/'+names.at(-1)),evidence.expected);
 assert(proof.remaining_native_turns>0&&proof.remaining_native_turns<=7);
 return {session_dir:dir,native_history_resume:{source_session:proof.source_session,failed_session:dir},
  all_native_outputs_retained:true,original_tool_results_present:true,no_ambiguous_partial_output:true,
  remaining_native_turns:proof.remaining_native_turns,consumed_retained_native_turns:proof.consumed_native_turns,
  evidence_sha256:hash({proof,failed_session:evidence.failed_session_sha256,failed_stdout:evidence.failed_stdout_sha256,expected:hash(evidence.expected)})};
}

// This is an offline, fail-closed source contract. It neither spawns Code nor authorizes paid continuation.
export function inspectNativeHistoryCheckpoint({observation,cpu}){
 assert(cpu.verified&&cpu.exact_requests&&cpu.exact_terminal_request);assert.equal(cpu.actual_upstream_API_calls,0);
 const dir=fs.realpathSync(observation.source_session);assert.equal(dir,observation.source_session);
 assert.equal(path.dirname(dir),cpu.source+'/Code');
 assert.equal(sha(dir+'/SESSION.json'),observation.session_sha256);assert.equal(sha(dir+'/stdout.jsonl'),observation.stdout_sha256);
 assert.equal(sha(observation.native_history),observation.native_history_sha256);
 assert.equal(sha(cpu.source+'/invocations.jsonl'),cpu.source_invocations_sha256);assert.equal(sha(cpu.source+'/bundle.json'),cpu.source_bundle_sha256);
 const session=read(dir+'/SESSION.json'),launch=read(dir+'/LAUNCH.json'),history=lines(observation.native_history),events=lines(dir+'/stdout.jsonl');
 assert(session.exit!==null&&session.exit!==undefined);assert.equal(session.harness,'native-skill-decision-loop/v1');assert.equal(session.offline_only,false);
 const terminal=nativeTerminalFailure(events);
 let deadline=null;
 if(!terminal&&observation.local_deadline_authorization){
  const authorization=observation.local_deadline_authorization;
  assert.equal(sha(authorization.file),authorization.sha256);
  const policy=read(authorization.file),record=policy.targets.find(t=>t.source_session===dir);
  assert.equal(policy.version,'authorized-complete-history-deadline-resume/v1');
  assert.equal(policy.human_instruction,'允许240秒，仅无损续接（推荐）');
  assert.equal(policy.new_logical_timeout_ms,240000);assert.equal(policy.old_logical_timeout_ms,120000);
  assert(record);assert.equal(record.session_sha256,sha(dir+'/SESSION.json'));assert.equal(record.stdout_sha256,sha(dir+'/stdout.jsonl'));
  const sourcePlanFile=path.resolve(cpu.source,'../..')+'/PLAN.json';
  assert.equal(policy.source_root,path.dirname(path.dirname(cpu.source)));
  assert.equal(policy.source_plan_sha256,sha(sourcePlanFile));assert.equal(read(sourcePlanFile).logical_timeout_ms,120000);
  assert.equal(session.error,'Decision-loop Code logical deadline; no partial action accepted or saved complete reply redrawn');
  assert.deepEqual(session.exit,{code:null,signal:'SIGKILL'});assert.equal(session.actual_HTTP,null);
  const elapsed=Date.parse(session.closed)-Date.parse(launch.started);assert(elapsed>=119000&&elapsed<150000);
  deadline={status:504,kind:'verified_local_logical_deadline',actual_HTTP:null};
 }
 assert((terminal&&[429,500,502,503,504].includes(terminal.status))||deadline);
 assert(!/quota|balance|credit|forbidden|unauthori[sz]ed|permission/i.test(session.error??''));
 assert.equal(launch.max_native_retries,0);assert.equal(sha(launch.binary),'24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de');
 const limit=launch.max_native_model_turns;assert(Number.isInteger(limit)&&limit>=1&&limit<=7);
 assert.equal(Number(launch.argv[launch.argv.indexOf('--max-turns')+1]),limit);
 const calls=parseInvocations(fs.readFileSync(cpu.source+'/invocations.jsonl','utf8'),{strict:true}),accepted=calls.filter(c=>c.response&&!c.error);
 assert.equal(accepted.length,cpu.accepted_calls);assert.equal(cpu.prefix.length,accepted.length);assert(calls.at(-1).error&&!calls.at(-1).response);
 for(let i=0;i<accepted.length;i++){const c=accepted[i],p=cpu.prefix[i];assert.equal(c.call,p.call);assert.equal(hash(c.request),p.request_sha256);assert.equal(hash(c.response.raw),p.raw_sha256);assert.equal(sha(p.proposal),p.proposal_sha256);}
 const rejected=calls.slice(0,-1).filter(c=>c.error);assert.equal(rejected.length,(cpu.rejected_calls??[]).length);
 for(let i=0;i<rejected.length;i++){const c=rejected[i],p=cpu.rejected_calls[i];assert(c.response?.raw);assert.equal(c.call,p.call);assert.equal(c.error.code,'TOOL_CONTRACT');assert.deepEqual(c.error,p.error);assert.equal(hash(c.request),p.request_sha256);assert.equal(hash(c.response.raw),p.raw_sha256);assert.equal(sha(p.proposal),p.proposal_sha256);}
 assert.equal(read(cpu.source+'/stats.json').parse_errors,cpu.preserved_parse_errors??0);
 const originals=new Map();
 for(const p of observation.original_raw_replies){const file=dir+'/'+p.file;assert.equal(sha(file),p.sha256);const raw=read(file);assert(raw.id===p.id&&raw.model==='claude-opus-5-5'&&raw.stop_reason);assert(!originals.has(raw.id));originals.set(raw.id,raw);}
 const ids=new Set(events.flatMap(e=>e.type==='assistant'&&e.message?.model==='claude-opus-5-5'?[e.message.id]:e.type==='stream_event'&&e.event?.type==='message_start'&&e.event.message?.model==='claude-opus-5-5'?[e.event.message.id]:[]));
 assert.deepEqual([...ids].sort(),[...originals.keys()].sort(),'Every observed model output must be completely retained');
 assert(originals.size>0&&originals.size<limit);const remaining=limit-originals.size;
 const sourceBlocks=history.filter(e=>e.type==='assistant'&&e.message?.model==='claude-opus-5-5').flatMap(e=>e.message.content??[]);
 const ordered=[...originals.values()].sort((a,b)=>history.findIndex(e=>e.message?.id===a.id)-history.findIndex(e=>e.message?.id===b.id));let cursor=0;
 for(const raw of ordered){assert(history.some(e=>e.message?.id===raw.id));for(const b of raw.content){while(cursor<sourceBlocks.length&&hash(normalized(sourceBlocks[cursor]))!==hash(normalized(b)))cursor++;assert(cursor<sourceBlocks.length,'Signed block not preserved in persisted history');cursor++;}}
 const results=history.filter(e=>e.type==='user'&&Array.isArray(e.message?.content)).flatMap(e=>e.message.content.filter(b=>b.type==='tool_result'));
 if(deadline)for(const raw of originals.values())for(const block of raw.content)if(block.type==='tool_use')assert(results.some(r=>r.tool_use_id===block.id),'Every retained native tool must already have its original result');
 const receiptFile=dir+'/MCP-CALLS.jsonl',receiptFileExists=fs.existsSync(receiptFile);
 // A Read-only first decision has no controller MCP log yet; never synthesize one.
 const receipts=receiptFileExists?lines(receiptFile):[];assert.deepEqual(receipts,session.native_MCP_receipts);
 for(const r of receipts){const id=r._meta?.['claudecode/toolUseId'];assert(id);const result=results.find(b=>b.tool_use_id===id);assert(result,'Original MCP result must already exist; do not invent one');const file=dir+'/results/'+r.rpc_id+'.json';assert(fs.existsSync(file));const expected=read(file);assert.equal(text(result.content),expected.text);assert.equal(!!result.is_error,!!expected.is_error);}
 const boundary=read(dir+'/native-knowledge-boundary.json'),ledger=read(dir+'/NATIVE-KNOWLEDGE-LEDGER.json');assert.equal(boundary.max_reads,3);assert.deepEqual(ledger,session.native_knowledge_ledger);
 const plan=read(path.resolve(cpu.source,'../..')+'/PLAN.json');assert.equal(boundary.assets_sha256,plan.native_skill.assets_sha256);verifyNativeSkillEdition({files:boundary.files,sha256:boundary.assets_sha256,derivation:boundary.derivation});
 const recordedLedger=cpu.pending_files.find(f=>f.file==='NATIVE-KNOWLEDGE-LEDGER.json');assert(recordedLedger);assert.equal(sha(dir+'/NATIVE-KNOWLEDGE-LEDGER.json'),recordedLedger.sha256);
 const reads=ledger.attempts.filter(a=>a.tool==='Read'&&a.allowed).length;assert(reads<=3);
 for(const [rel,digest]of Object.entries(boundary.files))assert.equal(sha(boundary.skill_root+'/'+rel),digest);
 assert.equal(read(cpu.source+'/bundle.json').metrics.steps,cpu.steps);
 return {version:HISTORY_CHECKPOINT_VERSION,source:cpu.source,source_session:dir,history:observation.native_history,history_sha256:observation.native_history_sha256,
  source_invocations_sha256:cpu.source_invocations_sha256,source_bundle_sha256:cpu.source_bundle_sha256,source_session_sha256:observation.session_sha256,
  source_launch_sha256:sha(dir+'/LAUNCH.json'),source_boundary_sha256:sha(dir+'/native-knowledge-boundary.json'),source_ledger_sha256:sha(dir+'/NATIVE-KNOWLEDGE-LEDGER.json'),source_mcp_config_sha256:sha(dir+'/mcp.json'),source_mcp_tools_sha256:sha(dir+'/mcp-tools.json'),source_skill_manifest_sha256:sha(dir+'/NATIVE-SKILL-MANIFEST.json'),
  accepted_calls:accepted.length,replayed_rejected_calls:rejected.length,preserved_parse_errors:cpu.preserved_parse_errors??0,steps:cpu.steps,consumed_native_turns:originals.size,remaining_native_turns:remaining,inherited_allowed_Reads:reads,remaining_allowed_Reads:3-reads,
  source_MCP_receipts:receipts.length,source_mcp_receipts_sha256:receiptFileExists?sha(receiptFile):null,original_tool_results_present:true,no_observed_partial_output:true,source_error_status:(terminal??deadline).status,
  ...(deadline?{termination_kind:deadline.kind,actual_HTTP:null,deadline_authorization_sha256:observation.local_deadline_authorization.sha256}:{}),
  production_ready:false,new_paid_recovery_authorized_by_this_audit:false,actual_upstream_API_calls:0};
}

export function prepareNativeHistoryCheckpoint({observation,cpu,segment,incomplete,runtime,destination,expected,attestation}){
 if(incomplete){
  const checked=inspectRegisteredNativeCheckpoint({incomplete});assert.deepEqual(checked,attestation);
  const prepared=prepareIncompleteNativeHistory({registration:incomplete,attestation:inspectIncompleteNativeHistory(incomplete),expected,destination});
  const witness={...prepared.proof,...checked,destination,read_only_source_workspace:prepared.cwd};
  fs.writeFileSync(destination+'/NATIVE-RESUME-CHECKPOINT.json',JSON.stringify(witness,null,2)+'\n',{flag:'wx'});
  return {...prepared,proof:witness};
 }
 const proof=inspectRegisteredNativeCheckpoint(runtime?{runtime}:{observation,cpu,segment}),source=proof.source_session,launch=read(source+'/LAUNCH.json');
 assert(attestation,'Explicit immutable checkpoint attestation required');assert.deepEqual(proof,attestation);
 const names=fs.readdirSync(source).filter(n=>/^EXPECTED-CONTROLLER-REQUEST-\d+\.json$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
 assert.deepEqual(expected,read(source+'/'+names.at(-1)),'Resume must answer the exact latest original controller request');
 assert(path.isAbsolute(destination)&&!fs.existsSync(destination+'/home')&&!fs.existsSync(destination+'/workspace'));
 const args=[...launch.argv],option=name=>args[args.indexOf(name)+1],boundary=read(source+'/native-knowledge-boundary.json'),ledger=read(source+'/NATIVE-KNOWLEDGE-LEDGER.json');
 assert(args.includes('--resume'));assert.equal(path.basename(proof.history),option('--resume')+'.jsonl');assert.equal(option('--tools'),'Skill,Read');
 const instructions=option('--append-system-prompt'),system=expected.system.map(b=>b.text).join('\n');assert(instructions.startsWith(system+'\n\n'));
 // --restricted confines Read to cwd. Keep the original read-only Skill workspace, while HOME,
 // MCP results and all hook writes move to the new isolated session.
 const home=destination+'/home',cwd=launch.cwd;assert.equal(path.resolve(boundary.skill_root,'../../..'),cwd);fs.cpSync(source+'/home',home,{recursive:true});fs.mkdirSync(destination+'/workspace');fs.mkdirSync(destination+'/results');
 boundary.ledger=destination+'/NATIVE-KNOWLEDGE-LEDGER.json';fs.writeFileSync(boundary.ledger,JSON.stringify(ledger,null,2)+'\n',{flag:'wx'});fs.writeFileSync(destination+'/native-knowledge-boundary.json',JSON.stringify(boundary,null,2)+'\n',{flag:'wx'});
 const settings=JSON.parse(option('--settings'));assert.equal(settings.hooks.PreToolUse.length,1);for(const group of settings.hooks.PreToolUse)for(const hook of group.hooks){assert(hook.command.includes(source+'/native-knowledge-boundary.json'));hook.command=hook.command.replace(source+'/native-knowledge-boundary.json',destination+'/native-knowledge-boundary.json');}
 args[args.indexOf('--settings')+1]=JSON.stringify(settings);args[args.indexOf('--max-turns')+1]=String(proof.remaining_native_turns);args[args.indexOf('--mcp-config')+1]=destination+'/mcp.json';
 const tools=read(source+'/mcp-tools.json');tools.receipts=destination+'/MCP-CALLS.jsonl';tools.results=destination+'/results';fs.writeFileSync(destination+'/mcp-tools.json',JSON.stringify(tools,null,2)+'\n',{flag:'wx'});
 const mcp=read(source+'/mcp.json');mcp.mcpServers.experiment.args[mcp.mcpServers.experiment.args.length-1]=destination+'/mcp-tools.json';fs.writeFileSync(destination+'/mcp.json',JSON.stringify(mcp,null,2)+'\n',{flag:'wx'});
 const routing=read(source+'/NATIVE-TASK-ENTRY.json');routing.native_model_turn_budget=proof.remaining_native_turns;routing.inherited_task_entry=true;routing.source_task_entry=source+'/NATIVE-TASK-ENTRY.json';fs.writeFileSync(destination+'/NATIVE-TASK-ENTRY.json',JSON.stringify(routing,null,2)+'\n',{flag:'wx'});
 const manifest=read(source+'/NATIVE-SKILL-MANIFEST.json');
 const knowledge={version:'native-skill-decision-loop/v1',plugin:option('--plugin-dir'),root:boundary.skill_root,name:boundary.skill_name,ledger:boundary.ledger,assets_sha256:boundary.assets_sha256,guidance_revision:manifest.guidance_revision,settings,
  allowed:args.slice(args.indexOf('--allowedTools')+1,args.indexOf('--plugin-dir')).filter(a=>!a.startsWith('mcp__experiment__')),instructions:instructions.slice(system.length+2)};
 const history=home+'/projects/decision-loop/'+option('--resume')+'.jsonl';assert.equal(sha(history),proof.history_sha256);
 const derivation=runtime?deriveRuntimeResumeHistory({runtime,history,destination}):null;
 const witness={...proof,...(derivation?{runtime_history_derivation:derivation}:{}),destination,read_only_source_workspace:cwd,cloned_history:history,cloned_history_sha256:sha(history),source_ledger_sha256:sha(source+'/NATIVE-KNOWLEDGE-LEDGER.json'),source_task_entry_sha256:sha(source+'/NATIVE-TASK-ENTRY.json'),source_boundary_sha256:sha(source+'/native-knowledge-boundary.json'),new_Skill_entry_executed:false,new_tool_results_synthesized:false,ledger_inherited_without_budget_reset:true};
 fs.writeFileSync(destination+'/NATIVE-RESUME-CHECKPOINT.json',JSON.stringify(witness,null,2)+'\n',{flag:'wx'});
 return {proof:witness,home,cwd,args,knowledge,history,receipts:tools.receipts,tools:tools.tools.map(t=>t.name),stdin:'',resume_interrupted_turn:true};
}
