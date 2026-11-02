// Insulin delivery device catalog, loaded from knowledge/devices.json.
// A null bolus speed in the data means instantaneous delivery.
import {KNOWLEDGE} from '../knowledge.mjs';

export const PUMPS=Object.fromEntries(Object.entries(KNOWLEDGE.pumps).map(([id,p])=>
  [id,{...p,bolus_speed_u_per_min:p.bolus_speed_u_per_min??Infinity}]));
export const PENS=KNOWLEDGE.pens;
export const PEN_INSULINS=KNOWLEDGE.penInsulins;
export const OCCLUSION_RATE_PER_DAY_REFERENCE=KNOWLEDGE.faults.occlusion_rate_per_day.value;

/** Rounds to a device step; step 0 means continuous. */
export function quantize(value,step,mode='nearest') {
  if(!step)return value;
  const f=mode==='down'?Math.floor:Math.round;
  return Math.round(f(value/step+1e-9)*step*1e6)/1e6;
}
