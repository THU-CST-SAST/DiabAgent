import test from 'node:test';
import assert from 'node:assert/strict';
import {cogiMetrics} from '../src/bench/cogi.mjs';
import {COGI48_VERSION,cogi48Metrics,cogi48FromStats} from '../src/bench/cogi48.mjs';
import {episodeScore,glucoseMetrics,dynamicMetrics,summarizeRun} from '../src/bench/score.mjs';
import {scoringTarget} from '../src/bench/scoring-target.mjs';
import {systemPrompt} from '../src/bench/prompt.mjs';
import {buildInstanceConfig} from '../src/sim/instance.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';
import * as scoring from '../src/bench/score.mjs';
import {scoreBundle} from '../src/export/harbor/score.mjs';
import {runFromBundle} from '../src/viz/run.mjs';
const near=(a,b)=>assert(Math.abs(a-b)<1e-10,`${a} != ${b}`);
test('exact inclusive 4-8 band differs from published COGI; hypo/GV unchanged',()=>{
 const values=[70,72.064,144.128,145,180];
 const a=cogi48Metrics(values),b=cogiMetrics(values);
 near(a.tir_percent,40);near(b.tir_percent,100);
 near(a.subscores.hypo,b.subscores.hypo);near(a.subscores.gv,b.subscores.gv);
 near(a.score-b.score,-30);assert.equal(a.published_cogi,false);
 assert.deepEqual(scoringTarget(COGI48_VERSION),{low_mg_dl:72.064,high_mg_dl:144.128});
});
test('worked example/endpoints/invalid/empty',()=>{
 near(cogi48FromStats({tir_4_8:.8,tbr70:.03,sd_mgdl:36}).score,80);
 assert.equal(cogi48Metrics([100,100]).score,100);
 assert.equal(cogi48Metrics([]).score,null);
 for(const a of [[NaN],[null],[Infinity],[0],[-1]])assert.throws(()=>cogi48Metrics(a));
 assert.throws(()=>cogi48FromStats({tir_4_8:1,tbr70:.2,sd_mgdl:18}));
});
test('episode branch same as samples; no safety veto or CV/ROC penalty',()=>{
 const xs=[50,50,50,90,100,140],{events,...glucose}=glucoseMetrics(xs),dynamic=dynamicMetrics(xs.map((g,i)=>({m:i*5,g})));
 const s=episodeScore({glucose,events,dynamic},undefined,{version:COGI48_VERSION});
 near(s.score,cogi48Metrics(xs).score);assert(s.safety_fail);assert.equal(s.safety_veto_applied,false);assert(s.score>0);
 assert.throws(()=>episodeScore({glucose,events},undefined,{version:COGI48_VERSION}));
 const rows=[{instance:'x',score:s.score,cogi:s,complete:true,state:'done'}];
 const summary=summarizeRun(rows,{scoringVersion:COGI48_VERSION,B:10});
 assert.equal(summary.weights_version,COGI48_VERSION);assert.equal(summary.normalization_reference,'none_absolute_0_100');
});
test('visible prompt uses new formula, retains safety/center, excludes obsolete veto/CV claims',()=>{
 const config=buildInstanceConfig({seed:20261020,horizon_minutes:4320}),obs=new SimEnv(config).observe();
 for(const units of ['mmol','mgdl']){
 const s=systemPrompt({config,obs,units,scoring_version:COGI48_VERSION,prompt_revision:'availability-consistency/v8-center-target'});
 assert(s.includes('0.50*S_TIR + 0.35*S_Hypo + 0.15*S_GV'));assert(s.includes('5-6 mmol/L'));
 assert(!s.includes('Below 3 mmol/L for at least 15 minutes scores zero'));
 assert(!s.includes('CV above 0.36'));assert(!s.includes('METRICS-v0.3 still rewards'));
 assert(!s.includes('Keep true blood glucose in the target range 3.9'));
 }
});
test('native exported reward and daily scores use the same explicit new version',()=>{
 const env=new SimEnv(buildInstanceConfig({seed:20261020,horizon_minutes:1440}));
 while(!env.done())env.step({action_id:'cogi48-'+env.step_count,expected_step:env.step_count,action:{type:'WAIT'}});
 const bundle=env.exportBundle(),result=scoreBundle(bundle,scoring,{scoring_version:COGI48_VERSION,verifier:'daily',references:{wait:20,oref0:30}});
 near(result.reward.reward,cogi48Metrics(scoring.trueGrid(bundle).map(p=>p.g)).score);
 near(result.daily[0].score,result.reward.reward);assert.equal(result.score.scoring_version,COGI48_VERSION);
 assert.deepEqual(result.score.weights,{tir:.5,hypo:.35,gv:.15});assert.equal(result.normalization.normalized,null);
 const run=runFromBundle(bundle,{scoringVersion:COGI48_VERSION});near(run.metrics.score,result.reward.reward);assert.equal(run.metrics.scoring_version,COGI48_VERSION);
 assert.equal(runFromBundle(bundle).metrics.scoring_version,'METRICS-v0.3');
});
