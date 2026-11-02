// Paired authoring: freeze one world, vary only observations, then test the real agent.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {buildBenchmark} from '../benchmark/build.mjs';
import {buildInstanceConfig} from '../sim/instance.mjs';
import {SimEnv} from '../env/pomdp.mjs';
import {episodeMetrics,episodeScore,trueGrid} from '../bench/score.mjs';
import {mergeLayers} from './generate.mjs';
import {careContext} from '../bench/prompt.mjs';
import {readInvocations} from '../bench/models/trace.mjs';

export const PAIR_FORMAT='opendiabet.information-pairs/v1';
export const hash=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
export const readJson=f=>JSON.parse(fs.readFileSync(f,'utf8'));
export function writeJson(f,x) {fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(x,null,2)+'\n');}
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'
  ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));

export function scoreSummary(scores) {
  if(!scores.length)return {n:0,mean:null,min:null,max:null,sample_sd:null};
  const mean=scores.reduce((a,b)=>a+b,0)/scores.length;
  return {n:scores.length,mean,min:Math.min(...scores),max:Math.max(...scores),
    sample_sd:scores.length>1?Math.sqrt(scores.reduce((sum,x)=>sum+(x-mean)**2,0)/(scores.length-1)):null};
}

export function validatePairCriteria(criteria) {
  if(!criteria||![criteria.complete_min,criteria.partial_max,criteria.min_gap].every(x=>Number.isFinite(x)&&x>=0&&x<=1))
    throw new Error('criteria requires complete_min, partial_max, min_gap in [0,1]');
  for(const key of ['complete_max','partial_min','reference_min'])
    if(criteria[key]!=null&&(!Number.isFinite(criteria[key])||criteria[key]<0||criteria[key]>1))throw new Error(`criteria.${key} must be in [0,1]`);
  if(criteria.complete_min>(criteria.complete_max??1)||(criteria.partial_min??0)>criteria.partial_max)
    throw new Error('criteria score bands are reversed');
  if(!['all','mean'].includes(criteria.aggregation??'all'))throw new Error('criteria.aggregation must be all or mean');
  if(criteria.repeats!=null&&(!Number.isInteger(criteria.repeats)||criteria.repeats<1))throw new Error('criteria.repeats must be a positive integer');
  return criteria;
}

export function differences(a,b,prefix='') {
  if(same(a,b))return [];
  if(a&&b&&typeof a==='object'&&typeof b==='object')return [...new Set([...Object.keys(a),...Object.keys(b)])]
    .sort().flatMap(k=>differences(a[k],b[k],prefix?`${prefix}.${k}`:k));
  return [prefix];
}

// These fields affect notices/readings, never physiological parameters or delivered treatment.
const OBSERVATION_PATHS=[/^scenario\.masking\./,/^scenario\.announcement\./,
  /^scenario\.meals\.[^.]+\.announce_probability$/,
  /^scenario\.(activity|anaerobic)\.(announced|advance_notice_minutes)$/,
  /^scenario\.(alcohol|illness|sleep_loss)\.announced$/,
  /^scenario\.extra_events\.\d+\.(announced|announced_grams)$/,
  /^initial_state\.history\.\d+\.announced_grams$/,
  /^cgm\.(error_scale|error_draw|forced_gaps|compression_lows|sensor_age_days_at_start|calibration_overdue_at_start)(\.|$)/,
  /^meter\.routine_times(\.|$)/];

/** A control uses an explicit plan, not a policy reacting to different observations. */
export function playPlan(spec,hours,plan=[]) {
  const env=new SimEnv(buildInstanceConfig({...spec,self_care:'none',horizon_minutes:Math.round(hours*60)}));
  const sorted=[...plan].sort((a,b)=>a.at_minute-b.at_minute);let next=0;
  const receipts=[];
  for(const p of sorted)if(!Number.isInteger(p.at_minute)||p.at_minute<0||p.at_minute>=hours*60||p.at_minute%5)
    throw new Error('reference_plan times must be 5-minute grid points inside the horizon');
  if(new Set(sorted.map(p=>p.at_minute)).size!==sorted.length)throw new Error('reference_plan has simultaneous actions');
  while(!env.done()) {
    const o=env.observe(),p=sorted[next];
    const action=p&&p.at_minute<=o.elapsed_minutes?(next++,p.action):{type:'WAIT'};
    const result=env.step({action_id:`control-${env.step_count}`,expected_step:env.step_count,action});
    if(action.type!=='WAIT')receipts.push({at_minute:o.elapsed_minutes,action,result:result.info.action_result});
  }
  const bundle=env.exportBundle(),metrics=episodeMetrics(bundle),s=episodeScore(metrics);
  return {score:s.score,raw_score:s.raw,safety_fail:s.safety_fail,glucose:metrics.glucose,receipts,
    true_grid_sha256:hash(trueGrid(bundle)),bundle};
}

/** Accept a pair supplied by an owner, or generate it from base_spec plus named settings. */
export function recipePair(recipe,setting='partial') {
  if(!/^[a-z0-9][a-z0-9._-]*$/.test(recipe.id??''))throw new Error('recipe.id must be slug-safe');
  if(!(recipe.hours>0&&recipe.hours<=168))throw new Error(`${recipe.id}: hours must be in (0, 168]`);
  const variant=name=>{
    if(recipe.base_spec) {
      const s=recipe.settings?.[name];if(!s)throw new Error(`${recipe.id}: missing setting ${name}`);
      const spec=structuredClone(recipe.base_spec);
      spec.overrides=mergeLayers(spec.overrides??{},s.overrides??{});
      if(s.care_context!==undefined)spec.care_context=s.care_context;
      return spec;
    }
    const spec=recipe[name]?.spec;if(!spec)throw new Error(`${recipe.id}: missing ${name}.spec`);
    return structuredClone(spec);
  };
  const complete=variant('complete'),partial=variant(setting);
  for(const s of [complete,partial]){careContext(s.care_context);s.self_care='none';s.horizon_minutes=Math.round(recipe.hours*60);}
  return {complete,partial};
}

export function inspectPair(recipe,{setting='partial',referenceMin}={}) {
  const pair=recipePair(recipe,setting),a=buildInstanceConfig(pair.complete),b=buildInstanceConfig(pair.partial);
  if(a.self_care.mode!=='none'||b.self_care.mode!=='none')throw new Error(`${recipe.id}: paired full-autonomy tasks cannot enable self-care through overrides`);
  const changed=differences(a,b),illegal=changed.filter(p=>!OBSERVATION_PATHS.some(r=>r.test(p)));
  if(illegal.length)throw new Error(`${recipe.id}: changes outside observation settings: ${illegal.join(', ')}`);
  if(!changed.length&&pair.complete.care_context===pair.partial.care_context)throw new Error(`${recipe.id}: variants are identical`);
  if(!same(new SimEnv(a).observe().action_specs,new SimEnv(b).observe().action_specs))throw new Error(`${recipe.id}: action spaces differ`);
  const waitA=playPlan(pair.complete,recipe.hours),waitB=playPlan(pair.partial,recipe.hours);
  const ga=trueGrid(waitA.bundle),gb=trueGrid(waitB.bundle);
  const maxDelta=ga.length===gb.length?Math.max(0,...ga.map((p,i)=>p.m===gb[i].m?Math.abs(p.g-gb[i].g):Infinity)):Infinity;
  // Notice boundaries can split an integration step; tolerate only floating-point roundoff.
  if(maxDelta>1e-6)throw new Error(`${recipe.id}: same-action physiological trajectories differ (${maxDelta} mg/dL)`);
  if(!Array.isArray(recipe.reference_plan)||!recipe.reference_plan.length)throw new Error(`${recipe.id}: reference_plan required`);
  const refA=playPlan(pair.complete,recipe.hours,recipe.reference_plan),refB=playPlan(pair.partial,recipe.hours,recipe.reference_plan);
  if([...refA.receipts,...refB.receipts].some(r=>r.result?.status!=='applied'))throw new Error(`${recipe.id}: reference plan contains a rejected action`);
  if(referenceMin!=null&&refA.score<referenceMin)throw new Error(`${recipe.id}: reference score ${refA.score} < ${referenceMin}`);
  if(Math.abs(refA.score-refB.score)>1e-12)throw new Error(`${recipe.id}: reference score changes with observation settings`);
  const compact=({bundle,...x})=>x;
  return {pair,changed,world_matched:true,controls:{matched_world_max_delta_mg_dl:maxDelta,complete_wait:compact(waitA),partial_wait:compact(waitB),
    complete_reference:compact(refA),partial_reference:compact(refB)},bundles:{complete_wait:waitA.bundle,partial_wait:waitB.bundle,
    complete_reference:refA.bundle,partial_reference:refB.bundle}};
}

/** Hash all frozen runnable task files, including the verifier and oracle. */
export function treeHash(dir) {
  const h=createHash('sha256');
  const walk=(d,relative='')=>{
    for(const name of fs.readdirSync(d).sort()) {
      const f=path.join(d,name),rel=path.join(relative,name),s=fs.lstatSync(f);
      if(s.isSymbolicLink())throw new Error(`symlink not allowed in a frozen task: ${f}`);
      if(s.isDirectory())walk(f,rel);else {h.update(rel+'\0');h.update(fs.readFileSync(f));h.update('\0');}
    }
  };walk(dir);return h.digest('hex');
}

export function buildPairs({source,outDir,setting='partial',name='opendiabet-information-pairs',criteria}) {
  if(fs.existsSync(path.join(outDir,'pairs.json')))throw new Error('Frozen pair directory already exists; use a new candidate version directory');
  const recipes=Array.isArray(source)?source:source.recipes;
  if(!Array.isArray(recipes)||!recipes.length)throw new Error('source must contain recipes');
  validatePairCriteria(criteria);
  const prepared=recipes.map(recipe=>({recipe,...inspectPair(recipe,{setting,referenceMin:criteria.reference_min??criteria.complete_min})}));
  const tasks=prepared.flatMap(({recipe,pair})=>Object.entries(pair).map(([variant,spec])=>({
    task_id:`${recipe.id}-${variant}`,spec,hours:recipe.hours,metadata:{pair_id:recipe.id,information_variant:variant},
    factors:{pair_id:recipe.id,information_variant:variant,information_setting:variant==='complete'?'complete':setting}})));
  buildBenchmark({name,version:'1',outDir,experiments:[{id:'information-pairs',title:'Matched information variants',track:'full',tasks}]});
  const manifest={format:PAIR_FORMAT,created:new Date().toISOString(),setting,criteria,source_sha256:hash(canonical(source)),
    note:'Repeated model draws use repeat=0: identical episode seed and world. These are selected stress tests, not a population success-rate estimate.',
    pairs:prepared.map(({recipe,changed,controls,bundles})=>{
      const evidence=path.join(outDir,'evidence',recipe.id);
      writeJson(path.join(evidence,'recipe.json'),recipe);writeJson(path.join(evidence,'controls.json'),controls);
      for(const [key,bundle] of Object.entries(bundles))writeJson(path.join(evidence,`${key}.bundle.json`),bundle);
      return {id:recipe.id,title:recipe.title,mechanism:recipe.mechanism,hours:recipe.hours,source_provenance:recipe.source_provenance,
        observation_changes:changed,care_context_changed:recipePair(recipe,setting).complete.care_context!==recipePair(recipe,setting).partial.care_context,
        world_matched:true,controls,variants:Object.fromEntries(['complete','partial'].map(v=>{
          const id=`${recipe.id}-${v}`;return [v,{task_id:id,dir:`tasks/${id}`,sha256:treeHash(path.join(outDir,'tasks',id))}];
        }))};
    })};
  writeJson(path.join(outDir,'pairs.json'),manifest);return manifest;
}

export function verifyFrozenPairs(dir) {
  const m=readJson(path.join(dir,'pairs.json'));
  if(m.format!==PAIR_FORMAT)throw new Error('Unsupported pair manifest');
  for(const p of m.pairs)for(const [v,t] of Object.entries(p.variants))
    if(treeHash(path.join(dir,t.dir))!==t.sha256)throw new Error(`${p.id}/${v}: frozen task changed`);
  return m;
}

/** Frozen criteria select all-draw bounds (default) or declared mean bands; invalid runs never qualify. */
export function assessPairs(dir,jobs,{draws,model,effort}={}) {
  const manifest=verifyFrozenPairs(dir),criteria=manifest.criteria;
  validatePairCriteria(criteria);
  if(!Number.isInteger(draws)||draws<1)throw new Error('draws must be a positive integer');
  draws=Math.max(draws,criteria.repeats??1);
  if(new Set(jobs.map(j=>path.resolve(j))).size!==jobs.length)throw new Error('Duplicate jobs are not independent draws');
  const records=[];
  const responseIds=new Set(),drawTasks=new Set();
  for(const job of jobs) {
    const binding=readJson(path.join(job,'pair-binding.json'));
    if(binding.pairs_sha256!==hash(fs.readFileSync(path.join(dir,'pairs.json'),'utf8')))throw new Error(`${job}: wrong paired version`);
    if(binding.model!==model||binding.effort!==effort)throw new Error(`${job}: target model/effort differs from the frozen job binding`);
    for(const entry of fs.readdirSync(job)) {
      const f=path.join(job,entry,'trial.json');if(!fs.existsSync(f))continue;
      const r=readJson(f);if(!r.agent.startsWith('llm:'))continue;
      const drawTask=`${path.resolve(job)}\0${r.task_id}`;
      if(drawTasks.has(drawTask))throw new Error(`${job}: duplicate task in one independent draw: ${r.task_id}`);
      drawTasks.add(drawTask);
      const configFile=path.join(job,entry,'agent','model.json');
      const cfg=fs.existsSync(configFile)?readJson(configFile):{};
      if(fs.existsSync(configFile)&&binding.model_config_sha256!==hash(cfg))throw new Error(`${job}/${entry}: model configuration differs from the frozen job binding`);
      const traceFile=path.join(job,entry,'agent','invocations.jsonl');
      const trace=readInvocations(traceFile,{strict:true});
      const requests=trace.map(x=>x.request),responses=trace.filter(x=>!x.error&&x.response?.raw).map(x=>x.response.raw);
      const actualModelVerified=responses.length>0&&responses.every(x=>x.model===model&&x.id&&x.status==='completed'
        &&(effort==null||x.reasoning?.effort===effort))
        &&requests.length>0&&requests.every(x=>x?.model===model&&x.reasoning_effort===effort)
        &&trace.every(x=>x.response||x.error);
      for(const response of responses)if(response.id) {
        if(responseIds.has(response.id))throw new Error(`Reused API response id: ${response.id}`);
        responseIds.add(response.id);
      }
      records.push({...r,evidence:path.join(job,entry),actual_model_verified:actualModelVerified,
        model:cfg.model,effort:r.agent_options?.reasoning_effort??cfg.reasoning_effort});
    }
  }
  const pairs=manifest.pairs.map(p=>{
    const variants=Object.fromEntries(Object.entries(p.variants).map(([v,t])=>{
      const attempts=records.filter(r=>r.task_id===t.task_id);
      const valid=attempts.filter(r=>r.status==='done'&&r.repeat===0&&!r.scored_with_fill&&r.reward?.agent_completed===1
        &&r.reward?.verifier_wait_steps===0&&r.model===model&&r.effort===effort&&r.actual_model_verified&&Number.isFinite(r.reward.reward));
      return [v,{scores:valid.map(r=>r.reward.reward),valid:valid.length,attempts:attempts.length,
        summary:scoreSummary(valid.map(r=>r.reward.reward)),
        evidence:attempts.map(r=>({dir:r.evidence,status:r.status,reward:r.reward,model:r.model,effort:r.effort,
          actual_model_verified:r.actual_model_verified,prior_attempts:r.attempts}))}];
    }));
    const c=variants.complete.scores,s=variants.partial.scores;
    const enough=c.length>=draws&&s.length>=draws&&variants.complete.attempts===c.length&&variants.partial.attempts===s.length;
    const worstGap=c.length&&s.length?Math.min(...c)-Math.max(...s):null;
    const meanGap=c.length&&s.length?variants.complete.summary.mean-variants.partial.summary.mean:null;
    const meanMode=criteria.aggregation==='mean',cs=meanMode?[variants.complete.summary.mean]:c,ss=meanMode?[variants.partial.summary.mean]:s;
    const gap=meanMode?meanGap:worstGap;
    const qualified=enough&&cs.every(x=>x>=criteria.complete_min&&x<=(criteria.complete_max??1))
      &&ss.every(x=>x>=(criteria.partial_min??0)&&x<=criteria.partial_max)&&gap>=criteria.min_gap;
    return {id:p.id,title:p.title,variants,min_gap:worstGap,mean_gap:meanGap,qualification_gap:gap,
      qualified_for_review:qualified,state:qualified?'qualified_for_review':enough?'needs_iteration':'pending_valid_rollouts'};
  });
  return {format:'opendiabet.pair-assessment/v1',created:new Date().toISOString(),model,effort,draws,criteria,
    pairs_sha256:hash(fs.readFileSync(path.join(dir,'pairs.json'),'utf8')),pairs,qualified:pairs.filter(p=>p.qualified_for_review).length,
    accepted:0,note:'Independent review and final validation are still required for acceptance.'};
}

/** Recompute rewards from the recorded truth using each task's frozen scorer. */
export async function auditPairRollouts(dir,assessment) {
  const manifest=verifyFrozenPairs(dir),checks=[];
  if(assessment.pairs_sha256!==hash(fs.readFileSync(path.join(dir,'pairs.json'),'utf8')))throw new Error('Assessment belongs to a different frozen version');
  for(const pair of assessment.pairs) {
    const definition=manifest.pairs.find(p=>p.id===pair.id);if(!definition)throw new Error(`Unknown pair ${pair.id}`);
    for(const [variant,result] of Object.entries(pair.variants)) {
      const taskDir=path.join(dir,definition.variants[variant].dir);
      const instance=readJson(path.join(taskDir,'environment/sim/instance.json'));
      // Audit against the frozen resolved configuration, never today's simulator implementation.
      const expected=instance.config;
      if(!expected)throw new Error(`${taskDir}: missing frozen instance configuration`);
      const score=await import(pathToFileURL(path.resolve(taskDir,'environment/sim/app/src/bench/score.mjs')).href);
      const scoring=readJson(path.join(taskDir,'tests/scoring.json'));
      for(const run of result.evidence) {
        if(run.status!=='done')continue;
        const trialDir=run.dir,file=path.join(trialDir,'verifier/bundle.json.gz');
        const bundle=JSON.parse(gunzipSync(fs.readFileSync(file)));
        const trial=readJson(path.join(trialDir,'trial.json'));
        const bundleDigest=hash(fs.readFileSync(file));
        if(trial.sim_data?.sha256!==bundleDigest)throw new Error(`${trialDir}: bundle checksum differs from the recorded trial`);
        const configChanges=differences(expected,bundle.manifest.config);
        if(configChanges.length)throw new Error(`${trialDir}: recorded world differs from frozen task: ${configChanges.join(', ')}`);
        if(!bundle.metrics.completed_horizon)throw new Error(`${trialDir}: incomplete bundle`);
        const recomputed=score.episodeScore(score.episodeMetrics(bundle),scoring.weights).score;
        const verifier=readJson(path.join(trialDir,'verifier/reward.json'));
        if(Math.abs(recomputed-run.reward.reward)>1e-12||Math.abs(recomputed-verifier.reward)>1e-12)
          throw new Error(`${trialDir}: recorded reward does not match its true-glucose bundle`);
        if(verifier.agent_completed!==1||verifier.verifier_wait_steps!==0)throw new Error(`${trialDir}: verifier filled the episode`);
        checks.push({pair_id:pair.id,variant,trial_dir:trialDir,reward:recomputed,bundle_sha256:bundleDigest,
          task_sha256:definition.variants[variant].sha256,world_matches:true,score_recomputed:true,agent_completed:true});
      }
    }
  }
  return {format:'opendiabet.pair-rollout-audit/v1',pairs_sha256:assessment.pairs_sha256,checked:checks.length,checks};
}
