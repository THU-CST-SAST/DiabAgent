import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifySkillAssets,hash} from './skill-assets.mjs';

/** Produce a complete revised edition; no independent injected extension or new read tool. */
export function reviseClosedLoopSkill(destination) {
  if(fs.existsSync(destination))throw Error('Never overwrite a Skill edition');
  const original=verifySkillAssets();
  const knowledgeFile=fileURLToPath(new URL('../../skills/revisions/closed-loop-knowledge-v1.md',import.meta.url));
  const knowledge=fs.readFileSync(knowledgeFile,'utf8');
  const entryAddition=`\n## 本实验中的两种闭环算法\n\n本 Skill 的泵与闭环章节已整合 B3 预测性 HCL 和 B4 oref1 / SMB / UAM 的算法知识。完整机制、条件和限制见原有 [07-pump-basal-bolus-and-closed-loop.md](references/07-pump-basal-bolus-and-closed-loop.md)，不需要另一个 Skill 或扩展。\n\nB3 根据新鲜的扰动 CGM 及近期趋势预测30分钟后的风险，先考虑低糖保护，再在 IOB、设备步长、给药间隔及最大基础率约束下判断基础率或部分纠正；餐食、运动、睡眠和输注故障不能忽略。B4 使用公开的 CGM 趋势、胰岛素账本和估计活动、COB 及已报告餐食构造 IOB/COB/UAM 预测，结合有限的 autosens 历史和 SMB 限额，防止胰岛素堆叠；UAM 不是知道隐藏餐食。两者都不是直接读取真值的神谕，也不是完整真实设备固件。\n\n本实验每小时决策时，算法不会在后台每5分钟自动重算。应考虑动作持续时间、临时基础率自然到期、公开 IOB、传感器延迟与风险随时间变化；不能把小剂量乘12、强行延长动作或绕过安全限制。可按原预算使用模拟、历史工具和提前随访/告警订阅。缺失数据不是零；儿童、生病日、疑似输注失败与低糖仍服从本 Skill 原安全契约。上述仅用于合成患者研究，不是临床处方或真实设备操作授权。\n`;
  const changed={
    'SKILL.md':text=>text+'\n'+entryAddition,
    'references/00-retrieval-index.md':text=>text+'\n## 本实验闭环算法检索\n\nB3 HCL、B4 oref1、SMB、UAM、autosens 以及小时决策下的延迟与风险，直接读取已有 `references/07-pump-basal-bolus-and-closed-loop.md` 的新增算法小节。本版没有额外的 Skill 扩展文件或工具。\n',
    'references/07-pump-basal-bolus-and-closed-loop.md':text=>text+'\n\n'+knowledge,
  };
  const files={};
  for(const rel of Object.keys(original.source.files)) {
    let text=fs.readFileSync(path.join(original.skillRoot,rel),'utf8');
    if(changed[rel])text=changed[rel](text);
    const target=path.join(destination,original.source.directory,rel);
    fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);files[rel]=hash(text);
  }
  const manifest={...original.source,files,sha256:hash(JSON.stringify(files)),
    derivation:{version:'sweet-sim.skill-closed-loop-integrated/v1',upstream_assets_sha256:original.source.sha256,
      knowledge_sha256:hash(knowledge),modified_existing_files:Object.keys(changed),
      added_runtime_reference_files:[],separate_prompt_extension:false,
      authority:'Human requires integrating both algorithms into this same Skill, not original-Skill-plus-extension.'},
    usage:'Complete locally revised Skill edition derived from the pinned upstream. Only3existing Markdown files changed; other files unchanged. Upstream attribution/safety/redistribution terms preserved.'};
  fs.writeFileSync(path.join(destination,'source.json'),JSON.stringify(manifest,null,2)+'\n');
  verifySkillAssets(destination);
  return manifest;
}
