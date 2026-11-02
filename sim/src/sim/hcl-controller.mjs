import {hclLoop} from '../policies/hcl.mjs';
import {cgmLive} from '../policies/care.mjs';

/** Device-only HCL automation using public CGM/device records and the existing predictive loop. */
export function runHclController(world){
  const k=world.controller,c=world.config.controller,obs=world.observe();
  if(!(k.mode==='closed'||c.compute_suggestions)||!cgmLive(obs,10))return;
  const state=k.hcl??={lastSample:null,loop:null,exercise:[],care:{lastCorrection:null}};
  if(state.lastSample===obs.cgm.sample_time)return;
  state.lastSample=obs.cgm.sample_time;
  for(const event of obs.events??[]){
    if(!['exercise_planned','exercise_started'].includes(event.type))continue;
    const start=Date.parse(event.planned_time??event.time??obs.virtual_time);
    if(Number.isFinite(start)&&!state.exercise.some(e=>e.start===start))state.exercise.push({start,end:start+(event.duration_minutes??60)*60000,kind:event.kind??'aerobic'});
  }
  state.exercise=state.exercise.filter(e=>e.end+3600000>=world.now);
  const previousAuto=state.loop?.lastAutoBolusAt??null,loop=hclLoop(undefined,{state:state.loop});
  const decision=loop.decide(obs,{st:state.care,personPending:false,
    exerciseMode:()=>state.exercise.some(e=>e.kind==='aerobic'&&world.now>=e.start-3600000&&world.now<=e.end+3600000)});
  state.loop=loop.snapshot();
  k.lastRecommendation={at:world.now,algorithm:'hcl',action:decision?.action??null,reason:decision?.rationale??null,receipts:[]};
  if(!decision||k.mode!=='closed'||!world.controllerActive()||world.device.stopReason(world.now)||world.device.temp&&world.device.temp.source!=='loop'){
    if(decision?.action.type==='BOLUS')state.loop.lastAutoBolusAt=previousAuto;return;
  }
  const receipt=world.apply(decision.action,`loop:hcl:${world.now}:${decision.action.type}`,'loop');
  if(decision.action.type==='BOLUS'&&receipt.status!=='applied')state.loop.lastAutoBolusAt=previousAuto;
  k.lastRecommendation.receipts.push({action:decision.action,receipt});
}
