#!/usr/bin/env node
// Design catalogue only: preserve frozen worlds, validate inputs, render day cards. No LLM calls.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {constructScenario,merge} from '../sweet-sim/src/experiments/scenario-generator.mjs';
import {buildInstanceConfig} from '../sweet-sim/src/sim/instance.mjs';
import {SimEnv} from '../sweet-sim/src/env/pomdp.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const source='sweet-sim/artifacts/benchmarks/scenario24-paired-responses-clock-20261017/construction.json';
if(!fs.existsSync(path.join(root,source)))throw Error(`Frozen construction required: ${source}; do not silently substitute a new generation.`);
const frozenBytes=fs.readFileSync(path.join(root,source));
const frozenSha=createHash('sha256').update(frozenBytes).digest('hex');
assert.equal(frozenSha,'1535db43f68c68b4cd9f60041b15abfd0093b587552bf0bc51743e44ef4d749e','The legacy24 construction must match the inspected frozen source');
const frozen=JSON.parse(frozenBytes);
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const families={
 A:{name:'进餐时序、摄入估计与既有给药错配',intent:'保留原四道多事件复合题，不减餐、不删运动。补充高估/低估两个方向，防止把未知信息一律解释为漏餐。测相对时序、记录可靠性和已发生暴露，不以固定动作答案评分。'},
 B:{name:'慢吸收与多次输入重叠',intent:'恢复原 B 类四道难题，不拆掉慢餐、缺觉、黎明、运动等组合。核心是同一天不同输入与药效在时间上重叠，不是识别某个食物名称。模型只表达碳水池吸收时间常数，不新增脂肪/蛋白代谢；真实高脂餐标签不等于已有独立营养模型。'},
 C:{name:'活动与延迟风险',intent:'保留原四题中的多次运动、活动顺序和跨夜扰动。考察运动相对既有输入的时点与持续效应，不把所有运动都规定为降糖。原高强度段是 AC=0 加肝糖工程代理，饮酒也是延迟肝糖代理，均不得宣称验证了无氧运动或乙醇代谢。'},
 D:{name:'非疾病需求变化与暂时性应激',intent:'只收原 D03/D04，保持其两次应激、活动、缺觉及黎明交错。疾病移到 H 类只是分类变更，原物理题不变。此类测试暂时变化及其结束后的反馈，不把时钟函数或肝糖附加项描述成完整激素生理。'},
 E:{name:'输注送达异常与恢复',intent:'原四题完整保留，包括快餐、间歇失效、恢复后运动及传感器叠加。区分设备命令账本与实际进入身体的药量，修复不重置药库，也不补回丢失剂量。不是凭一个高读数判定故障，而是结合工具和连续反馈。'},
 F:{name:'观测异常与证据切换',intent:'保留原四道观测复合题，新增校准到期和伪高结束后真实升糖两种情境。考察来源、时间戳和判断更新；“怀疑传感器”不能变成全天忽视真实变化。只用现有 CGM/指尖模型，不增加手指污染或清洗过程。'},
 G:{name:'既有药效、暂停恢复与剩余输注承诺',intent:'这是上一草稿“药效 B 类”的收敛版，单列 G，避免覆盖原 B 的意义。用具体的历史给药、暂停和延长输注制造不同初始状态，后续日程固定，禁止写死模型建议或手工补一个 IOB。重点是延迟、叠加、自身操作记忆及可取消的未来承诺；不是只有少吃/漏餐才可区分策略。'},
 H:{name:'疾病相关需求、摄入与恢复的交错',intent:'独立成类，保留原 D01/D02 两题，再加六题。现有 illness 是 sensitivity_multiplier=1/(1+insulin_need_increase) 的有限时段代理；与已支持的进餐、给药史及送达故障组合。区分持续需求、低摄入、早恢复、晚恢复、食欲先恢复和并存故障，不按流感/肺炎/胃肠炎名称重复计题，也不模拟器官功能、酮体、脱水、呕吐排空或药物作用。'},
};

// [new id, legacy id, title, rationale, mechanism comparator]. Legacy specs are copied exactly.
const retained=[
 ['A01','A01','不规则多餐连续冲击','保持多次输入的原难度，观察长时间控制而非一次补偿。','同餐量背景，去除其中一次追加摄入；分别评估各输入，不统一把全天改成少餐。'],
 ['A02','A02','预打后取消主餐并开始活动','已发生药效、少量摄入和活动叠加，需要应对时序改变。','同给药史和活动，计划餐兑现；另设无预打版本，不能一次改两项。'],
 ['A03','A03','已补碳未充分吸收后再迟餐','刚发生的补碳仍在肠道仓库，不能每次重新当作未处理。','同药效史、未补该笔碳水；完整日程不变。'],
 ['A04','A04','既往纠正叠加活动和主餐变小','保留已有两个剂量及活动，测试历史暴露和调整。','同实际摄入/活动，仅比较该既往治疗史有无；历史必须重新回放。'],
 ['B01','B01','全天分散摄入及慢吸收晚餐','连续小输入与主餐吸收尾部交错，不简化成单一慢餐。','同总摄入和时间，关键慢餐使用普通时间常数。'],
 ['B02','B02','两次慢餐尾部叠加后续输入','考察前一输入尚未结束时继续摄入的时序判断。','同摄入量和时点，只改变首个慢餐时间常数。'],
 ['B03','B03','晚间慢餐、缺觉与黎明叠加','跨夜仍需追踪旧输入，不能在午夜重置判断。','分别去掉慢输入、缺觉或黎明项，保持其他组合；不以一个全删版代替分项比较。'],
 ['B04','B04','既往叠加给药、慢餐、运动和饮酒','保留原复合题完整状态链，检验长时规划和记忆。','按预注册一次去除饮酒代理或一次活动，其他历史和输入不变。'],
 ['C01','C01','两段活动穿插补给和多餐','第一次活动的状态与第二次活动共享，不按两道独立题处理。','同日程去掉第二次活动；另可改变间隔，但不同时换负荷。'],
 ['C02','C02','暂时肝糖正扰动后接有氧','原高强度标签仅是工程代理；关注先暂升、后有氧的交错，不规定曲线必然翻转。','保留后段活动，仅去除第一段正肝糖代理。'],
 ['C03','C03','晚间活动和饮酒后的延迟作用','不能在活动停止或当前稳定后忘记后续外源扰动。','同摄入和活动，无饮酒延迟肝糖代理。'],
 ['C04','C04','夜间慢餐后次晨连续两次活动','前一天输入和活动状态进入次晨，保持原题尾部难度。','同背景去掉后一次活动，不清空此前运动状态。'],
 ['D01','D03','两次餐后应激结束后叠加活动','关注暂时扰动消退以及当时仍在作用的输入。','分别去掉一段应激，固定餐食和运动；保留另一段作为背景。'],
 ['D02','D04','缺觉与黎明后回到正常需求','需要跨过需求变化的进入和退出，而非全天固定强化。','同日程去掉缺觉或黎明中的一个，分开做机制对照。'],
 ['E01','E01','静默送达不足叠加多餐','保留原多餐压力，不把故障诊断简化为孤立无餐高糖。','同命令和日程，正常送达。'],
 ['E02','E02','三次间歇送达不足和不规则进食','恢复一次不代表以后都正常，需持续更新。','同输入日程、全程正常送达；如比较持续故障须另注册。'],
 ['E03','E03','送达恢复后慢餐与活动交错','修复前后药物、肠道和运动状态连续。','同故障前史，在注册时点不修复；若 Agent 主动修复，仍按工具效果处理。'],
 ['E04','E04','静默送达不足叠加渐进伪高','同一读数同时受真实生理与测量影响。','2×2 消融：无异常、仅送达不足、仅漂移、两者并存。'],
 ['F01','F01','真实活动下降叠加伪高','不能只按表面高值增加干预，也不能丢掉真实活动。','相同摄入/运动，去掉漂移。'],
 ['F02','F02','真实餐后输入叠加伪低','考察低读数复核及识别表面读数与真实输入并存。','同进食，无漂移/压迫；分别移除两种传感器项。'],
 ['F03','F03','多次进食和活动发生在断流前后','信息缺口期间身体继续演化，必须使用可用工具与恢复后的反馈。','同真实日程，去除强制断流；I 条件不能代替物理缺口。'],
 ['F04','F04','疾病恢复期伴错误校准及漂移','完整保留原观测复合题，H 为次标签，不重复计算一条物理题。','2×2：疾病恢复过程与观测异常分别有无，观察交互。'],
 ['H01','D01','疾病高需求中低摄入随后恢复','原题完整保留，需求恢复与后续较大摄入在不同时间发生。','同摄入无需求代理；另保持需求代理但不发生摄入恢复，分开比较。'],
 ['H02','D02','疾病需求两次上升与恢复','原题完整保留，同一天需两次调整而不能沿用第一阶段结论。','保留第一次需求变化，去掉第二次，其余日程不变。'],
];
const cards=retained.map(([short,old,title,intent,comparator])=>{
 const r=frozen.rows.find(x=>x.preset===old);assert.ok(r,old);
 return {id:`V4R2-${short}`,family:short[0],title,status:'retained-exact',legacy_id:old,legacy_source:r.source_preset,
   intent,comparator,partial_rules:structuredClone(r.rules),evidence:r.evidence,
   instance_spec:structuredClone(r.spec),legacy_spec_sha256:hash(r.spec)};
});
const seed=frozen.options.seed;
const base=()=>{
 const s=constructScenario({preset:'A03',seed,startTime:'2026-10-17T22:00:00.000Z'}).spec;
 s.overrides.scenario.extra_events=[];
 s.overrides.scenario.announcement.information_mode='native';
 s.overrides.initial_state.history=s.overrides.initial_state.history.filter(e=>e.type==='calibrate_cgm');
 return s;
};
const record=(id,at,category,text)=>({id,type:'record',at_minute:at,category,text});
const meal=(at,grams,reported=grams,tau=60,id=`meal-${at}`)=>[
 record(`plan-${id}`,Math.max(0,at-35),'meal',`当前计划约在 ${clockAt(360+at)} 进食，估计碳水 ${reported} g；这是意向，不是未来实际摄入保证。`),
 {id,type:'meal',at_minute:at,grams,announced_grams:reported,absorption_minutes:tau},
];
const meals=xs=>xs.flatMap(x=>meal(...x));
const ordinary=()=>meals([[90,35,35,60],[390,55,55,75],[720,50,50,90]]);
const delayed=()=>meals([[240,35,35,60],[480,50,50,75],[720,45,45,90]]);
const illness=(id,at,hours,increase=.4)=>[
 {id,type:'illness',at_minute:at,duration_hours:hours,insulin_need_increase:increase,announced:true},
 record(`${id}-recovery`,at+hours*60,'life','患者此时报告身体不适有所缓解；不提供实际敏感性或保证下一次血糖变化。'),
];
const treatment=(minutes_before,units)=>({type:'bolus',minutes_before,units});
function add(short,title,intent,events,{history=[],patch={},rules=[{category:'life'}],evidence=[],comparator}={}){
 let spec=base();spec.overrides=merge(spec.overrides,patch);
 spec.overrides.initial_state.history.push(...history);
 spec.overrides.scenario.extra_events=events.sort((a,b)=>a.at_minute-b.at_minute||a.id.localeCompare(b.id));
 cards.push({id:`V4R2-${short}`,family:short[0],title,status:'new-config-design',legacy_id:null,intent,comparator,
   partial_rules:rules,evidence,instance_spec:spec});
}
add('A05','摄入高估而非漏餐','真实摄入较少但记录高估，不能一律推断还吃了更多。早期不硬塞既往给药；Agent 怎样相信记录及如何更新由它决定。',
 meals([[90,25,55,60],[390,55,55,75],[720,50,50,90]]),{rules:[{category:'meal',ids:['meal-90','plan-meal-90']}],evidence:['S01'],comparator:'真实摄入和物理配置不变，首餐上报改为 25 g；另可与 A06 比较，但不能误称两者真值相同。'});
add('A06','摄入低估而非记录准确','同样保留真实摄入与上报分离，方向与 A05 相反，不预先写定给药答案。',
 meals([[90,55,25,60],[390,55,55,75],[720,50,50,90]]),{rules:[{category:'meal',ids:['meal-90','plan-meal-90']}],evidence:['S01'],comparator:'同真实摄入，首餐上报改为 55 g。'});
add('F05','校准到期停更而进食继续','06:00 尚有读数，06:10 到期后无法继续更新，后续三餐仍发生；考察数据时效和现有校准工具，不新增传感器生理。',
 [...ordinary(),record('calibration-narrative',0,'fault','患者提到很久没有校准；具体到期时间以设备状态为准。')],{
 patch:{initial_state:{history_minutes:720,history:[{type:'calibrate_cgm',minutes_before:710}]}},
 rules:[{category:'fault',ids:['calibration-narrative']}],evidence:['R12','R13'],comparator:'同 Guardian 3 和日程，最近一次校准改为起点前 5 分钟；到期时刻按当前设备模型验证。'});
add('F06','伪高结束后真实摄入开始主导','08:00–12:00 仅传感器正向漂移，12:30 午餐后不再有该漂移；考察能否撤销旧的传感器解释并跟踪新证据，不预设真实血糖的形状。',
 [...ordinary(),{id:'early-drift',type:'sensor_drift',at_minute:120,duration_minutes:240,bias_mg_dl:60,ramp_minutes:45},
 record('early-sensor-report',120,'fault','患者报告传感器部位可能受影响；无法说明偏差方向和幅度。')],{
 rules:[{category:'fault',ids:['early-sensor-report']}],evidence:['R12','R22'],comparator:'同真实摄入，无早段漂移；另设午餐不发生的版本，分清观测异常结束与新摄入。'});
add('G01','近期已有给药尚未充分作用','05:40 给过 1.5 U，06:00 回合开始，10:00 前无新摄入；考察能否考虑时间延迟。这是明确的外部给药史，不预设它当时是否合理，也不伪造一个高血糖起点。',delayed(),{
 history:[treatment(20,1.5)],rules:[{category:'treatment'}],evidence:['R01','N05'],comparator:'G02：同预热初值、总量和日程，只把既往剂量移到 03:20，回合初态各自回放。'});
add('G02','相同剂量更早给入','03:20 给过 1.5 U，06:00 开始，10:00 前无新摄入；不能只看最近一次剂量的总量而忽略作用阶段。与 G01 的起点读数不强制相同，不能把二者都宣称为当前高糖。',delayed(),{
 history:[treatment(160,1.5)],rules:[{category:'treatment'}],evidence:['R01','N05'],comparator:'G01：保持总量和普通日程，仅改变历史给药时点。'});
add('G03','多次历史剂量叠加后的控制','04:10、05:00、05:45 各给 1 U，总量 3 U；06:00 后不能把不同次观察当作互不相干，10:00 前没有新餐。',delayed(),{
 history:[treatment(110,1),treatment(60,1),treatment(15,1)],rules:[{category:'treatment'}],evidence:['N05'],comparator:'同总量 3 U 在 05:00 单次给入；只比较时序，不同时减少总量。'});
add('G04','此前主动暂停已结束且另有给药','04:30 主动暂停基础 60 分钟，05:30 自动恢复，05:40 给 1.5 U；06:00 开始设备无故障。区分过去的缺口、当前正常送达及已有药效。',delayed(),{
 history:[{type:'suspend_pump',minutes_before:90,minutes:60},treatment(20,1.5)],
 rules:[{category:'treatment'}],evidence:['R10','R01'],comparator:'相同既往给药和日程，没有那次主动暂停；这不是输注故障修复题。'});
add('G05','餐取消但延长输注尚未完成','05:30 启动 3 U/180 分钟延长输注；06:00 主餐取消，06:30 实际只有 10 g 加餐。未取消时剩余输注持续到 08:30，取消则按现有动作改变未来输入，已入体部分不回收。',
 [...meals([[30,10,10,60],[390,55,55,75],[720,50,50,90]]),record('cancelled-meal',0,'meal','原定主餐取消，只能在 06:30 吃少量加餐；先前已启动延长输注。')],{
 history:[{type:'extended_bolus',minutes_before:30,units:3,duration_minutes:180}],
 rules:[{category:'meal',ids:['cancelled-meal']}],evidence:['R01','R02'],comparator:'同样的主餐取消和实际日程，但没有剩余延长输注承诺；历史分别回放。'});
add('G06','补碳进入身体但读数尚未体现','05:15 给过 2 U、05:55 已补 15 g；06:00 开始，没有立即安排大餐把问题冲掉，10:00 才有第一餐。检验是否使用既有补碳与自身后续回执。',
 [...delayed(),record('recent-rescue',0,'meal','患者报告 05:55 已喝下含 15 g 碳水的饮料；尚不能保证已完全吸收。')],{
 history:[treatment(45,2),{type:'carbs',minutes_before:5,grams:15}],
 rules:[{category:'meal',ids:['recent-rescue','history:2']}],evidence:['R01','R12'],comparator:'同药效史但未发生这 15 g 补碳，也没有相应报告；不是只删文字而保留假摄入。'});
add('H03','需求持续偏高但三餐正常','08:00–20:00 illness 参数 0.4，三餐不减量，没有额外运动或故障。把持续需求问题与漏餐补偿分开；20:00 后继续观察至次晨。',
 [...ordinary(),...illness('ill',120,12)],{rules:[{category:'life',ids:['ill']}],evidence:['R08','SICK25'],comparator:'完全相同三餐，没有 illness 代理。'});
add('H04','已有给药后需求较早恢复','05:40 有 1.5 U 历史；06:00–08:00 illness 参数 0.4；07:30 15 g、12:30 35 g、18:00 55 g。考察需求代理消退与仍在体内的药效，不预设 Agent 已经追加。',
 [...meals([[90,15,15,60],[390,35,35,75],[720,55,55,90]]),...illness('ill',0,2)],{
 history:[treatment(20,1.5)],rules:[{category:'life',ids:['ill-recovery']}],evidence:['R08','R01'],comparator:'同既往药量和摄入，需求扰动持续到 14:00；初始阶段一致，后段分叉。'});
add('H05','需求持续偏高而实际摄入明显减少','08:00–20:00 illness 参数 0.4；07:30 35 g、12:30 15 g、18:00 10 g，没有用晚间大餐自动抵消。只减少实际摄入，不模拟呕吐、脱水或胃排空疾病。',
 [...meals([[90,35,35,60],[390,15,15,75],[720,10,10,90]]),...illness('ill',120,12)],{
 rules:[{category:'life',ids:['ill']}],evidence:['R08'],comparator:'H03：相同需求变化、三餐正常；另设同低摄入但无需求变化，分开核对。'});
add('H06','需求先恢复、食欲较晚恢复','06:00–14:00 illness 参数 0.4；07:30 15 g、12:30 20 g，14:00 需求代理消退，到 18:00 才恢复 50 g 摄入。14:00–18:00 是两者不同步的关键窗口。',
 [...meals([[90,15,15,60],[390,20,20,75],[720,50,50,90]]),...illness('ill',0,8),
 record('appetite-return',720,'life','患者此时食欲恢复并进餐；不代表提供任何真实生理参数。')],{
 rules:[{category:'life',ids:['ill-recovery']}],evidence:['R08','SICK25'],comparator:'保持摄入日程，需求代理持续到 20:00；不同时改变两条恢复时间线。'});
add('H07','食欲先恢复、需求较晚恢复','08:00–22:00 illness 参数 0.4；07:30 20 g、12:30 55 g、14:30 15 g、18:00 50 g。正常摄入先回来，但需求代理到 22:00 才结束，之后仍留 8 小时。',
 [...meals([[90,20,20,60],[390,55,55,75],[510,15,15,60],[720,50,50,90]]),...illness('ill',120,14),
 record('appetite-return',390,'life','患者此时食欲恢复；身体是否已经恢复需要后续观察。')],{
 rules:[{category:'life',ids:['appetite-return']}],evidence:['R08','SICK25'],comparator:'保持同样摄入，把需求恢复移至 14:00；不要直接与 H06 比较后把所有差异归因于一个因素。'});
add('H08','疾病相关需求上升叠加送达不足','08:00–20:00 illness 参数 0.4；10:00–14:00 泵实际送达比例 0.5，并在 10:00 有部位异常报告。14:00 外源修复；Agent 可更早主动更换；三餐为 35/35/40 g。',
 [...meals([[90,35,35,60],[390,35,35,75],[720,40,40,90]]),...illness('ill',120,12),
 {id:'delivery-loss',type:'infusion_deficit',at_minute:240,duration_minutes:240,delivered_fraction:.5},
 record('site-problem',240,'fault','患者报告贴布潮湿或管路松动，设备画面可能仍显示运行。'),
 {id:'scheduled-repair',type:'infusion_recovery',at_minute:480},record('repair-report',480,'fault','此时输注部位已处理；不补回之前未送达药物。')],{
 rules:[{category:'fault',ids:['site-problem']}],evidence:['R08','R09','R19'],comparator:'2×2：正常、仅 illness、仅送达不足、两者并存；每个世界有各自 WAIT。'});

assert.equal(cards.length,40);assert.equal(new Set(cards.map(c=>c.id)).size,40);
const counts=Object.fromEntries(Object.keys(families).map(f=>[f,cards.filter(c=>c.family===f).length]));
assert.deepEqual(Object.values(counts),[6,4,4,2,4,6,6,8]);
const retainedIds=cards.filter(c=>c.legacy_id).map(c=>c.legacy_id).sort();
assert.deepEqual(retainedIds,frozen.rows.map(r=>r.preset).sort());
for(const c of cards){
 if(c.legacy_id)assert.deepEqual(c.instance_spec,frozen.rows.find(r=>r.preset===c.legacy_id).spec);
 const cfg=buildInstanceConfig(c.instance_spec),env=new SimEnv(cfg);
 assert.equal(env.terminated,false,`${c.id}: initialization failed`);
 assert.equal(cfg.utc_offset_minutes,480,'The rendered day cards use Beijing time');
 assert.equal(cfg.horizon_minutes,1440);assert.equal(cfg.controller.enabled,false);
 c.instance_spec_sha256=hash(c.instance_spec);
 c.config_check={schema_and_initialization:'passed',extra_event_types:[...new Set(cfg.scenario.extra_events.map(e=>e.type))],
   initial_glucose_mg_dl:env.physiology.glucose(),initial_calibration_due:env.cgm?.calibrationDue()?new Date(env.cgm.calibrationDue()).toISOString():null};
}
const f05=cards.find(c=>c.id==='V4R2-F05');
assert.equal(Date.parse(f05.config_check.initial_calibration_due)-Date.parse(f05.instance_spec.start_time),10*60000);
const g05=cards.find(c=>c.id==='V4R2-G05');
assert.ok(new SimEnv(buildInstanceConfig(g05.instance_spec)).device.extended,'G05 needs an actual remaining commitment');

function clockAt(minutes){const m=((minutes%1440)+1440)%1440;return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;}
function stamp(spec,at){return new Date(Date.parse(spec.start_time)+at*60000+480*60000).toISOString().slice(5,16).replace('T',' ');}
function recordText(e,events){
 if(e.id.startsWith('plan-meal-')){const m=events.find(x=>x.id===e.id.slice(5));if(m)return `患者当前进餐意向：预计 ${m.announced_grams} g，计划在 ${m.at_minute} 分钟处；意向不保证兑现`;}
 if(e.id.startsWith('plan-activity-'))return '患者报告近期活动意向，不是保证实际发生或未来血糖预测';
 if(e.id.startsWith('ill-recovery-'))return '患者此时报告身体不适改善、食欲改变；不提供真实敏感性';
 if(e.id.startsWith('leak-report-'))return '患者报告贴布潮湿/管路松脱，不提供实际送达比例';
 if(e.id.startsWith('sensor-report-'))return '患者报告传感器部位/干扰问题，不提供偏差方向和幅度';
 if(e.id.startsWith('stress-end-'))return '患者报告应激情境结束；已进入身体的药物继续作用';
 const translations={'cancelled-lunch':'计划主餐取消，只有少量加餐；不能假定主餐随后必然到达',
 'recent-rescue':'患者报告起点前 5 分钟已补 15 g 碳水，尚可能未充分吸收',
 'meal-change':'原计划主餐变小，起点前纠正可能仍在作用',
 'repair-report':'患者报告此前输注问题已处理；需要结合当前状态继续判断'};
 return translations[e.id]??e.text;
}
function describe(e,events){
 if(e.type==='meal')return `实际摄入 ${e.grams} g；记录 ${e.announced_grams??'未上报'} g；碳水池吸收时间常数 τ=${e.absorption_minutes} min（不是全部吸收完毕时长）`;
 if(e.type==='record')return `当下 ${e.category} 记录：${recordText(e,events)}`;
 if(e.type==='exercise')return `活动 ${e.duration_minutes} min，AC=${e.accelerometer_counts}${e.hepatic_delta_mg_dl_per_min?`，附加肝糖代理 ${e.hepatic_delta_mg_dl_per_min} mg/dL/min`:''}；标签 ${e.kind??'aerobic'} 不另增加生理机制`;
 if(e.type==='illness')return `需求代理开始，参数 r=${e.insulin_need_increase}，SI 倍率=1/(1+r)，维持 ${e.duration_hours} h；不是临床加量比例`;
 if(e.type==='stress')return `应激肝糖代理 ${e.hepatic_delta_mg_dl_per_min} mg/dL/min，持续 ${e.duration_minutes} min`;
 if(e.type==='sleep_loss')return `缺觉敏感性代理减幅 ${e.sensitivity_decrease}，持续 ${e.duration_minutes} min`;
 if(e.type==='alcohol')return `饮酒记录，${e.onset_hours} h 后起肝糖代理 ${e.hepatic_delta_mg_dl_per_min} mg/dL/min，持续 ${e.duration_hours} h；不是乙醇动力学`;
 if(e.type==='infusion_deficit')return `实际送达比例 ${e.delivered_fraction}，持续 ${e.duration_minutes} min；命令账本不变，Agent 可主动修复`;
 if(e.type==='infusion_recovery')return '外源输注修复事件；不重置体内状态，不补回未送达药物';
 if(e.type==='sensor_drift')return `CGM 漂移峰值 ${e.bias_mg_dl} mg/dL，总长 ${e.duration_minutes} min，起止斜坡各 ${e.ramp_minutes} min；不改变真实血糖`;
 if(e.type==='sensor_calibration_error')return `错误校准，输入参考值偏差 ${e.bias_mg_dl} mg/dL；效果按现有校准模型，不等于读数永远固定加这个值`;
 return `${e.type}：${JSON.stringify(e)}`;
}
function dayRows(spec){
 const es=spec.overrides.scenario.extra_events,rows=[];
 for(const h of spec.overrides.initial_state.history){
  const text=h.type==='bolus'?`已给入 ${h.units} U，作为真实起点前药物历史回放`
   :h.type==='carbs'?`已补碳 ${h.grams} g，进入实际吸收仓库`
   :h.type==='meal'?`已进食 ${h.grams} g，上报 ${h.announced_grams??'未上报'} g，τ=${h.absorption_minutes} min`
   :h.type==='calibrate_cgm'?'此前完成 CGM 校准，使用现有指尖误差模型'
   :h.type==='suspend_pump'?`主动暂停基础 ${h.minutes} min；按现有设备状态计时`
   :h.type==='extended_bolus'?`启动延长输注 ${h.units} U/${h.duration_minutes} min；已送达与剩余部分按设备回放`
   :`${h.type}（起点前设备/治疗历史）`;
  rows.push({at:-h.minutes_before,text:`起点前：${text}`});
  if(h.type==='suspend_pump')rows.push({at:h.minutes-h.minutes_before,text:'若无其他操作，此前主动暂停按原时长结束；不是故障修复或药库重置'});
 }
 for(const e of es){rows.push({at:e.at_minute,text:describe(e,es)});
  const duration=e.duration_minutes??(e.type==='illness'?e.duration_hours*60:null);
  if(duration&&e.at_minute+duration<=1440)rows.push({at:e.at_minute+duration,text:`${e.id} 的预设作用区间结束；体内药库/肠道/运动状态不清零，后续真实变化由积分决定`});
  if(e.type==='alcohol'){
   rows.push({at:e.at_minute+e.onset_hours*60,text:`${e.id} 的延迟肝糖代理开始`});
   rows.push({at:e.at_minute+(e.onset_hours+e.duration_hours)*60,text:`${e.id} 的延迟肝糖代理结束（若超回合则标为未观测尾部）`});
  }
 }
 const cgm=spec.overrides.cgm;
 for(const g of cgm.forced_gaps??[])rows.push({at:g.at_minute,text:`CGM 强制断流 ${g.duration_minutes} min`},{at:g.at_minute+g.duration_minutes,text:'强制断流区间结束；是否有有效新值还取决于校准等设备状态'});
 for(const g of cgm.compression_lows??[])rows.push({at:g.at_minute,text:`CGM 压迫伪低，深度参数 ${g.depth_mg_dl} mg/dL，持续 ${g.duration_minutes} min`},{at:g.at_minute+g.duration_minutes,text:'压迫伪低区间结束'});
 if(spec.overrides.physiology.dawn_fraction)rows.push({at:0,text:`整日沿原时钟使用黎明项 dawn_fraction=${spec.overrides.physiology.dawn_fraction}；03:00 起、05–08 时段较强、10:00 退出，三档相同`});
 return rows.sort((a,b)=>a.at-b.at);
}
const report={format:'sweet-sim.scenario-design/v4r2',status:'design-not-a-registered-benchmark',date:'2026-10-18',
 source:{path:source,sha256:frozenSha,options:frozen.options},
 counts:{total:40,retained_exact:24,new_design:16,families:counts},families,cards,
 limits:['No new physiological mechanism','Schema and initialization checks only; no LLM experiment or outcome filtering',
 'Legacy worlds/specs unchanged, including their original clock and late events','New day schedules are synthetic design choices, not literature-fitted or clinical prescriptions',
 'New family registration, complete control-world catalogue and information-projection audits remain implementation work']};
const out=path.join(root,'analysis/scenario-v4r2-day-cards-20261018');
fs.writeFileSync(`${out}.json`,JSON.stringify(report,null,2)+'\n');
const md=['# V4R2 逐场景的一天：24 题原样保留 + 16 题补充','',
 '这是作者用设计卡，含真实事件/参数，不能直接作为模型提示词。参数为合成研究配置，不是患者处方；血糖轨迹由模型与 Agent 实际动作共同产生，不预先写死。',
 '新配置只验证现有 schema 和初始化；没有调用 LLM、运行新评分实验、增加内核机制或改旧题难度。正式目录/信息对照审计尚未完成。',
 `来源：冻结的 construction.json（SHA256 ${report.source.sha256}）。旧 24 个 instance_spec 逐项深比较及 SHA256 保持一致。`,
 '旧题保留原本的绝对时钟及其 ±30 min 偏移；新增题为 06:00 至次晨 06:00。下表全部使用北京时间。τ 是碳水池时间常数，不是整餐吸收结束时间。',
 '新题三餐只是背景。除明确列出的起点前历史外，不安排固定治疗动作、自动患者或控制器；Agent 是否给药、补碳、测量、修复、取消输注由它自己决定。基础输注继续，所有改变都走现有工具。',
 '疾病 r 参数只控制已有代理的 SI 倍率，不能解读成临床统一增加 r 比例剂量。旧题沿用其配置，新增 H 使用已有 0.4 参数级别，未增加病种生理。',
 '正式实验要求每题有本世界 WAIT；下列因素对照是另一层，每个配对世界也应有 WAIT。新题基线尚未运行。I0/I1/I2 只改记录及记录派生估计，自身回执保留。',
 '所有剂量与参数属于仿真器，不能用于真实硬件或患者。预热初始血糖字段不是重写回合起点：回合初态必须由历史回放获得。','',
 '| 类别 | 保留原题 | 新增 | 合计 |','|---|---:|---:|---:|',
 ...Object.entries(families).map(([f,v])=>`| ${f} ${v.name} | ${cards.filter(c=>c.family===f&&c.legacy_id).length} | ${cards.filter(c=>c.family===f&&!c.legacy_id).length} | ${counts[f]} |`),''];
for(const [family,meta] of Object.entries(families)){
 md.push(`## ${family} ${meta.name}`,'',meta.intent,'');
 for(const c of cards.filter(x=>x.family===family)){
  const s=c.instance_spec;
  md.push(`### ${c.id} ${c.title}`,'',`来源：${c.legacy_id?`原 ${c.legacy_id}（底层 ${c.legacy_source}），物理配置原样保留`:'新增配置设计，只使用现有输入'}。回合：${stamp(s,0)} → ${stamp(s,1440)}。`,
   `设计意图：${c.intent}`,`前史预热 ${s.overrides.initial_state.history_minutes} min，具体给药/进食见下表。回放后的起点真实血糖预览 ${c.config_check.initial_glucose_mg_dl.toFixed(2)} mg/dL（作者审计信息，不是给 Agent 的真值）；不强制所有起点偏高。`,
   `I1 隐藏规则：${JSON.stringify(c.partial_rules)}。这些规则尚需逐条投影审计；不宣称均已完成。`,
   `因素对照：${c.comparator}`,`依据编号：${c.evidence.join('、')}；证据支持同类现象，不等于当天参数或组合已被临床验证。`,
   '', '| 北京时间 | 预设的外源事件/事实 |','|---|---|',
   ...dayRows(s).map(r=>`| ${stamp(s,r.at)}${r.at>1440?'（回合外）':''} | ${r.text.replaceAll('|','/')} |`),
   `| ${stamp(s,1440)} | 回合结束。未消退状态不因回合结束而解释为临床风险已消失。 |`,'');
 }
}
md.push('## 引用及实现边界','',
 'R01–R13 见 [原研究登记](scenario-family-evidence-v1-20261016.zh-CN.md)，R14–R22 见 [扩展研究 JSON](../sweet-sim/knowledge/scenario-hard-evidence-v3.json)，N05 见 [近年证据表](scenario-v4-evidence-and-mechanisms-20261018.zh-CN.md)，S01 见 [前版附录的基础研究来源](scenario-v4r1-capability-balanced-design-20261018.zh-CN.md)。这里只沿用研究编号，不沿用前版候选目录。',
 'SICK25：[2025 年韩国儿童青少年感染前中后 CGM 观察研究](https://pmc.ncbi.nlm.nih.gov/articles/PMC11917402/)，18 人，观察到感染期指标变化及恢复。无法提供总日剂量数据；不能标定成人 0.4 倍率、小时病程或需求与食欲的先后时点。',
 '现有 illness 的症状叙述不构成症状/免疫模型。H 类只是现有需求代理与真实摄入、药效及送达交互的病日控制任务；不声称评估完整疾病诊疗。',
 '上一草稿的独立蛋白、动态加温 PK、脂肪增生切换、HAAF、激素药代、指尖污染全部移出当前 V4R2，不作为待实现题占位。',
 '旧 24 题继承原 mask，新增题给出明确 I1 规则草案。历史账本目前只有类别级过滤，不能声称支持按某一笔历史剂量 ID 隐藏。',
 '原工具/评分/原生报告不改。新类别 G/H 尚未接入原 FAMILIES 注册表，不把本文件或 JSON 冒充已注册可直接运行的 benchmark。',
 '校准状态、故障动态、读数新鲜度仍服从实际设备实现；不得通过自动维护、患者脚本或强制治疗“帮忙”获得分数。','');
fs.writeFileSync(`${out}.zh-CN.md`,md.join('\n'));
console.log(JSON.stringify({json:`${out}.json`,markdown:`${out}.zh-CN.md`,...report.counts,
 schema_and_initialization:cards.length,legacy_spec_equality:retainedIds.length,f05_due_minutes:10,g05_remaining_commitment:true}));
