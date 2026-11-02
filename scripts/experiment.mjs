import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {ROOT,DATA,read,hash,write,taskRows,fixture,protocol} from './lib.mjs';
import {buildInstanceConfig} from '../sim/src/sim/instance.mjs';
import {normalizeConfig} from '../sim/src/core/config.mjs';
import {publicInfo} from '../sim/src/export/harbor.mjs';
import {parseAgentOptions,AGENT_OPTION_DEFAULTS} from '../sim/src/bench/agent-options.mjs';
import {planScenarioPipeline} from '../sim/src/experiments/scenario-pipeline.mjs';
import {KNOWLEDGE} from '../sim/src/knowledge.mjs';

const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
export function merge(a,b){
  if(!object(a)||!object(b))return structuredClone(b);
  const out=structuredClone(a);for(const [k,v]of Object.entries(b)){assert(!['__proto__','constructor','prototype'].includes(k),'Unsafe configuration key');out[k]=object(v)&&object(out[k])?merge(out[k],v):structuredClone(v);}return out;
}
const jsonOption=v=>typeof v==='string'?JSON.parse(v):v??{};
const resolve=(base,p)=>path.resolve(base,p);
function makeFixture(spec,id,scoring){
  const config=buildInstanceConfig(spec),pub=publicInfo(spec,config,{taskId:id});pub.scoring_version=scoring;
  return {instance:{id,config},pub};
}
function dataset(source,base,scoring){
  if(source===undefined||source==='main212')return {rows:taskRows().map(r=>({...r,input:fixture(r)})),inherited:null};
  if(typeof source==='string'){
    const file=resolve(base,source);
    if(fs.statSync(file).isDirectory()){
      if(fs.existsSync(file+'/TASKS.json'))return {rows:read(file+'/TASKS.json').map(r=>{const bytes=fs.readFileSync(file+'/fixtures/'+r.task_id+'.json');assert.equal(hash(bytes),r.fixture_sha256);return {...r,input:JSON.parse(bytes)};}),inherited:fs.existsSync(file+'/EXPERIMENT.json')?read(file+'/EXPERIMENT.json'):null};
      if(fs.existsSync(file+'/fixture.json'))return dataset({fixture:file+'/fixture.json'},base,scoring);
      if(fs.existsSync(file+'/construction.json')){const c=read(file+'/construction.json');return dataset({pipeline:c.config},file,scoring);}
      throw Error('Dataset needs TASKS.json + fixtures/, fixture.json, or construction.json');
    }
    return dataset({fixture:file},base,scoring);
  }
  assert(object(source),'dataset must be main212, a path, or an object');
  if(source.fixture){const file=resolve(base,source.fixture),bytes=fs.readFileSync(file),input=JSON.parse(bytes);assert(input.instance?.config&&input.pub,'Expected a fixture; use dataset.spec for a task specification');return {rows:[{task_id:input.instance.id,fixture_sha256:hash(bytes),input}],inherited:null};}
  if(source.spec){const spec=typeof source.spec==='string'?read(resolve(base,source.spec)):source.spec,id=spec.id??'custom-task';return {rows:[{task_id:id,input:makeFixture(spec,id,scoring)}],inherited:null};}
  if(source.pipeline){
    const config=typeof source.pipeline==='string'?read(resolve(base,source.pipeline)):source.pipeline,plan=planScenarioPipeline(config);
    return {rows:plan.rows.flatMap(row=>plan.information.map(mode=>{const id=row.preset+'-'+mode.toLowerCase();return {task_id:id,scene:row.scenario_id,factors:row.factors,input:makeFixture(row.variants[mode],id,scoring)};})),inherited:null};
  }
  throw Error('dataset object requires fixture, spec, or pipeline');
}

export function resolveExperiment(options={}){
  const file=options.experiment?fs.realpathSync(options.experiment):null,base=file?path.dirname(file):process.cwd(),custom=file?read(file):{};
  const allowed=new Set(['name','dataset','selection','hardware','world','agent_options','runtime','model','harness','scoring_version','units','baseline','native_skill']);
  for(const key of Object.keys(custom))assert(allowed.has(key),'Unknown experiment field: '+key);
  const defaults=protocol();let scoring=custom.scoring_version??defaults.scoring_version;
  const source=options.dataset?path.resolve(options.dataset):custom.dataset??'main212';
  const loaded=dataset(source,base,scoring),inherited=loaded.inherited?.protocol??{};
  scoring=custom.scoring_version??inherited.scoring_version??scoring;
  const flags=jsonOption(options['agent-options']);for(const key of Object.keys(AGENT_OPTION_DEFAULTS)){const flag=key.replaceAll('_','-');if(options[flag]!==undefined)flags[key]=options[flag];}
  const agent=parseAgentOptions(merge(merge(defaults.agent_options,inherited.agent_options??{}),merge(custom.agent_options??{},merge(flags,options.interval?{decision_schedule:'hourly',fixed_interval_minutes:Number(options.interval)}:{}))));
  const runtime=merge({max_native_turns:7,max_reference_reads:3,logical_timeout_ms:240000,max_turns:400,max_format_errors:3,outer_api_tries:1},merge(inherited.runtime??{},custom.runtime??{}));
  for(const [k,min,max]of [['max_native_turns',1,256],['max_reference_reads',0,100],['logical_timeout_ms',1,86400000],['max_turns',1,1000000],['max_format_errors',1,1000000],['outer_api_tries',1,100]])assert(Number.isInteger(runtime[k])&&runtime[k]>=min&&runtime[k]<=max,'Invalid runtime.'+k);
  const hardware=options.hardware??custom.hardware,patch=hardware?(typeof hardware==='string'?read(ROOT+'configs/hardware.json')[hardware]:hardware):{};
  assert(patch!==undefined,'Unknown hardware preset: '+hardware);
  const world=merge(patch,custom.world??{}),selection=custom.selection??{};
  let rows=loaded.rows;
  const scenarios=options.scenarios?options.scenarios.split(','):selection.scenarios;
  if(scenarios){const wanted=new Set(scenarios.map(x=>x.toLowerCase()));rows=rows.filter(r=>wanted.has((r.scene??r.task_id.split('-')[0]).toLowerCase()));}
  const ids=options.tasks?options.tasks.split(','):selection.tasks;
  if(ids){const wanted=new Set(ids);rows=rows.filter(r=>wanted.delete(r.task_id));assert.equal(wanted.size,0,'Unknown task IDs');}
  const limit=options.limit??selection.limit;if(limit!==undefined){assert(Number.isInteger(Number(limit))&&Number(limit)>0);rows=rows.slice(0,Number(limit));}
  assert(rows.length>0,'No selected tasks');
  for(const row of rows){
    assert(/^[a-z0-9-]+$/.test(row.task_id),'Invalid task identifier');
    const original=row.input,patched=Object.keys(world).length?merge(original.instance.config,world):null;
    if(patched&&world.horizon_minutes!==undefined)patched.scenario.extra_events=patched.scenario.extra_events.filter(e=>e.at_minute<patched.horizon_minutes);
    const config=patched?normalizeConfig(patched):original.instance.config;
    assert(config.horizon_minutes>agent.warmup_days*1440,'warmup_days must leave a scored horizon');
    if(config.controller.enabled&&config.controller.mode==='closed')assert(config.therapy.mode==='pump'&&KNOWLEDGE.sensors[config.cgm.model]?.modality==='cgm','Closed-loop hardware requires a pump and real-time CGM');
    if(config!==original.instance.config||original.pub.scoring_version!==scoring){
      const pub=publicInfo({seed:config.seed,overrides:config},config,{taskId:row.task_id});pub.scoring_version=scoring;
      row.input={instance:{id:row.task_id,config},pub};
    }
    row.source_fixture_sha256=row.fixture_sha256??null;row.fixture_sha256=hash(JSON.stringify(row.input,null,2)+'\n');row.config_sha256=hash(JSON.stringify(config));row.horizon_minutes=config.horizon_minutes;
  }
  assert.equal(new Set(rows.map(r=>r.task_id)).size,rows.length,'Duplicate task identifiers');
  const effective={...defaults,agent_options:agent,runtime,scoring_version:scoring,options:{units:custom.units??inherited.options?.units??defaults.options.units},
    model:merge(inherited.model??{},custom.model??{}),native_skill:merge(merge(defaults.native_skill,inherited.native_skill??{}),custom.native_skill??{})};
  effective.model.reasoning_effort??=agent.reasoning_effort??'high';
  effective.max_turns=runtime.max_turns;effective.max_format_errors=runtime.max_format_errors;effective.max_native_turns_per_decision=runtime.max_native_turns;
  effective.logical_timeout_ms=runtime.logical_timeout_ms;effective.native_skill.max_reads_per_decision=runtime.max_reference_reads;
  assert(!['api_key','key','token'].some(k=>Object.hasOwn(effective.model,k)),'Use a credential environment variable');
  const customized=file||options.dataset||options.hardware||options.interval||options.scenarios||options['agent-options']||Object.keys(AGENT_OPTION_DEFAULTS).some(k=>options[k.replaceAll('_','-')]!==undefined);
  return {name:custom.name??loaded.inherited?.name??'main212',mode:customized?'custom':'main212',
    rows,protocol:effective,harness:options.harness??custom.harness??loaded.inherited?.harness??null,baseline:merge(loaded.inherited?.baseline??{},custom.baseline??{}),config_file:file,hardware:hardware??loaded.inherited?.hardware??null};
}

export function saveDataset(experiment,out){
  const root=path.resolve(out);assert(!fs.existsSync(root),'Dataset output already exists');fs.mkdirSync(root,{recursive:true});
  const rows=experiment.rows.map(({input,...row})=>{write(root+'/fixtures/'+row.task_id+'.json',input);return row;});
  write(root+'/TASKS.json',rows);write(root+'/EXPERIMENT.json',{name:experiment.name,mode:experiment.mode,protocol:experiment.protocol,harness:experiment.harness,hardware:experiment.hardware,baseline:experiment.baseline});
  return root;
}
