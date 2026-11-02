import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {reviseHardwareSkill} from './revise-hardware-skill.mjs';
import {verifySkillAssets,hash} from './skill-assets.mjs';

/** A separate candidate edition; never rewrites the running or installed Skill. */
export function reviseNativeSimulationSkill(destination){
  const parent=reviseHardwareSkill(destination);
  if(parent.sha256!=='03b5ff431902a3767399a90e94ced3c5194bac7b539aa1668ed4b5973e02aa20')throw Error('Unexpected parent knowledge edition');
  const entry=fs.readFileSync(fileURLToPath(new URL('../../skills/revisions/native-simulation-entry-v1.md',import.meta.url)),'utf8');
  const original=path.join(destination,parent.directory,'SKILL.md');
  fs.writeFileSync(original,entry);
  const files={...parent.files,'SKILL.md':hash(entry)};
  const manifest={...parent,files,sha256:hash(JSON.stringify(files)),derivation:{
    ...parent.derivation,version:'sweet-sim.skill-native-simulation-entry/v1',parent_assets_sha256:parent.sha256,
    original_entry_sha256:parent.files['SKILL.md'],modified_existing_files:['SKILL.md'],
    unchanged_reference_files:Object.keys(parent.files).filter(f=>f!=='SKILL.md'),
    separate_prompt_extension:false,mandatory_reference_reads:false,authority:'User asks to make the existing Skill useful through a native harness, without a mandatory read or score gate.'},
    usage:'Synthetic-experiment-only native discovery and entrypoint candidate. All reference bytes unchanged; original and parent editions preserved. Not registered for a real cohort.'};
  fs.writeFileSync(path.join(destination,'source.json'),JSON.stringify(manifest,null,2)+'\n');
  verifySkillAssets(destination);return manifest;
}
