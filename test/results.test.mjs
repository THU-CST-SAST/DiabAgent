import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ROOT,fixture,taskRows,runBaseline,write,read} from '../scripts/lib.mjs';
import {summarizeResults} from '../scripts/results.mjs';

const tasks=taskRows().slice(0,6);
let baseline;
test.before(()=>{baseline=runBaseline(fixture(tasks[0]),{policy:'standard',interval:15});});
const temp=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'diabagent-results-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};

test('model summary includes only complete audited scores and renders the framework report',t=>{
  const root=temp(t),model='provider/custom-model';
  write(root+'/PLAN.json',{harness:'claude-code',model});
  write(root+'/STATUS.json',{updated:'2026-11-02T00:00:00Z',terminal:false,tasks:tasks.map((r,i)=>({task_id:r.task_id,state:['complete','interrupted','running','unstarted','complete','complete'][i]}))});
  for(const [i,score,audit_valid] of [[0,baseline.result.score,true],[4,baseline.result.score+1,true],[5,baseline.result.score,false]]){
    const dir=root+'/trials/'+tasks[i].task_id;
    write(dir+'/RESULT.json',{state:'complete',audit_valid,score});write(dir+'/bundle.json',baseline.bundle);
    write(dir+'/DECISION-LOOP-AUDIT.json',{valid:audit_valid,scientific_score:score});
  }
  const result=summarizeResults(root,{report:true});
  assert.deepEqual(result.counts,{complete:1,running:1,interrupted:1,unstarted:1,invalid:2});
  assert.equal(result.groups[0].COGI,baseline.result.score);assert.equal(result.groups[0].S_TIR,baseline.result.score_details.subscores.tir);
  assert.equal(result.status_updated,'2026-11-02T00:00:00Z');assert(result.tasks.filter(r=>r.state!=='complete').every(r=>r.score===null));
  const html=fs.readFileSync(result.report_file,'utf8');assert(html.includes('window.RUNS='));assert(html.includes(tasks[0].task_id));assert(!html.includes(tasks[4].task_id));
  assert(fs.readFileSync(root+'/summary.csv','utf8').includes('"S_Hypo"'));assert(fs.readFileSync(root+'/tasks.csv','utf8').includes('"unstarted","COGI-4-8/v1",,,,,\n'));
  assert.equal(read(root+'/summary.json').groups[0].model,model);
});

test('empty run means remain null and do not produce an invented completed score',t=>{
  const root=temp(t);write(root+'/PLAN.json',{harness:'codex',model:'another-model'});
  write(root+'/STATUS.json',{updated:'2026-11-02T00:00:00Z',terminal:false,tasks:[{task_id:tasks[0].task_id,state:'unstarted'}]});
  const result=summarizeResults(root,{report:true});assert.equal(result.groups[0].COGI,null);assert.equal(result.groups[0].S_Hypo,null);assert.equal(result.report_file,null);
});

test('baseline output supports the same score exports and interactive report',t=>{
  const root=temp(t),row=tasks[0];write(root+'/PLAN.json',{tasks:[row],policies:['standard'],interval_minutes:15});
  write(root+'/standard/'+row.task_id+'/RESULT.json',baseline.result);write(root+'/standard/'+row.task_id+'/bundle.json',baseline.bundle);
  const result=summarizeResults(root,{report:true});assert.equal(result.groups[0].COGI,baseline.result.score);assert.equal(result.counts.complete,1);assert(fs.existsSync(result.report_file));
});
