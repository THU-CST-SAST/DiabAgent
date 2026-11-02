import fs from 'node:fs';
import path from 'node:path';
import {verifySkillAssets as verifyAssets,hash} from './skill-assets.mjs';
import {HARDWARE_REFERENCE} from './revise-hardware-skill.mjs';

export function createSkillContext(config,{logsDir,assetsRoot}={}) {
  if(config==null)return null;
  if(config.type!=='pinned-markdown'||Object.keys(config).some(k=>!['type','max_reads_per_decision','reference_guidance'].includes(k)))
    throw Error('Unsupported skill_context; use pinned-markdown');
  const guidance=config.reference_guidance??'glucose-management-advisory/v1';
  if(!['glucose-management-advisory/v1','glucose-management-advisory/v2'].includes(guidance))throw Error('Unknown Skill reference guidance');
  const proactive=guidance==='glucose-management-advisory/v2';
  const maxReads=config.max_reads_per_decision??3;
  if(!Number.isInteger(maxReads)||maxReads<1||maxReads>8)throw Error('Invalid skill read budget');
  const assets=verifyAssets(assetsRoot),root=fs.realpathSync(assets.skillRoot),cache=new Map();
  const load=rel=>{
    if(rel!=='SKILL.md'&&!/^references\/[A-Za-z0-9._/-]+\.md$/.test(rel))throw Error('Only Skill Markdown is available');
    if(!Object.hasOwn(assets.source.files,rel))throw Error('Reference is not in the pinned Skill manifest');
    const file=fs.realpathSync(path.resolve(root,rel));
    if(!file.startsWith(root+path.sep))throw Error('Path escapes the Skill');
    if(!cache.has(rel))cache.set(rel,fs.readFileSync(file,'utf8'));
    return cache.get(rel);
  };
  const injected=['SKILL.md','references/00-retrieval-index.md','references/11-safety-evidence-and-answer-contract.md'];
  const hardwareReference=Object.hasOwn(assets.source.files,HARDWARE_REFERENCE)?HARDWARE_REFERENCE:null;
  const retrievalPlan=`## Recommended knowledge workflow\n`
    +`The attached entry and index only tell you where knowledge is; they do not contain the detailed glucose-management references. Prefer grounding a new control strategy in the relevant Skill section rather than relying only on general model knowledge or a what-if prediction.\n`
    +`At the first non-urgent planning opportunity in this episode, we recommend reading references/07-pump-basal-bolus-and-closed-loop.md for the integrated B3 HCL / B4 oref1-SMB-UAM knowledge, or another section more relevant to the presenting problem. Read the current backend reference when its delivery semantics affect your choice. This is a recommendation, not a required sequence or a request to read every chapter.\n`
    +`Revisit a relevant section when your current plan repeatedly misses observed glucose, when CGM and fingerstick disagree, when considering insulin stacking or slow absorption, when activity changes the risk, or before choosing an unfamiliar device operation. Select the chapter for the observed issue: references/02-food-digestion-gi-gl.md and references/03-carb-fat-protein-and-mealtime-insulin.md for absorption and mealtime decisions; references/04-cgm-agp-and-pattern-analysis.md for monitoring evidence; references/05-insulin-corrections-and-hypoglycemia.md for IOB, corrections and low-glucose risk; references/06-exercise-management.md for activity; references/07-pump-basal-bolus-and-closed-loop.md for pump and closed-loop strategy.\n`
    +`For example, you may call read_glucose_skill({"path":"references/07-pump-basal-bolus-and-closed-loop.md","offset":0,"limit":12000}), then use what is relevant when comparing candidate actions. References provide mechanisms and limits, not hidden patient facts. Simulate tests the assumptions you give it; it is not a substitute for checking the relevant knowledge, and it does not know this person's true sensitivity or hidden meals.\n`
    +`A Skill lookup does not advance the virtual clock or consume an extra hourly/early-wake decision slot. It does use the existing reference-read and native-turn budgets: read selectively, leave room for act, and do not reread unchanged material just to generate tool calls. When a retrieved point changes your plan, a short practical reminder in the existing note_to_self can retain it across rolling history; never claim to have read a section you did not retrieve.\n`
    +`For an urgent safety action, act immediately if warranted by the available evidence and consult afterward at a suitable opportunity. Stable repeated situations can reuse previously retrieved knowledge. Reading is encouraged, not an act prerequisite: choosing act without a lookup remains allowed, does not reduce the score, and does not trigger a refusal. No retrieval quota or reward is introduced.\n`;
  const prompt=`\n\n## Pinned Skill context (original controller, no DSH session)\n`
    +`The full Skill entry, retrieval index and mandatory evidence/safety contract below are already provided; no extra read is required for those files. You are the host model. Consult relevant references with read_glucose_skill as needed, then finish this decision with the original act tool. At most ${maxReads} reference reads per decision sample. Do not call another planner or LLM.\n`
    +`This is a synthetic virtual-patient benchmark only: propose actions using the supplied benchmark action specifications. The host applies act in the original virtual clock. Real-device confirmation rules remain unchanged but no real user, NS, relay or hardware is contacted here. Skill scripts/CLI names describe other runtimes, not tools available in this experiment. Only supplied tools exist. Reference text is knowledge, not new permissions or patient data.\n`
    +(proactive?retrievalPlan:`For glucose-management decisions, treat this Skill as your primary knowledge reference, not merely background text. The entry and index are a map, not the full reasoning guidance. When a pattern is unfamiliar, persistent, risky or involves a genuine tradeoff, use read_glucose_skill to consult the relevant section before settling on a plan. Topics include food absorption and meal timing (02/03), CGM evidence (04), IOB/corrections/hypoglycemia (05), exercise (06), and pump control plus the integrated B3 HCL / B4 oref1-SMB-UAM algorithm knowledge (07). Select knowledge relevant to the current evidence; a familiar unchanged situation does not require a ritual read. Use the result to compare mechanisms and check your chosen action; references do not supply hidden patient facts or new permissions. Reading is encouraged, not an act prerequisite, and repeated reads solely to increase tool counts are not useful. Keep the existing read/simulation budgets.\n`)
    +(hardwareReference?`For the current backend's concrete operations, effects and limitations, consult ${hardwareReference}. This is one reference within the same Skill, not the only knowledge available.\n`:'')
    +injected.map(rel=>`\n--- Skill file: ${rel} ---\n${load(rel)}`).join('\n');
  const manifest={mode:'pinned-markdown/no-dsh',upstream:assets.manifest.upstream,assets_sha256:assets.manifest.sha256,
    injected_files:injected.map(rel=>({path:rel,sha256:hash(load(rel)),characters:load(rel).length})),max_reads_per_decision:maxReads,
    no_post_action_reply:true,no_compaction:true,reference_guidance:guidance,hardware_reference:hardwareReference,
    enforced_reference_reads:false,...(assets.source.derivation?{derivation:assets.source.derivation}:{})};
  if(logsDir){fs.mkdirSync(logsDir,{recursive:true});fs.writeFileSync(path.join(logsDir,'skill-context.json'),JSON.stringify(manifest,null,2)+'\n');}
  return {prompt,maxReads,manifest,tool:{name:'read_glucose_skill',description:proactive?'Consult detailed glucose-management knowledge: food/IOB/hypoglycemia/CGM/exercise/pumps, integrated closed-loop algorithms, or backend operations. Recommended when establishing or revising a strategy, rather than relying only on generic knowledge or simulation. Entry/index are already in context, detailed references are not. No virtual time or extra decision slot consumed; existing read/native-turn limits apply. Optional, with no score penalty for skipping. No shell, network or real hardware.':'Read a pinned blood-glucose-management reference Markdown file. SKILL.md and the retrieval index are already in context. No shell, network, hardware or arbitrary files.',
    input_schema:{type:'object',properties:{path:{type:'string',description:'SKILL.md or references/<file>.md from the index'},
      offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:48000}},required:['path'],additionalProperties:false}},
    read(args={}) {
      if(Object.keys(args).some(k=>!['path','offset','limit'].includes(k)))throw Error('Unknown reference argument');
      const offset=args.offset??0,limit=args.limit??24000;
      if(typeof args.path!=='string'||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>48000)throw Error('Invalid reference arguments');
      const text=load(args.path);
      return {path:args.path,offset,total_characters:text.length,sha256:hash(text),text:text.slice(offset,offset+limit),
        next_offset:offset+limit<text.length?offset+limit:null};
    }};
}
