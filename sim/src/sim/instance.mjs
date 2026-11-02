// Instance specs: a compact description of one simulated person with their devices and life
// events, resolved into a full World config. Specs come from presets (knowledge/instances.json),
// population generators (src/population) or trace2sim reconstructions.
//
// {
//   seed, start_time?, horizon_minutes?,
//   person:   {type, bmi, dawn, carb_counting, sample, seed?} | null (reference patient; seed: person
//             draw, default = the instance seed),
//   therapy:  {mode:'pump', pump:{model, insulin}} | {mode:'mdi', mdi:{bolus_pen, bolus_insulin, basal_pen, basal_insulin}},
//   sensors:  {cgm: model|null, meter: model|null},
//   events:   [event pack ids],          see EVENT_PACKS
//   controller: {mode}, self_care: 'none' (全权, default) | 'assisted' (辅助) | {mode, ...},
//   overrides: {...any config fields}
// }
import {normalizeConfig} from '../core/config.mjs';
import {PUMPS,PENS,PEN_INSULINS} from '../core/devices.mjs';
import {INSULINS,PUMP_INSULINS} from '../core/insulins.mjs';
import {CGMS} from '../core/cgm.mjs';
import {METERS} from '../core/meter.mjs';

/** Named bundles of scenario switches; applicability depends on the instance. */
export const EVENT_PACKS={
  baseline:{scenario:{}},
  high_fat_meals:{meals_high_fat_probability:0.3},
  anaerobic_exercise:{scenario:{anaerobic:{enabled:true,probability:0.5}}},
  alcohol:{scenario:{alcohol:{enabled:true,probability:0.5}}},
  illness:{scenario:{illness:{enabled:true,probability_per_day:0.5}}},
  sleep_loss:{scenario:{sleep_loss:{enabled:true,probability:0.5}}},
  menstrual:{scenario:{menstrual:{enabled:true}},requires:spec=>spec.sex==='female'&&spec.age_years>=12&&spec.age_years<=52},
  stress:{scenario:{stress:{enabled:true,probability:0.5}}},
  occlusion_faults:{faults:{occlusion_rate_per_day:0.25},requires:(_,t)=>t.mode==='pump'},
  unannounced_meals:{scenario:{announcement:{probability:0.8}}},
};

const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function deepMerge(a,b) {
  if(!isObject(a)||!isObject(b))return structuredClone(b);
  const out={...a};
  for(const [k,v] of Object.entries(b))out[k]=k in a&&isObject(a[k])&&isObject(v)&&k!=='meals'?deepMerge(a[k],v):structuredClone(v);
  return out;
}
const minus=(hhmm,min)=>{const m=(Number(hhmm.slice(0,2))*60+Number(hhmm.slice(3))-min+1440)%1440;return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;};

/** Throws if devices, insulins and sensors cannot be combined. */
export function checkCompatibility(spec) {
  const t=spec.therapy??{mode:'pump'},s=spec.sensors??{};
  if(t.mode==='pump') {
    const p=t.pump??{};
    if(p.model&&!PUMPS[p.model])throw new Error(`Unknown pump ${p.model}`);
    if(p.insulin&&!PUMP_INSULINS.includes(p.insulin))throw new Error(`${p.insulin} cannot be used in a pump (allowed: ${PUMP_INSULINS.join(', ')})`);
  } else if(t.mode==='mdi') {
    const m=t.mdi??{};
    for(const [pen,ins] of [[m.bolus_pen,m.bolus_insulin],[m.basal_pen,m.basal_insulin]]) {
      if(!pen||!ins)continue;
      if(!PENS[pen])throw new Error(`Unknown pen ${pen}`);
      if(!PEN_INSULINS[pen]?.includes(ins))throw new Error(`${PENS[pen].name} does not deliver ${ins} (delivers ${PEN_INSULINS[pen].join(', ')})`);
    }
    if(m.basal_insulin&&INSULINS[m.basal_insulin]?.class!=='long')throw new Error(`${m.basal_insulin} is not a long-acting insulin`);
  } else throw new Error(`Unknown therapy mode ${t.mode}`);
  if(s.cgm!==undefined&&s.cgm!==null&&!CGMS[s.cgm])throw new Error(`Unknown sensor ${s.cgm}`);
  if(s.meter!==undefined&&s.meter!==null&&!METERS[s.meter])throw new Error(`Unknown meter ${s.meter}`);
  if(s.cgm===null&&!s.meter)throw new Error('An instance needs a CGM or a meter');
  if(s.cgm&&CGMS[s.cgm].calibration?.required&&!s.meter)throw new Error(`${s.cgm} needs a meter for calibration`);
}

/** Resolves an instance spec to a validated World config. */
export function buildInstanceConfig(spec) {
  checkCompatibility(spec);
  const base={seed:spec.seed??0};
  if(spec.start_time)base.start_time=spec.start_time;
  if(spec.horizon_minutes)base.horizon_minutes=spec.horizon_minutes;
  if(spec.person)base.person=spec.person;
  if(spec.therapy)base.therapy=spec.therapy;
  if(spec.controller)base.controller=spec.controller;
  if(spec.self_care)base.self_care=typeof spec.self_care==='string'?{mode:spec.self_care}:spec.self_care;
  const sensors=spec.sensors??{};
  if('cgm' in sensors)base.cgm={model:sensors.cgm};
  if('meter' in sensors)base.meter={model:sensors.meter};

  // Resolve the person first so routines can follow their meal plan.
  let cfg=normalizeConfig(base);
  const packs=spec.events??['baseline'],layer={};
  for(const id of packs) {
    const pack=EVENT_PACKS[id];if(!pack)throw new Error(`Unknown event pack ${id}`);
    if(pack.requires&&!pack.requires(cfg.patient,cfg.therapy))throw new Error(`Event pack ${id} does not apply to this instance`);
    if(pack.scenario)Object.assign(layer,deepMerge(layer,{scenario:pack.scenario}));
    if(pack.faults)Object.assign(layer,deepMerge(layer,{faults:pack.faults}));
    if(pack.meals_high_fat_probability)layer.scenario=deepMerge(layer.scenario??{},{meals:Object.fromEntries(Object.entries(cfg.scenario.meals)
      .map(([k,m])=>[k,{...m,high_fat_probability:k==='snack'?0:pack.meals_high_fat_probability}]))});
  }
  // Patient measurement habits that follow from the sensors.
  if(cfg.meter.model&&!cfg.meter.routine_times.length) {
    const mealTimes=Object.values(cfg.scenario.meals).filter(m=>(m.probability??1)>=0.9).map(m=>minus(m.time,15));
    const routine=!cfg.cgm.model?[...mealTimes,'22:00']                       // fingerstick-only: pre-meal and bedtime
      :CGMS[cfg.cgm.model].calibration?.required?['07:00','19:00']             // twice-daily calibration checks
      :[];                                                                      // CGM users keep the meter as backup
    layer.meter={routine_times:[...new Set(routine)].sort()};
  }
  const merged=deepMerge(deepMerge(base,layer),spec.overrides??{});
  cfg=normalizeConfig(merged);
  return cfg;
}
