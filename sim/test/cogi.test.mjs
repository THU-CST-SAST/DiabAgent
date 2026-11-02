import test from 'node:test';
import assert from 'node:assert/strict';
import {cogiFromStats,cogiMetrics} from '../src/bench/cogi.mjs';
import {episodeScore,glucoseMetrics,summarizeRun} from '../src/bench/score.mjs';
import {scoringTarget} from '../src/bench/scoring-target.mjs';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);
test('worked component example and weighted total',()=>{
  const c=cogiFromStats({tir:.8,tbr70:.03,sd_mgdl:36});
  assert.deepEqual(c.subscores,{tir:80,hypo:80,gv:80});near(c.score,80);
  near(Object.values(c.contributions).reduce((a,b)=>a+b),c.score);
});
test('linear endpoints and clipping',()=>{
  assert.equal(cogiFromStats({tir:1,tbr70:0,sd_mgdl:18}).score,100);
  assert.equal(cogiFromStats({tir:0,tbr70:.15,sd_mgdl:108}).score,0);
  assert.equal(cogiFromStats({tir:0,tbr70:1,sd_mgdl:200}).score,0);
  near(cogiFromStats({tir:.5,tbr70:.075,sd_mgdl:63}).score,50);
});
test('exact mg/dL boundaries and population SD, not rounded mmol thresholds',()=>{
  const c=cogiMetrics([69,70,180,181]);
  assert.equal(c.tir_percent,50);assert.equal(c.tbr70_percent,25);
  near(c.sd_mgdl,Math.sqrt((56**2+55**2+55**2+56**2)/4));
  assert.deepEqual(scoringTarget('COGI-v1'),{low_mg_dl:70,high_mg_dl:180});
});
test('invalid/missing data fail closed; empty is null not zero',()=>{
  assert.equal(cogiMetrics([]).score,null);
  for(const xs of [[NaN],[null],[Infinity],[0],[-1]])assert.throws(()=>cogiMetrics(xs));
  for(const x of [{tir:80,tbr70:0,sd_mgdl:20},{tir:.9,tbr70:.2,sd_mgdl:20},
    {tir:.5,tbr70:.1,sd_mgdl:-1}])assert.throws(()=>cogiFromStats(x));
});
test('COGI branch has no severe-hypoglycemia veto and legacy remains unchanged',()=>{
  const {events,...glucose}=glucoseMetrics([50,50,50,100]);
  const m={glucose,events};const s=episodeScore(m,undefined,{version:'COGI-v1'});
  assert.equal(s.safety_fail,true);assert.equal(s.safety_veto_applied,false);
  assert.ok(s.score>0);near(s.score,cogiMetrics([50,50,50,100]).score);
  assert.equal(episodeScore(m,undefined,{version:'bench-v0.2'}).score,0);
  assert.equal(episodeScore({},undefined,{version:'COGI-v1'}).score,null);
});
test('run summary uses COGI weights, equal-task subscores and no legacy normalization',()=>{
  const rows=[.8,.6].map((tir,i)=>{const cogi=cogiFromStats({tir,tbr70:0,sd_mgdl:18});
    return {instance:`task${i}`,score:cogi.score,cogi,state:'done',complete:true,safety_fail:false};});
  const s=summarizeRun(rows,{scoringVersion:'COGI-v1',B:20,seed:1});
  assert.equal(s.normalization_reference,'none_absolute_0_100');
  assert.equal(s.weights_version,'COGI-v1');assert.deepEqual(s.weights,{tir:.5,hypo:.35,gv:.15});
  assert.deepEqual(s.cogi_subscores,{tir:70,hypo:100,gv:100});near(s.score.mean,85);
});
