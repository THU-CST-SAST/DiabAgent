// World runtime APIs used by the long-running live service: reconfigure(patch), prune(before)
// and the oref0 recommendation kept by the built-in controller.
import test from 'node:test';
import assert from 'node:assert/strict';
import {World} from '../src/sim/world.mjs';
import {oref0Policy} from '../src/policies/oref0.mjs';

const HOUR=3600000,DAY=24*HOUR;
const base=(extra={})=>({horizon_minutes:10080,therapy:{pump:{model:'ideal',insulin:'aspart'}},cgm:{model:'legacy_uniform',noise_mg_dl:1.5},
  controller:{mode:'closed',compute_suggestions:true,expose_actions:true},...extra});
const run=(w,ms)=>w.advanceTo(w.now+ms,{sample:true});
const withoutEvents=o=>{const {events,...rest}=o;return rest;};
const future=w=>w.events.filter(e=>e.at>w.now);
const lunch={time:'14:00',carbs_g:90,carbs_jitter_g:1,time_jitter_minutes:0,absorption_minutes:60};

test('reconfigure applies live-changeable settings to the running World',()=>{
  const w=new World(base({controller:{mode:'open',compute_suggestions:true,expose_actions:true}}));run(w,2*HOUR);
  const state=structuredClone(w.physiology.state);
  const r=w.reconfigure({profile:{basal_u_h:1.2,target_mg_dl:140},patient:{weight_kg:80},cgm:{noise_mg_dl:4},
    controller:{mode:'closed',temp_targets:{hypo:150}},safety:{max_bolus_u:5}});
  assert.deepEqual(r.changed.sort(),['cgm.noise_mg_dl','controller.mode','controller.temp_targets.hypo','patient.weight_kg',
    'profile.basal_u_h','profile.target_mg_dl','safety.max_bolus_u']);
  assert.equal(r.regenerated,false);
  assert.equal(w.device.scheduledBasalUph,1.2);assert.equal(w.physiology.params.BW,80);assert.equal(w.cgm.noiseMgdl,4);
  assert.equal(w.controller.mode,'closed');assert.deepEqual(w.physiology.state,state,'compartment state is kept');
  const o=w.observe();
  assert.equal(o.profile.basal_u_h,1.2);assert.equal(o.profile.target_mg_dl,140);assert.equal(o.profile.max_bolus_u,5);
  w.apply({type:'SET_TEMP_TARGET',preset:'hypo'},'tt');assert.equal(w.targetMgdl(),150);
  // An explicit controller.mode is re-applied even when equal to the configured value.
  w.apply({type:'SET_LOOP_MODE',mode:'lgs'},'m');assert.equal(w.controller.mode,'lgs');
  assert.deepEqual(w.reconfigure({controller:{mode:'closed'}}).changed,[]);assert.equal(w.controller.mode,'closed');
  w.reconfigure({controller:{enabled:false}});assert.equal(w.controller.enabled,false);
  run(w,HOUR);assert.ok(Number.isFinite(w.physiology.glucose()));
});

test('reconfigure rejects invalid and unsupported patches without changing the World',()=>{
  const w=new World(base());run(w,HOUR);const before=w.snapshot();
  assert.throws(()=>w.reconfigure(null),/must be an object/);
  assert.throws(()=>w.reconfigure({profile:{bogus:1}}),/Unknown config field: profile\.bogus/);
  assert.throws(()=>w.reconfigure({profile:{target_mg_dl:500}}),/profile\.target_mg_dl must be a number/);
  assert.throws(()=>w.reconfigure({profile:{basal_u_h:4}}),/max_basal_u_h must be >= basal/);
  assert.throws(()=>w.reconfigure({controller:{mode:'auto'}}),/controller\.mode/);
  assert.throws(()=>w.reconfigure({therapy:{pump:{model:'dana_i'}}}),/Cannot change therapy\.pump\.model/);
  assert.throws(()=>w.reconfigure({cgm:{model:'dexcom_g6'}}),/Cannot change cgm\.model/);
  assert.throws(()=>w.reconfigure({physiology:{sensitivity:2}}),/Cannot change physiology\.sensitivity/);
  assert.throws(()=>w.reconfigure({patient:{initial_glucose_mg_dl:200}}),/Cannot change patient\.initial_glucose_mg_dl/);
  assert.throws(()=>w.reconfigure({start_time:'2026-10-14T00:00:00.000Z',horizon_minutes:60}),/start_time, horizon_minutes/);
  // A rejected patch with supported parts applies none of them.
  assert.throws(()=>w.reconfigure({profile:{target_mg_dl:150},therapy:{mode:'mdi'}}),/Cannot change/);
  assert.deepEqual(w.snapshot(),before);
});

test('scenario reconfiguration redraws only future events, like a World started with the new config',()=>{
  const w=new World(base());run(w,10*HOUR);   // 10:00 local: breakfast eaten, lunch ahead
  const done=structuredClone(w.events.slice(0,w.nextEvent)),meals=structuredClone(w.physiology.meals);
  assert.ok(done.some(e=>e.id.endsWith(':breakfast')));
  // Breakfast moved after now must not be eaten again; lunch moves to 14:00.
  const r=w.reconfigure({scenario:{meals:{breakfast:{time:'11:00',carbs_g:40,carbs_jitter_g:0,time_jitter_minutes:0,absorption_minutes:40},lunch}}});
  assert.equal(r.regenerated,true);
  assert.deepEqual(w.events.slice(0,w.nextEvent),done,'processed events are untouched');
  assert.deepEqual(w.physiology.meals,meals);
  const next=future(w);
  assert.ok(next.every(e=>e.at>w.now));
  assert.ok(!next.some(e=>e.id===done.find(d=>d.id.endsWith(':breakfast')).id),'eaten breakfast is not redrawn');
  const lunchEvent=next.find(e=>e.id.endsWith(':lunch'));
  assert.equal(new Date(lunchEvent.at).toISOString(),'2026-10-14T06:00:00.000Z');assert.ok(Math.abs(lunchEvent.grams-90)<=1);
  // Same future as a fresh World with the new config (minus ids that already happened).
  const fresh=new World({...base(),scenario:{...w.config.scenario}});fresh.ensureEvents(w.generatedUntil-DAY-1);
  const ids=new Set(done.map(e=>e.id));
  assert.deepEqual(next,fresh.events.filter(e=>e.at>w.now&&!ids.has(e.id)&&e.at<w.generatedUntil));
  // A meal removed via null disappears from the future only.
  w.reconfigure({scenario:{meals:{dinner:null}}});
  assert.ok(!future(w).some(e=>e.name==='dinner'));assert.ok('lunch' in w.config.scenario.meals);
  run(w,2*DAY);
  assert.equal(w.events.filter(e=>e.id.endsWith(':breakfast')&&e.at<w.now-DAY).length,1);
});

test('reconfigure is deterministic for the same patch sequence',()=>{
  const script=w=>{
    run(w,9*HOUR);w.reconfigure({seed:7,scenario:{activity:{probability:1}}});
    run(w,5*HOUR);w.apply({type:'INGEST_CARBS',grams:15},'c1');w.reconfigure({profile:{basal_u_h:0.9},patient:{weight_kg:72}});
    run(w,20*HOUR);w.reconfigure({cgm:{noise_mg_dl:3},controller:{mode:'lgs'},scenario:{meals:{lunch}}});
    run(w,DAY);return w;
  };
  const a=script(new World(base())),b=script(new World(base()));
  assert.deepEqual(a.snapshot(),b.snapshot());
  const c=new World(base());run(c,9*HOUR);
  const restored=World.restore(c.snapshot());
  for(const w of [c,restored]){w.reconfigure({seed:7,scenario:{activity:{probability:1}}});run(w,DAY);}
  assert.deepEqual(c.snapshot(),restored.snapshot());
});

test('prune keeps the future trajectory, observations and snapshot/restore identical',()=>{
  const cfg=base({scenario:{stress:{enabled:true,probability:1}}});
  const a=new World(cfg),b=World.restore(a.snapshot());
  let dropped={events:0,notices:0,reported_carbs:0};
  for(let day=0;day<4;day++) {
    for(const w of [a,b]){run(w,10*HOUR);w.apply({type:'INGEST_CARBS',grams:12},`r${day}`);run(w,14*HOUR);}
    assert.deepEqual(b.drain(),a.drain());
    const d=b.prune(b.now);   // as aggressive as allowed
    for(const k of Object.keys(dropped))dropped[k]+=d[k];
    assert.deepEqual(withoutEvents(b.observe()),withoutEvents(a.observe()));
    assert.deepEqual(b.estimates(),a.estimates());
  }
  assert.ok(dropped.events>0&&dropped.notices>0&&dropped.reported_carbs>0,JSON.stringify(dropped));
  assert.ok(b.events.length<a.events.length&&b.reportedCarbs.length<a.reportedCarbs.length);
  assert.deepEqual(b.observe().events,[],'pruned notices leave the observation');
  // Restoring a pruned snapshot continues exactly like the pruned World and the unpruned one.
  const c=World.restore(b.snapshot());
  for(const w of [a,b,c]){w.reconfigure({scenario:{meals:{lunch}}});run(w,DAY+7*HOUR);}
  assert.deepEqual(c.snapshot(),b.snapshot());
  assert.deepEqual(b.physiology.snapshot(),a.physiology.snapshot());
  assert.deepEqual(b.device.snapshot(),a.device.snapshot());
  assert.deepEqual(b.metrics,a.metrics);
  assert.deepEqual(future(b),future(a),'a redraw after pruning matches one without');
  assert.deepEqual(b.drain(),a.drain());
  assert.deepEqual(withoutEvents(b.observe()),withoutEvents(a.observe()));
  assert.throws(()=>b.prune(NaN),/finite/);
});

test('prune on MDI keeps the last basal injection and the long-acting dynamics',()=>{
  const cfg={horizon_minutes:10080,therapy:{mode:'mdi'},cgm:{model:'dexcom_g6'}};
  const a=new World(cfg),b=World.restore(a.snapshot());
  for(let day=0;day<3;day++)for(const w of [a,b]){run(w,DAY);if(w===b)w.prune(w.now);}
  assert.equal(b.device.basalLog.length,1);assert.ok(a.device.basalLog.length>1);
  assert.deepEqual(withoutEvents(b.observe()),withoutEvents(a.observe()));
  assert.deepEqual(b.physiology.snapshot(),a.physiology.snapshot());
});

test('oref0Policy returns the determine-basal recommendation and the World keeps it',()=>{
  const w=new World(base());run(w,30*60000);
  const d=oref0Policy(w.observe());
  assert.ok(d.recommendation&&typeof d.recommendation.reason==='string'&&'eventualBG' in d.recommendation);
  const k=w.controller.lastRecommendation;
  assert.equal(k.at,w.now);assert.ok(k.raw&&k.raw.reason);assert.equal(k.reason.startsWith('oref0'),true);
  const mdi=new World({therapy:{mode:'mdi'},cgm:{model:'dexcom_g6'}});
  assert.equal(oref0Policy(mdi.observe()).recommendation,null);
  // LGS computes a suggestion only when compute_suggestions is set; its dosing is unchanged.
  const lgs=s=>{const x=new World(base({controller:{mode:'lgs',compute_suggestions:s}}));run(x,30*60000);return x;};
  const on=lgs(true),off=lgs(false);
  assert.ok(on.controller.lastRecommendation.raw);assert.equal(off.controller.lastRecommendation,null);
  assert.deepEqual(on.physiology.snapshot(),off.physiology.snapshot());
});
