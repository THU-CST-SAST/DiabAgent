import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {nativeToolResult,nativeWitnessMatches,NATIVE_SKILL_VERSION,verifyNativeSkillEdition} from './native-skill.mjs';
import {inspectRegisteredNativeCheckpoint} from './native-history-checkpoint.mjs';
import {verifyInheritedTaskEntries} from './inherited-task-entry.mjs';
import {assertRegisteredCodeModel,modelIdentityMatches} from './model-identity.mjs';

const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function inspectNativeKnowledge(location,session,events,maxTurns){
  const launch=read(location+'/LAUNCH.json'),config=read(location+'/native-knowledge-boundary.json');
  const ledger=read(location+'/NATIVE-KNOWLEDGE-LEDGER.json');
  const resumed=fs.existsSync(location+'/NATIVE-RESUME-REGISTRATION.json')?read(location+'/NATIVE-RESUME-REGISTRATION.json'):null;
  const checkpoint=resumed?inspectRegisteredNativeCheckpoint(resumed):null;
  let inheritedReads=0,inheritedIds=[];
  if(checkpoint){
    assert(isDeepStrictEqual(checkpoint,resumed.attestation));const witness=read(location+'/NATIVE-RESUME-CHECKPOINT.json');
    assert.equal(witness.destination,location);assert.equal(witness.remaining_native_turns,maxTurns);assert.equal(witness.history_sha256,checkpoint.history_sha256);
    assert.equal(witness.new_Skill_entry_executed,false);assert.equal(witness.new_tool_results_synthesized,false);
    const previous=read(checkpoint.source_session+'/NATIVE-KNOWLEDGE-LEDGER.json').attempts;assert(isDeepStrictEqual(ledger.attempts.slice(0,previous.length),previous));
    inheritedReads=previous.filter(a=>a.tool==='Read'&&a.allowed).length;inheritedIds=previous.map(a=>a.id);
    assert.equal(config.skill_root,read(checkpoint.source_session+'/native-knowledge-boundary.json').skill_root);assert.equal(config.ledger,location+'/NATIVE-KNOWLEDGE-LEDGER.json');assert.equal(launch.cwd,read(checkpoint.source_session+'/LAUNCH.json').cwd);
  }
  assert.equal(session.harness,NATIVE_SKILL_VERSION);
  assert(isDeepStrictEqual(session.native_knowledge_ledger,ledger));
  assert.equal(config.max_reads,3);
  verifyNativeSkillEdition({files:config.files,sha256:config.assets_sha256,derivation:config.derivation});
  if(!checkpoint)assert.equal(config.skill_root,location+'/workspace/.experiment-plugin/skills/blood-glucose-management');
  for(const [rel,digest] of Object.entries(config.files)){
    const file=fs.realpathSync(config.skill_root+'/'+rel);
    assert(file.startsWith(fs.realpathSync(config.skill_root)+path.sep));assert.equal(sha(fs.readFileSync(file)),digest);
  }
  const argv=launch.argv,option=name=>argv[argv.indexOf(name)+1];
  assert(!argv.includes('--bare')&&!argv.includes('--disable-slash-commands')&&!argv.includes('--system-prompt'));
  assert.equal(option('--tools'),'Skill,Read');assert(argv.includes('--restricted'));
  assert.equal(option('--plugin-dir'),path.dirname(path.dirname(config.skill_root)));
  const settings=JSON.parse(option('--settings'));assert.equal(settings.disableBundledSkills,true);
  assert.equal(settings.hooks.PreToolUse.length,1);assert.equal(settings.hooks.PreToolUse[0].matcher,'Skill|Read');
  assert.equal(settings.hooks.PreToolUse[0].hooks.length,1);
  const hook=settings.hooks.PreToolUse[0].hooks[0];
  assert.equal(hook.type,'command');assert.equal(hook.timeout,5);
  assert(hook.command.includes('/native-read-hook.mjs')&&hook.command.includes(location+'/native-knowledge-boundary.json'));
  assert(!launch.environment_names.includes('CLAUDE_CODE_DISABLE_ATTACHMENTS'));
  let explicitTaskEntries=0,entryReloads=0;
  if(fs.existsSync(location+'/NATIVE-TASK-ENTRY.json')){
    const routing=read(location+'/NATIVE-TASK-ENTRY.json');
    assert.equal(routing.mode,'task-command-v1');assert.equal(routing.command,'/'+config.skill_name);
    assert.equal(routing.manual_body_injection,false);assert.equal(routing.model_selected_activation,false);
    assert.equal(routing.native_model_turn_budget,maxTurns);assert.equal(routing.reference_read_budget,3);
    assert(argv.includes('--resume'));const sid=option('--resume');assert(/^[a-f0-9-]{36}$/.test(sid));
    const history=fs.readFileSync(location+'/home/projects/decision-loop/'+sid+'.jsonl','utf8').split('\n').filter(Boolean).map(JSON.parse);
    const body=fs.readFileSync(config.skill_root+'/SKILL.md','utf8').replace(/^---\n[\s\S]*?\n---\n/,'').trim();
    const exact=`Base directory for this skill: ${config.skill_root}\n\n${body}\n`;
    const entries=history.filter(e=>e.type==='user'&&e.isMeta===true&&Array.isArray(e.message?.content)
      &&e.message.content.length===1&&e.message.content[0].type==='text'&&e.message.content[0].text===exact);
    if(checkpoint){
      assert.equal(routing.inherited_task_entry,true);
      const sourceHistory=fs.readFileSync(checkpoint.history,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),sourceEntries=sourceHistory.filter(e=>e.type==='user'&&e.isMeta===true&&Array.isArray(e.message?.content)&&e.message.content.length===1&&e.message.content[0].type==='text'&&e.message.content[0].text===exact);
      const freshSkills=ledger.attempts.filter(a=>{const result=nativeToolResult(events,a.id);return a.tool==='Skill'&&a.allowed&&!inheritedIds.includes(a.id)&&result&&!result.block.is_error;}).map(a=>a.id);
      entryReloads=verifyInheritedTaskEntries({history,entries,sourceEntries,successfulFreshSkillIds:freshSkills}).model_selected_reloads;
    }else assert.equal(entries.length,1,'Native session must preserve exactly one pinned task-entry body');
    const witness=read(location+'/NATIVE-TASK-ENTRY-WITNESS.json');
    assert.equal(witness.source,location+'/home/projects/decision-loop/'+sid+'.jsonl');
    assert(isDeepStrictEqual(witness.native_record,entries[0]));
    assert(witness.wait_ms>=0&&witness.wait_ms<=1100);
    explicitTaskEntries=1;
  }
  const witnesses=ledger.attempts.map(a=>({...a,cwd:checkpoint?launch.cwd:location+'/workspace',result:nativeToolResult(events,a.id)})).filter(w=>!checkpoint||w.result);
  const internal=session.native_internal??[],ids=new Set(inheritedIds);
  for(let i=0;i<internal.length;i++){
    const record=internal[i];assert(isDeepStrictEqual(record,read(location+'/NATIVE-INTERNAL-'+(i+1)+'.json')));
    const uses=record.raw.content.filter(b=>b.type==='tool_use');assert(uses.length>0);
    assert.equal(uses.length,record.operations.length);
    for(const use of uses){
      assert(!ids.has(use.id));ids.add(use.id);
      const witness=witnesses.find(w=>nativeWitnessMatches(use,w));assert(witness);
      const op=record.operations.find(o=>o.id===use.id);assert(op);
      assert(isDeepStrictEqual(op.result,witness.result.block));
      assert.equal(op.allowed,witness.allowed);
      if(use.name==='Read'&&op.allowed){
        assert.equal(op.source_sha256,config.files[op.path]);
        const text=fs.readFileSync(config.skill_root+'/'+op.path,'utf8').split('\n')
          .slice(op.offset_lines-1,op.offset_lines-1+op.limit_lines).join('\n');
        assert.equal(op.characters,text.length);assert(text.length<=48000);
      }
    }
  }
  assert(ledger.attempts.filter(o=>o.tool==='Read'&&o.allowed).length<=3);
  // Both streamed and JSON-native output may repeat the same message id in public chunks.
  const requested=option('--model');assertRegisteredCodeModel(requested);
  const assistants=events.filter(e=>e.type==='assistant'&&e.message?.model);
  // The CLI emits its own '<synthetic>' assistant messages (API error notices, interruption markers).
  // They are local text, not model output, so they are neither an identity violation nor a model turn —
  // but they must stay text-only, so a local notice can never carry a tool call into the audited history.
  const synthetic=assistants.filter(e=>e.message.model==='<synthetic>');
  for(const e of synthetic)assert(e.message.content?.every(b=>b.type==='text'),'Synthetic CLI message must be text-only');
  const replies=assistants.filter(e=>e.message.model!=='<synthetic>');
  for(const e of replies)assert(modelIdentityMatches(requested,e.message.model),'Skill audit model identity mismatch');
  const turnIds=new Set(replies.map(e=>e.message.id));
  assert(turnIds.size<=maxTurns);
  return {witnesses,internal,explicit_task_entries:explicitTaskEntries,...(checkpoint?{inherited_task_entries:1,model_selected_entry_reloads:entryReloads,inherited_reference_reads:inheritedReads,native_history_checkpoint:{source_session:checkpoint.source_session,history_sha256:checkpoint.history_sha256,consumed_original_native_turns:checkpoint.consumed_native_turns,remaining_native_turns:maxTurns}}:{}),skill_invocations:internal.flatMap(r=>r.operations).filter(o=>o.tool==='Skill'&&o.allowed&&!o.result.is_error).length,
    reference_reads:internal.flatMap(r=>r.operations).filter(o=>o.tool==='Read'&&o.allowed&&!o.result.is_error).length,
    algorithm_reads:internal.flatMap(r=>r.operations).filter(o=>o.tool==='Read'&&o.algorithm_section_covered&&!o.result.is_error).length,
    read_paths:[...new Set(internal.flatMap(r=>r.operations).filter(o=>o.tool==='Read'&&o.allowed&&!o.result.is_error).map(o=>o.path))]};
}
