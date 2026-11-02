import {equilibriumBasalUph} from './physiology.mjs';
import {INSULINS,PUMP_INSULINS,BOLUS_PEN_INSULINS,BASAL_PEN_INSULINS} from './insulins.mjs';
import {PUMPS,PENS} from './devices.mjs';
import {CGMS,DEFAULT_GAPS} from './cgm.mjs';
import {METERS} from './meter.mjs';
import {personLayer,PERSONS} from './person.mjs';

const meal=(time,carbs_g,carbs_jitter_g,time_jitter_minutes,absorption_minutes)=>
  ({time,carbs_g,carbs_jitter_g,time_jitter_minutes,absorption_minutes});

// Lifestyle defaults follow upstream sweet-sim's DEFAULT_CONFIG.
export const DEFAULT_CONFIG=Object.freeze({
  seed:20261013,
  start_time:'2026-10-13T16:00:00.000Z',   // 00:00 local at UTC+8
  utc_offset_minutes:480,
  horizon_minutes:1440,
  decision_interval_minutes:5,
  // Descriptive subject fields plus the kernel's body weight and starting glucose.
  patient:{sex:'male',age_years:39,height_cm:170,weight_kg:66,initial_glucose_mg_dl:120},
  // Person type (knowledge/persons.json). type null = the kernel's reference patient. When set, the
  // type fills patient, profile, physiology, meal plan, carb counting and safety defaults; any
  // field given explicitly in the config still wins. sample draws from the type's distributions,
  // seeded by person.seed (null = the config seed). A separate person seed keeps the same
  // individual while the episode seed (events, noise) changes, e.g. across bench repeats.
  person:{type:null,bmi:'normal',dawn:'absent',carb_counting:'typical',sample:false,seed:null,resolved:null},
  // Individual physiology on the kernel: insulin sensitivity relative to the reference patient,
  // optional overrides of glucose effectiveness (p1), basal glucose (Gb) and carb bioavailability
  // (AG), meal absorption speed, dawn phenomenon and day-to-day sensitivity variation.
  physiology:{sensitivity:1,glucose_effectiveness:null,basal_glucose:null,carb_bioavailability:null,
    meal_absorption_scale:1,dawn_fraction:0,daily_sensitivity_cv:0},
  // basal_u_h null = the model's equilibrium basal for this weight; dia_hours null = the
  // insulin's AAPS minimum DIA.
  profile:{basal_u_h:null,isf_mg_dl_per_u:50,carb_ratio_g_per_u:10,target_mg_dl:120,dia_hours:null,max_basal_u_h:3},
  // mode 'pump': one rapid insulin via a pump. mode 'mdi': rapid pen + long-acting pen;
  // basal_dose_u null = equilibrium basal x 24 h split across basal_times.
  therapy:{
    mode:'pump',
    // refill_every_days: the person's routine reservoir refill + infusion-set change every N days at
    // refill_time (local); null = never (a long episode then runs the reservoir dry).
    pump:{model:'dana_i',insulin:'aspart',reservoir_u:null,refill_every_days:null,refill_time:'20:00'},
    // missed_doses_before_start: the person forgot their last N routine long-acting doses before the
    // start (not in the preload; the pen log shows the earlier one). extra_doses_before_start: extra
    // long-acting injections before the start [{minutes_before, units}] (double or mistimed dose; the
    // latest one is the pen log's last injection). Both default off.
    mdi:{bolus_pen:'novopen_echo',bolus_insulin:'aspart',basal_pen:'tresiba_flextouch',basal_insulin:'degludec',
      basal_dose_u:null,basal_times:['22:00'],auto_basal_injection:true,missed_doses_before_start:0,extra_doses_before_start:[]},
  },
  // Interstitial sensor: real-time CGM, fingerstick-calibrated CGM or flash (scan to read); null = none.
  // noise_mg_dl only applies to legacy_uniform. Flash sensors are read on SCAN and by the
  // patient's own scans every scan_interval_minutes within scan_window (local time).
  // Default-off scenario controls (OpenDiabet task generator): error_draw 'median' uses the median
  // calibration error of the sensor type instead of a draw (noise stays random);
  // sensor_age_days_at_start fixes how long the current sensor has been worn (null = random);
  // forced_gaps are signal losses [{at_minute, duration_minutes}] from the episode start;
  // calibration_overdue_at_start starts a calibrated CGM with its calibration overdue.
  // compression_lows (OpenDiabet v1.1-hard, default off): sensor compression artefacts
  // [{at_minute, duration_minutes, depth_mg_dl}] from the episode start: readings drop by up to
  // depth (5-min ramps at both ends) while true glucose is unchanged.
  // error_scale (Experiment 1b, default 1): multiplies every sensor error term (calibration gain
  // error and drift, offset, AR noise, uniform amplitude, interstitial lag); 0 = readings equal true
  // plasma glucose. Gaps are not scaled. Same random draws for every value (src/core/cgm.mjs).
  cgm:{model:'dexcom_g6',noise_mg_dl:1.5,gaps:{...DEFAULT_GAPS},scan_interval_minutes:90,scan_window:['07:00','23:00'],
    error_draw:'sampled',sensor_age_days_at_start:null,forced_gaps:[],calibration_overdue_at_start:false,compression_lows:[],error_scale:1},
  // Fingerstick meter; routine_times are the patient's own checks (local HH:MM), visible as events.
  meter:{model:null,routine_times:[]},
  // Hidden infusion-set occlusions: random rate and/or explicit onsets (pump mode only).
  faults:{occlusion_rate_per_day:0,occlusions:[]},
  estimates:{cob_absorption_minutes:180},
  scenario:{
    meals:{breakfast:meal('08:00',50,10,20,40),lunch:meal('12:30',70,15,30,55),dinner:meal('19:00',60,15,30,65)},
    // Reported carbs: uniform +-carb_error_fraction, or model 'normal' with bias and sd (fractions).
    // A meal may set announce_probability (overrides probability for that meal). report_composition:
    // the person also says when an announced meal is high in fat/protein (meal_composition_reported).
    // report_delay (v1.1-hard, default off): with `probability` an announced meal is reported
    // min..max minutes after the person starts eating (meal_announced then carries eaten_at).
    announcement:{probability:1,carb_error_fraction:.2,model:'uniform',bias:0,sd:0,report_composition:false,information_mode:'native',
      report_delay:{probability:0,min_minutes:15,max_minutes:45}},
    // Partial observability (v1.1-hard, default off): per event type, the probability that the
    // visible notice is withheld (the event itself still happens). meal_announcement: the meal is
    // not reported at all; exercise: neither the plan nor the start notice; alcohol / illness /
    // sleep_loss: the report; composition: the high-fat remark; basal_injection_notice: the
    // routine long-acting notice (the pen log still records it); device_alarms: the pump
    // occlusion alarm notice (the pump still stops; its status shows it). One random stream per
    // event id, so masking never shifts any other draw.
    masking:{meal_announcement:0,exercise:0,alcohol:0,illness:0,sleep_loss:0,composition:0,basal_injection_notice:0,device_alarms:0},
    // advance_notice_minutes > 0: announced exercise is also announced as planned that long before it starts.
    activity:{enabled:true,probability:.35,time:'16:00',time_jitter_minutes:60,duration_minutes:30,accelerometer_counts:2095,announced:true,advance_notice_minutes:0},
    stress:{enabled:false,probability:.15,time:'10:00',time_jitter_minutes:90,duration_minutes:45,hepatic_delta_mg_dl_per_min:.05},
    // Optional life events; each uses its own random stream, so enabling one never shifts others.
    anaerobic:{enabled:false,probability:.15,time:'18:00',time_jitter_minutes:60,duration_minutes:30,hepatic_delta_mg_dl_per_min:.5,announced:true,advance_notice_minutes:0},
    alcohol:{enabled:false,probability:.1,time:'21:00',time_jitter_minutes:60,onset_hours:6,duration_hours:10,hepatic_delta_mg_dl_per_min:-.3,announced:true},
    illness:{enabled:false,probability_per_day:.01,min_days:2,max_days:5,insulin_need_increase:.3,announced:true},
    // cycle_day_at_start: fixed cycle day at the episode start (null = drawn from the seed).
    menstrual:{enabled:false,cycle_days:28,luteal_need_increase:.08,cycle_day_at_start:null},
    sleep_loss:{enabled:false,probability:.1,sensitivity_decrease:.15,announced:true},
    extra_events:[],
  },
  safety:{max_bolus_u:10,bolus_min_interval_minutes:15,block_bolus_below_mg_dl:70,max_rescue_carbs_g:50,
    rescue_absorption_minutes:20,max_temp_minutes:720},
  alarms:{low_mg_dl:70,urgent_low_mg_dl:54,high_mg_dl:250},
  // Optional AAPS-like loop running inside the simulated phone. 'open' leaves dosing to the agent;
  // expose_actions adds loop/temp-target actions; compute_suggestions runs oref0 even in open mode.
  controller:{mode:'open',enabled:true,expose_actions:false,compute_suggestions:false,
    temp_targets:{meal:100,activity:150,hypo:140,duration_minutes:60}},
  // How much the simulated person manages themselves. 'none' (全权): the agent makes every treatment
  // decision. 'assisted' (辅助): the person boluses for the meals they announce with their own bolus
  // calculator (reported carbs / profile CR, plus a correction above a threshold minus IOB), sometimes
  // late or not at all, and treats lows they can see; the agent acts on top of that.
  // meal_bolus.forced_miss (v1.1-hard, default []): meal names the person forgets to bolus for.
  self_care:{mode:'none',
    meal_bolus:{miss_probability:.05,max_delay_minutes:15,correction_above_mg_dl:180,correction_fraction:1,forced_miss:[]},
    low_treatment:{threshold_mg_dl:70,grams:15,recheck_minutes:15}},
  // Agent-side profile switch (Experiment 3): when enabled, the SET_PROFILE action can reprogram the
  // profile (basal, ISF, carb ratio, target; long-acting dose on pens) within max_change_factor of the
  // current value per change. Only the programmed settings change, never the person's physiology.
  profile_switch:{enabled:false,max_change_factor:2},
  // Pre-episode history (default off): history_minutes > 0 simulates that long before the start with
  // no lifestyle events, starting from patient.initial_glucose_mg_dl, and applies the scripted
  // `history` entries [{type, minutes_before, ...}] (bolus {units}, meal {grams, announced_grams|null,
  // absorption_minutes}, carbs {grams}, suspend_pump {minutes}, long_acting {units}). The episode then
  // starts from that state: insulin on board and reported carbs in the device/app history, recent
  // CGM readings, a pump left suspended. Nothing of it is scored.
  initial_state:{history_minutes:0,history:[]},
  // Records only: these controls never modify physiology, measurements or delivered actions.
  information:{mode:'native',rules:[],policy:'records-v1',own_records:false},
});
export const INITIAL_STATE_TYPES=Object.freeze({bolus:['units'],meal:['grams','announced_grams','absorption_minutes'],carbs:['grams'],
  suspend_pump:['minutes'],long_acting:['units'],extended_bolus:['units','duration_minutes'],occlusion:[],calibrate_cgm:[]});

// [min, max] for every numeric leaf; paths use '*' for map entries.
const RANGES={
  seed:[0,4294967295],utc_offset_minutes:[-720,840],horizon_minutes:[5,40320],decision_interval_minutes:[5,5],
  'patient.weight_kg':[10,250],'patient.age_years':[1,120],'patient.height_cm':[50,230],
  'physiology.sensitivity':[0.05,20],'physiology.glucose_effectiveness':[0.0005,0.1],'physiology.basal_glucose':[60,250],
  'physiology.carb_bioavailability':[0.3,1.2],'physiology.meal_absorption_scale':[0.3,3],'physiology.dawn_fraction':[0,1.5],
  'physiology.daily_sensitivity_cv':[0,0.5],
  'scenario.meals.*.probability':[0,1],'scenario.meals.*.high_fat_probability':[0,1],
  'scenario.announcement.bias':[-0.9,0.9],'scenario.announcement.sd':[0,1.5],
  'scenario.anaerobic.probability':[0,1],'scenario.anaerobic.time_jitter_minutes':[0,180],'scenario.anaerobic.duration_minutes':[5,180],
  'scenario.anaerobic.hepatic_delta_mg_dl_per_min':[0,2],
  'scenario.alcohol.probability':[0,1],'scenario.alcohol.time_jitter_minutes':[0,180],'scenario.alcohol.onset_hours':[0,24],
  'scenario.alcohol.duration_hours':[1,24],'scenario.alcohol.hepatic_delta_mg_dl_per_min':[-2,0],
  'scenario.illness.probability_per_day':[0,1],'scenario.illness.min_days':[1,30],'scenario.illness.max_days':[1,30],
  'scenario.illness.insulin_need_increase':[0,3],
  'scenario.menstrual.cycle_days':[21,40],'scenario.menstrual.luteal_need_increase':[0,0.5],
  'scenario.sleep_loss.probability':[0,1],'scenario.sleep_loss.sensitivity_decrease':[0,0.6],'patient.initial_glucose_mg_dl':[40,400],
  'profile.basal_u_h':[0,10],'profile.isf_mg_dl_per_u':[5,300],'profile.carb_ratio_g_per_u':[1,100],
  'profile.target_mg_dl':[80,180],'profile.dia_hours':[3,12],'profile.max_basal_u_h':[0,12],
  'therapy.pump.reservoir_u':[0,1000],'therapy.pump.refill_every_days':[1,14],'cgm.scan_interval_minutes':[15,720],'therapy.mdi.basal_dose_u':[1,200],'cgm.noise_mg_dl':[0,30],'cgm.error_scale':[0,5],
  'cgm.gaps.start_probability_per_sample':[0,0.2],'cgm.gaps.mean_length_samples':[1,100],'faults.occlusion_rate_per_day':[0,1],
  'estimates.cob_absorption_minutes':[30,480],'profile_switch.max_change_factor':[1.05,4],
  'scenario.meals.*.carbs_g':[1,200],'scenario.meals.*.carbs_jitter_g':[0,80],
  'scenario.meals.*.time_jitter_minutes':[0,120],'scenario.meals.*.absorption_minutes':[5,240],
  'scenario.announcement.probability':[0,1],'scenario.announcement.carb_error_fraction':[0,.9],
  'scenario.activity.probability':[0,1],'scenario.activity.time_jitter_minutes':[0,180],
  'scenario.activity.duration_minutes':[5,240],'scenario.activity.accelerometer_counts':[0,6539],
  'scenario.stress.probability':[0,1],'scenario.stress.time_jitter_minutes':[0,180],
  'scenario.stress.duration_minutes':[5,480],'scenario.stress.hepatic_delta_mg_dl_per_min':[0,.5],
  'safety.max_bolus_u':[0,25],'safety.bolus_min_interval_minutes':[0,240],'safety.block_bolus_below_mg_dl':[0,150],
  'safety.max_rescue_carbs_g':[0,100],'safety.rescue_absorption_minutes':[5,120],'safety.max_temp_minutes':[5,1440],
  'self_care.meal_bolus.miss_probability':[0,1],'self_care.meal_bolus.max_delay_minutes':[0,60],
  'self_care.meal_bolus.correction_above_mg_dl':[120,400],'self_care.meal_bolus.correction_fraction':[0,1],
  'self_care.low_treatment.threshold_mg_dl':[54,100],'self_care.low_treatment.grams':[5,50],'self_care.low_treatment.recheck_minutes':[10,60],
  'alarms.low_mg_dl':[40,100],'controller.temp_targets.meal':[80,180],'controller.temp_targets.activity':[80,200],
  'controller.temp_targets.hypo':[80,200],'controller.temp_targets.duration_minutes':[5,240],'alarms.urgent_low_mg_dl':[40,80],'alarms.high_mg_dl':[150,400],
  'scenario.meals.*.announce_probability':[0,1],'scenario.activity.advance_notice_minutes':[0,720],'scenario.anaerobic.advance_notice_minutes':[0,720],
  'scenario.menstrual.cycle_day_at_start':[0,40],'cgm.sensor_age_days_at_start':[0,30],'therapy.mdi.missed_doses_before_start':[0,4],
  'initial_state.history_minutes':[0,720],
  'scenario.announcement.report_delay.probability':[0,1],'scenario.announcement.report_delay.min_minutes':[0,180],
  'scenario.announcement.report_delay.max_minutes':[0,180],
  ...Object.fromEntries(['meal_announcement','exercise','alcohol','illness','sleep_loss','composition','basal_injection_notice','device_alarms']
    .map(k=>[`scenario.masking.${k}`,[0,1]])),
};
const INTEGERS=new Set(['seed','therapy.pump.refill_every_days','utc_offset_minutes','horizon_minutes','scenario.meals.*.time_jitter_minutes','patient.age_years',
  'scenario.illness.min_days','scenario.illness.max_days','scenario.menstrual.cycle_days',
  'scenario.activity.time_jitter_minutes','scenario.activity.duration_minutes','scenario.stress.time_jitter_minutes',
  'scenario.stress.duration_minutes','therapy.mdi.missed_doses_before_start','initial_state.history_minutes',
  'scenario.announcement.report_delay.min_minutes','scenario.announcement.report_delay.max_minutes']);
const NULLABLE=new Set(['profile.basal_u_h','profile.dia_hours','therapy.pump.reservoir_u','therapy.pump.refill_every_days','therapy.mdi.basal_dose_u',
  'physiology.glucose_effectiveness','physiology.basal_glucose','physiology.carb_bioavailability',
  'scenario.menstrual.cycle_day_at_start','cgm.sensor_age_days_at_start']);
const HHMM=/^([01]\d|2[0-3]):[0-5]\d$/;
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);

// Opt-in fields without a default: absent from normalized configs unless set, so existing world hashes stay unchanged.
//   therapy.mdi.dose_memory (boolean): smart-pen dose memory; routine and pre-episode long-acting doses remain
//   visible as device records under I1/I2 record masks (a pump's running basal is always visible).
const OPTIONAL_FIELDS=new Set(['therapy.mdi.dose_memory','therapy.mdi.max_daily_injections']);
function merge(defaults,input,path) {
  if(!isObject(input))throw new Error(`${path||'config'} must be an object`);
  const out={};
  for(const k of Object.keys(input))if(!(k in defaults)&&!OPTIONAL_FIELDS.has(path+k))throw new Error(`Unknown config field: ${path}${k}`);
  for(const k of Object.keys(input))if(OPTIONAL_FIELDS.has(path+k)&&!(k in defaults))out[k]=structuredClone(input[k]);
  for(const [k,d] of Object.entries(defaults)) {
    const v=input[k];
    // Meal maps are replaced wholesale so a scenario can drop meals.
    out[k]=v===undefined?structuredClone(d):isObject(d)&&k!=='meals'?merge(d,v,`${path}${k}.`):structuredClone(v);
  }
  return out;
}

function check(value,path) {
  const key=path.replace(/^scenario\.meals\.[^.]+\./,'scenario.meals.*.');
  if(typeof value==='number'||key in RANGES) {
    if(value===null&&NULLABLE.has(key))return;
    const [lo,hi]=RANGES[key]??[];
    if(typeof value!=='number'||!Number.isFinite(value)||value<lo||value>hi)throw new Error(`${path} must be a number in [${lo}, ${hi}]`);
    if(INTEGERS.has(key)&&!Number.isInteger(value))throw new Error(`${path} must be an integer`);
  } else if(isObject(value))for(const [k,v] of Object.entries(value))check(v,`${path}.${k}`);
}

export function normalizeConfig(input={}) {
  if(!isObject(input))throw new Error('config must be an object');
  const spec={...DEFAULT_CONFIG.person,...(isObject(input.person)?input.person:{})};
  if(spec.anthropometry!==undefined&&spec.type===null)throw new Error('person.anthropometry requires a person.type');
  const defaults=spec.anthropometry===undefined?DEFAULT_CONFIG
    :{...DEFAULT_CONFIG,person:{...DEFAULT_CONFIG.person,anthropometry:null}};
  let c,resolved=null;
  if(spec.type!==null) {
    if(!PERSONS[spec.type])throw new Error(`person.type must be null or one of ${Object.keys(PERSONS).join(', ')}`);
    const p=personLayer(spec,spec.seed??input.seed??DEFAULT_CONFIG.seed);resolved=p.resolved;
    c=merge(merge(defaults,p.layer,''),input,'');
  } else c=merge(defaults,input,'');
  c.person.resolved=resolved;
  for(const k of ['patient','profile','physiology','therapy','cgm','meter','faults','estimates','scenario','safety','alarms','controller','self_care','profile_switch','initial_state'])check(c[k],k);
  const enumOf=(v,list,where)=>{if(!list.includes(v))throw new Error(`${where} must be one of ${list.join(', ')}`);};
  enumOf(c.patient.sex,['male','female'],'patient.sex');
  enumOf(c.person.bmi,['normal','overweight','obese'],'person.bmi');
  enumOf(c.person.dawn,['absent','present','random'],'person.dawn');
  enumOf(c.person.carb_counting,['typical','accurate','poor'],'person.carb_counting');
  if(typeof c.person.sample!=='boolean')throw new Error('person.sample must be boolean');
  if(c.person.seed!==null&&!(Number.isInteger(c.person.seed)&&c.person.seed>=0&&c.person.seed<=4294967295))
    throw new Error('person.seed must be null or an integer in [0, 4294967295]');
  enumOf(c.scenario.announcement.model,['uniform','normal'],'scenario.announcement.model');
  for(const k of ['anaerobic','alcohol'])if(!HHMM.test(c.scenario[k].time))throw new Error(`scenario.${k}.time must be HH:MM`);
  for(const k of ['anaerobic','alcohol','illness','menstrual','sleep_loss'])if(typeof c.scenario[k].enabled!=='boolean')throw new Error(`scenario.${k}.enabled must be boolean`);
  if(c.scenario.illness.min_days>c.scenario.illness.max_days)throw new Error('scenario.illness.min_days must be <= max_days');
  if(!['open','closed','lgs'].includes(c.controller.mode))throw new Error('controller.mode must be open, closed or lgs');
  if(!['none','assisted'].includes(c.self_care.mode))throw new Error('self_care.mode must be none or assisted');
  if(typeof c.profile_switch.enabled!=='boolean')throw new Error('profile_switch.enabled must be boolean');
  for(const k of ['enabled','expose_actions','compute_suggestions'])if(typeof c.controller[k]!=='boolean')throw new Error(`controller.${k} must be boolean`);
  for(const k of ['seed','utc_offset_minutes','horizon_minutes','decision_interval_minutes'])check(c[k],k);
  const start=Date.parse(c.start_time);
  if(typeof c.start_time!=='string'||!c.start_time.endsWith('Z')||!Number.isFinite(start))throw new Error('start_time must be a UTC ISO timestamp');
  if(start%(5*60000))throw new Error('start_time must align to the 5-minute grid');
  validateTherapy(c);
  if(c.cgm.model!==null&&!CGMS[c.cgm.model])throw new Error(`cgm.model must be null or one of ${Object.keys(CGMS).join(', ')}`);
  if(c.meter.model!==null&&!METERS[c.meter.model])throw new Error(`meter.model must be null or one of ${Object.keys(METERS).join(', ')}`);
  if(c.cgm.model===null&&c.meter.model===null)throw new Error('An instance needs at least one glucose sensor (cgm or meter)');
  if(c.cgm.model&&CGMS[c.cgm.model].calibration?.required&&c.meter.model===null)throw new Error(`${c.cgm.model} needs a fingerstick meter for calibration`);
  const hhmmList=(v,where)=>{if(!Array.isArray(v)||v.length>24||v.some(x=>!HHMM.test(x)))throw new Error(`${where} must be a list of HH:MM`);};
  hhmmList(c.meter.routine_times,'meter.routine_times');hhmmList(c.cgm.scan_window,'cgm.scan_window');
  if(c.cgm.scan_window.length!==2)throw new Error('cgm.scan_window must be [from, to]');
  if(!Array.isArray(c.faults.occlusions)||c.faults.occlusions.some(o=>!isObject(o)||Object.keys(o).join()!=='at_minute'
    ||!(o.at_minute>=0&&o.at_minute<c.horizon_minutes)))throw new Error('faults.occlusions must be [{at_minute}] within the horizon');
  if((c.faults.occlusion_rate_per_day>0||c.faults.occlusions.length)&&c.therapy.mode!=='pump')throw new Error('Occlusion faults require pump mode');
  for(const [name,m] of Object.entries(c.scenario.meals)) {
    const known=Object.keys(DEFAULT_CONFIG.scenario.meals.breakfast),optional=['probability','high_fat_probability','announce_probability'];
    if(!isObject(m)||Object.keys(m).some(k=>!known.includes(k)&&!optional.includes(k))||known.some(k=>!(k in m)))
      throw new Error(`scenario.meals.${name} must have ${known.join(', ')} (optional: ${optional.join(', ')})`);
    if(!HHMM.test(m.time))throw new Error(`scenario.meals.${name}.time must be HH:MM`);
    if(m.carbs_jitter_g>=m.carbs_g)throw new Error(`scenario.meals.${name}.carbs_jitter_g must be below carbs_g`);
  }
  for(const k of ['activity','stress'])if(!HHMM.test(c.scenario[k].time))throw new Error(`scenario.${k}.time must be HH:MM`);
  for(const k of ['enabled','announced'])if(k in c.scenario.activity&&typeof c.scenario.activity[k]!=='boolean')throw new Error(`scenario.activity.${k} must be boolean`);
  if(typeof c.scenario.stress.enabled!=='boolean')throw new Error('scenario.stress.enabled must be boolean');
  if(!Array.isArray(c.scenario.extra_events)||c.scenario.extra_events.length>500)throw new Error('scenario.extra_events must be an array (max 500)');
  c.scenario.extra_events.forEach(validateExtraEvent(c.horizon_minutes));
  if(c.scenario.extra_events.some(e=>e.type==='infusion_deficit')&&c.therapy.mode!=='pump')throw new Error('infusion_deficit requires a pump');
  if(c.scenario.extra_events.some(e=>['sensor_bias','sensor_drift','sensor_calibration_error'].includes(e.type))&&!c.cgm.model)throw new Error('Sensor fault requires a CGM');
  validateScenarioControls(c);
  if(!['native','I0','I1','I2'].includes(c.information.mode))throw new Error('information.mode must be native, I0, I1 or I2');
  if(!['records-v1','minimal-v2','record-derived-v3'].includes(c.information.policy))throw new Error('unknown information.policy');
  if(typeof c.information.own_records!=='boolean')throw new Error('information.own_records must be boolean');
  if(c.information.own_records&&c.information.policy==='minimal-v2')throw new Error('own_records requires numeric record estimates, not minimal-v2');
  if(!Array.isArray(c.information.rules)||c.information.rules.length>50)throw new Error('information.rules must be an array');
  for(const r of c.information.rules) {
    if(!isObject(r)||!['meal','exercise','life','fault','treatment'].includes(r.category)||Object.keys(r).some(k=>!['category','ids'].includes(k))
      ||(r.ids!==undefined&&(!Array.isArray(r.ids)||r.ids.some(x=>typeof x!=='string'))))throw new Error('information rule requires category and optional string ids');
  }
  // Default programmed basal = this person's true requirement.
  if(c.profile.basal_u_h===null)c.profile.basal_u_h=equilibriumBasalUph(c.patient.weight_kg)/c.physiology.sensitivity;
  const rapid=INSULINS[c.therapy.mode==='pump'?c.therapy.pump.insulin:c.therapy.mdi.bolus_insulin];
  // AAPS enforces a minimum DIA of 5 h for its rapid presets.
  c.profile.dia_hours=Math.max(c.profile.dia_hours??0,rapid.min_dia_hours);
  if(c.therapy.mode==='mdi'&&c.therapy.mdi.basal_dose_u===null)
    c.therapy.mdi.basal_dose_u=Math.round(c.profile.basal_u_h*24/c.therapy.mdi.basal_times.length);
  if(c.therapy.mode==='mdi'&&c.therapy.mdi.max_daily_injections!==undefined&&c.therapy.mdi.auto_basal_injection
    &&c.therapy.mdi.basal_times.length*Math.ceil(c.therapy.mdi.basal_dose_u/PENS[c.therapy.mdi.basal_pen].max_u-1e-9)>c.therapy.mdi.max_daily_injections)
    throw new Error('Routine basal injections exceed the daily pen injection limit');
  if(c.profile.max_basal_u_h<c.profile.basal_u_h)throw new Error('profile.max_basal_u_h must be >= basal');
  return c;
}

/** Default-off controls used by the OpenDiabet task generator (see DEFAULT_CONFIG comments). */
function validateScenarioControls(c) {
  const g=c.cgm,s=c.scenario,m=c.therapy.mdi,is=c.initial_state;
  if(!['sampled','median'].includes(g.error_draw))throw new Error('cgm.error_draw must be sampled or median');
  if(typeof g.calibration_overdue_at_start!=='boolean')throw new Error('cgm.calibration_overdue_at_start must be boolean');
  if(!Array.isArray(g.forced_gaps)||g.forced_gaps.length>50||g.forced_gaps.some(x=>!isObject(x)||Object.keys(x).sort().join()!=='at_minute,duration_minutes'
    ||!(Number.isFinite(x.at_minute)&&x.at_minute>=0&&x.at_minute<c.horizon_minutes)||!(Number.isFinite(x.duration_minutes)&&x.duration_minutes>=5&&x.duration_minutes<=1440)))
    throw new Error('cgm.forced_gaps must be [{at_minute, duration_minutes (5..1440)}] within the horizon');
  if(typeof s.announcement.report_composition!=='boolean')throw new Error('scenario.announcement.report_composition must be boolean');
  if(!['native','complete'].includes(s.announcement.information_mode))throw new Error('scenario.announcement.information_mode must be native or complete');
  if(s.menstrual.cycle_day_at_start!==null&&s.menstrual.cycle_day_at_start>=s.menstrual.cycle_days)throw new Error('scenario.menstrual.cycle_day_at_start must be below cycle_days');
  if(!Array.isArray(m.extra_doses_before_start)||m.extra_doses_before_start.length>4||m.extra_doses_before_start.some(x=>!isObject(x)
    ||Object.keys(x).sort().join()!=='minutes_before,units'||!(Number.isFinite(x.minutes_before)&&x.minutes_before>0&&x.minutes_before<=2880)
    ||!(Number.isFinite(x.units)&&x.units>0&&x.units<=200)))
    throw new Error('therapy.mdi.extra_doses_before_start must be [{minutes_before (0..2880], units (0..200]}]');
  if(c.therapy.mode!=='mdi'&&(m.missed_doses_before_start>0||m.extra_doses_before_start.length))throw new Error('missed/extra long-acting doses require pens (mdi)');
  if(!Array.isArray(is.history)||is.history.length>50)throw new Error('initial_state.history must be an array (max 50)');
  if(is.history_minutes%5)throw new Error('initial_state.history_minutes must be a multiple of 5');
  if(is.history.length&&!is.history_minutes)throw new Error('initial_state.history needs history_minutes > 0');
  is.history.forEach((e,i)=>{
    const where=`initial_state.history[${i}]`,fields=INITIAL_STATE_TYPES[e?.type];
    if(!isObject(e)||!fields)throw new Error(`${where}.type must be one of ${Object.keys(INITIAL_STATE_TYPES).join(', ')}`);
    for(const k of Object.keys(e))if(!['type','minutes_before',...fields].includes(k))throw new Error(`Unknown field ${where}.${k}`);
    if(!(Number.isInteger(e.minutes_before)&&e.minutes_before>0&&e.minutes_before<=is.history_minutes&&e.minutes_before%5===0))
      throw new Error(`${where}.minutes_before must be a multiple of 5 in (0, history_minutes]`);
    const num=(k,lo,hi)=>{if(!(Number.isFinite(e[k])&&e[k]>lo&&e[k]<=hi))throw new Error(`${where}.${k} must be in (${lo}, ${hi}]`);};
    if(['bolus','long_acting','extended_bolus'].includes(e.type))num('units',0,e.type==='long_acting'?200:25);
    if(e.type==='extended_bolus'){num('duration_minutes',4,480);if(c.therapy.mode!=='pump')throw new Error('extended_bolus history needs a pump');}
    if(e.type==='occlusion'&&c.therapy.mode!=='pump')throw new Error('occlusion history needs a pump');
    if(e.type==='meal'||e.type==='carbs')num('grams',0,200);
    if(e.type==='meal'){num('absorption_minutes',4,240);if(e.announced_grams!==null&&!(Number.isFinite(e.announced_grams)&&e.announced_grams>=0&&e.announced_grams<=300))throw new Error(`${where}.announced_grams must be null or 0..300`);}
    if(e.type==='suspend_pump'){num('minutes',0,1440);if(c.therapy.mode!=='pump')throw new Error(`${where}: suspend_pump needs a pump`);}
    if(e.type==='long_acting'&&c.therapy.mode!=='mdi')throw new Error(`${where}: long_acting needs pens (mdi)`);
  });
  if(is.history_minutes&&(m.missed_doses_before_start>0||m.extra_doses_before_start.length))
    throw new Error('initial_state history cannot be combined with missed/extra long-acting doses');
  // v1.1-hard controls (default off).
  const rd=s.announcement.report_delay;
  if(rd.min_minutes>rd.max_minutes)throw new Error('scenario.announcement.report_delay.min_minutes must be <= max_minutes');
  const fm=c.self_care.meal_bolus.forced_miss;
  if(!Array.isArray(fm)||fm.length>10||fm.some(x=>typeof x!=='string'||!x||x.length>40))throw new Error('self_care.meal_bolus.forced_miss must be a list of meal names');
  if(!Array.isArray(g.compression_lows)||g.compression_lows.length>20||g.compression_lows.some(x=>!isObject(x)
    ||Object.keys(x).sort().join()!=='at_minute,depth_mg_dl,duration_minutes'||!(Number.isFinite(x.at_minute)&&x.at_minute>=0&&x.at_minute<c.horizon_minutes)
    ||!(Number.isFinite(x.duration_minutes)&&x.duration_minutes>=5&&x.duration_minutes<=240)||!(Number.isFinite(x.depth_mg_dl)&&x.depth_mg_dl>0&&x.depth_mg_dl<=150)))
    throw new Error('cgm.compression_lows must be [{at_minute, duration_minutes (5..240), depth_mg_dl (0..150]}] within the horizon');
}

const EXTRA_FIELDS={
  meal:{grams:[1,200],absorption_minutes:[5,240]},
  exercise:{duration_minutes:[5,240],accelerometer_counts:[0,6539]},
  stress:{duration_minutes:[5,480],hepatic_delta_mg_dl_per_min:[0,.5]},
  // v1.1-hard: a sudden illness at a given minute (sensitivity / (1 + insulin_need_increase)).
  illness:{duration_hours:[1,240],insulin_need_increase:[0,3]},
  sleep_loss:{duration_minutes:[5,1440],sensitivity_decrease:[0,.6]},
  infusion_recovery:{},
  sensor_bias:{duration_minutes:[5,1440],bias_mg_dl:[-100,100]},
  sensor_calibration_error:{bias_mg_dl:[-100,100]},
  sensor_drift:{duration_minutes:[10,1440],bias_mg_dl:[-100,100],ramp_minutes:[5,360]},
  // Match the published multi-day cohort contract (up to the 28-day horizon).
  infusion_deficit:{duration_minutes:[5,40320],delivered_fraction:[0,1]},
  alcohol:{onset_hours:[0,24],duration_hours:[1,24],hepatic_delta_mg_dl_per_min:[-1,0]},
  record:{},
  patient_treatment:{},
};
const validateExtraEvent=horizon=>(e,i)=>{
  const where=`scenario.extra_events[${i}]`;
  if(!isObject(e)||!EXTRA_FIELDS[e.type])throw new Error(`${where}.type must be meal, exercise, stress or illness`);
  const required=['id','type','at_minute',...Object.keys(EXTRA_FIELDS[e.type]),...(e.type==='meal'?['announced_grams']:['exercise','illness','sleep_loss','alcohol'].includes(e.type)?['announced']:e.type==='record'?['category','text']:e.type==='patient_treatment'?['action','announced']:[])];
  const allowed=[...required,...(e.type==='exercise'?['kind','hepatic_delta_mg_dl_per_min']:[])];
  for(const k of Object.keys(e))if(!allowed.includes(k))throw new Error(`Unknown field ${where}.${k}`);
  for(const k of required)if(!(k in e))throw new Error(`${where}.${k} is required`);
  if(typeof e.id!=='string'||!e.id||e.id.length>64)throw new Error(`${where}.id must be a short string`);
  if(!Number.isFinite(e.at_minute)||e.at_minute<0||e.at_minute>=horizon)throw new Error(`${where}.at_minute must be within the horizon`);
  for(const [k,[lo,hi]] of Object.entries(EXTRA_FIELDS[e.type]))if(!Number.isFinite(e[k])||e[k]<lo||e[k]>hi)throw new Error(`${where}.${k} must be in [${lo}, ${hi}]`);
  if(e.type==='meal'&&e.announced_grams!==null&&!(Number.isFinite(e.announced_grams)&&e.announced_grams>=0&&e.announced_grams<=300))throw new Error(`${where}.announced_grams must be null or 0..300`);
  if((e.type==='exercise'||e.type==='illness')&&typeof e.announced!=='boolean')throw new Error(`${where}.announced must be boolean`);
  if(e.type==='record'&&(!['meal','exercise','life','fault'].includes(e.category)||typeof e.text!=='string'||e.text.length>1000))throw new Error(`${where}: invalid record`);
  if(e.type==='sensor_drift'&&e.ramp_minutes*2>e.duration_minutes)throw new Error(`${where}: ramps exceed duration`);
  if(e.type==='exercise'&&e.kind!==undefined&&!['aerobic','anaerobic','mixed'].includes(e.kind))throw new Error(`${where}: invalid exercise kind`);
  if(e.type==='exercise'&&e.hepatic_delta_mg_dl_per_min!==undefined&&!(Number.isFinite(e.hepatic_delta_mg_dl_per_min)&&e.hepatic_delta_mg_dl_per_min>=0&&e.hepatic_delta_mg_dl_per_min<=2))throw new Error(`${where}: invalid hepatic exercise term`);
  if(['sleep_loss','alcohol'].includes(e.type)&&typeof e.announced!=='boolean')throw new Error(`${where}.announced must be boolean`);
  if(e.type==='patient_treatment') {
    const a=e.action,fields={BOLUS:{units:[0,25]},INGEST_CARBS:{grams:[0,200]},EXTENDED_BOLUS:{units:[0,25],duration_minutes:[4,480]}};
    if(!isObject(a)||!fields[a.type]||typeof e.announced!=='boolean')throw Error(`${where}: invalid scripted patient treatment`);
    if(Object.keys(a).some(k=>k!=='type'&&!(k in fields[a.type])))throw Error(`${where}: unexpected treatment field`);
    for(const [key,[lo,hi]] of Object.entries(fields[a.type]))if(!Number.isFinite(a[key])||a[key]<=lo||a[key]>hi)
      throw Error(`${where}: invalid ${key}`);
  }
};

function validateTherapy(c) {
  const t=c.therapy,oneOf=(v,list,where)=>{if(!list.includes(v))throw new Error(`${where} must be one of ${list.join(', ')}`);};
  oneOf(t.mode,['pump','mdi'],'therapy.mode');
  oneOf(t.pump.model,Object.keys(PUMPS),'therapy.pump.model');
  oneOf(t.pump.insulin,PUMP_INSULINS,'therapy.pump.insulin');
  oneOf(t.mdi.bolus_pen,Object.keys(PENS),'therapy.mdi.bolus_pen');
  oneOf(t.mdi.basal_pen,Object.keys(PENS),'therapy.mdi.basal_pen');
  oneOf(t.mdi.bolus_insulin,BOLUS_PEN_INSULINS,'therapy.mdi.bolus_insulin');
  oneOf(t.mdi.basal_insulin,BASAL_PEN_INSULINS,'therapy.mdi.basal_insulin');
  if(!HHMM.test(t.pump.refill_time))throw new Error('therapy.pump.refill_time must be HH:MM');
  if(typeof t.mdi.auto_basal_injection!=='boolean')throw new Error('therapy.mdi.auto_basal_injection must be boolean');
  if(t.mdi.dose_memory!==undefined&&typeof t.mdi.dose_memory!=='boolean')throw new Error('therapy.mdi.dose_memory must be boolean');
  if(t.mdi.max_daily_injections!==undefined&&(!Number.isInteger(t.mdi.max_daily_injections)||t.mdi.max_daily_injections<1||t.mdi.max_daily_injections>5))
    throw new Error('therapy.mdi.max_daily_injections must be an integer in [1,5]');
  const times=t.mdi.basal_times;
  if(!Array.isArray(times)||!times.length||times.length>4||times.some(x=>!HHMM.test(x))||new Set(times).size!==times.length)
    throw new Error('therapy.mdi.basal_times must be 1-4 distinct HH:MM strings');
}
