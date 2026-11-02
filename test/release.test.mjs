import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT,read,fixture,taskRows,runBaseline,scoreBundle,saveReport,assertEndpoint} from '../scripts/lib.mjs';
import {verifySkillAssets} from '../sim/src/bench/skill-assets.mjs';
import {verifyNativeSkillEdition} from '../harnesses/claude-code-decision-loop/native-skill.mjs';
import {buildInstanceConfig} from '../sim/src/sim/instance.mjs';
import {SimEnv} from '../sim/src/env/pomdp.mjs';

const cli=args=>spawnSync(process.execPath,['scripts/benchmark.mjs',...args],{cwd:ROOT,encoding:'utf8',env:{PATH:process.env.PATH,HOME:os.tmpdir()}});

test('all212 original task byte hashes, physics and scoring contract verify without keys',()=>{
  const result=cli(['verify']);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).tasks,212);
  const rows=taskRows();assert.equal(new Set(rows.map(r=>r.task_id)).size,212);
  for(const row of rows){const f=fixture(row);assert.equal(f.instance.config.horizon_minutes,4320);assert.equal(f.pub.scoring_version,'COGI-4-8/v1');}
});

test('two model-independent harness defaults and exact derived Skill are available',()=>{
  for(const harness of ['claude-code','codex']){
    const settings=read(ROOT+'configs/harnesses/'+harness+'.json');assert.equal(settings.harness,harness);assert(!settings.config.model);
  }
  assert.equal(Object.keys(read(ROOT+'experiments/paper/models.json')).length,5);
  const assets=verifySkillAssets(ROOT+'sim/skills/main212');verifyNativeSkillEdition(assets.source);
  assert.equal(assets.source.sha256,read(ROOT+'benchmark/main212/protocol.json').native_skill.assets_sha256);
  assert.equal(fs.realpathSync(ROOT+'sim/harnesses/claude-code-decision-loop/runtime'),fs.realpathSync(ROOT+'sim'));
});

test('both native model engines load from an isolated checkout without cluster paths',async()=>{
  const code=await import('../harnesses/claude-code-decision-loop/model.mjs');
  const codex=await import('../harnesses/codex-decision-loop/model.mjs');
  assert.equal(typeof code.createDecisionLoopModel,'function');assert.equal(typeof codex.createCodexDecisionLoopModel,'function');
});

test('documented single-task constructor runs and keeps private config outside public.json',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'diabagent-constructor-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const result=cli(['create','--spec','examples/task.json','--out',dir+'/new']);assert.equal(result.status,0,result.stderr);
  const f=read(dir+'/new/fixture.json'),pub=read(dir+'/new/public.json');
  assert.equal(pub.scoring_version,'COGI-4-8/v1');assert(!pub.config&&!pub.evaluator_only&&!pub.scenario);
  const env=new SimEnv(f.instance.config);const obs=env.observe();assert(!obs.true_glucose_mg_dl&&!obs.scenario);
  const again=cli(['create','--spec','examples/task.json','--out',dir+'/new']);assert.notEqual(again.status,0);
  assert.deepEqual(read(dir+'/new/fixture.json'),f);
  const config=buildInstanceConfig(read(ROOT+'examples/task.json'));assert.equal(config.therapy.pump.model,'dana_i');
});

test('baseline 5/15/60min share frozen world, score and original framework player',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'diabagent-baseline-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const input=fixture(taskRows()[0]);
  for(const interval of [5,15,60]){
    const {bundle,result}=runBaseline(input,{policy:'oref1',interval});
    assert.equal(result.steps,864);assert.equal(bundle.evaluator_only.states.length,865);
    assert.deepEqual(bundle.manifest.config,input.instance.config);assert.equal(result.score,scoreBundle(bundle).score);
    const subs=result.score_details.subscores;assert(Math.abs(result.score-(0.5*subs.tir+0.35*subs.hypo+0.15*subs.gv))<1e-10);
    if(interval!==5)assert.equal(result.decisions.fixed_decisions,4320/interval);
    const out=dir+'/'+interval;fs.mkdirSync(out);saveReport(out,bundle);
    const html=fs.readFileSync(out+'/index.html','utf8');assert(html.includes('window.RUNS='));assert(!html.includes('<script src="player.js">'));assert(html.length>50000);
  }
});

test('paid runs cannot start from missing endpoint/credentials; bad args fail closed',()=>{
  for(const args of [['run','--harness','claude-code','--model','vendor/new-model'],['list','--unknown','1'],['baselines','--policies','bogus','--out','artifacts/never-created']])assert.notEqual(cli(args).status,0);
  assert(!fs.existsSync(ROOT+'artifacts/never-created'));
  assert.throws(()=>assertEndpoint('https://user:secret@example.com'));
  assert.throws(()=>assertEndpoint('http://example.com'));
  assert.throws(()=>assertEndpoint('https://example.com/?key=secret'));
});

test('documented baseline CLI publishes total/components and cannot overwrite results',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'diabagent-baseline-cli-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const args=['baselines','--limit','1','--policies','standard','--interval','15','--out',dir+'/new'];
  const result=cli(args);assert.equal(result.status,0,result.stderr);
  const summary=read(dir+'/new/SUMMARY.json');assert.equal(summary[0].n,1);assert(Number.isFinite(summary[0].subscores.hypo));
  assert.notEqual(cli(args).status,0);assert.deepEqual(read(dir+'/new/SUMMARY.json'),summary);
});
