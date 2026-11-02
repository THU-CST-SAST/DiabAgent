import assert from 'node:assert/strict';

export const HYPOGLYCEMIA_REVISION='patient224-three-day/hypoglycemia-v2';
// Synthetic research inputs, not patient dosing or exercise recommendations.
export const HYPO_REPLACEMENTS=Object.freeze([
  {old:'a04',id:'a04',family:'A',title:'已给餐时胰岛素但早餐取消，长时间空腹',mechanism:'missed-meal-after-bolus'},
  {old:'b01',id:'b01',family:'B',title:'少量进食后重复给药，吸收结束而药效叠加',mechanism:'stacked-insulin-after-small-meal'},
  {old:'c04',id:'c04',family:'C',title:'早餐午餐均未吃，连续长时间有氧活动',mechanism:'prolonged-fasted-exercise'},
  {old:'f06',id:'f06',family:'F',title:'漏餐后运动引发真低血糖，CGM偏高掩盖下降',mechanism:'true-low-masked-by-positive-sensor-drift'},
]);
const meal=(id,at,grams,absorption=60)=>({id,type:'meal',at_minute:at,grams,announced_grams:grams,absorption_minutes:absorption});
const bolus=(id,at,units)=>({id,type:'patient_treatment',at_minute:at,action:{type:'BOLUS',units},announced:true});
const activity=(id,at,duration,counts)=>({id,type:'exercise',at_minute:at,duration_minutes:duration,accelerometer_counts:counts,announced:true});
const record=(id,at,text)=>({id,type:'record',at_minute:at,category:'meal',text});

export function hypoglycemiaEvents(id){
  assert(HYPO_REPLACEMENTS.some(r=>r.id===id));
  const events=[];
  for(let day=0;day<3;day++){
    const shift=[0,15,-15][day],base=day*1440,local=[];
    if(id==='a04')local.push(bolus('breakfast-dose',435+shift,7.5),record('cancelled-breakfast',450+shift,'Breakfast was cancelled after a full meal dose. No replacement food is scheduled before lunch.'));
    if(id==='b01')local.push(bolus('first-dose',420+shift,4),meal('small-breakfast',440+shift,10,20),bolus('second-dose',465+shift,4),record('no-more-food',480+shift,'The person ate only a small portion; the rest of breakfast was not eaten.'));
    if(id==='c04')local.push(record('fasting',420+shift,'The person has not eaten breakfast and will miss lunch.'),activity('long-activity',540+shift,180,3500),activity('second-activity',780+shift,90,3000));
    if(id==='f06')local.push(bolus('breakfast-dose',435+shift,4),record('missed-breakfast',450+shift,'The person did not eat the planned breakfast.'),activity('activity',510+shift,120,2500),
      {id:'sensor-positive-drift',type:'sensor_drift',at_minute:480+shift,duration_minutes:240,bias_mg_dl:35,ramp_minutes:30});
    local.push(meal('late-lunch',id==='c04'?930+shift:840+shift,55+[0,3,-3][day]),meal('dinner',1140+shift,65+[0,-3,3][day]),meal('evening-snack',1290+shift,15));
    events.push(...local.map(e=>({...e,id:`hypo-v2-d${day}-${e.id}`,at_minute:base+e.at_minute})));
  }
  return events.sort((a,b)=>a.at_minute-b.at_minute||a.id.localeCompare(b.id));
}

/** New publication identity; neither the source object nor its old worlds are overwritten. */
export function deriveHypoglycemiaRevision(source){
  assert.equal(source.hours,72);assert.equal(source.scenarios.length,32);assert.equal(source.world_ids.length,224);
  const config=structuredClone(source);assert(HYPO_REPLACEMENTS.every(r=>r.id===r.old));
  const factors=new Map(source.factors.map(f=>[f.id,f.id.replace('3d-v1','3d-hypo-v2')]));
  assert([...factors].every(([a,b])=>a!==b));
  config.name='patient224-three-day-hypoglycemia-v2-20261029';
  config.title='Three-day224 v2: four sparse severe-hypoglycemia replacements; original categories retained';
  config.factors=config.factors.map(f=>({...f,id:factors.get(f.id)}));
  config.world_ids=source.world_ids.map(old=>{
    let id=old;for(const [a,b]of factors)id=id.replace('-'+a+'-','-'+b+'-');
    return id;
  });
  const replacements=[];
  config.scenarios=config.scenarios.map(scene=>{
    const replacement=HYPO_REPLACEMENTS.find(r=>r.old===scene.id);if(!replacement)return scene;
    assert.equal(scene.family,replacement.family);
    const spec=structuredClone(scene.spec),o=spec.overrides;
    spec.start_time='2026-10-20T16:00:00.000Z';spec.horizon_minutes=4320;spec.self_care='none';
    o.patient={...o.patient,initial_glucose_mg_dl:120};
    o.initial_state={...o.initial_state,history_minutes:360,history:[{type:'calibrate_cgm',minutes_before:5}]};
    o.scenario={...o.scenario,meals:{},extra_events:hypoglycemiaEvents(replacement.id)};
    o.cgm={...o.cgm,error_scale:1,sensor_age_days_at_start:2};delete o.cgm.forced_gaps;delete o.cgm.compression_lows;
    replacements.push({...replacement,old_worlds:source.world_ids.filter(id=>id.startsWith(replacement.old+'-')).length,
      omitted_routine_food_until_local:replacement.id==='c04'?'15:30':'14:00'});
    return {...scene,id:replacement.id,title:replacement.title,spec,
      evidence:[...(scene.evidence??[]),'SYNTHETIC-PROSPECTIVE-HYPOGLYCEMIA-V2-NOT-CLINICALLY-VALIDATED']};
  });
  assert.equal(config.scenarios.length,source.scenarios.length);
  assert.deepEqual(config.scenarios.map(s=>s.id),source.scenarios.map(s=>s.id));
  assert.deepEqual(config.family_names,source.family_names);
  assert.equal(new Set(config.world_ids).size,224);
  const changed=replacements.reduce((n,r)=>n+r.old_worlds,0);
  return {config,registration:{version:HYPOGLYCEMIA_REVISION,source_name:source.name,templates:32,worlds:224,information:source.information,
    scenario_numbering:'inherited-original-ids',
    replacement_templates:4,unchanged_templates:28,replacement_worlds:changed,unchanged_worlds:224-changed,replacements,
    boundaries:['New version only; original configs, frozen running sources and results remain untouched.',
      'Only four within-family substitutions; patient/hardware selection cardinality and original information contract retained.',
      'Dose amounts are fixed synthetic scenario inputs, subject to the existing age scaling and device safety/rounding; not clinical instructions.',
      'Normal CGM error and lag retained. No truth clipping, direct glucose event or physiology constant change.',
      'Input-only revision; no new model experiment is launched by constructing this version.'],status:'inputs_only_requires_offline_qualification'}};
}
