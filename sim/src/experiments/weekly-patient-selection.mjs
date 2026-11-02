import {PATIENT_CODES,WEEKLY_MAIN_BLOCKS} from './weekly-selection.mjs';

export const PRIORITY_TEMPLATES=Object.freeze(['a02','a03','b02','b04','c01','d02','d04','e01','e03','h02','h03','h04']);
// Complementary omission pairs balance the eight patient strata without sampling outcomes.
const OMISSION_GROUPS=[
  {ages:['adult','older'],scenarios:['a01','b01','c04','d03','f03','f05','f06']},
  {ages:['child','adolescent'],scenarios:['a04','d05','h01']},
  {ages:['child','adult'],scenarios:['e02','e04']},
  {ages:['child','older'],scenarios:['c02','d01']},
  {ages:['adolescent','adult'],scenarios:['f01','f02']},
  {ages:['adolescent','older'],scenarios:['b03','f04']},
];
export const HARDWARE_ANCHORS=Object.freeze({a02:'AF',c01:'CM',d02:'TF',h02:'OM'});
const increment=(o,k)=>{o[k]=(o[k]??0)+1;};

export function selectPatientPriority(candidates) {
  if(candidates.format!=='sweet-sim.weekly-matrix-candidates/v1'||candidates.remaining_worlds!==928
    ||candidates.axes?.body_sizes?.join(',')!=='typical'||candidates.worlds.length!==928)
    throw Error('Expected the frozen 928-world typical-body pool');
  const index=new Map(candidates.worlds.map(w=>[[w.scenario,w.patient,w.backend].join('|'),w]));
  if(index.size!==928)throw Error('Duplicate candidate identities');
  const omitted=new Map();
  for(const {ages,scenarios} of OMISSION_GROUPS)scenarios.forEach((s,i)=>omitted.set(s,
    ages.map((a,j)=>`${a}-${(i+j)%2===0?'male':'female'}-typical`)));
  const worlds=[],blocks=[],coverage={family:{},backend:{},age_group:{},sex:{},patient:{},family_patient:{}},mainCoverage={family:{},age_group:{},sex:{},patient:{}};
  for(const scenario of Object.keys(WEEKLY_MAIN_BLOCKS)) {
    const alcohol=['c03','d06'].includes(scenario),priority=PRIORITY_TEMPLATES.includes(scenario);
    if(!alcohol&&!priority&&!omitted.has(scenario))throw Error(`Unassigned template: ${scenario}`);
    const patients=Object.entries(PATIENT_CODES).filter(([,p])=>alcohol?!p.startsWith('child-')&&!p.startsWith('adolescent-')
      :priority||!omitted.get(scenario).includes(p));
    if(patients.length!==(alcohol?4:priority?8:6))throw Error('Patient allocation count mismatch');
    for(const [code,patient] of patients) {
      const backends=HARDWARE_ANCHORS[scenario]===code?['pump_pct','pump_abs','pump_combo','pens']:['pump_pct'],ids=[];
      for(const backend of backends) {
        const w=index.get([scenario,patient,backend].join('|'));
        if(!w)throw Error(`Missing compatible candidate: ${scenario}/${patient}/${backend}`);
        if(w.family!==scenario[0].toUpperCase()||w.anthropometry.age_group!==patient.split('-')[0]
          ||w.demographics.sex!==patient.split('-')[1])throw Error(`Inconsistent candidate factors: ${w.id}`);
        if(alcohol&&w.demographics.age_years<18)throw Error('Minor alcohol is forbidden');
        const role=backend==='pump_pct'?'patient-main':'hardware-probe',row={...w,selection_role:role};
        worlds.push(row);ids.push(w.id);
        increment(coverage.family,w.family);increment(coverage.backend,backend);increment(coverage.age_group,w.anthropometry.age_group);
        increment(coverage.sex,w.demographics.sex);increment(coverage.patient,patient);
        coverage.family_patient[w.family]??={};increment(coverage.family_patient[w.family],patient);
        if(role==='patient-main') {
          increment(mainCoverage.family,w.family);increment(mainCoverage.age_group,w.anthropometry.age_group);
          increment(mainCoverage.sex,w.demographics.sex);increment(mainCoverage.patient,patient);
        }
      }
      blocks.push({scenario,patient,code,backends,world_ids:ids});
    }
  }
  if(worlds.length!==224||blocks.length!==212||new Set(worlds.map(w=>w.id)).size!==224)throw Error('Invalid patient-priority selection');
  if(Object.values(mainCoverage.age_group).some(n=>n!==53)||mainCoverage.sex.male!==106||mainCoverage.sex.female!==106)
    throw Error('Patient-main balance failed');
  if(Object.values(coverage.family_patient).some(p=>Object.keys(p).length!==8))throw Error('Missing family/patient coverage');
  return {format:'sweet-sim.weekly-main-selection/v1',name:'weekly-patient224-20261022',title:'Weekly R2: patient-priority 212 + 12 hardware probes',
    method:'patient-priority/212-plus-12/v1',source_sha256:candidates.source_sha256,world_seed:candidates.axes.world_seed,
    physical_worlds:224,main_worlds:212,hardware_probe_worlds:12,patient_scenario_blocks:212,
    information:candidates.axes.information,tasks_per_model:224*candidates.axes.information.length,baseline_worlds:224,
    policy:{outcome_filtering:false,world_seed_search:false,body_sizes:['typical'],priority_templates:PRIORITY_TEMPLATES,
      hardware_anchors:HARDWARE_ANCHORS,omission_groups:OMISSION_GROUPS,
      rationale:'Patient diversity first: 8 / 6 / 4 profiles per template, common Dana-i core, only four small complete hardware probes. Mechanistic hypotheses, not measured difficulty.'},
    coverage,main_coverage:mainCoverage,blocks,selected_ids:worlds.map(w=>w.id),worlds};
}
