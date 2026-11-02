// Bench test suites (docs/BENCH.zh-CN.md §2): observation profiles, quota-based diverse sampling,
// baseline screening (drop degenerate instances and refill), difficulty tiers, a dev/test split
// stratified by observation profile, and reading/writing suite.json + instances.jsonl.
// Also runs the code baselines per track (src/bench/tracks.mjs: full = wait / patient / oref0,
// assisted = wait / oref0) per instance and repeat, in worker threads, writing the same per-episode
// layout as LLM runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {fileURLToPath} from 'node:url';
import {KNOWLEDGE as K,KNOWLEDGE_SHA256} from '../knowledge.mjs';
import {Rng,streamSeed} from '../core/rng.mjs';
import {buildInstanceConfig} from '../sim/instance.mjs';
import {SimEnv,VERSION as ENV_VERSION} from '../env/pomdp.mjs';
import {POLICIES,runFromBundle} from '../viz/run.mjs';
import {CLASSICAL_BASELINES,BASELINE_CADENCE_VERSION} from './hourly-policy.mjs';
import {dimensions,applicablePacks,makeSpec} from '../population/catalog.mjs';
import {episodeMetrics,episodeScore,normalizeScore} from './score.mjs';
import {TRACKS,DEFAULT_TRACK,checkTrack,trackSpec} from './tracks.mjs';

export const SUITE_FORMAT='sweet-sim.suite/v1';
export const BASELINE_HARNESS_VERSION='bench-baselines/0.1';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const KERNEL_SHA256=createHash('sha256').update(fs.readFileSync(path.join(ROOT,'model/Deichmann2023.ts'))).digest('hex');
const WORKER_ROLE='sweet-sim-bench-worker';

// ---- observation profiles (§2.2) --------------------------------------------------------------

const hm=s=>Number(s.slice(0,2))*60+Number(s.slice(3));
const hhmm=m=>{m=((Math.round(m)%1440)+1440)%1440;return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;};
const BEDTIME='22:00';

/** Main meals of a resolved config (breakfast, lunch, dinner), sorted by time. */
function mainMeals(cfg) {
  const meals=cfg.scenario.meals,named=['breakfast','lunch','dinner'].filter(k=>meals[k]).map(k=>meals[k]);
  const list=named.length?named:Object.values(meals).filter(m=>(m.probability??1)>=0.9);
  return list.map(m=>m.time).sort();
}

/**
 * The seven observation profiles. Each fixes the sensor family (cgms), whether a meter is
 * required, and the patient's own measurement habit as config overrides: meter.routine_times
 * (fingersticks), cgm.scan_window + cgm.scan_interval_minutes (flash scans).
 * routine(meals) gets the person's main meal times (HH:MM) and returns the overrides.
 */
export const OBSERVATION_PROFILES=Object.freeze({
  cgm_rt:{label:'Real-time CGM, 5-min readings',cgms:['dexcom_g6','dexcom_g7','libre_2','libre_3'],meter:'optional',
    routine:()=>({meter:{routine_times:[]}}),expected:{fingersticks:0,scans:0}},
  cgm_calibrated:{label:'Calibrated CGM (12 h fingerstick calibration), checks 07:00 and 19:00',cgms:['dexcom_g5','medtronic_guardian_3'],meter:'required',
    routine:()=>({meter:{routine_times:['07:00','19:00']}}),expected:{fingersticks:2,scans:0}},
  flash_frequent:{label:'Flash (scan to read), scans every 2 h while awake (07:00-23:00)',cgms:['libre_1_scan','libre_2_scan'],meter:'optional',
    routine:()=>({meter:{routine_times:[]},cgm:{scan_window:['07:00','23:00'],scan_interval_minutes:120}}),expected:{fingersticks:0,scans:9}},
  flash_sparse:{label:'Flash, 4 scans: pre-breakfast to bedtime, evenly spaced',cgms:['libre_1_scan','libre_2_scan'],meter:'optional',
    routine:meals=>{
      // The flash routine is a window + interval, so "before meals and bedtime" is approximated by 4
      // evenly spaced scans from 15 min before breakfast to bedtime (22:00).
      const a=hm(meals[0])-15,step=Math.round((hm(BEDTIME)-a)/3/5)*5;
      return {meter:{routine_times:[]},cgm:{scan_window:[hhmm(a),hhmm(a+3*step)],scan_interval_minutes:step}};
    },expected:{fingersticks:0,scans:4}},
  smbg_intensive:{label:'Meter only: before meals, 2 h after meals, bedtime (7/day)',cgms:[null],meter:'required',
    routine:meals=>({meter:{routine_times:[...new Set([...meals.map(t=>hhmm(hm(t)-15)),...meals.map(t=>hhmm(hm(t)+120)),BEDTIME])].sort()}}),
    expected:{fingersticks:7,scans:0}},
  smbg_standard:{label:'Meter only: before meals and bedtime (4/day)',cgms:[null],meter:'required',
    routine:meals=>({meter:{routine_times:[...new Set([...meals.map(t=>hhmm(hm(t)-15)),BEDTIME])].sort()}}),expected:{fingersticks:4,scans:0}},
  smbg_sparse:{label:'Meter only: morning and evening (2/day)',cgms:[null],meter:'required',
    routine:meals=>({meter:{routine_times:[hhmm(hm(meals[0])-15),BEDTIME]}}),expected:{fingersticks:2,scans:0}},
});
export const PROFILE_IDS=Object.keys(OBSERVATION_PROFILES);

/** Config overrides implementing an observation profile for a spec (uses the person's meal plan). */
export function profileOverrides(profileId,spec) {
  const p=OBSERVATION_PROFILES[profileId];if(!p)throw new Error(`Unknown observation profile ${profileId}`);
  const {overrides,...base}=spec;
  return p.routine(mainMeals(buildInstanceConfig(base)));
}

// ---- factors ----------------------------------------------------------------------------------

const sensorSetup=cgm=>!cgm?'meter_only':K.sensors[cgm].modality==='flash'?'flash':K.sensors[cgm].calibration?.required?'calibrated_cgm':'cgm';

/** §2.4 factors of a sampled choice. */
function choiceFactors(c) {
  const t=c.therapy,p=K.persons[c.person_type];
  const f={person_type:c.person_type,age_group:p.age_group,sex:p.sex,bmi:c.bmi,dawn:c.dawn,carb_counting:c.carb_counting,mode:t.mode};
  if(t.mode==='pump')Object.assign(f,{pump:t.pump.model,rapid_insulin:t.pump.insulin});
  else Object.assign(f,{bolus_pen:t.mdi.bolus_pen,rapid_insulin:t.mdi.bolus_insulin,basal_pen:t.mdi.basal_pen,basal_insulin:t.mdi.basal_insulin});
  Object.assign(f,{observation_profile:c.profile,sensor_setup:sensorSetup(c.cgm),cgm:c.cgm??'none',meter:c.meter??'none',
    controller:'off',event_packs:[...c.events].sort()});
  return f;
}

/** Factor levels used for per-factor summaries (event_pack is multi-valued). */
export function factorLevels(inst) {
  const f=inst.factors;
  return {observation_profile:f.observation_profile,mode:f.mode,device:f.mode==='pump'?f.pump:'pen',person_type:f.person_type,
    age_group:f.age_group,event_pack:f.event_packs?.length?f.event_packs:['none'],tier:inst.tier??null};
}

/** Coverage units (levels and level pairs) of a factor set, as in catalog.diverseSample. */
function coverageUnits(f) {
  const k={person_type:f.person_type,bmi:f.bmi,dawn:f.dawn,carb_counting:f.carb_counting,mode:f.mode,profile:f.observation_profile,
    cgm:f.cgm,meter:f.meter,device:f.pump??f.bolus_pen,rapid_insulin:f.rapid_insulin,basal_insulin:f.basal_insulin??'none',event_count:String(f.event_packs.length)};
  for(const e of f.event_packs)k[`event:${e}`]='on';
  const e=Object.entries(k).sort(([a],[b])=>a<b?-1:1),out=e.map(([a,v])=>`${a}=${v}`);
  for(let i=0;i<e.length;i++)for(let j=i+1;j<e.length;j++)out.push(`${e[i][0]}=${e[i][1]}|${e[j][0]}=${e[j][1]}`);
  return out;
}

// ---- quota sampler (§2.3) ---------------------------------------------------------------------

/** Minimum counts per factor level (scaled from the n=200 design) and balancing caps. */
export function suiteQuotas(n,d=dimensions()) {
  // Scaled minimums never exceed an even share (small test suites stay feasible).
  const s=n/200,min=(k,levels=1)=>Math.max(1,Math.min(Math.ceil(k*s),Math.floor(n/levels)));
  return {
    min:{observation_profile:Object.fromEntries(PROFILE_IDS.map(p=>[p,min(24,PROFILE_IDS.length)])),
      person_type:Object.fromEntries(d.person_type.map(p=>[p,min(20,d.person_type.length)])),
      mode:{pump:Math.floor(0.45*n),mdi:Math.floor(0.45*n)},
      event_pack:Object.fromEntries(d.event_packs.map(p=>[p,min(20)]))},
    cap:{observation_profile:Math.ceil(n/PROFILE_IDS.length),person_type:Math.ceil(n/d.person_type.length),mode:Math.ceil(n/2)},
  };
}

const pick=(rng,xs)=>xs[Math.floor(rng.next()*xs.length)];
const seedFor=(suiteSeed,index)=>(suiteSeed%40000)*100000+index*100;   // repeats use seed + r (r < 100)

function countLevels(instances) {
  const c={observation_profile:{},person_type:{},mode:{},event_pack:{}};
  const inc=(k,v)=>{c[k][v]=(c[k][v]??0)+1;};
  for(const x of instances){const f=x.factors;inc('observation_profile',f.observation_profile);inc('person_type',f.person_type);inc('mode',f.mode);
    for(const e of f.event_packs)inc('event_pack',e);}
  return c;
}

/**
 * Picks one instance: draws `candidates` random valid choices within the allowed profile /
 * person / mode levels and keeps the one that best fills unmet quotas, then adds the most new
 * coverage units. Candidates whose spec fails to build (e.g. a sampled age outside a pack's
 * range) are skipped.
 */
function sampleOne(rng,{d,quotas,counts,covered,allowed,index,suiteSeed,hours,candidates=200}) {
  const W=1000,meters=Object.keys(K.meters),scored=[];
  for(let i=0;i<candidates;i++) {
    const profile=pick(rng,allowed.observation_profile),person_type=pick(rng,allowed.person_type),mode=pick(rng,allowed.mode);
    const P=OBSERVATION_PROFILES[profile],therapy=pick(rng,d.therapy.filter(t=>t.mode===mode));
    const cgm=pick(rng,P.cgms),meter=P.meter==='required'?pick(rng,meters):pick(rng,[null,...meters]);
    const packs=applicablePacks(person_type,therapy),k=Math.floor(rng.next()*(Math.min(3,packs.length)+1)),pool=[...packs];
    const events=Array.from({length:k},()=>pool.splice(Math.floor(rng.next()*pool.length),1)[0]);
    const c={profile,person_type,bmi:pick(rng,d.bmi),dawn:pick(rng,d.dawn),carb_counting:pick(rng,d.carb_counting),therapy,cgm,meter,events};
    const f=choiceFactors(c);
    let gain=coverageUnits(f).filter(u=>!covered.has(u)).length;
    for(const e of events)if((counts.event_pack[e]??0)<quotas.min.event_pack[e])gain+=W;
    scored.push({c,f,gain,i});
  }
  scored.sort((a,b)=>b.gain-a.gain||a.i-b.i);
  for(const {c,f} of scored) {
    const seed=seedFor(suiteSeed,index);
    const choice={person_type:c.person_type,bmi:c.bmi,dawn:c.dawn,carb_counting:c.carb_counting,therapy:c.therapy,
      sensors:{cgm:c.cgm,meter:c.meter},controller:'manual',events:c.events};
    const spec=makeSpec(choice,{seed,sample:true,horizon_minutes:Math.round(hours*60)});
    spec.person.seed=seed;   // the individual is fixed per instance; repeats (seed + r) change only the day
    try {
      spec.overrides=profileOverrides(c.profile,spec);
      buildInstanceConfig(spec);
    } catch {continue;}
    return {factors:f,spec,candidate_index:index};
  }
  throw new Error('No valid candidate found; increase candidates');
}

function addCounts(counts,covered,inst) {
  const f=inst.factors;
  for(const [k,v] of [['observation_profile',f.observation_profile],['person_type',f.person_type],['mode',f.mode]])counts[k][v]=(counts[k][v]??0)+1;
  for(const e of f.event_packs)counts.event_pack[e]=(counts.event_pack[e]??0)+1;
  for(const u of coverageUnits(f))covered.add(u);
}

const underCap=(counts,quotas,key,levels)=>{const xs=levels.filter(v=>(counts[key][v]??0)<quotas.cap[key]);return xs.length?xs:levels;};

/** Checks the §2.3 quotas; returns {ok, failures, counts}. */
export function checkQuotas(instances,n=instances.length) {
  const q=suiteQuotas(n),c=countLevels(instances),failures=[];
  for(const [k,levels] of Object.entries(q.min))for(const [v,min] of Object.entries(levels))
    if((c[k][v]??0)<min)failures.push(`${k}=${v}: ${c[k][v]??0} < ${min}`);
  return {ok:!failures.length,failures,counts:c,min:q.min};
}

const idOf=(prefix,i)=>`${prefix}-${String(i).padStart(4,'0')}`;

/**
 * Quota-based diverse sample of n instance specs (no simulation). Every spec has
 * person.sample=true with person.seed = the instance seed, its own seed, the built-in controller disabled, and the observation
 * profile's measurement routine as overrides. Instances get a provisional split (tier null);
 * screenSuite replaces degenerate instances and assigns tiers and the final split.
 */
export function buildSuite({name='bench',n=200,devFraction=0.2,seed,hours=24,prefix='b01',candidates=200}={}) {
  seed??=streamSeed(0,`suite:${name}`)%40000;
  const d=dimensions(),quotas=suiteQuotas(n,d),rng=Rng.stream(seed,'bench:suite');
  const counts=countLevels([]),covered=new Set(),instances=[];
  for(let i=0;i<n;i++) {
    const allowed={observation_profile:underCap(counts,quotas,'observation_profile',PROFILE_IDS),
      person_type:underCap(counts,quotas,'person_type',d.person_type),mode:underCap(counts,quotas,'mode',['pump','mdi'])};
    const x=sampleOne(rng,{d,quotas,counts,covered,allowed,index:i,suiteSeed:seed,hours,candidates});
    const inst={id:idOf(prefix,i),split:null,tier:null,factors:x.factors,spec:x.spec,candidate_index:x.candidate_index};
    addCounts(counts,covered,inst);instances.push(inst);
  }
  const suite={meta:{name,seed,n,hours,dev_fraction:devFraction,prefix,candidates,next_candidate:n,coverage_units:covered.size},instances};
  assignSplit(suite);
  return suite;
}

/** Replacement for a dropped instance: same observation profile, person type and mode (keeps quotas). */
function refill(suite,dropped,keep,round) {
  const d=dimensions(),{meta}=suite,quotas=suiteQuotas(meta.n,d),counts=countLevels(keep),covered=new Set();
  for(const x of keep)for(const u of coverageUnits(x.factors))covered.add(u);
  const rng=Rng.stream(meta.seed,`bench:suite:refill:${round}:${dropped.id}`),f=dropped.factors;
  const x=sampleOne(rng,{d,quotas,counts,covered,index:meta.next_candidate++,suiteSeed:meta.seed,hours:meta.hours,candidates:meta.candidates,
    allowed:{observation_profile:[f.observation_profile],person_type:[f.person_type],mode:[f.mode]}});
  return {id:dropped.id,split:null,tier:null,factors:x.factors,spec:x.spec,candidate_index:x.candidate_index};
}

// ---- tiers and split --------------------------------------------------------------------------

const TIERS=['hard','medium','easy'];
const hashKey=(seed,s)=>streamSeed(seed,s);

/** Tertiles of the patient baseline's normalized score (ties broken by its raw score, then id). */
export function assignTiers(instances) {
  const key=x=>{const s=x.screening;if(!s)return [0,0];const n=normalizeScore(s.patient,s).normalized;return [n??0,s.patient];};
  const sorted=[...instances].sort((a,b)=>{const ka=key(a),kb=key(b);return ka[0]-kb[0]||ka[1]-kb[1]||(a.id<b.id?-1:1);});
  sorted.forEach((x,i)=>{x.tier=TIERS[Math.min(2,Math.floor(i*3/sorted.length))];});
}

/** dev/test split stratified by observation profile (and spread across tiers within a profile). */
export function assignSplit(suite) {
  const {instances,meta}=suite,total=Math.round(instances.length*meta.dev_fraction);
  const groups=PROFILE_IDS.map(p=>instances.filter(x=>x.factors.observation_profile===p)).filter(g=>g.length);
  // Largest-remainder allocation of the dev count across profiles.
  const exact=groups.map(g=>g.length*meta.dev_fraction),alloc=exact.map(Math.floor);
  const order=exact.map((e,i)=>[e-Math.floor(e),i]).sort((a,b)=>b[0]-a[0]||a[1]-b[1]);
  for(let r=total-alloc.reduce((a,b)=>a+b,0),j=0;r>0;r--,j++)alloc[order[j%order.length][1]]++;
  groups.forEach((g,gi)=>{
    const tierRank=x=>x.tier?TIERS.indexOf(x.tier):0;
    const s=[...g].sort((a,b)=>tierRank(a)-tierRank(b)||hashKey(meta.seed,a.id)-hashKey(meta.seed,b.id));
    const k=alloc[gi],m=s.length;
    s.forEach((x,i)=>{x.split=Math.floor((i+1)*k/m)>Math.floor(i*k/m)?'dev':'test';});
  });
}

// ---- episodes (baselines) ---------------------------------------------------------------------

/**
 * Spec of an instance for repeat r on a track: seed = spec.seed + r (the harness uses the same
 * rule; person.seed stays, so every repeat is the same individual) and the track's self_care.
 */
export function repeatSpec(instance,repeat=0,hours,track=DEFAULT_TRACK) {
  return trackSpec({...instance.spec,seed:instance.spec.seed+repeat,...(hours?{horizon_minutes:Math.round(hours*60)}:{})},track);
}

/** Runs one code-policy episode in-process; returns the SimEnv. */
export function runPolicyEpisode(spec,policy,{agentOptions=null}={}) {
  const env=new SimEnv(buildInstanceConfig(spec)),decide=POLICIES[policy](agentOptions);
  if(!decide)throw new Error(`Unknown baseline policy ${policy}`);
  while(!env.done()) {
    const d=decide(env.observe());
    env.step({action_id:`${policy}-${env.step_count}`,expected_step:env.step_count,action:d.action,rationale:String(d.rationale??'').slice(0,4000)});
  }
  if(decide.execution_protocol){env.baselineProtocol=decide.execution_protocol;env.baselineGating=decide.gating;}
  return env;
}

export function episodeDir(root,instanceId,repeat) {return path.join(root,instanceId,`r${repeat}`);}

/** Executes one pool task (screening or baseline episode). Runs inside workers or inline. */
function runTask(task) {
  const t0=performance.now(),spec=repeatSpec(task.instance,task.repeat,task.hours,task.track);
  if(task.kind==='screen') {
    const env=runPolicyEpisode(spec,task.policy),m=episodeMetrics(env.exportBundle());
    return {id:task.instance.id,policy:task.policy,score:episodeScore(m).score,tir:m.glucose.tir,ms:performance.now()-t0};
  }
  // baseline episode with files
  const dir=episodeDir(task.root,task.instance.id,task.repeat),statusFile=path.join(dir,'status.json');
  if(!task.force&&fs.existsSync(statusFile)) {
    const existing=JSON.parse(fs.readFileSync(statusFile,'utf8'));
    if(existing.state==='done') {
      if(CLASSICAL_BASELINES.includes(task.policy)&&(existing.execution_protocol?.kind!=='policy-hourly'
        ||existing.execution_protocol.version!==BASELINE_CADENCE_VERSION))
        throw Error('Existing baseline uses the historical cadence; preserve it and choose a new output instead of reusing it as hourly');
      return {id:task.instance.id,skipped:true,ms:0};
    }
  }
  fs.mkdirSync(dir,{recursive:true});
  const started=new Date().toISOString(),env=runPolicyEpisode(spec,task.policy),bundle=env.exportBundle();
  const bundleText=JSON.stringify(bundle);
  if(task.gzip){fs.writeFileSync(path.join(dir,'bundle.json.gz'),zlib.gzipSync(bundleText));fs.rmSync(path.join(dir,'bundle.json'),{force:true});}
  else {fs.writeFileSync(path.join(dir,'bundle.json'),bundleText);fs.rmSync(path.join(dir,'bundle.json.gz'),{force:true});}
  const run=runFromBundle(bundle,{id:`${task.instance.id}-r${task.repeat}`});
  Object.assign(run,{policy:`baseline:${task.policy}`,factors:task.instance.factors,packs:task.instance.factors.event_packs,
    ...(env.baselineProtocol?{execution_protocol:env.baselineProtocol,baseline_gating:env.baselineGating}:{})});
  fs.writeFileSync(path.join(dir,'run.json'),JSON.stringify(run));
  const metrics=episodeMetrics(bundle,{status:null});
  fs.writeFileSync(path.join(dir,'metrics.json'),JSON.stringify(metrics,null,1));
  const finished=new Date().toISOString();
  fs.writeFileSync(statusFile,JSON.stringify({state:'done',reason:null,turns:env.step_count,started,finished,model:`baseline:${task.policy}`,
    suite:task.suite,track:task.track,instance:task.instance.id,repeat:task.repeat,seed:spec.seed,harness_version:BASELINE_HARNESS_VERSION,
    ...(env.baselineProtocol?{execution_protocol:env.baselineProtocol,baseline_gating:env.baselineGating}:{})},null,1));
  return {id:task.instance.id,policy:task.policy,repeat:task.repeat,score:episodeScore(metrics).score,ms:performance.now()-t0};
}

export const defaultParallel=()=>Math.max(1,(os.availableParallelism?.()??os.cpus().length)-1);

/** Runs tasks on a worker_threads pool (inline when parallel<=1); results are returned in task order. */
export async function runPool(tasks,{parallel=defaultParallel(),onResult}={}) {
  const results=new Array(tasks.length);
  if(parallel<=1||tasks.length<=1) {
    tasks.forEach((t,i)=>{results[i]=runTask(t);onResult?.(results[i],i);});
    return results;
  }
  let next=0,done=0;
  await new Promise((resolve,reject)=>{
    const workers=[];
    const finish=err=>{for(const w of workers)w.terminate();err?reject(err):resolve();};
    for(let k=0;k<Math.min(parallel,tasks.length);k++) {
      const w=new Worker(new URL(import.meta.url),{workerData:{role:WORKER_ROLE}});workers.push(w);
      const feed=()=>{if(next<tasks.length){const i=next++;w.postMessage({i,task:tasks[i]});}};
      w.on('message',m=>{
        if(m.error)return finish(new Error(`task ${m.i} failed: ${m.error}`));
        results[m.i]=m.result;onResult?.(m.result,m.i);
        if(++done===tasks.length)finish();else feed();
      });
      w.on('error',finish);
      feed();
    }
  });
  return results;
}

if(!isMainThread&&workerData?.role===WORKER_ROLE) {
  parentPort.on('message',({i,task})=>{
    try {parentPort.postMessage({i,result:runTask(task)});}
    catch(e) {parentPort.postMessage({i,error:e.stack??String(e)});}
  });
}

// ---- screening --------------------------------------------------------------------------------

export const SCREEN_POLICIES=['wait','patient','oref0'];   // screening runs on the full track

/**
 * Runs the three baselines (repeat 0) on every unscreened instance, drops degenerate ones
 * (wait already ≥ waitMax, or the best baseline ≤ bestMin) and refills them with a new instance of
 * the same observation profile, person type and mode; repeats up to maxRounds. Then assigns
 * tiers and the final split. Mutates and returns the suite.
 */
export async function screenSuite(suite,{parallel=defaultParallel(),maxRounds=6,waitMax=0.98,bestMin=0.02,onProgress}={}) {
  const dropped=[];let round=0;
  const t0=performance.now();let episodes=0;
  for(;round<maxRounds;round++) {
    const todo=suite.instances.filter(x=>!x.screening);
    if(!todo.length)break;
    const tasks=todo.flatMap(x=>SCREEN_POLICIES.map(policy=>({kind:'screen',instance:x,policy,repeat:0,hours:suite.meta.hours})));
    const res=await runPool(tasks,{parallel,onResult:()=>{episodes++;onProgress?.({round,done:episodes});}});
    todo.forEach((x,i)=>{x.screening=Object.fromEntries(SCREEN_POLICIES.map((p,j)=>[p,Number(res[i*3+j].score.toFixed(4))]));});
    const bad=suite.instances.filter(x=>{const s=x.screening;return s.wait>=waitMax||Math.max(s.wait,s.patient,s.oref0)<=bestMin;});
    if(!bad.length)break;
    if(round===maxRounds-1){for(const x of bad)x.degenerate=true;break;}
    for(const x of bad) {
      const s=x.screening,keep=suite.instances.filter(y=>y!==x);
      dropped.push({id:x.id,round,candidate_index:x.candidate_index,reason:s.wait>=waitMax?'wait_already_good':'all_baselines_fail',screening:s,
        observation_profile:x.factors.observation_profile,person_type:x.factors.person_type,mode:x.factors.mode,event_packs:x.factors.event_packs});
      suite.instances[suite.instances.indexOf(x)]=refill(suite,x,keep,round);
    }
  }
  assignTiers(suite.instances);
  assignSplit(suite);
  suite.meta.screening={policies:SCREEN_POLICIES,repeat:0,rule:{wait_score_at_least:waitMax,best_baseline_at_most:bestMin},
    rounds:round+1,dropped,degenerate_kept:suite.instances.filter(x=>x.degenerate).map(x=>x.id),
    episodes,seconds:Number(((performance.now()-t0)/1000).toFixed(1))};
  return suite;
}

// ---- files ------------------------------------------------------------------------------------

function gitInfo() {
  try {
    const commit=execFileSync('git',['rev-parse','--short','HEAD'],{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
    // Dirty = uncommitted or untracked changes in the code and data that determine episodes.
    const dirty=execFileSync('git',['status','--porcelain','--','src','knowledge','model','vendor'],{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().length>0;
    return {commit,dirty};
  } catch {return {commit:null,dirty:null};}
}

/** Writes suite.json and instances.jsonl into dir. */
export function writeSuite(suite,dir) {
  fs.mkdirSync(dir,{recursive:true});
  const {meta,instances}=suite,q=checkQuotas(instances,meta.n),git=gitInfo();
  const count=(pred)=>instances.filter(pred).length;
  const suiteJson={format:SUITE_FORMAT,name:meta.name,created:new Date().toISOString(),
    sweet_sim_commit:git.commit,sweet_sim_dirty:git.dirty,knowledge_sha256:KNOWLEDGE_SHA256,kernel_sha256:KERNEL_SHA256,environment_version:ENV_VERSION,
    hours:meta.hours,units_for_agent:'mmol/L',seed:meta.seed,
    counts:{total:instances.length,dev:count(x=>x.split==='dev'),test:count(x=>x.split==='test'),
      tier:Object.fromEntries(TIERS.map(t=>[t,count(x=>x.tier===t)]))},
    quotas:q.min,quota_check:{ok:q.ok,failures:q.failures},achieved:q.counts,
    observation_profiles:Object.fromEntries(Object.entries(OBSERVATION_PROFILES).map(([k,p])=>[k,{label:p.label,cgms:p.cgms,meter:p.meter,expected_per_day:p.expected}])),
    controller:'disabled for every instance (the agent is the only decision maker)',
    repeat_seed_rule:'repeat r runs the instance with seed = spec.seed + r; person.seed = spec.seed is kept, so repeats are the same individual on a different day',
    tracks:Object.fromEntries(Object.entries(TRACKS).map(([k,t])=>[k,{label:t.label,self_care:t.self_care,baselines:t.baselines}])),
    screening_track:'full',
    sampling:{method:'quota-constrained greedy coverage of factor levels and level pairs (catalog.diverseSample style)',
      candidates_per_slot:meta.candidates,coverage_units:meta.coverage_units,dev_fraction:meta.dev_fraction},
    screening:meta.screening??null,
    tier_rule:'tertiles of the patient baseline normalized score on repeat 0 (ties by its raw score)',
    notes:'Instances are specs for buildInstanceConfig(spec). person.sample=true draws individual physiology from the person type with person.seed (= the instance base seed). A track sets spec.self_care (src/bench/tracks.mjs).'};
  fs.writeFileSync(path.join(dir,'suite.json'),JSON.stringify(suiteJson,null,1));
  fs.writeFileSync(path.join(dir,'instances.jsonl'),instances.map(x=>JSON.stringify({id:x.id,split:x.split,tier:x.tier,factors:x.factors,spec:x.spec,
    screening:x.screening??null,...(x.degenerate?{degenerate:true}:{}),candidate_index:x.candidate_index})).join('\n')+'\n');
  return suiteJson;
}

/** Reads a suite dir: {dir, meta (suite.json), instances}. */
export function loadSuite(dir) {
  const meta=JSON.parse(fs.readFileSync(path.join(dir,'suite.json'),'utf8'));
  const instances=fs.readFileSync(path.join(dir,'instances.jsonl'),'utf8').split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l));
  return {dir,meta,instances};
}

/**
 * Baseline directory of a track: <suiteDir>/baselines/<track>. Suites built before tracks existed
 * (baselines/<policy> directly) are read as the full track.
 */
export function baselineRoot(suiteDir,track=DEFAULT_TRACK) {
  const dir=path.join(suiteDir,'baselines',checkTrack(track));
  if(track==='full'&&!fs.existsSync(dir)&&fs.existsSync(path.join(suiteDir,'baselines','wait')))return path.join(suiteDir,'baselines');
  return dir;
}

/**
 * Runs code baselines of a track for every instance (filtered by split/ids) and repeat into
 * <suiteDir>/baselines/<track>/<policy>/<instance>/r<k>/{bundle.json, run.json, metrics.json, status.json}.
 * policies default to the track's baselines; 'patient' is refused on the assisted track (it would
 * bolus the meals the person already bolused). Resumable: episodes with status 'done' are skipped unless force.
 */
export async function runBaselines({suiteDir,track=DEFAULT_TRACK,repeats=3,policies=null,parallel=defaultParallel(),split='all',ids=null,gzip=false,force=false,onProgress}={}) {
  checkTrack(track);
  policies??=TRACKS[track].baselines;
  for(const p of policies)if(!TRACKS[track].baselines.includes(p))
    throw new Error(`Baseline ${p} is not defined on the ${track} track (baselines: ${TRACKS[track].baselines.join(', ')})`);
  const suite=loadSuite(suiteDir),want=ids?new Set(ids):null;
  const instances=suite.instances.filter(x=>(split==='all'||x.split===split)&&(!want||want.has(x.id)));
  const tasks=[];
  for(const policy of policies)for(const x of instances)for(let r=0;r<repeats;r++)
    tasks.push({kind:'baseline',instance:x,policy,repeat:r,hours:suite.meta.hours,track,root:path.join(suiteDir,'baselines',track,policy),suite:suite.meta.name,gzip,force});
  const t0=performance.now();let done=0;
  const results=await runPool(tasks,{parallel,onResult:r=>onProgress?.({done:++done,total:tasks.length,result:r})});
  const ran=results.filter(r=>!r.skipped);
  return {episodes:tasks.length,ran:ran.length,skipped:results.length-ran.length,seconds:(performance.now()-t0)/1000,
    episode_ms_mean:ran.length?ran.reduce((a,r)=>a+r.ms,0)/ran.length:0};
}
