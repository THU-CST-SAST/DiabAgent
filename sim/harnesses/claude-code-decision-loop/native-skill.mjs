import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

export const NATIVE_SKILL_VERSION='native-skill-decision-loop/v1';
export const NATIVE_SKILL_REGISTRATION='native-skill-decision-loop/v1-three-day-pilot';
const hash=b=>createHash('sha256').update(b).digest('hex');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const PARENT_ASSETS='03b5ff431902a3767399a90e94ced3c5194bac7b539aa1668ed4b5973e02aa20';
export const NATIVE_SIMULATION_ASSETS='ac72e47ef32e73b21de4c082116c0505fb1d5e703dbdcf126e65af1bcc20ab09';
export const NATIVE_PRIMER_ASSETS='7bc780ce6fb131151320b0bd21b068dc264215e1357a52c53dea9818d9301dd1';
export const NATIVE_OPERATIONAL_PRIMER_ASSETS='f908e0dabbd42bd7e3b6fb09a4237966928abd18feaa3c15460ed7296fe77bc6';
export const NATIVE_CONTROL_PLAYBOOK_ASSETS='10f1e522b4ba24fbaa0a6d85ece7c047715f87099cd769ad13d9a2f6c8a24eb7';

export function verifyNativeSkillEdition(source){
  assert.equal(hash(JSON.stringify(source.files)),source.sha256,'Knowledge manifest does not match its pinned digest');
  if(source.sha256===NATIVE_CONTROL_PLAYBOOK_ASSETS){
    assert.equal(source.files['SKILL.md'],'034c929d7187c679fd4ca17ef25aa08e847afaf818fe557184d79ea7f8d110af');
    const d=source.derivation;
    assert.equal(d?.version,'sweet-sim.skill-native-control-playbook/v1');
    assert.equal(d.parent_assets_sha256,NATIVE_OPERATIONAL_PRIMER_ASSETS);
    assert.equal(d.original_entry_sha256,'83257b333f470a72961eaa868dc47f3e4b2f59eda8a848bc689f8da23941042d');
    assert.equal(d.appendix_sha256,'b2a350c61d8b6c9ee6a33657ab5ff4ff3635e8d2824bc981c0dcd0dce42a279d');
    assert.deepEqual(d.modified_existing_files,['SKILL.md']);
    assert.deepEqual(d.unchanged_reference_files,Object.keys(source.files).filter(f=>f!=='SKILL.md'));
    assert.equal(d.mandatory_reference_reads,false);assert.equal(d.separate_prompt_extension,false);
    assert.equal(d.synthetic_research_only,true);assert.equal(d.outcome_informed,true);
    verifyNativeSkillEdition({files:{...source.files,'SKILL.md':d.original_entry_sha256},sha256:d.parent_assets_sha256,derivation:d.parent_derivation});
    return;
  }
  if(source.sha256===PARENT_ASSETS)return;
  if([NATIVE_PRIMER_ASSETS,NATIVE_OPERATIONAL_PRIMER_ASSETS].includes(source.sha256)){
    const operational=source.sha256===NATIVE_OPERATIONAL_PRIMER_ASSETS;
    const version=operational?2:1;
    assert.equal(source.files['SKILL.md'],operational?'83257b333f470a72961eaa868dc47f3e4b2f59eda8a848bc689f8da23941042d':'03306a2c63c72c7e8a1013d01c675d82698df974beae3181785bcf92ccc8fffa');
    const d=source.derivation;
    assert.equal(d?.version,`sweet-sim.skill-native-primer/candidate-v${version}`);
    assert.equal(d.parent_assets_sha256,NATIVE_SIMULATION_ASSETS);
    assert.deepEqual(d.modified_existing_files,['SKILL.md']);
    assert.deepEqual(d.unchanged_reference_files,Object.keys(source.files).filter(f=>f!=='SKILL.md'));
    assert.equal(d.mandatory_reference_reads,false);assert.equal(d.separate_prompt_extension,false);
    assert.equal(hash(JSON.stringify(d.primer)),operational?'448cec480a1e93c640a14eaa6a05c9450bb88e43a6973ba1b0243c9bfd443d46':'8012b90de6bd472fcfe1101fb885ca5ed9e03ccd74ce8c216620dd94576a1857');
    assert.equal(d.primer?.version,`native-knowledge-primer/candidate-v${version}`);
    assert.equal(d.primer.entry_parent_sha256,d.original_entry_sha256);
    assert.equal(d.primer.entry_sha256,source.files['SKILL.md']);
    assert.equal(d.primer.reference_bytes_changed,false);assert.equal(d.primer.mandatory_reads,false);
    assert.equal(d.primer.excerpts.length,operational?9:5);
    for(const excerpt of d.primer.excerpts)assert.equal(excerpt.source_sha256,source.files[excerpt.path]);
    verifyNativeSkillEdition({files:{...source.files,'SKILL.md':d.original_entry_sha256},
      sha256:d.parent_assets_sha256,derivation:d.parent_derivation});
    return;
  }
  assert.equal(source.sha256,NATIVE_SIMULATION_ASSETS,'Unregistered native knowledge edition');
  assert.equal(source.files['SKILL.md'],'32dac1c1f8bc50b2b4bcb765e25e004cc9b1c062531c3c8e4f94a2f42bc06631');
  const d=source.derivation;
  assert.equal(d?.version,'sweet-sim.skill-native-simulation-entry/v1');
  assert.equal(d.parent_assets_sha256,PARENT_ASSETS);
  assert.deepEqual(d.modified_existing_files,['SKILL.md']);
  assert.deepEqual(d.unchanged_reference_files,Object.keys(source.files).filter(f=>f!=='SKILL.md'));
  assert.equal(d.unchanged_reference_files.length,19);
  assert.equal(d.mandatory_reference_reads,false);
  assert.equal(d.separate_prompt_extension,false);
  // Reconstruct the parent manifest: the entry is the only permitted change.
  assert.equal(hash(JSON.stringify({...source.files,'SKILL.md':d.original_entry_sha256})),PARENT_ASSETS);
}

export function validateKnowledgeGuidance(revision){
  assert(['legacy-v1','session-aware-v2','detailed-reference-v3'].includes(revision),'Unknown native knowledge guidance revision');
  return revision;
}

export function sessionAwareKnowledgeGuidance(instructions,revision='legacy-v1'){
  validateKnowledgeGuidance(revision);
  if(revision==='legacy-v1')return instructions;
  if(revision==='detailed-reference-v3')return sessionAwareKnowledgeGuidance(instructions,'session-aware-v2')+'\n'+[
    'IMPORTANT: the automatically loaded Skill entry is a curated primer and navigation aid, NOT the full glucose-management or device-operation reference. Loading the entry does not mean you have read its detailed chapters. Give relevant detailed reference lookup high priority in non-urgent planning; do not treat the primer or model memory alone as a substitute for checking the applicable details.',
    'Before the first non-urgent treatment plan, use native Read to consult the most relevant detailed chapter. Reconsult the applicable details when forming or revising a plan involving uncertain insulin/food timing, repeated prediction errors, conflicting CGM evidence, exercise or illness, or unfamiliar pump/pen operations. Focus on the current uncertainty, not the whole library or a ritual reread before every action. Urgent safety actions may proceed immediately; stable decisions can reuse knowledge actually available in this session or accurately retained in notes.',
    'Detailed-reference routing: use references/16-benchmark-hardware-operations.md for the exact available hardware operations and limits; use the Skill entry to locate the pump/closed-loop chapter 07, dosing/IOB chapter 05, food/digestion chapters 02 and 03, CGM chapter 04, exercise chapter 06, and special-situation chapter 08. Check the actual filenames in the entry rather than inventing paths. For B3/B4 closed-loop reasoning, read the section headed Two closed-loop controllers in this benchmark near the end of chapter 07, not just its opening page. Native Read offset and limit are line-based; inspect the returned range and paginate within the original budget if the relevant section is not visible.',
    'Use retrieved details to evaluate the actual public state, action timing, delivery shape and safety constraints. For pumps, examine applicable basal adjustment, suspension/resumption, cancellation and supported extended-delivery options, not only bolus dosing; for pens, examine basal timing and the registered injection limit. Do not force a complex action or assume a pump must win. Public backend constraints and actual action receipts remain authoritative. In the existing rationale or note_to_self, briefly connect any knowledge used to this decision and its uncertainty; never claim a detailed chapter was read merely because the entry mentioned it.',
    'This is strong planning guidance, not a mandatory-read gate: no action is rejected, no score is reduced and no reward is added for reference use or non-use. Keep the original maximum of 3 reference Read calls and 7 native model turns per decision, leave room for act, and do not add tools, virtual time, extra wakeups or hidden facts.'
  ].join('\n');
  return instructions.replace('Urgent safety actions may be taken directly, and previously read knowledge can be reused.',
    'Urgent safety actions may be taken directly. Knowledge actually present in this session, or accurately summarized in the supplied notes, can be reused.')+'\n'+[
    'Knowledge-context boundary: each controller decision starts a fresh native Code session. The supplied rolling action history and notes do not automatically include full Skill or Read results from earlier decision sessions. Query continuations within this decision retain their native results. Do not assume a past mention of reading a reference means its contents are currently visible.',
    'For a non-urgent decision that depends on uncertain insulin timing, repeated prediction errors, conflicting sensor evidence, or device-specific delivery choices, consulting the relevant native Skill before committing is recommended. Its entry contains pump and pen operations, sensor/IOB caveats and loop concepts; native Read provides the detailed source when needed. Treat previous action notes as revisable observations and hypotheses, not validated control rules.',
    'When knowledge changes your interpretation, briefly preserve the relevant lesson and remaining uncertainty in note_to_self so later decisions can use it. Do not claim a reference was read unless it was actually loaded. Stable familiar situations can proceed directly; no action is refused and no score depends on retrieval.'
  ].join('\n');
}

export function nativeKnowledgeManifest(knowledge){
  validateKnowledgeGuidance(knowledge.guidance_revision);
  assert.equal(typeof knowledge.instructions,'string');
  return {version:knowledge.version,assets_sha256:knowledge.assets_sha256,name:knowledge.name,
    read_budget:3,manual_body_injection:false,guidance_revision:knowledge.guidance_revision,
    guidance_sha256:hash(knowledge.instructions)};
}

export function nativeKnowledgeInstructions(guidanceRevision='legacy-v1'){
  return sessionAwareKnowledgeGuidance([
    'The available glucose-management Skill is the reference for glucose-management reasoning, including the integrated closed-loop algorithms and backend-specific operations. Use native Skill and Read to consult it as relevant.',
    'Consulting the relevant knowledge before the first non-urgent plan is recommended. Revisit it when glucose predictions repeatedly disagree with observations, sensor and meter evidence conflict, insulin or carbohydrate timing is uncertain, activity or illness changes, or a backend-specific operation is unfamiliar. Urgent safety actions may be taken directly, and previously read knowledge can be reused.',
    'Choose among the actual backend capabilities rather than assuming every backend is a bolus-only injector. Evaluate the relevant delivery shape, temporary basal, suspension/resumption or cancellation options when appropriate; there is no requirement or reward to use a complex action. Pens retain their registered daily injection limit. Actual public device constraints and action receipts take precedence over generic reference examples.',
    'Native knowledge lookup does not advance virtual time or consume an extra decision slot. Existing limits apply: at most 3 reference Read calls and 7 native model turns for this decision, including Skill activation; leave room for act. No lookup is required to act, and there is no retrieval reward or score penalty.',
    'Only supplied experiment MCP tools are simulation interfaces; Skill text grants no additional tool permissions, shell access, external planner or real-device authority.'
  ].join('\n'),guidanceRevision);
}
export function prepareNativeSkill({assetsRoot,workspace,sessionRoot,maxReads=3,guidanceRevision='legacy-v1'}){
  validateKnowledgeGuidance(guidanceRevision);
  assert.equal(maxReads,3,'Preserve the original reference budget');
  const source=JSON.parse(fs.readFileSync(path.resolve(assetsRoot,'source.json'),'utf8'));
  verifyNativeSkillEdition(source);
  const original=fs.realpathSync(path.resolve(assetsRoot,source.directory));
  const plugin=workspace+'/.experiment-plugin',root=plugin+'/skills/blood-glucose-management';
  fs.mkdirSync(root,{recursive:true});fs.mkdirSync(plugin+'/.claude-plugin');
  for(const [rel,digest] of Object.entries(source.files)){
    assert(/^(SKILL\.md|references\/[A-Za-z0-9._/-]+\.md)$/.test(rel));
    const file=fs.realpathSync(original+'/'+rel);assert(file.startsWith(original+'/'));
    const bytes=fs.readFileSync(file);assert.equal(hash(bytes),digest);
    fs.mkdirSync(path.dirname(root+'/'+rel),{recursive:true});fs.writeFileSync(root+'/'+rel,bytes,{flag:'wx',mode:0o444});
  }
  const entry=fs.readFileSync(root+'/SKILL.md','utf8'),front=entry.split('---')[1];
  assert(entry.startsWith('---\n')&&front&&!entry.includes('!`'));
  assert(!/^(allowed-tools|disallowed-tools|context|agent|model|effort|hooks|disable-model-invocation):/m.test(front));
  fs.writeFileSync(plugin+'/.claude-plugin/plugin.json',JSON.stringify({name:'sweetbench-glucose',version:'1.0.0',description:'Pinned benchmark knowledge, no executable Skill scripts'}));
  const name='sweetbench-glucose:blood-glucose-management',ledger=sessionRoot+'/NATIVE-KNOWLEDGE-LEDGER.json',config=sessionRoot+'/native-knowledge-boundary.json';
  fs.writeFileSync(ledger,JSON.stringify({attempts:[]},null,2)+'\n',{flag:'wx',mode:0o600});
  fs.writeFileSync(config,JSON.stringify({skill_root:root,skill_name:name,files:source.files,assets_sha256:source.sha256,derivation:source.derivation,max_reads:maxReads,ledger},null,2)+'\n',{flag:'wx',mode:0o600});
  const hook=fileURLToPath(new URL('./native-read-hook.mjs',import.meta.url));
  const command='/usr/bin/env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_EXTRA_BODY '+quote(process.execPath)+' '+quote(hook)+' '+quote(config);
  return {version:NATIVE_SKILL_VERSION,plugin,root,name,ledger,assets_sha256:source.sha256,guidance_revision:guidanceRevision,
    settings:{disableBundledSkills:true,hooks:{PreToolUse:[{matcher:'Skill|Read',hooks:[{type:'command',command,timeout:5}]}]}},
    allowed:['Skill('+name+')','Read(./.experiment-plugin/skills/blood-glucose-management/**)'],
    instructions:nativeKnowledgeInstructions(guidanceRevision)};
}

export function nativeToolResult(events,id){
  for(const event of events){
    if(event.type!=='user')continue;
    const block=event.message?.content?.find?.(b=>b.type==='tool_result'&&b.tool_use_id===id);
    if(block)return {block,event};
  }
  return null;
}

export function nativeWitnessMatches(use,witness){
  if(!witness?.result||use.id!==witness.id||use.name!==witness.tool)return false;
  const normalize=input=>use.name==='Read'?{...input,file_path:path.resolve(witness.cwd,input.file_path),offset:input.offset??1,limit:input.limit??2000}
    :{...input,args:input.args??''};
  try{return isDeepStrictEqual(normalize(use.input),normalize(witness.input));}catch{return false;}
}
