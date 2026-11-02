import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildInstanceConfig} from '../sim/instance.mjs';
import {SimEnv} from '../env/pomdp.mjs';
import {buildBenchmark} from '../benchmark/build.mjs';
import {trueGrid,episodeMetrics,episodeScore} from '../bench/score.mjs';

export const PROTOCOL='scenario-factors/v2-metrics-v03';
export const PRESETS={
  A01:['餐时给药后迟餐',['R01']],A02:['实际摄入少于原计划',['R01']],
  A03:['主餐和甜点分段摄入',['R01','R02']],A04:['午餐推迟而晚餐照常',['R01','R02']],
  B01:['慢吸收餐叠加已有速效作用',['R02']],B02:['晚间混合餐后段叠加黎明需求',['R02','R03']],
  B03:['上一餐未吸收完再次进食',['R02']],B04:['已补碳但尚未充分吸收',['R01','R02']],
  C01:['餐后药效较强时运动',['R04']],C02:['空腹运动遇到此前纠正剂量',['R04']],
  C03:['傍晚和次晨两次活动',['R05']],C04:['活动持续且下一餐延迟',['R04','R05']],
  D01:['疾病相关需求变化同时摄入减少',['R08']],D02:['需求恢复但追加药效仍在',['R08']],
  D03:['缺觉与清晨需求重叠',['R06','R03']],D04:['应激结束但此前纠正仍起效',['R07']],
  E01:['餐前开始输注不足',['R09']],E02:['泵暂停后遇到进食',['R10']],
  E03:['延长大剂量期间输注中断',['R09']],E04:['故障解除与治疗残余交互',['R09']],
  F01:['进食与CGM中断重叠',['R12']],F02:['压迫相关伪低',['R11']],
  F03:['测量偏差叠加真实变化',['R12','R13']],F04:['餐后阶段校准异常',['R12','R13']],
};
export const MODES=['I0','I1','I2'];
const clone=structuredClone;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v);
export const merge=(a,b)=>Object.fromEntries([...new Set([...Object.keys(a),...Object.keys(b)])].map(k=>
  [k,k in b?obj(a[k])&&obj(b[k])?merge(a[k],b[k]):clone(b[k]):clone(a[k])]));
const meal=(id,at,grams,absorption=60)=>({id,type:'meal',at_minute:at,grams,announced_grams:grams,absorption_minutes:absorption});
const exercise=(id,at,duration=45)=>({id,type:'exercise',at_minute:at,duration_minutes:duration,accelerometer_counts:2095,announced:true});
const record=(id,at,category,text)=>({id,type:'record',at_minute:at,category,text});

/** Explicit, deterministic event scripts. No reward search, dose inversion or outcome filtering. */
export function constructScenario({preset,seed=20261017,startTime='2026-10-17T04:00:00.000Z',patient={},person=null,therapy={},sensors={},hours=24,overrides={}}={}) {
  if(!PRESETS[preset])throw new Error(`Unknown preset ${preset}; choose ${Object.keys(PRESETS).join(',')}`);
  const spec={seed,start_time:startTime,horizon_minutes:Math.round(hours*60),
    ...(person?{person:{type:person,sample:false,seed}}:{}),
    therapy:merge({mode:'pump',pump:{model:'dana_i',insulin:'aspart'}},therapy),
    sensors:merge({cgm:'medtronic_guardian_3',meter:'contour_next_one'},sensors),events:['baseline'],self_care:'none',
    overrides:{patient:{...(!person?{sex:'male',age_years:39,height_cm:170,weight_kg:66}:{}),...patient},
      physiology:{daily_sensitivity_cv:0},controller:{enabled:false},
      cgm:{error_draw:'median',sensor_age_days_at_start:2,gaps:{start_probability_per_sample:0}},meter:{routine_times:[]},
      scenario:{meals:{},activity:{enabled:false},stress:{enabled:false},
        announcement:{information_mode:'complete',carb_error_fraction:0},extra_events:[]},
      initial_state:{history_minutes:360,history:[]}}};
  const o=spec.overrides,events=[meal('lunch',60,55),meal('dinner',420,60),meal('breakfast',1200,45)],hist=o.initial_state.history;
  const bolus=(minutes_before,units)=>hist.push({type:'bolus',minutes_before,units});
  const previousMeal=(minutes_before,grams,absorption_minutes=90)=>hist.push({type:'meal',minutes_before,grams,announced_grams:grams,absorption_minutes});
  const ill=(at,duration_hours,increase)=>events.push({id:'illness',type:'illness',at_minute:at,duration_hours,insulin_need_increase:increase,announced:true});
  const faultReport=(at,text)=>events.push(record('fault-confirmed',at,'fault',text));
  const notes=[];
  switch(preset) {
    case 'A01':bolus(15,5.5);events[0].at_minute=75;notes.push('Historical 5.5 U for planned 55 g lunch; actual intake starts 90 minutes after dosing.');break;
    case 'A02':bolus(15,5.5);events[0]=meal('lunch',10,25);notes.push('Planned 55 g, actually 25 g; known prior 5.5 U, no fabricated intake.');break;
    case 'A03':events[0]=meal('lunch',30,40);events.push(meal('dessert',120,30,45));break;
    case 'A04':events[0]=meal('lunch',300,65,150);events[1]=meal('dinner',420,55,100);break;
    case 'B01':bolus(15,5.5);events[0]=meal('lunch',10,55,200);notes.push('Long absorption is a proxy for mixed-meal kinetics, not validated fat/protein metabolism.');break;
    case 'B02':events[1]=meal('late-mixed-meal',720,75,240);o.physiology.dawn_fraction=.25;notes.push('Late meal tail and dawn factor; amplitude is a frozen research assumption.');break;
    case 'B03':events[0]=meal('lunch',10,65,200);events.push(meal('second-intake',110,35,100));break;
    case 'B04':bolus(50,4);hist.push({type:'carbs',minutes_before:5,grams:15});events[0]=meal('lunch',90,45);notes.push('Rescue carbs enter the same real absorption compartments, not merely a display log.');break;
    case 'C01':previousMeal(40,50);bolus(55,5);events.push(exercise('postmeal-activity',20,60));break;
    case 'C02':bolus(40,2);o.patient.initial_glucose_mg_dl=190;events.push(exercise('fasting-activity',10,60));events[0].at_minute=150;break;
    case 'C03':events.push(exercise('evening-activity',390,60),exercise('morning-activity',1170,45));break;
    case 'C04':events.push(exercise('prolonged-activity',10,120));events[0].at_minute=180;break;
    case 'D01':ill(0,24,.4);events[0].grams=events[0].announced_grams=25;events[1].grams=events[1].announced_grams=30;events[2].grams=events[2].announced_grams=25;break;
    case 'D02':ill(0,2,.4);bolus(30,2);o.patient.initial_glucose_mg_dl=180;notes.push('Need returns at hour 2; initial correction remains in PK compartments. Abrupt recovery is a model assumption.');break;
    case 'D03':events.push({id:'sleep-loss',type:'sleep_loss',at_minute:0,duration_minutes:1080,sensitivity_decrease:.15,announced:true});o.physiology.dawn_fraction=.25;break;
    case 'D04':events.push({id:'acute-stress',type:'stress',at_minute:0,duration_minutes:120,hepatic_delta_mg_dl_per_min:.3});bolus(30,2);o.patient.initial_glucose_mg_dl=180;break;
    case 'E01':o.faults={occlusions:[{at_minute:20}]};notes.push('Complete interruption uses the existing queue/occlusion alarm model, not partial-flow resistance.');break;
    case 'E02':hist.push({type:'suspend_pump',minutes_before:30,minutes:180});break;
    case 'E03':hist.push({type:'extended_bolus',minutes_before:30,units:4,duration_minutes:180});o.faults={occlusions:[{at_minute:45}]};break;
    case 'E04':bolus(180,4);hist.push({type:'occlusion',minutes_before:120});events.push({id:'fault-recovery',type:'infusion_recovery',at_minute:60});faultReport(60,'A previously diagnosed infusion interruption has been cleared; inspect current delivery and recorded insulin before further dosing.');break;
    case 'F01':o.cgm.forced_gaps=[{at_minute:45,duration_minutes:90}];faultReport(135,'CGM communication recovered after a signal interruption.');break;
    case 'F02':o.cgm.compression_lows=[{at_minute:90,duration_minutes:60,depth_mg_dl:80}];faultReport(150,'Person reports pressure on the sensor during the preceding low-reading episode; independent meter measurement is available.');break;
    case 'F03':events.push({id:'sensor-bias',type:'sensor_bias',at_minute:45,duration_minutes:150,bias_mg_dl:-35});faultReport(200,'Sensor bias was confirmed by an independent measurement comparison.');break;
    case 'F04':events.push({id:'bad-calibration',type:'sensor_calibration_error',at_minute:90,bias_mg_dl:30});faultReport(95,'Recent calibration used an erroneous meter value; recheck with an independent measurement.');break;
  }
  o.scenario.extra_events=events.sort((a,b)=>a.at_minute-b.at_minute||a.id.localeCompare(b.id));
  // Valid starting calibration is real pre-episode care, not a future calibration oracle.
  if(['medtronic_guardian_3','dexcom_g5'].includes(spec.sensors.cgm))hist.push({type:'calibrate_cgm',minutes_before:5});
  spec.overrides=merge(o,overrides);
  const cfg=buildInstanceConfig(spec);
  if(preset.startsWith('E')&&cfg.therapy.mode!=='pump')throw new Error(`${preset} requires a pump`);
  if(preset==='E03'&&!new SimEnv(cfg).device.spec.extended)throw new Error('E03 requires extended-bolus capability');
  if(preset==='F04'&&!new SimEnv(cfg).cgm?.calibration)throw new Error('F04 requires a calibratable sensor; choose Guardian 3 or Dexcom G5');
  const category=preset.startsWith('C')?'exercise':preset.startsWith('D')?'life':preset.startsWith('F')||preset==='E04'?'fault':'meal';
  const rules=category==='meal'?[{category,ids:[events.find(e=>e.type==='meal').id]}]:[{category}];
  return {preset,title:PRESETS[preset][0],evidence:PRESETS[preset][1],spec,rules,notes,
    construction:{protocol:PROTOCOL,source_commit:'60adb4c67e5c808c989906c8dbae42f4ff4c306c',
      no_outcome_filtering:true,initial_history:clone(hist),events:clone(spec.overrides.scenario.extra_events),
      model_limits:['Evidence supports event families, not the chosen coefficients or cross-factor interactions.',...notes]}};
}

export function scenarioVariants(options) {
  const base=constructScenario(options);
  return {...base,variants:Object.fromEntries(MODES.map(mode=>[mode,merge(base.spec,{overrides:{information:{mode,rules:mode==='I1'?base.rules:[]}}})]))};
}
export function fixedActionEpisode(spec,{actionAt=null}={}) {
  const env=new SimEnv(buildInstanceConfig(spec));
  while(!env.done())env.step({action_id:`audit-${env.step_count}`,expected_step:env.step_count,action:actionAt?.(env)??{type:'WAIT'}});
  return env.exportBundle();
}
export function auditScenario(row,{requireDistinct=true}={}) {
  const bundles=MODES.map(m=>fixedActionEpisode(row.variants[m]));
  const grids=bundles.map(trueGrid),truthHashes=grids.map(hash);
  assert.ok(bundles.every(b=>b.metrics.completed_horizon),`${row.preset}: fixed-action episode did not complete the horizon`);
  assert.ok(grids.every(g=>g.length===row.spec.horizon_minutes/5&&g.every((p,i)=>p.m===i*5&&Number.isFinite(p.g))),
    `${row.preset}: incomplete or non-finite true glucose grid`);
  assert.equal(new Set(truthHashes).size,1,`${row.preset}: information changed fixed-action physiology`);
  const projection=bundles.map(b=>[b.initial_observation,...b.trajectory.map(x=>x.next_observation)].map(o=>
    ({events:o.events,carbs:o.reported_carbs,ledger:o.device.insulin_ledger}))),projectionHashes=projection.map(hash);
  if(requireDistinct)assert.equal(new Set(projectionHashes).size,3,`${row.preset}: duplicate information projections`);
  assert.ok(grids[0].length===row.spec.horizon_minutes/5,`${row.preset}: missing true glucose samples`);
  return {preset:row.preset,completed_horizon:true,finite_grid:true,truth_sha256:truthHashes[0],information_projection_sha256:Object.fromEntries(MODES.map((m,i)=>[m,projectionHashes[i]])),
    grid_points:grids[0].length,max_truth_difference_mgdl:Math.max(...grids.flatMap(g=>g.map((p,i)=>Math.abs(p.g-grids[0][i].g)))),
    wait_score:episodeScore(episodeMetrics(bundles[0])).score,wait_dynamic:episodeMetrics(bundles[0]).dynamic};
}

export function buildScenarios(outDir,{presets=Object.keys(PRESETS),audit=true,onProgress=()=>{},...options}={}) {
  const rows=presets.map(preset=>scenarioVariants({...options,preset})),audits=[];
  if(audit)for(const row of rows){audits.push(auditScenario(row));onProgress(`mechanics and information audit: ${row.preset}`);}
  const manifest=buildBenchmark({name:'scenario24-v2',version:'2.0',outDir,title:'24 explicit event scripts, three record-availability modes',
    description:'Harbor full-care, fixed subject/hardware, METRICS-v0.3. Simulation only. No outcome-based selection.',
    experiments:MODES.map(mode=>({id:mode.toLowerCase(),track:'full',references:false,repeats:1,
      tasks:rows.map(r=>({task_id:`${r.preset.toLowerCase()}-${mode.toLowerCase()}`,spec:r.variants[mode],hours:r.spec.horizon_minutes/60,
        factors:{preset:r.preset,family:r.preset[0],information:mode},
        metadata:{instance_id:r.preset,pair_id:r.preset,information:mode,title_zh:r.title,protocol:PROTOCOL}}))}))});
  fs.writeFileSync(path.join(outDir,'construction.json'),JSON.stringify({protocol:PROTOCOL,options,rows,audits},null,2)+'\n');
  return {manifest,rows,audits};
}
