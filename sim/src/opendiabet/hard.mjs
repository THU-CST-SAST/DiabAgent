// OpenDiabet v1.1-hard: harder variants of the v1 environments (docs/OPENDIABET-V1.zh-CN.md §6).
// A hard candidate = a v1 environment (same task, backend, setting, person type, pens) plus a
// hardness layer drawn from its own stream:
//   (a) partial observability   scenario.masking: per event type, the visible notice is withheld
//                               (meal announcements, exercise plan/start, alcohol/illness/poor-sleep
//                               reports, high-fat remarks, routine-injection notices; device alarms
//                               stay on unless knobs.device_alarms > 0)
//   (b) late and distorted reports  scenario.announcement.report_delay (15-45 min after eating) and a
//                               larger, biased carb-count error (randomized setting; not for tasks
//                               whose carb error is the task itself)
//   (c) compound events         2-4 overlapping event packs (randomized), forced to occur around the
//                               task's own moment
//   (d) surprises at risky moments   unannounced exercise when insulin on board peaks, overnight
//                               occlusion, CGM dropout during the steepest fall, forgotten self-bolus
//                               of the largest meal (assisted), sudden illness
//   (e) observation degradation CGM gap during a fall (d), compression low at night
// Surprise placement uses a reference trace of the same environment without surprises played by
// the `patient` baseline (insulin on board and true glucose), never anything an agent could not
// in principle face. Every surprise is recorded in evaluator-only metadata (env.hard.surprises);
// withheld notices and late reports are flagged on the evaluator events and derived at scoring.
// Public information (spec.events packs) says what *can* happen (unannounced meals, occlusions,
// compound packs), never when.
import {Rng,streamSeed} from '../core/rng.mjs';
import {buildInstanceConfig} from '../sim/instance.mjs';
import {SimEnv} from '../env/pomdp.mjs';
import {POLICIES} from '../viz/run.mjs';
import {applicablePacks} from '../population/catalog.mjs';
import {CGMS} from '../core/cgm.mjs';
import {trueGrid,derivedSurprises} from '../bench/score.mjs';
import {generateEnvironment,inspectEnvironment,mergeLayers,BACKENDS,SETTINGS} from './generate.mjs';
import {taskById,TASK_IDS} from './tasks.mjs';

export const HARD_NAME='opendiabet-v1.1-hard';
export const HARD_GENERATOR_VERSION='opendiabet-hard-generator/1.1';
export const SURPRISE_TYPES=['unannounced_exercise','sudden_illness','cgm_dropout','compression_low','overnight_occlusion','forgotten_self_bolus'];
export const COMPOUND_POOL=['anaerobic_exercise','alcohol','illness','sleep_loss','stress','high_fat_meals'];
/** Knob ranges per setting: clean keeps masking light (surprises still allowed); randomized is heavy. */
export const HARD_LEVELS=Object.freeze({
  clean:{masking:{meal_announcement:[0.05,0.15]},report_delay:[0,0],carb:null,extra_packs:[0,1],surprises:[1,2]},
  randomized:{masking:{meal_announcement:[0.15,0.4],exercise:[0.3,0.8],alcohol:[0.3,0.8],illness:[0.3,0.8],sleep_loss:[0.3,0.8],
    composition:[0.3,0.8],basal_injection_notice:[0.2,0.6]},report_delay:[0.3,0.7],carb:{bias:[-0.25,0.1],sd:[0.1,0.2]},
    extra_packs:[2,4],surprises:[2,3]},
});
const BACKUP_METER='contour_next_one';
const clone=x=>structuredClone(x);
const u=(r,a,b)=>a+(b-a)*r.next();
const r2=v=>Number(v.toFixed(2));
const round5=m=>Math.round(m/5)*5;
const hhmm=m=>{m=((Math.round(m)%1440)+1440)%1440;return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;};
const minOf=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
const shuffle=(r,xs)=>{const a=[...xs];for(let i=a.length-1;i>0;i--){const j=Math.floor(r.next()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};

export const hardSeed=(task,backend,setting,seedIndex,k)=>streamSeed(0,`${HARD_NAME}:${task}:${backend}:${setting}:s${seedIndex}:c${k}`)%1000000000;

/** Local start minute of a config (episode minute m is local (start + m) mod 1440). */
const startLocal=cfg=>((Date.parse(cfg.start_time)/60000+cfg.utc_offset_minutes)%1440+1440)%1440;

/**
 * Reference trace of a spec: the patient baseline (full track) for 24 h; returns
 * {iob: [[minute, U]], glucose: [[minute, mg/dL]], events (evaluator events in the horizon)}.
 */
export function referenceTrace(spec,hours=24) {
  const env=new SimEnv(buildInstanceConfig({...spec,self_care:'none',horizon_minutes:Math.round(hours*60)})),pol=POLICIES.patient();
  const iob=[];
  while(!env.done()) {
    const o=env.observe();iob.push([o.elapsed_minutes,o.iob.total_u]);
    const d=pol(o);env.step({action_id:`ref-${env.step_count}`,expected_step:env.step_count,action:d.action});
  }
  const b=env.exportBundle();
  return {iob,glucose:trueGrid(b).map(p=>[p.m,p.g]),events:b.evaluator_only.events,config:b.manifest.config};
}

/** Draws the hardness knobs of a candidate (pure function of the stream). */
export function drawKnobs(r,{setting,card,family,cfg,personType,therapy,level=HARD_LEVELS[setting],intensity=1}) {
  const masking={};
  for(const [k,[a,b]] of Object.entries(level.masking))masking[k]=r2(intensity*u(r,a,b));
  const rdP=r2(intensity*u(r,...level.report_delay));
  const carb=level.carb&&!card.keepsCarbCounting?{bias:r2(u(r,...level.carb.bias)),sd:r2(u(r,...level.carb.sd))}:null;
  const own=new Set(cfg.__packs??[]);
  const pool=COMPOUND_POOL.filter(p=>!own.has(p)&&applicablePacks(personType,therapy).includes(p));
  // Total event packs (task + background + compound) drawn in [lo, hi]; compound packs fill the rest.
  const [lo,hi]=level.extra_packs,total=Math.round((lo+Math.floor(r.next()*(hi-lo+1)))*Math.min(1,intensity+0.25));
  const extraPacks=shuffle(r,pool).slice(0,Math.max(0,total-own.size));
  const realtime=CGMS[cfg.cgm.model]?.modality==='cgm';
  const eligible=SURPRISE_TYPES.filter(t=>t!=='forgotten_self_bolus'&&(t==='overnight_occlusion'?family==='pump'&&!['T18','T19'].includes(card.id)
    :t==='cgm_dropout'||t==='compression_low'?realtime&&card.id!=='T20':true));
  const [s0,s1]=level.surprises,ns=Math.min(eligible.length,Math.max(1,Math.round((s0+Math.floor(r.next()*(s1-s0+1)))*intensity)));
  const surprises=shuffle(r,eligible).slice(0,ns);
  const forgotten=r.next()<0.5;   // assisted-track surprise (no effect on the full track)
  return {masking,report_delay:{probability:rdP,min_minutes:15,max_minutes:45},carb,extra_packs:extraPacks,surprise_types:surprises,forgotten_self_bolus:forgotten};
}

/** Overrides that force a compound pack to occur near the anchor (local minutes). */
function compoundLayer(pack,r,{anchor,cfg}) {
  const at=hhmm(round5(anchor+u(r,-60,60)));
  switch(pack) {
    case 'anaerobic_exercise':return {scenario:{anaerobic:{enabled:true,probability:1,time:at,time_jitter_minutes:10,duration_minutes:round5(u(r,30,50)),announced:true,advance_notice_minutes:round5(u(r,20,60))}}};
    case 'alcohol':return {scenario:{alcohol:{enabled:true,probability:1,time:hhmm(round5(u(r,0,90))),time_jitter_minutes:10,announced:true}}};
    case 'illness':return {scenario:{illness:{enabled:true,probability_per_day:1,min_days:1,max_days:2,announced:true}}};
    case 'sleep_loss':return {scenario:{sleep_loss:{enabled:true,probability:1,announced:true}}};
    case 'stress':return {scenario:{stress:{enabled:true,probability:1,time:at,time_jitter_minutes:20,duration_minutes:round5(u(r,120,300)),hepatic_delta_mg_dl_per_min:r2(u(r,0.1,0.25))}}};
    case 'high_fat_meals': {
      const meals=clone(cfg.scenario.meals);for(const k of Object.keys(meals))meals[k].high_fat_probability=['lunch','dinner'].includes(k)?1:0;
      return {scenario:{meals,announcement:{report_composition:true}}};
    }
    default:return {};
  }
}

/** Surprise placement on the reference trace; returns {layer, surprise} (minutes from the start). */
function placeSurprise(type,r,{trace,cfg,i,s0,events}) {
  const H=cfg.horizon_minutes,toEp=local=>((local-s0)%1440+1440)%1440,id=`surprise:${type}:${i}`;
  const within=(xs,a,b)=>xs.filter(([m])=>m>=a&&m<b);
  const localWin=(a,b)=>{const x=toEp(a),y=x+((b-a+1440)%1440);return [x,Math.min(H-30,y)];};
  switch(type) {
    case 'unannounced_exercise': {
      const [a,b]=localWin(360,1260),cand=within(trace.iob,a,b);
      const [m]=cand.reduce((best,x)=>x[1]>best[1]?x:best,cand[0]??[a+120,0]);
      const at=round5(m),dur=round5(u(r,30,60)),AC=Math.round(u(r,2500,4500));
      return {layer:{extra:{id,type:'exercise',at_minute:at,duration_minutes:dur,accelerometer_counts:AC,announced:false}},
        surprise:{id,type,at_minute:at,duration_minutes:dur,detail:{accelerometer_counts:AC,iob_u:r2(m===at?cand.find(x=>x[0]===m)?.[1]??0:0)}}};
    }
    case 'sudden_illness': {
      const [a,b]=localWin(540,1020),at=round5(u(r,a,b)),inc=r2(u(r,0.3,0.6)),h=Math.round(u(r,24,48));
      return {layer:{extra:{id,type:'illness',at_minute:at,duration_hours:h,insulin_need_increase:inc,announced:false}},
        surprise:{id,type,at_minute:at,duration_minutes:h*60,detail:{insulin_need_increase:inc}}};
    }
    case 'cgm_dropout': {
      // The steepest 30-min fall of the reference trace (or the start of a surprise exercise).
      const g=trace.glucose;let best=null;
      for(let k=6;k<g.length;k++){const d=g[k][1]-g[k-6][1];if(g[k-6][0]>=60&&g[k][0]<H-60&&(!best||d<best.d))best={m:g[k-6][0],d};}
      const ex=events.find(e=>e.type==='exercise'&&e.id?.startsWith('surprise:'));
      const at=round5(ex?ex.at_minute+15:best?best.m:600),dur=round5(u(r,45,90));
      return {layer:{gap:{at_minute:at,duration_minutes:dur}},surprise:{id,type,at_minute:at,duration_minutes:dur,detail:{fall_mg_dl_per_30min:best?Math.round(best.d):null}}};
    }
    case 'compression_low': {
      const [a,b]=localWin(60,270),at=round5(u(r,a,b)),dur=round5(u(r,20,40)),depth=Math.round(u(r,35,55));
      return {layer:{compression:{at_minute:at,duration_minutes:dur,depth_mg_dl:depth}},surprise:{id,type,at_minute:at,duration_minutes:dur,detail:{depth_mg_dl:depth}}};
    }
    case 'overnight_occlusion': {
      const [a,b]=localWin(30,240),at=round5(u(r,a,b));
      return {layer:{occlusion:{at_minute:at}},surprise:{id,type,at_minute:at}};
    }
    default:throw new Error(`unknown surprise ${type}`);
  }
}

/** Intensity ladder over candidates (knob probabilities, surprise and compound counts scale with it). */
export const INTENSITY=[1,1,0.75,0.75,0.5,0.5];
export const intensityOf=k=>INTENSITY[k%INTENSITY.length];

/**
 * One hard candidate of a cell. k = candidate index (0..K-1): the base v1 environment uses attempt
 * k (next attempts if its mechanics check fails), the hardness layer its own stream, intensity
 * intensityOf(k).
 */
export function hardCandidate({task,backend,setting,seedIndex=1,k=0,levels=HARD_LEVELS,intensity=intensityOf(k)}) {
  if(!SETTINGS.includes(setting))throw new Error(`Unknown setting ${setting}`);
  let base=null;
  for(let a=k;a<k+6&&!base;a++){const e=generateEnvironment({task,backend,setting,seedIndex,attempt:a});if(inspectEnvironment(e).ok)base=e;}
  if(!base)throw new Error(`${task}-${backend}-${setting}: no base attempt passes the mechanics check`);
  const card=taskById(task),r=Rng.stream(hardSeed(task,backend,setting,seedIndex,k),'hard');
  const cfg0=buildInstanceConfig(base.spec);cfg0.__packs=base.factors.event_packs;
  const knobs=drawKnobs(r,{setting,card,family:base.family,cfg:cfg0,personType:base.factors.person_type,therapy:base.spec.therapy,level:levels[setting],intensity});
  const s0=startLocal(cfg0),anchorLocal=typeof base.mechanics?.time==='string'?minOf(base.mechanics.time):minOf(cfg0.scenario.meals.lunch?.time??'12:30');
  // (a)-(c): masking, late reports, carb distortion, compound packs.
  let layer={scenario:{masking:knobs.masking,announcement:{probability:cfg0.scenario.announcement.probability,report_delay:knobs.report_delay,
    ...(knobs.carb?{model:'normal',bias:knobs.carb.bias,sd:knobs.carb.sd}:{})}}};
  for(const p of knobs.extra_packs)layer=mergeLayers(layer,compoundLayer(p,r,{anchor:anchorLocal,cfg:cfg0}));
  const events=[...base.spec.events,...knobs.extra_packs];
  if(knobs.masking.meal_announcement>0||knobs.report_delay.probability>0)if(!events.includes('unannounced_meals'))events.push('unannounced_meals');
  let spec={...clone(base.spec),seed:base.seed,events,overrides:mergeLayers(base.spec.overrides,layer)};
  // (d)-(e): surprises placed on the reference trace of the environment so far.
  const trace=referenceTrace(spec),cfg=buildInstanceConfig(spec);
  const extra=[...cfg.scenario.extra_events],gaps=[...cfg.cgm.forced_gaps],comp=[...cfg.cgm.compression_lows],occl=[...cfg.faults.occlusions],surprises=[];
  const placed=[];
  // Exercise first so a CGM dropout can fall into it.
  const order=[...knobs.surprise_types].sort((a,b)=>(a==='unannounced_exercise'?-1:0)-(b==='unannounced_exercise'?-1:0));
  order.forEach((type,i)=>{
    const p=placeSurprise(type,r,{trace,cfg,i,s0,events:placed});
    if(p.layer.extra){extra.push(p.layer.extra);placed.push(p.layer.extra);}
    if(p.layer.gap)gaps.push(p.layer.gap);if(p.layer.compression)comp.push(p.layer.compression);if(p.layer.occlusion)occl.push(p.layer.occlusion);
    surprises.push({...p.surprise,track:'all'});
  });
  const patch={};
  if(extra.length!==cfg.scenario.extra_events.length)patch.scenario={extra_events:extra};
  if(gaps.length!==cfg.cgm.forced_gaps.length||comp.length)patch.cgm={...(gaps.length?{forced_gaps:gaps}:{}),...(comp.length?{compression_lows:comp}:{})};
  if(occl.length!==cfg.faults.occlusions.length) {
    patch.faults={occlusions:occl,occlusion_rate_per_day:cfg.faults.occlusion_rate_per_day};
    if(!spec.events.includes('occlusion_faults'))spec.events.push('occlusion_faults');   // public: occlusions can happen
  }
  // Sensor surprises come with a backup meter (the fair response is a fingerstick).
  if((gaps.length>cfg.cgm.forced_gaps.length||comp.length)&&!spec.sensors.meter)spec.sensors={...spec.sensors,meter:BACKUP_METER};
  if(knobs.forgotten_self_bolus) {
    const meals=trace.events.filter(e=>e.type==='meal'&&(e.announced_grams!=null||e.late_report)).sort((a,b)=>b.grams-a.grams);
    const m=meals[0];
    if(m) {
      patch.self_care={meal_bolus:{forced_miss:[m.name]}};
      const at=Math.round((m.at-Date.parse(cfg.start_time))/60000);
      surprises.push({id:`surprise:forgotten_self_bolus:${m.name}`,type:'forgotten_self_bolus',at_minute:at,track:'assisted',detail:{meal:m.name,grams:m.grams}});
    }
  }
  spec.overrides=mergeLayers(spec.overrides,patch);
  // occlusion_faults sets a random rate; keep the base rate (explicit onsets only).
  if(spec.events.includes('occlusion_faults')&&!base.spec.events.includes('occlusion_faults'))spec.overrides=mergeLayers(spec.overrides,{faults:{occlusion_rate_per_day:cfg0.faults.occlusion_rate_per_day}});
  const final=buildInstanceConfig(spec);   // validates
  // Withheld notices and late reports on this seed (evaluator-only; also derived at scoring).
  const w=new SimEnv(buildInstanceConfig({...spec,horizon_minutes:1440}));
  const derived=derivedSurprises({manifest:{config:w.config??final},evaluator_only:{events:w.events}});
  surprises.sort((a,b)=>a.at_minute-b.at_minute);
  const hard={candidate:k,base_attempt:base.attempt,level:setting==='clean'?'light':'heavy',intensity,hard_seed:hardSeed(task,backend,setting,seedIndex,k),
    knobs:{masking:knobs.masking,report_delay:knobs.report_delay,carb_report:knobs.carb,compound_packs:knobs.extra_packs,
      surprise_types:knobs.surprise_types,forgotten_self_bolus:knobs.forgotten_self_bolus},
    surprises,masked_events:derived.map(({source,...x})=>x),backup_meter_added:spec.sensors.meter===BACKUP_METER&&base.spec.sensors.meter!==BACKUP_METER,
    event_packs:spec.events.filter(p=>p!=='baseline')};
  return {...base,generator:HARD_GENERATOR_VERSION,suite:HARD_NAME,spec,
    factors:{...base.factors,event_packs:hard.event_packs,meter:spec.sensors.meter??'none',hard_level:hard.level,
      surprise_types:[...new Set(surprises.map(s=>s.type))],compound_packs:knobs.extra_packs.length},
    hard};
}

/** Explicit surprises a track is scored on (scoring.json; derived ones are added by the verifier). */
export const surprisesForTrack=(env,track)=>(env.hard?.surprises??[]).filter(s=>s.track==='all'||s.track===track)
  .map(({track:_,...s})=>s);

export const HARD_TASKS=TASK_IDS,HARD_BACKENDS=Object.keys(BACKENDS);
