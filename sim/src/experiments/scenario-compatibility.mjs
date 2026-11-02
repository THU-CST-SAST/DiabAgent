import {PUMPS} from '../core/devices.mjs';
import {CGMS} from '../core/cgm.mjs';

/** Structural exclusions only; never consult a trajectory, score or model response. */
export function scenarioCompatibility(spec,cfg,{requiresCalibration=false}={}) {
  const events=cfg.scenario.extra_events,history=cfg.initial_state.history,reasons=[];
  const pump=cfg.therapy.mode==='pump',device=pump?PUMPS[cfg.therapy.pump.model]:null;
  if(cfg.patient.age_years<18&&events.some(e=>e.type==='alcohol'))reasons.push('minor-alcohol');
  if(!pump&&events.some(e=>['infusion_deficit','infusion_recovery'].includes(e.type)))reasons.push('infusion-requires-pump');
  const extended=history.some(e=>e.type==='extended_bolus')||events.some(e=>e.type==='patient_treatment'
    &&['EXTENDED_BOLUS','CANCEL_EXTENDED_BOLUS'].includes(e.action?.type));
  if(extended&&!device?.extended)reasons.push('extended-bolus-unsupported');
  if((requiresCalibration||events.some(e=>e.type==='sensor_calibration_error'))&&!CGMS[cfg.cgm.model]?.calibration?.required)
    reasons.push('calibration-required');
  return reasons;
}
