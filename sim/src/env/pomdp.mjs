// Event-driven POMDP over one simulated instance (src/sim/world.mjs). This layer owns only the
// episode protocol: decision grid, idempotent action IDs, step counting, trajectory recording
// and export. Physiology, devices, sensors and scheduling live in World.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {World} from '../sim/world.mjs';
import {MAX_STEP_MINUTES} from '../core/physiology.mjs';
import {PUMPS,PENS} from '../core/devices.mjs';
import {INSULINS} from '../core/insulins.mjs';
import {CGMS} from '../core/cgm.mjs';
import {METERS} from '../core/meter.mjs';
import {KNOWLEDGE_SHA256} from '../knowledge.mjs';

export const VERSION='sweet-sim-pomdp/0.4.0';
const KERNEL_FILE=new URL('../../model/Deichmann2023.ts',import.meta.url);
const KERNEL_SHA256=createHash('sha256').update(fs.readFileSync(KERNEL_FILE)).digest('hex');
const clone=x=>structuredClone(x);

export class SimEnv {
  constructor(input={}) {
    this.world=new World(input);
    this.end=this.world.start+this.config.horizon_minutes*60000;
    this.transitions=[];this.evaluator=[];this.cache={};
    this.initialObservation=this.world.observe();this.recordEvaluator();
  }

  snapshot() {const {world,...rest}=this;return clone({...rest,world:world.snapshot()});}
  static restore(s) {
    const env=Object.assign(Object.create(SimEnv.prototype),clone(s));
    env.world=World.restore(s.world);return env;
  }

  // Read-through accessors kept for callers and tests that inspect the simulated instance.
  get config() {return this.world.config;}
  get start() {return this.world.start;}
  get now() {return this.world.now;}
  get physiology() {return this.world.physiology;}
  get device() {return this.world.device;}
  get cgm() {return this.world.cgm;}
  get metrics() {return this.world.metrics;}
  /** Scheduled events within the horizon (evaluator-only: includes hidden events). */
  get events() {return this.world.events.filter(e=>e.at<this.end);}
  get terminated() {return this.world.terminated;}
  get error() {return this.world.error;}
  get step_count() {return this.transitions.length;}
  done() {return this.world.terminated||this.world.now>=this.end;}
  observe() {return this.world.observe();}
  apply(action,id) {return this.world.apply(action,id);}

  /**
   * One decision: apply the action now, then advance to the earliest of the next decision
   * tick, the next visible event, a sensor change, a device alarm, or the horizon. Rejected
   * actions still advance time, so an agent cannot stall the clock by retrying.
   */
  step({action_id,expected_step,action,rationale=''}) {
    if(typeof action_id!=='string'||!action_id||action_id.length>128)throw new Error('action_id required (max 128 chars)');
    if(typeof rationale!=='string'||rationale.length>4000)throw new Error('rationale must be text (max 4000 chars)');
    const fingerprint=JSON.stringify({expected_step,action,rationale});
    const cached=this.cache[action_id];
    if(cached) {
      if(cached.fingerprint!==fingerprint)throw new Error('action_id reused with different request');
      return clone(cached.response);
    }
    if(expected_step!==this.transitions.length)throw new Error('Stale expected_step');
    if(this.done())throw new Error('Episode finished');

    const w=this.world,t0=w.now,reward0=w.metrics.reward;
    w.notices=[];
    const receipt=w.apply(action,action_id);
    const grid=this.config.decision_interval_minutes*60000;
    const nextTick=(Math.floor(w.now/grid)+1)*grid;
    const sensorChange=w.cgm&&w.cgm.nextExpiry()>w.now?w.cgm.nextExpiry():Infinity;
    w.advanceTo(Math.min(nextTick,this.end,w.nextVisibleEventAt(),sensorChange));
    w.sampleIfDue();

    const truncated=!w.terminated&&w.now>=this.end;
    const response={observation:w.observe(),reward:w.metrics.reward-reward0,terminated:w.terminated,truncated,
      info:{step:this.transitions.length+1,elapsed_minutes:(w.now-t0)/60000,
        stop_reason:w.terminated?'model_error':truncated?'horizon':w.notices.length?'event':'scheduled',
        action_result:receipt,next_tick:w.iso((Math.floor(w.now/grid)+1)*grid),error:w.error}};
    this.transitions.push({step:this.transitions.length,action_id,action:clone(action),rationale,
      reward:response.reward,next_observation:clone(response.observation),info:clone(response.info),terminated:response.terminated,truncated});
    this.recordEvaluator();
    this.cache[action_id]={fingerprint,response:clone(response)};
    return response;
  }

  recordEvaluator() {this.evaluator.push(this.world.evaluatorState());}

  summary() {
    return {...this.world.summary(),steps:this.transitions.length,completed_horizon:!this.world.terminated&&this.world.now>=this.end};
  }

  manifest() {
    const c=this.config,t=c.therapy,mdi=this.world.mdi,pick=(o,keys)=>Object.fromEntries(keys.filter(k=>k in o).map(k=>[k,o[k]]));
    const insulinInfo=name=>({id:name,...pick(INSULINS[name],['name','class','pk','depot','iob','fit','evidence'])});
    return {environment_version:VERSION,simulation:true,config:clone(c),knowledge_sha256:KNOWLEDGE_SHA256,
      model:{name:'Deichmann2023 (ETH t1d-exercise-model translation)',kernel_sha256:KERNEL_SHA256,max_integration_step_minutes:MAX_STEP_MINUTES},
      insulins:{rapid:insulinInfo(this.world.rapidInsulin),long_acting:mdi?insulinInfo(t.mdi.basal_insulin):null,
        potency:'plasma insulin treated as equally potent across products'},
      device:mdi?{type:'mdi',bolus_pen:PENS[t.mdi.bolus_pen],basal_pen:PENS[t.mdi.basal_pen]}:{type:'pump',id:t.pump.model,...PUMPS[t.pump.model]},
      cgm:c.cgm.model?{id:c.cgm.model,...pick(CGMS[c.cgm.model],['name','kind','label','interval_min','range','wear_days','warmup_min','spread','calibration','evidence']),gaps:c.cgm.gaps}:null,
      meter:c.meter.model?{id:c.meter.model,...METERS[c.meter.model],routine_times:c.meter.routine_times}:null,
      faults:c.faults,
      trajectory_sha256:createHash('sha256').update(JSON.stringify(this.transitions)).digest('hex')};
  }

  exportBundle() {
    return {manifest:this.manifest(),initial_observation:this.initialObservation,trajectory:this.transitions,
      metrics:this.summary(),evaluator_only:{events:this.world.events.filter(e=>e.at<this.end),states:this.evaluator}};
  }
}
