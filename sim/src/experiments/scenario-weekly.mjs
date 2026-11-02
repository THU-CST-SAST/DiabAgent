import {createHash} from 'node:crypto';
import {planScenarioPipeline} from './scenario-pipeline.mjs';
import {Rng} from '../core/rng.mjs';

export const WEEKLY_VERSION='v4.3-weekly-r1';
const DAY=1440,WEEK=7*DAY,copy=structuredClone,round=x=>5*Math.round(x/5);
const hash=x=>createHash('sha256').update(x).digest('hex');

function independentRoutineTimes({dailyMeals,events,history,cgm,seed,id}) {
  const windows=[];
  const boundary=(minute,width=180)=>windows.push([minute-width,minute+width]);
  const exposure=(minute,duration=360)=>windows.push([minute,minute+duration]);
  for(const e of events) {
    if(e.type==='meal')continue;
    if(e.type==='record') {
      if(['life','fault'].includes(e.category))boundary(e.at_minute);
      continue;
    }
    if(e.type==='patient_treatment') {
      exposure(e.at_minute,e.action.type==='EXTENDED_BOLUS'?e.action.duration_minutes+360:360);
      continue;
    }
    boundary(e.at_minute);
    if(e.type==='alcohol') {
      boundary(e.at_minute+60*e.onset_hours);
      boundary(e.at_minute+60*(e.onset_hours+e.duration_hours));
    } else {
      const duration=e.duration_minutes??(e.duration_hours==null?null:60*e.duration_hours);
      if(duration!=null)boundary(e.at_minute+duration);
    }
  }
  for(const e of history)if(e.type!=='calibrate_cgm')exposure(-e.minutes_before,
    e.type==='extended_bolus'?e.duration_minutes+360:360);
  for(const e of [...(cgm.forced_gaps??[]),...(cgm.compression_lows??[])]) {
    boundary(e.at_minute);boundary(e.at_minute+e.duration_minutes);
  }
  const guarded=minute=>windows.some(([from,to])=>minute>=from&&minute<=to);
  const adjustments=[];
  for(let day=0;day<7;day++) {
    const meals=dailyMeals.filter(m=>m.day===day).sort((a,b)=>a.event.at_minute-b.event.at_minute);
    for(const [index,{event,original}] of meals.entries()) {
      const before=event.at_minute;
      const jitter=round(Rng.stream(seed,`v43-weekly-r2/${id}/d${day}/${original.id}/time`).symmetric(30));
      const lower=index===0?day*DAY:meals[index-1].event.at_minute+5;
      const upper=index===meals.length-1?(day+1)*DAY-5:meals[index+1].event.at_minute-5;
      const candidate=Math.min(upper,Math.max(lower,day*DAY+original.at_minute+jitter));
      const protect=guarded(before)||guarded(candidate);
      if(!protect) {
        event.at_minute=candidate;
        const plan=events.find(e=>e.id===`${event.id}-plan`);
        if(plan) {
          plan.at_minute=Math.max(day*DAY,candidate-35);
          // The caller refreshes this one derived plan's timestamp after choosing the new time.
          adjustments.push({id:event.id,day:day+1,before,after:candidate,protected:false,plan_id:plan.id});
          continue;
        }
      }
      adjustments.push({id:event.id,day:day+1,before,after:event.at_minute,protected:protect});
    }
  }
  return adjustments;
}

// Counts are preregistered stress-protocol choices, not population incidence estimates.
export const WEEKLY_RULES={
  A01:['daily',7,'每日多次摄入，保留慢主餐与后续输入交叠'],
  A02:['daily',7,'每日两次慢餐及后续摄入，吸收状态跨日连续'],
  A03:['package',3,'三次预打后取消主餐与活动的关联组合'],
  A04:['package',4,'四次缺觉代理，黎明项仍每日发生'],
  B01:['history',3,'三次慢餐与近期给药组合，不能重置既往状态'],
  B02:['package',3,'三次叠加给药、小餐和活动组合'],
  B03:['history',3,'三次延长输注后取消主餐，剩余输注真实继续'],
  B04:['history',3,'三次既往给药及救援补碳、主餐延后组合'],
  C01:['package',3,'三个活动日，每日两段活动，共六段'],
  C02:['package',2,'两个混合活动日，每次保留肝糖正扰动后有氧的顺序'],
  C03:['package',2,'两个活动及饮酒组合日，延迟肝糖项跨夜继续'],
  C04:['package',2,'两个跨晚间及次晨活动组合，共六段'],
  D01:['package',3,'三个应激日，每日两次应激及消退后的活动'],
  D02:['package',4,'四次缺觉及恢复后活动，日常黎明项不取消'],
  D03:['daily',7,'每日黎明需求与快慢摄入衔接'],
  D04:['package',4,'四次缺觉恢复窗口叠加餐食慢尾'],
  D05:['package',3,'三个应激日，每日保留两段餐后应激'],
  D06:['package',2,'两次饮酒延迟项，与当晚慢餐及次晨摄入相交'],
  E01:['fault',3,'三次长时静默送达不足，可由 Agent 提前修复'],
  E02:['rotating',5,'一周五次间歇送达不足，轮换原三种持续时间和送达比例'],
  E03:['package',3,'三次送达不足、外源修复及后续活动组合'],
  E04:['package',3,'三次送达不足叠加渐进伪高'],
  F01:['package',2,'两个传感器异常日，共四次伪高并保留活动'],
  F02:['package',3,'三个传感器异常日，共三次负漂移和三次压迫伪低'],
  F03:['rotating',5,'一周五次断流，轮换原三种缺口；活动在其中三个日程发生'],
  F04:['illness',1,'一次约两天需求上升，恢复前错误校准、恢复时漂移'],
  F05:['history',3,'初始校准将过期；三次慢餐与近期给药，后续沿用真实校准有效期'],
  F06:['package',4,'四次晨间漂移，漂移结束后真实午晚餐照常'],
  H01:['illness',1,'一次约三天需求上升，正常摄入，恢复窗口保留慢餐'],
  H02:['illness',1,'一次约两天需求上升并低摄入，发病前慢餐与治疗真实回放'],
  H03:['illness',1,'一次约两天需求上升，食欲比需求晚四至八小时恢复'],
  H04:['illness',1,'一次约三天需求上升，期间两次部分送达不足及外源修复'],
};

export function weeklyPipeline(catalog,{seed=20261020,revision='r1'}={}) {
  if(!['r1','r2'].includes(revision))throw Error('Weekly revision must be explicit r1 or r2');
  const version=revision==='r1'?WEEKLY_VERSION:'v4.3-weekly-r2';
  const unit=key=>parseInt(hash(`${WEEKLY_VERSION}/${seed}/${key}`).slice(0,8),16)/2**32;
  const between=(key,a,b)=>a+(b-a)*unit(key);
  const select=(key,n,includeZero=false)=>{
    const pool=Array.from({length:7},(_,i)=>i).filter(d=>!includeZero||d!==0)
      .sort((a,b)=>unit(`${key}/${a}`)-unit(`${key}/${b}`));
    return [...(includeZero?[0]:[]),...pool.slice(0,n-(includeZero?1:0))].sort((a,b)=>a-b);
  };
  const calendars=[];
  const scenarios=catalog.cards.map(card=>{
    const id=card.id.slice(-3),rule=WEEKLY_RULES[id];
    if(!rule)throw Error(`Missing explicit weekly rule: ${id}`);
    const spec=copy(card.instance_spec),o=spec.overrides,old=copy(o.scenario.extra_events);
    spec.seed=seed;spec.horizon_minutes=WEEK;
    spec.therapy.pump={...spec.therapy.pump,refill_every_days:3,refill_time:'20:00'};
    // Keep native sensor age, automatic replacement, warm-up and calibration behaviour.
    delete o.information;delete o.cgm.forced_gaps;delete o.cgm.compression_lows;
    const history=copy(o.initial_state.history),events=[],dailyMeals=[];
    const days=select(id,rule[1],['package','history'].includes(rule[0])&&history.some(e=>e.type!=='calibrate_cgm'));
    const shifts=Array.from({length:7},(_,d)=>round(between(`${id}/day/${d}/shift`,-20,20)));
    const at=(d,m)=>d*DAY+Math.max(0,m+shifts[d]);
    const add=e=>{if(e.at_minute>=0&&e.at_minute<WEEK)events.push(e);};
    const cloned=(e,d)=>({...copy(e),id:`d${d}-${e.id}`,at_minute:at(d,e.at_minute)});
    const record=(id,minute,category,text)=>add({id,type:'record',at_minute:minute,category,text});
    let illness=null,appetiteEnd=null;
    if(rule[0]==='illness') {
      const original=old.find(e=>e.type==='illness');
      const day=Math.floor(between(`${id}/ill-day`,1,3));
      const duration=round(between(`${id}/ill-duration`,id==='F04'?36:48,id==='F04'?48:72));
      const onset=at(day,original.at_minute),end=onset+duration*60;
      illness={onset,end,duration_hours:duration};
      appetiteEnd=end+(id==='H03'?round(between(`${id}/appetite-lag`,240,480)):0);
      add({...copy(original),id:'weekly-illness',at_minute:onset,duration_hours:duration});
      record('illness-recovery',end,'life',id==='H03'
        ?'The person reports improvement in illness; appetite has not recovered yet.'
        :'The person reports that the illness is improving. This is not a measurement of insulin sensitivity.');
      if(id==='H03')record('appetite-recovery',appetiteEnd,'life','Appetite has returned; actual meals are recorded separately.');
      if(id==='F04')for(const e of old.filter(e=>['sensor_calibration_error','sensor_drift'].includes(e.type)))
        add({...copy(e),id:`weekly-${e.id}`,at_minute:end+(e.type==='sensor_calibration_error'?-30:0)});
      if(id==='H04')for(let i=0;i<2;i++) {
        const start=onset+(i===0?120:26*60)+round(between(`${id}/fault/${i}`,-30,30));
        add({id:`weekly-loss-${i}`,type:'infusion_deficit',at_minute:start,duration_minutes:240,delivered_fraction:.5});
        record(`weekly-site-${i}`,start,'fault','The person reports damp adhesive or a loose line; the device display may still indicate operation.');
        add({id:`weekly-repair-${i}`,type:'infusion_recovery',at_minute:start+240});
        record(`weekly-repaired-${i}`,start+240,'fault','The infusion site has been treated. Previously lost insulin is not delivered retroactively.');
      }
    }
    const meals=old.filter(e=>e.type==='meal');
    for(let d=0;d<7;d++)for(const original of meals) {
      const meal=cloned(original,d),factor=between(`${id}/day/${d}/${original.id}/grams`,.9,1.1);
      let grams=original.grams;
      if(['H02','H03'].includes(id)) {
        const low=meal.at_minute>=illness.onset&&meal.at_minute<appetiteEnd;
        if(!low)grams=Math.max(40,Math.min(65,grams*2));
      }
      meal.grams=Math.max(1,Math.round(grams*factor));
      meal.announced_grams=original.announced_grams===null?null:Math.round(meal.grams*original.announced_grams/original.grams);
      add(meal);
      dailyMeals.push({day:d,event:meal,original});
      const clock=new Date(Date.parse(spec.start_time)+(meal.at_minute+480)*60000).toISOString().slice(0,16);
      record(`${meal.id}-plan`,Math.max(d*DAY,meal.at_minute-35),'meal',
        `Current intention: approximately ${meal.announced_grams??meal.grams} g carbohydrate around ${clock} local; `
        +`${meal.absorption_minutes>100?'mixed meal reported high in fat/protein':'ordinary meal'}. Timing and actual intake may change; this is not a future glucose prediction.`);
    }
    const nonmeal=old.filter(e=>e.type!=='meal'&&e.type!=='record');
    if(!illness) {
      if(id==='E02')for(const [i,d] of days.entries())add(cloned(nonmeal[i%nonmeal.length],d));
      else if(id==='F03') {
        const gaps=card.instance_spec.overrides.cgm.forced_gaps;
        o.cgm.forced_gaps=days.map((d,i)=>({...copy(gaps[i%gaps.length]),at_minute:at(d,gaps[i%gaps.length].at_minute)}));
        for(const d of days.slice(0,3))for(const e of nonmeal)add(cloned(e,d));
      } else for(const d of days)for(const e of nonmeal)add(cloned(e,d));
      if(id==='F02')o.cgm.compression_lows=days.flatMap(d=>card.instance_spec.overrides.cgm.compression_lows.map(e=>({...copy(e),at_minute:at(d,e.at_minute)})));
      for(const d of days)for(const e of old.filter(e=>e.type==='record'&&!(e.category==='meal'&&e.id.startsWith('plan-'))&&!e.id.startsWith('plan-activity')))
        add(cloned(e,d));
    }
    const futureHistory=(h,minute,index)=>{
      if(h.type==='meal')add({id:`history-meal-${index}`,type:'meal',at_minute:minute,grams:h.grams,
        announced_grams:h.announced_grams??h.grams,absorption_minutes:h.absorption_minutes??60});
      else {
        const action=h.type==='bolus'?{type:'BOLUS',units:h.units}:h.type==='carbs'?{type:'INGEST_CARBS',grams:h.grams}
          :h.type==='extended_bolus'?{type:'EXTENDED_BOLUS',units:h.units,duration_minutes:h.duration_minutes}:null;
        if(!action)throw Error(`Unsupported repeating patient input: ${h.type}`);
        add({id:`patient-input-${index}`,type:'patient_treatment',at_minute:minute,action,announced:true});
      }
    };
    const inputs=history.filter(e=>e.type!=='calibrate_cgm');
    if(id==='H02') {
      o.initial_state.history=history.filter(e=>e.type==='calibrate_cgm');
      inputs.forEach((h,i)=>futureHistory(h,illness.onset-120-h.minutes_before,`ill-${i}`));
    } else if(inputs.length)for(const d of days.filter(d=>d>0))inputs.forEach((h,i)=>futureHistory(h,at(d,0)-h.minutes_before,`${d}-${i}`));
    const timing=revision==='r2'?independentRoutineTimes({dailyMeals,events,history:o.initial_state.history,cgm:o.cgm,seed,id}):null;
    if(timing)for(const change of timing.filter(change=>change.plan_id&&change.before!==change.after)) {
      const meal=events.find(e=>e.id===change.id),plan=events.find(e=>e.id===change.plan_id);
      const clock=new Date(Date.parse(spec.start_time)+(meal.at_minute+480)*60000).toISOString().slice(0,16);
      plan.text=`Current intention: approximately ${meal.announced_grams??meal.grams} g carbohydrate around ${clock} local; `
        +`${meal.absorption_minutes>100?'mixed meal reported high in fat/protein':'ordinary meal'}. Timing and actual intake may change; this is not a future glucose prediction.`;
    }
    o.scenario.extra_events=events.sort((a,b)=>a.at_minute-b.at_minute||a.id.localeCompare(b.id));
    const calendar={id,source_id:card.id,title:card.title,rule:rule[2],selected_days:days.map(d=>d+1),
      daily_shift_minutes:shifts,illness,appetite_end_minute:appetiteEnd,evidence:card.evidence,
      history:o.initial_state.history,events:o.scenario.extra_events,sensor_intervals:{forced_gaps:o.cgm.forced_gaps??[],compression_lows:o.cgm.compression_lows??[]},
      instance_spec_sha256:hash(JSON.stringify(spec)),...(timing?{timing_adjustments:timing}: {})};
    calendars.push(calendar);
    return {id:id.toLowerCase(),case_id:`w43-${revision==='r2'?'r2-':''}${id.toLowerCase()}`,family:card.family,title:card.title,
      exact_spec:true,spec,partial_rules:copy(card.partial_rules),evidence:copy(card.evidence),
      requires_calibration:['F04','F05'].includes(id)};
  });
  const config={format:'sweet-sim.scenario-pipeline/v1',name:`scenario32-v43-weekly-${revision}`,
    title:`v4.3 weekly ${revision}: continuous seven days, fixed hourly decisions`,hours:168,
    family_names:Object.fromEntries(Object.entries(catalog.families).map(([key,value])=>[key,value.name])),
    information_contract:'carbs-treatment-only/v1',information:['I0','I1','I2'],
    patients:[{id:'frozen'}],hardware:[{id:'frozen'}],factors:[{id:'frozen'}],
    world_seeds:[seed],background_seeds:[null],scenarios};
  return {version,seed,config,calendars};
}

export function planWeekly(catalog,options) {
  const weekly=weeklyPipeline(catalog,options);
  return {...weekly,plan:planScenarioPipeline(weekly.config)};
}

export function renderWeekly(weekly) {
  const r2=weekly.version==='v4.3-weekly-r2';
  const lines=[`# ${weekly.version}：32 个一周场景`,'',
    '本版从冻结 v4.2 目录派生，不改 v4.0 / v4.1 / v4.2。先构造并冻结，再运行模型；不筛选低分随机世界。',
    r2?'每个世界连续 10080 分钟。保留 R1 的关键关联包、事件日期及参数；非关键餐次各自在名义时间 ±30 分钟内独立波动。碳水仍为 R1 的 ±10% 原抽样，世界种子不筛选；各模型及信息档配对。'
      :'每个世界连续 10080 分钟。每日餐食及关联包在原窗口内整体偏移 ±20 分钟、碳水 ±10%；世界种子固定，各模型及 I0/I1/I2 物理世界完全相同。',
    ...(r2?['R2 的改动不增加餐量、剂量、故障频率或疾病强度，不改生理模型或评分；仅解除日内所有餐次时间偏移完全相关的构造限制。关键事件边界前后180分钟、已预定治疗后360分钟（延长输注另加其持续时间）内的餐次保留原时序；这是保留场景关系的构造保护窗，不是新增药效/吸收公式。']:[]),
    '按类型选择一周发生次数，次数是研究压力协议，不是临床发生率。保留原证据编号、机制与参数幅度，不增加疾病/脱水/酮症新模型。',
    '传感器初始年龄、自动更换、预热和校准有效期不变。每三天 20:00 执行原生补充药仓及换管例行操作，防止额外引入未设计的药仓耗尽；该操作对故障的实际影响按原生设备逻辑保留。',
    '固定 T+0/60/.../10020 分钟决策，允许每天本地日历日期最多六次额外决策，固定槽位不随额外决策移动。WAIT 合法，测量与报警也不能突破预算。',
    '长期目标及原生 METRICS-v0.3 总回合评分保持不变；每次提供完整自身决策历史（含 WAIT、拒绝），外部记录仍按 I0/I1/I2 隐藏。',
    'I2 难度目标预注册：经验 P90 <0.5，至少 29/32 完成轨迹 <0.5；不把服务中断当低分，不以严重低血糖总分归零单独声称题目质量合格。另核对 I0、WAIT、日间表现及模型可用性。R1 后任何调参必须另存 R2，不能覆盖本版。','',
    '| ID | 标题 | 一周规则 | 选中第几日（从回合起点划分） |','|---|---|---|---|',
    ...weekly.calendars.map(c=>`| ${c.id} | ${c.title} | ${c.rule} | ${c.illness?'一次连续病程，详见下表':c.selected_days.join(', ')} |`),''];
  for(const c of weekly.calendars) {
    lines.push(`## ${c.id} ${c.title}`,'',`来源：${c.source_id}；依据：${c.evidence.join(', ')}。${c.rule}。`,
      `每日时间偏移（分钟）：${c.daily_shift_minutes.join(', ')}。初始历史：\`${JSON.stringify(c.history)}\`。`,
      ...(c.illness?[`病程参数：\`${JSON.stringify(c.illness)}\`；食欲恢复相对分钟：${c.appetite_end_minute}。`]:[]),
      `配置 SHA256：\`${c.instance_spec_sha256}\`。`,'','| 相对分钟 | 类型 | 具体事件 |','|---|---|---|',
      ...c.events.map(e=>`| ${e.at_minute} | ${e.type} | ${JSON.stringify(e).replaceAll('|','&#124;')} |`),
      ...Object.entries(c.sensor_intervals).flatMap(([type,rows])=>rows.map(e=>`| ${e.at_minute} | ${type} | ${JSON.stringify(e)} |`)),'');
    if(c.timing_adjustments)lines.push('### R2 时间变动与保留','',
      '| 餐次 | R1 分钟 | R2 分钟 | 关键关系保护 |','|---|---|---|---|',
      ...c.timing_adjustments.map(e=>`| ${e.id} | ${e.before} | ${e.after} | ${e.protected?'是':'否'} |`),'');
  }
  return lines.join('\n')+'\n';
}
