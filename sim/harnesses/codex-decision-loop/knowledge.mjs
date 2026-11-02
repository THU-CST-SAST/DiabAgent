import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyNativeSkillEdition,NATIVE_CONTROL_PLAYBOOK_ASSETS} from '../claude-code-decision-loop/native-skill.mjs';
import {evaluateNativeRead} from '../claude-code-decision-loop/native-read-hook.mjs';

export const CODEX_KNOWLEDGE_TOOLS=[
  {name:'Read',description:'Read a pinned glucose-management Skill Markdown file. Offsets and limits are line-based. Only the registered knowledge files may be read.',input_schema:{type:'object',properties:{file_path:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}},required:['file_path'],additionalProperties:false}},
  {name:'Skill',description:'Load the pinned glucose-management Skill entry. This does not read the detailed references.',input_schema:{type:'object',properties:{skill:{type:'string'},args:{type:'string'}},required:['skill'],additionalProperties:false}}
];
export function codexNativeSkillCatalog(knowledge){
  const entry=fs.readFileSync(knowledge.path,'utf8'),description=entry.match(/^description: (.+)$/m)?.[1];assert(description);
  return ['<skills_instructions>','## Skills',
    'A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and a short path that can be expanded into an absolute path using the skill roots table.',
    '### Skill roots','- `r0` = `'+path.dirname(knowledge.root)+'`','### Available skills',
    '- blood-glucose-management: '+description+' (file: r0/blood-glucose-management/SKILL.md)','</skills_instructions>'].join('\n');
}
export function codexKnowledgeResult(config,state,{id,name,input}){
  const decision=evaluateNativeRead(config,state,{tool_use_id:id,tool_name:name,tool_input:input});
  if(!decision.allowed)return {success:false,text:decision.reason};
  const entry=fs.readFileSync(config.skill_root+'/SKILL.md','utf8');
  if(name==='Skill')return {success:true,text:'Base directory for this skill: '+config.skill_root+'\n\n'+entry.replace(/^---\n[\s\S]*?\n---\n/,'').trim()+'\n'};
  const lines=fs.readFileSync(config.skill_root+'/'+decision.path,'utf8').split('\n');
  const text=lines.slice(decision.offset_lines-1,decision.offset_lines-1+decision.limit_lines).join('\n');
  assert.equal(text.length,decision.characters);return {success:true,text};
}
export function installCodexKnowledge(root,assetsRoot){
  const manifest=JSON.parse(fs.readFileSync(assetsRoot+'/source.json'));
  verifyNativeSkillEdition(manifest);assert.equal(manifest.sha256,NATIVE_CONTROL_PLAYBOOK_ASSETS);
  const target=root+'/home/skills/blood-glucose-management';fs.mkdirSync(target,{recursive:true});
  const destination=fs.realpathSync(target);
  for(const [rel,digest] of Object.entries(manifest.files)){
    assert(rel.endsWith('.md')&&!rel.split('/').includes('..')&&!path.isAbsolute(rel));
    const from=fs.realpathSync(assetsRoot+'/'+manifest.directory+'/'+rel);
    assert(from.startsWith(fs.realpathSync(assetsRoot)+path.sep));
    const bytes=fs.readFileSync(from);assert.equal(createHash('sha256').update(bytes).digest('hex'),digest);
    fs.mkdirSync(path.dirname(destination+'/'+rel),{recursive:true});fs.writeFileSync(destination+'/'+rel,bytes);
  }
  const config={skill_name:'sweetbench-glucose:blood-glucose-management',skill_root:destination,files:manifest.files,assets_sha256:manifest.sha256,max_reads:3},state={attempts:[]};
  fs.writeFileSync(root+'/KNOWLEDGE-REGISTRATION.json',JSON.stringify({...config,source:assetsRoot,native_entry_mode:'explicit Codex skill input',reference_reader:'dynamic Read with original evaluateNativeRead policy',entry_bytes_changed:false,reference_bytes_changed:false},null,2));
  const persist=()=>fs.writeFileSync(root+'/NATIVE-KNOWLEDGE-LEDGER.json',JSON.stringify(state,null,2));persist();
  let inheritedRoot=null;
  return {path:destination+'/SKILL.md',root:destination,config,manifest,state,
    inherit({ledger,knowledge}){
      assert.equal(state.attempts.length,0);assert.equal(knowledge.assets_sha256,config.assets_sha256);
      for(const [file,digest]of Object.entries(config.files))assert.equal(createHash('sha256').update(fs.readFileSync(knowledge.skill_root+'/'+file)).digest('hex'),digest);
      assert(ledger.attempts.filter(a=>a.tool==='Read'&&a.allowed).length<=3);
      inheritedRoot=fs.realpathSync(knowledge.skill_root);state.attempts=structuredClone(ledger.attempts);persist();
      fs.writeFileSync(root+'/INHERITED-KNOWLEDGE.json',JSON.stringify({source_root:inheritedRoot,original_ledger:ledger,budget_reset:false},null,2));
    },
    execute({id,name,input}){
      const source=inheritedRoot&&name==='Read'&&input.file_path?.startsWith(inheritedRoot+path.sep)?inheritedRoot:destination;
      if(source!==destination)for(const [file,digest]of Object.entries(config.files))assert.equal(createHash('sha256').update(fs.readFileSync(source+'/'+file)).digest('hex'),digest);
      const result=codexKnowledgeResult({...config,skill_root:source},state,{id,name,input});persist();return result;
    }};
}
