// opendiabet-mvp: experiments 1 (full autonomy) and 2 (assisted) on the SAME 8 instances from the
// bench-v0.2 test split, 24 h, built with buildBenchmark (docs/EXPERIMENTS.zh-CN.md, BENCH §8).
// Instance choice is deterministic and stratified: every observation profile once (alternating
// pump / pens), plus one more real-time-CGM instance on the other device type, so 4 pump + 4 pens;
// within a cell the difficulty tier rotates easy -> medium -> hard (first id wins ties).
import fs from 'node:fs';
import path from 'node:path';
import {buildBenchmark} from './build.mjs';

export const MVP_PROFILES=['cgm_rt','cgm_calibrated','flash_frequent','flash_sparse','smbg_intensive','smbg_standard','smbg_sparse'];
const TIERS=['easy','medium','hard'];

/** Picks n (default 8) test-split instances stratified by observation profile and pump / pens. */
export function pickMvpInstances(instances,{n=8,split='test'}={}) {
  const pool=instances.filter(x=>!split||x.split===split).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const picked=[],used=new Set(),modeCount={pump:0,mdi:0};
  const take=(profile,mode,i)=>{
    const cell=pool.filter(x=>!used.has(x.id)&&x.factors.observation_profile===profile&&x.factors.mode===mode);
    const pick=cell.find(x=>x.tier===TIERS[i%3])??cell[0];
    if(pick){picked.push(pick);used.add(pick.id);modeCount[mode]++;}
    return pick;
  };
  MVP_PROFILES.forEach((p,i)=>{if(picked.length<n){const mode=i%2?'mdi':'pump';take(p,mode,i)??take(p,mode==='pump'?'mdi':'pump',i);}});
  for(let i=0;picked.length<n&&i<MVP_PROFILES.length*2;i++) {
    const mode=modeCount.pump<=modeCount.mdi?'pump':'mdi';
    take(MVP_PROFILES[i%MVP_PROFILES.length],mode,picked.length)??take(MVP_PROFILES[i%MVP_PROFILES.length],mode==='pump'?'mdi':'pump',picked.length);
  }
  return picked;
}

/** Reads a suite's instances.jsonl. */
export function readInstances(file) {
  return fs.readFileSync(file,'utf8').split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l));
}

/**
 * Builds opendiabet-mvp under outDir: exp1-full and exp2-assisted over the same instances.
 * opts: suiteFile (bench-v0.2 instances.jsonl), hours (24), n (8), references (precompute baselines, true).
 */
export function buildMvp({outDir,suiteFile=path.join('artifacts','bench','suites','bench-v0.2','instances.jsonl'),hours=24,n=8,references=true,onTask}={}) {
  const chosen=pickMvpInstances(readInstances(suiteFile),{n});
  const tasks=prefix=>chosen.map(x=>({task_id:`${prefix}-${x.id}`,spec:x.spec,hours,factors:x.factors,
    metadata:{instance_id:x.id,tier:x.tier??null,suite:'bench-v0.2'}}));
  return buildBenchmark({name:'opendiabet-mvp',version:'0.1',title:'OpenDiabet MVP: experiments 1 (full) and 2 (assisted)',
    description:`Same ${chosen.length} bench-v0.2 test instances on both tracks, ${hours} h, stratified by observation profile and pump / pens.`,
    outDir,onTask,experiments:[
      {id:'exp1-full',title:'实验 1 全权管理 / Exp 1 full autonomy',track:'full',repeats:1,references,
        agents:['wait','patient','oref0','causal','oracle','llm:<bench/models/x.json>'],primary_metric:'reward',tasks:tasks('exp1')},
      {id:'exp2-assisted',title:'实验 2 辅助管理 / Exp 2 assisted',track:'assisted',repeats:1,references,
        agents:['wait','oref0','causal','oracle','llm:<bench/models/x.json>'],primary_metric:'reward',tasks:tasks('exp2')}]});
}
