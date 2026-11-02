import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const sha=text=>createHash('sha256').update(text).digest('hex');
function firstParagraph(text,heading){
  const lines=text.replaceAll('\r\n','\n').split('\n');
  const hits=lines.flatMap((line,index)=>line===heading?[index]:[]);
  assert.equal(hits.length,1,'Expected exactly one source heading: '+heading);
  let start=hits[0]+1;
  while(start<lines.length&&!lines[start].trim())start++;
  let end=start;
  while(end<lines.length&&lines[end].trim()&&!/^#{1,6} /.test(lines[end]))end++;
  assert(end>start,'Missing source paragraph: '+heading);
  return lines.slice(start,end).join('\n');
}

// Candidate construction does not register or launch a scientific cohort.
export function buildNativeKnowledgePrimer({entry,loopReference,hardwareReference}){
  const anchor='## Use the Relevant Knowledge';
  assert.equal(entry.split(anchor).length,2,'Expected one unmodified routing anchor');
  assert(!entry.includes('## Native Knowledge Primer'),'Do not duplicate the primer');
  const excerpts=[
    ['references/07-pump-basal-bolus-and-closed-loop.md',loopReference,'## Read the state before choosing an action'],
    ['references/07-pump-basal-bolus-and-closed-loop.md',loopReference,'## B3: simplified predictive hybrid closed loop'],
    ['references/07-pump-basal-bolus-and-closed-loop.md',loopReference,'## B4: oref1 / SMB / UAM-inspired open-source loop'],
    ['references/07-pump-basal-bolus-and-closed-loop.md',loopReference,'## Applying the concepts at hourly decision boundaries'],
    ['references/16-benchmark-hardware-operations.md',hardwareReference,'## Dana-i：延长大剂量']
  ].map(([path,source,heading])=>({path,source_sha256:sha(source),heading,text:firstParagraph(source,heading)}));
  const primer=['## Native Knowledge Primer',
    'These are verbatim excerpts from the existing research references, delivered by native Skill activation. They are not new patient facts, clinical prescriptions, a callable baseline, or an instruction to copy policy thresholds into the task target. Use current public observations and safety limits. The detailed sections remain available through native Read; reading them is optional, with no refusal or score gate.',
    ...excerpts.map(e=>`### ${e.heading.replace(/^## /,'')}\n\n${e.text}\n\nSource: [${e.path}](${e.path}).`)
  ].join('\n\n')+'\n\n';
  const text=entry.replace(anchor,primer+anchor);
  return {text,manifest:{version:'native-knowledge-primer/candidate-v1',entry_parent_sha256:sha(entry),entry_sha256:sha(text),
    excerpts:excerpts.map(({text,...e})=>({...e,excerpt_sha256:sha(text)})),
    scientific_deployment:false,mandatory_reads:false,reference_bytes_changed:false,
    delivery:'Native Skill body only; no system-prompt injection or custom reader',
    evidence_limit:'Receiving these excerpts is distinct from a native Read or proof of improved decisions.'}};
}

function section(text,heading){
  const lines=text.replaceAll('\r\n','\n').split('\n');
  const hits=lines.flatMap((line,index)=>line===heading?[index]:[]);
  assert.equal(hits.length,1,'Expected exactly one source heading: '+heading);
  let end=hits[0]+1;
  while(end<lines.length&&!/^#{1,6} /.test(lines[end]))end++;
  const body=lines.slice(hits[0]+1,end).join('\n').trim();
  assert(body,'Missing source section');return body;
}

export function buildNativeOperationalPrimer(input){
  const base=buildNativeKnowledgePrimer(input);
  const excerpts=[
    ['references/16-benchmark-hardware-operations.md',input.hardwareReference,'## 三种泵共同的控制'],
    ['references/16-benchmark-hardware-operations.md',input.hardwareReference,'## pens：注射与每日负担'],
    ['references/04-cgm-agp-and-pattern-analysis.md',input.sensorReference,'#### “延迟”不等于“不准”']
  ].map(([path,source,heading])=>({path,source_sha256:sha(source),heading,text:section(source,heading)}));
  const caution='但餐后食物仍在吸收，因此不能这样机械外推。';
  assert.equal(input.correctionReference.split(caution).length,2,'Expected exact IOB caveat');
  excerpts.push({path:'references/05-insulin-corrections-and-hypoglycemia.md',source_sha256:sha(input.correctionReference),
    heading:'IOB interpretation caveat from section5.4',text:caution});
  const body=['## Device Operations and Observation Uncertainty',
    'Additional verbatim material from the same references follows. The IOB sentence cautions against mechanically treating all remaining insulin as a future glucose fall while food is still absorbing; it supplies no meal fact or new dose rule. In I2, unreported food remains unknown. Use the actual public observation rather than evaluator truth.',
    ...excerpts.map(e=>`### ${e.heading.replace(/^#{1,6} /,'')}\n\n${e.text}\n\nSource: [${e.path}](${e.path}).`)
  ].join('\n\n')+'\n\n';
  const text=base.text.replace('## Use the Relevant Knowledge',body+'## Use the Relevant Knowledge');
  return {text,manifest:{...base.manifest,version:'native-knowledge-primer/candidate-v2',entry_sha256:sha(text),
    prior_candidate_entry_sha256:base.manifest.entry_sha256,
    excerpts:[...base.manifest.excerpts,...excerpts.map(({text,...e})=>({...e,excerpt_sha256:sha(text)}))]}};
}
