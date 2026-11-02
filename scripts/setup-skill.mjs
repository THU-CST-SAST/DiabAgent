import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {reviseNativePrimerSkill} from '../sim/src/bench/revise-native-primer-skill.mjs';
import {verifySkillAssets,hash} from '../sim/src/bench/skill-assets.mjs';
import {verifyNativeSkillEdition} from '../harnesses/claude-code-decision-loop/native-skill.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const source=JSON.parse(fs.readFileSync(root+'sim/skills/source.json'));
const upstream=root+'sim/skills/sweet-agent-skill';
assert(fs.existsSync(upstream+'/skills'),'Run git submodule update --init --recursive first');
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:upstream,encoding:'utf8'}).trim(),source.source.commit);
verifySkillAssets();
const dest=root+'sim/skills/main212';
if(!fs.existsSync(dest)){
  const temp=dest+'.building-'+process.pid;
  try{
    const assets=reviseNativePrimerSkill(temp,{operational:true});
    const entry=path.join(temp,assets.directory,'SKILL.md');
    const appendix=fs.readFileSync(root+'sim/skills/revisions/control-playbook-v1.md');
    const parent=assets.derivation,original=assets.files['SKILL.md'],parentHash=assets.sha256;
    fs.appendFileSync(entry,appendix);
    assets.files['SKILL.md']=hash(fs.readFileSync(entry));assets.sha256=hash(JSON.stringify(assets.files));
    assets.derivation={version:'sweet-sim.skill-native-control-playbook/v1',parent_assets_sha256:parentHash,
      parent_derivation:parent,original_entry_sha256:original,appendix_sha256:hash(appendix),modified_existing_files:['SKILL.md'],
      unchanged_reference_files:Object.keys(assets.files).filter(f=>f!=='SKILL.md'),mandatory_reference_reads:false,
      separate_prompt_extension:false,synthetic_research_only:true,outcome_informed:true};
    verifyNativeSkillEdition(assets);
    fs.writeFileSync(temp+'/source.json',JSON.stringify(assets,null,2)+'\n');verifySkillAssets(temp);
    fs.renameSync(temp,dest);
  }catch(error){fs.rmSync(temp,{recursive:true,force:true});throw error;}
}
const edition=verifySkillAssets(dest);verifyNativeSkillEdition(edition.source);
console.log(JSON.stringify({skill:edition.source.sha256,files:Object.keys(edition.source.files).length,model_calls:0}));
