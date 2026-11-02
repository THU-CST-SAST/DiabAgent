// Fixed balanced blocks: never read scores, trajectories, model responses or selection seeds.
export const PATIENT_CODES=Object.freeze({
  CM:'child-male-typical',CF:'child-female-typical',TM:'adolescent-male-typical',TF:'adolescent-female-typical',
  AM:'adult-male-typical',AF:'adult-female-typical',OM:'older-male-typical',OF:'older-female-typical',
});
export const WEEKLY_MAIN_BLOCKS=Object.freeze({
  a01:['CM','TF'],a02:['CF','TM'],a03:['AM','OF'],a04:['AF','OM'],
  b01:['CM','AF'],b02:['TF','OM'],b03:Object.keys(PATIENT_CODES),b04:['AM','OF'],
  c01:['CM','TF'],c02:['CF','TM'],c03:['AM','OF'],c04:['AF','OM'],
  d01:['CM','TF'],d02:['CF','TM'],d03:['AM','OF'],d04:['AF','OM'],d05:['CF','TM'],d06:['AM','OF'],
  e01:['CM','TF','AM'],e02:['CF','TM','OF'],e03:['CM','AF','OM'],e04:['TF','AM','OF'],
  f01:['CM','TF'],f02:['CF','TM'],f03:['AM','OF'],f04:['AF','OM'],f05:['CF','TM'],f06:['AF','OM'],
  h01:['CM','TF'],h02:['CF','TM'],h03:['AM','OF'],h04:['AF','OM','CM'],
});
const BACKENDS=['pump_pct','pump_abs','pump_combo','pens'];
const backendsFor=scenario=>scenario==='b03'?['pump_pct']
  :scenario.startsWith('e')||scenario==='h04'?BACKENDS.slice(0,3):BACKENDS;
const increment=(o,k)=>{o[k]=(o[k]??0)+1;};

export function selectWeeklyMain(candidates) {
  if(candidates.format!=='sweet-sim.weekly-matrix-candidates/v1'||candidates.remaining_worlds!==928
    ||candidates.axes?.body_sizes?.join(',')!=='typical')throw Error('Expected the frozen 928-world typical-body candidate pool');
  const index=new Map();
  for(const w of candidates.worlds) {
    const key=[w.scenario,w.patient,w.backend].join('|');
    if(index.has(key))throw Error(`Duplicate candidate identity: ${key}`);
    index.set(key,w);
  }
  if(index.size!==928)throw Error('Candidate count differs from declared count');
  const worlds=[],blocks=[],coverage={family:{},backend:{},age_group:{},sex:{},patient:{},family_patient:{}};
  for(const [scenario,codes] of Object.entries(WEEKLY_MAIN_BLOCKS))for(const code of codes) {
    const patient=PATIENT_CODES[code],backends=backendsFor(scenario),ids=[];
    for(const backend of backends) {
      const w=index.get([scenario,patient,backend].join('|'));
      if(!w)throw Error(`Missing compatible candidate: ${scenario}/${patient}/${backend}`);
      if(w.family!==scenario[0].toUpperCase()||w.anthropometry.age_group!==patient.split('-')[0]
        ||w.demographics.sex!==patient.split('-')[1])throw Error(`Inconsistent candidate factors: ${w.id}`);
      if(['c03','d06'].includes(scenario)&&w.demographics.age_years<18)throw Error('Minor alcohol is forbidden');
      worlds.push(w);ids.push(w.id);
      increment(coverage.family,w.family);increment(coverage.backend,backend);
      increment(coverage.age_group,w.anthropometry.age_group);increment(coverage.sex,w.demographics.sex);
      increment(coverage.patient,patient);
      coverage.family_patient[w.family]??={};increment(coverage.family_patient[w.family],patient);
    }
    blocks.push({scenario,patient,code,backends,world_ids:ids});
  }
  if(worlds.length!==261||new Set(worlds.map(w=>w.id)).size!==261)throw Error('Invalid 261-world selection');
  if(Object.values(coverage.family_patient).some(x=>Object.keys(x).length!==8))throw Error('Every family must cover all eight patient configurations');
  return {format:'sweet-sim.weekly-main-selection/v1',method:'fixed-patient-blocks/all-compatible-backends/v1',
    source_sha256:candidates.source_sha256,world_seed:candidates.axes.world_seed,
    physical_worlds:261,patient_scenario_blocks:blocks.length,information:candidates.axes.information,
    tasks_per_model:261*candidates.axes.information.length,baseline_worlds:261,
    policy:{outcome_filtering:false,world_seed_search:false,body_sizes:['typical'],
      rationale:'Keep all 32 templates and complete compatible hardware blocks; balance age/sex across each family. No new world or event parameters.'},
    coverage,blocks,selected_ids:worlds.map(w=>w.id),worlds};
}

export function selectedPipelineConfig(config,selection) {
  if(config.factors?.length!==1||config.world_seeds?.length!==1||config.background_seeds?.length!==1
    ||config.world_seeds[0]!==selection.world_seed)throw Error('Expected one frozen factor, world seed and background seed');
  const [factor]=config.factors,[background]=config.background_seeds;
  const world_ids=selection.worlds.map(w=>[w.scenario,w.patient,w.backend.replaceAll('_','-'),factor.id,
    `s${selection.world_seed}`,background===null?'bnone':`b${background}`].join('-'));
  return {...structuredClone(config),name:selection.name??'weekly-main261-20261022',title:selection.title??'Weekly R2: 261 balanced paired worlds',
    on_incompatible:'error',world_ids};
}
