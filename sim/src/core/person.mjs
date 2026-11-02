// Person types -> configuration layer. A person is described by a type (sex x age group), variants
// (BMI class, dawn phenomenon, carb-counting skill) and optionally a seeded draw from the type's
// distributions. The same quantities are what trace2sim estimates from real data.
//
// Mapping onto the Deichmann2023 kernel: the basal insulin requirement per kg defines the
// person's insulin sensitivity relative to the reference patient (0.208 U/kg/day at
// sensitivity 1). Because sensitivity scales insulin action against a fixed basal reference,
// it sets both the basal requirement and the response to a bolus. The programmed profile
// (basal, ISF, carb ratio) is derived from the true needs and perturbed by a "settings
// mismatch", so a profile is never a perfect description of the person.
import {KNOWLEDGE} from '../knowledge.mjs';
import {Rng} from './rng.mjs';

export const PERSONS=KNOWLEDGE.persons;
const M=KNOWLEDGE.personModel;
const DEFAULT_ABSORPTION={breakfast:40,lunch:55,dinner:65,snack:30};

const round=(v,step)=>Number((Math.round(v/step)*step).toFixed(6));
const clampTo=(v,{min=-Infinity,max=Infinity})=>Math.min(max,Math.max(min,v));

/**
 * spec: {type, bmi:'normal'|'overweight'|'obese', dawn:'absent'|'present'|'random',
 *        carb_counting:'typical'|'accurate'|'poor', sample:boolean}
 * Returns {layer, resolved}: a partial config to merge under user input, and a summary.
 */
// AAPS caps temp basals at 4x the scheduled basal, within the age hard limit
// (insulin-resistant adults use the higher limit).
function maxBasal(group,basal) {
  const L=KNOWLEDGE.aaps.hard_limits,want=Math.max(1,round(basal*4,0.1));
  const limit=group==='child'?L.child.max_basal_u_h:group==='adolescent'?L.teenage.max_basal_u_h
    :want>L.adult.max_basal_u_h?L.insulin_resistant.max_basal_u_h:L.adult.max_basal_u_h;
  return Math.max(round(basal*1.5,0.1),Math.min(want,limit));
}

export function personLayer(spec,seed) {
  const t=PERSONS[spec.type];if(!t)throw new Error(`Unknown person type ${spec.type}; one of ${Object.keys(PERSONS).join(', ')}`);
  const bmi=M.variants.bmi[spec.bmi],cc0=M.variants.carb_counting[spec.carb_counting];
  if(!bmi||!cc0)throw new Error('Unknown person variant');
  const rng=spec.sample?Rng.stream(seed,'person'):null;
  const draw=d=>rng?clampTo(rng.normal(d.median,d.sd),d):d.median;
  const jitter=cv=>rng?Math.exp(rng.normal(0,cv)):1;

  const sampledWeight=round(draw(t.weight_kg)*bmi.weight_x,0.1),body=spec.anthropometry;
  if(body!==undefined&&(!body||typeof body!=='object'||Array.isArray(body)
    ||Object.keys(body).some(k=>!['height_cm','weight_kg'].includes(k))
    ||!Number.isFinite(body.height_cm)||body.height_cm<50||body.height_cm>230
    ||!Number.isFinite(body.weight_kg)||body.weight_kg<10||body.weight_kg>250))
    throw Error('person.anthropometry requires height_cm in [50,230] and weight_kg in [10,250]');
  const weight=body?.weight_kg??sampledWeight,height=body?.height_cm??t.height_cm;
  const tddPerKg=draw(t.tdd_u_per_kg_day)*bmi.tdd_per_kg_x,basalFraction=draw(t.basal_fraction);
  const basalPerKg=tddPerKg*basalFraction,sensitivity=M.reference.basal_u_per_kg_day/basalPerKg;
  const trueBasal=basalPerKg*weight/24;
  const dawnFraction=spec.dawn==='random'?(rng?(rng.next()<t.dawn_prevalence?M.variants.dawn.present.fraction:0):0)
    :M.variants.dawn[spec.dawn]?.fraction;
  if(dawnFraction===undefined)throw new Error('Unknown dawn variant');
  const pm=M.profile_mismatch,ref=M.reference;
  // Profile values scale like the model: ISF with sensitivity per kg, carb ratio with sensitivity.
  // (The weight factor belongs only on ISF: glucose per unit of insulin and glucose per gram of
  // carbohydrate both go as 1 / distribution volume, so in their ratio — the carb ratio — the
  // weight cancels. The clinical "500 rule" assumes otherwise and does not hold in this kernel.)
  const profile={basal_u_h:round(trueBasal*jitter(pm.basal_cv),0.005),
    isf_mg_dl_per_u:Math.max(5,Math.round(ref.profile_isf_mg_dl_per_u*sensitivity*ref.weight_kg/weight*jitter(pm.isf_cv))),
    carb_ratio_g_per_u:Math.max(1,round(ref.profile_carb_ratio_g_per_u*sensitivity*jitter(pm.carb_ratio_cv),0.5)),
    max_basal_u_h:maxBasal(t.age_group,trueBasal)};
  const carbsPerDay=draw(t.carbs_g_per_day);
  const meals=Object.fromEntries(Object.entries(t.meal_plan).map(([name,m])=>{
    const g=Math.max(5,Math.round(carbsPerDay*m.share));
    return [name,{time:m.time,carbs_g:g,carbs_jitter_g:Math.round(g*0.2),time_jitter_minutes:30,
      absorption_minutes:DEFAULT_ABSORPTION[name]??45,...(m.probability!==undefined?{probability:m.probability}:{})}];
  }));
  const cc={...t.carb_estimation,...cc0};
  const layer={
    patient:{sex:t.sex,age_years:t.age_years,height_cm:height,weight_kg:weight,initial_glucose_mg_dl:120},
    profile:{...profile,target_mg_dl:t.age_group==='child'?120:110},
    physiology:{sensitivity,dawn_fraction:dawnFraction,daily_sensitivity_cv:M.daily_sensitivity_cv.value},
    scenario:{meals,announcement:{probability:1,model:'normal',bias:cc.bias,sd:cc.sd,carb_error_fraction:0},
      activity:{probability:t.exercise_probability_per_day}},
    safety:{max_bolus_u:t.max_bolus_u},
  };
  const resolved={type:spec.type,name:t.name,age_group:t.age_group,sex:t.sex,bmi:spec.bmi,carb_counting:spec.carb_counting,
    sampled:!!spec.sample,weight_kg:weight,tdd_u_per_kg_day:tddPerKg,basal_fraction:basalFraction,
    true_basal_u_h:trueBasal,true_tdd_u_day:tddPerKg*weight,insulin_sensitivity:sensitivity,dawn_fraction:dawnFraction,
    carbs_g_per_day:carbsPerDay,carb_estimation:cc,profile,...(body?{height_cm:height,anthropometry:{...body}}:{})};
  return {layer,resolved};
}
