#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseArgs,list,progressLine} from '../src/benchmark/cli.mjs';
import {planScenarioPipeline,buildScenarioPipeline,runScenarioPipeline} from '../src/experiments/scenario-pipeline.mjs';

const [command,...argv]=process.argv.slice(2),opt=parseArgs(argv);
process.env.PATH=[path.dirname(process.execPath),process.env.PATH??'/usr/bin:/bin'].join(path.delimiter);
const need=key=>{if(!opt[key])throw Error(`--${key} required`);return opt[key];};
const json=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const child=(script,args)=>{
  const r=spawnSync(process.execPath,[script,...args],{stdio:'inherit'});
  if(r.error)throw r.error;if(r.status!==0)throw Error(`${script} exited ${r.status}`);
};
try {
  if(command==='plan'||command==='build') {
    const config=json(need('config'));
    const plan=command==='plan'?planScenarioPipeline(config):buildScenarioPipeline(need('out'),config,{onProgress:console.error}).plan;
    console.log(JSON.stringify({protocol:plan.protocol,name:plan.name,counts:plan.counts,information:plan.information,
      cases:plan.rows.map(r=>({id:r.preset,title:r.title,factors:r.factors})),rejected:plan.rejected},null,2));
  } else if(command==='run') {
    const models=list(need('models')).map(m=>{const i=m.indexOf('=');if(i<1)throw Error('--models uses id=CONFIG.json,id2=CONFIG.json');return {id:m.slice(0,i),config:m.slice(i+1)};});
    const result=await runScenarioPipeline({benchmarkDir:need('benchmark'),jobsDir:opt['jobs-dir']??'artifacts/benchmarks/jobs',runId:need('run-id'),models,
      information:opt.information?list(opt.information):null,parallel:Number(opt.parallel??16),modelDraws:Number(opt.draws??1),repeats:Number(opt.repeats??1),
      withWait:opt['no-wait']!=='true',apiTries:Number(opt['api-tries']??4),agentOptions:{...(opt['agent-options']?JSON.parse(opt['agent-options']):{simulate:true,simulate_calls:1}),
        ...(opt['prompt-revision']?{prompt_revision:opt['prompt-revision']}:{})},
      onTrial:(t,p)=>console.error(progressLine(t,p))});
    console.log(JSON.stringify(result.map(r=>({job:r.job_dir,incomplete:r.incomplete,trials:r.result.trials})),null,2));
    if(result.some(r=>r.incomplete))process.exitCode=1;
  } else if(command==='report') {
    const out=need('out'),empty=path.join(path.resolve(out),'.empty-inputs');fs.mkdirSync(empty,{recursive:true});
    child('scripts/mvp-report.mjs',['--out',out,'--jobs-dir',opt['jobs-dir']??'artifacts/benchmarks/jobs','--jobs',need('jobs'),
      '--exp3',empty,'--exp4',empty,'--oracle',empty,'--title',opt.title??'Scenario pipeline：Agent 实验记录',
      ...(opt.selection?['--selection',opt.selection]:[])]);
  } else if(command==='freeze') {
    child('scripts/freeze-experiment.mjs',['--archive',need('archive'),...(opt.verify?['--verify']:
      ['--benchmark',need('benchmark'),'--jobs',need('jobs'),'--report',need('report'),...(opt.extra?['--extra',opt.extra]:[])])]);
  } else throw Error('Usage: node scripts/scenario-pipeline.mjs plan|build|run|report|freeze [options]; see docs/SCENARIO-PIPELINE.zh-CN.md');
} catch(e){console.error(e.stack??e.message);process.exitCode=1;}
