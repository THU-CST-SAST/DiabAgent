// Known-truth traces for trace2sim validation. A World instance with deliberately altered
// physiology lives through several days (scenario meals with misestimated announcements, the
// built-in oref0 loop issuing temp basals, a patient who boluses for announced meals, treats
// lows and occasionally corrects highs). What a real patient's Nightscout would hold is
// recorded from World.drain(): CGM readings, delivered boluses, temp basals, reported carbs.
// The hidden truth (physiology, actual meals, plasma glucose) is returned separately.
import {World} from '../sim/world.mjs';
import {buildInstanceConfig} from '../sim/instance.mjs';
import {DAY_MS,MIN_MS} from './util.mjs';

const STEP=5*MIN_MS;
const roundStep=(u,step)=>Number((Math.floor(u/step+1e-9)*step).toFixed(3));

export const DEFAULT_TRUTH=Object.freeze({sensitivity:0.7,carb_bioavailability:0.85,meal_absorption_scale:1.3,dawn_fraction:0.2});

/**
 * opts: {seed, days, person, truth (physiology overrides), dailySensitivityCv, cgm, pump, insulin,
 *        loop:'closed'|'open', carbErrorFraction, announceProbability, exercise}
 * Returns {nightscout:{entries, treatments, profile}, meta, truth, config}.
 */
export function syntheticTrace(opts={}) {
  const o={seed:7,days:6,person:'adult_male',truth:DEFAULT_TRUTH,dailySensitivityCv:0.13,cgm:'dexcom_g6',pump:'dana_i',insulin:'aspart',
    loop:'closed',carbErrorFraction:0.2,announceProbability:1,exercise:false,mdi:null,...opts};
  // mdi: null for a pump, or {bolus_pen, bolus_insulin, basal_pen, basal_insulin} for pens (no loop).
  const therapy=o.mdi?{mode:'mdi',mdi:o.mdi}:{mode:'pump',pump:{model:o.pump,insulin:o.insulin}};
  const spec={seed:o.seed,horizon_minutes:Math.min(10080,o.days*1440),person:{type:o.person},
    therapy,sensors:{cgm:o.cgm,meter:null},controller:{mode:o.mdi?'open':o.loop},events:['baseline'],
    overrides:{physiology:{...o.truth,daily_sensitivity_cv:o.dailySensitivityCv},
      scenario:{announcement:{probability:o.announceProbability,model:'uniform',carb_error_fraction:o.carbErrorFraction,bias:0,sd:0},
        activity:{enabled:o.exercise}}}};
  const config=buildInstanceConfig(spec);
  const w=new World(config),c=w.config,end=w.start+o.days*DAY_MS;
  const entries=[],treatments=[],truthGlucose=[];
  const eventById=id=>w.events.find(e=>e.id===id);
  let seen=0,lastRescue=-Infinity,lastBolus=-Infinity,n=0;
  const bolusStep=w.device.kind==='pump'?w.device.spec.bolus_step_u||0.05:w.device.bolusPenSpec.step_u;
  const collect=()=>{
    const out=w.drain();
    for(const s of out.samples)if(s.type==='sgv')entries.push({type:'sgv',sgv:Math.round(s.observed),date:s.at,dateString:new Date(s.at).toISOString()});
    for(const t of out.treatments) {
      if(!['Meal Bolus','Correction Bolus','Temp Basal','Carb Correction','Combo Bolus','Basal Injection'].includes(t.eventType))continue;
      const doc={_id:String(t.id),eventType:t.eventType,created_at:new Date(t.at).toISOString(),enteredBy:t.source??'sim'};
      if(t.carbs!=null){doc.carbs=t.carbs;
        // Patient-selected absorption type (Loop-style absorptionTime): the meal's nominal speed.
        doc.absorptionTime=t.eventType==='Carb Correction'?c.safety.rescue_absorption_minutes:eventById(t.id)?.absorption_minutes;}
      if(t.insulin!=null)doc.insulin=t.insulin;
      if(t.insulinType)doc.insulinType=t.insulinType;
      if(t.absolute!=null){doc.absolute=t.absolute;doc.duration=t.duration;}
      if(t.eventType==='Combo Bolus')doc.duration=t.duration;
      treatments.push(doc);
    }
  };
  collect();
  for(let t=w.start+STEP;t<=end;t+=STEP) {
    w.advanceTo(t,{sample:true});
    if(w.terminated)throw new Error(`synthetic world terminated: ${w.error}`);
    const notices=w.notices.slice(seen);seen=w.notices.length;
    const g=w.latestGlucose(),fresh=g&&t-g.at<=15*MIN_MS?g.value:null;
    for(const nt of notices)if(nt.type==='exercise_started')
      treatments.push({_id:nt.id,eventType:'Exercise',created_at:nt.time,duration:nt.duration_minutes,intensity:'moderate',enteredBy:'patient'});
    for(const nt of notices)if(nt.type==='meal_announced') {
      let u=nt.grams/c.profile.carb_ratio_g_per_u;
      if(fresh&&fresh>150)u+=(fresh-c.profile.target_mg_dl)/c.profile.isf_mg_dl_per_u*0.5;
      u=roundStep(Math.min(u,c.safety.max_bolus_u),bolusStep);
      if(u>0&&w.apply({type:'BOLUS',units:u},`bolus:${nt.id}`,'patient').status==='applied')lastBolus=t;
    }
    if(fresh&&fresh<70&&t-lastRescue>=45*MIN_MS) {
      if(w.apply({type:'INGEST_CARBS',grams:15},`rescue:${t}`,'patient').status==='applied')lastRescue=t;
    } else if(fresh&&fresh>250&&t-lastBolus>=3*3600000) {
      const u=roundStep((fresh-c.profile.target_mg_dl)/c.profile.isf_mg_dl_per_u*0.6,bolusStep);
      if(u>0&&w.apply({type:'BOLUS',units:u},`corr:${t}`,'patient').status==='applied')lastBolus=t;
    }
    if(++n%288===0&&w.device.kind==='pump')w.device.maintenance({reservoirU:w.device.spec.reservoir_u});   // daily refill
    truthGlucose.push({t,mg_dl:w.physiology.glucose()});
    collect();
  }
  const meals=w.events.filter(e=>e.type==='meal'&&e.at>=w.start&&e.at<end)
    .map(e=>({id:e.id,t:e.at,grams:e.grams,absorption_minutes:e.absorption_minutes,announced_grams:e.announced_grams}));
  const rescues=treatments.filter(t=>t.eventType==='Carb Correction').map(t=>({t:Date.parse(t.created_at),grams:t.carbs,absorption_minutes:t.absorptionTime}));
  const profile={defaultProfile:'Default',store:{Default:{units:'mg/dl',
    basal:[{time:'00:00',value:w.device.kind==='pump'?w.device.scheduledBasalUph:c.profile.basal_u_h}],sens:[{time:'00:00',value:c.profile.isf_mg_dl_per_u}],
    carbratio:[{time:'00:00',value:c.profile.carb_ratio_g_per_u}],
    target_low:[{time:'00:00',value:c.profile.target_mg_dl}],target_high:[{time:'00:00',value:c.profile.target_mg_dl}]}}};
  const meta={id:`synthetic-${o.person}-${o.seed}`,sex:c.patient.sex,age_years:c.patient.age_years,weight_kg:c.patient.weight_kg,height_cm:c.patient.height_cm,
    therapy,cgm_model:o.cgm,utc_offset_minutes:c.utc_offset_minutes};
  return {nightscout:{entries,treatments,profile},meta,
    truth:{physiology:{...c.physiology},meals,rescues,glucose:truthGlucose,profile:c.profile,
      summary:w.summary(),person:c.person.resolved},config:c};
}

/** Carbs as actually eaten (hidden truth), in TraceV1 form: for replay-parity checks. */
export function trueCarbs(synth) {
  return [...synth.truth.meals.map(m=>({t:m.t,grams:m.grams,absorption_minutes:m.absorption_minutes,kind:'meal'})),
    ...synth.truth.rescues.map(r=>({t:r.t,grams:r.grams,absorption_minutes:r.absorption_minutes,kind:'correction'}))].sort((a,b)=>a.t-b.t);
}
