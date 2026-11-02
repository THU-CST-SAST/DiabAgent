// Builds the frozen OpenDiabet set as a sweet-sim.benchmark/v1 directory (docs/BENCH.zh-CN.md §8)
// with buildBenchmark: one experiment per track (opendiabet-v1-full, opendiabet-v1-assisted) over the
// same environments, merged into one benchmark.json. Next to the Harbor task dirs it writes
//   environments.jsonl   the frozen environment list (env id, factors, mechanics, spec, re-draws)
//   references.json      reference scores per track (written by `references`), tiers, re-draws
//   task-cards/T01.json  the 25 task cards
//   coverage.html, catalog.md
// and an `opendiabet` block in benchmark.json (generator, settings, backends, splits, counts).
import fs from 'node:fs';
import path from 'node:path';
import {buildBenchmark} from '../benchmark/build.mjs';
import {TASKS} from './tasks.mjs';
import {GENERATOR_VERSION,BENCHMARK_NAME,BACKENDS,SETTING_RULES,DEV_TASKS,DEV_BACKENDS,taskIdOf,cardJson} from './generate.mjs';
import {specHash} from './references.mjs';
import {SCORING_VERSION as OPENDIABET_SCORING} from './episodes.mjs';
import {coverageHtml,catalogMd} from './report.mjs';

export const experimentsFor=(name=BENCHMARK_NAME,label='OpenDiabet v1')=>({
  full:{id:`${name}-full`,title:`${label} 全权管理 / full autonomy`,agents:['wait','patient','oref0','causal','oracle','llm:<bench/models/x.json>']},
  assisted:{id:`${name}-assisted`,title:`${label} 辅助管理 / assisted (the person boluses announced meals and treats visible lows)`,
    agents:['wait','oref0','causal','oracle','llm:<bench/models/x.json>']},
});
export const EXPERIMENTS=experimentsFor();
const writeJson=(f,d)=>{fs.mkdirSync(path.dirname(f),{recursive:true});const t=`${f}.tmp-${process.pid}`;fs.writeFileSync(t,JSON.stringify(d,null,1)+'\n');fs.renameSync(t,f);};
export const readEnvironments=f=>fs.readFileSync(f,'utf8').split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l));

/** References recorded for exactly these specs: {[track]: {[env_id]: scores}} plus tiers. */
export function loadReferences(outDir,envs) {
  const f=path.join(outDir,'references.json');
  if(!fs.existsSync(f))return {references:{},tiers:{},details:{},redraws:[]};
  const r=JSON.parse(fs.readFileSync(f,'utf8')),ok=new Set(envs.filter(e=>r.spec_sha256?.[e.env_id]===specHash(e.spec)).map(e=>e.env_id));
  const keep=o=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>ok.has(k)));
  return {references:Object.fromEntries(Object.entries(r.tracks??{}).map(([t,x])=>[t,keep(x)])),details:Object.fromEntries(Object.entries(r.details??{}).map(([t,x])=>[t,keep(x)])),
    tiers:keep(r.tiers),redraws:r.redraws??[]};
}

/** name / extraHtml / catalog: the v1.1-hard set passes its own name, hardness section and catalog. */
export function writeSetFiles(outDir,{envs,references={},details={},tiers={},redraws=[],name=BENCHMARK_NAME,extraHtml='',catalog=null}) {
  fs.mkdirSync(path.join(outDir,'task-cards'),{recursive:true});
  for(const t of TASKS)writeJson(path.join(outDir,'task-cards',`${t.id}.json`),cardJson(t));
  fs.writeFileSync(path.join(outDir,'environments.jsonl'),envs.map(e=>JSON.stringify({...e,spec_sha256:specHash(e.spec)})).join('\n')+'\n');
  fs.writeFileSync(path.join(outDir,'coverage.html'),coverageHtml({envs,references,details,redraws,tiers,name,extraHtml}));
  fs.writeFileSync(path.join(outDir,'catalog.md'),catalog??catalogMd({envs,references,tiers,name}));
}

/** Builds (merges) the track experiments into outDir; returns the manifest. */
/**
 * Optional (v1.1-hard): name, version, title, description, generator, label, taskExtra(env, track) ->
 * {scoring_extra, metadata} per task, block (extra fields of the `opendiabet` manifest block).
 *
 * scoringVersion defaults to the one the OpenDiabet references were computed under
 * (src/opendiabet/episodes.mjs), NOT to the METRICS-v0.3 that new Harbor tasks default to. The
 * exported tasks carry those references in their metadata and their verifier normalizes against
 * them, so a task that declared v0.3 while its references were computed under v0.2 would hand the
 * agent a reward on one scale and a normalization on another.
 */
export function buildSetBenchmark({outDir,envs,tracks=['full'],references={},tiers={},redraws=[],onTask=null,
  name=BENCHMARK_NAME,version='1.0',title='OpenDiabet v1: 25 scenario tasks x 4 hardware backends x 2 settings',
  description='RoboTwin-style generated environment set (docs/OPENDIABET-V1.zh-CN.md); full and assisted tracks over the same 200 environments.',
  generator=GENERATOR_VERSION,label='OpenDiabet v1',taskExtra=null,block={},scoringVersion=OPENDIABET_SCORING}) {
  const EXP=experimentsFor(name,label);
  const experiments=tracks.map(track=>({...EXP[track],track,repeats:1,primary_metric:'reward',
    description:`${envs.length} ${label} environments (25 tasks x 4 backends x 2 settings) on the ${track} track, 24 h.`,
    tasks:envs.map(e=>{
      const refs=references[track]?.[e.env_id],x=taskExtra?.(e,track)??{};
      return {task_id:taskIdOf(e.env_id,track),spec:e.spec,hours:24,...(x.scoring_extra?{scoring_extra:x.scoring_extra}:{}),
        factors:{...e.factors,env_id:e.env_id,split:e.split,tier:tiers[e.env_id]??null,unseen_task:e.unseen_task,unseen_backend:e.unseen_backend},
        metadata:{instance_id:e.env_id,env_id:e.env_id,suite:name,generator,task:e.task,title_zh:e.title.zh,title_en:e.title.en,
          task_category:e.category,backend:e.backend,setting:e.setting,seed_index:e.seed_index,attempt:e.attempt,split:e.split,tier:tiers[e.env_id]??null,
          unseen_task:e.unseen_task,unseen_backend:e.unseen_backend,redraws:(e.redraws??[]).length,mechanics_json:JSON.stringify(e.mechanics),
          ...(refs?{references:refs}:{}),...(x.metadata??{})}};
    })}));
  const m=buildBenchmark({name,version,title,description,outDir,experiments,onTask,scoringVersion});
  const file=path.join(outDir,'benchmark.json'),cur=JSON.parse(fs.readFileSync(file,'utf8'));
  cur.opendiabet={generator,environments:envs.length,environments_file:'environments.jsonl',task_cards:'task-cards/',
    references_file:fs.existsSync(path.join(outDir,'references.json'))?'references.json':null,coverage:'coverage.html',catalog:'catalog.md',
    tasks:TASKS.map(t=>({id:t.id,title:t.title,category:t.category})),backends:Object.fromEntries(Object.entries(BACKENDS).map(([k,b])=>[k,{family:b.family,label:b.label,therapy:b.therapy,action_space:b.action_space}])),
    settings:SETTING_RULES,
    splits:{rule:`dev = ${DEV_TASKS[0]}-${DEV_TASKS.at(-1)} x {${DEV_BACKENDS.join(', ')}} (both settings); test = all others; unseen_task = T18-T25, unseen_backend = pump_abs, pump_combo`,
      dev:envs.filter(e=>e.split==='dev').map(e=>e.env_id),test:envs.filter(e=>e.split==='test').map(e=>e.env_id)},
    counts:{dev:envs.filter(e=>e.split==='dev').length,test:envs.filter(e=>e.split==='test').length,unseen_task:envs.filter(e=>e.unseen_task).length,
      unseen_backend:envs.filter(e=>e.unseen_backend).length},
    redraws:redraws.length,track_task_ids:'Harbor task id = lower-case env id; assisted track adds -assisted',...block};
  writeJson(file,cur);
  return cur;
}
