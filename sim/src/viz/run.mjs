// Compact run records for visualization (preview page, demo videos, GUI replay).
// A run record is a self-contained JSON description of one simulated instance over a horizon:
// who the person is, which devices and sensors they use, and per-step series of true glucose,
// visible readings, IOB/COB/basal, treatments and scheduled events (including hidden ones).
// Format id: 'sweet-sim.run/v1'. Times are minutes since the episode start.
import {buildInstanceConfig} from '../sim/instance.mjs';
import {SimEnv} from '../env/pomdp.mjs';
import {patientPolicy} from '../policies/patient.mjs';
import {oref0Policy} from '../policies/oref0.mjs';
import {standardCarePolicy,guidelinePolicy} from '../policies/care.mjs';
import {hclPolicy} from '../policies/hcl.mjs';
import {oref1Policy} from '../policies/oref1.mjs';
import {KNOWLEDGE as K} from '../knowledge.mjs';
import {episodeMetrics,episodeScore} from '../bench/score.mjs';
import {standardBaselinePolicy} from '../bench/hourly-policy.mjs';

export const RUN_FORMAT='sweet-sim.run/v1';
export const POLICIES={
  patient:()=>patientPolicy(),
  oref0:()=>obs=>oref0Policy(obs),
  wait:()=>()=>({action:{type:'WAIT'},rationale:'wait'}),
  // Classical care baselines (docs/BASELINES.zh-CN.md): B1 standard, B2 guideline, B3 hcl, B4 oref1.
  standard:(options=null)=>standardBaselinePolicy('standard',standardCarePolicy,options),
  guideline:(options=null)=>standardBaselinePolicy('guideline',guidelinePolicy,options),
  hcl:(options=null)=>standardBaselinePolicy('hcl',hclPolicy,options),
  oref1:(options=null)=>standardBaselinePolicy('oref1',oref1Policy,options),
};
const name=(table,id)=>id?(table[id]?.name??id):null;
const round=(v,d=2)=>v==null?null:Number(v.toFixed(d));

/** Static description of an instance from its normalized config (and spec event packs if known). */
function describe(cfg,{packs,factors}={}) {
  const r=cfg.person?.resolved,t=cfg.therapy,p=cfg.patient;
  const setup=!cfg.cgm.model?'meter_only':K.sensors[cfg.cgm.model].modality==='flash'?'flash'
    :K.sensors[cfg.cgm.model].calibration?.required?'calibrated_cgm':'cgm';
  const sc=cfg.scenario;
  packs??=[['high_fat_meals',Object.values(sc.meals).some(m=>m.high_fat_probability>0)],['anaerobic_exercise',sc.anaerobic?.enabled],
    ['alcohol',sc.alcohol?.enabled],['illness',sc.illness?.enabled],['sleep_loss',sc.sleep_loss?.enabled],['menstrual',sc.menstrual?.enabled],
    ['stress',sc.stress?.enabled||sc.extra_events.some(e=>e.type==='stress')],['occlusion_faults',cfg.faults.occlusion_rate_per_day>0.05||cfg.faults.occlusions.length>0],['unannounced_meals',sc.announcement.probability<1],
    ['illness',sc.extra_events.some(e=>e.type==='illness')],['sleep_loss',sc.extra_events.some(e=>e.type==='sleep_loss')],
    ['activity',sc.extra_events.some(e=>e.type==='exercise')],['signal_gaps',cfg.cgm.forced_gaps.length>0],['compression_low',cfg.cgm.compression_lows.length>0],
    ['sensor_bias',sc.extra_events.some(e=>e.type==='sensor_bias')],['calibration_error',sc.extra_events.some(e=>e.type==='sensor_calibration_error')],
    ['sensor_drift',sc.extra_events.some(e=>e.type==='sensor_drift')],['infusion_deficit',sc.extra_events.some(e=>e.type==='infusion_deficit')],['alcohol',sc.extra_events.some(e=>e.type==='alcohol')]]
    .filter(([,on])=>on).map(([k])=>k);
  return {
    factors:factors??null,
    person:r?{type:r.type,name:r.name,group:r.age_group,sex:r.sex,age:p.age_years,weight:p.weight_kg,height:p.height_cm,bmi:r.bmi,
      dawn:r.dawn_fraction>0?'present':'absent',carb_counting:r.carb_counting,tdd:round(r.true_tdd_u_day,1),tdd_kg:round(r.tdd_u_per_kg_day),
      sensitivity:round(r.insulin_sensitivity),carbs_day:Math.round(r.carbs_g_per_day)}
      :{type:'reference',name:'Reference patient',group:'adult',sex:p.sex??'male',age:p.age_years??39,weight:p.weight_kg,height:p.height_cm??170,
        bmi:'normal',dawn:cfg.physiology.dawn_fraction>0?'present':'absent',carb_counting:'typical',tdd:null,tdd_kg:null,sensitivity:cfg.physiology?.sensitivity??1,carbs_day:null},
    profile:{basal:t.mode==='mdi'?null:cfg.profile.basal_u_h,isf:cfg.profile.isf_mg_dl_per_u,cr:cfg.profile.carb_ratio_g_per_u,target:cfg.profile.target_mg_dl},
    therapy:t.mode==='pump'?{mode:'pump',device:name(K.pumps,t.pump.model),form:K.pumps[t.pump.model].form,insulin:name(K.insulins,t.pump.insulin)}
      :{mode:'mdi',device:name(K.pens,t.mdi.bolus_pen),insulin:name(K.insulins,t.mdi.bolus_insulin),
        basal_device:name(K.pens,t.mdi.basal_pen),basal_insulin:name(K.insulins,t.mdi.basal_insulin),basal_dose:t.mdi.basal_dose_u,basal_times:t.mdi.basal_times},
    sensors:{setup,cgm:name(K.sensors,cfg.cgm.model),meter:name(K.meters,cfg.meter.model),routine:cfg.meter.routine_times},
    controller:cfg.controller.enabled===false?'manual':cfg.controller.mode,packs:[...new Set(packs)],
  };
}

function eventsOf(events,t0,hours) {
  return events.map(e=>({m:Math.round((e.at-t0)/60000),end:e.until?Math.round((e.until-t0)/60000):null,type:e.type,
    kind:e.kind??e.name??null,grams:e.grams??null,reported:e.announced_grams??null,
    announced:e.type==='meal'?e.announced_grams!=null:e.announced??null,absorption:e.absorption_minutes??null,units:e.units??null,
    ...(e.text?{text:e.text}:{}),...(e.category?{category:e.category}:{})}))
    .filter(e=>e.m<hours*60);
}
function metricsOf(m) {
  return {tir:m.tir_70_180,tbr:m.tbr_below70,tbr54:m.tbr_below54,tar:m.tar_above180,tar250:m.tar_above250,mean:m.mean_glucose,sd:m.sd_glucose,
    min:m.min_glucose,max:m.max_glucose,insulin:m.total_insulin_u,bolus:m.bolus_u,rescue_carbs:m.rescue_carbs_g,error:m.error};
}

/** Simulates an instance spec under a baseline policy and returns a run record. */
// policy: a POLICIES name, or a factory (cfg, env) => (obs => {action, rationale}) for custom deciders.
export function simulateRun(spec,{id='run',policy='patient',hours,factors,label,agentOptions=null}={}) {
  const s={...spec,...(hours?{horizon_minutes:Math.round(hours*60)}:{})};
  const cfg=buildInstanceConfig(s),env=new SimEnv(cfg),decide=typeof policy==='function'?policy(cfg,env):POLICIES[policy](agentOptions),t0=env.start;
  const H=(env.end-t0)/3600000,minute=iso=>Math.round((Date.parse(iso)-t0)/60000);
  const truth=[],readings=[],treatments=[],iob=[],cob=[],basal=[];let lastReading=null;
  const sampleObs=(o,m)=>{iob.push([m,round(o.iob.total_u)]);cob.push([m,round(o.cob.estimate_g,1)]);
    if(o.device.current_basal_u_h!=null&&cfg.therapy.mode==='pump')basal.push([m,round(o.device.current_basal_u_h,3)]);};
  sampleObs(env.observe(),0);
  while(!env.done()) {
    const d=decide(env.observe());
    const res=env.step({action_id:`p-${env.step_count}`,expected_step:env.step_count,action:d.action,rationale:d.rationale});
    const st=env.evaluator.at(-1),m=minute(st.time),o=res.observation;
    truth.push([m,Math.round(st.true_glucose_mg_dl)]);sampleObs(o,m);
    if(o.glucose&&o.glucose.time!==lastReading){lastReading=o.glucose.time;readings.push([minute(o.glucose.time),Math.round(o.glucose.value_mg_dl),o.glucose.source]);}
    if(d.action.type!=='WAIT'&&res.info.action_result.status==='applied')
      treatments.push([minute(o.virtual_time),d.action.type,d.action.units??d.action.grams,d.rationale]);
  }
  const packs=(spec.events??[]).filter(e=>e!=='baseline');
  return {format:RUN_FORMAT,id,policy:label??(typeof policy==='function'?'custom':policy),start:cfg.start_time,utc_offset_minutes:cfg.utc_offset_minutes,hours:H,
    ...(decide.execution_protocol?{execution_protocol:decide.execution_protocol,baseline_gating:decide.gating}:{}),
    ...describe(cfg,{packs,factors}),actions:env.observe().available_actions,
    metrics:{...metricsOf(env.summary()),dynamic:episodeMetrics(env.exportBundle()).dynamic,score:episodeScore(episodeMetrics(env.exportBundle())).score,scoring_version:'METRICS-v0.3'},truth,readings,treatments,events:eventsOf(env.events,t0,H),series:{iob,cob,basal}};
}

/** Converts an exported SimEnv bundle (scripts/export.mjs, exportBundle()) into a run record. */
export function runFromBundle(bundle,{id='bundle',scoringVersion='METRICS-v0.3'}={}) {
  const cfg=bundle.manifest.config,t0=Date.parse(cfg.start_time),H=cfg.horizon_minutes/60;
  const minute=iso=>Math.round((Date.parse(iso)-t0)/60000);
  const truth=bundle.evaluator_only.states.map(s=>[minute(s.time),Math.round(s.true_glucose_mg_dl)]);
  const readings=[],treatments=[],iob=[],cob=[],basal=[];let lastReading=null;
  for(const tr of bundle.trajectory) {
    const o=tr.next_observation,m=minute(o.virtual_time);
    iob.push([m,round(o.iob.total_u)]);cob.push([m,round(o.cob.estimate_g,1)]);
    if(o.device?.current_basal_u_h!=null&&cfg.therapy.mode==='pump')basal.push([m,round(o.device.current_basal_u_h,3)]);
    const g=o.glucose??(o.cgm?.value_mg_dl!=null?{time:o.cgm.sample_time,value_mg_dl:o.cgm.value_mg_dl,source:'cgm'}:null);
    if(g&&g.time!==lastReading){lastReading=g.time;readings.push([minute(g.time),Math.round(g.value_mg_dl),g.source]);}
    if(tr.action.type!=='WAIT'&&tr.info.action_result?.status==='applied')
      treatments.push([minute(tr.info.action_result.at??o.virtual_time),tr.action.type,tr.action.units??tr.action.grams??tr.action.rate_u_h??null,tr.rationale]);
  }
  const seen=new Set([bundle.initial_observation,...bundle.trajectory.map(t=>t.next_observation)].flatMap(o=>o?.events??[]).map(e=>e.id).filter(Boolean));
  const projected=cfg.information?.mode&&cfg.information.mode!=='native';
  const events=bundle.evaluator_only.events.map(e=>({...e,
    ...(projected&&['meal','exercise','illness','sleep_loss','stress','alcohol','record'].includes(e.type)?{
      announced:seen.has(e.id),...(e.type==='meal'&&!seen.has(e.id)?{announced_grams:null}:{})}:{}),
    at:typeof e.at==='string'?Date.parse(e.at):e.at,until:typeof e.until==='string'?Date.parse(e.until):e.until}));
  return {format:RUN_FORMAT,id,policy:'recorded',start:cfg.start_time,utc_offset_minutes:cfg.utc_offset_minutes,hours:H,
    ...describe(cfg),actions:bundle.initial_observation?.available_actions??[],
    metrics:{...metricsOf(bundle.metrics),dynamic:episodeMetrics(bundle).dynamic,score:episodeScore(episodeMetrics(bundle),undefined,{version:scoringVersion}).score,scoring_version:scoringVersion},truth,readings,treatments,events:eventsOf(events,t0,H),series:{iob,cob,basal}};
}
