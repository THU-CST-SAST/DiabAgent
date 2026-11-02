// Action table: which structured actions an instance offers, with parameter ranges derived
// from its delivery device, sensors, safety settings and (optional) built-in controller.
// The same specs drive validation and are published in observations, so an agent sees the
// exact legal action space of the instance it controls.
import {KNOWLEDGE} from '../knowledge.mjs';

/** Durations AAPS offers for "Disconnect pump" (knowledge/devices.json aaps.disconnect_pump_minutes). */
export const SUSPEND_MINUTES=Object.freeze([...(KNOWLEDGE.aaps.disconnect_pump_minutes??[15,30,60,120,180])]);

/** Parameter specs per available action type. Ranges are environment limits; devices may round further. */
export function actionSpecs(world) {
  const c=world.config,s=c.safety,p=c.profile,d=world.device,specs={};
  const n=(min,max,{step=null,exclusive_min=false,integer=false,optional=false,unit=null,note=null}={})=>
    ({min,max,...(step?{step}:{}),...(exclusive_min?{exclusive_min}:{}),...(integer?{integer}:{}),...(optional?{optional}:{}),...(unit?{unit}:{}),...(note?{note}:{})});
  specs.WAIT={};
  specs.INGEST_CARBS={grams:n(0,s.max_rescue_carbs_g,{exclusive_min:true,unit:'g'}),
    absorption_minutes:n(5,240,{optional:true,unit:'min',note:`default ${s.rescue_absorption_minutes}`})};
  if(d.kind==='pump') {
    const sp=d.spec,t=sp.tbr;
    specs.BOLUS={units:n(0,Math.min(s.max_bolus_u,sp.max_bolus_u),{exclusive_min:true,step:sp.bolus_step_u||null,unit:'U',
      note:Number.isFinite(sp.bolus_speed_u_per_min)?`delivered at ${sp.bolus_speed_u_per_min} U/min`:'instantaneous'})};
    // Only pumps that deliver over time and whose AAPS driver can stop a running bolus.
    if(sp.cancel_bolus&&Number.isFinite(sp.bolus_speed_u_per_min))specs.CANCEL_BOLUS={};
    const maxRate=Math.min(p.max_basal_u_h,t.type==='absolute'?t.max:Infinity,sp.max_basal_u_h);
    specs.TEMP_BASAL={
      rate_u_h:n(0,maxRate,{optional:true,step:t.type==='absolute'?t.step||null:null,unit:'U/h',
        note:t.type==='percent'?'converted to the pump percent grid':'give rate_u_h or percent'}),
      percent:n(0,t.type==='percent'?t.max:Math.round(maxRate/d.scheduledBasalUph*100),{optional:true,step:t.type==='percent'?t.step:null,unit:'%',
        note:t.type==='percent'?'native for this pump':'converted to an absolute rate'}),
      duration_minutes:n(1,Math.min(s.max_temp_minutes,t.max_duration_min),{integer:true,step:t.duration_step_min,unit:'min'})};
    specs.CANCEL_TEMP_BASAL={};
    if(sp.extended) {
      specs.EXTENDED_BOLUS={units:n(0,Math.min(s.max_bolus_u,sp.max_bolus_u),{exclusive_min:true,step:sp.extended.step_u||null,unit:'U'}),
        duration_minutes:n(1,sp.extended.max_minutes,{integer:true,step:sp.extended.duration_step_min,unit:'min'})};
      specs.CANCEL_EXTENDED_BOLUS={};
    }
    // AAPS "Disconnect pump" offers fixed durations only.
    specs.SUSPEND_PUMP={minutes:{enum:[...SUSPEND_MINUTES],unit:'min'}};
    specs.RESUME_PUMP={};
    specs.CHANGE_INFUSION_SET={};
  } else {
    specs.BOLUS={units:n(0,Math.min(s.max_bolus_u,d.bolusPenSpec.max_u),{exclusive_min:true,step:d.bolusPenSpec.step_u,unit:'U'})};
    specs.BASAL_INJECTION={units:n(0,d.basalPenSpec.max_u,{exclusive_min:true,step:d.basalPenSpec.step_u,unit:'U'})};
  }
  if(world.meter)specs.MEASURE_BG={};
  if(world.cgm?.modality==='flash')specs.SCAN={};
  if(world.cgm?.calibration&&world.meter)specs.CALIBRATE_CGM={note:'performs a fingerstick and calibrates the sensor'};
  if(c.profile_switch?.enabled)specs.SET_PROFILE=profileSpec(world,n);
  if(c.controller.expose_actions&&d.kind==='pump') {
    specs.SET_LOOP_MODE={mode:{enum:['open','closed','lgs','enable','disable']}};
    specs.SUSPEND_LOOP={minutes:n(1,1440,{integer:true,unit:'min'})};
    specs.SET_TEMP_TARGET={preset:{enum:['meal','activity','hypo','cancel']}};
  }
  return specs;
}

/** Profile fields the agent may reprogram (SET_PROFILE), each within max_change_factor of its current value. */
export const PROFILE_FIELDS=Object.freeze(['basal_u_h','isf_mg_dl_per_u','carb_ratio_g_per_u','target_mg_dl','basal_dose_u']);
function profileSpec(world,n) {
  const c=world.config,p=c.profile,d=world.device,f=c.profile_switch.max_change_factor;
  const lo=v=>Number((Math.ceil(v*1000-1e-6)/1000).toFixed(3)),hi=v=>Number((Math.floor(v*1000+1e-6)/1000).toFixed(3));
  const around=(cur,min,max,o)=>n(lo(Math.max(min,cur/f)),hi(Math.min(max,cur*f)),{optional:true,...o});
  const spec={};
  if(d.kind==='pump') {
    const sp=d.spec,cur=d.scheduledBasalUph;
    spec.basal_u_h=around(cur,Math.max(0,sp.min_basal_u_h??0),Math.min(10,p.max_basal_u_h,sp.max_basal_u_h),
      {step:sp.basal_step_u_h||null,unit:'U/h',note:`scheduled basal; at most profile max basal ${p.max_basal_u_h} U/h`});
  } else {
    const m=c.therapy.mdi;
    spec.basal_dose_u=around(m.basal_dose_u,1,Math.min(200,d.basalPenSpec.max_u*m.basal_times.length*4),
      {step:d.basalPenSpec.step_u,unit:'U',note:`routine long-acting dose per injection at ${m.basal_times.join(', ')}; from the next routine injection`});
  }
  spec.isf_mg_dl_per_u=around(p.isf_mg_dl_per_u,5,300,{unit:'mg/dL per U'});
  spec.carb_ratio_g_per_u=around(p.carb_ratio_g_per_u,1,100,{unit:'g per U'});
  spec.target_mg_dl=n(80,180,{optional:true,unit:'mg/dL'});
  spec.note=`profile switch: give at least one field; each change within x${f} of the current value; changes the programmed settings only`;
  return spec;
}

export function availableActions(world) {return Object.keys(actionSpecs(world));}

/** Throws a descriptive error unless the action is legal for this instance. */
export function validateAction(world,action) {
  if(!action||typeof action!=='object'||Array.isArray(action)||typeof action.type!=='string')throw new Error('Action must be an object with a type');
  const specs=actionSpecs(world),spec=specs[action.type];
  if(!spec) {
    const pens=world.device.kind==='mdi';
    if(pens&&['TEMP_BASAL','CANCEL_TEMP_BASAL','EXTENDED_BOLUS','CANCEL_EXTENDED_BOLUS','CHANGE_INFUSION_SET','SUSPEND_PUMP','RESUME_PUMP','CANCEL_BOLUS'].includes(action.type))
      throw new Error(`${action.type} is not available with pens (MDI)`);
    if(!pens&&action.type==='BASAL_INJECTION')throw new Error(`${action.type} is only available with pens (MDI)`);
    if(['EXTENDED_BOLUS','CANCEL_EXTENDED_BOLUS'].includes(action.type))throw new Error(`${world.device.spec.name} does not support extended bolus via AAPS`);
    if(action.type==='CANCEL_BOLUS')throw new Error(Number.isFinite(world.device.spec.bolus_speed_u_per_min)
      ?`${world.device.spec.name} does not support cancelling a bolus via AAPS`:`${world.device.spec.name} delivers boluses instantly; nothing to cancel`);
    throw new Error(`${action.type} is not available in this instance; available: ${Object.keys(specs).join(', ')}`);
  }
  for(const k of Object.keys(action))if(k!=='type'&&(!(k in spec)||k==='note'))throw new Error(`Unknown action field: ${k}`);
  for(const [k,r] of Object.entries(spec)) {
    if(k==='note')continue;
    const v=action[k];
    if(r.enum){if(!r.enum.includes(v))throw new Error(`${k} must be one of ${r.enum.join(', ')}`);continue;}
    if(v===undefined&&r.optional)continue;
    const lo=r.exclusive_min?'(':'[';
    if(typeof v!=='number'||!Number.isFinite(v)||(r.exclusive_min?v<=r.min:v<r.min)||v>r.max||(r.integer&&!Number.isInteger(v)))
      throw new Error(`${k} must be ${r.integer?'an integer ':''}in ${lo}${r.min}, ${r.max}]`);
  }
  if(action.type==='SET_PROFILE'&&!PROFILE_FIELDS.some(k=>action[k]!==undefined))
    throw new Error(`SET_PROFILE needs at least one of ${Object.keys(spec).filter(k=>k!=='note').join(', ')}`);
  if(action.type==='TEMP_BASAL'&&(action.rate_u_h===undefined)===(action.percent===undefined))
    throw new Error('TEMP_BASAL needs exactly one of rate_u_h or percent');
}
