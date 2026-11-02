#!/usr/bin/env node
// Design-only revision. Legacy experiments and V4R2 inputs are read, never rewritten.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {merge} from '../sweet-sim/src/experiments/scenario-generator.mjs';
import {buildInstanceConfig} from '../sweet-sim/src/sim/instance.mjs';
import {SimEnv} from '../sweet-sim/src/env/pomdp.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const input=path.join(root,'analysis/scenario-v4r2-day-cards-20261018.json'),bytes=fs.readFileSync(input),prior=JSON.parse(bytes);
assert.equal(prior.format,'sweet-sim.scenario-design/v4r2');assert.equal(prior.cards.length,40);
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const families={
 A:{name:'摄入过程与药效时序错配',intent:'只在外源摄入的次数、吸收及实际兑现过程上组织四种主挑战。保留旧复合题难度，不再把全天多餐、慢餐、取消餐和报告误差分别膨胀为很多同类题。药物始终有作用，但分类依据是主要发生改变的外源输入，不是这题是否出现胰岛素。'},
 B:{name:'既有治疗、残余药效与未完成输注',intent:'四题分别是给药时点、叠加历史、剩余输注承诺和已发生的救援输入。它们的关键是身体/设备已经处于什么状态，而非猜发生了哪顿饭。原 G02 等放到严格定义的对照或诊断档案，不再重复计为独立主情景。A/B 共八题；不存在一个额外的 G 主族。'},
 C:{name:'活动与延迟风险',intent:'保留 V4R2 的四道原活动复合题，原物理事件和参数不变。运动顺序、多次活动与跨夜尾部是主挑战；饮酒、进餐等可作次标签，不重复计题。'},
 D:{name:'非疾病的需求变化与肝糖输出扰动',intent:'从两题扩展至六题：保留两道原复合压力题，增加黎明、缺觉退出、餐后短时应激及无运动的饮酒延迟扰动。分别标注敏感性项或肝糖项，不把两者写成同一生理机制。新增题有明确物理扰动，隐藏叙述后仍存在；不把仅有名称变化的稳定背景算新主题。'},
 E:{name:'输注异常与恢复',intent:'原四道故障复合题不变。过去的主动暂停可作为状态鉴别/诊断条件，但不再额外增加一个与 B 重复的主情景。'},
 F:{name:'观测异常与证据切换',intent:'保留 V4R2 六题，含四道原复合题和两个已配置的设备/证据切换题。测量异常仍与信息记录隐藏正交，不新增污染或采血生理。'},
 H:{name:'疾病相关需求与摄入恢复',intent:'八题收敛到四种代表性情境：正常进食的高需求、低摄入的高需求、需求与摄入恢复错位、病日并存送达异常。早恢复/晚恢复等相近病例进入同一题的对照，而不是按不同病名或多个恢复时点重复计题。仍只使用现有 illness 代理，不增加真实病种动力学。'},
};
const byId=id=>{const c=prior.cards.find(c=>c.id===`V4R2-${id}`);assert.ok(c,id);return c;};
const cards=[];
function keep(short,from,title,reason,comparison=null){
 const p=byId(from),c=structuredClone(p);
 c.id=`V4R3-${short}`;c.family=short[0];c.title=title;c.previous_id=p.id;c.retention_reason=reason;
 c.intent=reason+' '+p.intent;if(comparison)c.comparator=comparison;
 cards.push(c);
}
keep('A01','B01','分散多次摄入与慢吸收主餐交叠','用原 B01 的八次摄入完整覆盖不规则多餐与慢输入，不再另把原 A01 算入新主集。');
keep('A02','B02','两次慢餐尾部叠加后续进食','保留两次慢输入及其间/之后摄入的原复杂度。');
keep('A03','A02','预打后主餐取消并开始活动','保留预打、实际小餐和活动的错配，不能简化成无药效的取消意向。');
keep('A04','B03','夜间慢餐叠加缺觉与黎明','保留原跨夜复合题，主标签为慢输入，其他机制按次标签报告。');
keep('B01','G01','既往给药时点与残余作用','同总量不同历史时点作为同一题的主世界/配对世界，不分别占两个主题。',
 '主世界为原 G01：起点前20分钟1.5 U；时点对照为原 G02：起点前160分钟1.5 U，摄入和其他物理配置相同。历史各自回放，初始血糖不强行相同。');
keep('B02','A04','既往叠加给药后活动与小餐交错','保留原 A04 的两次给药、活动及餐量变化，而非另造多道单次/分次同质题。',
 '同总量4 U、相同活动和进食，把1.7 U/2.3 U的分布改为起点前40分钟一次给入；预注册为给药时序分布对照，不能同时改变总量。原 G03 的3 U简化配置仅留诊断档案，不冒充严格匹配对照。');
keep('B03','G05','主餐取消但延长输注尚未完成','保留一个真正需要区分未来承诺与已入体药效的设备/生理交互。');
keep('B04','A03','救援补碳未充分吸收且主餐推迟','使用原复杂题而不是另算原 G06 简化题，保留既有药效和全天后续输入。');
for(const f of ['C','E','F'])for(const p of prior.cards.filter(c=>c.family===f)){
 keep(p.id.slice(5),p.id.slice(5),p.title,'原 V4R2 物理配置不变。');
}
keep('D01','D01','两次短时应激消退后分别接活动','保留原 D03 的两段肝糖代理、四餐与活动，不降低其难度。');
keep('D02','D02','缺觉与黎明叠加后的需求恢复','保留原 D04 的缺觉、黎明、四餐与后续活动。');
const record=(id,at,category,text)=>({id,type:'record',at_minute:at,category,text});
function newD(short,title,intent,events,{patch={},rules=[{category:'life'}],evidence,comparison}){
 const s=structuredClone(byId('H03').instance_spec);
 s.overrides.scenario.extra_events=[];
 s.overrides=merge(s.overrides,patch);
 s.overrides.scenario.extra_events=events.sort((a,b)=>a.at_minute-b.at_minute||a.id.localeCompare(b.id));
 cards.push({id:`V4R3-${short}`,family:'D',title,status:'new-config-design',previous_id:null,legacy_id:null,
  intent,retention_reason:'扩展 D，仅用已有机制',comparator:comparison,evidence,partial_rules:rules,instance_spec:s});
}
function meals(rows,origin=360){return rows.flatMap(([clock,grams,tau=60])=>{
 const [h,m]=clock.split(':').map(Number),at=(h*60+m-origin+1440)%1440,id=`meal-${at}`;
 return [record(`plan-${id}`,Math.max(0,at-35),'meal',`患者当前计划约${clock}摄入${grams} g；意向不保证兑现。`),
  {id,type:'meal',at_minute:at,grams,announced_grams:grams,absorption_minutes:tau}];
});}
newD('D03','未进食时的黎明需求进入与退出','00:00起始；03:00进入现有黎明函数、05:00—08:00较强、10:00退出。第一餐11:00，使早期需求变化不被强制餐食覆盖。不是重设基础生理参考或改变患者目标。',
 [...meals([['11:00',35],['15:30',55,75],['19:00',50,90]],0),record('prior-dawn-report',0,'life','患者报告以往清晨有反复升糖现象，不提供今日未来曲线或真实参数。')],{
 patch:{physiology:{dawn_fraction:.3}},rules:[{category:'life',ids:['prior-dawn-report']}],evidence:['R03'],
 comparison:'同患者、日程与种子，关闭 dawn_fraction；时钟函数参数沿现有实现，不按模型分数调幅。'});
cards.at(-1).instance_spec.start_time='2026-10-17T16:00:00.000Z';
newD('D04','缺觉相关需求退出后仍继续进食','06:00—18:00缺觉代理 sensitivity_decrease=0.2；07:30/12:30进食35/55 g，18:30再吃50 g。关注需求代理退出时已有治疗与随后进食，不预设 Agent 一定增加治疗。',
 [...meals([['07:30',35],['12:30',55,75],['18:30',50,90]]),
 {id:'sleep-loss',type:'sleep_loss',at_minute:0,duration_minutes:720,sensitivity_decrease:.2,announced:true},
 record('rest-recovered',720,'life','患者此时报告休息情况改善；后续需要结合实际走势判断，不提供敏感性数值。')],{
 rules:[{category:'life',ids:['rest-recovered']}],evidence:['R06'],comparison:'同样日程，缺觉代理持续到次晨；另设完全无该代理的背景。它们不是新增主题。'});
newD('D05','慢餐后的短时应激及其消退','07:30摄入40 g、τ=150 min；08:00—10:00加入0.3 mg/dL/min的已有应激肝糖代理；14:00/18:00再进食50/45 g。10:00只结束应激项，不清空肠道和药库。',
 [...meals([['07:30',40,150],['14:00',50,75],['18:00',45,90]]),
 {id:'stress',type:'stress',at_minute:120,duration_minutes:120,hepatic_delta_mg_dl_per_min:.3},
 record('stress-start',120,'life','患者报告当前处于紧张情境，不提供实际肝糖增量。'),
 record('stress-end',240,'life','患者报告紧张情境此时结束，先前摄入和治疗不因此失效。')],{
 rules:[{category:'life',ids:['stress-end']}],evidence:['R07','R18'],comparison:'同样慢输入，无应激代理；空腹无明显效应可作额外叙述反例，但不再强造一个全信息档位重复主情景。'});
newD('D06','无运动背景下的饮酒延迟肝糖扰动','12:00至次日12:00；13:00/18:00/次日07:30摄入35/55/50 g。19:00饮酒记录，5小时后即午夜开始-0.25 mg/dL/min肝糖代理，持续8小时，之后仍观察4小时。当天不加运动以区别于 C03。',
 [...meals([['13:00',35],['18:00',55,75],['07:30',50,90]],720),
 {id:'alcohol',type:'alcohol',at_minute:420,onset_hours:5,duration_hours:8,hepatic_delta_mg_dl_per_min:-.25,announced:true}],{
 rules:[{category:'life',ids:['alcohol']}],evidence:['R15'],comparison:'同摄入和作息，无该延迟负向肝糖代理。不模拟乙醇浓度、糖原或胰高血糖素。'});
cards.at(-1).instance_spec.start_time='2026-10-18T04:00:00.000Z';
keep('H01','H03','正常进食下的持续疾病高需求','正常摄入与持续需求上升的代表，不另按病种或需求时长拆题。');
keep('H02','H05','持续疾病高需求伴摄入明显减少','与 H01 分开，因为需要同时考虑较低外源输入和较高需求。');
keep('H03','H06','疾病需求与食欲恢复先后错位','一个主情景覆盖恢复顺序，不再把多种早晚恢复各算一题。',
 '主世界需求06:00—14:00、18:00恢复摄入；相同三餐15/20/50 g不变，仅把需求结束移至22:00，就得到食欲先恢复的配对世界。旧 H07 的餐量/起点/加餐也不同，不能直接作为该严格对照。');
keep('H04','H08','疾病高需求叠加送达不足及修复','保留一种跨机制病日复杂题。与 E 的差别是需求扰动始终存在，不能把高糖全部解释为漏餐或全部解释为设备问题。');
cards.sort((a,b)=>a.id.localeCompare(b.id));
const counts=Object.fromEntries(Object.keys(families).map(f=>[f,cards.filter(c=>c.family===f).length]));
assert.deepEqual(Object.values(counts),[4,4,4,6,4,6,4]);assert.equal(cards.length,32);
assert.equal(new Set(cards.map(c=>c.id)).size,32);
const covered=cards.filter(c=>c.legacy_id).map(c=>c.legacy_id).sort();
assert.equal(covered.length,20);assert.equal(new Set(covered).size,20);
const legacyNotCore=prior.cards.filter(c=>c.legacy_id&&!covered.includes(c.legacy_id)).map(c=>c.legacy_id).sort();
assert.deepEqual(legacyNotCore,['A01','B04','D01','D02']);
for(const c of cards){
 if(c.previous_id)assert.deepEqual(c.instance_spec,prior.cards.find(p=>p.id===c.previous_id).instance_spec);
 const config=buildInstanceConfig(c.instance_spec),env=new SimEnv(config);
 assert.equal(config.horizon_minutes,1440);assert.equal(config.utc_offset_minutes,480);assert.equal(config.controller.enabled,false);
 assert.equal(env.terminated,false);c.instance_spec_sha256=hash(c.instance_spec);
 c.config_check={schema_and_initialization:'passed',initial_glucose_mg_dl:env.physiology.glucose()};
}
const report={format:'sweet-sim.scenario-design/v4r3',date:'2026-10-18',status:'design-not-registered-not-llm-tested',
 source:{file:path.relative(root,input),sha256:createHash('sha256').update(bytes).digest('hex')},
 counts:{total:32,from_v4r2_unchanged:28,new_D:4,legacy24_core_retained:20,legacy24_not_in_core:4,families:counts},
 families,legacy_not_in_core:legacyNotCore,cards,
 limits:['Legacy24 and its experiments remain immutable, including four cases not selected into the compact core.',
 'Eight A/B primary scenarios; timing variants are comparator worlds, not additional primary scenarios.',
 'IOB/COB estimates and own-action receipt rules unchanged; new I1 rules require projection audits.',
 'Model-free schema/initialization checks only, no new physiology, runner, score or LLM calls.']};
const out=path.join(root,'analysis/scenario-v4r3-day-cards-20261018');
fs.writeFileSync(`${out}.json`,JSON.stringify(report,null,2)+'\n');
function stamp(s,at){return new Date(Date.parse(s.start_time)+480*60000+at*60000).toISOString().slice(5,16).replace('T',' ');}
function rows(c){
 const s=c.instance_spec,o=s.overrides,rs=[];
 for(const e of o.initial_state.history)rs.push({at:-e.minutes_before,text:`前史：${e.type==='bolus'?`给入${e.units} U`:e.type==='carbs'?`已补${e.grams} g碳水`:e.type==='meal'?`摄入${e.grams} g，τ=${e.absorption_minutes} min`:e.type==='calibrate_cgm'?'已有CGM校准':e.type==='extended_bolus'?`启动${e.units} U/${e.duration_minutes} min延长输注`:e.type==='suspend_pump'?`主动暂停${e.minutes} min`:e.type}`});
 for(const e of o.scenario.extra_events){
  const content=e.type==='meal'?`摄入${e.grams} g，上报${e.announced_grams??'未报'} g，τ=${e.absorption_minutes} min`
   :e.type==='record'?`当下${e.category}记录：${e.text}`
   :e.type==='exercise'?`活动${e.duration_minutes} min，AC=${e.accelerometer_counts}，附加肝糖项${e.hepatic_delta_mg_dl_per_min??0} mg/dL/min`
   :e.type==='illness'?`已有需求代理开始，r=${e.insulin_need_increase}，SI倍率=1/(1+r)，持续${e.duration_hours} h`
   :e.type==='sleep_loss'?`已有缺觉代理开始，SI减幅${e.sensitivity_decrease}，持续${e.duration_minutes} min`
   :e.type==='stress'?`已有正肝糖代理${e.hepatic_delta_mg_dl_per_min} mg/dL/min，持续${e.duration_minutes} min`
   :e.type==='alcohol'?`饮酒记录，${e.onset_hours} h后开始${e.hepatic_delta_mg_dl_per_min} mg/dL/min代理，持续${e.duration_hours} h`
   :e.type==='infusion_deficit'?`实际送达比例${e.delivered_fraction}，持续${e.duration_minutes} min；Agent可主动修复`
   :e.type==='infusion_recovery'?'预设外源修复；不重置生理状态，不补回丢失药物'
   :e.type==='sensor_drift'?`传感器漂移峰值${e.bias_mg_dl} mg/dL，总长${e.duration_minutes} min，起止斜坡${e.ramp_minutes} min`
   :e.type==='sensor_calibration_error'?`错误校准的参考值偏差${e.bias_mg_dl} mg/dL；不等于永久固定读数偏差`:JSON.stringify(e);
  rs.push({at:e.at_minute,text:content});
  const duration=e.duration_minutes??(e.type==='illness'?60*e.duration_hours:null);
  if(duration)rs.push({at:e.at_minute+duration,text:`${e.id}预设区间结束；不清空此前体内状态`});
  if(e.type==='alcohol')rs.push({at:e.at_minute+e.onset_hours*60,text:'延迟负向肝糖代理开始'},
   {at:e.at_minute+(e.onset_hours+e.duration_hours)*60,text:'延迟负向肝糖代理结束；继续观察，不等于真实风险归零'});
 }
 for(const x of o.cgm.forced_gaps??[])rs.push({at:x.at_minute,text:`CGM断流${x.duration_minutes} min`});
 for(const x of o.cgm.compression_lows??[])rs.push({at:x.at_minute,text:`CGM压迫伪低${x.duration_minutes} min，深度参数${x.depth_mg_dl} mg/dL`});
 if(o.physiology.dawn_fraction)rs.push({at:0,text:`整日按北京时间使用现有黎明函数，dawn_fraction=${o.physiology.dawn_fraction}；03:00进入，05:00—08:00较强，10:00退出`});
 if(c.previous_id==='V4R2-F05')rs.push({at:10,text:'现有校准到期；无主动校准则不能继续得到新值'});
 if(c.previous_id==='V4R2-G05')rs.push({at:150,text:'若未被Agent取消，原延长输注承诺至此完成；这不是强制治疗事件'});
 rs.push({at:1440,text:'回合结束，未消退尾部不被解释为风险已结束'});return rs.sort((a,b)=>a.at-b.at);
}
const md=['# V4R3 精简设计：32个主情景','',
 '本轮只修订设计。A/B/G收敛为A、B共8题；D扩展至6题；H精简至4题。原legacy24及冻结结果不改，其中20题原样进入新核心，另外4题仍保留于legacy24。',
 '原A05/A06不作为主情景：当关键餐食记录被隐藏时，计碳高估/低估的标签已不可见，退化成实际摄入问题；这不代表两个不同摄入世界的曲线会相同。',
 '下表为作者设计卡，不是给模型的全知提示词。时间为北京时间；所有数值是合成仿真配置，不是临床剂量或饮食建议。τ为时间常数，不是吸收完毕时间。',
 '八个A/B主情景不包含机制对照世界。合并题的历史时点、恢复顺序进入对照，不额外重复计数。每物理世界有WAIT，信息投影及自身动作记忆规则保持。',
 '新目录未接入原注册表，新题未完成全轨迹/信息投影审计，未跑新模型。传感器/设备维护仍须Agent按原工具自行执行。','',
 '| 类别 | 设计意图 | 主情景数 |','|---|---|---:|',...Object.entries(families).map(([f,v])=>`| ${f} ${v.name} | ${v.intent} | ${counts[f]} |`),''];
for(const [f,v]of Object.entries(families)){
 md.push(`## ${f} ${v.name}`,'',v.intent,'');
 for(const c of cards.filter(c=>c.family===f))md.push(`### ${c.id} ${c.title}`,'',
  `来源：${c.previous_id??'新增D配置'}${c.legacy_id?`；原冻结题${c.legacy_id}，物理配置未变`:''}。`,
  `意图：${c.intent}`,`机制对照：${c.comparator}`,`I1规则草案：${JSON.stringify(c.partial_rules)}。正式运行前须核对有效投影。`,
  `依据：${c.evidence.join('、')}，来源同类现象不等于选定参数或组合已临床验证。`,
  `回合：${stamp(c.instance_spec,0)}—${stamp(c.instance_spec,1440)}；起点由历史回放获得，不覆盖成手工高值。`,'',
  '| 北京时间 | 实际预设事件 |','|---|---|',...rows(c).map(r=>`| ${stamp(c.instance_spec,r.at)}${r.at>1440?'（回合外）':''} | ${r.text.replaceAll('|','/').replaceAll('\n',' ')} |`),'');
}
md.push('## 精简与留档原则','',
 '原A05/A06移出；旧G01/G02合成B01主世界/时点对照；旧G03不单列，与B02不同剂量的诊断配置不能冒充匹配对照；旧G04仅作E类状态鉴别参考；旧G05进入B03；旧G06不单列，B04用原A03复合题。',
 'H04早恢复变体不单列；H06/H07的恢复顺序收敛为新H03，严格对照固定摄入、只改需求恢复时点，不能直接拿原H07不同餐量/加餐/起始时点作单因素对照。',
 'legacy24中未进入精简核心的原A01/B04/D01/D02仍保存其全部配置和实验。它们与新情景共享部分机制，但不再增加核心主情景数量。不宣称它们变简单、无效或应删除。',
 '核心32与legacy24共享20世界，不能当成56个独立世界汇总；在未增加机制对照/种子前，其并集是36。历史结果只在提示词/代码/世界等条件一致时可复用，不授权重新跑任何实验。',
 '', '## 证据及检查','',
 'D03/R03、D04/R06、D05/R07及R18、D06/R15均使用已有原语或明确代理，不新增机制。来源见[基础研究](scenario-family-evidence-v1-20261016.zh-CN.md)及[扩展研究](../sweet-sim/knowledge/scenario-hard-evidence-v3.json)。',
 '应激空腹反例只能作为额外辅助对照；不能给出一个无物理变化、只删掉文字后与普通背景相同的新全档位主题来凑数。',
 '检查：32唯一ID，A/B各4，D6，H4；28份物理配置与V4R2深比较一致，其中20份来自legacy24；4份新增D通过当前schema和初始化。不是临床验证或难度验证。','');
fs.writeFileSync(`${out}.zh-CN.md`,md.join('\n'));
console.log(JSON.stringify({out,...report.counts,legacy_not_in_core:legacyNotCore,schema_and_initialization:cards.length}));
