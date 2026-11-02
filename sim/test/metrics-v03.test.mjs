import test from 'node:test';
import assert from 'node:assert/strict';
import {dynamicMetrics,episodeScore,glucoseMetrics} from '../src/bench/score.mjs';
const pts=xs=>xs.map((g,i)=>({m:i*5,g}));
const metrics=xs=>({dynamic:dynamicMetrics(pts(xs)),...(()=>{const {events,...glucose}=glucoseMetrics(xs);return {events,glucose};})()});

test('exact mmol conversion, disjoint bins and normalized histogram',()=>{
  const d=dynamicMetrics(pts([1,2,3,4,8,12,13].map(x=>x*18.016)));
  assert.ok(Math.abs(Object.values(d.bins).reduce((a,b)=>a+b,0)-1)<1e-12);
  assert.equal(d.bins.extreme_low,1/7);assert.equal(d.bins.low,2/7);
  assert.equal(d.tir_4_8,2/7);assert.equal(d.bins.very_high,1/7);
});
test('published worked example gives 0.695, CV and ROC each penalized',()=>{
  const dynamic={n:288,safety_pass:true,bins:{target:.8,low:.03,extreme_low:0,very_high:.02},cv:.4,fast_roc_fraction:.06};
  assert.ok(Math.abs(episodeScore({dynamic}).score-.695)<1e-12);
});
test('severe low safety veto, 10 minutes does not veto, disconnected samples cannot form event',()=>{
  assert.equal(episodeScore(metrics([50,50,50,100])).score,0);
  assert.equal(metrics([50,50,100]).dynamic.safety_pass,true);
  assert.equal(dynamicMetrics([{m:0,g:50},{m:5,g:50},{m:60,g:50}]).severe_hypo_events,0);
});
test('rate uses adjacent 5 minute samples, not missing-sample bridges',()=>{
  assert.equal(dynamicMetrics(pts([100,110,121])).fast_roc_fraction,.5);
  assert.equal(dynamicMetrics([{m:0,g:100},{m:60,g:200}]).roc_pairs,0);
});
test('explicit old score is reproducible; new score rewards tighter target',()=>{
  const m=metrics([160,160,160]);
  assert.equal(episodeScore(m,undefined,{version:'bench-v0.2'}).score,1);
  assert.equal(episodeScore(m).score,0);
  assert.equal(episodeScore(metrics([110,110,110])).score,1);
});
