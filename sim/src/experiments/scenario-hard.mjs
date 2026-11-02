import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {constructScenario,merge,MODES,auditScenario} from './scenario-generator.mjs';
import {buildBenchmark} from '../benchmark/build.mjs';
import {buildInstanceConfig} from '../sim/instance.mjs';

export const PROTOCOL='scenario-compound/v3-hard-r1';
export const HARD_PRESETS={
 H01:['不规则快吸收大餐连续冲击',['R01','R20','R21']],H02:['全天分散加餐与慢吸收晚餐',['R14','R20','R21']],
 H03:['两次慢餐尾部叠加快速碳水',['R14','R18']],H04:['预打后进食取消并开始运动',['R01','R04']],
 H05:['既有药效与未吸收补碳后再迟餐',['R01','R18']],H06:['午夜混合餐叠加缺觉和黎明',['R14','R03','R06']],
 H07:['两段长时间运动穿插高碳水补给',['R04','R17']],H08:['高强度暂升后接长时间有氧',['R16','R04']],
 H09:['晚间活动和饮酒后次晨低糖压力',['R05','R15']],H10:['夜间慢餐后次晨连续两次活动',['R14','R17']],
 H11:['疾病高需求中摄入减少后恢复',['R08','R01']],H12:['疾病需求两次上升与恢复',['R08','R20']],
 H13:['餐后应激结束后叠加活动',['R07','R04']],H14:['缺觉与黎明后恢复正常需求',['R06','R03']],
 H15:['无报警送达不足遇到快吸收餐',['R19','R09','R20']],H16:['三次间歇送达不足与不规则进食',['R19','R09']],
 H17:['送达恢复后叠加慢餐与运动',['R19','R14','R04']],H18:['无报警送达不足叠加渐进伪高',['R19','R22']],
 H19:['真实活动下降叠加渐进伪高',['R04','R22']],H20:['真实餐后升高叠加伪低与补给',['R20','R11']],
 H21:['多次快餐和活动都发生在CGM断流中',['R20','R12']],H22:['疾病恢复期伴错误校准和漂移',['R08','R13','R22']],
 H23:['既往纠正未完整记录且进餐改变',['R20','R01']],H24:['既往叠加给药后慢餐与运动再交错',['R20','R17','R18']],
};
export const TARGETS=Object.freeze({full_mean_at_least:.75,sparse_mean_at_most:.5,mean_gap_at_least:.25,
  sparse_defect_cases_at_least:8,defect_definition:'S<0.5 or severe-hypoglycemia veto; exploratory benchmark criterion, not a clinical threshold',
  rejection_policy:'No outcome filtering; all specified cases, including full-information failures, are reported.'});
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');

export function constructHardScenario({preset,seed=20261017,revision='r1',...options}={}) {
 if(!['r1','r2'].includes(revision))throw new Error(`Unknown compound revision ${revision}`);
 if(!HARD_PRESETS[preset])throw new Error(`Unknown compound preset ${preset}`);
 const base=constructScenario({...options,seed,preset:'A03'}),spec=structuredClone(base.spec),o=spec.overrides;
 const ev=[],hist=o.initial_state.history.filter(e=>e.type==='calibrate_cgm');o.initial_state.history=hist;
 const note=['Compound stress test: source studies support components, not these combined parameter trajectories.'];
 let partial='meals';
 const record=(id,at,category,text)=>ev.push({id,type:'record',at_minute:at,category,text});
 const startMinute=(Date.parse(spec.start_time)/60000+480)%1440;
 const clock=m=>{const x=(startMinute+m)%1440;return `${String(Math.floor(x/60)).padStart(2,'0')}:${String(x%60).padStart(2,'0')}`;};
 const meal=(at,g,tau=45,intent=true)=>{
   const id=`meal-${ev.filter(e=>e.type==='meal').length}`;
   ev.push({id,type:'meal',at_minute:at,grams:g,announced_grams:g,absorption_minutes:tau});
   if(intent)record(`plan-${id}`,Math.max(0,at-35),'meal',`Current intention: meal around ${clock(at)}, estimated ${g} g carbohydrate; ${tau<=20?'fast-carbohydrate food/drink':tau>=120?'mixed meal reported high in fat/protein':'ordinary meal'}. This is a patient plan, not a guaranteed future glucose response.`);
 };
 const meals=xs=>xs.forEach(x=>meal(...x));
 const activity=(at,duration=90,counts=4317,kind='aerobic',hep=0)=>{
   const id=`activity-${ev.filter(e=>e.type==='exercise').length}`;
   ev.push({id,type:'exercise',at_minute:at,duration_minutes:duration,accelerometer_counts:counts,announced:true,kind,hepatic_delta_mg_dl_per_min:hep});
   record(`plan-${id}`,Math.max(0,at-40),'exercise',`Person intends ${kind} activity around ${clock(at)} for about ${duration} minutes; ${counts>=4000?'vigorous/prolonged':'moderate'} effort. Timing may change.`);
 };
 const ill=(at,hours,increase)=>{ev.push({id:`ill-${at}`,type:'illness',at_minute:at,duration_hours:hours,insulin_need_increase:increase,announced:true});
   record(`ill-recovery-${at}`,at+hours*60,'life','Person reports fever/nausea have improved and appetite is changing; review recent insulin before repeating corrections. Exact insulin sensitivity is unknown.');};
 const sleep=(duration=1080,decrease=.25)=>ev.push({id:'sleep',type:'sleep_loss',at_minute:0,duration_minutes:duration,sensitivity_decrease:decrease,announced:true});
 const alcohol=(at,onset=6,hours=8,hep=-.5)=>ev.push({id:`alcohol-${at}`,type:'alcohol',at_minute:at,onset_hours:onset,duration_hours:hours,hepatic_delta_mg_dl_per_min:hep,announced:true});
 const stress=(at,duration=120,hep=.5)=>{ev.push({id:`stress-${at}`,type:'stress',at_minute:at,duration_minutes:duration,hepatic_delta_mg_dl_per_min:hep});
   record(`stress-end-${at}`,at+duration,'life','The stressful activity has ended; person reports feeling calmer. Previously delivered insulin remains active.');};
 const leak=(at,duration=600,fraction=.15)=>{
   ev.push({id:`leak-${at}`,type:'infusion_deficit',at_minute:at,duration_minutes:duration,delivered_fraction:fraction});
   record(`leak-report-${at}`,at,'fault','Person notices wet adhesive or a loose infusion cannula. Pump display can still appear running; inspect the infusion site. Exact delivered fraction is unknown.');
 };
 const drift=(at,duration=360,bias=75,ramp=60)=>{
   ev.push({id:`drift-${at}`,type:'sensor_drift',at_minute:at,duration_minutes:duration,bias_mg_dl:bias,ramp_minutes:ramp});
   record(`sensor-report-${at}`,at,'fault','Person reports a sensor-site problem or possible interference. Sensor values may not reflect blood glucose; an independent meter is available. Direction and magnitude are not supplied.');
 };
 const bolus=(ago,units)=>hist.push({type:'bolus',minutes_before:ago,units});
 switch(preset) {
 case 'H01':meals([[40,90,15],[230,80,15],[475,100,18],[760,65,15],[1190,80,18]]);break;
 case 'H02':meals([[45,65,30],[155,35,12],[270,45,15],[400,40,15],[520,95,140],[690,35,12],[980,30,15],[1190,65,25]]);break;
 case 'H03':meals([[45,90,150],[200,35,12],[370,95,160],[580,40,15],[850,35,12],[1190,70,35]]);break;
 case 'H04':bolus(15,8);meal(45,15,25,false);record('cancelled-lunch',0,'meal','A planned 80 g meal was cancelled after a pre-meal dose. Only a small snack is currently available; do not assume the planned meal will arrive.');meals([[260,65,20],[560,85,60],[1170,70,25]]);activity(50,100,4317);partial='exercise';break;
 case 'H05':bolus(45,6);hist.push({type:'carbs',minutes_before:5,grams:15});record('recent-rescue',0,'meal','Person reports a 15 g rescue drink five minutes ago; it may not yet have fully acted. Main meal is delayed.');meals([[130,60,150],[420,85,25],[760,55,15],[1200,70,30]]);break;
 case 'H06':sleep(1080,.25);o.physiology.dawn_fraction=.45;meals([[45,70,25],[390,65,40],[720,95,180],[990,30,12],[1210,75,18]]);partial='life';break;
 case 'H07':meals([[45,75,30],[220,70,18],[420,80,20],[640,65,35],[1190,75,20]]);activity(110,100,4317);activity(460,100,4317);partial='exercise';break;
 case 'H08':meals([[45,75,35],[290,85,20],[610,70,30],[1190,75,20]]);activity(130,35,0,'anaerobic',.9);activity(185,100,4317);activity(660,70,2095);partial='exercise';break;
 case 'H09':meals([[45,70,30],[380,85,140],[650,30,20],[1190,55,20]]);activity(300,90,4317);alcohol(540,5,9,-.55);partial='life';break;
 case 'H10':meals([[45,65,30],[480,90,140],[800,40,15],[1170,75,25]]);activity(365,80,2095);activity(1090,85,4317);activity(1240,60,2095);partial='exercise';break;
 case 'H11':ill(0,10,1.2);meals([[45,30,40],[300,25,60],[660,85,15],[920,70,20],[1220,75,25]]);partial='life';break;
 case 'H12':ill(0,4,1.4);ill(600,4,1.4);meals([[45,55,20],[270,90,15],[650,45,30],[890,85,15],[1210,65,25]]);partial='life';break;
 case 'H13':stress(0,150,.5);stress(600,120,.5);meals([[45,90,35],[300,65,20],[650,80,25],[1190,70,20]]);activity(180,100,4317);activity(760,75,2095);partial='life';break;
 case 'H14':sleep(1080,.3);o.physiology.dawn_fraction=.55;meals([[45,70,25],[400,75,40],[740,50,15],[1130,90,15]]);activity(1220,70,4317);partial='life';break;
 case 'H15':leak(25,900,.1);meals([[45,85,15],[300,85,20],[580,75,25],[940,65,20],[1210,70,20]]);partial='fault';break;
 case 'H16':leak(25,230,.1);leak(400,230,.2);leak(780,240,.1);meals([[45,80,15],[280,70,20],[440,80,20],[820,80,15],[1190,70,25]]);partial='fault';break;
 case 'H17':leak(25,300,.15);ev.push({id:'repair',type:'infusion_recovery',at_minute:325});record('repair-report',325,'fault','Infusion site problem was corrected. Review active insulin and food before further dosing.');meals([[45,80,30],[250,80,150],[600,65,20],[1190,70,25]]);activity(380,100,4317);partial='fault';break;
 case 'H18':leak(25,700,.15);drift(75,480,65,90);meals([[45,85,18],[300,80,25],[650,75,20],[1190,65,25]]);partial='fault';break;
 case 'H19':drift(30,480,85,90);drift(800,360,65,60);meals([[45,55,35],[330,65,30],[700,60,25],[1190,65,20]]);activity(120,100,4317);activity(870,80,2095);partial='fault';break;
 case 'H20':drift(30,480,-80,60);o.cgm.compression_lows=[{at_minute:830,duration_minutes:90,depth_mg_dl:65}];meals([[45,95,15],[240,65,15],[480,80,20],[850,75,15],[1190,65,25]]);partial='fault';break;
 case 'H21':o.cgm.forced_gaps=[{at_minute:20,duration_minutes:240},{at_minute:440,duration_minutes:210},{at_minute:1050,duration_minutes:180}];meals([[45,85,15],[180,70,20],[470,80,18],[600,65,20],[1100,70,18],[1240,50,20]]);activity(300,90,4317);partial='exercise';break;
 case 'H22':ill(0,5,1.2);ev.push({id:'wrong-calibration',type:'sensor_calibration_error',at_minute:270,bias_mg_dl:45});drift(300,420,55,90);meals([[45,60,35],[330,40,25],[690,90,15],[1190,70,25]]);partial='life';break;
 case 'H23':o.patient.initial_glucose_mg_dl=210;bolus(70,3);bolus(20,4);record('meal-change',0,'meal','Lunch will be much smaller than originally planned; prior correction insulin may still be active.');meals([[80,20,150],[360,80,15],[660,75,25],[1190,70,20]]);activity(45,90,4317);partial='treatment';break;
 case 'H24':o.patient.initial_glucose_mg_dl=190;hist.push({type:'meal',minutes_before:100,grams:80,announced_grams:80,absorption_minutes:150});bolus(115,6);bolus(20,2);meals([[100,25,15],[350,70,20],[620,85,130],[1190,70,25]]);activity(80,90,4317);alcohol(600,5,8,-.45);partial='treatment';break;
 }
 if(revision==='r2') {
   // A registered global load envelope, not a per-case search against model rewards.
   const food=ev.filter(e=>e.type==='meal'),total=food.reduce((s,e)=>s+e.grams,0),scale=Math.min(1,240/total);
   for(const e of food) {
     e.grams=e.announced_grams=Math.round(e.grams*scale);
     e.absorption_minutes=Math.max(60,e.absorption_minutes);
     const plan=ev.find(p=>p.id===`plan-${e.id}`);
     if(plan)plan.text=`Current intention: meal around ${clock(e.at_minute)}, estimated ${e.grams} g carbohydrate; ${e.absorption_minutes>=120?'mixed meal reported high in fat/protein':'ordinary meal'}. Timing and actual intake may change; this is not a future glucose prediction.`;
   }
   for(const e of ev) {
     if(e.type==='exercise') {
       e.duration_minutes=Math.min(e.duration_minutes,60);
       e.accelerometer_counts=Math.min(e.accelerometer_counts,2095);
       e.hepatic_delta_mg_dl_per_min=Math.min(e.hepatic_delta_mg_dl_per_min,.45);
       const plan=ev.find(p=>p.id===`plan-${e.id}`);
       if(plan)plan.text=`Person intends ${e.kind} activity around ${clock(e.at_minute)} for about ${e.duration_minutes} minutes; moderate effort. Timing may change.`;
     }
     if(e.type==='illness')e.insulin_need_increase=Math.min(e.insulin_need_increase,.6);
     if(e.type==='alcohol')e.hepatic_delta_mg_dl_per_min=Math.max(e.hepatic_delta_mg_dl_per_min,-.25);
     if(e.type==='sleep_loss')e.sensitivity_decrease=Math.min(e.sensitivity_decrease,.2);
     if(e.type==='stress')e.hepatic_delta_mg_dl_per_min=Math.min(e.hepatic_delta_mg_dl_per_min,.3);
   }
   const doses=hist.filter(e=>e.type==='bolus'),sum=doses.reduce((s,e)=>s+e.units,0);
   if(sum>4)for(const e of doses)e.units=Math.round(e.units*4/sum*20)/20;
   o.physiology.dawn_fraction=Math.min(o.physiology.dawn_fraction??0,.3);
   if(preset==='H04')ev.find(e=>e.id==='cancelled-lunch').text='A planned 40 g meal was cancelled after a pre-meal dose. Only a small snack is currently available; do not assume the planned meal will arrive.';
   note.push('R2 globally limits scripted dietary intake to approximately 240 g/day, ordinary absorption time constants to at least 60 min, moderate exercise bouts to 60 min, illness need increases to 60%, and initial bolus history to 4 U. Event timing, information masks and silent faults are retained. These are protocol hypotheses, not literature-fitted coefficients.');
 }
 o.scenario.extra_events=ev.sort((a,b)=>a.at_minute-b.at_minute||a.id.localeCompare(b.id));
 const firstMeals=ev.filter(e=>e.type==='meal').slice(0,2).flatMap(e=>[e.id,`plan-${e.id}`]);
 const rules=partial==='meals'?[{category:'meal',ids:firstMeals}]:partial==='treatment'?[{category:'treatment'},{category:'exercise'}]:[{category:partial}];
 if(partial==='treatment')note.push('I1 hides prior treatment and exercise; I2 retains the prior treatment ledger but hides meal/activity/life/fault records. These masks are not ordered severity levels.');
 note.push('Reported near-term intentions are provided as current patient records; they are not guaranteed future events or hidden physiological parameters.');
 buildInstanceConfig(spec);
 return {preset,title:HARD_PRESETS[preset][0],evidence:HARD_PRESETS[preset][1],spec,rules,notes:note,
   construction:{protocol:PROTOCOL.replace('r1',revision),revision,no_outcome_filtering:true,initial_history:structuredClone(hist),events:structuredClone(ev),
     total_scripted_carbs_g:ev.filter(e=>e.type==='meal').reduce((s,e)=>s+e.grams,0),partial_mask:rules,model_limits:note}};
}

export function hardVariants(options) {
 const b=constructHardScenario(options);
 return {...b,variants:Object.fromEntries(MODES.map(mode=>[mode,merge(b.spec,{overrides:{information:{mode,rules:mode==='I1'?b.rules:[]}}})]))};
}
export function buildHardScenarios(outDir,{presets=Object.keys(HARD_PRESETS),onProgress=()=>{},...options}={}) {
 if(fs.existsSync(outDir))throw new Error(`No overwrite: use a new version directory, ${outDir} already exists`);
 const rows=presets.map(preset=>hardVariants({...options,preset})),audits=[];
 for(const r of rows){audits.push(auditScenario(r));onProgress(`compound mechanism/information audit: ${r.preset}`);}
 const source=fs.readFileSync(new URL('./scenario-hard.mjs',import.meta.url));
 const revision=options.revision??'r1',protocol=PROTOCOL.replace('r1',revision);
 const manifest=buildBenchmark({name:`scenario24-v3-hard-${revision}`,version:revision==='r1'?'3.1':'3.2',outDir,title:`Compound stress scenarios, ${revision}`,
   description:'Simulation only. Frozen compound hypotheses, no outcome filtering, same Harbor full loop and METRICS-v0.3.',
   experiments:MODES.map(mode=>({id:mode.toLowerCase(),track:'full',references:false,repeats:1,
     tasks:rows.map(r=>({task_id:`${r.preset.toLowerCase()}-${mode.toLowerCase()}`,spec:r.variants[mode],hours:r.spec.horizon_minutes/60,
       factors:{preset:r.preset,family:r.preset,information:mode},metadata:{instance_id:r.preset,pair_id:r.preset,information:mode,title_zh:r.title,protocol}}))}))});
 fs.writeFileSync(path.join(outDir,'construction.json'),JSON.stringify({protocol,options,targets:TARGETS,
   generator_sha256:hash(source.toString()),evidence:JSON.parse(fs.readFileSync(new URL('../../knowledge/scenario-hard-evidence-v3.json',import.meta.url))),rows,audits},null,2)+'\n');
 fs.writeFileSync(path.join(outDir,'scenario-hard.source.mjs'),source);
 return {manifest,rows,audits};
}
