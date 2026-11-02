import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {modelIdentityMatches} from './model-identity.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const lines=p=>fs.readFileSync(p,'utf8').split('\n').filter(Boolean).map(JSON.parse);

// Reconciles a retained invalid response, not an accepted controller reply or permission to call a model.
export function inspectPendingParallelReply(source,{model='claude-opus-5-5',expectedRequestSha256=null}={}){
  source=fs.realpathSync(source);
  const session=read(source+'/SESSION.json'),launch=read(source+'/LAUNCH.json');
  assert(session.exit!=null);assert.deepEqual(session.turns,[]);assert.deepEqual(session.native_internal??[],[]);
  assert.match(session.error??'',/logical deadline/);assert.equal(launch.max_native_model_turns,7);
  assert(!fs.readdirSync(source).some(f=>/^ACCEPTED-PROPOSAL-|^COMPLETE-NATIVE-REPLY-|^NATIVE-INTERNAL-/.test(f)));
  assert.deepEqual(fs.readdirSync(source+'/results'),[],'No original query result may be discarded');
  const ledger=read(source+'/NATIVE-KNOWLEDGE-LEDGER.json');assert.deepEqual(ledger.attempts,[]);
  const events=lines(source+'/stdout.jsonl'),chunks=events.filter(e=>e.type==='assistant');
  assert(chunks.length>=2);const message=chunks[0].message;
  assert.equal(message.type,'message');assert.equal(message.role,'assistant');assert.equal(message.stop_reason,'tool_use');
  assert(modelIdentityMatches(model,message.model));
  const {content,...header}=message,blocks=[];
  for(const e of chunks){const {content,...h}=e.message;assert(isDeepStrictEqual(h,header),'Native chunk header changed');assert(Array.isArray(content));blocks.push(...content);}
  assert(events.filter(e=>e.type==='stream_event').every(e=>e.event?.type==='ping'),'Partial streamed output must be reconciled separately');
  assert(blocks.every(b=>['thinking','text','tool_use'].includes(b.type)));
  assert(blocks.some(b=>b.type==='thinking'&&typeof b.signature==='string'&&b.signature.length>0));
  const uses=blocks.filter(b=>b.type==='tool_use');assert(uses.length>=2);assert.equal(new Set(uses.map(u=>u.id)).size,uses.length);
  assert(uses.every(u=>['mcp__experiment__simulate','mcp__experiment__read_glucose_history'].includes(u.name)&&u.input&&typeof u.input==='object'&&!u.input.__unparsedToolInput));
  const receipts=lines(source+'/MCP-CALLS.jsonl');assert.equal(receipts.length,1);
  assert(isDeepStrictEqual(receipts,session.native_MCP_receipts));
  assert.equal(receipts[0]._meta?.['claudecode/toolUseId'],uses[0].id);
  assert.equal('mcp__experiment__'+receipts[0].name,uses[0].name);assert(isDeepStrictEqual(receipts[0].arguments,uses[0].input));
  const argv=launch.argv,index=argv.indexOf('--resume');assert(index>=0);const sid=argv[index+1];assert.match(sid,/^[a-f0-9-]{36}$/);
  const historyFile=source+'/home/projects/decision-loop/'+sid+'.jsonl',history=lines(historyFile),raw={...header,content:blocks};
  const native=history.filter(e=>e.type==='assistant'&&e.message?.id===raw.id);
  assert.equal(native.length,1,'Require a single complete original native-history message');
  assert(isDeepStrictEqual(native[0].message,raw),'Full original history must prove exact blocks, order and signatures');
  const ids=new Set(uses.map(u=>u.id));
  assert(!history.some(e=>e.message?.content?.some?.(b=>b.type==='tool_result'&&ids.has(b.tool_use_id))),'Unreconciled original tool result');
  const boundary=read(source+'/native-knowledge-boundary.json');
  assert.equal(boundary.skill_root,source+'/workspace/.experiment-plugin/skills/blood-glucose-management');
  const skillFile=boundary.skill_root+'/SKILL.md',entry=fs.readFileSync(skillFile,'utf8');assert.equal(hash(entry),boundary.files['SKILL.md']);
  const exact='Base directory for this skill: '+boundary.skill_root+'\n\n'+entry.replace(/^---\n[\s\S]*?\n---\n/,'').trim()+'\n';
  assert.equal(history.filter(e=>e.type==='user'&&e.isMeta===true&&e.message?.content?.length===1&&e.message.content[0].text===exact).length,1);
  const required=['SESSION.json','LAUNCH.json','stdout.jsonl','MCP-CALLS.jsonl','EXPECTED-CONTROLLER-REQUEST-1.json','NATIVE-KNOWLEDGE-LEDGER.json','native-knowledge-boundary.json'];
  const files=Object.fromEntries(required.map(f=>[f,hash(fs.readFileSync(source+'/'+f))]));
  if(expectedRequestSha256)assert.equal(files['EXPECTED-CONTROLLER-REQUEST-1.json'],expectedRequestSha256);
  return {version:'registered-native-pending-parallel/v1',source,raw,raw_sha256:hash(JSON.stringify(raw)),files,
    native_history:{file:historyFile,sha256:hash(fs.readFileSync(historyFile))},skill_entry_sha256:hash(entry),
    consumed_native_turns:1,remaining_native_turns:6,executed_queries:0,original_MCP_receipts:1,
    original_rejection_results:0,derived_rejection_results_required:uses.length,
    paid_continuation_allowed:false,original_files_modified:false};
}

export function verifyPendingCorrection(correction,expected){
  assert.equal(correction.version,'registered-native-pending-parallel/v1');
  const {source_manifest,...registered}=correction;
  assert.deepEqual(inspectPendingParallelReply(registered.source,{model:expected.model}),registered);
  assert.deepEqual(read(source_manifest).proof,registered);
  assert.deepEqual(read(registered.source+'/EXPECTED-CONTROLLER-REQUEST-1.json'),expected);
  return registered;
}
