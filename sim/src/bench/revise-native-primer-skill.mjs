import fs from 'node:fs';
import path from 'node:path';
import {reviseNativeSimulationSkill} from './revise-native-simulation-skill.mjs';
import {buildNativeKnowledgePrimer,buildNativeOperationalPrimer} from './native-knowledge-primer.mjs';
import {verifySkillAssets,hash} from './skill-assets.mjs';

/** Offline edition; scientific deployment requires a separate frozen registration. */
export function reviseNativePrimerSkill(destination,{operational=false}={}){
  const parent=reviseNativeSimulationSkill(destination);
  const root=path.join(destination,parent.directory);
  const read=name=>fs.readFileSync(path.join(root,name),'utf8');
  const build=operational?buildNativeOperationalPrimer:buildNativeKnowledgePrimer;
  const candidate=build({entry:read('SKILL.md'),
    loopReference:read('references/07-pump-basal-bolus-and-closed-loop.md'),
    hardwareReference:read('references/16-benchmark-hardware-operations.md'),
    ...(operational?{sensorReference:read('references/04-cgm-agp-and-pattern-analysis.md'),
      correctionReference:read('references/05-insulin-corrections-and-hypoglycemia.md')}:{})});
  fs.writeFileSync(path.join(root,'SKILL.md'),candidate.text);
  const files={...parent.files,'SKILL.md':hash(candidate.text)};
  const manifest={...parent,files,sha256:hash(JSON.stringify(files)),derivation:{
    version:`sweet-sim.skill-native-primer/candidate-v${operational?2:1}`,parent_assets_sha256:parent.sha256,
    original_entry_sha256:parent.files['SKILL.md'],parent_derivation:parent.derivation,
    modified_existing_files:['SKILL.md'],unchanged_reference_files:Object.keys(files).filter(f=>f!=='SKILL.md'),
    mandatory_reference_reads:false,separate_prompt_extension:false,primer:candidate.manifest},
    usage:'Offline native Skill primer candidate. No registered scientific deployment or model-effect evidence. References unchanged.'};
  fs.writeFileSync(path.join(destination,'source.json'),JSON.stringify(manifest,null,2)+'\n');
  verifySkillAssets(destination);
  return manifest;
}
