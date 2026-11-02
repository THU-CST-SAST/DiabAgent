import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {reviseClosedLoopSkill} from './revise-closed-loop-skill.mjs';
import {verifySkillAssets,hash} from './skill-assets.mjs';

export const HARDWARE_REFERENCE='references/16-benchmark-hardware-operations.md';
export function reviseHardwareSkill(destination) {
  const parent=reviseClosedLoopSkill(destination),base=path.join(destination,parent.directory);
  const reference=fs.readFileSync(fileURLToPath(new URL('../../skills/revisions/hardware-operations-v1.md',import.meta.url)),'utf8');
  fs.writeFileSync(path.join(base,HARDWARE_REFERENCE),reference,{flag:'wx'});
  const routing=`\n## 本实验硬件操作检索\n\n本实验笔和泵的操作效果、适用情境与限制可查阅 [硬件操作参考](${HARDWARE_REFERENCE})，并以当前观测的动作表和参数为准。\n`;
  for(const rel of ['SKILL.md','references/00-retrieval-index.md'])fs.appendFileSync(path.join(base,rel),routing);
  const files={};for(const rel of [...Object.keys(parent.files),HARDWARE_REFERENCE])files[rel]=hash(fs.readFileSync(path.join(base,rel)));
  const manifest={...parent,files,sha256:hash(JSON.stringify(files)),derivation:{...parent.derivation,
    version:'sweet-sim.skill-hardware-reference/v1',parent_assets_sha256:parent.sha256,
    hardware_reference:HARDWARE_REFERENCE,hardware_reference_sha256:hash(reference),
    added_runtime_reference_files:[HARDWARE_REFERENCE],separate_prompt_extension:false,
    authority:'User requires detailed backend operations in a separate reference, entrypoint routing only.'}};
  fs.writeFileSync(path.join(destination,'source.json'),JSON.stringify(manifest,null,2)+'\n');
  verifySkillAssets(destination);return manifest;
}
