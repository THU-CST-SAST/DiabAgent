// OpenDiabet v1 scenario task cards (docs/OPENDIABET-V1.zh-CN.md §1.3). A card is data (what the task
// tests, its backend variants, scenario parameters, success notes, clean/randomized rules) plus
// `build(ctx)`, which turns a resolved base config into the task's spec changes:
//   {overrides, start_time, mechanics}
// Static fields: person (fixed person variants, e.g. dawn), personTypes, packs (public event packs the
// task enables), excludeBackground, sensor ({clean, randomized} sensor rules), keepsCarbCounting.
// ctx: {cfg (resolved config of the spec before the task layer), family ('pump' | 'pens'), setting
// ('clean' | 'randomized'), rng (setting-level stream), cell (cell-level stream, same for clean and
// randomized), simulate(overrides, hours) -> {obs0, glucose: [[minute, mg/dL]]}, bolusMax, quantBolus}.
// Every value a card writes goes into the instance spec (overrides), so an environment is fully
// described by its spec and rebuilds with buildInstanceConfig alone.

const HHMM=m=>{m=((Math.round(m)%1440)+1440)%1440;return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;};
const MIN=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
const clone=x=>structuredClone(x);
const uniform=(r,a,b)=>a+(b-a)*r.next();
const round5=m=>Math.round(m/5)*5;
const MAIN=['breakfast','lunch','dinner'];

export const CATEGORIES=Object.freeze({
  daily:{zh:'日常',en:'Daily life'},
  events:{zh:'运动与事件',en:'Exercise and life events'},
  extreme_start:{zh:'极端开局',en:'Extreme start'},
  device:{zh:'设备',en:'Device'},
  sensor:{zh:'传感器',en:'Sensor'},
  population:{zh:'人群',en:'Population'},
});

/** Bisection on a monotone decreasing f(x) for f(x) = target over [lo, hi] (n steps). */
function solveDecreasing(f,target,lo,hi,n=9) {
  let a=lo,b=hi,best=null;
  for(let i=0;i<n;i++) {
    const x=(a+b)/2,y=f(x);
    if(!best||Math.abs(y-target)<Math.abs(best.y-target))best={x,y};
    if(y>target)a=x;else b=x;
  }
  return best;
}
const minOver=(glucose,from,to)=>Math.min(...glucose.filter(([m])=>m>=from&&m<=to).map(([,g])=>g));

const notes=(zh,en)=>({zh,en});

export const TASKS=[
  {id:'T01',title:notes('普通的一天','An ordinary day'),category:'daily',
    capability:notes('三餐加餐的常规给药与基础管理','Routine meal dosing and basal management over a normal day'),
    scenario:{},success:notes('TIR 高、无低血糖；餐前或进餐时按报告碳水给药','High TIR without lows; dose announced meals around meal time'),
    build:()=>({})},

  {id:'T02',title:notes('高碳水日（大餐）','High-carb day (large meals)'),category:'daily',
    capability:notes('大剂量的估算与餐后高峰控制','Sizing large boluses and controlling post-meal peaks'),
    scenario:{main_meal_carbs_factor:1.6,max_meal_carbs_g:150},
    success:notes('大餐后峰值受控、不过量导致迟发低血糖','Contain peaks after large meals without late lows from over-dosing'),
    build:({cfg})=>{
      const meals=clone(cfg.scenario.meals);
      for(const k of MAIN)if(meals[k]){const g=Math.min(150,Math.round(meals[k].carbs_g*1.6));meals[k].carbs_g=g;meals[k].carbs_jitter_g=Math.round(g*0.15);}
      return {overrides:{scenario:{meals}},mechanics:{main_meal_carbs:MAIN.filter(k=>meals[k]).map(k=>meals[k].carbs_g)}};
    }},

  {id:'T03',title:notes('高脂餐','High-fat meals'),category:'daily',
    capability:notes('吸收延迟：分次/方波给药（无方波设备如何应对）','Delayed absorption: split or extended boluses (and what to do without them)'),
    scenario:{high_fat_meals:['lunch','dinner'],absorption_x:1.6,extra_glucose_x:1.2,composition_reported:true},
    backend_variants:{pump_pct:notes('可用方波大剂量','Extended bolus available'),pump_abs:notes('无方波：可分次给药或临时基础率','No extended bolus: split doses or temp basal'),
      pump_combo:notes('无方波、不能取消大剂量','No extended bolus, boluses cannot be cancelled'),pens:notes('只能分次注射','Split injections only')},
    success:notes('晚高峰受控且早期不低血糖','Late rise contained without an early low'),
    packs:['high_fat_meals'],
    build:({cfg})=>{
      const meals=clone(cfg.scenario.meals);
      for(const k of Object.keys(meals))meals[k].high_fat_probability=['lunch','dinner'].includes(k)?1:0;
      return {overrides:{scenario:{meals,announcement:{report_composition:true}}},mechanics:{high_fat:['lunch','dinner'].filter(k=>meals[k])}};
    }},

  {id:'T04',title:notes('不规律进食','Irregular eating'),category:'daily',
    capability:notes('迟餐、跳餐、宵夜的应对','Late, skipped and late-night meals'),
    scenario:{breakfast:'skipped',lunch_delay_minutes:'120 (clean) / 90-150',late_snack:'22:45'},
    success:notes('跳餐时不过量（基础合适）、迟餐和宵夜按实际进食给药','No over-dosing around the skipped meal; dose the late meals when they happen'),
    build:({cfg,rng,setting})=>{
      const meals=clone(cfg.scenario.meals),delay=setting==='clean'?120:round5(uniform(rng,90,150));
      if(meals.breakfast)meals.breakfast.probability=0;
      if(meals.lunch)meals.lunch.time=HHMM(Math.min(MIN(meals.lunch.time)+delay,23*60));
      const d=meals.dinner?.carbs_g??60,g=Math.max(20,Math.round(d*0.5));
      meals.late_snack={time:'22:45',carbs_g:g,carbs_jitter_g:Math.round(g*0.15),time_jitter_minutes:15,absorption_minutes:45};
      return {overrides:{scenario:{meals}},mechanics:{breakfast_skipped:true,lunch_time:meals.lunch?.time,late_snack_g:g}};
    }},

  {id:'T05',title:notes('未报告进食','Unannounced meals'),category:'daily',
    capability:notes('只能从血糖曲线推断进食','Infer meals from the glucose curve alone'),
    scenario:{unannounced:['lunch','snack']},
    success:notes('发现未报告的午餐并适度补救，不对噪声过度反应','Detect the unannounced lunch and correct moderately; do not chase noise'),
    packs:['unannounced_meals'],
    build:({cfg})=>{
      const meals=clone(cfg.scenario.meals);
      for(const k of Object.keys(meals))meals[k].announce_probability=k==='lunch'||k==='snack'?0:1;
      return {overrides:{scenario:{meals}},mechanics:{unannounced:Object.keys(meals).filter(k=>k==='lunch'||k==='snack')}};
    }},

  {id:'T06',title:notes('计碳严重偏差','Systematic carb-count error'),category:'daily',
    capability:notes('患者报告的克数系统性偏少或偏多','Reported grams systematically too low or too high'),
    scenario:{model:'normal',bias:'±0.4 (clean) / ±0.3-0.5; direction per cell (65% under-reporting)',sd:0.08},
    success:notes('从餐后反应中识别偏差并调整剂量','Learn the bias from post-meal responses and adjust doses'),
    keepsCarbCounting:true,
    build:({cell,rng,setting})=>{
      const under=cell.next()<0.65,mag=setting==='clean'?0.4:uniform(rng,0.3,0.5),bias=Number(((under?-1:1)*mag).toFixed(3));
      return {overrides:{scenario:{announcement:{probability:1,model:'normal',bias,sd:0.08}}},mechanics:{bias}};
    }},

  {id:'T07',title:notes('有氧运动','Aerobic exercise'),category:'events',
    capability:notes('运动前后减量、低血糖预防','Reduce insulin around exercise and prevent lows'),
    scenario:{time:'17:00 (clean) / 15:00-18:00',duration_minutes:60,accelerometer_counts:3500,advance_notice_minutes:60},
    backend_variants:{pump:notes('可提前设临时基础率','Temp basal ahead of exercise'),pens:notes('只能减餐时剂量或补碳水','Only reduce boluses or eat carbs')},
    success:notes('运动中及之后无低血糖','No low during or after the exercise'),
    build:({rng,setting})=>{
      const t=setting==='clean'?'17:00':HHMM(round5(uniform(rng,15*60,18*60)));
      return {overrides:{scenario:{activity:{enabled:true,probability:1,time:t,time_jitter_minutes:15,duration_minutes:60,accelerometer_counts:3500,announced:true,advance_notice_minutes:60}}},
        mechanics:{time:t}};
    }},

  {id:'T08',title:notes('无氧运动','Anaerobic exercise'),category:'events',
    capability:notes('运动后血糖反升的处理','Handle the glucose rise after high-intensity exercise'),
    scenario:{time:'18:00 (clean) / 16:00-19:00',duration_minutes:45,hepatic_delta_mg_dl_per_min:0.5,advance_notice_minutes:60},
    success:notes('不因运动预防性减量过多；运动后升高适度纠正','Do not over-reduce for exercise; correct the post-exercise rise moderately'),
    packs:['anaerobic_exercise'],
    build:({rng,setting})=>{
      const t=setting==='clean'?'18:00':HHMM(round5(uniform(rng,16*60,19*60)));
      return {overrides:{scenario:{anaerobic:{enabled:true,probability:1,time:t,time_jitter_minutes:15,duration_minutes:45,announced:true,advance_notice_minutes:60}}},
        mechanics:{time:t}};
    }},

  {id:'T09',title:notes('晚间饮酒','Evening alcohol'),category:'events',
    capability:notes('夜间延迟性低血糖风险','Delayed overnight hypoglycaemia risk'),
    scenario:{start_local:'18:00',drink:'21:00 (clean) / 20:00-22:00, reported',effect:'hepatic output -0.3 mg/dL/min from 6 h later for 10 h'},
    success:notes('夜间和次晨无低血糖（睡前减量或加餐）','No overnight or next-morning low (less insulin or a bedtime snack)'),
    packs:['alcohol'],startLocal:'18:00',
    build:({rng,setting})=>{
      const t=setting==='clean'?'21:00':HHMM(round5(uniform(rng,20*60,22*60)));
      return {start_time:'2026-10-14T10:00:00.000Z',overrides:{scenario:{alcohol:{enabled:true,probability:1,time:t,time_jitter_minutes:15,announced:true}}},mechanics:{time:t}};
    }},

  {id:'T10',title:notes('生病','Illness'),category:'events',
    capability:notes('胰岛素需求上升、持续高血糖','Higher insulin needs, persistent hyperglycaemia'),
    scenario:{onset:'08:00 (reported)',insulin_need_increase:0.3,days:'2-3'},
    success:notes('识别需求上升并逐步加量，不发生低血糖','Recognise the higher need and step up insulin without lows'),
    packs:['illness'],
    build:()=>({overrides:{scenario:{illness:{enabled:true,probability_per_day:1,min_days:2,max_days:3,announced:true}}}})},

  {id:'T11',title:notes('睡眠不足','Sleep loss'),category:'events',
    capability:notes('敏感性下降','Lower insulin sensitivity'),
    scenario:{onset:'07:00 (reported)',sensitivity_decrease:0.15,hours:16},
    success:notes('白天适度加量','Moderately more insulin during the day'),
    packs:['sleep_loss'],
    build:()=>({overrides:{scenario:{sleep_loss:{enabled:true,probability:1,announced:true}}}})},

  {id:'T12',title:notes('压力','Stress'),category:'events',
    capability:notes('肝糖输出增加导致的隐性升高','Hidden rise from stress-driven hepatic glucose output'),
    scenario:{time:'10:00 (clean) / 09:00-15:00',duration_minutes:300,hepatic_delta_mg_dl_per_min:0.2,announced:false},
    success:notes('从曲线识别不明原因升高并纠正','Notice and correct an unexplained rise'),
    packs:['stress'],
    build:({rng,setting})=>{
      const t=setting==='clean'?'10:00':HHMM(round5(uniform(rng,9*60,15*60)));
      return {overrides:{scenario:{stress:{enabled:true,probability:1,time:t,time_jitter_minutes:30,duration_minutes:300,hepatic_delta_mg_dl_per_min:0.2}}},mechanics:{time:t}};
    }},

  {id:'T13',title:notes('黄体期','Luteal phase'),category:'events',
    capability:notes('周期性需求上升（只用于女性个体）','Cyclical rise in insulin need (female persons only)'),
    scenario:{cycle_days:28,cycle_day_at_start:'18 (clean) / 16-24',luteal_need_increase:0.15},
    success:notes('全天轻度加量','Slightly more insulin all day'),
    packs:['menstrual'],personTypes:['adolescent_female','adult_female'],
    build:({rng,setting})=>{
      const day=setting==='clean'?18:Math.round(uniform(rng,16,24));
      return {overrides:{scenario:{menstrual:{enabled:true,cycle_days:28,cycle_day_at_start:day,luteal_need_increase:0.15}}},mechanics:{cycle_day_at_start:day}};
    }},

  {id:'T14',title:notes('黎明现象','Dawn phenomenon'),category:'events',
    capability:notes('清晨升高与基础率调整','Early-morning rise and basal adjustment'),
    scenario:{dawn:'present (03:00-10:00)'},
    backend_variants:{pump:notes('清晨临时基础率','Early-morning temp basal'),pens:notes('只能校正大剂量','Correction boluses only')},
    success:notes('清晨升高被及时纠正','Morning rise corrected in time'),
    person:{dawn:'present'},build:()=>({})},

  {id:'T15',title:notes('开局低血糖 / 快速下降','Start: low or falling fast'),category:'extreme_start',
    capability:notes('立即补糖、停止胰岛素、复查','Treat at once, stop insulin, recheck'),
    scenario:{history_minutes:120,history:'correction bolus 90 min before the start (from 150 mg/dL 2 h before), tuned so that waiting reaches ~55 mg/dL within 2 h'},
    success:notes('开局几十分钟内处理，避免严重低血糖','Act within the first minutes; no severe low'),
    build:({simulate,quantBolus,bolusMax})=>{
      const mk=u=>({patient:{initial_glucose_mg_dl:150},initial_state:{history_minutes:120,history:[{type:'bolus',minutes_before:90,units:quantBolus(u)}]}});
      const f=u=>minOver(simulate(mk(u),2).glucose,0,120);
      const best=solveDecreasing(f,55,0.5,bolusMax);
      const o=mk(best.x),r=simulate(o,2);
      return {overrides:o,mechanics:{bolus_u:o.initial_state.history[0].units,start_glucose:Math.round(r.glucose[0][1]),min_2h_wait:Math.round(minOver(r.glucose,0,120))}};
    }},

  {id:'T16',title:notes('开局高血糖且活性胰岛素多','Start: high glucose with lots of insulin on board'),category:'extreme_start',
    capability:notes('避免叠加剂量','Avoid stacking insulin'),
    scenario:{history_minutes:180,history:'unbolused announced meal (1/3 of daily carbs) 150 min before the start, then two correction boluses 60 and 20 min before it, tuned so waiting reaches ~100 mg/dL within 6 h'},
    success:notes('不再追加校正，等待已有胰岛素起效','No extra correction; let the insulin on board work'),
    build:({cfg,simulate,quantBolus,bolusMax})=>{
      const g=Math.max(40,Math.min(100,Math.round((cfg.person?.resolved?.carbs_g_per_day??200)*0.33)));
      const mk=u=>({patient:{initial_glucose_mg_dl:140},initial_state:{history_minutes:180,history:[
        {type:'meal',minutes_before:150,grams:g,announced_grams:g,absorption_minutes:60},
        {type:'bolus',minutes_before:60,units:quantBolus(u)},{type:'bolus',minutes_before:20,units:quantBolus(u)}]}});
      const f=u=>minOver(simulate(mk(u),6).glucose,0,360);
      const best=solveDecreasing(f,100,0.5,bolusMax);
      const o=mk(best.x),r=simulate(o,6);
      return {overrides:o,mechanics:{meal_g:g,bolus_u:o.initial_state.history.filter(h=>h.type==='bolus').map(h=>h.units),start_glucose:Math.round(r.glucose[0][1]),
        start_iob_u:Number(r.obs0.iob.total_u.toFixed(2)),min_6h_wait:Math.round(minOver(r.glucose,0,360))}};
    }},

  {id:'T17',title:notes('开局餐后高峰','Start: post-meal spike'),category:'extreme_start',
    capability:notes('不重复给药、观察回落','Do not dose twice; watch it come down'),
    scenario:{history_minutes:90,history:'announced late meal 40 min before the start (1/3 of daily carbs, 20-100 g, within one device bolus), bolused by the person (reported carbs / profile CR)'},
    success:notes('不重复给药也不发生低血糖','No second meal dose and no low'),
    build:({cfg,simulate,quantBolus,bolusMax})=>{
      const CR=cfg.profile.carb_ratio_g_per_u,carbsDay=cfg.person?.resolved?.carbs_g_per_day??200;
      const g=Math.max(20,Math.min(100,Math.round(carbsDay*0.33),Math.floor(bolusMax*CR*0.9)));   // a meal the device can dose in one bolus
      const u=Math.min(bolusMax,quantBolus(g/CR));
      const o={patient:{initial_glucose_mg_dl:120},initial_state:{history_minutes:90,history:[
        {type:'meal',minutes_before:40,grams:g,announced_grams:g,absorption_minutes:45},{type:'bolus',minutes_before:40,units:u}]}};
      const r=simulate(o,3);
      return {overrides:o,mechanics:{meal_g:g,bolus_u:u,start_glucose:Math.round(r.glucose[0][1]),peak_3h_wait:Math.round(Math.max(...r.glucose.map(x=>x[1])))}};
    }},

  {id:'T18',title:notes('输注故障','Delivery failure'),category:'device',
    capability:notes('泵：管路堵塞（报警前只能从血糖推断）；笔：漏打长效','Pump: infusion-set occlusion (before the alarm only glucose shows it); pens: missed long-acting dose'),
    scenario:{pump:'occlusion at 06:40 (clean) / 03:00-11:00',pens:'last routine long-acting dose before the start missed'},
    backend_variants:{pump:notes('管路堵塞：换管路','Occlusion: change the infusion set'),pens:notes('漏打长效：补打或加校正','Missed long-acting dose: inject it or correct')},
    success:notes('尽早发现并纠正（换管路 / 补长效）','Detect and fix early (set change / make up the long-acting dose)'),
    packs:pump=>pump?['occlusion_faults']:[],excludeBackground:['occlusion_faults'],
    build:({family,rng,setting})=>{
      if(family==='pens')return {overrides:{therapy:{mdi:{missed_doses_before_start:1}}},mechanics:{missed_long_acting_doses:1}};
      const at=setting==='clean'?400:round5(uniform(rng,180,660));
      return {overrides:{faults:{occlusion_rate_per_day:0,occlusions:[{at_minute:at}]}},mechanics:{occlusion_at_minute:at}};
    }},

  {id:'T19',title:notes('泵暂停后未恢复 / 长效打错时间','Pump left suspended / mistimed long-acting dose'),category:'device',
    capability:notes('发现并纠正设备状态','Notice and correct the device state'),
    scenario:{pump:'suspended 60 min before the start for 8 h (clean) / 5-10 h',pens:'an extra long-acting dose 30 min (clean) / 20-90 min before the start, on top of the routine one'},
    backend_variants:{pump:notes('恢复泵（RESUME_PUMP）','Resume the pump (RESUME_PUMP)'),pens:notes('多打了长效：减量、补碳水、密切观察','Extra long-acting dose: less insulin, carbs, watch closely')},
    success:notes('尽早恢复胰岛素输注 / 防止长效过量引起低血糖','Resume delivery early / prevent lows from the extra long-acting dose'),
    excludeBackground:['occlusion_faults'],
    build:({family,cfg,rng,setting})=>{
      if(family==='pens') {
        const u=cfg.therapy.mdi.basal_dose_u,mb=setting==='clean'?30:round5(uniform(rng,20,90));
        return {overrides:{therapy:{mdi:{extra_doses_before_start:[{minutes_before:mb,units:u}]}}},mechanics:{extra_long_acting_u:u,minutes_before:mb}};
      }
      const m=setting==='clean'?480:round5(uniform(rng,300,600));
      return {overrides:{initial_state:{history_minutes:60,history:[{type:'suspend_pump',minutes_before:60,minutes:m}]}},mechanics:{suspended_minutes_total:m,remaining_at_start:m-60}};
    }},

  {id:'T20',title:notes('传感器预热与中断','Sensor warm-up and signal loss'),category:'sensor',
    capability:notes('数据空窗期的决策（主动测指尖血）','Decisions while readings are missing (fingersticks)'),
    scenario:{sensor_expiry:'06:00 (clean) / 04:00-10:00, then warm-up',forced_gap:'13:00 for 90 min (clean) / 11:00-16:00 for 60-120 min',meter:'required'},
    success:notes('空窗期用指尖血补足信息，不盲目给药','Use fingersticks during gaps; no blind dosing'),
    sensor:{clean:{profile:'cgm_rt',cgm:'dexcom_g6',meter:'contour_next_one'},randomized:{profiles:['cgm_rt'],meter:'required'}},
    build:({cfg,rng,setting,wearDays})=>{
      const wear=wearDays(cfg.cgm.model);
      const expiry=setting==='clean'?360:round5(uniform(rng,240,600));
      const gapAt=setting==='clean'?780:round5(uniform(rng,660,960)),gapLen=setting==='clean'?90:round5(uniform(rng,60,120));
      const age=Number((wear-expiry/1440).toFixed(6));
      return {overrides:{cgm:{sensor_age_days_at_start:age,forced_gaps:[{at_minute:gapAt,duration_minutes:gapLen}]}},
        mechanics:{sensor_expiry_minute:expiry,gap:{at_minute:gapAt,duration_minutes:gapLen}}};
    }},

  {id:'T21',title:notes('需要校准的 CGM','CGM that needs calibration'),category:'sensor',
    capability:notes('校准过期时先测再校准','Calibrate when the calibration is overdue'),
    scenario:{calibration_overdue_at_start:true,routine_checks:['07:00','19:00']},
    success:notes('开局即校准，恢复读数','Calibrate at the start to get readings back'),
    sensor:{clean:{profile:'cgm_calibrated',cgm:'dexcom_g5',meter:'contour_next_one'},randomized:{profiles:['cgm_calibrated'],meter:'required'}},
    build:()=>({overrides:{cgm:{calibration_overdue_at_start:true}},mechanics:{calibration_overdue_at_start:true}})},

  {id:'T22',title:notes('扫描式传感器','Flash sensor'),category:'sensor',
    capability:notes('主动扫描的时机','When to scan'),
    scenario:{sensor:'flash (scan to read)',routine:'4 scans/day (clean) / flash_frequent or flash_sparse'},
    success:notes('在关键时刻（餐前、餐后、夜间）扫描','Scan at the moments that matter (meals, night)'),
    sensor:{clean:{profile:'flash_sparse',cgm:'libre_1_scan',meter:null},randomized:{profiles:['flash_frequent','flash_sparse'],meter:'optional'}},
    build:()=>({})},

  {id:'T23',title:notes('只有指尖血','Fingerstick meter only'),category:'sensor',
    capability:notes('稀疏观测下的给药（先测再打）','Dosing with sparse readings (measure, then dose)'),
    scenario:{sensor:'meter only',routine:'before meals and bedtime (clean) / smbg_intensive, smbg_standard or smbg_sparse'},
    success:notes('给药前测血糖，夜间安全','Measure before dosing; safe nights'),
    sensor:{clean:{profile:'smbg_standard',cgm:null,meter:'contour_next_one'},randomized:{profiles:['smbg_intensive','smbg_standard','smbg_sparse'],meter:'required'}},
    build:()=>({})},

  {id:'T24',title:notes('儿童','Child'),category:'population',
    capability:notes('小剂量、高敏感、剂量步长限制','Small doses, high sensitivity, dose-step limits'),
    scenario:{person_types:['child_male','child_female']},
    success:notes('剂量按步长取整后仍安全','Safe after rounding to the device step'),
    personTypes:['child_male','child_female'],
    build:()=>({})},

  {id:'T25',title:notes('老年','Older adult'),category:'population',
    capability:notes('低血糖风险高、计碳较差','High hypoglycaemia risk, poor carb counting'),
    scenario:{person_types:['older_male','older_female'],carb_counting:'poor'},
    success:notes('偏保守、避免低血糖','Conservative dosing; avoid lows'),
    personTypes:['older_male','older_female'],keepsCarbCounting:true,
    person:{carb_counting:'poor'},build:()=>({})},
];
export const TASK_IDS=TASKS.map(t=>t.id);
export const taskById=id=>{const t=TASKS.find(x=>x.id===id);if(!t)throw new Error(`Unknown task ${id}; one of ${TASK_IDS.join(', ')}`);return t;};
/** Public event packs a task enables (visible in public.json as possible events). */
export const taskPacks=(task,family)=>typeof task.packs==='function'?task.packs(family==='pump'):task.packs??[];
