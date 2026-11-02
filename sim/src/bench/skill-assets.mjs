import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export const SKILL_PACKAGE_ROOT=fileURLToPath(new URL('../../skills/',import.meta.url));
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Verify only the fixed Markdown inputs, without loading App or Skill executable runtimes. */
export function verifySkillAssets(root=SKILL_PACKAGE_ROOT) {
  const source=JSON.parse(fs.readFileSync(path.join(root,'source.json'),'utf8'));
  if(source.format!=='sweet-sim.skill-source/v1'||source.directory!=='sweet-agent-skill/skills/blood-glucose-management')throw Error('Unknown Skill source format');
  if(!/^[0-9a-f]{40}$/.test(source.source?.commit??'')||hash(JSON.stringify(source.files))!==source.sha256)throw Error('Skill source manifest mismatch');
  const base=fs.realpathSync(root),skillRoot=fs.realpathSync(path.join(base,source.directory));
  if(!skillRoot.startsWith(base+path.sep))throw Error('Skill source escapes its package');
  for(const [rel,sha] of Object.entries(source.files)) {
    if(rel!=='SKILL.md'&&!/^references\/[A-Za-z0-9._/-]+\.md$/.test(rel))throw Error(`Invalid Skill path: ${rel}`);
    const target=fs.realpathSync(path.resolve(skillRoot,rel));
    if(!target.startsWith(skillRoot+path.sep)||hash(fs.readFileSync(target))!==sha)throw Error(`Pinned Skill file mismatch: ${rel}`);
  }
  for(const rel of ['SKILL.md','references/00-retrieval-index.md','references/11-safety-evidence-and-answer-contract.md'])
    if(!Object.hasOwn(source.files,rel))throw Error(`Missing mandatory Skill file: ${rel}`);
  return {root,skillRoot,source,manifest:{sha256:source.sha256,upstream:{skill:source.source}}};
}

export function freezeSkillAssets(dest) {
  const assets=verifySkillAssets(),to=path.join(dest,'skills');
  fs.mkdirSync(to,{recursive:true});fs.copyFileSync(path.join(assets.root,'source.json'),path.join(to,'source.json'));
  for(const rel of Object.keys(assets.source.files)) {
    const file=path.join(to,assets.source.directory,rel);fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.copyFileSync(path.join(assets.skillRoot,rel),file);
  }
  verifySkillAssets(to);
  return {sha256:assets.source.sha256,files:Object.keys(assets.source.files).length+1,
    upstream:assets.manifest.upstream,mode:'pinned-markdown/no-dsh'};
}
