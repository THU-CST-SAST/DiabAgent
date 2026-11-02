import {randomUUID} from 'node:crypto';
import Deichmann2023,{DEFAULT_PARAMETERS,initialState,insulinFromBasal,rk4Step} from '../../../model/Deichmann2023.ts';
import {DEFAULT_CONFIG,configSchema,mergeConfig} from './config.js';
import {dayEvents,localDay,random} from './lifestyle.js';
import {parseCommand} from './commands.js';
import {iobAt,controllerRecommendation} from './controller.js';

const clone=x=>structuredClone(x);
export class VirtualPatient {
  constructor({config=DEFAULT_CONFIG,start=Date.now(),snapshot=null}={}) {
    if(snapshot){this.restore(snapshot);return;}
    this.config=configSchema.parse(config);this.sessionId=randomUUID();this.start=start;this.now=start;
    this.params={...DEFAULT_PARAMETERS,BW:this.config.subject.weightKg};
    const delivery=this.config.profile.basalUph*1e6/60;
    this.state={...initialState({...this.params,Ib:insulinFromBasal(delivery,this.params)},delivery,this.config.initialGlucoseMgdl),G:this.config.initialGlucoseMgdl};
    this.meals=[];this.doses=[];this.dailyEvents=[];this.generatedDays=[];this.activeEvents=[];this.recentSamples=[];this.processedEventIds=[];
    this.manualBasal=null;this.autoBasal=null;this.extended=null;this.tempTarget=null;
    this.loopMode=this.config.loopMode;this.loopEnabled=true;this.loopSuspendedUntil=0;this.sleeping=false;
    this.faults={pumpConnected:true,reservoirU:150,battery:100};this.randomIndex=0;
    this.nextSample=start;this.publicationOffset=0;this.wallAnchor=Date.now();this.wallVirtualAnchor=start;
    this.lastRecommendation=null;this.pending={samples:[],events:[],treatments:[],changes:[]};
    this.rebuildModel();this.ensureDays();this.atBoundary();
  }
  rebuildModel(){this.patient=new Deichmann2023(this.params);}
  serialize(){return clone(Object.fromEntries(Object.entries(this).filter(([k])=>!['patient','pending'].includes(k))));}
  restore(s){Object.assign(this,clone(s));this.rebuildModel();this.pending={samples:[],events:[],treatments:[],changes:[]};}
  drain(){const p=this.pending;this.pending={samples:[],events:[],treatments:[],changes:[]};return p;}
  ensureDays() {
    for(const offset of [-86400000,0,86400000]) {
      const day=localDay(this.now+offset);if(this.generatedDays.includes(day))continue;
      this.generatedDays.push(day);this.dailyEvents.push(...dayEvents(day,this.config).filter(e=>e.at>=this.start&&!this.processedEventIds.includes(e.id)));
    }
    this.dailyEvents.sort((a,b)=>a.at-b.at);
  }
  noise(){const rng=random((this.config.seed+this.randomIndex++*7919)>>>0);return (rng()*2-1)*this.config.sensorNoiseMgdl;}
  addMeal(grams,tau,source,id=randomUUID()) {
    const index=this.meals.length?Math.max(...this.meals.map(m=>m.index))+1:0;
    this.meals.push({id,index,grams,tau,at:this.now,source});this.state[`meal${index}a`]=grams*1000*this.params.AG;this.state[`meal${index}b`]=0;
    this.pending.treatments.push({id,at:this.now,eventType:'Carb Correction',carbs:grams,source,simulation:true,consumed:true});
  }
  bolus(units,source,id=randomUUID()) {
    if(!this.faults.pumpConnected||this.faults.battery<=0||this.faults.reservoirU<units)throw new Error('Virtual pump unavailable or insufficient reservoir');
    this.state.x1+=units*1e6;this.faults.reservoirU-=units;
    this.doses.push({at:this.now,units,kind:'bolus',id});
    this.pending.treatments.push({id,at:this.now,eventType:'Correction Bolus',insulin:units,source,simulation:true,delivered:true});
  }
  cob(){return this.meals.reduce((s,m)=>s+(this.state[`meal${m.index}a`]+this.state[`meal${m.index}b`])/this.params.AG/1000,0);}
  basalRate() {
    const p=this.config.profile;
    if(this.manualBasal?.until>this.now)return this.manualBasal.basis==='percent'?p.basalUph*this.manualBasal.value/100:this.manualBasal.value;
    if(this.autoBasal?.until>this.now&&this.loopEnabled&&this.loopSuspendedUntil<=this.now&&this.loopMode!=='open')return this.autoBasal.rate;
    return p.basalUph;
  }
  atBoundary() {
    this.ensureDays();
    for(const e of this.dailyEvents.filter(e=>!e.done&&e.at<=this.now)) {
      e.done=true;this.processedEventIds.push(e.id);this.pending.events.push({...e,simulation:true});
      if(e.type==='meal')this.addMeal(e.carbsG,e.tau,e.source,e.id);
      if(e.type==='sleep'){this.sleeping=true;this.activeEvents.push(e);}
      if(e.type==='wake')this.sleeping=false;
      if(['exercise','stress'].includes(e.type))this.activeEvents.push(e);
    }
    this.activeEvents=this.activeEvents.filter(e=>e.until>this.now);
    if(this.now>=this.nextSample) {
      const sample={at:this.now,glucose:this.state.G,observed:this.state.G+this.noise(),iob:iobAt(this).iob,cob:this.cob(),simulation:true};
      this.recentSamples.push(sample);this.recentSamples=this.recentSamples.filter(p=>p.at>=this.now-6*3600000);
      this.pending.samples.push(sample);this.nextSample=this.now+this.config.sampleMinutes*60000;
      if(this.recentSamples.length>=3) {
        this.lastRecommendation=controllerRecommendation(this);
        if(this.loopEnabled&&this.loopSuspendedUntil<=this.now&&!(this.manualBasal?.until>this.now)) {
          const r=this.lastRecommendation;
          if(this.loopMode==='closed'&&Number.isFinite(r.rate)&&r.duration>0)this.autoBasal={rate:Math.max(0,Math.min(this.config.profile.maxBasalUph,r.rate)),until:this.now+r.duration*60000};
          if(this.loopMode==='lgs')this.autoBasal={rate:sample.observed<70?0:this.config.profile.basalUph,until:this.now+this.config.sampleMinutes*60000};
        }
      }
    }
  }
  integrate(dt) {
    const basal=this.basalRate(),square=this.extended?.until>this.now?this.extended.rate:0;
    const available=this.faults.pumpConnected&&this.faults.battery>0;
    const actual=available?Math.min(basal+square,this.faults.reservoirU*60/dt):0;
    const AC=this.activeEvents.reduce((s,e)=>Math.max(s,e.AC??0),0);
    this.patient.hepaticDelta=this.activeEvents.reduce((s,e)=>s+(e.hepaticDelta??0),0);
    rk4Step(this.state,dt,(x,offset)=>{
      const Ra=this.meals.reduce((s,m)=>s+x[`meal${m.index}b`]/m.tau,0);
      const d=this.patient.computeDerivatives(new Date(this.now+offset*60000),x,{iir:actual,AC,Ra});
      for(const m of this.meals){d[`meal${m.index}a`]=-x[`meal${m.index}a`]/m.tau;d[`meal${m.index}b`]=(x[`meal${m.index}a`]-x[`meal${m.index}b`])/m.tau;}
      return d;
    });
    this.state.G=this.state.Q1/this.params.Vg;
    if(this.state.G<=0||Object.values(this.state).some(v=>!Number.isFinite(v)))throw new Error('Nonphysical model state; no glucose clipping');
    this.faults.reservoirU=Math.max(0,this.faults.reservoirU-actual*dt/60);
    // Signed excess basal and actual extended input are separate from physiological plasma I.
    const deliveredBasal=Math.min(actual,basal),deliveredSquare=Math.max(0,actual-deliveredBasal);
    if(Math.abs(deliveredBasal-this.config.profile.basalUph)>1e-12)this.continuousDose((deliveredBasal-this.config.profile.basalUph)*dt/60,'basal');
    if(deliveredSquare>0){this.continuousDose(deliveredSquare*dt/60,'extended');this.extended.deliveredU+=deliveredSquare*dt/60;}
  }
  continuousDose(units,kind) {
    const at=Math.floor(this.now/60000)*60000;
    const existing=this.doses.slice(-4).find(d=>d.kind===kind&&d.at===at);
    if(existing)existing.units+=units;else this.doses.push({at,units,kind});
  }
  advanceTo(target) {
    if(!Number.isFinite(target)||target<this.now)throw new Error('Invalid forward time');
    while(this.now<target) {
      this.atBoundary();
      const boundaries=[target,this.nextSample,...this.dailyEvents.filter(e=>!e.done).map(e=>e.at),...this.activeEvents.map(e=>e.until),
        this.manualBasal?.until,this.autoBasal?.until,this.extended?.until,this.tempTarget?.until,this.loopSuspendedUntil].filter(t=>Number.isFinite(t)&&t>this.now);
      const next=Math.min(this.now+6000,...boundaries),dt=(next-this.now)/60000;
      this.integrate(dt);this.now=next;
      if(this.doses.length>1000)this.doses=this.doses.filter(d=>d.at>this.now-this.config.profile.diaHours*3600000);
      for(const m of this.meals.filter(m=>this.now-m.at>24*3600000&&(this.state[`meal${m.index}a`]+this.state[`meal${m.index}b`])<.001)) {
        delete this.state[`meal${m.index}a`];delete this.state[`meal${m.index}b`];this.meals=this.meals.filter(v=>v!==m);
      }
      if(this.generatedDays.length>10){const cutoff=this.now-3*86400000;this.dailyEvents=this.dailyEvents.filter(e=>e.at>=cutoff||!e.done);this.generatedDays=this.generatedDays.slice(-6);}
    }
    this.atBoundary();
  }
  applyCommand(text,id) {
    const c=parseCommand(text),at=this.now,until=n=>at+n*60000,source='aaps_relay';
    if(c.type==='bolus')this.bolus(c.units,source,id);
    if(c.type==='carbs')this.addMeal(c.grams,this.params.tau_m,source,id);
    if(c.type==='temp_basal'){
      const rate=c.basis==='percent'?this.config.profile.basalUph*c.value/100:c.value;
      if(rate>this.config.profile.maxBasalUph)throw new Error('Virtual profile max basal exceeded');
      this.manualBasal={...c,at,until:until(c.minutes)};
      this.pending.treatments.push({id,at,eventType:'Temp Basal',absolute:rate,duration:c.minutes,source,simulation:true,basis:c.basis,value:c.value});
    }
    if(c.type==='cancel_basal'){this.manualBasal=null;this.autoBasal=null;this.pending.treatments.push({id,at,eventType:'Temp Basal',absolute:this.config.profile.basalUph,duration:0,source,simulation:true});}
    if(c.type==='extended') {
      if(!this.faults.pumpConnected)throw new Error('Virtual pump unavailable');
      this.extended={id,at,until:until(c.minutes),rate:c.units/c.minutes*60,totalU:c.units,deliveredU:0};
      this.pending.treatments.push({id,at,eventType:'Combo Bolus',insulin:c.units,duration:c.minutes,source,simulation:true,delivery:'scheduled_not_fully_delivered'});
    }
    if(c.type==='cancel_extended'){const old=this.extended;this.extended=null;this.pending.treatments.push({id,at,eventType:'Note',notes:'Extended cancelled; delivered insulin retained',deliveredU:old?.deliveredU??0,source,simulation:true});}
    if(c.type==='loop') {
      if(c.mode==='enable'){this.loopEnabled=true;this.loopSuspendedUntil=0;}
      else if(['disable','stop'].includes(c.mode)){this.loopEnabled=false;this.autoBasal=null;}
      else if(c.mode==='suspend'){this.loopSuspendedUntil=until(c.minutes);this.manualBasal=null;this.autoBasal=null;}
      else {this.loopMode=c.mode;this.autoBasal=null;}
    }
    if(c.type==='temp_target')this.tempTarget=c.preset==='cancel'?null:{preset:c.preset,value:this.config.tempTargets[c.preset],at,until:until(this.config.tempTargets.durationMinutes)};
    if(!['bolus','carbs','temp_basal','cancel_basal','extended','cancel_extended','bg'].includes(c.type))
      this.pending.treatments.push({id,at,eventType:c.type==='temp_target'?'Temporary Target':'Note',source,simulation:true,command:text,target:this.tempTarget});
    return {simulation:true,sessionId:this.sessionId,commandId:id,command:text,appliedAt:new Date(at).toISOString(),
      action:c,status:'applied',...(c.type==='extended'?{scheduledU:c.units,deliveredU:0}:{}),state:this.status()};
  }
  changeConfig(patch) {
    const previous=clone(this.config);this.config=mergeConfig(this.config,patch);this.params.BW=this.config.subject.weightKg;
    this.rebuildModel();if(patch.loopMode)this.loopMode=this.config.loopMode;
    // Only not-yet-generated days use changed lifestyle; consumed meals and drug pools stay intact.
    if(patch.meals||patch.sleep||patch.activity||patch.stress){this.dailyEvents=this.dailyEvents.filter(e=>e.done);this.generatedDays=[];this.ensureDays();
      this.dailyEvents=this.dailyEvents.filter(e=>e.done||e.at>this.now);}
    this.wallAnchor=Date.now();this.wallVirtualAnchor=this.now;
    this.pending.changes.push({kind:'config',before:previous,after:this.config,simulationTime:this.now});
  }
  status() {
    const last=this.recentSamples.at(-1),old=this.recentSamples.at(-2),slope=old?(last.observed-old.observed)/((last.at-old.at)/60000):0;
    const iob=iobAt(this);
    return {simulation:true,simulationError:this.simulationError??null,sessionId:this.sessionId,subject:this.config.subject,virtualTime:new Date(this.now).toISOString(),
      publicationOffsetMs:this.publicationOffset,bg:last?.observed??this.state.G,trueBg:this.state.G,sampleTime:last?new Date(last.at+this.publicationOffset).toISOString():null,
      bg_trend:slope>2?'DoubleUp':slope>1?'SingleUp':slope>.3?'FortyFiveUp':slope<-2?'DoubleDown':slope<-1?'SingleDown':slope<-.3?'FortyFiveDown':'Flat',
      iob:iob.iob,basalIob:iob.basaliob,bolusIob:iob.bolusiob,iobDefinition:'oref0 rapid-acting action curve; signed basal above scheduled baseline; U',
      cob:this.cob(),cobDefinition:'remaining model gut carbohydrate pools; g',loop_mode:this.loopMode,loopEnabled:this.loopEnabled,
      loopSuspendedUntil:this.loopSuspendedUntil>this.now?new Date(this.loopSuspendedUntil).toISOString():null,
      basalUph:this.basalRate(),scheduledBasalUph:this.config.profile.basalUph,tempBasal:this.manualBasal,
      extended:this.extended?.until>this.now?clone(this.extended):null,tempTarget:this.tempTarget?.until>this.now?clone(this.tempTarget):null,
      pump_connected:this.faults.pumpConnected&&this.faults.reservoirU>0&&this.faults.battery>0,battery:this.faults.battery,reservoirU:this.faults.reservoirU,
      sleeping:this.sleeping,activeEvents:clone(this.activeEvents),paused:this.config.paused,speed:this.config.speed,
      model:'Deichmann2023 ETH reference kernel; synthetic inputs; not a clinical prediction',recommendation:this.lastRecommendation};
  }
}
