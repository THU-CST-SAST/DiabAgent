// Device automation only: no guideline caregiver, rescue carbs, calibration or hidden events.
import {makeAutosens,oref1Recommendation} from '../policies/oref1.mjs';
import {cgmLive,tempBasalAction} from '../policies/care.mjs';

export function runOref1Controller(world) {
  const k=world.controller,c=world.config.controller,obs=world.observe();
  if(!(k.mode==='closed'||c.compute_suggestions)||!cgmLive(obs,10))return;
  const state=k.oref1??={lastSample:null,autosens:null};
  if(state.lastSample===obs.cgm.sample_time)return;
  state.lastSample=obs.cgm.sample_time;
  const autosens=makeAutosens({state:state.autosens});
  const target=k.tempTarget?.until>world.now?k.tempTarget.value:null;
  const r=oref1Recommendation(obs,{tempTarget:target,autosens});
  state.autosens=autosens.snapshot();
  if(!r)return;
  const nonfinite=Object.entries(r).some(([key,v])=>typeof v==='number'&&!Number.isFinite(v))||/NaN|Infinity/.test(r.reason??'');
  k.lastRecommendation={at:world.now,algorithm:'oref1',raw:r,nonfinite,receipts:[]};
  if(nonfinite||k.mode!=='closed'||!world.controllerActive()||world.device.stopReason(world.now))return;
  // Explicit user temp basals override automation until they expire or are cancelled.
  if(world.device.temp&&world.device.temp.source!=='loop')return;
  const apply=action=>{
    const receipt=world.apply(action,`loop:oref1:${world.now}:${action.type}`,'loop');
    k.lastRecommendation.receipts.push({action,receipt});
  };
  if(Number.isFinite(r.units)&&r.units>0) {
    const spec=obs.action_specs.BOLUS?.units,previous=world.device.lastBolus;
    if(spec&&(!previous||world.now-previous.at>=world.config.safety.bolus_min_interval_minutes*60000)) {
      const step=spec.step||.05,units=Number((Math.floor(Math.min(r.units,spec.max)/step+1e-9)*step).toFixed(6));
      if(units>0)apply({type:'BOLUS',units});
    }
  }
  if(Number.isFinite(r.rate)&&Number.isFinite(r.duration)&&r.duration>0) {
    const action=tempBasalAction(obs,Math.max(0,Math.min(r.rate,obs.profile.max_basal_u_h)),Math.round(r.duration));
    if(action)apply(action);
  }
}
