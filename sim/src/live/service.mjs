// One long-running World driven by a (possibly accelerated) clock: real-time ticks, speed,
// fast-forward, transactional rollback and idempotent relay commands. Replaces upstream
// src/service.js + src/patient.js; the physiology, pump, CGM, scenario and loop now come from
// the shared World (src/sim/world.mjs), and src/live/compat.mjs keeps the upstream shapes.
import {randomUUID} from 'node:crypto';
import {World} from '../sim/world.mjs';
import {normalizeConfig} from '../core/config.mjs';
import {parseCommand,planCommand} from './commands.mjs';
import {DAY_MS,SAMPLE_MS,CARB_ABSORPTION_MINUTES,DEFAULT_LIVE_CONFIG,parseLiveConfig,mergeLiveConfig,toWorldConfig,
  sleepEvents,localDayOf,eventView,sampleRecord,treatmentRecord,commandTreatment,tempTargetView,statusView,
  isLegacyCheckpoint,migrateLegacyCheckpoint} from './compat.mjs';

export const CHECKPOINT_FORMAT='sweet-sim-live/2';
const clone=x=>structuredClone(x);
const emptyPending=()=>({samples:[],treatments:[],events:[],changes:[]});
const ADVANCE_CHUNK_MS=3600000;      // sleep labels and pruning interleave at least hourly
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
/** Minimal World config patch turning config a into b (changed leaves only; arrays whole). */
function configPatch(a,b) {
  const out={};
  for(const [k,v] of Object.entries(b)) {
    if(isObject(v)&&isObject(a[k])){const p=configPatch(a[k],v);if(Object.keys(p).length)out[k]=p;}
    else if(JSON.stringify(a[k])!==JSON.stringify(v))out[k]=clone(v);
  }
  return out;
}

export class LiveService {
  /**
   * store: Store (src/live/store.mjs). Options for a fresh database: config (upstream shape),
   * start (virtual epoch ms; floored to the 5-minute grid). clock: wall clock in ms (tests
   * pass an accelerated or manual clock).
   */
  constructor(store,{config=DEFAULT_LIVE_CONFIG,start,clock=Date.now}={}) {
    this.store=store;this.clock=clock;this.pending=emptyPending();
    const saved=store.load();
    if(saved&&isLegacyCheckpoint(saved)) {
      store.backupLegacy(saved,clock());
      const {world,live}=migrateLegacyCheckpoint(saved);
      this.world=world;this.live={...live,eventCursor:world.nextEvent};
      this.collect();this.commit();
    } else if(saved) {
      if(saved.format!==CHECKPOINT_FORMAT)throw new Error(`Unknown checkpoint format ${saved.format}`);
      this.restoreFrom(saved);
    } else {
      const cfg=parseLiveConfig(clone(config)),wall=clock(),t0=Math.floor((start??wall)/SAMPLE_MS)*SAMPLE_MS;
      this.world=new World(toWorldConfig(cfg,t0));
      this.live={sessionId:randomUUID(),start:t0,config:cfg,publicationOffset:0,wallAnchor:wall,wallVirtualAnchor:t0,
        fastForward:null,simulationError:null,manualTemp:null,eventCursor:0,
        sleep:{sleeping:false,active:[],pending:[],days:[],doneIds:[]}};
      this.collect();this.commit();
    }
  }

  // --- read accessors ---------------------------------------------------------------------
  get now() {return this.world.now;}
  get start() {return this.live.start;}
  get config() {return this.live.config;}
  get sessionId() {return this.live.sessionId;}
  get publicationOffset() {return this.live.publicationOffset;}
  get fastForwardState() {return this.live.fastForward;}
  get simulationError() {return this.live.simulationError??this.world.error??null;}
  status() {return statusView(this.world,this.live,this.recommendation());}
  /**
   * Raw oref0 determine-basal output from the World controller's last CGM sample (upstream
   * status.recommendation and devicestatus openaps.suggested); null before the first one.
   */
  recommendation() {return this.world.controller.lastRecommendation?.raw??null;}
  /** Scheduled lifestyle events and sleep labels not yet reached (upstream admin `events`). */
  upcomingEvents() {
    return [...this.world.events.slice(this.world.nextEvent).map(eventView),...clone(this.live.sleep.pending)].sort((a,b)=>a.at-b.at);
  }

  // --- persistence ------------------------------------------------------------------------
  serialize() {return {format:CHECKPOINT_FORMAT,live:clone(this.live),world:this.world.snapshot()};}
  restoreFrom(s) {this.live=clone(s.live);this.world=World.restore(s.world);this.pending=emptyPending();}
  commit(command=null) {
    this.collect();
    this.store.commit(this.serialize(),this.pending,command);
    this.pending=emptyPending();
  }
  /** Runs fn(service) and persists atomically; any failure restores the previous state. */
  transaction(fn) {
    const before=this.serialize();
    try {const result=fn(this);this.commit();return result;}
    catch(error){this.restoreFrom(before);throw error;}
  }

  /** Moves records produced by the World (and sleep labels) into the pending commit, then prunes. */
  collect() {
    const w=this.world,l=this.live,p=this.pending,o=w.drain();
    for(const s of o.samples) {
      if(s.type==='sgv')p.samples.push(sampleRecord(s));
      else p.events.push({id:`${s.type}:${s.at}`,type:s.type,at:s.at,observed:s.observed,source:s.source,simulation:true});
    }
    for(const t of o.treatments)p.treatments.push(treatmentRecord(t,w));
    for(const e of w.events.slice(l.eventCursor,w.nextEvent))p.events.push({...eventView(e),simulation:true});
    l.eventCursor=w.nextEvent;
    for(const n of o.notices)if(!n.id)p.events.push({id:`notice:${n.type}:${n.time}`,type:n.type,at:Date.parse(n.time),notice:n,simulation:true});
    this.processSleep();
    // Everything up to now is persisted, so the World may drop it (it keeps what it still needs).
    l.eventCursor-=w.prune(w.now+1).events;
  }

  // --- sleep context labels -----------------------------------------------------------------
  ensureSleep() {
    const s=this.live.sleep;
    for(const offset of [-DAY_MS,0,DAY_MS]) {
      const day=localDayOf(this.world.now+offset);if(s.days.includes(day))continue;
      s.days.push(day);
      s.pending.push(...sleepEvents(day,this.config).filter(e=>e.at>=this.live.start&&!s.doneIds.includes(e.id)));
    }
    s.pending.sort((a,b)=>a.at-b.at);
    if(s.days.length>10)s.days=s.days.slice(-6);
  }
  processSleep() {
    this.ensureSleep();
    const s=this.live.sleep,now=this.world.now;
    while(s.pending.length&&s.pending[0].at<=now) {
      const e=s.pending.shift();
      s.doneIds=[...s.doneIds.slice(-19),e.id];
      this.pending.events.push({...e,simulation:true});
      if(e.type==='sleep'){s.sleeping=true;s.active.push(e);}
      if(e.type==='wake')s.sleeping=false;
    }
    s.active=s.active.filter(e=>e.until>now);
  }

  // --- time -------------------------------------------------------------------------------
  advanceTo(target) {
    if(!Number.isFinite(target)||target<this.world.now)throw new Error('Invalid forward time');
    while(this.world.now<target) {
      this.world.advanceTo(Math.min(target,this.world.now+ADVANCE_CHUNK_MS),{sample:true});
      if(this.world.terminated)throw new Error(this.world.error??'Simulation terminated');
      this.collect();
    }
  }

  tick() {
    const l=this.live,w=this.world;
    if(l.fastForward&&l.fastForward.target>w.now) {
      this.transaction(s=>{
        const ff=s.live.fastForward;
        s.advanceTo(Math.min(ff.target,s.world.now+30*60000));
        if(s.world.now>=ff.target){const t=s.clock();s.live.fastForward=null;s.live.publicationOffset=t-s.world.now;s.live.wallAnchor=t;s.live.wallVirtualAnchor=s.world.now;}
      });return;
    }
    if(l.config.paused||l.config.speed===0)return;
    const target=l.wallVirtualAnchor+(this.clock()-l.wallAnchor)*l.config.speed;
    if(target>w.now)this.transaction(s=>{
      s.advanceTo(Math.min(target,s.world.now+5*60000));
      if(s.config.speed!==1)s.live.publicationOffset=s.clock()-s.world.now;
    });
  }
  fastForward(minutes) {
    if(!Number.isFinite(minutes)||minutes<=0||minutes>7*1440)throw new Error('Fast-forward must be 1..10080 minutes');
    return this.fastForwardTo(this.world.now+minutes*60000);
  }
  fastForwardTo(target) {
    if(!Number.isFinite(target)||target<=this.world.now||target-this.world.now>7*86400000)throw new Error('Target must be after current simulation time and within 7 days');
    if(this.live.fastForward)throw new Error('Fast-forward already running');
    return this.transaction(s=>{s.live.fastForward={start:s.world.now,target};return clone(s.live.fastForward);});
  }
  /** Persists a stopped simulation (paused, with the error shown in status and /health). */
  markFailed(message) {
    return this.transaction(s=>{s.live.config.paused=true;s.live.simulationError=message;s.live.fastForward=null;});
  }

  // --- relay commands -----------------------------------------------------------------------
  applyCommand(text,id) {
    const c=parseCommand(text),w=this.world,at=w.now,source='aaps_relay';
    const plan=planCommand(c,{scheduledBasalUph:w.device.scheduledBasalUph,maxBasalUph:this.config.profile.maxBasalUph,
      carbAbsorptionMinutes:CARB_ABSORPTION_MINUTES});
    for(const action of plan.actions) {
      const r=w.apply(action,id,source);
      if(r.status!=='applied')throw new Error(r.reason);
    }
    if(c.type==='temp_basal')this.live.manualTemp={...c,at,until:at+c.minutes*60000};
    if(c.type==='cancel_basal')this.live.manualTemp=null;
    if(plan.cancelUserTemp){w.device.cancelTemp();this.live.manualTemp=null;}
    this.collect();
    const target=tempTargetView(w,this.config);
    this.pending.treatments=this.pending.treatments.map(t=>t.id===id?commandTreatment(t,c,text,target):t);
    return {simulation:true,sessionId:this.sessionId,commandId:id,command:text,appliedAt:new Date(at).toISOString(),
      action:c,actions:plan.actions,status:'applied',...(c.type==='extended'?{scheduledU:c.units,deliveredU:0}:{}),state:this.status()};
  }
  /** Executes a relay command exactly once per ID; local failures become failed receipts. */
  command(id,cmd) {
    const previous=this.store.command(id);
    if(previous){if(previous.cmd!==cmd)throw new Error('Command ID reused with different payload');return previous.outcome;}
    const before=this.serialize();let outcome;
    try {outcome={status:'success',result:this.applyCommand(cmd,id)};}
    catch(error){this.restoreFrom(before);outcome={status:'failed',result:{error:error.message,simulation:true}};}
    try {this.commit({id,cmd,outcome,simMs:this.world.now});}
    catch(error){this.restoreFrom(before);throw error;}
    return outcome;
  }

  // --- configuration and maintenance --------------------------------------------------------
  /** Upstream PATCH semantics: drug and meal pools stay; only future lifestyle is redrawn. */
  changeConfig(patch) {
    const previous=clone(this.live.config),next=mergeLiveConfig(previous,patch),w=this.world,now=w.now;
    const target=normalizeConfig(toWorldConfig(next,w.start));
    // Initial glucose only seeds a new World; the running one keeps its own.
    target.patient.initial_glucose_mg_dl=w.config.patient.initial_glucose_mg_dl;
    const worldPatch=configPatch(w.config,target);
    // An explicit loopMode is re-applied even when unchanged (resets a mode set by a LOOP command).
    if(patch.loopMode!==undefined)worldPatch.controller={...worldPatch.controller,mode:next.loopMode};
    w.reconfigure(worldPatch);   // future lifestyle events are redrawn by the World when they change
    this.live.config=next;
    if(patch.sleep||patch.seed!==undefined) {
      const s=this.live.sleep;s.pending=[];s.days=[];this.ensureSleep();s.pending=s.pending.filter(e=>e.at>now);
    }
    this.live.wallAnchor=this.clock();this.live.wallVirtualAnchor=now;
    this.pending.changes.push({kind:'config',before:previous,after:clone(next),simulationTime:now});
    return next;
  }
  /** Virtual pump connection, reservoir and battery (upstream /api/admin/pump-maintenance). */
  pumpMaintenance(b) {
    const allowed=['pumpConnected','reservoirU','battery'];
    if(!b||typeof b!=='object'||Object.keys(b).some(k=>!allowed.includes(k))||typeof b.pumpConnected!=='boolean'||!Number.isFinite(b.reservoirU)
      ||b.reservoirU<0||b.reservoirU>300||!Number.isFinite(b.battery)||b.battery<0||b.battery>100)throw new Error('Invalid virtual pump maintenance settings');
    const d=this.world.device;
    this.pending.changes.push({kind:'virtual_pump_maintenance',before:{pumpConnected:d.connected,reservoirU:d.reservoirU,battery:d.battery},
      after:{...b},simulationTime:this.world.now});
    d.maintenance({connected:b.pumpConnected,battery:b.battery,reservoirU:b.reservoirU});
    return {pumpConnected:d.connected,reservoirU:d.reservoirU,battery:d.battery};
  }
}

/** Upstream name, kept for callers of the former src/service.js. */
export {LiveService as PatientService};
