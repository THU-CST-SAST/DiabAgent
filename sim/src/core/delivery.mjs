// Insulin delivery devices with device-specific dose semantics. All times are virtual epoch ms.
// The ledger records what the device *believes* it delivered (as AAPS does); the physiology
// receives what was actually delivered, so occlusions make visible IOB overestimate reality.
import {PUMPS,PENS,quantize} from './devices.mjs';

const LEDGER_RETENTION_MS=24*3600000;
const BUCKET_MS=5*60000;

function addToBucket(ledger,at,units,kind,source=null) {
  const bucket=Math.floor(at/BUCKET_MS)*BUCKET_MS,last=ledger.findLast(e=>e.kind===kind&&(source==null||e.source===source));
  if(last?.at===bucket)last.units+=units;else ledger.push({at:bucket,units,kind,...(source?{source}:{})});
}

export class Pump {
  constructor({model,scheduledBasalUph,reservoirU,recordSources=false}) {
    const spec=PUMPS[model];if(!spec)throw new Error(`Unknown pump ${model}`);
    this.kind='pump';this.model=model;
    this.setScheduledBasal(scheduledBasalUph);
    this.reservoirU=Math.min(reservoirU??spec.reservoir_u,spec.reservoir_u);
    this.temp=null;this.bolusRun=null;this.extended=null;
    this.occlusion=null;          // {since, missedU, alarmed}
    this.suspendedUntil=0;        // user/loop suspension (AAPS "suspend pump")
    this.connected=true;this.battery=100;
    this.ledger=[];this.lastBolus=null;
    if(recordSources)this.recordSources=true;
  }
  static restore(s) {return Object.assign(Object.create(Pump.prototype),structuredClone(s));}
  snapshot() {return structuredClone({...this});}
  get spec() {return PUMPS[this.model];}
  /** Programs the profile basal on the device's basal grid. */
  setScheduledBasal(uph) {
    const spec=PUMPS[this.model];
    this.scheduledBasalUph=Math.max(spec.min_basal_u_h,quantize(uph,spec.basal_step_u_h));
    return this.scheduledBasalUph;
  }
  get occlusionAlarm() {return !!this.occlusion?.alarmed;}
  /** Why the pump is not delivering at `now`, or null. */
  stopReason(now) {
    if(!this.connected)return 'disconnected';
    if(this.battery<=0)return 'battery_empty';
    if(this.occlusionAlarm)return 'occlusion_alarm';
    if(now<this.suspendedUntil)return 'user_suspended';
    return null;
  }

  basalAt(now) {return this.temp&&now<this.temp.until?this.temp.rateUph:this.scheduledBasalUph;}
  programmedRate(now) {
    if(this.stopReason(now))return 0;
    const bolus=this.bolusRun&&now<this.bolusRun.until?this.bolusRun.rateUph:0;
    const ext=this.extended&&now<this.extended.until?this.extended.rateUph:0;
    return this.basalAt(now)+bolus+ext;
  }
  nextBoundary(now) {
    return Math.min(...[this.temp?.until,this.bolusRun?.until,this.extended?.until,this.suspendedUntil].filter(t=>t>now),Infinity);
  }
  expire(now) {
    if(this.temp&&now>=this.temp.until)this.temp=null;
    if(this.bolusRun&&now>=this.bolusRun.until)this.bolusRun=null;
    if(this.extended&&now>=this.extended.until)this.extended=null;
    if(this.suspendedUntil&&now>=this.suspendedUntil)this.suspendedUntil=0;
  }

  /** Delivers [now, now+dt); returns {primaryUph, instantU, notices}. */
  deliver(now,dtMin) {
    const programmed=this.programmedRate(now),notices=[],stopped=this.stopReason(now);
    const capped=Math.min(programmed,this.reservoirU*60/dtMin);
    // The app records a stopped pump as zero basal, so suspension lowers visible IOB.
    const net=((stopped?0:this.basalAt(now))-this.scheduledBasalUph)*dtMin/60;
    const netSource=this.recordSources?(stopped?(stopped==='user_suspended'?this.suspensionSource:null):this.temp?.source)??'external':null;
    if(Math.abs(net)>1e-12)addToBucket(this.ledger,now,net,'basal',netSource);
    if(!stopped) {
      const ext=this.extended&&now<this.extended.until?this.extended.rateUph*dtMin/60:0;
      if(ext>0){addToBucket(this.ledger,now,ext,'extended',this.recordSources?this.extended.source??'external':null);this.extended.deliveredU+=ext;}
      if(this.bolusRun&&now<this.bolusRun.until)this.bolusRun.deliveredU+=this.bolusRun.rateUph*dtMin/60;
    }
    let actual=capped;
    if(this.occlusion&&!this.occlusion.alarmed) {
      this.occlusion.missedU+=capped*dtMin/60;actual=0;
      if(this.occlusion.missedU>=this.spec.occlusion_alarm_missed_u) {
        this.occlusion.alarmed=true;this.temp=null;this.bolusRun=null;this.extended=null;
        notices.push({type:'pump_occlusion_alarm',missed_u_estimate:this.occlusion.missedU});
      }
    } else this.reservoirU=Math.max(0,this.reservoirU-capped*dtMin/60);
    if(this.ledger.length>500)this.ledger=this.ledger.filter(e=>e.at>now-LEDGER_RETENTION_MS);
    return {primaryUph:actual,instantU:0,notices};
  }

  ensureRunning(now) {
    const why=this.stopReason(now);
    if(why==='occlusion_alarm')throw new Error('Pump suspended by occlusion alarm; change the infusion set');
    if(why)throw new Error(`Pump not delivering (${why})`);
  }

  bolus(units,now,source=null) {
    const s=this.spec;this.ensureRunning(now);
    if(units>s.max_bolus_u)throw new Error(`Exceeds device max bolus ${s.max_bolus_u} U`);
    if(this.bolusRun&&now<this.bolusRun.until)throw new Error('Bolus already in progress');
    const u=quantize(units,s.bolus_step_u,'down');
    if(!(u>0))throw new Error(`Below bolus step ${s.bolus_step_u} U`);
    if(u>this.reservoirU)throw new Error('Insufficient reservoir');
    const provenance=this.recordSources?{source:source??'external'}:{};
    this.lastBolus={at:now,units:u,...provenance};this.ledger.push({at:now,units:u,kind:'bolus',...provenance});
    if(!Number.isFinite(s.bolus_speed_u_per_min)) {
      if(this.occlusion)this.occlusion.missedU+=u;else this.reservoirU-=u;
      return {delivered_u:u,instantU:this.occlusion?0:u,delivery_minutes:0};
    }
    const minutes=u/s.bolus_speed_u_per_min;
    this.bolusRun={units:u,deliveredU:0,rateUph:s.bolus_speed_u_per_min*60,startedAt:now,until:now+Math.round(minutes*60000)};
    return {delivered_u:u,instantU:0,delivery_minutes:minutes};
  }

  setTemp(rateUph,minutes,now) {
    const s=this.spec,t=s.tbr;this.ensureRunning(now);
    let rate,percent=null;
    if(t.type==='percent') {
      const base=this.scheduledBasalUph;
      percent=Math.min(t.max,Math.max(0,quantize(base?rateUph/base*100:0,t.step)));
      rate=base*percent/100;
    } else rate=Math.min(t.max,s.max_basal_u_h,Math.max(0,quantize(rateUph,t.step)));
    const duration=Math.min(t.max_duration_min,Math.max(t.duration_step_min,quantize(minutes,t.duration_step_min)));
    this.temp={rateUph:rate,percent,startedAt:now,until:now+duration*60000};
    return {rate_u_h:rate,percent,duration_minutes:duration};
  }
  cancelTemp() {this.temp=null;return {};}

  setExtended(units,minutes,now,source=null) {
    const e=this.spec.extended;this.ensureRunning(now);
    if(!e)throw new Error(`${this.spec.name} does not support extended bolus via AAPS`);
    const u=quantize(units,e.step_u,'down'),d=Math.min(e.max_minutes,Math.max(e.duration_step_min,quantize(minutes,e.duration_step_min)));
    if(!(u>0))throw new Error('Extended bolus below step');
    if(u>this.reservoirU)throw new Error('Insufficient reservoir');
    this.extended={units:u,rateUph:u/d*60,startedAt:now,until:now+d*60000,deliveredU:0,
      ...(this.recordSources?{source:source??'external'}:{})};
    return {units:u,duration_minutes:d};
  }
  cancelExtended() {const e=this.extended;this.extended=null;return {delivered_u:e?.deliveredU??0};}

  /** Stops a running bolus; the ledger keeps only what was delivered, as pump history does. */
  cancelBolus(now) {
    const b=this.bolusRun;
    if(!b||now>=b.until)throw new Error('No bolus in progress');
    const delivered=Math.min(b.units,b.deliveredU),entry=this.ledger.findLast(e=>e.kind==='bolus'&&e.at===b.startedAt);
    if(entry)entry.units=delivered;
    if(this.lastBolus?.at===b.startedAt)this.lastBolus.units=delivered;
    this.bolusRun=null;
    return {delivered_u:delivered,cancelled_u:b.units-delivered};
  }
  suspend(minutes,now,source=null) {
    if(this.bolusRun&&now<this.bolusRun.until)this.cancelBolus(now);
    if(this.recordSources)this.suspensionSource=source??'external';
    this.suspendedUntil=now+minutes*60000;return {suspended_until:this.suspendedUntil};
  }
  resume() {const was=this.suspendedUntil;this.suspendedUntil=0;return {was_suspended:was>0};}
  maintenance({connected,battery,reservoirU}) {
    if(connected!==undefined)this.connected=connected;
    if(battery!==undefined)this.battery=battery;
    if(reservoirU!==undefined)this.reservoirU=Math.min(reservoirU,this.spec.reservoir_u);
    return {connected:this.connected,battery:this.battery,reservoir_u:this.reservoirU};
  }

  startOcclusion(now) {if(!this.occlusion)this.occlusion={since:now,missedU:0,alarmed:false};}
  changeInfusionSet() {const had=!!this.occlusion;this.occlusion=null;return {cleared_occlusion:had};}

  status(now,iso) {
    const t=this.temp,b=this.bolusRun,e=this.extended;
    return {type:'pump',model:this.model,name:this.spec.name,scheduled_basal_u_h:this.scheduledBasalUph,
      current_basal_u_h:this.stopReason(now)?0:this.basalAt(now),suspended:!!this.stopReason(now),stop_reason:this.stopReason(now),
      suspended_until:now<this.suspendedUntil?iso(this.suspendedUntil):null,connected:this.connected,battery:this.battery,form:this.spec.form,
      temp_basal:t&&now<t.until?{rate_u_h:t.rateUph,percent:t.percent,started_at:iso(t.startedAt),ends_at:iso(t.until),remaining_minutes:(t.until-now)/60000}:null,
      bolus_in_progress:b&&now<b.until?{units:b.units,ends_at:iso(b.until)}:null,
      extended_bolus:e&&now<e.until?{units:e.units,delivered_u:e.deliveredU,ends_at:iso(e.until)}:null,
      reservoir_u:this.reservoirU,last_bolus:this.lastBolus?{time:iso(this.lastBolus.at),units:this.lastBolus.units}:null,
      limits:{bolus_step_u:this.spec.bolus_step_u,max_bolus_u:this.spec.max_bolus_u,basal_step_u_h:this.spec.basal_step_u_h,
        max_basal_u_h:this.spec.max_basal_u_h,tbr:this.spec.tbr,extended:!!this.spec.extended}};
  }
}

/** Multiple daily injections: a rapid-insulin pen and a long-acting pen. */
export class Pens {
  constructor({bolusPen,basalPen,basalInsulin,recordSources=false,maxDailyInjections=null,utcOffsetMinutes=0}) {
    for(const p of [bolusPen,basalPen])if(!PENS[p])throw new Error(`Unknown pen ${p}`);
    this.kind='mdi';Object.assign(this,{bolusPen,basalPen,basalInsulin});
    this.ledger=[];this.lastBolus=null;this.basalLog=[];
    if(maxDailyInjections!=null){this.maxDailyInjections=maxDailyInjections;this.utcOffsetMinutes=utcOffsetMinutes;this.injectionCounts={};}
    if(recordSources)this.recordSources=true;
  }
  static restore(s) {return Object.assign(Object.create(Pens.prototype),structuredClone(s));}
  snapshot() {return structuredClone({...this});}
  get suspended() {return false;}
  get bolusPenSpec() {return PENS[this.bolusPen];}
  get basalPenSpec() {return PENS[this.basalPen];}
  stopReason() {return null;}
  nextBoundary() {return Infinity;}
  expire() {}
  deliver() {return {primaryUph:0,instantU:0,notices:[]};}

  injectionDay(now) {return new Date(now+(this.utcOffsetMinutes??0)*60000).toISOString().slice(0,10);}
  injectionBudget(now) {
    const day=this.injectionDay(now),used=this.injectionCounts?.[day]??0;
    return {local_date:day,limit:this.maxDailyInjections??null,used,
      remaining:this.maxDailyInjections==null?null:Math.max(0,this.maxDailyInjections-used)};
  }
  recordInjection(now,{historical=false}={}) {
    if(this.maxDailyInjections==null)return;
    const budget=this.injectionBudget(now);
    if(!historical&&budget.remaining===0)throw new Error('Daily pen injection limit reached');
    this.injectionCounts??={};this.injectionCounts[budget.local_date]=budget.used+1;
  }

  bolus(units,now,source=null) {
    const pen=PENS[this.bolusPen],u=quantize(units,pen.step_u);
    if(!(u>0))throw new Error(`Below pen step ${pen.step_u} U`);
    if(u>pen.max_u)throw new Error(`Exceeds pen max ${pen.max_u} U`);
    this.recordInjection(now);
    const provenance=this.recordSources?{source:source??'external'}:{};
    this.lastBolus={at:now,units:u,...provenance};this.ledger.push({at:now,units:u,kind:'bolus',...provenance});
    return {delivered_u:u,instantU:u,delivery_minutes:0};
  }
  basalInjection(units,now,source) {
    const pen=PENS[this.basalPen],u=quantize(units,pen.step_u);
    if(!(u>0))throw new Error(`Below pen step ${pen.step_u} U`);
    if(u>pen.max_u)throw new Error(`Exceeds pen max ${pen.max_u} U`);
    this.recordInjection(now);
    this.basalLog.push({at:now,units:u,source});
    return {delivered_u:u};
  }
  status(now,iso) {
    const last=this.basalLog.at(-1);
    return {type:'mdi',bolus_pen:PENS[this.bolusPen].name,basal_pen:PENS[this.basalPen].name,basal_insulin:this.basalInsulin,
      current_basal_u_h:0,suspended:false,temp_basal:null,
      last_bolus:this.lastBolus?{time:iso(this.lastBolus.at),units:this.lastBolus.units}:null,
      last_basal_injection:last?{time:iso(last.at),units:last.units}:null,
      limits:{bolus_step_u:PENS[this.bolusPen].step_u,max_bolus_u:PENS[this.bolusPen].max_u,basal_step_u:PENS[this.basalPen].step_u},
      ...(this.maxDailyInjections==null?{}:{injection_budget:this.injectionBudget(now)})};
  }
}
