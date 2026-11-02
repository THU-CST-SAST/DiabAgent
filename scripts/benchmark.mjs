#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {ROOT,DATA,read,write,hash,fixture,taskRows,selectTasks,protocol,runBaseline,saveReport,policies} from './lib.mjs';
import {buildInstanceConfig} from '../sim/src/sim/instance.mjs';
import {publicInfo} from '../sim/src/export/harbor.mjs';
import {planScenarioPipeline,buildScenarioPipeline} from '../sim/src/experiments/scenario-pipeline.mjs';
import {resolveExperiment,saveDataset} from './experiment.mjs';
import {AGENT_OPTION_DEFAULTS} from '../sim/src/bench/agent-options.mjs';
import {KNOWLEDGE} from '../sim/src/knowledge.mjs';

export function options(argv){
  const out={};for(let i=0;i<argv.length;i++){
    assert(/^--[a-z-]+$/.test(argv[i]),'Expected --option');const k=argv[i].slice(2);assert(!(k in out),'Duplicate option');
    out[k]=argv[i+1]&&!argv[i+1].startsWith('--')?argv[++i]:'true';
  }return out;
}
const [command,...args]=process.argv.slice(2),opt=options(args);
const need=key=>{assert(opt[key]&&opt[key]!=='true','--'+key+' required');return opt[key];};
const experimentFlags=['experiment','dataset','hardware','scenarios','interval','agent-options',...Object.keys(AGENT_OPTION_DEFAULTS).map(k=>k.replaceAll('_','-'))];
const allowed={verify:[],list:[],catalog:[],prepare:['out','tasks','limit',...experimentFlags],create:['spec','out'],pipeline:['config','out'],baselines:['out','tasks','limit','policies',...experimentFlags],run:['out','tasks','limit','harness','model','binary','endpoint','key-env','parallel','decision-redraw','model-catalog','harness-config','harness-module','dry-run',...experimentFlags],report:['bundle','out'],results:['run','report']};
try{
  assert(Object.hasOwn(allowed,command),'Commands: verify | list | catalog | prepare | create | pipeline | baselines | run | results | report (see README.md)');
  for(const key of Object.keys(opt))assert(allowed[command].includes(key),'Unknown option --'+key);
  if(command==='verify'){
    const rows=taskRows();assert.equal(rows.length,212);assert.equal(new Set(rows.map(r=>r.task_id)).size,212);
    for(const row of rows){const f=fixture(row),c=f.instance.config;assert.equal(f.instance.id,row.task_id);assert.equal(c.horizon_minutes,4320);assert.equal(c.information.mode,'I2');assert.equal(c.therapy.pump.model,'dana_i');assert.equal(c.therapy.pump.insulin,'aspart');assert.equal(c.controller.enabled,false);assert.equal(f.pub.scoring_version,'COGI-4-8/v1');}
    const original=read(DATA+'/original-runtime-hashes.json');
    const differences=original.files.filter(r=>hash(fs.readFileSync(ROOT+'sim/'+r.path))!==r.sha256).map(r=>r.path);
    const extensions=read(DATA+'/runtime-extensions.json');
    assert.deepEqual(differences,extensions.files.map(f=>f.path),'Undocumented runtime difference');
    for(const file of extensions.files)assert.equal(hash(fs.readFileSync(ROOT+'sim/'+file.path)),file.sha256,'Extension source changed: '+file.path);
    console.log(JSON.stringify({tasks:212,scenario_templates:new Set(rows.map(r=>r.scene)).size,fixture_hashes:'original byte-identical',runtime_extensions:'verified',documented_differences:differences,model_calls:0},null,2));
  }else if(command==='list')console.log(JSON.stringify(taskRows().map(({task_id,scene,patient})=>({task_id,scene,patient})),null,2));
  else if(command==='catalog')console.log(JSON.stringify({hardware_presets:read(ROOT+'configs/hardware.json'),pumps:KNOWLEDGE.pumps,pens:KNOWLEDGE.pens,insulins:KNOWLEDGE.insulins,sensors:KNOWLEDGE.sensors,agent_options:AGENT_OPTION_DEFAULTS},null,2));
  else if(command==='prepare'){
    const experiment=resolveExperiment(opt),out=saveDataset(experiment,need('out'));
    console.log(JSON.stringify({out,tasks:experiment.rows.length,mode:experiment.mode,protocol:experiment.protocol,model_calls:0},null,2));
  }
  else if(command==='create'){
    const spec=read(need('spec')),config=buildInstanceConfig(spec),id=spec.id??'custom-task',out=path.resolve(need('out'));
    assert(/^[a-z0-9-]+$/.test(id));assert(!fs.existsSync(out));fs.mkdirSync(out,{recursive:true});
    const pub=publicInfo(spec,config,{taskId:id});pub.scoring_version='COGI-4-8/v1';
    write(out+'/fixture.json',{instance:{id,config},pub});write(out+'/public.json',pub);
    console.log(JSON.stringify({created:out,model_calls:0}));
  }else if(command==='pipeline'){
    const config=read(need('config'));const plan=planScenarioPipeline(config);
    if(opt.out){assert(!fs.existsSync(opt.out));buildScenarioPipeline(opt.out,config);}
    console.log(JSON.stringify({counts:plan.counts,model_calls:0},null,2));
  }else if(command==='baselines'){
    const experiment=resolveExperiment(opt),rows=experiment.rows,names=(opt.policies??experiment.baseline.policies?.join(',')??'standard,guideline,oref1').split(','),interval=Number(opt.interval??experiment.baseline.interval_minutes??(experiment.mode==='main212'?15:experiment.protocol.agent_options.fixed_interval_minutes));
    assert(names.length&&new Set(names).size===names.length&&names.every(n=>Object.hasOwn(policies,n)),'Unknown or duplicate baseline');
    assert(Number.isInteger(interval)&&interval>=5&&interval%5===0);
    const out=path.resolve(need('out'));assert(!fs.existsSync(out),'Output already exists');fs.mkdirSync(out,{recursive:true});
    write(out+'/PLAN.json',{tasks:rows.map(({input,...r})=>r),policies:names,interval_minutes:interval,scoring_version:experiment.protocol.scoring_version,protocol:experiment.protocol,experiment_mode:experiment.mode});
    const results=[];
    for(const row of rows)for(const name of names){
      const {bundle,result}=runBaseline(fixture(row),{policy:name,interval,extraLimit:experiment.protocol.agent_options.max_extra_decisions_per_day,evaluation:experiment.protocol}),dir=out+'/'+name+'/'+row.task_id;
      write(dir+'/RESULT.json',result);if(bundle){write(dir+'/bundle.json',bundle);saveReport(dir,bundle,experiment.protocol);}results.push({task_id:row.task_id,...result});
      write(out+'/RESULTS.json',results);console.error(`${results.length}/${rows.length*names.length} ${name} ${row.task_id} ${result.score?.toFixed(3)??result.state}`);
    }
    const summary=names.map(policy=>{const rs=results.filter(r=>r.policy===policy&&r.state==='complete');return {policy,n:rs.length,score:rs.length?rs.reduce((s,r)=>s+r.score,0)/rs.length:null,
      subscores:Object.fromEntries(['tir','hypo','gv'].map(k=>[k,rs.length&&rs.every(r=>Number.isFinite(r.score_details.subscores?.[k]))?rs.reduce((s,r)=>s+r.score_details.subscores[k],0)/rs.length:null]))};});
    write(out+'/SUMMARY.json',summary);console.log(JSON.stringify(summary,null,2));
  }else if(command==='run'){
    const experiment=resolveExperiment(opt);opt.harness??=experiment.harness;
    if(opt['dry-run']==='true'){console.log(JSON.stringify({tasks:experiment.rows.length,mode:experiment.mode,hardware:experiment.hardware,protocol:experiment.protocol,model_calls:0},null,2));}
    else{
    need('out');need('harness');need('model');
    if(opt['decision-redraw']!==undefined)assert(['true','false'].includes(opt['decision-redraw']));
    const {runModels}=await import('./run-model.mjs');await runModels(experiment.rows,opt,experiment);
    }
  }else if(command==='results'){
    const {summarizeResults}=await import('./results.mjs');
    const result=summarizeResults(need('run'),{report:opt.report==='true'});
    console.table(result.groups);console.log(JSON.stringify({counts:result.counts,summary:result.summary_file,csv:result.csv_file,report:result.report_file},null,2));
  }else if(command==='report'){
    const out=path.resolve(need('out'));assert(!fs.existsSync(out));fs.mkdirSync(out,{recursive:true});saveReport(out,read(need('bundle')));console.log(out+'/index.html');
  }
}catch(error){console.error(error.message);process.exitCode=1;}
