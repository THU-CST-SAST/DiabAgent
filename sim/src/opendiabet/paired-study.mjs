// A frozen family, predeclared worlds and fresh model draws: calibration is separate from confirmation.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {Rng} from '../core/rng.mjs';
import {bootstrapMean} from '../bench/score.mjs';
import {loadModelConfig} from '../bench/models/index.mjs';
import {readInvocations} from '../bench/models/trace.mjs';
import {freezeAgentCode,runJob} from '../benchmark/runner.mjs';
import {buildPairs,verifyFrozenPairs,assessPairs,auditPairRollouts,readJson,writeJson,hash,treeHash,scoreSummary} from './paired-generation.mjs';

export const STUDY_FORMAT='opendiabet.paired-study/v1';
const digest=file=>hash(fs.readFileSync(file));
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const key=value=>JSON.stringify(canonical(value));
const band=(value,name)=>{
  if(!Array.isArray(value)||value.length!==2||!value.every(x=>Number.isFinite(x)&&x>=0&&x<=1)||value[0]>value[1])
    throw new Error(`${name} must be an ordered [minimum, maximum] in [0,1]`);
};

export function validateStudyProtocol(protocol) {
  for(const field of ['complete_mean','partial_mean'])band(protocol?.[field],field);
  for(const field of ['reference_min','world_mean_gap_min','complete_draw_floor','partial_draw_ceiling','within_world_range_max'])
    if(!Number.isFinite(protocol[field])||protocol[field]<0||protocol[field]>1)throw new Error(`${field} must be in [0,1]`);
  for(const field of ['draws_per_variant','confirmation_worlds','max_turns','api_tries'])
    if(!Number.isInteger(protocol[field])||protocol[field]<1)throw new Error(`${field} must be a positive integer`);
  if(protocol.confirmation_worlds<2||protocol.draws_per_variant<2)throw new Error('Confirmation needs multiple worlds and independent draws');
  if(!Number.isInteger(protocol.parameter_seed)||protocol.parameter_seed<0)throw new Error('parameter_seed must be a nonnegative integer');
  return protocol;
}

/** Sample without replacement before model results exist; reserve the supplied development case. */
export function sampleStudyParameters(space,development,{count,seed}) {
  if(!space||typeof space!=='object'||Array.isArray(space)||!Object.keys(space).length)throw new Error('parameterSpace must have finite numeric axes');
  let combinations=[{}];
  for(const name of Object.keys(space).sort()) {
    const values=space[name];
    if(!Array.isArray(values)||!values.length||!values.every(Number.isFinite)||new Set(values).size!==values.length)
      throw new Error(`Invalid parameter axis ${name}`);
    if(combinations.length*values.length>10000)throw new Error('Parameter domain exceeds 10000 combinations');
    combinations=combinations.flatMap(row=>values.map(value=>({...row,[name]:value})));
  }
  if(!combinations.some(row=>key(row)===key(development)))throw new Error('developmentParameters is outside the declared domain');
  const candidates=combinations.filter(row=>key(row)!==key(development));
  if(candidates.length<count)throw new Error('Not enough distinct held-out parameter combinations');
  const rng=Rng.stream(seed,'paired-study-heldout-parameters');
  for(let i=candidates.length-1;i>0;i--) {
    const j=Math.floor(rng.next()*(i+1));[candidates[i],candidates[j]]=[candidates[j],candidates[i]];
  }
  return candidates.slice(0,count);
}

function criteriaFor(protocol) {
  // Family means are calibrated below; each world separately must retain a meaningful gap.
  return {complete_min:protocol.complete_draw_floor,partial_max:protocol.partial_draw_ceiling,
    min_gap:protocol.world_mean_gap_min,repeats:protocol.draws_per_variant,reference_min:protocol.reference_min,aggregation:'mean'};
}

/** Freeze all inputs once. Owners cannot adapt the confirmation sample after seeing model scores. */
export async function freezeStudy({factoryFile,outDir,protocol,modelConfig}) {
  validateStudyProtocol(protocol);
  if(fs.existsSync(outDir))throw new Error('Study directory already exists; use a new version');
  fs.mkdirSync(outDir,{recursive:true});
  const source=fs.readFileSync(factoryFile),factory=path.join(outDir,'factory.mjs');
  fs.writeFileSync(factory,source);writeJson(path.join(outDir,'protocol.json'),protocol);
  const model=loadModelConfig(modelConfig);
  if(!model.model||!model.reasoning_effort)throw new Error('Study requires an explicit model and reasoning effort');
  if(model.api_key)throw new Error('Use api_key_env; literal credentials cannot enter a study');
  writeJson(path.join(outDir,'model.json'),model);
  const module=await import(pathToFileURL(path.resolve(factory)).href);
  if(typeof module.makeRecipe!=='function')throw new Error('Factory must export makeRecipe(parameters, {id, seed})');
  const parameters=[module.developmentParameters,...sampleStudyParameters(module.parameterSpace,module.developmentParameters,
    {count:protocol.confirmation_worlds,seed:protocol.parameter_seed})];
  const studyTag=hash({factory:hash(source),protocol}).slice(0,12);
  const worlds=parameters.map((params,index)=>{
    const split=index===0?'development':'confirmation',id=`case-${studyTag}-${index.toString().padStart(3,'0')}`;
    // Keep derived seeds compatible with factories and tools using nonnegative signed int32.
    const seed=Number.parseInt(hash(`${protocol.parameter_seed}:${index}`).slice(0,8),16)&0x7fffffff;
    const options={id,seed},recipe=module.makeRecipe(structuredClone(params),options);
    if(key(recipe)!==key(module.makeRecipe(structuredClone(params),options)))throw new Error(`Factory is not deterministic for ${id}`);
    if(recipe.id!==id)throw new Error('Factory must use the neutral assigned id');
    return {id,split,parameters:params,seed,recipe};
  });
  const fingerprints=new Set(),stages={};
  for(const split of ['development','confirmation']) {
    const cases=worlds.filter(w=>w.split===split);
    const pairs=buildPairs({source:{recipes:cases.map(w=>w.recipe)},outDir:path.join(outDir,split),
      name:`information-study-${split}`,criteria:criteriaFor(protocol)});
    for(const pair of pairs.pairs) {
      const fingerprint=pair.controls.complete_wait.true_grid_sha256;
      if(fingerprints.has(fingerprint))throw new Error('Duplicate true world: parameter/seed changes did not produce distinct trajectories');
      fingerprints.add(fingerprint);
      worlds.find(w=>w.id===pair.id).true_grid_sha256=fingerprint;
    }
    stages[split]={dir:split,pairs_sha256:digest(path.join(outDir,split,'pairs.json')),worlds:cases.length,draws:protocol.draws_per_variant};
  }
  // Freeze the agent once for both phases and verify imports outside the development checkout.
  const runtime=path.join(outDir,'runtime');freezeAgentCode(runtime);
  const agentCode=path.join(runtime,'agent-code');
  const imported=spawnSync(process.execPath,['--input-type=module','-e',"await import('./src/benchmark/llm-agent.mjs')"],
    {cwd:agentCode,encoding:'utf8',timeout:30000,env:{PATH:path.dirname(process.execPath)+path.delimiter+(process.env.PATH??''),NODE_PATH:''}});
  if(imported.status!==0)throw new Error(`Frozen agent preflight failed before model launch: ${imported.stderr}`);
  const study={format:STUDY_FORMAT,created:new Date().toISOString(),factory_sha256:hash(source),
    protocol_sha256:digest(path.join(outDir,'protocol.json')),model_config_sha256:hash(model),model:model.model,effort:model.reasoning_effort,
    runtime_sha256:treeHash(agentCode),parameter_space:module.parameterSpace,
    seed_derivation:'first uint32 of SHA-256(parameter_seed:index), masked to nonnegative int32',
    worlds:worlds.map(({recipe,...world})=>world),stages,
    note:'One predeclared development world and a fixed distinct confirmation sample. Existing selection runs are excluded; independent review is required after confirmation.'};
  writeJson(path.join(outDir,'study.json'),study);return study;
}

export function verifyStudy(outDir) {
  const study=readJson(path.join(outDir,'study.json'));
  if(study.format!==STUDY_FORMAT)throw new Error('Unsupported study format');
  for(const [name,expected] of [['factory.mjs',study.factory_sha256],['protocol.json',study.protocol_sha256]])
    if(digest(path.join(outDir,name))!==expected)throw new Error(`Frozen study ${name} changed`);
  const model=readJson(path.join(outDir,'model.json'));
  if(hash(model)!==study.model_config_sha256)throw new Error('Frozen study model configuration changed');
  if(treeHash(path.join(outDir,'runtime/agent-code'))!==study.runtime_sha256)throw new Error('Frozen study agent runtime changed');
  for(const stage of Object.values(study.stages)) {
    const dir=path.join(outDir,stage.dir);verifyFrozenPairs(dir);
    if(digest(path.join(dir,'pairs.json'))!==stage.pairs_sha256)throw new Error('Frozen study pair manifest changed');
  }
  return study;
}

export function summarizeStudyAssessment(assessment,protocol,{stage='confirmation',expectedWorlds,expectedDraws}) {
  const pairs=assessment.pairs,issues=[];
  if(pairs.length!==expectedWorlds)issues.push('world_count');
  const complete=pairs.map(p=>p.variants.complete.scores),partial=pairs.map(p=>p.variants.partial.scores);
  const sufficient=pairs.length===expectedWorlds&&pairs.every(p=>Object.values(p.variants).every(v=>
    v.valid===expectedDraws&&v.attempts===expectedDraws&&v.scores.length===expectedDraws));
  if(!sufficient)issues.push('pending_valid_rollouts');
  const ci=groups=>{
    const result=bootstrapMean(groups,{B:2000,seed:protocol.parameter_seed,label:'paired-study-world-clusters'});
    return {...result,ci95:result.instances<2?[null,null]:result.ci95};
  };
  const summaries={complete:ci(complete),partial:ci(partial)};
  for(const variant of ['complete','partial']) {
    const range=protocol[`${variant}_mean`],mean=summaries[variant].mean;
    if(mean==null||mean<range[0]||mean>range[1])issues.push(`${variant}_mean_outside_band`);
  }
  const worldResults=pairs.map(pair=>{
    const c=scoreSummary(pair.variants.complete.scores),p=scoreSummary(pair.variants.partial.scores);
    const gap=c.n&&p.n?c.mean-p.mean:null,failures=[];
    if(gap==null||gap<protocol.world_mean_gap_min)failures.push('gap');
    if(c.min==null||c.min<protocol.complete_draw_floor)failures.push('complete_floor');
    if(p.max==null||p.max>protocol.partial_draw_ceiling)failures.push('partial_ceiling');
    if(c.n>1&&c.max-c.min>protocol.within_world_range_max+1e-12)failures.push('complete_repeat_range');
    if(p.n>1&&p.max-p.min>protocol.within_world_range_max+1e-12)failures.push('partial_repeat_range');
    if(failures.length)issues.push(`${pair.id}:${failures.join(',')}`);
    return {id:pair.id,complete:c,partial:p,mean_gap:gap,failures};
  });
  const gap=ci(worldResults.map(w=>w.mean_gap==null?[]:[w.mean_gap]));
  return {format:'opendiabet.study-assessment/v1',stage,valid_confirmation:stage==='confirmation'&&sufficient,
    qualified_for_review:stage==='confirmation'&&issues.length===0,calibrated:issues.length===0,
    state:issues.length===0?(stage==='confirmation'?'qualified_for_review':'ready_for_confirmation'):
      sufficient?'needs_iteration':'pending_valid_rollouts',issues,summaries,gap,worlds:worldResults,
    uncertainty:'95% percentile bootstrap resamples whole worlds, keeping model repeats together. Small selected synthetic domains do not establish population or clinical performance.',accepted:0};
}

export async function assessStudy(outDir,stage) {
  const study=verifyStudy(outDir),definition=study.stages[stage];
  if(!definition)throw new Error('stage must be development or confirmation');
  const protocol=readJson(path.join(outDir,'protocol.json')),dir=path.join(outDir,definition.dir);
  const jobs=Array.from({length:definition.draws},(_,i)=>path.join(outDir,'jobs',stage,`draw-${i+1}`));
  const jobsRoot=path.join(outDir,'jobs',stage),studyDigest=digest(path.join(outDir,'study.json'));
  if(fs.existsSync(jobsRoot)&&fs.readdirSync(jobsRoot).some(name=>!jobs.some(job=>path.basename(job)===name)))
    throw new Error('Unexpected jobs in the predeclared study stage');
  for(const [index,job] of jobs.entries())if(fs.existsSync(path.join(job,'pair-binding.json'))) {
    const binding=readJson(path.join(job,'pair-binding.json'));
    if(binding.study_sha256!==studyDigest||binding.stage!==stage||binding.draw!==index+1)
      throw new Error('Job does not belong to the frozen study phase and draw');
    if(treeHash(path.join(job,'agent-code'))!==study.runtime_sha256)throw new Error('Job agent runtime differs from frozen study');
  }
  const assessment=assessPairs(dir,jobs.filter(job=>fs.existsSync(path.join(job,'pair-binding.json'))),
    {draws:definition.draws,model:study.model,effort:study.effort});
  if(stage==='confirmation') {
    const previous=(await assessStudy(outDir,'development')).assessment;
    const ids=source=>new Set(source.pairs.flatMap(pair=>Object.values(pair.variants).flatMap(variant=>variant.evidence.flatMap(run=>{
      const file=path.join(run.dir,'agent/invocations.jsonl');
      return readInvocations(file,{strict:true}).map(call=>call.response?.id).filter(Boolean);
    }))));
    const earlier=ids(previous);
    if([...ids(assessment)].some(id=>earlier.has(id)))throw new Error('Confirmation reuses a development API response');
  }
  const summary=summarizeStudyAssessment(assessment,protocol,{stage,expectedWorlds:definition.worlds,expectedDraws:definition.draws});
  // Recompute recorded scores before allowing either phase to qualify. A saved reward alone
  // must never open confirmation or leave a qualified summary behind after an audit failure.
  const nativeAudit=summary.state==='pending_valid_rollouts'?null:await auditPairRollouts(dir,assessment);
  // Evidence identity must survive archiving or moving a study to another checkout.
  const audit=nativeAudit?{...nativeAudit,path_base:'study_directory',checks:nativeAudit.checks.map(check=>({
    ...check,trial_dir:path.relative(outDir,check.trial_dir).split(path.sep).join('/')
  }))}:null;
  if(audit&&audit.checked!==definition.worlds*definition.draws*2)throw new Error('Native score audit coverage differs from the planned stage');
  return {assessment,audit,summary:{...summary,native_score_audit:audit?{checked:audit.checked,sha256:hash(audit)}:null,
    study_sha256:digest(path.join(outDir,'study.json')),
    pairs_sha256:definition.pairs_sha256,model:study.model,effort:study.effort,planned_jobs:jobs}};
}

/** Run only the predeclared jobs. API/installation failures leave the stage pending and are retained. */
export async function runStudy(outDir,stage,{parallel=2,onTrial}={}) {
  const study=verifyStudy(outDir),definition=study.stages[stage];
  if(!definition)throw new Error('stage must be development or confirmation');
  if(!Number.isInteger(parallel)||parallel<1)throw new Error('parallel must be a positive integer');
  if(stage==='confirmation'&&!(await assessStudy(outDir,'development')).summary.calibrated)
    throw new Error('Development is not calibrated; do not open the confirmation set');
  const protocol=readJson(path.join(outDir,'protocol.json')),modelFile=path.join(outDir,'model.json'),cfg=loadModelConfig(modelFile);
  if(hash(cfg)!==study.model_config_sha256)throw new Error('Environment would change the frozen model configuration');
  const dir=path.join(outDir,definition.dir),jobsDir=path.join(outDir,'jobs',stage);
  process.env.PATH=path.dirname(process.execPath)+path.delimiter+(process.env.PATH??'');
  const allowed=new Set(Array.from({length:definition.draws},(_,i)=>`draw-${i+1}`));
  if(fs.existsSync(jobsDir)&&fs.readdirSync(jobsDir).some(name=>!allowed.has(name)))throw new Error('Unexpected jobs in the predeclared study stage');
  for(let draw=1;draw<=definition.draws;draw++) {
    const jobId=`draw-${draw}`,job=path.join(jobsDir,jobId),runtime=path.join(job,'agent-code');
    const binding={pairs_sha256:definition.pairs_sha256,model:study.model,effort:study.effort,
      model_config_sha256:study.model_config_sha256,study_sha256:digest(path.join(outDir,'study.json')),stage,draw};
    const bindingFile=path.join(job,'pair-binding.json');
    if(fs.existsSync(bindingFile)&&key(readJson(bindingFile))!==key(binding))throw new Error('Study resume binding differs');
    writeJson(bindingFile,binding);
    if(!fs.existsSync(runtime))fs.cpSync(path.join(outDir,'runtime/agent-code'),runtime,{recursive:true});
    if(treeHash(runtime)!==study.runtime_sha256)throw new Error('Job agent runtime differs from frozen study');
    const result=await runJob({benchmarkDir:dir,jobsDir,jobId,agents:[`llm:${modelFile}`],repeats:1,parallel,maxConcurrentLlm:parallel,
      maxAttempts:3,keepSimData:true,agentOptions:{units:'mgdl',maxTurns:protocol.max_turns,
        agentOptions:{reasoning_effort:study.effort},apiTries:protocol.api_tries},onTrial});
    verifyStudy(outDir);
    if(result.incomplete)break;
  }
  const result=await assessStudy(outDir,stage);
  writeJson(path.join(dir,'assessment.json'),result.assessment);writeJson(path.join(outDir,`${stage}-assessment.json`),result.summary);
  if(result.audit)writeJson(path.join(dir,'rollout-audit.json'),result.audit);
  return result.summary;
}
