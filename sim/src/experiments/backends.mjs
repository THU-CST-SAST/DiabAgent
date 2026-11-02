// Experiment 4 (docs/PLAN-v2.zh-CN.md 实验 4): hardware backends and insulins. Paired variants of
// OpenDiabet v1 environments (same person, same day seeds, same events and sensors; only the
// therapy changes), in one benchmark (artifacts/benchmarks/exp4-backends):
//
//   exp4a  backend        pump_pct (Dana-i, aspart) / pump_abs (Omnipod DASH, Fiasp) / pump_combo
//                         (Accu-Chek Combo, lispro) / pens (the task's pen pair, as in v1) /
//                         pump_loop (Dana-i + aspart with the built-in oref0 loop in closed mode;
//                         the agent acts on top, with the loop actions exposed: SET_LOOP_MODE,
//                         SUSPEND_LOOP, SET_TEMP_TARGET; a user temp basal overrides the loop's)
//                         Backends keep their v1 insulin (backend = device + its insulin, as in v1).
//   exp4b  pump insulin   Dana-i with aspart / lispro / fiasp / lyumjev (regular human insulin is
//                         pen-only in the device database). lispro (and glulisine) share aspart's PK
//                         in knowledge/insulins.json, so lispro is a negative control (validation:
//                         identical scores for every reference agent); glulisine is left out.
//   exp4c  pen insulin    NovoPen 6 with aspart / fiasp / regular_human (the one pen that takes
//                         all three, so the pen step is fixed); long-acting pen as in the base
//
// To keep the pairing, every variant of a base environment uses the same sensors: a real-time or
// calibrated CGM of the base is kept, otherwise the base gets dexcom_g6 (the loop needs a
// continuous CGM). The pump-only background pack occlusion_faults is dropped from all variants.
// Base environments: selectBaseEnvs over the v1 set without the device tasks T18-T19 (their
// mechanics differ per family) and the sensor tasks T20-T23: 19 tasks x (pump, pens) = 38.
import path from 'node:path';
import {buildBenchmark} from '../benchmark/build.mjs';
import {mergeLayers,BACKENDS,cellPenPair} from '../opendiabet/generate.mjs';
import {profileOverrides} from '../bench/suite.mjs';
import {CGMS} from '../core/cgm.mjs';
import {buildInstanceConfig} from '../sim/instance.mjs';
import {loadV1Environments,selectBaseEnvs,variantTaskId,variantFields,writePairedFiles} from './paired.mjs';

export const EXP4_BENCHMARK='exp4-backends';
export const EXP4_EXCLUDED_TASKS=['T18','T19','T20','T21','T22','T23'];
export const LOOP_CONTROLLER=Object.freeze({enabled:true,mode:'closed',expose_actions:true});
export const PEN_SWEEP_PEN='novopen_6';
const AGENTS=['wait','patient','oref0','causal','oracle','llm:<bench/models/x.json>'];

export const BACKEND_LEVELS=['pump_pct','pump_abs','pump_combo','pens','pump_loop'];
export const LADDERS=Object.freeze({
  '4a':{id:'exp4a',factor:'hardware backend',title:'实验 4a 后端 / hardware backend',reference_level:'pump_pct',expected_trend:null,
    levels:BACKEND_LEVELS.map(b=>({level:b,label:b==='pump_loop'?'Dana-i (aspart) + built-in oref0 closed loop':BACKENDS[b].label.en,backend:b}))},
  '4b':{id:'exp4b',factor:'rapid insulin in a pump (Dana-i)',title:'实验 4b 泵用胰岛素 / pump insulin',reference_level:'aspart',expected_trend:null,
    levels:['aspart','lispro','fiasp','lyumjev'].map(i=>({level:i,label:i==='lispro'?'Dana-i + lispro (same PK as aspart in the knowledge base: negative control)':`Dana-i + ${i}`,insulin:i}))},
  '4c':{id:'exp4c',factor:'rapid insulin in a pen (NovoPen 6)',title:'实验 4c 笔用胰岛素 / pen insulin',reference_level:'aspart',expected_trend:null,
    levels:['aspart','fiasp','regular_human'].map(i=>({level:i,label:`NovoPen 6 + ${i}`,insulin:i}))},
});
export const LADDER_IDS=Object.keys(LADDERS);

const clone=x=>structuredClone(x);
/** Base spec with the shared sensors / events of all exp-4 variants (see header). */
export function pairedBaseSpec(base) {
  const spec=clone(base.spec);
  spec.events=(spec.events??['baseline']).filter(e=>e!=='occlusion_faults');
  const cgm=spec.sensors?.cgm;
  if(!cgm||CGMS[cgm].modality!=='cgm') {
    spec.sensors={cgm:'dexcom_g6',meter:spec.sensors?.meter??null};
    const {overrides,...plain}=spec;
    spec.overrides=mergeLayers(overrides??{},profileOverrides('cgm_rt',plain));
  }
  return spec;
}
const pensOf=base=>base.spec.therapy?.mode==='mdi'?clone(base.spec.therapy.mdi):cellPenPair(base.task);

/** Spec of one level for a base environment. */
export function variantSpec(base,ladderId,lv) {
  const spec=pairedBaseSpec(base);
  spec.controller={enabled:false};
  if(ladderId==='4a') {
    if(lv.backend==='pens')spec.therapy={mode:'mdi',mdi:pensOf(base)};
    else if(lv.backend==='pump_loop'){spec.therapy=clone(BACKENDS.pump_pct.therapy);spec.controller={...LOOP_CONTROLLER};}
    else spec.therapy=clone(BACKENDS[lv.backend].therapy);
  } else if(ladderId==='4b')spec.therapy={mode:'pump',pump:{model:'dana_i',insulin:lv.insulin}};
  else if(ladderId==='4c') {
    const p=pensOf(base);
    spec.therapy={mode:'mdi',mdi:{bolus_pen:PEN_SWEEP_PEN,bolus_insulin:lv.insulin,basal_pen:p.basal_pen,basal_insulin:p.basal_insulin}};
  } else throw new Error(`unknown ladder ${ladderId}`);
  return spec;
}

/** Factors of a variant (device / insulin fields follow the variant's therapy). */
function therapyFactors(spec,lv) {
  const t=spec.therapy;
  return t.mode==='pump'?{mode:'pump',family:'pump',pump:t.pump.model,rapid_insulin:t.pump.insulin,backend:lv.backend??'pump_pct',controller:spec.controller?.enabled?'closed_loop':'off',
    bolus_pen:null,basal_pen:null,basal_insulin:null}
    :{mode:'mdi',family:'pens',pump:null,bolus_pen:t.mdi.bolus_pen,rapid_insulin:t.mdi.bolus_insulin,basal_pen:t.mdi.basal_pen,basal_insulin:t.mdi.basal_insulin,
      backend:'pens',controller:'off'};
}

/**
 * Builds the experiment-4 benchmark. selection: {envIds} or nothing (stratified default);
 * ladders: subset of LADDER_IDS. Returns {manifest, bases, counts}.
 */
export function buildBackends({envIds=null,selection=null,ladders=LADDER_IDS,outDir=path.join('artifacts','benchmarks',EXP4_BENCHMARK),
  envsFile,clean=false,onTask=null,limit=null}={}) {
  const envs=loadV1Environments(envsFile);
  let bases=selectBaseEnvs(envs,{excludeTasks:EXP4_EXCLUDED_TASKS,envIds:envIds??selection?.envIds??null});
  if(limit)bases=bases.slice(0,limit);
  const experiments=ladders.map(lid=>{
    const L=LADDERS[lid];if(!L)throw new Error(`unknown ladder ${lid} (one of ${LADDER_IDS.join(', ')})`);
    const tasks=[];
    for(const base of bases)L.levels.forEach((lv,i)=>{
      const spec=variantSpec(base,lid,lv);buildInstanceConfig(spec);
      const x=variantFields(base,{ladder:lid,level:lv.level,levelIndex:i,levelValue:lv.backend??lv.insulin,
        extraFactors:{...therapyFactors(spec,lv),cgm:spec.sensors.cgm,meter:spec.sensors.meter??'none',event_packs:spec.events.filter(e=>e!=='baseline')},
        extraMetadata:{suite:EXP4_BENCHMARK,level_label:lv.label,...(lv.backend?{variant_backend:lv.backend}:{}),...(lv.insulin?{variant_insulin:lv.insulin}:{}),
          closed_loop:spec.controller?.enabled===true}});
      tasks.push({task_id:variantTaskId(L.id,base.env_id,lv.level),spec,hours:24,factors:x.factors,metadata:x.metadata,variant:x.variant});
    });
    const levels=L.levels.map((lv,i)=>({level:lv.level,level_index:i,label:lv.label,...(lv.backend?{backend:lv.backend}:{}),...(lv.insulin?{insulin:lv.insulin}:{}),
      ...(lv.backend==='pump_loop'?{controller:LOOP_CONTROLLER}:{})}));
    return {id:L.id,title:L.title,track:'full',repeats:1,agents:AGENTS,primary_metric:'reward',
      description:`${bases.length} base environments x ${L.levels.length} levels of ${L.factor}; paired by base environment (same person, day, events and sensors).`,
      tasks,design:{ladder:lid,factor:L.factor,levels,reference_level:L.reference_level,expected_trend:L.expected_trend}};
  });
  buildBenchmark({name:EXP4_BENCHMARK,version:'0.1',title:'Experiment 4: hardware backends and insulins (paired variants of OpenDiabet v1)',
    description:'Paired variants of OpenDiabet v1 environments across backends (incl. a built-in closed loop) and rapid insulins (docs/PLAN-v2.zh-CN.md 实验 4).',
    outDir,experiments:experiments.map(({design,...e})=>({...e,tasks:e.tasks.map(({variant,...t})=>t)})),clean,onTask});
  const manifest=writePairedFiles(outDir,{experiments,bases,block:{
    design:'paired variants of OpenDiabet v1 environments: same person, episode seed, events and sensors; only the therapy (device, insulin, loop) changes',
    source:'artifacts/benchmarks/opendiabet-v1/environments.jsonl',
    base_selection:`per task (excluding ${EXP4_EXCLUDED_TASKS.join(', ')}) one pump environment (pump_pct / pump_abs / pump_combo rotating) and one pens environment, opposite settings`,
    shared_changes:['sensors: keep a continuous CGM of the base, else dexcom_g6 (+ the base meter)','event pack occlusion_faults dropped'],
    ladders:Object.fromEntries(ladders.map(l=>[LADDERS[l].id,{factor:LADDERS[l].factor,levels:LADDERS[l].levels.map(x=>x.level),reference_level:LADDERS[l].reference_level}]))}});
  return {manifest,bases,counts:Object.fromEntries(experiments.map(e=>[e.id,e.tasks.length]))};
}
