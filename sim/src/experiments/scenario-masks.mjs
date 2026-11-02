import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {constructHardScenario} from './scenario-hard.mjs';
import {MODES,merge,auditScenario} from './scenario-generator.mjs';
import {buildBenchmark} from '../benchmark/build.mjs';
import {backgroundClock} from './scenario-background.mjs';

export const PROTOCOL='scenario-compound/v3-mask-r3';
export const CLOCK_PROTOCOL='scenario-compound/v3-mask-clock-v1';
export const ESTIMATE_PROTOCOL='scenario-compound/v3-mask-estimates-v1';
export const CLOCK_ESTIMATE_PROTOCOL='scenario-compound/v3-mask-estimates-clock-v1';
export const FAMILIES={A:'进餐与给药时序错配',B:'混合餐与吸收重叠',C:'活动与延迟风险',D:'胰岛素需求变化',E:'输注送达异常',F:'观测与传感器异常'};
const meal=ids=>({category:'meal',ids:ids.flatMap(id=>[id,`plan-${id}`])});
const category=category=>({category});
const ids=(category,...ids)=>({category,ids});
// Only availability changes. Physical scripts are the registered R2 scripts, without outcome filtering.
export const MASK_CASES=[
 ['A01','H01',[meal(['meal-0','meal-1'])]],
 ['A02','H04',[ids('meal','cancelled-lunch','meal-0')]],
 ['A03','H05',[ids('meal','recent-rescue','history:2')]],
 ['A04','H23',[category('treatment'),category('exercise')]],
 ['B01','H02',[meal(['meal-4'])]],
 ['B02','H03',[meal(['meal-0','meal-2'])]],
 ['B03','H06',[category('life')]],
 ['B04','H24',[category('treatment'),category('exercise')]],
 ['C01','H07',[ids('exercise','activity-1','plan-activity-1')]],
 ['C02','H08',[ids('exercise','activity-1','plan-activity-1')]],
 ['C03','H09',[ids('life','alcohol-540')]],
 ['C04','H10',[ids('exercise','activity-1','plan-activity-1')]],
 ['D01','H11',[ids('life','ill-recovery-0')]],
 ['D02','H12',[ids('life','ill-600','ill-recovery-600')]],
 ['D03','H13',[ids('life','stress-end-0','stress-end-600')]],
 ['D04','H14',[category('life')]],
 ['E01','H15',[meal(['meal-0'])]],
 ['E02','H16',[ids('fault','leak-report-400','leak-report-780')]],
 ['E03','H17',[ids('fault','leak-report-25')]],
 ['E04','H18',[ids('fault','leak-report-25')]],
 ['F01','H19',[category('fault')]],
 ['F02','H20',[category('fault')]],
 ['F03','H21',[meal(['meal-0','meal-1'])]],
 ['F04','H22',[ids('life','ill-recovery-0')]],
];

export function maskedScenario({preset,backgroundSeed=null,informationPolicy='record-derived-v3',...options}) {
 const row=MASK_CASES.find(r=>r[0]===preset);
 if(!row)throw new Error(`Unknown mask scenario ${preset}`);
 if(!['minimal-v2','record-derived-v3'].includes(informationPolicy))throw new Error(`Unsupported mask information policy: ${informationPolicy}`);
 const background=backgroundSeed==null?null:backgroundClock(preset,backgroundSeed);
 if(background&&options.startTime!=null)throw new Error('Do not combine backgroundSeed and startTime');
 const [,source,rules]=row,b=constructHardScenario({...options,...(background?{startTime:background.start_time}:{}),preset:source,revision:'r2'});
 const derived=informationPolicy==='record-derived-v3';
 const protocol=derived?(background?CLOCK_ESTIMATE_PROTOCOL:ESTIMATE_PROTOCOL):(background?CLOCK_PROTOCOL:PROTOCOL);
 const notes=b.notes.filter(n=>!n.includes('I2 retains'));
 notes.push(derived
   ? 'Record-derived-v3: I1 selectively withholds key records; I2 withholds every treatment/meal/activity/life/fault record. Numeric IOB/COB estimates remain available and are computed strictly after filtering records, never from hidden model state. Empty estimator inputs produce zero estimates, not proof of zero actual insulin/carbohydrate. Agent action memory and receipts remain available.'
   : 'R3 changes labels and record visibility only. I1 selectively withholds the listed key records; I2 withholds every treatment/meal/activity/life/fault record and IOB/COB. Missing does not mean zero. Agent action memory and receipts remain available.');
 if(background)notes.push('Clock-v1: one seeded absolute-clock offset per template, shared across models and masks. No mechanism, dose, intake, fault severity or relative interval tuning. Circadian phase may shift with clock time.');
 const base={...b,preset,source_preset:source,family:preset[0],family_name:FAMILIES[preset[0]],rules,notes,
   construction:{...b.construction,protocol,revision:derived?'mask-estimates-v1':background?'mask-clock-v1':'mask-r3',information_policy:informationPolicy,source_revision:'r2',source_preset:source,partial_mask:rules,model_limits:notes,
     ...(background?{background}: {})}};
 return {...base,variants:Object.fromEntries(MODES.map(mode=>[mode,merge(b.spec,{overrides:{information:{mode,policy:informationPolicy,rules:mode==='I1'?rules:[]}}})]))};
}

export function buildMaskedScenarios(outDir,{onProgress=()=>{},...options}={}) {
 if(fs.existsSync(outDir))throw new Error(`No overwrite: ${outDir}`);
 const rows=MASK_CASES.map(([preset])=>maskedScenario({...options,preset})),audits=[];
 for(const r of rows){audits.push(auditScenario(r));onProgress(`mask/truth audit: ${r.preset} <- ${r.source_preset}`);}
 const protocol=rows[0].construction.protocol,derived=rows[0].construction.information_policy==='record-derived-v3';
 const name=derived?`scenario24-v3-mask-estimates${options.backgroundSeed==null?'':'-clock'}-v1`:options.backgroundSeed==null?'scenario24-v3-mask-r3':'scenario24-v3-mask-clock-v1';
 const manifest=buildBenchmark({name,version:derived?'3.5':options.backgroundSeed==null?'3.3':'3.4',outDir,title:'24 R2 physical scenarios, A-F ordering and revised information masks',
   description:'Fixed-world Harbor full loop, METRICS-v0.3. No outcome filtering. I2 withholds all treatment and meal records.',
   experiments:MODES.map(mode=>({id:mode.toLowerCase(),track:'full',references:false,repeats:1,
     tasks:rows.map(r=>({task_id:`${r.preset.toLowerCase()}-${mode.toLowerCase()}`,spec:r.variants[mode],hours:r.spec.horizon_minutes/60,
       factors:{preset:r.preset,family:r.family,information:mode},metadata:{instance_id:r.preset,pair_id:r.preset,information:mode,title_zh:r.title,protocol}}))}))});
 const source=fs.readFileSync(new URL('./scenario-masks.mjs',import.meta.url),'utf8');
 fs.writeFileSync(path.join(outDir,'construction.json'),JSON.stringify({protocol,options,families:FAMILIES,
   generator_sha256:createHash('sha256').update(source).digest('hex'),
   evidence:JSON.parse(fs.readFileSync(new URL('../../knowledge/scenario-hard-evidence-v3.json',import.meta.url))),rows,audits},null,2)+'\n');
 fs.writeFileSync(path.join(outDir,'scenario-masks.source.mjs'),source);
 return {manifest,rows,audits};
}
