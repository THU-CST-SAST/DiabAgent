// OpenDiabet environment generator (docs/OPENDIABET-V1.zh-CN.md): scenario task x hardware backend x
// setting x seed -> one runnable, scoreable, replayable instance spec (src/sim/instance.mjs format).
//
//   generateEnvironment({task:'T05', backend:'pump_abs', setting:'randomized', seedIndex:1, attempt:0})
//     -> {env_id, task, backend, setting, seed_index, attempt, seed, split, factors, spec, mechanics, ...}
//   generateSet({tasks, backends, settings, seeds}) -> [env]   (deterministic order)
//   inspectEnvironment(env) -> {ok, checks}   the task's mechanics present in the generated world
//   cardJson(task) -> task card without code (task-cards/T01.json)
//
// Layers of a spec, later wins: observation profile routine (bench §2.2) -> setting (clean: typical
// person, Dexcom G6 with median error and no random gaps, every meal announced with exact grams,
// no background events; randomized: sampled person, observation profile drawn from the 7 (or the
// task's allowed ones), announce probability 0.75-1, 0-2 background event packs, sampled sensor
// error) -> task card (src/opendiabet/tasks.mjs). Seeds are hashes of (task, backend, setting, seed
// index, attempt); the person type and pen pair belong to the cell (task, backend), so clean and
// randomized of a cell share them. A degenerate environment (see references.mjs) is re-drawn with
// attempt + 1.
import {Rng,streamSeed} from '../core/rng.mjs';
import {KNOWLEDGE as K} from '../knowledge.mjs';
import {CGMS} from '../core/cgm.mjs';
import {buildInstanceConfig} from '../sim/instance.mjs';
import {SimEnv} from '../env/pomdp.mjs';
import {OBSERVATION_PROFILES,PROFILE_IDS,profileOverrides} from '../bench/suite.mjs';
import {dimensions,applicablePacks} from '../population/catalog.mjs';
import {TASKS,TASK_IDS,CATEGORIES,taskById,taskPacks} from './tasks.mjs';

export const GENERATOR_VERSION='opendiabet-generator/1.0';
export const BENCHMARK_NAME='opendiabet-v1';
export const SETTINGS=['clean','randomized'];
export const BACKENDS=Object.freeze({
  pump_pct:{family:'pump',label:{zh:'Dana-i（速效 门冬）',en:'Dana-i (aspart)'},therapy:{mode:'pump',pump:{model:'dana_i',insulin:'aspart'}},
    action_space:{zh:'百分比临时基础率、方波大剂量、取消大剂量、暂停/恢复、换管路',en:'percent temp basal, extended bolus, cancel bolus, suspend/resume, set change'}},
  pump_abs:{family:'pump',label:{zh:'Omnipod DASH（超速效 Fiasp）',en:'Omnipod DASH (Fiasp)'},therapy:{mode:'pump',pump:{model:'omnipod_dash',insulin:'fiasp'}},
    action_space:{zh:'绝对值临时基础率、无方波、贴敷式',en:'absolute temp basal, no extended bolus, patch pump'}},
  pump_combo:{family:'pump',label:{zh:'Accu-Chek Combo（速效 赖脯）',en:'Accu-Chek Combo (lispro)'},therapy:{mode:'pump',pump:{model:'accu_chek_combo',insulin:'lispro'}},
    action_space:{zh:'百分比临时基础率、无方波、不能取消大剂量、有管路',en:'percent temp basal, no extended bolus, no bolus cancel, tubed'}},
  pens:{family:'pens',label:{zh:'餐时笔 + 长效笔',en:'bolus pen + long-acting pen'},therapy:null,
    action_space:{zh:'只有大剂量与长效注射，按笔步长取整，无临时基础率',en:'boluses and long-acting injections on the pen steps only; no temp basal'}},
});
export const BACKEND_IDS=Object.keys(BACKENDS);
export const PERSON_TYPES=Object.keys(K.persons);
export const DEV_TASKS=TASK_IDS.slice(0,17),DEV_BACKENDS=['pump_pct','pens'];
export const SETTING_RULES={
  clean:{zh:'该人群类型的典型个体（不抽样，BMI 正常、无黎明现象、计碳准确）；实时 CGM（Dexcom G6，误差取中位数、无随机中断；任务规定传感器时用其规定）；进食全部报告且克数准确（任务本身规定时除外）；关闭日常运动等背景事件；日间敏感性波动为 0',
    en:'Typical individual of the person type (not sampled; normal BMI, no dawn, accurate carb counting); real-time CGM (Dexcom G6 with median error, no random gaps; or the sensor the task prescribes); every meal announced with exact grams (unless the task says otherwise); no background exercise or events; no day-to-day sensitivity variation'},
  randomized:{zh:'个体参数抽样（BMI、黎明现象按患病率、计碳能力）；观测配置从 7 种中抽（任务规定传感器时从其允许的配置中抽）；每餐报告概率 0.75–1 且有计碳误差；随机叠加 0–2 个背景事件包；传感器误差按型号抽样',
    en:'Sampled individual (BMI, dawn by prevalence, carb-counting skill); observation profile drawn from the 7 (or from the task\'s allowed ones); announce probability 0.75-1 with carb-count error; 0-2 random background event packs; sensor error drawn per model'},
};

const clone=x=>structuredClone(x);
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const pick=(r,xs)=>xs[Math.floor(r.next()*xs.length)];
/** Deep merge of override layers (objects merge; arrays and meal maps are replaced). */
export function mergeLayers(...layers) {
  const m=(a,b,k)=>{if(!isObject(a)||!isObject(b)||k==='meals')return clone(b);const o={...a};for(const [x,v] of Object.entries(b))o[x]=x in a?m(a[x],v,x):clone(v);return o;};
  return layers.filter(Boolean).reduce((a,b)=>m(a,b,null),{});
}

export const envIdOf=(task,backend,setting,seedIndex=1)=>`${task}-${backend}-${setting}-s${seedIndex}`;
/** Harbor task id: lower case; the assisted track gets a -assisted suffix. */
export const taskIdOf=(envId,track='full')=>`${envId.toLowerCase()}${track==='assisted'?'-assisted':''}`;
export const seedFor=(task,backend,setting,seedIndex=1,attempt=0)=>streamSeed(0,`${BENCHMARK_NAME}:${task}:${backend}:${setting}:s${seedIndex}:a${attempt}`)%1000000000;
export const splitOf=(task,backend)=>DEV_TASKS.includes(task)&&DEV_BACKENDS.includes(backend)?'dev':'test';

/** Person type of a cell: the task's own list, else a balanced rotation over all 8 types. */
export function cellPersonType(task,backend) {
  const card=taskById(task),bi=BACKEND_IDS.indexOf(backend);
  if(card.personTypes)return card.personTypes[(TASK_IDS.indexOf(task)+bi)%card.personTypes.length];
  const general=TASKS.filter(t=>!t.personTypes).map(t=>t.id),k=general.indexOf(task)*BACKEND_IDS.length+bi;
  return PERSON_TYPES[(3*k+Math.floor(k/8))%PERSON_TYPES.length];
}
let PEN_PAIRS=null;
/** Bolus + long-acting pen pair of a pens cell (deterministic per task). */
export function cellPenPair(task) {
  PEN_PAIRS??=dimensions().therapy.filter(t=>t.mode==='mdi').map(t=>t.mdi);
  return clone(PEN_PAIRS[streamSeed(0,`${BENCHMARK_NAME}:pens:${task}`)%PEN_PAIRS.length]);
}

/** Runs a spec with WAIT for `hours`; true glucose [[minute, mg/dL]] and the first observation. */
function simulateWait(spec,hours) {
  const env=new SimEnv(buildInstanceConfig({...spec,horizon_minutes:Math.round(hours*60)})),obs0=env.observe();
  while(!env.done())env.step({action_id:`w-${env.step_count}`,expected_step:env.step_count,action:{type:'WAIT'}});
  return {obs0,glucose:env.evaluator.map(s=>[Math.round((Date.parse(s.time)-env.start)/60000),s.true_glucose_mg_dl])};
}

/** One environment of the generator. */
export function generateEnvironment({task,backend,setting,seedIndex=1,attempt=0}) {
  const card=taskById(task),B=BACKENDS[backend];
  if(!B)throw new Error(`Unknown backend ${backend}; one of ${BACKEND_IDS.join(', ')}`);
  if(!SETTINGS.includes(setting))throw new Error(`Unknown setting ${setting}; one of ${SETTINGS.join(', ')}`);
  const family=B.family,seed=seedFor(task,backend,setting,seedIndex,attempt);
  const rng=Rng.stream(seed,'opendiabet:randomize'),cell=Rng.stream(streamSeed(0,`${BENCHMARK_NAME}:cell:${task}:${backend}`),'cell');
  const therapy=family==='pens'?{mode:'mdi',mdi:cellPenPair(task)}:clone(B.therapy);
  const type=cellPersonType(task,backend),clean=setting==='clean';
  const person={type,bmi:clean?'normal':pick(rng,['normal','overweight','obese']),dawn:clean?'absent':'random',
    carb_counting:clean?'accurate':pick(rng,['typical','accurate','poor']),sample:!clean,seed,...(card.person??{})};
  // Sensors: the clean default, the task's rule, or one of the 7 observation profiles.
  const meters=Object.keys(K.meters);let profile,cgm,meter;
  if(clean){const s=card.sensor?.clean??{profile:'cgm_rt',cgm:'dexcom_g6',meter:null};({profile,cgm,meter}=s);}
  else {
    const s=card.sensor?.randomized;profile=pick(rng,s?.profiles??PROFILE_IDS);
    const P=OBSERVATION_PROFILES[profile];cgm=pick(rng,P.cgms);
    const need=s?.meter??P.meter,coin=rng.next(),m=pick(rng,meters);meter=need==='required'||coin<0.5?m:null;
  }
  const packs=taskPacks(card,family);
  let background=[];
  if(!clean) {
    const pool=applicablePacks(type,therapy).filter(p=>!packs.includes(p)&&!(card.excludeBackground??[]).includes(p)).sort();
    const k=Math.floor(rng.next()*3);
    for(let i=0;i<k&&pool.length;i++)background.push(pool.splice(Math.floor(rng.next()*pool.length),1)[0]);
    background.sort();
  }
  const spec={seed,person,therapy,sensors:{cgm,meter},controller:{enabled:false},events:['baseline',...packs,...background]};
  const settingLayer=clean
    ?{physiology:{daily_sensitivity_cv:0},scenario:{activity:{enabled:false},
        ...(card.keepsCarbCounting?{}:{announcement:{probability:1,model:'uniform',carb_error_fraction:0,bias:0,sd:0}})},
      ...(cgm?{cgm:{error_draw:'median',gaps:{start_probability_per_sample:0,mean_length_samples:1}}}:{})}
    :{scenario:{announcement:{probability:Number((0.75+0.25*rng.next()).toFixed(2))}}};
  const base=mergeLayers(profileOverrides(profile,spec),settingLayer);
  const cfg=buildInstanceConfig({...spec,overrides:base});
  const bolusSpec=new SimEnv(cfg).observe().action_specs.BOLUS.units,q=Math.max(0.5,bolusSpec.step??0.5);
  const ctx={cfg,family,setting,rng,cell,bolusMax:Math.min(bolusSpec.max,family==='pens'?bolusSpec.max:25),
    quantBolus:u=>Math.min(Math.floor(bolusSpec.max/q)*q,Math.max(q,Math.round(u/q)*q)),
    wearDays:m=>CGMS[m]?.wear_days??10,
    simulate:(patch,hours)=>simulateWait({...spec,overrides:mergeLayers(base,patch)},hours)};
  const t=card.build(ctx)??{};
  if(t.start_time)spec.start_time=t.start_time;
  spec.overrides=mergeLayers(base,t.overrides);
  const config=buildInstanceConfig(spec);   // validates
  const envId=envIdOf(task,backend,setting,seedIndex),r=config.person.resolved;
  const factors={task,category:card.category,backend,family,setting,person_type:type,age_group:r?.age_group??null,sex:config.patient.sex,
    bmi:person.bmi,dawn:person.dawn,carb_counting:person.carb_counting,mode:therapy.mode,
    ...(therapy.mode==='pump'?{pump:therapy.pump.model,rapid_insulin:therapy.pump.insulin}
      :{bolus_pen:therapy.mdi.bolus_pen,rapid_insulin:therapy.mdi.bolus_insulin,basal_pen:therapy.mdi.basal_pen,basal_insulin:therapy.mdi.basal_insulin}),
    observation_profile:profile,sensor_setup:!cgm?'meter_only':CGMS[cgm].modality==='flash'?'flash':CGMS[cgm].calibration?.required?'calibrated_cgm':'cgm',
    cgm:cgm??'none',meter:meter??'none',event_packs:[...packs,...background],background_packs:background};
  return {env_id:envId,task,title:card.title,category:card.category,backend,family,setting,seed_index:seedIndex,attempt,seed,person_seed:seed,
    split:splitOf(task,backend),unseen_task:!DEV_TASKS.includes(task),unseen_backend:!DEV_BACKENDS.includes(backend),
    generator:GENERATOR_VERSION,factors,mechanics:t.mechanics??{},spec};
}

/**
 * Generates environments for every task x backend x setting x seed index (1..seeds). An
 * environment whose mechanics check fails (e.g. the sensor happens to be warming up at the start
 * of an extreme-start task) is re-drawn with the next attempt; `attempts` maps env_id -> first
 * attempt to use (re-draws of degenerate environments, see references.mjs).
 */
export function generateSet({tasks=TASK_IDS,backends=BACKEND_IDS,settings=SETTINGS,seeds=1,attempts={},onEnv=null}={}) {
  const out=[];
  for(const task of tasks)for(const backend of backends)for(const setting of settings)for(let s=1;s<=seeds;s++) {
    const id=envIdOf(task,backend,setting,s);let env=null,failed=[];
    for(let a=attempts[id]??0;a<(attempts[id]??0)+6;a++) {
      env=generateEnvironment({task,backend,setting,seedIndex:s,attempt:a});
      const chk=inspectEnvironment(env);
      if(chk.ok)break;
      failed.push({attempt:a,failed:chk.checks.filter(c=>!c.ok).map(c=>c.name)});env=null;
    }
    if(!env)throw new Error(`${id}: no attempt passed the mechanics check: ${JSON.stringify(failed)}`);
    if(failed.length)env.mechanics_redraws=failed;
    out.push(env);onEnv?.(env);
  }
  return out;
}

// --- mechanics check ------------------------------------------------------------------------------

const localMinute=(t,off)=>(((t+off*60000)%86400000)+86400000)%86400000/60000;
/** Checks that the task's mechanics are present in the world the spec builds (full track, 24 h). */
export function inspectEnvironment(env) {
  const cfg=buildInstanceConfig(env.spec),sim=new SimEnv(cfg),w=sim.world,obs=sim.observe(),ev=sim.events,off=cfg.utc_offset_minutes;
  const checks=[],check=(name,ok,value)=>checks.push({name,ok:!!ok,...(value!==undefined?{value}:{})});
  const meals=ev.filter(e=>e.type==='meal'),g0=w.physiology.glucose(),iob=obs.iob.total_u,pump=cfg.therapy.mode==='pump';
  const realtime=w.cgm?.modality==='cgm';
  switch(env.task) {
    case 'T02':check('large main meals',meals.filter(m=>['breakfast','lunch','dinner'].includes(m.name)).every(m=>m.grams>=40)&&meals.length>=2,meals.map(m=>m.grams));break;
    case 'T03':check('high-fat meal reported',meals.some(m=>m.composition==='high_fat'&&m.reported_composition==='high_fat'));break;
    case 'T04':check('breakfast skipped',!meals.some(m=>m.name==='breakfast'));check('late snack',meals.some(m=>m.name==='late_snack'));
      check('late lunch',meals.some(m=>m.name==='lunch'&&localMinute(m.at,off)>=13*60+15));break;
    case 'T05':check('unannounced lunch',meals.some(m=>m.name==='lunch'&&m.announced_grams==null));break;
    case 'T06':check('carb bias',cfg.scenario.announcement.model==='normal'&&Math.abs(cfg.scenario.announcement.bias)>=0.3,cfg.scenario.announcement.bias);break;
    case 'T07':check('aerobic exercise',ev.some(e=>e.type==='exercise'&&!e.kind));check('advance notice',ev.some(e=>e.type==='exercise_plan'&&e.kind==='aerobic'));break;
    case 'T08':check('anaerobic exercise',ev.some(e=>e.type==='exercise'&&e.kind==='anaerobic'));check('advance notice',ev.some(e=>e.type==='exercise_plan'&&e.kind==='anaerobic'));break;
    case 'T09':check('drink reported',ev.some(e=>e.type==='alcohol'&&e.announced));check('delayed effect in horizon',ev.some(e=>e.type==='alcohol_effect'));break;
    case 'T10':check('illness',ev.some(e=>e.type==='illness'));break;
    case 'T11':check('sleep loss',ev.some(e=>e.type==='sleep_loss'));break;
    case 'T12':check('stress',ev.some(e=>e.type==='stress'));break;
    case 'T13':check('luteal phase',w.sensitivityMultiplier(w.start)<0.95,w.sensitivityMultiplier(w.start));break;
    case 'T14':check('dawn phenomenon',cfg.physiology.dawn_fraction>0,cfg.physiology.dawn_fraction);break;
    case 'T15':check('low start',g0<=110,Math.round(g0));check('insulin on board',iob>0.3,iob);break;
    case 'T16':check('high start',g0>=180,Math.round(g0));check('insulin on board',iob>=1,iob);break;
    case 'T17':check('reported meal before start',obs.reported_carbs.length>0);check('insulin on board',iob>0.3,iob);break;
    case 'T18':if(pump)check('occlusion',ev.some(e=>e.type==='occlusion'));
      else check('missed long-acting dose',Date.parse(obs.device.last_basal_injection.time)<w.start-24*3600000,obs.device.last_basal_injection.time);break;
    case 'T19':if(pump)check('pump suspended',obs.device.suspended&&obs.device.stop_reason==='user_suspended',obs.device.suspended_until);
      else check('extra long-acting dose',Date.parse(obs.device.last_basal_injection.time)>w.start-3*3600000,obs.device.last_basal_injection.time);break;
    case 'T20':check('sensor expires in horizon',w.cgm&&w.cgm.nextExpiry()<sim.end);check('forced gap',cfg.cgm.forced_gaps.length===1);check('meter',!!w.meter);break;
    case 'T21':check('calibration overdue',obs.cgm?.calibration?.required_now===true);break;
    case 'T22':check('flash sensor',w.cgm?.modality==='flash');break;
    case 'T23':check('meter only',!w.cgm&&!!w.meter);break;
    case 'T24':check('child',cfg.person.resolved?.age_group==='child');break;
    case 'T25':check('older',cfg.person.resolved?.age_group==='older');check('poor carb counting',cfg.person.carb_counting==='poor');break;
    default:break;
  }
  if(['T15','T16','T17'].includes(env.task)&&realtime)check('CGM reading at start',obs.glucose?.source==='cgm');
  check('builds',true);
  return {ok:checks.every(c=>c.ok),checks};
}

/** Task card as JSON (task-cards/<id>.json): everything but the build code. */
export function cardJson(task) {
  const c=typeof task==='string'?taskById(task):task;
  const variants=Object.fromEntries(BACKEND_IDS.map(b=>{const v=c.backend_variants??{};return [b,v[b]??v[BACKENDS[b].family]??null];}));
  return {format:'opendiabet.task-card/v1',id:c.id,title:c.title,category:c.category,category_title:CATEGORIES[c.category],capability:c.capability,
    backends:BACKEND_IDS,backend_variants:variants,scenario:c.scenario,success:c.success,
    person_types:c.personTypes??'balanced rotation over all 8 types',person_fixed:c.person??null,
    event_packs:{pump:taskPacks(c,'pump'),pens:taskPacks(c,'pens')},excluded_background_packs:c.excludeBackground??[],
    sensor:{clean:c.sensor?.clean??{profile:'cgm_rt',cgm:'dexcom_g6',meter:null},randomized:c.sensor?.randomized??{profiles:PROFILE_IDS,meter:'per profile'}},
    keeps_carb_counting_error_in_clean:!!c.keepsCarbCounting,start_local:c.startLocal??'00:00',
    rules:{clean:SETTING_RULES.clean,randomized:SETTING_RULES.randomized},
    split:{dev_backends:DEV_TASKS.includes(c.id)?DEV_BACKENDS:[],unseen_task:!DEV_TASKS.includes(c.id)},generator:GENERATOR_VERSION};
}
