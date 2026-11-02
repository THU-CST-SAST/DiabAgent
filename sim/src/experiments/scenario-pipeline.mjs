import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {MASK_CASES,FAMILIES,maskedScenario} from './scenario-masks.mjs';
import {merge,MODES,auditScenario} from './scenario-generator.mjs';
import {buildInstanceConfig} from '../sim/instance.mjs';
import {SimEnv} from '../env/pomdp.mjs';
import {buildBenchmark,loadBenchmark} from '../benchmark/build.mjs';
import {runJob} from '../benchmark/runner.mjs';
import {probeModel} from '../benchmark/preflight.mjs';
import {loadModelConfig} from '../bench/models/index.mjs';
import {parseAgentOptions} from '../bench/agent-options.mjs';
import {createPatientProfile} from './patient-profiles.mjs';
import {scenarioCompatibility} from './scenario-compatibility.mjs';
import {adaptAgeQuantities,AGE_QUANTITY_POLICY} from './age-quantities.mjs';

export const PIPELINE_VERSION='sweet-sim.scenario-pipeline/v1';
const digest=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const id=x=>{if(typeof x!=='string'||!/^[a-z][a-z0-9-]*$/.test(x))throw Error(`Expected a lowercase slug, got ${x}`);return x;};
const write=(file,x)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(x,null,2)+'\n');fs.renameSync(tmp,file);};
function axis(values,name,fallback) {
  const rows=values??fallback;
  if(!Array.isArray(rows)||!rows.length)throw Error(`${name} must be a nonempty array`);
  const seen=new Set();
  for(const row of rows){id(row.id);if(seen.has(row.id))throw Error(`Duplicate ${name} id: ${row.id}`);seen.add(row.id);}
  return rows;
}
function seeds(values,name,fallback,{nullable=false}={}) {
  const rows=values??fallback;
  if(!Array.isArray(rows)||!rows.length||rows.some(s=>!(nullable&&s===null)&&(!Number.isSafeInteger(s)||s<0))||new Set(rows).size!==rows.length)
    throw Error(`${name} requires distinct non-negative integer seeds${nullable?' (or null)':''}`);
  return rows;
}
function rejectMaskOverride(o) {
  if(o?.information)throw Error('Information masks belong to the information axis, not patient/hardware/factor overrides');
}

/** Resolve the Cartesian product without any model calls or outcome-based selection. */
export function planScenarioPipeline(config={}) {
  const fields=new Set(['format','name','title','scenarios','patients','hardware','factors','world_seeds','background_seeds','information','hours','on_incompatible','family_names','information_contract','include_own_records','compatibility_contract','world_ids','input_quantity_policy']);
  for(const key of Object.keys(config))if(!fields.has(key))throw Error(`Unknown pipeline configuration field: ${key}`);
  if(config.format&&config.format!==PIPELINE_VERSION)throw Error('Unsupported pipeline format');
  if(config.input_quantity_policy!==undefined&&config.input_quantity_policy!==AGE_QUANTITY_POLICY)throw Error('Unknown input quantity policy');
  const name=id(config.name??'scenario-pipeline');
  const familyNames={...FAMILIES,...config.family_names};
  for(const [key,value] of Object.entries(familyNames))if(!/^[A-Z]$/.test(key)||typeof value!=='string'||!value.trim())throw Error('Invalid event family name');
  const informationContract=config.information_contract??'selective-records/v1';
  if(!['selective-records/v1','carbs-treatment-only/v1'].includes(informationContract))throw Error('Unknown information contract');
  if(config.include_own_records!==undefined&&typeof config.include_own_records!=='boolean')throw Error('include_own_records must be boolean');
  if(config.compatibility_contract!==undefined&&config.compatibility_contract!=='age-device/v1')throw Error('Unknown compatibility contract');
  const scenarios=axis((config.scenarios??MASK_CASES.map(([preset])=>preset)).map(s=>typeof s==='string'?{id:s.toLowerCase(),preset:s}:s),'scenarios',[]);
  const patients=axis(config.patients,'patients',[{id:'adult-reference',patient:{sex:'male',age_years:39,height_cm:170,weight_kg:66}}]);
  const hardware=axis(config.hardware,'hardware',[{id:'dana-guardian',therapy:{mode:'pump',pump:{model:'dana_i',insulin:'aspart'}},sensors:{cgm:'medtronic_guardian_3',meter:'contour_next_one'}}]);
  const factors=axis(config.factors,'factors',[{id:'default',overrides:{}}]);
  const worldSeeds=seeds(config.world_seeds,'world_seeds',[20261017]);
  const backgroundSeeds=seeds(config.background_seeds,'background_seeds',[null],{nullable:true});
  const information=config.information??MODES;
  if(!Array.isArray(information)||!information.length||information.some(m=>!MODES.includes(m))||new Set(information).size!==information.length)throw Error('Invalid information axis');
  const onIncompatible=config.on_incompatible??'error';
  if(!['error','skip'].includes(onIncompatible))throw Error('on_incompatible must be error or skip');
  let selected=null;
  if(config.world_ids!==undefined) {
    if(!Array.isArray(config.world_ids)||!config.world_ids.length)throw Error('world_ids must be a nonempty array');
    selected=new Set(config.world_ids.map(id));
    if(selected.size!==config.world_ids.length)throw Error('Duplicate selected world IDs');
  }
  const matched=new Set();
  const rows=[],rejected=[];
  for(const scene of scenarios)for(const patient of patients)for(const device of hardware)for(const factor of factors)
    for(const seed of worldSeeds)for(const backgroundSeed of backgroundSeeds) {
      const caseId=scene.case_id?id(scene.case_id):[scene.id,patient.id,device.id,factor.id,`s${seed}`,backgroundSeed===null?'bnone':`b${backgroundSeed}`].join('-');
      if(selected&&!selected.has(caseId))continue;
      matched.add(caseId);
      try {
        const generatedPatient=patient.demographics?createPatientProfile(patient.demographics,{seed}):null;
        if(generatedPatient&&patient.person)throw Error('Use demographics or person, not both');
        if(generatedPatient&&Object.keys(patient.patient??{}).some(k=>k!=='initial_glucose_mg_dl'))
          throw Error('Use demographics or explicit patient body fields, not both');
        const preset=scene.preset??scene.base_preset;
        if(!preset&&!scene.spec)throw Error('Custom scenario needs base_preset or an explicit spec');
        if(scene.spec&&(!Array.isArray(scene.spec.overrides?.scenario?.extra_events)||!scene.spec.overrides?.initial_state))
          throw Error('Custom spec must explicitly define overrides.scenario.extra_events and overrides.initial_state');
        for(const o of [scene.overrides,scene.spec?.overrides,patient.overrides,device.overrides,factor.overrides])rejectMaskOverride(o);
        if(backgroundSeed!==null&&scene.spec?.start_time)throw Error('Custom start_time cannot override the paired background-clock seed');
        const base=maskedScenario({preset:preset??'A03',seed,backgroundSeed,hours:config.hours??24,
          patient:patient.patient??{},person:patient.person??null,therapy:device.therapy??{},sensors:device.sensors??{}});
        let spec=base.spec;
        if(scene.exact_spec&&!scene.spec)throw Error('exact_spec requires an explicit spec');
        if(scene.spec)spec=scene.exact_spec?structuredClone(scene.spec):merge(spec,scene.spec);
        // Frozen event templates must not retain another person's demographic fields.
        if(generatedPatient||patient.person) {
          spec.person=generatedPatient?.person??{type:patient.person,sample:false,seed};
          const {sex,age_years,height_cm,weight_kg,...state}=spec.overrides.patient??{};
          spec.overrides={...spec.overrides,patient:state};
        } else if((patient.patient?.sex!==undefined||patient.patient?.age_years!==undefined)
          &&(!Number.isFinite(patient.patient.height_cm)||!Number.isFinite(patient.patient.weight_kg)))
          throw Error('Changing age/sex requires demographics or explicit height_cm and weight_kg');
        for(const o of [scene.overrides,patient.overrides,device.overrides,factor.overrides])if(o) {
          if(generatedPatient&&['sex','age_years','height_cm','weight_kg'].some(k=>Object.hasOwn(o.patient??{},k)))
            throw Error('demographics body fields cannot be replaced by overrides');
          spec=merge(spec,{overrides:o});
        }
        // World identity and observation masks cannot be smuggled in as treatment/event overrides.
        spec={...spec,seed,self_care:'none',therapy:merge(spec.therapy,device.therapy??{}),sensors:merge(spec.sensors,device.sensors??{}),
          overrides:merge(spec.overrides,{patient:patient.patient??{}})};
        let cfg=buildInstanceConfig(spec),quantityProvenance=null;
        if(config.input_quantity_policy) {
          const adapted=adaptAgeQuantities(spec,cfg);
          spec=adapted.spec;quantityProvenance=adapted.provenance;cfg=buildInstanceConfig(spec);
        }
        if(config.compatibility_contract) {
          const reasons=scenarioCompatibility(spec,cfg,{requiresCalibration:scene.requires_calibration});
          if(reasons.length)throw Error(`Incompatible scenario: ${reasons.join(', ')}`);
        }
        const env=new SimEnv(cfg);
        const family=scene.family??base.family;
        if(!Object.hasOwn(familyNames,family))throw Error(`Unknown event family ${family}`);
        if(family==='E'&&cfg.therapy.mode!=='pump')throw Error('Infusion-delivery scenarios require a pump');
        if((preset==='F04'||scene.requires_calibration)&&!env.cgm?.calibration)throw Error('Scenario requires a calibratable CGM');
        const narrativeMeals=spec.overrides.scenario.extra_events.filter(e=>e.type==='record'&&e.category==='meal').map(e=>e.id);
        const rules=informationContract==='carbs-treatment-only/v1'
          ?[{category:'exercise'},{category:'life'},{category:'fault'},...(narrativeMeals.length?[{category:'meal',ids:narrativeMeals}]:[])]
          :scene.partial_rules??base.rules;
        if(!Array.isArray(rules)||!rules.length)throw Error('I1 needs explicit partial_rules');
        const variants=Object.fromEntries(MODES.map(mode=>[mode,merge(spec,{overrides:{information:{mode,policy:'record-derived-v3',rules:mode==='I1'?rules:[],
          ...(config.include_own_records?{own_records:true}:{})}}})]));
        for(const s of Object.values(variants))buildInstanceConfig(s);
        rows.push({preset:caseId,scenario_id:scene.id,title:scene.title??base.title,family,rules,spec,variants,
          evidence:scene.evidence??(scene.spec?['CUSTOM_UNVALIDATED']:base.evidence),
          factors:{scenario:scene.id,patient:patient.id,hardware:device.id,other:factor.id,world_seed:seed,background_seed:backgroundSeed},
          resolved_patient:cfg.patient,resolved_therapy:cfg.therapy,resolved_sensors:{cgm:cfg.cgm.model,meter:cfg.meter.model},
          construction:{...base.construction,protocol:PIPELINE_VERSION,custom:!!(scene.spec||scene.overrides),
            events:spec.overrides.scenario.extra_events,initial_history:spec.overrides.initial_state.history,
            no_outcome_filtering:true,...(generatedPatient?{patient_generation:generatedPatient.provenance}:{}),
            ...(quantityProvenance?{input_quantities:quantityProvenance}:{})}});
      } catch(e){rejected.push({case_id:caseId,scenario:scene.id,patient:patient.id,hardware:device.id,other:factor.id,seed,background_seed:backgroundSeed,reason:e.message});}
    }
  if(selected&&matched.size!==selected.size)throw Error(`Unknown selected world IDs: ${[...selected].filter(x=>!matched.has(x)).join(', ')}`);
  if(rejected.length&&onIncompatible==='error')throw Error(`Incompatible combinations (${rejected.length}); nothing built:\n${rejected.map(r=>`${r.case_id}: ${r.reason}`).join('\n')}`);
  if(!rows.length)throw Error('No valid physical worlds remain');
  if(new Set(rows.map(r=>r.preset)).size!==rows.length)throw Error('Duplicate world IDs; explicit case_id requires unique worlds');
  return {protocol:PIPELINE_VERSION,name,config,information,families:familyNames,rows,rejected,
    counts:{requested_worlds:rows.length+rejected.length,worlds:rows.length,rejected_worlds:rejected.length,tasks:rows.length*information.length},
    config_sha256:digest(config)};
}

export function buildScenarioPipeline(outDir,config,{onProgress=()=>{}}={}) {
  if(fs.existsSync(outDir))throw Error(`No overwrite: ${outDir}`);
  const plan=planScenarioPipeline(config),audits=[];
  for(const row of plan.rows) {
    const audit=auditScenario(row,{requireDistinct:false});
    audit.distinct_information_projections=new Set(Object.values(audit.information_projection_sha256)).size;
    audits.push(audit);onProgress(`Fixed-world audit: ${row.preset}`);
  }
  fs.mkdirSync(path.dirname(path.resolve(outDir)),{recursive:true});
  const staging=fs.mkdtempSync(path.join(path.dirname(path.resolve(outDir)),'.scenario-pipeline-build-'));
  try {
    const manifest=buildBenchmark({name:plan.name,version:'1.0',outDir:staging,title:config.title??'Configurable scenario / patient / hardware benchmark',
      description:'Fixed physical worlds x record visibility, native Harbor act/wait/wake, METRICS-v0.3. No outcome filtering.',
      experiments:plan.information.map(mode=>({id:mode.toLowerCase(),track:'full',references:false,repeats:1,
        tasks:plan.rows.map(r=>({task_id:`${r.preset}-${mode.toLowerCase()}`,spec:r.variants[mode],hours:r.spec.horizon_minutes/60,
          factors:{...r.factors,family:r.family,information:mode},metadata:{instance_id:r.preset,pair_id:r.preset,title_zh:r.title,protocol:PIPELINE_VERSION}}))}))});
    write(path.join(staging,'construction.json'),{...plan,audits});
    write(path.join(staging,'pipeline-config.json'),config);
    fs.renameSync(staging,outDir);
    return {manifest,plan,audits};
  } catch(e){fs.rmSync(staging,{recursive:true,force:true});throw e;}
}

/** Existing runner, adapter, controller and verifier; no new agent or scoring loop. */
export async function runScenarioPipeline({benchmarkDir,jobsDir,runId,models,information=null,parallel=16,modelDraws=1,repeats=1,
  withWait=true,agentOptions={simulate:true,simulate_calls:1},onTrial=null,preflightTries=4,preflightBackoffMs=15000,apiTries=4}) {
  id(runId);
  parseAgentOptions(agentOptions);
  const bench=loadBenchmark(benchmarkDir),registration=read(path.join(benchmarkDir,'construction.json'));
  if(registration.protocol!==PIPELINE_VERSION)throw Error('Expected a scenario-pipeline benchmark');
  const wanted=(information??registration.information).map(m=>m.toLowerCase());
  if(!wanted.length||wanted.some(m=>!bench.experiments.some(e=>e.id===m)))throw Error('Requested information condition not in this benchmark');
  axis(models,'models',[]);
  if(!Number.isInteger(parallel)||parallel<1)throw Error('parallel must be a positive integer');
  if(!Number.isInteger(modelDraws)||modelDraws<1||!Number.isInteger(repeats)||repeats<1)throw Error('draws and repeats must be positive integers');
  if(!Number.isInteger(apiTries)||apiTries<1||apiTries>12)throw Error('apiTries must be an integer in [1,12]');
  if(!Number.isInteger(preflightTries)||preflightTries<1||preflightTries>12)throw Error('preflightTries must be an integer in [1,12]');
  if(!Number.isFinite(preflightBackoffMs)||preflightBackoffMs<0)throw Error('preflightBackoffMs must be finite and non-negative');
  const plans=models.map(m=>({model:m,cfg:loadModelConfig(m.config),jobId:`${runId}-${m.id}`}));
  for(const p of plans)if(p.cfg.max_parallel!==undefined&&(!Number.isInteger(p.cfg.max_parallel)||p.cfg.max_parallel<1))
    throw Error(`Model max_parallel must be a positive integer: ${p.model.id}`);
  const benchmarkSha=digest(fs.readFileSync(path.join(benchmarkDir,'benchmark.json')).toString());
  const options={causalFast:false,units:'mgdl',maxTurns:400,apiTries,agentOptions};
  for(const p of plans) {
    const prior=path.join(jobsDir,p.jobId,'config.json');
    if(fs.existsSync(prior)) {
      const c=read(prior);
      if(c.benchmark_sha256!==benchmarkSha||JSON.stringify(c.agents)!==JSON.stringify([`llm:${p.model.config}`])
        ||JSON.stringify(c.agent_options)!==JSON.stringify(options)||JSON.stringify(c.experiments)!==JSON.stringify(wanted)
        ||c.repeats!==repeats||c.model_draws!==modelDraws)throw Error(`Resume registration mismatch: ${p.jobId}; use a new run id`);
    }
    if(p.cfg.adapter!=='scripted') {
      // Preserve each probe, retrying only transient failures within a finite attempt budget.
      for(let attempt=1;;attempt++) {
        const probeDir=path.join(jobsDir,'.preflight',p.jobId,`${Date.now()}-${attempt}`);
        const probe=await probeModel({modelConfig:p.model.config,outDir:probeDir,maxTokens:1024});
        if(probe.ok)break;
        if(!probe.error?.retryable||attempt>=preflightTries)throw Error(`Model preflight failed: ${p.model.id}; see ${probeDir}`);
        await new Promise(r=>setTimeout(r,preflightBackoffMs*2**(attempt-1)));
      }
    }
  }
  const common={benchmarkDir,jobsDir,repeats,modelDraws,experiments:wanted,parallel,maxConcurrentLlm:parallel,
    keepSimData:true,maxAttempts:3,agentOptions:options,onTrial};
  const runs=plans.map(p=>{
    const n=Math.min(parallel,p.cfg.max_parallel??parallel);
    return runJob({...common,parallel:n,maxConcurrentLlm:n,jobId:p.jobId,agents:[`llm:${p.model.config}`]});
  });
  if(withWait)runs.push(runJob({...common,jobId:`run-${runId}-wait`,agents:['wait'],modelDraws:1,
    experiments:[bench.experiments[0].id],parallel:4}));
  // Do not exit on one arm's failure while another arm still has active trials.
  const settled=await Promise.allSettled(runs);
  const failed=settled.find(r=>r.status==='rejected');if(failed)throw failed.reason;
  return settled.map(r=>r.value);
}
