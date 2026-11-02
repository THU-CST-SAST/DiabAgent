#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {ROOT,DATA,read,write,hash,fixture,taskRows,selectTasks,protocol,runBaseline,saveReport,policies} from './lib.mjs';
import {buildInstanceConfig} from '../sim/src/sim/instance.mjs';
import {publicInfo} from '../sim/src/export/harbor.mjs';
import {planScenarioPipeline,buildScenarioPipeline} from '../sim/src/experiments/scenario-pipeline.mjs';

export function options(argv){
  const out={};for(let i=0;i<argv.length;i++){
    assert(/^--[a-z-]+$/.test(argv[i]),'Expected --option');const k=argv[i].slice(2);assert(!(k in out),'Duplicate option');
    out[k]=argv[i+1]&&!argv[i+1].startsWith('--')?argv[++i]:'true';
  }return out;
}
const [command,...args]=process.argv.slice(2),opt=options(args);
const need=key=>{assert(opt[key]&&opt[key]!=='true','--'+key+' required');return opt[key];};
const allowed={verify:[],list:[],create:['spec','out'],pipeline:['config','out'],baselines:['out','tasks','limit','policies','interval'],run:['out','tasks','limit','harness','model','binary','endpoint','key-env','parallel','decision-redraw','model-catalog'],report:['bundle','out'],results:['run','report']};
try{
  assert(Object.hasOwn(allowed,command),'Commands: verify | list | create | pipeline | baselines | run | results | report (see README.md)');
  for(const key of Object.keys(opt))assert(allowed[command].includes(key),'Unknown option --'+key);
  if(command==='verify'){
    const rows=taskRows();assert.equal(rows.length,212);assert.equal(new Set(rows.map(r=>r.task_id)).size,212);
    for(const row of rows){const f=fixture(row),c=f.instance.config;assert.equal(f.instance.id,row.task_id);assert.equal(c.horizon_minutes,4320);assert.equal(c.information.mode,'I2');assert.equal(c.therapy.pump.model,'dana_i');assert.equal(c.therapy.pump.insulin,'aspart');assert.equal(c.controller.enabled,false);assert.equal(f.pub.scoring_version,'COGI-4-8/v1');}
    const original=read(DATA+'/original-runtime-hashes.json');
    const differences=original.files.filter(r=>hash(fs.readFileSync(ROOT+'sim/'+r.path))!==r.sha256).map(r=>r.path);
    assert.deepEqual(differences,['src/bench/models/tool-contract.mjs'],'Undocumented runtime difference');
    console.log(JSON.stringify({tasks:212,scenario_templates:new Set(rows.map(r=>r.scene)).size,fixture_hashes:'verified',physics:'original byte-identical',documented_differences:differences,model_calls:0},null,2));
  }else if(command==='list')console.log(JSON.stringify(taskRows().map(({task_id,scene,patient})=>({task_id,scene,patient})),null,2));
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
    const rows=selectTasks(opt),names=(opt.policies??'standard,guideline,oref1').split(','),interval=Number(opt.interval??15);
    assert(names.length&&new Set(names).size===names.length&&names.every(n=>Object.hasOwn(policies,n)),'Unknown or duplicate baseline');
    assert([5,10,15,20,30,45,60,90,120].includes(interval));
    const out=path.resolve(need('out'));assert(!fs.existsSync(out),'Output already exists');fs.mkdirSync(out,{recursive:true});
    write(out+'/PLAN.json',{tasks:rows,policies:names,interval_minutes:interval,scoring_version:protocol().scoring_version});
    const results=[];
    for(const row of rows)for(const name of names){
      const {bundle,result}=runBaseline(fixture(row),{policy:name,interval}),dir=out+'/'+name+'/'+row.task_id;
      write(dir+'/bundle.json',bundle);write(dir+'/RESULT.json',result);saveReport(dir,bundle);results.push({task_id:row.task_id,...result});
      write(out+'/RESULTS.json',results);console.error(`${results.length}/${rows.length*names.length} ${name} ${row.task_id} ${result.score.toFixed(3)}`);
    }
    const summary=names.map(policy=>{const rs=results.filter(r=>r.policy===policy);return {policy,n:rs.length,score:rs.reduce((s,r)=>s+r.score,0)/rs.length,
      subscores:Object.fromEntries(['tir','hypo','gv'].map(k=>[k,rs.reduce((s,r)=>s+r.score_details.subscores[k],0)/rs.length]))};});
    write(out+'/SUMMARY.json',summary);console.log(JSON.stringify(summary,null,2));
  }else if(command==='run'){
    need('out');need('harness');need('model');need('binary');need('endpoint');
    if(opt['decision-redraw']!==undefined)assert(['true','false'].includes(opt['decision-redraw']));
    const {runModels}=await import('./run-model.mjs');await runModels(selectTasks(opt),opt);
  }else if(command==='results'){
    const {summarizeResults}=await import('./results.mjs');
    const result=summarizeResults(need('run'),{report:opt.report==='true'});
    console.table(result.groups);console.log(JSON.stringify({counts:result.counts,summary:result.summary_file,csv:result.csv_file,report:result.report_file},null,2));
  }else if(command==='report'){
    const out=path.resolve(need('out'));assert(!fs.existsSync(out));fs.mkdirSync(out,{recursive:true});saveReport(out,read(need('bundle')));console.log(out+'/index.html');
  }
}catch(error){console.error(error.message);process.exitCode=1;}
