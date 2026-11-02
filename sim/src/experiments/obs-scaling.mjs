// Experiment 1 (docs/PLAN-v2.zh-CN.md 实验 1): observation scaling. Paired variants of OpenDiabet v1
// environments along five ladders, one experiment each, in one benchmark
// (artifacts/benchmarks/exp1-obs-scaling):
//
//   exp1a  observation richness  smbg_sparse -> smbg_standard -> smbg_intensive -> flash -> cgm_rt
//          (observation profiles of src/bench/suite.mjs; fixed devices per level: meter = the base
//          environment's meter or contour_next_one; flash = libre_2_scan scanned every 2 h 07-23;
//          real-time CGM = dexcom_g6; CGM levels carry no meter), plus the uncertainty layer
//          (uncertaintyLayer below; plain1a: true builds without it)
//   exp1b  CGM error scale       cgm.error_scale 0 / 0.5 / 1 / 2 on dexcom_g6 with a sampled error
//          draw (src/core/cgm.mjs: scales calibration error, drift, offset, AR noise and lag)
//   exp1c  event masking         scenario.masking (src/core/scenario.mjs applyMasking, the v1.1-hard
//          knob) of meal announcements, exercise, alcohol, illness, sleep loss and meal-composition
//          notices at 0 / 25 / 50 / 75 / 100 %; device notices (basal-injection, pump alarms) stay
//          visible; announcement.probability is set to 1 so masking is the only source of missing
//          meal reports (task mechanics such as T05's unannounced lunch stay); real-time CGM
//   exp1d  history window        agent-side: agent_options.history_hours 1 / 3 / 12 / 24
//   exp1e  decision interval     agent-side: agent_options.min_decision_minutes 5 / 15 / 30 / 60
//          (max_decisions_per_day = 1440 / interval)
//   1d / 1e tasks are the base environment unchanged; agent_options use the names of
//   src/bench/agent-options.mjs (validated here with parseAgentOptions). The runner must apply them
//   per task (task [metadata] agent_options_json, or the experiment's levels[].agent_options).
//
// Base environments: selectBaseEnvs over the v1 set without the sensor tasks T20-T23 (their
// mechanics are the sensor itself): 21 tasks x (one pump, one pens) = 42 environments covering
// every task category; pump and pens half each; clean and randomized settings alternate.
import path from 'node:path';
import {buildBenchmark} from '../benchmark/build.mjs';
import {mergeLayers} from '../opendiabet/generate.mjs';
import {OBSERVATION_PROFILES,profileOverrides} from '../bench/suite.mjs';
import {buildInstanceConfig} from '../sim/instance.mjs';
import {parseAgentOptions} from '../bench/agent-options.mjs';
import {loadV1Environments,selectBaseEnvs,variantTaskId,variantFields,writePairedFiles} from './paired.mjs';

export const EXP1_BENCHMARK='exp1-obs-scaling';
export const EXP1_EXCLUDED_TASKS=['T20','T21','T22','T23'];
export const DEFAULT_METER='contour_next_one';
export const RT_CGM='dexcom_g6',FLASH_CGM='libre_2_scan';
export const MASKED_KINDS=['meal_announcement','exercise','alcohol','illness','sleep_loss','composition'];
const AGENTS=['wait','patient','oref0','causal','oracle','llm:<bench/models/x.json>'];

export const LADDERS=Object.freeze({
  '1a':{id:'exp1a',factor:'observation richness (sensor ladder)',title:'实验 1a 观测丰富度 / observation richness',expected_trend:1,reference_level:'cgm_rt',
    levels:[{level:'smbg_sparse',label:'meter 2/day',profile:'smbg_sparse'},{level:'smbg_standard',label:'meter 4/day',profile:'smbg_standard'},
      {level:'smbg_intensive',label:'meter 7/day',profile:'smbg_intensive'},{level:'flash',label:'flash, scans every 2 h',profile:'flash_frequent'},
      {level:'cgm_rt',label:'real-time CGM',profile:'cgm_rt'}]},
  '1b':{id:'exp1b',factor:'CGM error scale',title:'实验 1b CGM 误差倍数 / CGM error scale',expected_trend:-1,reference_level:'e1',
    levels:[{level:'e0',label:'x0 (noiseless)',error_scale:0},{level:'e0.5',label:'x0.5',error_scale:0.5},{level:'e1',label:'x1 (G6 as sampled)',error_scale:1},
      {level:'e2',label:'x2',error_scale:2}]},
  '1c':{id:'exp1c',factor:'event masking rate',title:'实验 1c 事件掩码率 / event masking',expected_trend:-1,reference_level:'m0',
    levels:[0,25,50,75,100].map(p=>({level:`m${p}`,label:`${p}% masked`,masking:p/100}))},
  '1d':{id:'exp1d',factor:'history window shown to the agent (harness-side)',title:'实验 1d 观测时长 / history window',expected_trend:1,reference_level:'h3',agentSide:true,
    levels:[1,3,12,24].map(h=>({level:`h${h}`,label:`${h} h history`,agent_options:{history_hours:h}}))},
  '1e':{id:'exp1e',factor:'minimum decision interval (harness-side)',title:'实验 1e 决策频次 / decision interval',expected_trend:-1,reference_level:'d5',agentSide:true,
    levels:[5,15,30,60].map(m=>({level:`d${m}`,label:`every >= ${m} min`,agent_options:{min_decision_minutes:m,max_decisions_per_day:Math.round(1440/m)}}))},
});
export const LADDER_IDS=Object.keys(LADDERS);

/**
 * Uncertainty layer of ladder 1a (default on; validated with the causal / patient references,
 * docs/PLAN-v2.zh-CN.md 实验 1): without it, a model-based agent controls the v1 days almost
 * open-loop (programmed profile = the person's truth, every meal reported), so the sensor ladder has
 * no effect. The layer adds what only glucose observations can reveal, identically for every level
 * of a base environment: day-to-day sensitivity variation (cv 0.15), a mis-set programmed profile
 * (ISF x1.3, carb ratio x1.25 -> systematic underdosing; the true physiology is unchanged) and 50 %
 * masked meal announcements and exercise notices (scenario.masking, v1.1-hard).
 */
export const UNCERTAINTY_1A=Object.freeze({daily_sensitivity_cv:0.15,isf_factor:1.3,carb_ratio_factor:1.25,masking:{meal_announcement:0.5,exercise:0.5}});
export function uncertaintyLayer(base,_spec=null,u=UNCERTAINTY_1A) {
  const p=buildInstanceConfig(base.spec).profile;
  return {physiology:{daily_sensitivity_cv:u.daily_sensitivity_cv},
    profile:{isf_mg_dl_per_u:Math.min(300,Math.round(p.isf_mg_dl_per_u*u.isf_factor)),carb_ratio_g_per_u:Math.min(100,Number((p.carb_ratio_g_per_u*u.carb_ratio_factor).toFixed(1)))},
    scenario:{masking:{...u.masking}}};
}

const clone=x=>structuredClone(x);
/** The base spec with the sensors of an observation profile (see header). */
export function withObservation(base,profile) {
  const P=OBSERVATION_PROFILES[profile];if(!P)throw new Error(`unknown observation profile ${profile}`);
  const spec=clone(base.spec);
  const cgm=P.cgms[0]===null?null:profile==='cgm_rt'?RT_CGM:profile.startsWith('flash')?FLASH_CGM:P.cgms[0];
  spec.sensors={cgm,meter:cgm?null:spec.sensors?.meter??DEFAULT_METER};
  const {overrides,...plain}=spec;
  spec.overrides=mergeLayers(overrides??{},profileOverrides(profile,plain));
  return spec;
}

/** Spec of one ladder level for a base environment. */
export function variantSpec(base,ladderId,lv) {
  switch(ladderId) {
    case '1a':return withObservation(base,lv.profile);
    case '1b':{const s=withObservation(base,'cgm_rt');s.overrides=mergeLayers(s.overrides,{cgm:{error_draw:'sampled',error_scale:lv.error_scale}});return s;}
    case '1c':{const s=withObservation(base,'cgm_rt');
      s.overrides=mergeLayers(s.overrides,{scenario:{announcement:{probability:1},masking:Object.fromEntries(MASKED_KINDS.map(k=>[k,lv.masking]))}});return s;}
    case '1d':case '1e':return clone(base.spec);
    default:throw new Error(`unknown ladder ${ladderId}`);
  }
}

/**
 * Builds the experiment-1 benchmark. selection: {envIds} (explicit base envs) or nothing (stratified
 * default); ladders: subset of LADDER_IDS; envsFile: v1 environments.jsonl. Returns {manifest, bases, counts}.
 */
export function buildObsScaling({envIds=null,selection=null,ladders=LADDER_IDS,outDir=path.join('artifacts','benchmarks',EXP1_BENCHMARK),
  envsFile,clean=false,onTask=null,limit=null,ladderOverrides=null,plain1a=false}={}) {
  ladderOverrides??=plain1a?{}:{'1a':uncertaintyLayer};
  const envs=loadV1Environments(envsFile);
  let bases=selectBaseEnvs(envs,{excludeTasks:EXP1_EXCLUDED_TASKS,envIds:envIds??selection?.envIds??null});
  if(limit)bases=bases.slice(0,limit);
  const experiments=ladders.map(lid=>{
    const L=LADDERS[lid];if(!L)throw new Error(`unknown ladder ${lid} (one of ${LADDER_IDS.join(', ')})`);
    const tasks=[];
    for(const base of bases)L.levels.forEach((lv,i)=>{
      if(lv.agent_options)parseAgentOptions(lv.agent_options);
      const spec=variantSpec(base,lid,lv);
      const shared=typeof ladderOverrides[lid]==='function'?ladderOverrides[lid](base,spec):ladderOverrides[lid];
      if(shared)spec.overrides=mergeLayers(spec.overrides??{},shared);
      buildInstanceConfig(spec);
      const value=lv.profile??lv.error_scale??lv.masking??lv.agent_options;
      const obs=lid==='1a'||lid==='1b'||lid==='1c'?{observation_profile:lid==='1a'?lv.profile:'cgm_rt',cgm:spec.sensors.cgm??'none',meter:spec.sensors.meter??'none',
        sensor_setup:!spec.sensors.cgm?'meter_only':lv.profile?.startsWith('flash')?'flash':'cgm'}:{};
      const x=variantFields(base,{ladder:lid,level:lv.level,levelIndex:i,levelValue:value,extraFactors:obs,
        extraMetadata:{suite:EXP1_BENCHMARK,level_label:lv.label,...(lv.agent_options?{agent_options_json:JSON.stringify(lv.agent_options),...lv.agent_options}:{}),
          ...(lid==='1b'?{cgm_error_scale:lv.error_scale}:{}),...(lid==='1c'?{masking_rate:lv.masking}:{})}});
      tasks.push({task_id:variantTaskId(L.id,base.env_id,lv.level),spec,hours:24,factors:x.factors,metadata:x.metadata,variant:x.variant});
    });
    const levels=L.levels.map((lv,i)=>({level:lv.level,level_index:i,label:lv.label,
      ...(lv.profile?{observation_profile:lv.profile}:{}),...(lv.error_scale!=null?{cgm_error_scale:lv.error_scale}:{}),
      ...(lv.masking!=null?{masking_rate:lv.masking,masked:MASKED_KINDS}:{}),...(lv.agent_options?{agent_options:lv.agent_options}:{})}));
    return {id:L.id,title:L.title,track:'full',repeats:1,agents:AGENTS,primary_metric:'reward',
      description:`${bases.length} base environments x ${L.levels.length} levels of ${L.factor}; paired by base environment (same person and day).`
        +(L.agentSide?' Harness-side factor: task specs equal the base environment; pass levels[].agent_options to the agent (pending in the LLM harness).':''),
      tasks,design:{ladder:lid,factor:L.factor,levels,reference_level:L.reference_level,expected_trend:L.expected_trend,
        ...(ladderOverrides[lid]===uncertaintyLayer?{shared_layer:{name:'uncertainty',...UNCERTAINTY_1A}}
          :ladderOverrides[lid]?{shared_overrides:typeof ladderOverrides[lid]==='function'?String(ladderOverrides[lid]):ladderOverrides[lid]}:{}),
        ...(L.agentSide?{notes:'agent_options are not applied by the simulator; the runner / LLM harness must honour them (agent_options_json in task metadata)'}:{})}};
  });
  buildBenchmark({name:EXP1_BENCHMARK,version:'0.1',title:'Experiment 1: observation scaling (paired variants of OpenDiabet v1)',
    description:'Paired variants of OpenDiabet v1 environments along five observation ladders (docs/PLAN-v2.zh-CN.md 实验 1).',
    outDir,experiments:experiments.map(({design,...e})=>({...e,tasks:e.tasks.map(({variant,...t})=>t)})),clean,onTask});
  const manifest=writePairedFiles(outDir,{experiments,bases,block:{
    design:'paired variants of OpenDiabet v1 environments (same person and episode seed across the levels of a base environment)',
    source:'artifacts/benchmarks/opendiabet-v1/environments.jsonl',
    base_selection:`per task (excluding ${EXP1_EXCLUDED_TASKS.join(', ')}) one pump environment (pump_pct / pump_abs / pump_combo rotating) and one pens environment, opposite settings`,
    ladders:Object.fromEntries(ladders.map(l=>[LADDERS[l].id,{factor:LADDERS[l].factor,levels:LADDERS[l].levels.map(x=>x.level),reference_level:LADDERS[l].reference_level,
      expected_trend:LADDERS[l].expected_trend,...(LADDERS[l].agentSide?{harness_side:true}:{})}])),
    dependencies:{exp1c:'scenario.masking (v1.1-hard, src/core/scenario.mjs applyMasking)',exp1d:'LLM harness: history window (agent_options.history_hours)',runner:'src/benchmark/runner.mjs applies one job-level agentOptions; per-task agent_options_json (1d/1e levels) must be merged per trial',
      exp1e:'LLM harness / runner: minimum decision interval and daily decision cap (agent_options.min_decision_minutes, max_decisions_per_day)'}}});
  return {manifest,bases,counts:Object.fromEntries(experiments.map(e=>[e.id,e.tasks.length]))};
}
