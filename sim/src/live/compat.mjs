// Upstream sweet-sim compatibility for the live service:
//   - the upstream patient config (camelCase, admin API / persisted) and its validation,
//   - its translation into a World config,
//   - upstream-shaped views (status, treatments, samples, events) built from World,
//   - sleep/wake context labels (upstream had them; World has no sleep physiology),
//   - migration of an upstream VirtualPatient checkpoint into a World.
import {World} from '../sim/world.mjs';
import {normalizeConfig} from '../core/config.mjs';
import {Physiology,equilibriumBasalUph} from '../core/physiology.mjs';
import {Rng} from '../core/rng.mjs';
import {localDay,localAt} from '../core/scenario.mjs';
import {direction} from '../core/cgm.mjs';
import {iobDefinition} from '../core/estimators.mjs';
import {INSULINS} from '../core/insulins.mjs';

const clone=x=>structuredClone(x);
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export const DAY_MS=86400000;
export const SAMPLE_MS=5*60000;
export const UTC_OFFSET_MINUTES=480;            // upstream timezone is fixed to Asia/Shanghai
export const CARB_ABSORPTION_MINUTES=40;        // upstream CARBS used the kernel's tau_m (40 min)
export const MODEL_DESCRIPTION='Deichmann2023 ETH reference kernel; synthetic inputs; not a clinical prediction';
export const COB_DESCRIPTION='reported carbs (relay CARBS and logged meals) absorbed linearly over the estimate window; g';

// --- upstream config ---------------------------------------------------------------------

const num=(min,max)=>({kind:'number',min,max});
const int=(min,max)=>({kind:'int',min,max});
const bool={kind:'boolean'};
const time={kind:'time'};
const oneOf=(...values)=>({kind:'enum',values});
const MEAL={time,carbsG:num(1,200),carbsJitterG:num(0,80),timeJitterMinutes:int(0,90),absorptionMinutes:num(5,240)};
/** Same fields, ranges and strictness as upstream src/config.js (zod). */
const SCHEMA={
  subject:{sex:oneOf('male','female'),ageYears:int(1,120),heightCm:num(30,260),weightKg:num(1,300)},
  seed:int(0,4294967295),timezone:oneOf('Asia/Shanghai'),
  sampleMinutes:int(1,15),sensorNoiseMgdl:num(0,10),initialGlucoseMgdl:num(30,500),
  profile:{basalUph:num(0,10),isfMgdlPerU:num(5,300),carbRatioGPerU:num(1,100),diaHours:num(5,12),targetMgdl:num(80,180),maxBasalUph:num(0,10),maxIobU:num(0,20)},
  meals:{breakfast:MEAL,lunch:MEAL,dinner:MEAL},
  sleep:{bedtime:time,wakeTime:time,jitterMinutes:int(0,90)},
  activity:{enabled:bool,probability:num(0,1),durationMinutes:int(5,120),accelerometerCounts:num(0,6539)},
  stress:{enabled:bool,probability:num(0,1),durationMinutes:int(5,240),hepaticDeltaMgdlPerMin:num(0,.5)},
  loopMode:oneOf('open','closed','lgs'),paused:bool,speed:num(0,60),
  tempTargets:{meal:num(80,180),activity:num(80,200),hypo:num(80,200),durationMinutes:int(5,240)},
};

function collect(schema,value,path,issues) {
  if(!schema.kind) {
    if(!isObject(value)){issues.push({code:'invalid_type',path,message:'Invalid input: expected object'});return;}
    for(const k of Object.keys(value))if(!(k in schema))issues.push({code:'unrecognized_keys',keys:[k],path,message:`Unrecognized key: "${k}"`});
    for(const [k,s] of Object.entries(schema))collect(s,value[k],[...path,k],issues);
    return;
  }
  const bad=message=>issues.push({code:'invalid_value',path,message});
  if(schema.kind==='boolean'){if(typeof value!=='boolean')bad('Invalid input: expected boolean');return;}
  if(schema.kind==='enum'){if(!schema.values.includes(value))bad(`Invalid option: expected one of ${schema.values.map(v=>`"${v}"`).join('|')}`);return;}
  if(schema.kind==='time'){if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))bad('Invalid string: must match HH:MM');return;}
  if(typeof value!=='number'||!Number.isFinite(value))return bad('Invalid input: expected number');
  if(schema.kind==='int'&&!Number.isInteger(value))return bad('Invalid input: expected int');
  if(value<schema.min||value>schema.max)bad(`Number must be within ${schema.min}..${schema.max}`);
}

/** Validates an upstream live config; throws with a JSON list of issues like upstream (zod). */
export function parseLiveConfig(input) {
  const issues=[];collect(SCHEMA,input,[],issues);
  if(!issues.length) {
    if(input.profile.maxBasalUph<input.profile.basalUph)issues.push({code:'custom',path:['profile','maxBasalUph'],message:'maxBasalUph must be >= basalUph'});
    for(const [name,m] of Object.entries(input.meals))if(m.carbsJitterG>=m.carbsG)
      issues.push({code:'custom',path:['meals',name,'carbsJitterG'],message:'Meal jitter must be below nominal carbs'});
    // The unified CGM model samples on the 5-minute grid only.
    if(input.sampleMinutes!==5)issues.push({code:'custom',path:['sampleMinutes'],message:'Only 5-minute CGM sampling is supported by the unified sensor model'});
  }
  if(issues.length)throw new Error(JSON.stringify(issues,null,2));
  const out=clone(input);
  // The translated World config must validate too (World ranges are narrower for a few fields).
  normalizeConfig(toWorldConfig(out,Date.parse('2026-01-01T00:00:00Z')));
  return out;
}

export const DEFAULT_LIVE_CONFIG=Object.freeze(parseLiveConfig({
  subject:{sex:'male',ageYears:39,heightCm:170,weightKg:66},seed:20261013,timezone:'Asia/Shanghai',
  sampleMinutes:5,sensorNoiseMgdl:1.5,initialGlucoseMgdl:120,
  profile:{basalUph:equilibriumBasalUph(66),isfMgdlPerU:50,carbRatioGPerU:10,diaHours:5,targetMgdl:120,maxBasalUph:3,maxIobU:3},
  meals:{breakfast:{time:'08:00',carbsG:50,carbsJitterG:10,timeJitterMinutes:20,absorptionMinutes:40},
    lunch:{time:'12:30',carbsG:70,carbsJitterG:15,timeJitterMinutes:30,absorptionMinutes:55},
    dinner:{time:'19:00',carbsG:60,carbsJitterG:15,timeJitterMinutes:30,absorptionMinutes:65}},
  sleep:{bedtime:'23:00',wakeTime:'07:00',jitterMinutes:30},
  activity:{enabled:true,probability:.35,durationMinutes:30,accelerometerCounts:2095},
  stress:{enabled:false,probability:.15,durationMinutes:45,hepaticDeltaMgdlPerMin:.05},
  loopMode:'open',paused:false,speed:1,tempTargets:{meal:100,activity:150,hypo:140,durationMinutes:60},
}));

/** Deep-merges a patch like upstream mergeConfig and validates the result. */
export function mergeLiveConfig(current,patch) {
  if(!isObject(patch))throw new Error('Config patch must be an object');
  const merge=(a,b)=>Object.fromEntries([...new Set([...Object.keys(a),...Object.keys(b)])].map(k=>[k,
    b[k]===undefined?a[k]:isObject(b[k])&&isObject(a[k])?merge(a[k],b[k]):b[k]]));
  return parseLiveConfig(merge(current,patch));
}

/** Upstream live config -> World config (ideal pump, uniform-noise CGM, built-in oref0 loop). */
export function toWorldConfig(c,startMs) {
  const meal=m=>({time:m.time,carbs_g:m.carbsG,carbs_jitter_g:m.carbsJitterG,time_jitter_minutes:m.timeJitterMinutes,absorption_minutes:m.absorptionMinutes});
  return {
    seed:c.seed,start_time:new Date(startMs).toISOString(),utc_offset_minutes:UTC_OFFSET_MINUTES,horizon_minutes:10080,
    patient:{sex:c.subject.sex,age_years:c.subject.ageYears,height_cm:c.subject.heightCm,weight_kg:c.subject.weightKg,initial_glucose_mg_dl:c.initialGlucoseMgdl},
    profile:{basal_u_h:c.profile.basalUph,isf_mg_dl_per_u:c.profile.isfMgdlPerU,carb_ratio_g_per_u:c.profile.carbRatioGPerU,
      target_mg_dl:c.profile.targetMgdl,dia_hours:c.profile.diaHours,max_basal_u_h:c.profile.maxBasalUph},
    therapy:{mode:'pump',pump:{model:'ideal',insulin:'aspart',reservoir_u:150}},
    cgm:{model:'legacy_uniform',noise_mg_dl:c.sensorNoiseMgdl},
    meter:{model:null},
    scenario:{meals:Object.fromEntries(Object.entries(c.meals).map(([k,m])=>[k,meal(m)])),
      // Lifestyle meals are logged with their true carbs, as upstream did.
      announcement:{probability:1,carb_error_fraction:0},
      activity:{enabled:c.activity.enabled,probability:c.activity.probability,time:'16:00',time_jitter_minutes:60,
        duration_minutes:c.activity.durationMinutes,accelerometer_counts:c.activity.accelerometerCounts,announced:true},
      stress:{enabled:c.stress.enabled,probability:c.stress.probability,time:'10:00',time_jitter_minutes:90,
        duration_minutes:c.stress.durationMinutes,hepatic_delta_mg_dl_per_min:c.stress.hepaticDeltaMgdlPerMin}},
    // Upstream applied no simulator-side dosing guards; the relay enforces its own limits.
    safety:{max_bolus_u:25,bolus_min_interval_minutes:0,block_bolus_below_mg_dl:0,max_rescue_carbs_g:100,
      rescue_absorption_minutes:CARB_ABSORPTION_MINUTES,max_temp_minutes:1440},
    controller:{mode:c.loopMode,enabled:true,expose_actions:true,compute_suggestions:true,
      temp_targets:{meal:c.tempTargets.meal,activity:c.tempTargets.activity,hypo:c.tempTargets.hypo,duration_minutes:c.tempTargets.durationMinutes}},
  };
}

// --- sleep / wake context labels -----------------------------------------------------------

/** Deterministic bedtime and wake labels for one local day (no physiological effect). */
export function sleepEvents(day,c) {
  const rng=Rng.stream(c.seed,`live-sleep:${day}`),jitter=n=>Math.round(rng.symmetric(n));
  const bedtime=localAt(day,c.sleep.bedtime,UTC_OFFSET_MINUTES)+jitter(c.sleep.jitterMinutes)*60000;
  let wake=localAt(day,c.sleep.wakeTime,UTC_OFFSET_MINUTES)+jitter(c.sleep.jitterMinutes)*60000;
  if(wake<=bedtime)wake+=DAY_MS;
  return [{id:`sleep:${day}`,type:'sleep',at:bedtime,until:wake,source:'context_label_no_sleep_physiology_in_original_model'},
    {id:`wake:${day}`,type:'wake',at:wake,source:'synthetic_daily_lifestyle'}];
}
export const localDayOf=ms=>localDay(ms,UTC_OFFSET_MINUTES);

// --- record and view mapping ---------------------------------------------------------------

const SOURCES={meal:'synthetic_daily_lifestyle',exercise:'synthetic_aerobic_accelerometry',stress:'experimental_stress_input_not_clinically_validated'};
/** World scheduled event -> upstream daily-event shape. */
export function eventView(e) {
  if(e.type==='meal')return {id:e.id,type:'meal',name:e.name,at:e.at,carbsG:e.grams,tau:e.absorption_minutes,source:SOURCES.meal};
  const out=clone(e);
  if(e.until!==undefined&&e.at!==undefined)out.durationMinutes=(e.until-e.at)/60000;
  if(e.hepatic_delta!==undefined){out.hepaticDelta=e.hepatic_delta;delete out.hepatic_delta;}
  if(SOURCES[e.type]&&!e.kind)out.source=SOURCES[e.type];
  return out;
}

/** World outbox sample -> upstream sample payload. */
export function sampleRecord(s) {
  return {at:s.at,glucose:s.glucose,observed:s.observed,iob:s.iob,cob:s.cob,simulation:true};
}

/** World outbox treatment -> upstream treatment payload (lifestyle meals keep their true carbs). */
export function treatmentRecord(t,world) {
  if(t.source==='patient_report'&&t.eventType==='Meal Bolus') {
    const e=world.events.find(x=>x.id===t.id);
    return {id:t.id,at:t.at,eventType:'Carb Correction',carbs:e?.grams??t.carbs,source:SOURCES.meal,simulation:true,consumed:true};
  }
  return {...clone(t),simulation:true};
}

/** Extra upstream fields for the treatment created by a relay command. */
export function commandTreatment(t,c,text,tempTarget) {
  switch(c.type) {
    case 'bolus':return {...t,delivered:true};
    case 'carbs':return {...t,consumed:true};
    case 'temp_basal':return {...t,basis:c.basis,value:c.value};
    case 'extended':return {...t,delivery:'scheduled_not_fully_delivered'};
    case 'cancel_extended':return {...t,notes:'Extended cancelled; delivered insulin retained'};
    case 'loop':case 'temp_target':return {...t,command:text,target:tempTarget};
    default:return t;
  }
}

/** Upstream {preset,value,at,until} temp target, or null. */
export function tempTargetView(world,c) {
  const t=world.controller.tempTarget;
  return t&&t.until>world.now?{preset:t.preset,value:t.value,at:t.until-c.tempTargets.durationMinutes*60000,until:t.until}:null;
}

const trend=slope=>{const d=direction(slope);return d==='NONE'?'Flat':d;};

/** Upstream-shaped status() of the live patient. */
export function statusView(world,live,recommendation=null) {
  const now=world.now,c=live.config,d=world.device,k=world.controller,last=world.cgm.latest();
  const {iob,cob}=world.estimates(),rapid=INSULINS[world.rapidInsulin];
  const userTemp=d.temp&&d.temp.until>now&&d.temp.source!=='loop'&&live.manualTemp?.at===d.temp.startedAt?live.manualTemp:null;
  return {simulation:true,simulationError:live.simulationError??world.error??null,sessionId:live.sessionId,subject:c.subject,
    virtualTime:new Date(now).toISOString(),publicationOffsetMs:live.publicationOffset,
    bg:last?.value??world.physiology.glucose(),trueBg:world.physiology.glucose(),
    sampleTime:last?new Date(last.at+live.publicationOffset).toISOString():null,bg_trend:trend(world.cgm.trend()),
    iob:iob.iob,basalIob:iob.basal_iob,bolusIob:iob.bolus_iob,iobDefinition:iobDefinition(rapid.iob,world.config.profile.dia_hours),
    cob:cob.cob,cobDefinition:COB_DESCRIPTION,
    loop_mode:k.mode,loopEnabled:k.enabled,loopSuspendedUntil:k.suspendedUntil>now?new Date(k.suspendedUntil).toISOString():null,
    basalUph:d.basalAt(now),scheduledBasalUph:d.scheduledBasalUph,tempBasal:userTemp?clone(userTemp):null,
    extended:d.extended&&d.extended.until>now?{at:d.extended.startedAt,until:d.extended.until,rate:d.extended.rateUph,totalU:d.extended.units,deliveredU:d.extended.deliveredU}:null,
    tempTarget:tempTargetView(world,c),
    pump_connected:d.connected&&d.reservoirU>0&&d.battery>0,battery:d.battery,reservoirU:d.reservoirU,
    sleeping:live.sleep.sleeping,activeEvents:[...live.sleep.active.filter(e=>e.until>now),...world.active.map(eventView)],
    paused:c.paused,speed:c.speed,model:MODEL_DESCRIPTION,
    recommendation:recommendation?{...clone(recommendation),algorithm:'oref0-0.7.1',simulation:true}:null};
}

// --- upstream checkpoint migration ---------------------------------------------------------

/** True for a checkpoint written by upstream VirtualPatient.serialize(). */
export const isLegacyCheckpoint=s=>isObject(s)&&!s.format&&isObject(s.state)&&Array.isArray(s.doses);

/**
 * Converts an upstream VirtualPatient checkpoint into {world, live}. Physiology (kernel state and
 * meal pools), the insulin ledger, pump faults, loop/temp-target state, active temp basal and
 * extended bolus, recent CGM and sleep context carry over. The World starts on the next 5-minute
 * grid point (at most 5 virtual minutes are skipped with the state frozen); future lifestyle
 * events are re-drawn by the unified scenario generator.
 */
export function migrateLegacyCheckpoint(old) {
  const config=parseLiveConfig({...clone(DEFAULT_LIVE_CONFIG),...clone(old.config),sampleMinutes:5});
  const start=Math.ceil(old.now/SAMPLE_MS)*SAMPLE_MS;
  const world=new World(toWorldConfig(config,start));
  const ph=world.physiology;
  for(const key of Object.keys(ph.state))if(Number.isFinite(old.state[key]))ph.state[key]=old.state[key];
  ph.meals=(old.meals??[]).map(m=>({id:m.id,grams:m.grams,tau:m.tau,a:old.state[`meal${m.index}a`]??0,b:old.state[`meal${m.index}b`]??0}))
    .filter(m=>m.a+m.b>=1);
  world.physiology=Physiology.restore(ph.snapshot());
  const d=world.device,f=old.faults??{};
  d.connected=f.pumpConnected??true;d.battery=f.battery??100;d.reservoirU=Math.min(f.reservoirU??d.reservoirU,d.spec.reservoir_u);
  const dia=world.config.profile.dia_hours*3600000;
  d.ledger=(old.doses??[]).filter(x=>x.at>start-dia).map(({at,units,kind})=>({at,units,kind}));
  const lastBolus=(old.doses??[]).filter(x=>x.kind==='bolus').at(-1);
  if(lastBolus)d.lastBolus={at:lastBolus.at,units:lastBolus.units};
  let manualTemp=null;
  const mb=old.manualBasal;
  if(mb&&mb.until>start) {
    const rate=mb.basis==='percent'?config.profile.basalUph*mb.value/100:mb.value;
    d.temp={rateUph:rate,percent:null,startedAt:mb.at,until:mb.until,source:'aaps_relay'};manualTemp=clone(mb);
  }
  const ex=old.extended;
  if(ex&&ex.until>start)d.extended={units:ex.totalU,rateUph:ex.rate,startedAt:ex.at,until:ex.until,deliveredU:ex.deliveredU};
  const k=world.controller;
  k.mode=old.loopMode??config.loopMode;k.enabled=old.loopEnabled??true;k.suspendedUntil=old.loopSuspendedUntil>start?old.loopSuspendedUntil:0;
  k.tempTarget=old.tempTarget&&old.tempTarget.until>start?{preset:old.tempTarget.preset,value:old.tempTarget.value,until:old.tempTarget.until}:null;
  // Replace the constructor's start sample (taken from the default state) with the migrated history.
  world.cgm.history=(old.recentSamples??[]).filter(s=>s.at>start-DAY_MS).map(s=>({at:s.at,value:s.observed,display:null}));
  world.cgm.ig=world.physiology.glucose();
  world.outbox={samples:[],treatments:[],notices:[]};world.notices=[];world.alarm=null;
  // Upstream already stored a reading at this instant when old.now was on the sample grid.
  // Its recommendation for that reading carries over as the loop's last one.
  if(world.cgm.history.at(-1)?.at===start) {
    world.lastSampleAt=start;
    if(old.lastRecommendation)k.lastRecommendation={at:start,action:null,reason:old.lastRecommendation.reason??null,nonfinite:false,raw:clone(old.lastRecommendation)};
  }
  else {delete world.lastSampleAt;world.sampleIfDue();}
  const sleepActive=(old.activeEvents??[]).filter(e=>e.type==='sleep'&&e.until>start);
  const sleepPending=(old.dailyEvents??[]).filter(e=>!e.done&&['sleep','wake'].includes(e.type)&&e.at>start);
  const live={sessionId:old.sessionId,start:old.start,config,publicationOffset:old.publicationOffset??0,
    wallAnchor:old.wallAnchor,wallVirtualAnchor:old.wallVirtualAnchor,
    fastForward:old.fastForward&&old.fastForward.target>start?{start:old.fastForward.start,target:old.fastForward.target}:null,
    simulationError:old.simulationError??null,manualTemp,
    sleep:{sleeping:!!old.sleeping,active:clone(sleepActive),pending:clone(sleepPending),
      days:[...new Set((old.generatedDays??[]))],
      doneIds:(old.processedEventIds??[]).filter(id=>/^(sleep|wake):/.test(id)).slice(-20)},
    migratedFrom:{format:'upstream-virtual-patient',virtualTime:new Date(old.now).toISOString(),skippedMs:start-old.now}};
  return {world,live};
}
