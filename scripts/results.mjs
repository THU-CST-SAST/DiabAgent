import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {read,write,scoreBundle} from './lib.mjs';
import {runFromBundle} from '../sim/src/viz/run.mjs';
import {playerPage} from '../sim/src/bench/report.mjs';

const finite=n=>typeof n==='number'&&Number.isFinite(n);
const mean=xs=>{const valid=xs.filter(finite);return valid.length?valid.reduce((s,n)=>s+n,0)/valid.length:null;};
const csv=rows=>rows.map(r=>r.map(v=>v==null?'':'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\n')+'\n';

export function summarizeResults(directory,{report=false}={}){
  const root=fs.realpathSync(path.resolve(directory)),plan=read(root+'/PLAN.json');
  const baseline=Array.isArray(plan.policies);
  const evaluation=plan.protocol??{},version=evaluation.scoring_version??plan.scoring_version??'COGI-4-8/v1';evaluation.scoring_version=version;
  const status=baseline?null:read(root+'/STATUS.json');
  const planned=baseline?plan.tasks.flatMap(t=>plan.policies.map(policy=>({task_id:t.task_id,policy}))):status.tasks;
  assert(Array.isArray(planned),'Run has no task registry');
  const records=[],runs=[],counts={complete:0,running:0,interrupted:0,unstarted:0,invalid:0};
  for(const task of planned){
    assert(/^[a-z0-9-]+$/.test(task.task_id),'Invalid task path');
    if(baseline)assert(/^[a-z0-9-]+$/.test(task.policy),'Invalid policy path');
    const dir=baseline?path.join(root,task.policy,task.task_id):path.join(root,'trials',task.task_id);
    const result=fs.existsSync(dir+'/RESULT.json')?read(dir+'/RESULT.json'):task;
    let state=result.state??'unstarted',score=null,subscores=null,problem=null;
    if(state==='complete'){
      try{
        assert(finite(result.score),'Missing finite completed score');
        if(!baseline){
          assert.equal(result.audit_valid,true,'Trajectory audit is not valid');
          const file=['adapter','custom'].includes(plan.harness)?'ADAPTER-AUDIT.json':plan.harness==='codex'?'CODEX-AUDIT.json':'DECISION-LOOP-AUDIT.json';
          const audit=read(dir+'/'+file);assert.equal(audit.valid,true,'Native audit is not valid');
          assert(finite(audit.scientific_score)&&Math.abs(audit.scientific_score-result.score)<1e-8,'Native reward differs');
        }
        const bundle=read(dir+'/bundle.json');
        assert.equal(bundle.metrics.steps,bundle.trajectory.length);assert.equal(bundle.evaluator_only.states.length,bundle.trajectory.length+1);
        assert.equal(bundle.metrics.elapsed_minutes,bundle.manifest.config.horizon_minutes);
        assert.equal(bundle.metrics.completed_horizon,true);
        const verified=scoreBundle(bundle,evaluation);assert(finite(verified.score)&&Math.abs(verified.score-result.score)<1e-8,'Bundle score differs');
        if(version.startsWith('COGI'))assert(['tir','hypo','gv'].every(k=>finite(verified.subscores[k])),'Missing component scores');
        score=verified.score;subscores=verified.subscores??{};
        if(report){
          const run=runFromBundle(bundle,{id:task.task_id,scoringVersion:version});run.metrics.score=score;
          run.id=(task.policy??plan.model)+' / '+task.task_id;runs.push(run);
        }
      }catch(error){state='invalid';problem=error.message;}
    }
    if(state==='not_applicable')counts.not_applicable??=0;
    if(!Object.hasOwn(counts,state))state='interrupted';counts[state]++;
    records.push({task_id:task.task_id,model:task.policy??plan.model,state,score,subscores,problem});
  }
  const groups=[...new Set(records.map(r=>r.model))].map(model=>{
    const rows=records.filter(r=>r.model===model),valid=rows.filter(r=>r.state==='complete');
    return {model,total:rows.length,complete:valid.length,score:mean(valid.map(r=>r.score)),COGI:version.startsWith('COGI')?mean(valid.map(r=>r.score)):null,
      S_TIR:mean(valid.map(r=>r.subscores.tir)),S_Hypo:mean(valid.map(r=>r.subscores.hypo)),S_GV:mean(valid.map(r=>r.subscores.gv))};
  });
  const summary_file=root+'/summary.json',csv_file=root+'/summary.csv';
  const result={updated:new Date().toISOString(),status_updated:status?.updated??null,terminal:status?.terminal??null,
    counts,groups,tasks:records,scoring_version:version,experiment_mode:plan.experiment_mode??'main212',aggregation:'equal-task mean over complete valid trajectories',summary_file,csv_file,report_file:null};
  if(report&&runs.length){
    fs.mkdirSync(root+'/report',{recursive:true});result.report_file=root+'/report/index.html';
    fs.writeFileSync(result.report_file,playerPage(runs));
  }
  write(summary_file,result);
  fs.writeFileSync(csv_file,csv([['model','total','complete','scoring_version','score','COGI','S_TIR','S_Hypo','S_GV'],...groups.map(g=>[g.model,g.total,g.complete,version,g.score,g.COGI,g.S_TIR,g.S_Hypo,g.S_GV])]));
  fs.writeFileSync(root+'/tasks.csv',csv([['model','task_id','state','scoring_version','score','COGI','S_TIR','S_Hypo','S_GV'],...records.map(r=>[r.model,r.task_id,r.state,version,r.score,version.startsWith('COGI')?r.score:null,r.subscores?.tir,r.subscores?.hypo,r.subscores?.gv])]));
  return result;
}
