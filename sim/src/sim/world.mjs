// One simulated instance (person + delivery device + insulin + sensors) evolving in virtual time.
// Shared by the POMDP evaluation environment (src/env) and the live service (src/live).
// Pure and deterministic: no wall clock, no random IDs; all randomness comes from named
// seed streams. Hidden state never enters observe().
import {normalizeConfig,DEFAULT_CONFIG} from '../core/config.mjs';
import {Physiology,MAX_STEP_MINUTES} from '../core/physiology.mjs';
import {Pump,Pens} from '../core/delivery.mjs';
import {INSULINS} from '../core/insulins.mjs';
import {Cgm,CGMS,direction} from '../core/cgm.mjs';
import {Meter,METERS} from '../core/meter.mjs';
import {Rng} from '../core/rng.mjs';
import {generateEvents,visibleNotice,localDay,localAt,applyMasking,lateReports,completeReports} from '../core/scenario.mjs';
import {iobAt,cobAt,iobDefinition,COB_DEFINITION} from '../core/estimators.mjs';
import {oref0Policy} from '../policies/oref0.mjs';
import {runOref1Controller} from './oref1-controller.mjs';
import {runHclController} from './hcl-controller.mjs';
import {actionSpecs,availableActions,validateAction} from './actions.mjs';

const MAX_STEP_MS=MAX_STEP_MINUTES*60000;
const DAY_MS=86400000;
const SAMPLE_MS=5*60000;
const HISTORY_SAMPLES=36;      // 3 h of CGM in each observation
const PROFILE_HISTORY=20;      // latest SET_PROFILE changes shown in observations
const MDI_PRELOAD_DAYS=10;     // long-acting history simulated before start (>3 half-lives of degludec)
const FRESH_MS=30*60000;       // a glucose reading older than this does not gate dosing
const ROUTINE=new Set(['smbg_routine','scan_routine']);
const clone=x=>structuredClone(x);
const minutesOf=hhmm=>Number(hhmm.slice(0,2))*60+Number(hhmm.slice(3));
const hhmmOf=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
// Reported carbs older than this never matter: the longest allowed COB window (estimates.
// cob_absorption_minutes <= 480) and the 6 h reported_carbs list in observations.
const MAX_CARB_MEMORY_MS=8*3600000;
// Config paths a running World can change (see reconfigure), and those that redraw future events.
const RECONFIGURABLE=['profile','patient.sex','patient.age_years','patient.height_cm','patient.weight_kg',
  'cgm.noise_mg_dl','cgm.scan_window','cgm.scan_interval_minutes','meter.routine_times',
  'controller','seed','scenario','faults','safety','alarms','estimates','profile_switch'];
const REGENERATE=['seed','scenario','faults','meter.routine_times','cgm.scan_window','cgm.scan_interval_minutes'];

/** Deep-merges a config patch (objects merge, everything else replaces; null removes a meal). */
function deepMerge(base,patch,path) {
  const out={...base};
  for(const [k,v] of Object.entries(patch)) {
    if(v===undefined)continue;
    if(v===null&&path==='scenario.meals.'){delete out[k];continue;}
    out[k]=isObject(v)&&isObject(base[k])?deepMerge(base[k],v,`${path}${k}.`):clone(v);
  }
  return out;
}
/** Adds defaults for config keys missing in an older saved config (objects recursively, never meals). */
function fillMissing(cfg,def) {
  for(const [k,v] of Object.entries(def)) {
    if(!(k in cfg))cfg[k]=clone(v);
    else if(isObject(v)&&isObject(cfg[k])&&k!=='meals'&&k!=='resolved')fillMissing(cfg[k],v);
  }
}
/** Dotted paths of leaves (arrays as a whole) that differ between two configs. */
function diffPaths(a,b,path) {
  const out=[];
  for(const k of new Set([...Object.keys(a),...Object.keys(b)])) {
    if(isObject(a[k])&&isObject(b[k]))out.push(...diffPaths(a[k],b[k],`${path}${k}.`));
    else if(JSON.stringify(a[k])!==JSON.stringify(b[k]))out.push(`${path}${k}`);
  }
  return out;
}

function emptyMetrics() {
  // Durations are integer milliseconds so 24 h sums exactly; integrals are in minutes.
  return {elapsed_ms:0,tir_ms:0,below70_ms:0,below54_ms:0,above180_ms:0,above250_ms:0,
    glucose_integral:0,glucose_sq_integral:0,min_glucose:Infinity,max_glucose:-Infinity,
    rapid_delivered_u:0,long_acting_u:0,bolus_u:0,rescue_carbs_g:0,rejected_actions:0,reward:0,
    fingersticks:0,scans:0};
}

export class World {
  constructor(input={},{episodeOrigin=null}={}) {
    const c=this.config=normalizeConfig(input),t=c.therapy,mdi=t.mode==='mdi';
    if(episodeOrigin!==null)this.episodeOrigin=episodeOrigin;   // pre-episode history World: sensor controls refer to the episode start
    this.start=Date.parse(c.start_time);this.now=this.start;
    this.rapidInsulin=mdi?t.mdi.bolus_insulin:t.pump.insulin;
    this.device=mdi?new Pens({bolusPen:t.mdi.bolus_pen,basalPen:t.mdi.basal_pen,basalInsulin:t.mdi.basal_insulin,recordSources:c.information.own_records,
      maxDailyInjections:t.mdi.max_daily_injections,utcOffsetMinutes:c.utc_offset_minutes})
      :new Pump({model:t.pump.model,scheduledBasalUph:c.profile.basal_u_h,reservoirU:t.pump.reservoir_u,recordSources:c.information.own_records});
    this.physiology=new Physiology({weightKg:c.patient.weight_kg,initialGlucose:c.patient.initial_glucose_mg_dl,
      basalUph:mdi?0:this.device.scheduledBasalUph,pk:INSULINS[this.rapidInsulin].pk,person:c.physiology});
    this.cgm=c.cgm.model?new Cgm({model:c.cgm.model,seed:c.seed,start:this.start,noiseMgdl:c.cgm.noise_mg_dl,gaps:c.cgm.gaps,
      errorDraw:c.cgm.error_draw,sensorAgeDays:c.cgm.sensor_age_days_at_start,forcedGaps:c.cgm.forced_gaps,
      calibrationOverdue:c.cgm.calibration_overdue_at_start,compressionLows:c.cgm.compression_lows,errorScale:c.cgm.error_scale,origin:this.episodeOrigin??this.start}):null;
    this.meter=c.meter.model?new Meter({model:c.meter.model,seed:c.seed}):null;
    this.lastScan=null;
    this.events=[];this.nextEvent=0;this.generatedUntil=this.start;
    if(mdi)this.preloadMdi();
    this.ensureEvents(this.start);
    this.active=[];this.reportedCarbs=[];this.notices=[];this.alarm=null;this.flashAlarm=null;
    this.controller={mode:c.controller.mode,enabled:c.controller.enabled,suspendedUntil:0,tempTarget:null,lastRecommendation:null};
    this.selfCare={queue:[],lastLowTreatment:-Infinity};   // assisted mode: the person's own pending boluses
    this.profileHistory=[];                                  // SET_PROFILE changes (profile_switch)
    this.metrics=emptyMetrics();this.outbox={samples:[],treatments:[],notices:[]};
    this.terminated=false;this.error=null;
    if(c.initial_state?.history_minutes>0)this.runInitialHistory();
    this.processDue();this.sampleIfDue();
    if(c.scenario.announcement.information_mode==='complete') {
      const mc=c.scenario.menstrual;
      if(mc.enabled&&c.patient.sex==='female'&&mc.cycle_day_at_start!=null)
        this.notify({type:'cycle_history_reported',cycle_day:mc.cycle_day_at_start,time:this.iso(),note:'person reports their current menstrual cycle day; physiological effect is unknown'});
      if(c.physiology.dawn_fraction>0)
        this.notify({type:'daily_pattern_reported',time:this.iso(),note:'person reports recurrent early-morning glucose rises in prior days; no future readings are supplied'});
    }
  }

  /**
   * Pre-episode history (config.initial_state, default off): simulates history_minutes before the
   * start in a separate World (same person, devices and sensors; no lifestyle events, no routines,
   * no self-care), applies the scripted entries, then continues this World from that state:
   * physiology, the delivery device (ledger -> IOB, last bolus, suspension, pen log), the sensor
   * (recent readings) and reported carbs. Metrics and notices of the history are discarded.
   */
  runInitialHistory() {
    const c=this.config,H=c.initial_state.history_minutes*60000,from=this.start-H,s=c.scenario;
    const off={enabled:false};
    const pre=new World({...clone(c),start_time:this.iso(from),horizon_minutes:c.initial_state.history_minutes,
      initial_state:{history_minutes:0,history:[]},self_care:{...clone(c.self_care),mode:'none'},controller:{...clone(c.controller),enabled:false},
      meter:{...clone(c.meter),routine_times:[]},faults:{occlusion_rate_per_day:0,occlusions:[]},
      cgm:{...clone(c.cgm),forced_gaps:[],compression_lows:[]},   // episode-time sensor controls are re-attached below
      scenario:{...clone(s),meals:{},extra_events:[],activity:{...s.activity,enabled:false},stress:{...s.stress,enabled:false},
        anaerobic:{...s.anaerobic,...off},alcohol:{...s.alcohol,...off},illness:{...s.illness,...off},sleep_loss:{...s.sleep_loss,...off}}},
      {episodeOrigin:this.start});
    const script=c.initial_state.history.map((e,i)=>({...e,i,at:this.start-e.minutes_before*60000})).sort((a,b)=>a.at-b.at||a.i-b.i);
    let k=0;
    const due=t=>{while(k<script.length&&script[k].at<=t)pre.historyEntry(script[k++]);};
    for(let t=from;t<this.start&&!pre.terminated;t+=SAMPLE_MS) {
      while(pre.now<t&&!pre.terminated)pre.advanceTo(t);
      pre.sampleIfDue();due(t);
    }
    while(pre.now<this.start&&!pre.terminated)pre.advanceTo(this.start);
    if(pre.terminated)throw new Error(`initial_state history failed: ${pre.error}`);
    this.physiology=pre.physiology;this.device=pre.device;this.reportedCarbs=pre.reportedCarbs;
    this.meter=pre.meter;
    if(pre.cgm) {
      // Forced gaps / compression lows are timed from the episode start (same origin in both Worlds).
      if(this.cgm?.forcedGaps)pre.cgm.forcedGaps=this.cgm.forcedGaps;
      if(this.cgm?.compressionLows)pre.cgm.compressionLows=this.cgm.compressionLows;
      this.cgm=pre.cgm;
    }
    this.initialHistory={from:this.iso(from),entries:script.length};
  }
  /** One scripted pre-episode entry (runInitialHistory). Device actions go through the normal checks. */
  historyEntry(e) {
    const id=`history:${e.i}`;let r=null;
    if(e.type==='bolus')r=this.apply({type:'BOLUS',units:e.units},id,'before_episode');
    else if(e.type==='long_acting')r=this.apply({type:'BASAL_INJECTION',units:e.units},id,'before_episode');
    else if(e.type==='carbs')r=this.apply({type:'INGEST_CARBS',grams:e.grams},id,'before_episode');
    else if(e.type==='suspend_pump')this.device.suspend(e.minutes,this.now);
    else if(e.type==='meal') {
      this.physiology.ingest(id,e.grams,e.absorption_minutes);
      const reported=this.config.scenario.announcement.information_mode==='complete'?e.grams:e.announced_grams;
      if(reported!=null)this.reportedCarbs.push({at:this.now,grams:reported,source:'announced_meal',id});
    }
    else if(e.type==='extended_bolus')r=this.apply({type:'EXTENDED_BOLUS',units:e.units,duration_minutes:e.duration_minutes},id,'before_episode');
    else if(e.type==='occlusion')this.device.startOcclusion(this.now);
    else if(e.type==='calibrate_cgm')r=this.apply({type:'CALIBRATE_CGM'},id,'before_episode');
    if(r&&r.status!=='applied')throw new Error(`initial_state history entry ${e.i} (${e.type}) rejected: ${r.reason}`);
  }

  snapshot() {
    const {physiology,device,cgm,meter,...rest}=this;
    return clone({...rest,physiology:physiology.snapshot(),device:device.snapshot(),cgm:cgm?.snapshot()??null,meter:meter?.snapshot()??null});
  }
  static restore(s) {
    const w=Object.assign(Object.create(World.prototype),clone(s));
    w.physiology=Physiology.restore(s.physiology);
    w.cgm=s.cgm?Cgm.restore(s.cgm):null;w.meter=s.meter?Meter.restore(s.meter):null;
    w.device=s.device.kind==='mdi'?Pens.restore(s.device):Pump.restore(s.device);
    w.selfCare??={queue:[],lastLowTreatment:-Infinity};   // snapshots from before self-care existed
    w.profileHistory??=[];
    // Configs saved before profile_switch / pump refills existed get those defaults (both off).
    w.config.profile_switch??=clone(DEFAULT_CONFIG.profile_switch);
    w.config.therapy.pump.refill_every_days??=null;w.config.therapy.pump.refill_time??=DEFAULT_CONFIG.therapy.pump.refill_time;
    fillMissing(w.config,DEFAULT_CONFIG);   // configs saved before the default-off scenario controls existed
    return w;
  }
  /** Returns and clears records produced since the last drain (live service persistence). */
  drain() {const o=this.outbox;this.outbox={samples:[],treatments:[],notices:[]};return o;}

  // --- runtime reconfiguration and long-run memory bounds ----------------------------------

  /**
   * Changes settings of a running World at the current virtual time. patch is a partial config
   * (same shape as the constructor input) deep-merged over the current config; a null entry in
   * scenario.meals removes that meal. The merged config is validated with normalizeConfig and
   * applied atomically: nothing changes when it throws. Supported:
   *   profile.*                        pump scheduled basal is reprogrammed; targets, ISF, CR, DIA, max basal
   *   patient.weight_kg                kernel body weight (compartment state kept); sex/age/height
   *   cgm.noise_mg_dl                  sensor noise from the next sample
   *   controller.*                     mode/enabled present in the patch are applied to the running loop
   *                                    (as SET_LOOP_MODE, even when equal to the configured value)
   *   seed, scenario.*, faults.*, meter.routine_times, cgm.scan_window, cgm.scan_interval_minutes
   *                                    future, not-yet-started scheduled events are redrawn from now;
   *                                    the new seed also drives later time-varying sensitivity draws
   *   safety.*, alarms.*, estimates.*  read at use
   * Anything else (therapy, sensor/meter models, physiology, person, start/horizon, initial glucose)
   * needs a new World and is rejected. Returns {changed: [paths], regenerated: boolean}.
   */
  reconfigure(patch) {
    if(!isObject(patch))throw new Error('reconfigure patch must be an object');
    const before=this.config,next=normalizeConfig(deepMerge(before,patch,''));
    next.person.resolved=clone(before.person.resolved);   // keep the drawn person record; its values are in the config
    const changed=diffPaths(before,next,'');
    const unsupported=changed.filter(p=>!RECONFIGURABLE.some(r=>p===r||p.startsWith(r+'.')));
    if(unsupported.length)throw new Error(`Cannot change ${unsupported.join(', ')} on a running World (start a new one)`);
    const touched=p=>changed.some(c=>c===p||c.startsWith(p+'.'));
    const regenerate=REGENERATE.some(touched);
    this.config=next;
    if(!this.mdi&&touched('profile.basal_u_h'))this.device.setScheduledBasal(next.profile.basal_u_h);
    if(touched('patient.weight_kg'))this.physiology.setWeight(next.patient.weight_kg);
    if(this.cgm&&touched('cgm.noise_mg_dl'))this.cgm.noiseMgdl=next.cgm.noise_mg_dl;
    const k=patch.controller??{};
    if(k.mode!==undefined)this.applyControllerAction({type:'SET_LOOP_MODE',mode:next.controller.mode});
    if(k.enabled!==undefined)this.applyControllerAction({type:'SET_LOOP_MODE',mode:next.controller.enabled?'enable':'disable'});
    if(regenerate)this.regenerateFutureEvents();
    return {changed,regenerated:regenerate};
  }

  /**
   * Replaces scheduled events after now with ones drawn from the current config. Processed
   * events and events already due stay; a redrawn event whose id already happened is dropped,
   * so a meal moved across now is not eaten twice. Windows are the same day windows a fresh
   * World uses, so the future equals that of a World started with the new config.
   */
  regenerateFutureEvents() {
    const now=this.now,kept=this.events.filter((e,i)=>i<this.nextEvent||e.at<=now),ids=new Set(kept.map(e=>e.id));
    const until=this.generatedUntil;
    this.events=kept;this.generatedUntil=this.windowStart(now);
    while(this.generatedUntil<until||this.generatedUntil<=now+DAY_MS) {
      const from=this.generatedUntil,to=from+DAY_MS;
      this.events.push(...this.windowEvents(from,to).filter(e=>e.at>now&&!ids.has(e.id)));this.generatedUntil=to;
    }
  }
  /** Start of the daily event-generation window containing t. */
  windowStart(t) {return this.start+Math.floor((t-this.start)/DAY_MS)*DAY_MS;}

  /**
   * Bounds memory of a long-running World: drops processed scheduled events, notices, reported
   * carbs and the MDI basal log older than `before`. Whatever later dynamics, observations or a
   * redraw still read is kept regardless of `before`: processed events from the two generation
   * windows before the current one (redraw de-duplication), reported carbs within
   * MAX_CARB_MEMORY_MS (COB at the longest allowed absorption window and the 6 h observation
   * list), unprocessed events and the latest basal injection. Dropped notices no longer appear
   * in observe().events. Device ledger, CGM and meter histories bound themselves. Returns the
   * number of items dropped per kind; events are removed from the front of the list, so an
   * external index into it must move back by `events`.
   */
  prune(before) {
    if(!Number.isFinite(before))throw new Error('prune(before) needs a finite virtual time');
    const now=this.now,eventCutoff=Math.min(before,this.windowStart(now)-2*DAY_MS);
    let events=0;
    while(events<this.nextEvent&&this.events[events].at<eventCutoff)events++;
    if(events){this.events=this.events.slice(events);this.nextEvent-=events;}
    const count=(list,keep)=>{const out=list.filter(keep);return [out,list.length-out.length];};
    const [notices,droppedNotices]=count(this.notices,n=>!(Date.parse(n.time)<before));
    const carbCutoff=Math.min(before,now-MAX_CARB_MEMORY_MS);
    const [carbs,droppedCarbs]=count(this.reportedCarbs,r=>r.at>=carbCutoff);
    this.notices=notices;this.reportedCarbs=carbs;
    let droppedBasal=0;
    if(this.mdi&&this.device.basalLog.length>1) {
      const last=this.device.basalLog.at(-1),[log,n]=count(this.device.basalLog,r=>r===last||r.at>=before);
      this.device.basalLog=log;droppedBasal=n;
    }
    return {events,notices:droppedNotices,reported_carbs:droppedCarbs,basal_log:droppedBasal};
  }

  iso(ms=this.now) {return new Date(ms).toISOString();}
  localTime(ms=this.now) {return new Date(ms+this.config.utc_offset_minutes*60000).toISOString().slice(0,16).replace('T',' ');}
  get mdi() {return this.device.kind==='mdi';}
  penInjectionBudget(at=this.now,{basalDose=this.config.therapy.mdi.basal_dose_u}={}) {
    if(!this.mdi||this.device.maxDailyInjections==null)return null;
    const m=this.config.therapy.mdi,budget=this.device.injectionBudget(at);
    const parts=Math.ceil(basalDose/this.device.basalPenSpec.max_u-1e-9);
    const reserved=m.auto_basal_injection?m.basal_times.filter(time=>{
      const when=localAt(budget.local_date,time,this.config.utc_offset_minutes);
      return when>at||(when===at&&!this.device.basalLog.some(d=>d.at===at&&d.source==='patient_routine'));
    }).length*parts:0;
    return {...budget,reserved_routine:reserved,available_for_agent:budget.remaining==null?null:Math.max(0,budget.remaining-reserved)};
  }
  /** True when the instance has a real-time CGM whose readings the agent sees as they arrive. */
  get continuousCgm() {return this.cgm?.modality==='cgm';}

  // --- scheduled events, generated one virtual day at a time --------------------------

  /** Long-acting steady state from the patient's injections over the preceding days. */
  preloadMdi() {
    const m=this.config.therapy.mdi,ins=INSULINS[m.basal_insulin],off=this.config.utc_offset_minutes,doses=[];
    for(let t=this.start-MDI_PRELOAD_DAYS*DAY_MS;t<this.start+DAY_MS;t+=DAY_MS)for(const hhmm of m.basal_times) {
      const day=localDay(t,off),at=localAt(day,hhmm,off);
      if(at<this.start&&at>=this.start-MDI_PRELOAD_DAYS*DAY_MS)
        doses.push({id:`basal:${day}:${hhmm}`,at_minute:(at-this.start)/60000,units:m.basal_dose_u,depot:ins.depot,at});
    }
    let unique=[...new Map(doses.map(d=>[d.id,d])).values()];
    // Scenario controls (default off): forgotten routine doses before the start, extra (double or mistimed) doses.
    const missed=m.missed_doses_before_start??0;
    if(missed>0)unique=unique.sort((a,b)=>a.at-b.at).slice(0,-missed);
    for(const [i,x] of (m.extra_doses_before_start??[]).entries()) {
      const at=this.start-x.minutes_before*60000;
      unique.push({id:`basal:extra:${i}`,at_minute:-x.minutes_before,units:x.units,depot:ins.depot,at});
    }
    this.physiology.preloadLongActing(unique,this.config.patient.initial_glucose_mg_dl);
    for(const dose of unique)for(let k=0;k<Math.ceil(dose.units/this.device.basalPenSpec.max_u-1e-9);k++)
      this.device.recordInjection(dose.at,{historical:true});
    const last=unique.sort((a,b)=>a.at-b.at).at(-1);
    if(last)this.device.basalLog.push({at:last.at,units:last.units,source:'before_episode'});
  }

  /** Daily routines at local clock times within [from, to). */
  routineEvents(from,to,times,type,extra={}) {
    const off=this.config.utc_offset_minutes,out=[];
    for(let t=from-DAY_MS;t<to+DAY_MS;t+=DAY_MS)for(const hhmm of times) {
      const day=localDay(t,off),at=localAt(day,hhmm,off);
      if(at>=from&&at<to)out.push({id:`${type}:${day}:${hhmm}`,type,at,...extra});
    }
    return out;
  }
  scanTimes() {
    const c=this.config.cgm,[a,b]=c.scan_window.map(minutesOf),out=[];
    for(let m=a;m<=b;m+=c.scan_interval_minutes)out.push(hhmmOf(m));
    return out;
  }

  /** Events for [from, to): lifestyle, MDI and measurement routines, infusion-set faults. */
  windowEvents(from,to) {
    const c=this.config,out=generateEvents(c.scenario,{seed:c.seed,start:from,end:to,utcOffsetMinutes:c.utc_offset_minutes,origin:this.start});
    if(this.mdi&&c.therapy.mdi.auto_basal_injection)
      out.push(...this.routineEvents(from,to,c.therapy.mdi.basal_times,'basal_injection',{units:c.therapy.mdi.basal_dose_u,insulin:c.therapy.mdi.basal_insulin})
        .map(e=>({...e,id:e.id.replace('basal_injection:','basal:')})));
    if(!this.mdi&&c.therapy.pump.refill_every_days) {
      // Routine reservoir refill + set change on every Nth local day after the start day.
      const k=c.therapy.pump.refill_every_days,off=c.utc_offset_minutes,day0=Date.parse(localDay(this.start,off));
      out.push(...this.routineEvents(from,to,[c.therapy.pump.refill_time],'pump_refill').filter(e=>{
        const n=Math.round((Date.parse(e.id.slice(12,22))-day0)/DAY_MS);return n>0&&n%k===0;}));
    }
    if(this.meter)out.push(...this.routineEvents(from,to,c.meter.routine_times,'smbg_routine'));
    if(this.cgm?.modality==='flash')out.push(...this.routineEvents(from,to,this.scanTimes(),'scan_routine'));
    const f=c.faults;
    f.occlusions.forEach((o,i)=>{const at=this.start+o.at_minute*60000;if(at>=from&&at<to)out.push({id:`occlusion:explicit:${i}`,type:'occlusion',at});});
    if(f.occlusion_rate_per_day>0) {
      // One stream per window keeps onsets independent of how far the world is run.
      const rng=Rng.stream(c.seed,`faults:${from}`);let t=from;
      for(let i=0;;i++){t+=-Math.log(1-rng.next())/f.occlusion_rate_per_day*DAY_MS;if(t>=to)break;
        out.push({id:`occlusion:${from}:${i}`,type:'occlusion',at:Math.round(t/60000)*60000});}
    }
    // v1.1-hard observation knobs (default off): withheld notices, late meal reports. Reports of
    // meals eaten in the previous window (up to max_minutes before `from`) belong to this window.
    applyMasking(out,c.scenario,c.seed);
    const rd=c.scenario.announcement.report_delay;
    if(rd?.probability>0) {
      const lead=Math.max(from-(rd.max_minutes+5)*60000,this.start);
      const prev=lead<from?applyMasking(generateEvents(c.scenario,{seed:c.seed,start:lead,end:from,utcOffsetMinutes:c.utc_offset_minutes,origin:this.start}),c.scenario,c.seed):[];
      out.push(...lateReports(prev,c.scenario,c.seed).filter(r=>r.at>=from),...lateReports(out,c.scenario,c.seed).filter(r=>r.at<to));
    }
    return completeReports(out,c.scenario).sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
  }
  ensureEvents(until) {
    while(this.generatedUntil<=until+DAY_MS) {
      const from=this.generatedUntil,to=from+DAY_MS;
      this.events.push(...this.windowEvents(from,to));this.generatedUntil=to;
    }
  }
  isVisibleEvent(e) {const n=visibleNotice(e,String);return ROUTINE.has(e.type)||(!!n&&!this.noticeHidden(n));}
  /** Earliest scheduled event strictly after now that the agent would be notified of. */
  nextVisibleEventAt() {
    this.ensureEvents(this.now);
    return this.events.slice(this.nextEvent).find(e=>e.at>this.now&&this.isVisibleEvent(e))?.at??Infinity;
  }
  nextSensorChangeAt() {const t=this.cgm?.nextExpiry()??Infinity;return t>this.now?t:Infinity;}

  // --- dynamics -----------------------------------------------------------------------

  recordHidden(category,id,source=null,at=this.now) {
    const i=this.config.information;
    if(i.mode==='native'||i.mode==='I0')return false;
    if(i.own_records&&['agent','agent_rescue_carbs'].includes(source))return false;
    if(i.own_records&&source==='loop'&&['oref1','hcl'].includes(this.config.controller.algorithm))return false;
    if(['minimal-v2','record-derived-v3'].includes(i.policy)&&i.mode==='I2')return ['meal','exercise','life','fault','treatment'].includes(category);
    if(source==='agent_rescue_carbs'||source==='agent')return false;
    if(category==='treatment'&&at>=this.start)return false;
    if(i.mode==='I2')return ['meal','exercise','life','fault'].includes(category);
    return i.rules.some(r=>r.category===category&&(!r.ids||r.ids.includes(id)));
  }
  noticeHidden(n) {
    if(this.config.information.own_records&&['agent','agent_rescue_carbs'].includes(n.source))return false;
    if(['minimal-v2','record-derived-v3'].includes(this.config.information.policy)&&this.config.information.mode==='I2'
      &&['patient_bolus','patient_treated_low','pump_refilled','profile_changed'].includes(n.type))return true;
    const t=n.type,category=n.category??(t.startsWith('meal_')?'meal':t.startsWith('exercise_')?'exercise'
      :['illness_reported','poor_sleep_reported','stress_reported','alcohol_reported','daily_pattern_reported','cycle_history_reported'].includes(t)?'life'
      :t==='pump_occlusion_alarm'||t==='fault_record'?'fault':null);
    return category&&this.recordHidden(category,n.id,n.source);
  }
  visibleCarbs() {return this.reportedCarbs.filter(r=>!this.recordHidden('meal',r.id,r.source,r.at));}
  visibleLedger() {return this.device.ledger.filter(r=>!this.recordHidden('treatment',null,r.source,r.at));}
  notify(n) {if(!this.noticeHidden(n)){this.notices.push(n);this.outbox.notices.push(n);}}

  processDue() {
    this.ensureEvents(this.now);
    while(this.nextEvent<this.events.length&&this.events[this.nextEvent].at<=this.now) {
      const e=this.events[this.nextEvent++];
      if(e.type==='meal') {
        this.physiology.ingest(e.id,e.grams,e.absorption_minutes);
        if(e.announced_grams!=null) {
          this.reportedCarbs.push({at:e.at,grams:e.announced_grams,source:'announced_meal',id:e.id});
          this.outbox.treatments.push({id:e.id,at:e.at,eventType:'Meal Bolus',carbs:e.announced_grams,source:'patient_report'});
          this.scheduleSelfBolus(e);
          if(e.reported_composition)this.notify({type:'meal_composition_reported',id:e.id,composition:e.reported_composition,
            note:'person says this meal is high in fat/protein (slower, longer absorption)',time:this.iso(e.at)});
        }
      } else if(e.type==='meal_report') {
        // Late report (v1.1-hard): the carbs count from when eating started.
        this.reportedCarbs.push({at:e.eaten_at,grams:e.grams,source:'announced_meal'});
        this.outbox.treatments.push({id:e.meal_id,at:e.eaten_at,eventType:'Meal Bolus',carbs:e.grams,source:'patient_report'});
        this.scheduleSelfBolus({id:e.meal_id,name:e.name,at:e.at,announced_grams:e.grams});
        if(e.reported_composition)this.notify({type:'meal_composition_reported',id:e.meal_id,composition:e.reported_composition,
          note:'person says this meal is high in fat/protein (slower, longer absorption)',time:this.iso(e.at)});
      } else if(e.type==='basal_injection') {
        // Doses above the pen maximum are split into equal back-to-back injections, as patients do.
        const parts=Math.ceil(e.units/this.device.basalPenSpec.max_u-1e-9);
        for(let k=0;k<parts;k++) {
          const id=parts>1?`${e.id}#${k+1}`:e.id,r=this.device.basalInjection(e.units/parts,e.at,'patient_routine');
          this.physiology.injectLongActing(id,r.delivered_u,INSULINS[e.insulin].depot);this.metrics.long_acting_u+=r.delivered_u;
          this.outbox.treatments.push({id,at:e.at,eventType:'Basal Injection',insulin:r.delivered_u,insulinType:e.insulin,source:'patient_routine'});
        }
      } else if(e.type==='smbg_routine') {
        const r=this.fingerstick('patient_routine');
        // Patients calibrate at a routine check when the sensor asks for it (overdue or due within 2 h).
        let calibrated=false;
        if(this.cgm?.calibration&&this.now>=this.cgm.sensor.readyAt&&this.cgm.calibrationDue()-this.now<2*3600000){this.cgm.calibrate(this.now,r.value);calibrated=true;}
        this.notify({type:'fingerstick',value_mg_dl:r.value,display:r.display,source:'patient_routine',...(calibrated?{cgm_calibrated:true}:{}),time:this.iso()});
        this.selfTreatLow(r.value);
      } else if(e.type==='scan_routine') {
        const s=this.scan('patient_routine');
        this.notify({type:'flash_scan',value_mg_dl:s.value_mg_dl,direction:s.direction,source:'patient_routine',time:this.iso()});
        if(s.value_mg_dl!=null)this.selfTreatLow(s.value_mg_dl);
      } else if(e.type==='pump_refill') {
        const r=this.device.maintenance({reservoirU:this.device.spec.reservoir_u}),site=this.device.changeInfusionSet();
        this.outbox.treatments.push({id:e.id,at:e.at,eventType:'Site Change',source:'patient_routine'});
        this.notify({type:'pump_refilled',reservoir_u:r.reservoir_u,...(site.cleared_occlusion?{cleared_occlusion:true}:{}),source:'patient_routine',time:this.iso()});
      } else if(e.type==='patient_treatment') {
        const r=this.apply(e.action,e.id,'patient_routine');
        e.treatment_result={status:r.status,applied:r.applied??null,reason:r.reason??null};
      } else if(e.type==='occlusion')this.device.startOcclusion(e.at);
      else if(e.type==='infusion_recovery'){this.device.changeInfusionSet();this.active=this.active.filter(x=>x.type!=='infusion_deficit');}
      else if(e.type==='sensor_calibration_error') {
        if(!this.cgm?.calibration)throw new Error('sensor_calibration_error requires a calibratable CGM');
        this.cgm.calibrate(this.now,Math.max(20,this.physiology.glucose()+e.bias_mg_dl));
      }
      else if(e.type==='sensor_bias'||e.type==='sensor_drift') {
        this.cgm.injectedBiases??=[];
        this.cgm.injectedBiases.push({from:e.at,until:e.until,bias:e.bias_mg_dl,...(e.type==='sensor_drift'?{ramp:e.ramp_minutes*60000}:{})});
      }
      else if(e.type==='record'){}
      else if(e.type==='exercise_plan'){}   // visible advance notice only
      else this.active.push(e);
      const notice=visibleNotice(e,t=>this.iso(t));
      if(notice)this.notify(notice);
    }
    this.runSelfCareQueue();
    this.active=this.active.filter(e=>e.until>this.now);
    this.device.expire(this.now);
    const replaced=this.cgm?.maybeReplace(this.now,t=>this.iso(t));
    if(replaced)this.notify(replaced);
  }

  /**
   * Integrates to target. With sample=true the sensor is sampled on its grid along the way
   * (live service); otherwise the caller samples and integration stops early when a device
   * alarm fires (evaluation environment).
   */
  advanceTo(target,{sample=false}={}) {
    if(!Number.isFinite(target)||target<this.now)throw new Error('Invalid forward time');
    const noticesBefore=this.notices.length;
    while(this.now<target&&!this.terminated) {
      this.processDue();
      if(sample)this.sampleIfDue();
      const next=Math.min(target,this.now+MAX_STEP_MS,this.events[this.nextEvent]?.at??Infinity,
        ...this.active.map(e=>e.until),this.device.nextBoundary(this.now),this.cgm?.nextExpiry()??Infinity,this.selfCare.queue[0]?.at??Infinity,
        sample?(Math.floor(this.now/SAMPLE_MS)+1)*SAMPLE_MS:Infinity);
      const dt=(next-this.now)/60000,g0=this.physiology.glucose();
      const delivery=this.device.deliver(this.now,dt);
      const AC=this.active.reduce((m,e)=>Math.max(m,e.AC??0),0);
      const hepaticDelta=this.active.reduce((s,e)=>s+(e.hepatic_delta??0),0);
      const sensitivityMultiplier=this.sensitivityMultiplier(this.now);
      const actualUph=delivery.primaryUph*this.deliveryFraction();
      try {this.physiology.integrate(dt,{insulinUph:actualUph,AC,hepaticDelta,sensitivityMultiplier});}
      catch(error) {this.terminated=true;this.error=error.message;return;}
      const g1=this.physiology.glucose();
      this.cgm?.integrate(dt,(g0+g1)/2);
      this.accumulate(g0,g1,next-this.now,actualUph);
      this.now=next;
      const shown=delivery.notices.filter(n=>!this.alarmMasked(n));
      for(const n of shown)this.notify({...n,time:this.iso()});
      if(shown.length&&!sample)break;
    }
    if(this.notices.length===noticesBefore||this.now>=target)this.processDue();
    if(sample)this.sampleIfDue();
  }

  /** v1.1-hard scenario.masking.device_alarms: a pump occlusion alarm notice may be silenced (one draw per occlusion). */
  alarmMasked(n) {
    if(this.noticeHidden(n))return true;
    const p=this.config.scenario.masking?.device_alarms;
    if(!(p>0)||n.type!=='pump_occlusion_alarm')return false;
    return Rng.stream(this.config.seed,`mask:alarm:${this.device.occlusion?.since??this.now}`).next()<p;
  }

  /** Tissue exposure may differ from the device's believed ledger (e.g. external leakage).
   * This stress-test wrapper does not claim to model catheter pressure or local absorption. */
  deliveryFraction() {return this.active.reduce((f,e)=>e.type==='infusion_deficit'?Math.min(f,e.delivered_fraction):f,1);}

  /**
   * Time-varying insulin sensitivity (1 = the person's own baseline): dawn phenomenon,
   * day-to-day variation, menstrual cycle and active events such as illness or sleep loss.
   */
  sensitivityMultiplier(t) {
    const c=this.config,ph=c.physiology;let m=1;
    const local=((t+c.utc_offset_minutes*60000)%DAY_MS+DAY_MS)%DAY_MS/60000;
    if(ph.dawn_fraction>0) {
      // Rising need from 03:00, full from 05:00 to 08:00, gone by 10:00 (Perriello 1991 timing).
      const h=local<180?0:local<300?(local-180)/120:local<480?1:local<600?(600-local)/120:0;
      m/=1+ph.dawn_fraction*h;
    }
    if(ph.daily_sensitivity_cv>0) {
      // Log-normal daily level, interpolated between local noons so changes are gradual.
      const noonOffset=(local-720)/1440,dayIndex=Math.floor((t-this.start)/DAY_MS+noonOffset+1e-9);
      const frac=((t-this.start)/DAY_MS+noonOffset)-dayIndex;
      const level=i=>{const r=Rng.stream(c.seed,`daily-sensitivity:${i}`),cv=ph.daily_sensitivity_cv;return Math.exp(r.normal(0,cv)-cv*cv/2);};
      m*=level(dayIndex)*(1-frac)+level(dayIndex+1)*frac;
    }
    const mc=c.scenario.menstrual;
    if(mc.enabled&&c.patient.sex==='female'&&c.patient.age_years>=12&&c.patient.age_years<=52) {
      const phase=mc.cycle_day_at_start??Rng.stream(c.seed,'menstrual').next()*mc.cycle_days,day=(((t-this.start)/DAY_MS+phase)%mc.cycle_days);
      // Luteal phase (second half of the cycle) raises insulin need; 2-day ramps at both ends.
      const half=mc.cycle_days/2,luteal=day<half?0:Math.min(1,(day-half)/2,(mc.cycle_days-day)/2);
      m/=1+mc.luteal_need_increase*luteal;
    }
    for(const e of this.active)if(e.sensitivity_multiplier)m*=e.sensitivity_multiplier;
    return m;
  }

  accumulate(g0,g1,dtMs,rateUph) {
    const m=this.metrics,g=(g0+g1)/2,dt=dtMs/60000;
    m.elapsed_ms+=dtMs;m.glucose_integral+=g*dt;m.glucose_sq_integral+=g*g*dt;
    m.min_glucose=Math.min(m.min_glucose,g0,g1);m.max_glucose=Math.max(m.max_glucose,g0,g1);
    m.rapid_delivered_u+=rateUph*dt/60;
    if(g>=70&&g<=180)m.tir_ms+=dtMs;
    if(g<70)m.below70_ms+=dtMs;if(g<54)m.below54_ms+=dtMs;
    if(g>180)m.above180_ms+=dtMs;if(g>250)m.above250_ms+=dtMs;
    // Engineering objective, per hour: squared deviation from 120 plus a hypoglycemia penalty.
    m.reward-=((g-120)**2/10000+(g<70?5:0))*dt/60;
  }

  /** Samples the interstitial sensor on its grid; only real-time CGMs publish readings directly. */
  sampleIfDue() {
    if(this.terminated||!this.cgm||!this.cgm.isSampleTime(this.now)||this.lastSampleAt===this.now)return;
    this.lastSampleAt=this.now;
    const truth=this.physiology.glucose(),r=this.cgm.sample(this.now,truth),a=this.config.alarms;
    if(!r)return;
    if(this.cgm.modality==='flash'){this.flashAlarms(r);return;}
    const level=r.value<a.urgent_low_mg_dl?'urgent_low':r.value<a.low_mg_dl?'low':r.value>a.high_mg_dl?'high':null;
    // Edge-triggered, so a persistent low does not interrupt every tick.
    if(level&&level!==this.alarm)this.notify({type:`cgm_${level}`,value_mg_dl:r.value,time:this.iso()});
    this.alarm=level;
    this.runController(r);
    this.selfTreatLow(r.value);
    const {iob,cob}=this.estimates();
    this.outbox.samples.push({at:r.at,type:'sgv',glucose:truth,observed:r.value,display:r.display,iob:iob.iob,cob:cob.cob,simulation:true});
  }
  /** Optional flash alarms (e.g. Libre 2): they say low/high but not the value; a scan is still needed. */
  flashAlarms(r) {
    const al=this.cgm.spec.alarms;if(!al)return;
    const level=r.value<al.low_mg_dl?'low':r.value>al.high_mg_dl?'high':null;
    if(level&&level!==this.flashAlarm)this.notify({type:`flash_alarm_${level}`,time:this.iso(),note:'scan to see the value'});
    this.flashAlarm=level;
  }

  // --- the person's own management (self_care.mode 'assisted') -----------------------

  /** On an announced meal, the person plans a bolus: maybe skipped, maybe a few minutes late. */
  scheduleSelfBolus(e) {
    const sc=this.config.self_care;if(sc.mode!=='assisted')return;
    const rng=Rng.stream(this.config.seed,`self-care:${e.id}`),mb=sc.meal_bolus;
    if(rng.next()<mb.miss_probability)return;            // forgotten bolus: nothing visible happens
    if(mb.forced_miss?.length&&mb.forced_miss.includes(e.name))return;   // v1.1-hard surprise: this meal is forgotten
    const delay=Math.floor(rng.next()*(mb.max_delay_minutes+1))*60000;
    this.selfCare.queue.push({at:e.at+delay,id:e.id,grams:e.announced_grams});
    this.selfCare.queue.sort((a,b)=>a.at-b.at);
  }
  /** Gives the planned boluses that are due, sized like a pump/app bolus calculator. */
  runSelfCareQueue() {
    const q=this.selfCare.queue,c=this.config,mb=c.self_care.meal_bolus;
    while(q.length&&q[0].at<=this.now) {
      const b=q.shift(),g=this.latestGlucose(),p=c.profile,iob=this.estimates().iob.iob;
      let units=b.grams/p.carb_ratio_g_per_u;
      const fresh=g&&this.now-g.at<=FRESH_MS;
      if(fresh&&g.value>mb.correction_above_mg_dl)units+=Math.max(0,(g.value-this.targetMgdl())/p.isf_mg_dl_per_u*mb.correction_fraction-iob);
      const spec=actionSpecs(this).BOLUS?.units;if(!spec)continue;
      units=Math.min(spec.max,spec.step?Math.round(units/spec.step)*spec.step:units);
      if(!(units>spec.min))continue;
      const r=this.apply({type:'BOLUS',units:Number(units.toFixed(3))},`self:${b.id}`,'patient');
      if(r.status==='applied')this.notify({type:'patient_bolus',units:r.applied.units,grams:b.grams,
        ...(fresh&&g.value>mb.correction_above_mg_dl?{includes_correction:true}:{}),time:this.iso()});
    }
  }
  /** The person treats a low they can see (CGM reading, fingerstick or scan), then waits to recheck. */
  selfTreatLow(valueMgdl) {
    const sc=this.config.self_care;if(sc.mode!=='assisted')return;
    const lt=sc.low_treatment;
    if(valueMgdl>=lt.threshold_mg_dl||this.now-this.selfCare.lastLowTreatment<lt.recheck_minutes*60000)return;
    const r=this.apply({type:'INGEST_CARBS',grams:Math.min(lt.grams,this.config.safety.max_rescue_carbs_g)},`self-low:${this.now}`,'patient');
    if(r.status==='applied'){this.selfCare.lastLowTreatment=this.now;this.notify({type:'patient_treated_low',grams:lt.grams,value_mg_dl:valueMgdl,time:this.iso()});}
  }

  // --- measurements --------------------------------------------------------------------

  fingerstick(source) {
    const r=this.meter.measure(this.now,this.physiology.glucose(),source);
    this.metrics.fingersticks++;
    this.outbox.samples.push({at:r.at,type:'mbg',glucose:this.physiology.glucose(),observed:r.value,display:r.display,source,simulation:true});
    return r;
  }
  scan(source) {
    const s=this.cgm.scan(this.now),cur=s.current,slope=cur?s.trend:null;
    this.lastScan={at:this.now,source,value_mg_dl:cur?.value??null,display:cur?.display??null,reading_time:cur?this.iso(cur.at):null,
      trend_mg_dl_per_min:slope,direction:direction(slope),history:s.history.map(r=>({time:this.iso(r.at),value_mg_dl:r.value}))};
    this.metrics.scans++;
    if(cur)this.outbox.samples.push({at:cur.at,type:'scan',glucose:this.physiology.glucose(),observed:cur.value,display:cur.display,source,simulation:true});
    return this.lastScan;
  }
  /** Most recent glucose value the person or app can see, from any sensor. */
  latestGlucose() {
    const c=[];
    const cg=this.continuousCgm?this.cgm.latest():null;if(cg)c.push({at:cg.at,value:cg.value,display:cg.display,source:'cgm'});
    const m=this.meter?.latest();if(m)c.push({at:m.at,value:m.value,display:m.display,source:'meter'});
    if(this.lastScan?.value_mg_dl!=null)c.push({at:Date.parse(this.lastScan.reading_time),value:this.lastScan.value_mg_dl,display:this.lastScan.display,source:'flash_scan'});
    return c.sort((a,b)=>b.at-a.at)[0]??null;
  }

  // --- built-in phone controller (AAPS-like loop), optional ---------------------------

  controllerActive() {
    const k=this.controller;
    return !this.mdi&&k.enabled&&k.suspendedUntil<=this.now;
  }
  runController(reading) {
    const k=this.controller,c=this.config.controller;
    if(this.mdi||!this.continuousCgm)return;
    if(c.algorithm==='oref1'&&k.mode!=='lgs')return runOref1Controller(this);
    if(c.algorithm==='hcl'&&k.mode!=='lgs')return runHclController(this);
    // oref0 drives closed mode; in open and LGS mode it only runs (as a suggestion) when compute_suggestions is set.
    let d=null;
    if(k.mode==='closed'||c.compute_suggestions) {
      d=oref0Policy(this.observe());
      k.lastRecommendation={at:this.now,action:d.action,reason:d.rationale,nonfinite:d.nonfinite,raw:d.recommendation??null};
    }
    if(k.mode==='lgs') {
      if(!this.controllerActive()||(this.device.temp&&this.device.temp.source!=='loop'))return;
      if(reading.value<this.config.alarms.low_mg_dl)this.setTemp(0,this.cgm.spec.interval_min,'loop');
      else if(this.device.temp?.source==='loop')this.device.cancelTemp();
      return;
    }
    if(k.mode!=='closed'||!this.controllerActive())return;
    if(this.device.temp&&this.device.temp.source!=='loop')return;   // a user temp basal wins
    if(d.action.type==='TEMP_BASAL'&&!this.device.stopReason(this.now))this.setTemp(d.action.rate_u_h,d.action.duration_minutes,'loop');
  }
  setTemp(rate,minutes,source) {
    const r=this.device.setTemp(rate,minutes,this.now);this.device.temp.source=source;
    this.outbox.treatments.push({id:`temp:${this.now}:${source}`,at:this.now,eventType:'Temp Basal',absolute:r.rate_u_h,
      percent:r.percent,duration:r.duration_minutes,source});
    return r;
  }
  targetMgdl() {
    const t=this.controller.tempTarget;
    return t&&t.until>this.now?t.value:this.config.profile.target_mg_dl;
  }

  // --- observation -------------------------------------------------------------------

  estimates() {
    const c=this.config,rapid=INSULINS[this.rapidInsulin];
    return {iob:iobAt(this.visibleLedger(),this.now,c.profile.dia_hours,rapid.iob),
      cob:cobAt(this.visibleCarbs(),this.now,c.estimates.cob_absorption_minutes)};
  }

  cgmBlock() {
    if(!this.continuousCgm)return null;
    const last=this.cgm.latest(),sensor=this.cgm.sensor;
    // A trend from readings older than 15 min is stale (warm-up, signal loss) and is withheld.
    const slope=last&&this.now-last.at<=15*60000?this.cgm.trend():null;
    return {model:CGMS[this.cgm.model].name,value_mg_dl:last?.value??null,display:last?.display??null,
      sample_time:last?this.iso(last.at):null,age_minutes:last?(this.now-last.at)/60000:null,
      trend_mg_dl_per_min:slope,direction:direction(slope),
      warming_up_until:this.now<sensor.readyAt?this.iso(sensor.readyAt):null,status:this.cgm.status,
      ...(this.cgm.calibration?{calibration:{last_calibrated:Number.isFinite(sensor.calibratedAt)?this.iso(sensor.calibratedAt):null,
        due_at:Number.isFinite(this.cgm.calibrationDue())?this.iso(this.cgm.calibrationDue()):null,
        required_now:this.now>=this.cgm.calibrationDue()}}:{})};
  }

  observe() {
    const c=this.config,rapid=INSULINS[this.rapidInsulin],k=this.controller,latest=this.latestGlucose();
    const {iob,cob}=this.estimates(),day=this.now-DAY_MS;
    const out={
      virtual_time:this.iso(),local_time:this.localTime(),elapsed_minutes:(this.now-this.start)/60000,
      glucose:latest?{value_mg_dl:latest.value,display:latest.display,time:this.iso(latest.at),age_minutes:(this.now-latest.at)/60000,source:latest.source}:null,
      cgm:this.cgmBlock(),
      cgm_history:this.continuousCgm?this.cgm.history.slice(-HISTORY_SAMPLES).map(r=>({time:this.iso(r.at),value_mg_dl:r.value})):[],
      ...(this.cgm?.modality==='flash'?{flash:{model:CGMS[this.cgm.model].name,last_scan:this.lastScan?{...this.lastScan,at:this.iso(this.lastScan.at)}:null,
        warming_up_until:this.now<this.cgm.sensor.readyAt?this.iso(this.cgm.sensor.readyAt):null}}:{}),
      ...(this.meter?{meter:{model:METERS[this.meter.model].name,
        last_reading:this.meter.latest()?{time:this.iso(this.meter.latest().at),value_mg_dl:this.meter.latest().value,display:this.meter.latest().display,source:this.meter.latest().source}:null,
        readings_last_24h:this.meter.countSince(day)}}:{}),
      iob:{total_u:iob.iob,bolus_u:iob.bolus_iob,basal_u:iob.basal_iob,definition:iobDefinition(rapid.iob,c.profile.dia_hours)},
      cob:{estimate_g:cob.cob,absorbing_reported_g:cob.absorbing_carbs,definition:COB_DEFINITION},
      insulin:{rapid:rapid.name,rapid_iob_curve:rapid.iob,long_acting:this.mdi?INSULINS[c.therapy.mdi.basal_insulin].name:null},
      device:{...this.device.status(this.now,t=>this.iso(t)),
        ...(this.mdi&&this.device.maxDailyInjections!=null?{injection_budget:this.penInjectionBudget()}:{}),
        insulin_ledger:this.visibleLedger().filter(d=>d.at>this.now-c.profile.dia_hours*3600000)
          .map(d=>({time:this.iso(d.at),units:d.units,kind:d.kind}))},
      reported_carbs:this.visibleCarbs().filter(r=>r.at>this.now-6*3600000).map(r=>({time:this.iso(r.at),grams:r.grams,source:r.source})),
      profile:{basal_u_h:this.mdi?null:this.device.scheduledBasalUph,isf_mg_dl_per_u:c.profile.isf_mg_dl_per_u,
        carb_ratio_g_per_u:c.profile.carb_ratio_g_per_u,target_mg_dl:this.targetMgdl(),dia_hours:c.profile.dia_hours,
        max_basal_u_h:c.profile.max_basal_u_h,max_bolus_u:c.safety.max_bolus_u,max_rescue_carbs_g:c.safety.max_rescue_carbs_g,
        basal_injection:this.mdi?{units:c.therapy.mdi.basal_dose_u,times:c.therapy.mdi.basal_times}:null,
        self_care:c.self_care.mode,
        ...(c.profile_switch?.enabled?{changes:clone(this.profileHistory.slice(-PROFILE_HISTORY))}:{})},
      ...(c.controller.expose_actions?{controller:{mode:k.mode,enabled:k.enabled,
        ...(['oref1','hcl'].includes(c.controller.algorithm)?{algorithm:c.controller.algorithm}:{}),
        suspended_until:k.suspendedUntil>this.now?this.iso(k.suspendedUntil):null,
        temp_target:k.tempTarget?.until>this.now?{...k.tempTarget,until:this.iso(k.tempTarget.until)}:null}}:{}),
      available_actions:availableActions(this),
      action_specs:actionSpecs(this),
      events:clone(this.notices),
    };
    if(this.config.information.mode!=='native') {
      out.information={mode:this.config.information.mode,note:'Only available records are shown. Missing meal/activity/fault records do not imply these events did not occur.'};
      if(c.information.policy==='record-derived-v3')out.information.policy=c.information.policy;
      if(c.information.own_records)out.information.own_records=true;
      if(this.recordHidden('fault',null)&&out.device.stop_reason==='occlusion_alarm')out.device.stop_reason='stopped_unknown';
      if(this.recordHidden('treatment',null,null,this.start-1)) {
        if(out.device.last_bolus&&Date.parse(out.device.last_bolus.time)<this.start)out.device.last_bolus=null;
        out.iob={...out.iob,history_complete:false,note:'Estimate from available records only; unknown historical insulin is not zero.'};
      }
      out.cob={...out.cob,history_complete:this.config.information.mode==='I0',note:'Estimate from available records; unreported intake is unknown, not zero.'};
      if(['minimal-v2','record-derived-v3'].includes(c.information.policy)&&c.information.mode==='I2') {
        if(c.information.policy==='minimal-v2') {
          out.information={mode:'I2',policy:'minimal-v2',note:'Only glucose, time, static therapy parameters and necessary current device state are provided. All meal, treatment, exercise, life and fault records are withheld. IOB/COB are unknown, not zero. Your own action receipts and conversational memory remain available.'};
          out.iob={total_u:null,bolus_u:null,basal_u:null,history_complete:false,definition:'Unknown: treatment history withheld'};
          out.cob={estimate_g:null,absorbing_reported_g:null,history_complete:false,definition:'Unknown: meal history withheld'};
        } else {
          // estimates() already used visibleLedger/visibleCarbs; never substitute hidden physiology.
          out.information.note='Glucose, time, static therapy parameters, necessary current device state and numeric record-derived IOB/COB estimates are provided. All meal, treatment, exercise, life and fault records are withheld before estimation. A zero estimate is not proof of zero actual active insulin or absorbing carbohydrate. Your own action receipts and conversational memory remain available.';
          out.iob={...out.iob,history_complete:false,note:'Computed from available treatment records only; a zero estimate does not establish zero actual active insulin.'};
          out.cob={...out.cob,history_complete:false,note:'Computed from available carbohydrate records only; a zero estimate does not establish zero actual absorbing carbohydrate.'};
        }
        if(c.information.own_records) {
          out.information.note='External meal, treatment, activity, life and fault records remain withheld. Your own accepted treatment and carbohydrate records are included in record-derived IOB/COB and your visible log. Estimates reflect device records, not true tissue delivery or hidden physiology.';
          out.iob.note='Estimate includes your own device-recorded insulin; hidden external insulin remains unknown, and recorded delivery can differ from tissue delivery.';
          out.cob.note='Estimate includes your own recorded carbohydrate intake; hidden external intake remains unknown.';
        } else {out.reported_carbs=[];out.device.insulin_ledger=[];}
        for(const key of ['last_bolus','last_injection','last_basal_injection','reservoir_u','bolus_in_progress','extended_bolus'])
          if(key in out.device) {
            const knownLoop=source=>source==='loop'&&['oref1','hcl'].includes(c.controller.algorithm);
            const known=(key==='last_basal_injection'&&this.mdi&&c.therapy.mdi.dose_memory)||c.information.own_records&&(key==='last_bolus'?this.device.lastBolus?.source==='agent'||knownLoop(this.device.lastBolus?.source)
              :key==='last_basal_injection'?this.device.basalLog?.at(-1)?.source==='agent'||!!(this.mdi&&this.config.therapy.mdi.dose_memory)
              :key==='bolus_in_progress'?this.device.lastBolus?.source==='agent'||knownLoop(this.device.lastBolus?.source)
              :key==='extended_bolus'?this.device.extended?.source==='agent':false);
            if(!known)out.device[key]=null;
          }
        if(out.profile.changes)out.profile.changes=c.information.own_records?out.profile.changes.filter(change=>change.source==='agent'):[];
      }
    }
    return out;
  }
  availableActions() {return availableActions(this);}

  // --- actions -----------------------------------------------------------------------

  /** Applies a structured action at the current virtual time; treatment errors become rejected receipts. */
  apply(action,id,source='agent') {
    const s=this.config.safety,at=this.iso(),d=this.device,log=r=>this.outbox.treatments.push({id,at:this.now,source,...r});
    try {
      validateAction(this,action);
      if(this.mdi&&['BOLUS','BASAL_INJECTION'].includes(action.type)&&source!=='patient_routine'
        &&this.penInjectionBudget()?.available_for_agent===0)
        throw new Error('Daily pen injection limit reached or remaining slots reserved for routine basal injections');
      let applied;
      switch(action.type) {
        case 'WAIT':break;
        case 'BOLUS': {
          const g=this.latestGlucose(),prev=d.lastBolus;
          if(g&&this.now-g.at<=FRESH_MS&&g.value<s.block_bolus_below_mg_dl)throw new Error(`Glucose below ${s.block_bolus_below_mg_dl} mg/dL`);
          if(prev&&this.now-prev.at<s.bolus_min_interval_minutes*60000)throw new Error(`${s.bolus_min_interval_minutes} min bolus interval`);
          const r=d.bolus(action.units,this.now,source);
          if(r.instantU>0){const u=r.instantU*this.deliveryFraction();this.physiology.bolus(u);this.metrics.rapid_delivered_u+=u;}
          this.metrics.bolus_u+=r.delivered_u;
          applied={units:r.delivered_u,delivery_minutes:r.delivery_minutes};
          log({eventType:'Correction Bolus',insulin:r.delivered_u});break;
        }
        case 'CANCEL_BOLUS': {
          applied=d.cancelBolus(this.now);this.metrics.bolus_u-=applied.cancelled_u;
          log({eventType:'Note',notes:'Bolus cancelled',deliveredU:applied.delivered_u});break;
        }
        case 'TEMP_BASAL': {
          const rate=action.rate_u_h??d.scheduledBasalUph*action.percent/100;
          applied=d.setTemp(rate,action.duration_minutes,this.now);d.temp.source=source;
          log({eventType:'Temp Basal',absolute:applied.rate_u_h,percent:applied.percent,duration:applied.duration_minutes});break;
        }
        case 'CANCEL_TEMP_BASAL':applied=d.cancelTemp();log({eventType:'Temp Basal',absolute:d.scheduledBasalUph,duration:0});break;
        case 'EXTENDED_BOLUS':
          applied=d.setExtended(action.units,action.duration_minutes,this.now,source);
          log({eventType:'Combo Bolus',insulin:applied.units,duration:applied.duration_minutes});break;
        case 'CANCEL_EXTENDED_BOLUS':
          applied=d.cancelExtended();
          log({eventType:'Note',notes:'Extended bolus cancelled; delivered insulin retained',deliveredU:applied.delivered_u});break;
        case 'SUSPEND_PUMP':
          applied=d.suspend(action.minutes,this.now,source);applied={suspended_until:this.iso(applied.suspended_until)};
          log({eventType:'Temp Basal',absolute:0,duration:action.minutes,notes:'pump suspended'});break;
        case 'RESUME_PUMP':applied=d.resume();log({eventType:'Note',notes:'pump resumed'});break;
        case 'CHANGE_INFUSION_SET':
          applied=d.changeInfusionSet(this.now);this.active=this.active.filter(e=>e.type!=='infusion_deficit');log({eventType:'Site Change'});break;
        case 'BASAL_INJECTION': {
          const r=d.basalInjection(action.units,this.now,source);
          this.physiology.injectLongActing(`${source}:${id}`,r.delivered_u,INSULINS[this.config.therapy.mdi.basal_insulin].depot);
          this.metrics.long_acting_u+=r.delivered_u;applied=r;
          log({eventType:'Basal Injection',insulin:r.delivered_u});break;
        }
        case 'INGEST_CARBS':
          this.physiology.ingest(`rescue:${id}`,action.grams,action.absorption_minutes??s.rescue_absorption_minutes);
        this.reportedCarbs.push({id,at:this.now,grams:action.grams,source:source==='agent'?'agent_rescue_carbs':source});
          this.metrics.rescue_carbs_g+=action.grams;
          log({eventType:'Carb Correction',carbs:action.grams});break;
        case 'MEASURE_BG': {
          const r=this.fingerstick(source);applied={value_mg_dl:r.value,display:r.display,time:this.iso(r.at)};
          log({eventType:'BG Check',glucose:r.value,glucoseType:'Finger'});break;
        }
        case 'SCAN': {
          const r=this.scan(source);applied={value_mg_dl:r.value_mg_dl,direction:r.direction,history_points:r.history.length};break;
        }
        case 'SET_PROFILE':
          applied=this.setProfile(action,source);
          log({eventType:'Profile Switch',notes:JSON.stringify(applied.changes)});break;
        case 'CALIBRATE_CGM': {
          const r=this.fingerstick(source);this.cgm.calibrate(this.now,r.value);
          applied={meter_value_mg_dl:r.value,next_due:this.iso(this.cgm.calibrationDue())};
          log({eventType:'BG Check',glucose:r.value,glucoseType:'Finger',notes:'CGM calibration'});break;
        }
        default:
          applied=this.applyControllerAction(action);
          log({eventType:action.type==='SET_TEMP_TARGET'?'Temporary Target':'Note',notes:JSON.stringify(action),
            ...(action.type==='SET_TEMP_TARGET'?{target:this.controller.tempTarget}:{})});
      }
      return {action_id:id,status:'applied',at,...(applied&&Object.keys(applied).length?{applied}:{})};
    } catch(error) {
      if(source!=='patient')this.metrics.rejected_actions++;
      return {action_id:id,status:'rejected',reason:error.message,at};
    }
  }

  /**
   * Reprograms the profile (SET_PROFILE, already validated against action_specs): basal rate (pump,
   * on the pump's basal grid), ISF, carb ratio, target, and on pens the routine long-acting dose
   * (from the next routine injection on). Physiology is never touched. Records a change history
   * entry and a visible profile_changed notice. Returns {changes: {field: {from, to}}}.
   */
  setProfile(a,source='agent') {
    const c=this.config,profile={},changes={};
    if(this.mdi&&a.basal_dose_u!==undefined&&this.device.maxDailyInjections!=null&&c.therapy.mdi.auto_basal_injection) {
      const step=this.device.basalPenSpec.step_u,u=step?Number((Math.round(a.basal_dose_u/step)*step).toFixed(3)):a.basal_dose_u;
      const budget=this.penInjectionBudget(this.now,{basalDose:u});
      if(budget.used+budget.reserved_routine>budget.limit
        ||c.therapy.mdi.basal_times.length*Math.ceil(u/this.device.basalPenSpec.max_u-1e-9)>budget.limit)
        throw new Error('Profile change would exceed the daily pen injection limit');
    }
    const before={basal_u_h:this.mdi?null:this.device.scheduledBasalUph,isf_mg_dl_per_u:c.profile.isf_mg_dl_per_u,
      carb_ratio_g_per_u:c.profile.carb_ratio_g_per_u,target_mg_dl:c.profile.target_mg_dl,basal_dose_u:this.mdi?c.therapy.mdi.basal_dose_u:null};
    for(const k of ['basal_u_h','isf_mg_dl_per_u','carb_ratio_g_per_u','target_mg_dl'])if(a[k]!==undefined)profile[k]=a[k];
    if(Object.keys(profile).length)this.reconfigure({profile});
    if(a.basal_dose_u!==undefined) {
      const step=this.device.basalPenSpec.step_u,u=step?Number((Math.round(a.basal_dose_u/step)*step).toFixed(3)):a.basal_dose_u;
      // Routine injections already scheduled (the next day is generated ahead) take the new dose.
      for(let i=this.nextEvent;i<this.events.length;i++)if(this.events[i].type==='basal_injection')this.events[i].units=u;
      this.config.therapy.mdi.basal_dose_u=u;
    }
    const after={basal_u_h:this.mdi?null:this.device.scheduledBasalUph,isf_mg_dl_per_u:this.config.profile.isf_mg_dl_per_u,
      carb_ratio_g_per_u:this.config.profile.carb_ratio_g_per_u,target_mg_dl:this.config.profile.target_mg_dl,basal_dose_u:this.mdi?this.config.therapy.mdi.basal_dose_u:null};
    for(const k of Object.keys(before))if(a[k]!==undefined)changes[k]={from:before[k],to:after[k]};
    const entry={time:this.iso(),source,changes};
    this.profileHistory.push(entry);
    this.notify({type:'profile_changed',source,changes:clone(changes),time:this.iso()});
    return {changes};
  }

  applyControllerAction(a) {
    const k=this.controller,c=this.config.controller,dropLoopTemp=()=>{if(this.device.temp?.source==='loop')this.device.cancelTemp();};
    if(a.type==='SET_LOOP_MODE') {
      if(a.mode==='enable'){k.enabled=true;k.suspendedUntil=0;}
      else if(a.mode==='disable'){k.enabled=false;dropLoopTemp();}
      else {k.mode=a.mode;dropLoopTemp();}
    }
    if(a.type==='SUSPEND_LOOP'){k.suspendedUntil=this.now+a.minutes*60000;dropLoopTemp();}
    if(a.type==='SET_TEMP_TARGET')k.tempTarget=a.preset==='cancel'?null:{preset:a.preset,value:c.temp_targets[a.preset],until:this.now+c.temp_targets.duration_minutes*60000};
    return {mode:k.mode,enabled:k.enabled};
  }

  // --- evaluation ----------------------------------------------------------------------

  evaluatorState() {
    const s=this.physiology.state,occ=this.device.occlusion;
    return {time:this.iso(),true_glucose_mg_dl:this.physiology.glucose(),interstitial_glucose_mg_dl:this.cgm?.ig??null,
      gut_carbs_g:this.physiology.gutCarbsG(),plasma_insulin_uU_ml:s.I,rapid_sc_depot_u:(s.x1+s.x2)/1e6,
      long_acting_depot_u:this.physiology.longActingDepotU(),sensitivity_multiplier:this.sensitivityMultiplier(this.now),
      occlusion:occ?{since:this.iso(occ.since),missed_u:occ.missedU,alarmed:occ.alarmed}:null,
      actual_delivery_fraction:this.deliveryFraction(),active_events:this.active.map(e=>e.id)};
  }

  summary() {
    const m=this.metrics,T=m.elapsed_ms/60000,frac=v=>m.elapsed_ms?v/m.elapsed_ms:null,days=T/1440;
    const mean=T?m.glucose_integral/T:null,sd=T?Math.sqrt(Math.max(0,m.glucose_sq_integral/T-mean*mean)):null;
    return {elapsed_minutes:T,error:this.error,
      tir_70_180:frac(m.tir_ms),tbr_below70:frac(m.below70_ms),tbr_below54:frac(m.below54_ms),
      tar_above180:frac(m.above180_ms),tar_above250:frac(m.above250_ms),
      mean_glucose:mean,sd_glucose:sd,cv:mean?sd/mean:null,gmi_percent:mean?3.31+0.02392*mean:null,
      min_glucose:Number.isFinite(m.min_glucose)?m.min_glucose:null,max_glucose:Number.isFinite(m.max_glucose)?m.max_glucose:null,
      total_insulin_u:m.rapid_delivered_u+m.long_acting_u,rapid_delivered_u:m.rapid_delivered_u,long_acting_u:m.long_acting_u,
      bolus_u:m.bolus_u,rescue_carbs_g:m.rescue_carbs_g,rejected_actions:m.rejected_actions,reward:m.reward,
      fingersticks:m.fingersticks,scans:m.scans,fingersticks_per_day:days?m.fingersticks/days:null,scans_per_day:days?m.scans/days:null,
      metric_basis:'true plasma glucose, time-weighted over integration substeps (<=6 s); insulin = actually delivered'};
  }
}
