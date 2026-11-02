import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SimEnv} from '../src/env/pomdp.mjs';
import {INSULINS} from '../src/core/insulins.mjs';
import {doseResponse,pkMetrics} from '../src/core/pk.mjs';
import {Cgm,CGMS} from '../src/core/cgm.mjs';
import {traces,evaluate,FITTED_SENSORS} from '../scripts/calibrate-cgm.mjs';

const NO_LIFE={meals:{},activity:{enabled:false},extra_events:[]};
const act=(env,action={type:'WAIT'})=>env.step({action_id:`a${env.step_count}`,expected_step:env.step_count,action});
const run=env=>{while(!env.done())act(env);return env;};
const pk=name=>pkMetrics(doseResponse(INSULINS[name]));
const near=(v,target,tol,label)=>assert.ok(Math.abs(v-target)<=tol,`${label}: ${v} vs ${target}±${tol}`);

test('kernel reference absorption matches published aspart PK',()=>{
  const m=pk('aspart');
  near(m.onset_10pct,11.2,3,'onset');          // Heise 2015: 11.2 min onset of appearance
  near(m.early_half,31.6,4,'early half-Cmax');  // Heise 2015: 31.6 min
  near(m.tmax,82.3,10,'tmax');                  // EMA: CSII Tmax 82.3 min
});

test('ultra-rapid and regular insulins reproduce literature differences vs the reference',()=>{
  const ref=pk('aspart'),fiasp=pk('fiasp'),lyumjev=pk('lyumjev'),regular=pk('regular_human');
  // Fiasp by CSII (Heise 2017): early half -11.8, Tmax -25.7, late half -35.4 min, AUC0-30 ~3x.
  near(fiasp.early_half-ref.early_half,-11.8,5,'fiasp early half shift');
  near(fiasp.tmax-ref.tmax,-25.7,6,'fiasp tmax shift');
  near(fiasp.late_half-ref.late_half,-35.4,6,'fiasp late half shift');
  near(fiasp.auc_0_30/ref.auc_0_30,3,0.5,'fiasp early exposure ratio');
  // Lyumjev: faster onset and less exposure after 3 h, within the documented residuals.
  assert.ok(lyumjev.auc_0_15/ref.auc_0_15>4,'lyumjev AUC0-15 ratio');
  assert.ok(lyumjev.auc_after_180<ref.auc_after_180*0.85,'lyumjev late exposure reduced');
  near(regular.tmax,150,10,'regular tmax');
  assert.ok(regular.late_half>5.5*60,'regular insulin lasts longer');
  // Bioavailability is preserved, so total exposure per unit is unchanged.
  const total=n=>doseResponse(INSULINS[n],{minutes:1440}).reduce((a,b)=>a+b,0);
  for(const n of ['fiasp','lyumjev','regular_human'])near(total(n)/total('aspart'),1,0.02,`${n} total exposure`);
});

test('long-acting insulins: steady-state flatness and half-life ordering',()=>{
  // Superpose daily (or twice-daily) doses of the linear single-dose response for 14 days.
  const steady=name=>{
    const ins=INSULINS[name],one=doseResponse(ins,{minutes:14*1440,dt:0.5}),every=1440/ins.doses_per_day,out=new Array(one.length).fill(0);
    for(let d=0;d<one.length;d+=every)for(let i=d;i<one.length;i++)out[i]+=one[i-d];
    const last=out.slice(13*1440),peak=Math.max(...last),trough=Math.min(...last);
    const day3=out.slice(2*1440,3*1440),mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
    return {ptr:peak/trough,day3_fraction:mean(day3)/mean(last)};
  };
  const u100=steady('glargine_u100'),u300=steady('glargine_u300'),deg=steady('degludec');
  assert.ok(u300.ptr<2,`U300 peak-to-trough ${u300.ptr} (Becker 2015: <2)`);
  assert.ok(deg.ptr<u100.ptr,'degludec flatter than glargine U100');
  assert.ok(u300.ptr<u100.ptr,'U300 flatter than U100');
  assert.ok(deg.day3_fraction<u100.day3_fraction,'degludec reaches steady state more slowly');
  assert.ok(deg.day3_fraction>0.8,'degludec near steady state by day 3 (label: 2-4 days)');
});

test('ultra-rapid insulin blunts the post-meal peak compared with aspart',()=>{
  const cfg=ins=>({horizon_minutes:300,scenario:{...NO_LIFE,extra_events:[{id:'m',type:'meal',at_minute:0,grams:50,absorption_minutes:40,announced_grams:50}]},
    therapy:{pump:{model:'ideal',insulin:ins}},cgm:{model:'ideal'}});
  const peak=ins=>{const e=new SimEnv(cfg(ins));act(e,{type:'BOLUS',units:4});return run(e).summary().max_glucose;};
  assert.ok(peak('fiasp')<peak('aspart')-5);
  assert.ok(peak('lyumjev')<peak('aspart')-5);
});

test('Dana-i: percent temp basals on a 10% / 15 min grid; bolus at 12 s per unit',()=>{
  const e=new SimEnv({scenario:NO_LIFE,therapy:{pump:{model:'dana_i'}},cgm:{model:'ideal'}});
  const base=e.device.scheduledBasalUph;
  assert.equal(base,0.57);   // equilibrium 0.5726 U/h programmed on the 0.01 U/h grid
  const r=act(e,{type:'TEMP_BASAL',rate_u_h:0.8,duration_minutes:40}).info.action_result;
  assert.equal(r.applied.percent,140);assert.equal(r.applied.duration_minutes,45);
  assert.ok(Math.abs(r.applied.rate_u_h-base*1.4)<1e-12);
  const b=act(e,{type:'BOLUS',units:2.37}).info.action_result;
  assert.equal(b.applied.units,2.35);assert.equal(b.applied.delivery_minutes,2.35/5);
  assert.equal(e.observe().iob.bolus_u>2.3,true);   // AAPS counts the full bolus from its start
});

test('Omnipod DASH: absolute temp basal on 0.05 U/h / 30 min grid; no extended bolus; slow bolus delivery',()=>{
  const e=new SimEnv({scenario:NO_LIFE,therapy:{pump:{model:'omnipod_dash'}},cgm:{model:'ideal'}});
  assert.equal(e.device.scheduledBasalUph,0.55);
  const r=act(e,{type:'TEMP_BASAL',rate_u_h:1.234,duration_minutes:50}).info.action_result;
  assert.deepEqual(r.applied,{rate_u_h:1.25,percent:null,duration_minutes:60});
  assert.match(act(e,{type:'EXTENDED_BOLUS',units:2,duration_minutes:60}).info.action_result.reason,/does not support/);
  act(e,{type:'BOLUS',units:3});
  assert.ok(e.observe().device.bolus_in_progress===null);   // 3 U at 1.5 U/min finishes in 2 min, before the next tick
  const quick=new SimEnv({scenario:NO_LIFE,therapy:{pump:{model:'omnipod_dash'}},cgm:{model:'ideal'}});
  quick.apply({type:'BOLUS',units:10},'x');
  assert.ok(quick.observe().device.bolus_in_progress.units===10);
});

test('hidden occlusion: delivery stops, glucose rises, alarm after the missed-insulin threshold, set change restores',()=>{
  const cfg=occ=>({horizon_minutes:720,scenario:NO_LIFE,therapy:{pump:{model:'omnipod_dash'}},cgm:{model:'ideal'},faults:{occlusion_rate_per_day:0,occlusions:occ}});
  const ok=run(new SimEnv(cfg([]))),occ=new SimEnv(cfg([{at_minute:30}]));
  let alarm=null;
  while(!occ.done()){const r=act(occ);if(!alarm&&r.observation.events.some(e=>e.type==='pump_occlusion_alarm'))alarm=r;}
  assert.ok(alarm,'alarm raised');
  assert.equal(alarm.info.stop_reason,'event');
  const minutes=alarm.observation.elapsed_minutes;
  near(minutes,30+4/0.55*60,6,'alarm time after 4 U missed at 0.55 U/h');
  assert.ok(!JSON.stringify(occ.transitions.slice(0,6)).includes('occlusion'),'onset is hidden');
  assert.ok(occ.summary().max_glucose>ok.summary().max_glucose+20,'missed insulin raises glucose');
  assert.equal(occ.observe().device.suspended,true);
  const fixed=new SimEnv(cfg([{at_minute:30}]));
  while(!fixed.observe().device.suspended)act(fixed);
  assert.match(act(fixed,{type:'BOLUS',units:1}).info.action_result.reason,/occlusion/);
  act(fixed,{type:'CHANGE_INFUSION_SET'});
  assert.equal(fixed.observe().device.suspended,false);
  assert.equal(fixed.observe().device.current_basal_u_h,0.55);
});

test('MDI: steady long-acting start, routine injection event, pen rounding, pump-only actions rejected',()=>{
  const e=new SimEnv({scenario:NO_LIFE,therapy:{mode:'mdi'},cgm:{model:'ideal'}});
  assert.equal(e.observe().device.type,'mdi');
  assert.equal(e.config.therapy.mdi.basal_dose_u,14);
  assert.ok(!e.observe().available_actions.includes('TEMP_BASAL'));
  assert.match(act(e,{type:'TEMP_BASAL',rate_u_h:1,duration_minutes:30}).info.action_result.reason,/not available/);
  assert.equal(act(e,{type:'BOLUS',units:1.3}).info.action_result.applied.units,1.5);   // NovoPen Echo: 0.5 U steps
  let injected=null;
  while(!e.done()){const r=act(e);if(r.observation.events.some(x=>x.type==='basal_injection_taken'))injected=r.observation;}
  assert.equal(injected.local_time.slice(11),'22:00');
  const s=e.summary();
  assert.ok(s.long_acting_u===14&&s.min_glucose>70,'degludec steady state keeps a fasting day in range');
  near(s.mean_glucose,120,25,'fasting mean glucose on degludec');
});

test('MDI with glargine fluctuates more than degludec over a fasting day',()=>{
  const sd=basal=>run(new SimEnv({horizon_minutes:2880,scenario:NO_LIFE,therapy:{mode:'mdi',mdi:{basal_insulin:basal,basal_pen:'lantus_solostar'}},cgm:{model:'ideal'}})).summary().sd_glucose;
  assert.ok(sd('glargine_u100')>sd('degludec'));
});

test('CGM: interstitial lag, LO/HI clamp, signal gaps and sensor replacement with warm-up',()=>{
  const start=Date.parse('2026-10-13T16:00:00Z');
  const c=new Cgm({model:'dexcom_g6',seed:5,start,gaps:{start_probability_per_sample:0,mean_length_samples:3}});
  c.sensor.tau=8;c.ig=200;
  for(let i=0;i<5;i++)c.integrate(1,100);
  near(c.ig,100+100*Math.exp(-5/8),1e-9,'first-order lag');
  const g=new Cgm({model:'libre_3',seed:1,start,gaps:{start_probability_per_sample:1,mean_length_samples:4}});
  assert.equal(g.sample(start,120),null);
  const r=new Cgm({model:'dexcom_g7',seed:2,start});
  r.sensor.insertedAt=start-r.spec.wear_days*86400000;
  const notice=r.maybeReplace(start,t=>new Date(t).toISOString());
  assert.equal(notice.type,'cgm_sensor_replaced');
  assert.equal(r.sample(start+5*60000,120),null);                  // warming up (30 min)
  assert.ok(r.sample(start+30*60000,120)!==null);
  const hi=new Cgm({model:'ideal',seed:1,start});
  assert.equal(hi.sample(start,520).display,'HI');
});

test('CGM models reproduce labeled MARD and approximately the unfitted %20/20',()=>{
  const data=traces(),pct2020={dexcom_g6:0.925,dexcom_g7:0.953,libre_2:0.932,libre_3:0.949};
  for(const model of Object.keys(pct2020)) {
    const r=evaluate(model,null,data);
    near(r.mard,CGMS[model].label_mard,0.005,`${model} MARD`);
    near(r.pct_20_20,pct2020[model],0.03,`${model} %20/20`);
    assert.ok(r.missing>0&&r.missing<0.02,`${model} gap fraction ${r.missing}`);
  }
  // Calibrated (12-hourly fingersticks) and flash sensors are fitted the same way.
  for(const model of FITTED_SENSORS.filter(m=>!(m in pct2020))) {
    assert.ok(Number.isFinite(CGMS[model].spread)&&CGMS[model].spread>0,`${model} spread fitted`);
    near(evaluate(model,null,data).mard,CGMS[model].label_mard,0.005,`${model} MARD`);
  }
  // Without the calibration routine a calibrated sensor's readings stop after the interval.
  const stale=evaluate('dexcom_g5',null,data.slice(0,2),{calibrate:false});
  assert.ok(stale.missing>0.5,`uncalibrated G5 withholds readings (missing ${stale.missing})`);
});

test('stale CGM: no new readings during warm-up, trend withheld, age grows',()=>{
  const e=new SimEnv({scenario:NO_LIFE,therapy:{pump:{model:'ideal'}},cgm:{model:'dexcom_g6',gaps:{start_probability_per_sample:0,mean_length_samples:3}}});
  e.cgm.sensor.insertedAt=e.now-10*86400000+20*60000;   // expires in 20 min
  let o;for(let i=0;i<12;i++)o=act(e).observation;
  assert.ok(o.cgm.warming_up_until);assert.equal(o.cgm.trend_mg_dl_per_min,null);assert.equal(o.cgm.direction,'NONE');
  assert.ok(o.cgm.age_minutes>=35);
});
