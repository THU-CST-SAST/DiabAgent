import test from 'node:test';
import assert from 'node:assert/strict';
import {episodeMetrics,episodeScore,normalizeScore,bootstrapMean,passK,compareRuns,glucoseMetrics,bgRisk,summarizeRun} from '../src/bench/score.mjs';

const START='2026-10-13T16:00:00.000Z',T0=Date.parse(START),iso=m=>new Date(T0+m*60000).toISOString();

/** Minimal bundle with a true-glucose trace on the 5-min grid (plus an off-grid state that must be ignored). */
function bundle(glucose,{events=[],trajectory=[],metrics={}}={}) {
  const H=glucose.length*5;
  const states=glucose.map((g,i)=>({time:iso(i*5),true_glucose_mg_dl:g}));
  states.splice(1,0,{time:iso(2),true_glucose_mg_dl:20});   // event-driven sub-step: not on the grid
  states.push({time:iso(H),true_glucose_mg_dl:999});          // horizon end: outside [0, H)
  return {manifest:{config:{start_time:START,horizon_minutes:H}},initial_observation:null,trajectory,metrics,
    evaluator_only:{events,states}};
}
const cgmObs=(m,v)=>({cgm:{sample_time:iso(m),value_mg_dl:v},cgm_history:[],events:[]});

test('glucose metrics match hand computations (TIR, TBR, TAR, events, mean)', () => {
  // 20 samples = 100 min: 3 below 54 in a row (15 min, one severe event), 2 in 54-69, 10 in range, 5 above 250.
  const g=[50,50,50,60,65,...Array(10).fill(120),260,260,260,260,260];
  const m=episodeMetrics(bundle(g));
  assert.equal(m.glucose.n,20);
  assert.equal(m.glucose.tir,10/20);
  assert.equal(m.glucose.tbr70,5/20);
  assert.equal(m.glucose.tbr54,3/20);
  assert.equal(m.glucose.tar180,5/20);
  assert.equal(m.glucose.tar250,5/20);
  assert.equal(m.glucose.titr,10/20);
  assert.equal(m.glucose.min,50);assert.equal(m.glucose.max,260);
  assert.ok(Math.abs(m.glucose.mean-g.reduce((a,b)=>a+b,0)/20)<1e-9);
  assert.ok(Math.abs(m.glucose.gmi-(3.31+0.02392*m.glucose.mean))<1e-9);
  assert.equal(m.events.hypo_events,1);
  assert.equal(m.events.longest_below54_minutes,15);
  assert.equal(m.events.longest_below70_minutes,25);
  assert.equal(m.events.hyper_events,0);                  // 25 min > 250 is not a 2 h event
  assert.equal(m.visible.tir,null);                      // no continuous readings
});

test('event thresholds: 10 min below 54 is not an event; 2 h above 250 is', () => {
  const short=glucoseMetrics([50,50,100,100]);
  assert.equal(short.events.hypo_events,0);
  const hyper=glucoseMetrics([...Array(24).fill(300),100,...Array(23).fill(300)]);
  assert.equal(hyper.events.hyper_events,1);
  assert.equal(hyper.events.longest_above250_minutes,120);
});

test('LBGI/HBGI follow Kovatchev: f(50) ≈ −1.50, r ≈ 22.5; f(112.5) ≈ 0', () => {
  // ln 50 = 3.9120, 3.9120^1.084 = 4.3866, 1.509·(4.3866 − 5.381) = −1.5006, r = 10·f² = 22.52
  assert.ok(Math.abs(bgRisk(50).f+1.5006)<2e-3);
  assert.ok(Math.abs(bgRisk(112.5).f)<0.01);
  const m=glucoseMetrics([50,50,112.5,112.5]);
  assert.ok(Math.abs(m.lbgi-22.52/2)<0.05,`lbgi ${m.lbgi}`);
  assert.ok(m.hbgi<0.01);
  const h=glucoseMetrics([400]);           // ln 400 = 5.9915, 5.9915^1.084 = 6.964, f = 1.509·(6.964 − 5.381) = 2.389 → r = 57.07
  assert.ok(Math.abs(h.hbgi-57.07)<0.1,`hbgi ${h.hbgi}`);
  assert.equal(h.lbgi,0);
});

test('visible readings: CGM samples give the realistic TIR and its gap to truth', () => {
  const g=Array(12).fill(150);
  const traj=g.map((_,i)=>({action:{type:'WAIT'},info:{action_result:{status:'applied'}},next_observation:cgmObs(i*5,i<6?150:200)}));
  const m=episodeMetrics(bundle(g,{trajectory:traj}));
  assert.equal(m.glucose.tir,1);
  assert.equal(m.visible.continuous_n,12);
  assert.equal(m.visible.tir,0.5);
  assert.equal(m.visible.tir_diff,-0.5);
});

test('treatments and behaviour come from the trajectory and transcript', () => {
  const step=(type,status='applied',extra={})=>({action:{type,...extra},info:{action_result:{status,...(type==='MEASURE_BG'?{applied:{value_mg_dl:100,time:iso(10)}}:{})}},next_observation:{events:[]}});
  const traj=[step('BOLUS','applied',{units:2}),step('BOLUS','rejected',{units:2}),step('TEMP_BASAL'),step('MEASURE_BG'),step('INGEST_CARBS'),step('WAIT')];
  const transcript=[{parsed:{wait_minutes:30},usage:{input_tokens:1000,output_tokens:50},latency_ms:800},
    {parse_error:'bad json',usage:{input_tokens:1200,output_tokens:10},latency_ms:400},{parsed:{wait_minutes:60},usage:{input_tokens:1000,output_tokens:40},latency_ms:600}];
  const m=episodeMetrics(bundle(Array(12).fill(120),{trajectory:traj,metrics:{total_insulin_u:3,bolus_u:2,rescue_carbs_g:15}}),
    {transcript,status:{started:'2026-10-14T00:00:00Z',finished:'2026-10-14T00:02:00Z'},price:{input:3,output:15}});
  assert.equal(m.treatments.boluses,1);assert.equal(m.treatments.temp_basals,1);assert.equal(m.treatments.carb_intakes,1);
  assert.equal(m.treatments.rescue_carbs_g,15);
  assert.equal(m.behaviour.turns,3);assert.equal(m.behaviour.parse_errors,1);assert.equal(m.behaviour.rejected_actions,1);
  assert.equal(m.behaviour.active_measurements,1);assert.equal(m.behaviour.mean_wait_minutes,45);
  assert.equal(m.visible.fingerstick_n,1);
  assert.equal(m.cost.input_tokens,3200);assert.equal(m.cost.output_tokens,100);
  assert.ok(Math.abs(m.cost.usd-(3200*3+100*15)/1e6)<1e-12);
  assert.equal(m.cost.wall_seconds,120);assert.equal(m.cost.mean_latency_ms,600);
});

test('episode score and the severe-hypo safety veto', () => {
  // 2 samples below 54 (10 min): no event, so the score is the formula.
  const a=episodeMetrics(bundle([50,50,...Array(18).fill(120)]));
  const sa=episodeScore(a,undefined,{version:'bench-v0.2'});
  assert.equal(sa.safety_fail,false);
  assert.ok(Math.abs(sa.score-(18/20-1.5*2/20-4*2/20))<1e-12);
  // 3 samples (15 min) below 54: vetoed to 0 even though most of the day is in range.
  const b=episodeMetrics(bundle([50,50,50,...Array(97).fill(120)]));
  const sb=episodeScore(b,undefined,{version:'bench-v0.2'});
  assert.equal(sb.safety_fail,true);assert.equal(sb.score,0);assert.ok(sb.raw>0.8);
  // clip to [0, 1]
  assert.equal(episodeScore(episodeMetrics(bundle(Array(10).fill(300)))).score,0);
  assert.equal(episodeScore(episodeMetrics(bundle(Array(10).fill(100)))).score,1);
  // custom weights
  const c=episodeScore(a,{tbr54:0,tbr70:0},{version:'bench-v0.2'});
  assert.ok(Math.abs(c.score-0.9)<1e-12);
});

test('normalization edge cases', () => {
  const n=normalizeScore(0.7,{wait:0.3,patient:0.6,oref0:0.8});
  assert.ok(Math.abs(n.normalized-0.8)<1e-12);assert.equal(n.s_ref,0.8);assert.equal(n.excluded,false);
  assert.ok(normalizeScore(0.1,{wait:0.3,patient:0.6,oref0:0.8}).normalized<0);           // worse than waiting
  assert.ok(normalizeScore(1,{wait:0.3,patient:0.6,oref0:0.5}).normalized>1);             // better than the reference
  const small=normalizeScore(0.9,{wait:0.8,patient:0.84,oref0:0.82});
  assert.equal(small.normalized,null);assert.equal(small.reason,'small_denominator');
  assert.equal(normalizeScore(0.9,{wait:0.8,patient:0.7,oref0:0.75}).reason,'small_denominator');  // reference below wait
  assert.equal(normalizeScore(0.5,null).reason,'missing_baselines');
  assert.equal(normalizeScore(0.5,{patient:0.6}).reason,'missing_baselines');
  assert.ok(Math.abs(normalizeScore(0.5,{wait:0,patient:0.5}).normalized-1)<1e-12);       // one reference is enough
});

test('bootstrap CI is deterministic, clustered by instance and seed-dependent', () => {
  const groups=[[0.1,0.2,0.15],[0.8,0.9,0.85],[0.5,0.4,0.45],[0.6,0.7,0.65],[0.3,0.2,0.25]];
  const a=bootstrapMean(groups,{B:1000,seed:7}),b=bootstrapMean(groups,{B:1000,seed:7});
  assert.deepEqual(a,b);
  const many=Array.from({length:30},(_,i)=>[((i*37)%101)/100,((i*53)%97)/100]);
  assert.notDeepEqual(bootstrapMean(many,{B:1000,seed:7}).ci95,bootstrapMean(many,{B:1000,seed:8}).ci95);
  assert.deepEqual(bootstrapMean(many,{B:1000,seed:7}),bootstrapMean(many,{B:1000,seed:7}));
  assert.ok(Math.abs(a.mean-0.47)<1e-12);
  assert.ok(a.ci95[0]<a.mean&&a.mean<a.ci95[1]);
  assert.equal(a.instances,5);assert.equal(a.n,15);
  // Clustered resampling is wider than treating the 15 episodes as independent instances.
  const flat=bootstrapMean(groups.flat().map(v=>[v]),{B:1000,seed:7});
  assert.ok(a.ci95[1]-a.ci95[0]>flat.ci95[1]-flat.ci95[0]);
  assert.deepEqual(bootstrapMean([]),{mean:null,ci95:[null,null],n:0,instances:0});
  assert.deepEqual(bootstrapMean([[0.4,0.6]]).ci95,[0.5,0.5]);
});

test('pass^k, run summary and paired comparison', () => {
  const rows=(model,delta)=>['a','b','c','d'].flatMap((id,i)=>[0,1,2].map(r=>({instance:id,repeat:r,score:Math.min(1,0.2*i+0.1+delta),
    normalized:0.2*i+delta,safety_fail:id==='a'&&r===1&&delta===0,tir:0.5,complete:true,state:'done',
    factors:{observation_profile:i%2?'cgm_rt':'smbg_sparse',event_pack:i?['alcohol','stress']:['none']}})));
  const A=rows('A',0.1),B=rows('B',0);
  assert.deepEqual(passK(B),{k:3,rate:0.75,instances:4});
  const s=summarizeRun(B,{suite:'t',model:'B',split:'test',B:500});
  assert.equal(s.episodes,12);assert.ok(Math.abs(s.safety_rate-11/12)<1e-4);
  assert.equal(s.by_factor.observation_profile.cgm_rt.n,6);
  assert.equal(s.by_factor.event_pack.alcohol.n,9);assert.equal(s.by_factor.event_pack.none.n,3);
  assert.deepEqual(summarizeRun(B,{suite:'t',model:'B',split:'test',B:500}).score,s.score);
  const cmp=compareRuns(A,B,{B:500});
  assert.equal(cmp.pairs,12);assert.equal(cmp.instances,4);
  assert.ok(Math.abs(cmp.score_diff.mean-0.1)<1e-9);
  assert.equal(cmp.wins,12);assert.equal(cmp.safety_fail_b,1);
});
