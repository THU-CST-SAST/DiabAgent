// Optional life events: generation, effect on sensitivity / hepatic output, and seed-stream independence.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeConfig} from '../src/core/config.mjs';
import {generateEvents} from '../src/core/scenario.mjs';
import {World} from '../src/sim/world.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';
import {buildInstanceConfig,EVENT_PACKS} from '../src/sim/instance.mjs';

const DAY=86400000,HOUR=3600000;
const NO_MEALS={meals:{},activity:{enabled:false},extra_events:[]};
const events=(scenario,days=3,seed=5)=>{
  const c=normalizeConfig({seed,scenario}),start=Date.parse(c.start_time);
  return generateEvents(c.scenario,{seed,start,end:start+days*DAY,utcOffsetMinutes:c.utc_offset_minutes});
};
const near=(v,target,tol,label)=>assert.ok(Math.abs(v-target)<=tol,`${label}: ${v} vs ${target}±${tol}`);
/** Mean true glucose over a window for a quiet ideal-pump day with the given scenario switches. */
function meanGlucose(scenario,{from=0,to=1440,seed=5,patient}={}) {
  const env=new SimEnv({seed,horizon_minutes:to,scenario:{...NO_MEALS,...scenario},therapy:{pump:{model:'ideal'}},cgm:{model:'ideal'},...(patient?{patient}:{})});
  while(!env.done())env.step({action_id:`a${env.step_count}`,expected_step:env.step_count,action:{type:'WAIT'}});
  const pts=env.evaluator.filter(s=>{const m=(Date.parse(s.time)-env.start)/60000;return m>=from&&m<=to;});
  return {mean:pts.reduce((s,p)=>s+p.true_glucose_mg_dl,0)/pts.length,env};
}

test('each life event pack generates its events with the configured effect',()=>{
  const c=normalizeConfig({}).scenario;
  const al=events({alcohol:{enabled:true,probability:1}});
  const drinks=al.filter(e=>e.type==='alcohol'),effects=al.filter(e=>e.type==='alcohol_effect');
  assert.equal(drinks.length,3);assert.ok(effects.length>=2);
  for(const e of effects) {
    const d=drinks.find(x=>x.id===e.id.replace('alcohol_effect:','alcohol:'))??{at:e.at-c.alcohol.onset_hours*HOUR,announced:true};
    assert.equal(e.at-d.at,c.alcohol.onset_hours*HOUR,'effect starts hours later');
    assert.equal(e.until-e.at,c.alcohol.duration_hours*HOUR);
    assert.ok(e.hepatic_delta<0,'alcohol suppresses hepatic glucose output');
    assert.equal(d.announced,true);assert.equal(e.announced,undefined);
  }
  const ill=events({illness:{enabled:true,probability_per_day:1}}).filter(e=>e.type==='illness');
  assert.equal(ill.length,3);
  for(const e of ill) {
    near(e.sensitivity_multiplier,1/(1+c.illness.insulin_need_increase),1e-12,'illness sensitivity');
    assert.ok(e.days>=c.illness.min_days&&e.days<=c.illness.max_days);assert.equal(e.until-e.at,e.days*DAY);
  }
  const sl=events({sleep_loss:{enabled:true,probability:1}}).filter(e=>e.type==='sleep_loss');
  assert.equal(sl.length,3);for(const e of sl){near(e.sensitivity_multiplier,1-c.sleep_loss.sensitivity_decrease,1e-12,'sleep loss');assert.equal(e.until-e.at,16*HOUR);}
  const an=events({anaerobic:{enabled:true,probability:1}}).filter(e=>e.kind==='anaerobic');
  assert.equal(an.length,3);for(const e of an){assert.equal(e.type,'exercise');assert.equal(e.AC,0);assert.ok(e.hepatic_delta>0);}
  const st=events({stress:{enabled:true,probability:1}}).filter(e=>e.type==='stress');
  assert.equal(st.length,3);for(const e of st){assert.ok(e.hepatic_delta>0);assert.equal(e.announced,false);}
  // Disabled packs generate nothing.
  const none=events({});
  for(const t of ['alcohol','alcohol_effect','illness','sleep_loss','stress'])assert.ok(!none.some(e=>e.type===t));
  assert.ok(!none.some(e=>e.kind==='anaerobic'));
});

test('life events change sensitivity and hepatic output, and glucose moves the intended way',()=>{
  const base=meanGlucose({}).mean;
  near(base,120,0.5,'quiet baseline');
  // Illness and sleep loss lower insulin sensitivity: glucose rises on the same basal.
  const ill=meanGlucose({illness:{enabled:true,probability_per_day:1}});
  assert.ok(ill.env.evaluator.some(s=>Math.abs(s.sensitivity_multiplier-1/1.3)<1e-9),'evaluator sees illness multiplier');
  assert.ok(ill.mean>base+5,`illness raises glucose (${ill.mean})`);
  const sleep=meanGlucose({sleep_loss:{enabled:true,probability:1}},{from:7*60});
  assert.ok(sleep.env.evaluator.some(s=>Math.abs(s.sensitivity_multiplier-0.85)<1e-9));
  assert.ok(sleep.mean>base+5,`sleep loss raises glucose (${sleep.mean})`);
  // Alcohol: hepatic output suppressed hours after the drink -> lower glucose.
  const al=meanGlucose({alcohol:{enabled:true,probability:1}},{from:0,to:2880});
  const quiet2=meanGlucose({},{from:0,to:2880});
  assert.ok(al.mean<quiet2.mean-2,`alcohol lowers glucose (${al.mean} vs ${quiet2.mean})`);
  assert.ok(al.env.summary().min_glucose<quiet2.env.summary().min_glucose-10,'alcohol nadir');
  // Anaerobic exercise and stress raise hepatic output -> higher glucose.
  const an=meanGlucose({anaerobic:{enabled:true,probability:1}}),st=meanGlucose({stress:{enabled:true,probability:1}});
  assert.ok(an.mean>base&&an.env.summary().max_glucose>base+5,`anaerobic raises glucose (max ${an.env.summary().max_glucose})`);
  assert.ok(st.mean>base&&st.env.summary().max_glucose>base+0.5,`stress raises glucose (max ${st.env.summary().max_glucose})`);
});

test('menstrual cycle: luteal-phase need increase for eligible females only',()=>{
  const cfg=patient=>({scenario:{...NO_MEALS,menstrual:{enabled:true}},patient,therapy:{pump:{model:'ideal'}},cgm:{model:'ideal'}});
  const female=new World(cfg({sex:'female',age_years:30})),male=new World(cfg({sex:'male',age_years:30}));
  const older=new World(cfg({sex:'female',age_years:70}));
  const days=Array.from({length:56},(_,i)=>female.start+i*DAY/2);
  const f=days.map(t=>female.sensitivityMultiplier(t)),inc=female.config.scenario.menstrual.luteal_need_increase;
  near(Math.min(...f),1/(1+inc),1e-9,'full luteal phase');near(Math.max(...f),1,1e-9,'follicular phase');
  assert.ok(f.filter(v=>v<0.99).length>15&&f.filter(v=>v>0.999).length>15,'both phases within 28 days');
  assert.ok(days.every(t=>male.sensitivityMultiplier(t)===1),'no cycle for males');
  assert.ok(days.every(t=>older.sensitivityMultiplier(t)===1),'no cycle after menopause');
});

test('seed streams: enabling event packs never shifts meal times, meal sizes or activity',()=>{
  const lifestyle=evs=>evs.filter(e=>e.type==='meal'||(e.type==='exercise'&&e.kind!=='anaerobic'))
    .map(e=>({id:e.id,at:e.at,grams:e.grams,announced_grams:e.announced_grams,until:e.until}));
  const all={alcohol:{enabled:true,probability:1},illness:{enabled:true,probability_per_day:1},sleep_loss:{enabled:true,probability:1},
    anaerobic:{enabled:true,probability:1},stress:{enabled:true,probability:1},menstrual:{enabled:true}};
  for(const seed of [1,2,3]) {
    const meals=normalizeConfig({}).scenario.meals;
    const base=lifestyle(events({meals},7,seed));
    assert.ok(base.length>=21);
    assert.deepEqual(lifestyle(events({meals,...all},7,seed)),base,`seed ${seed}: all packs`);
    for(const [k,v] of Object.entries(all))assert.deepEqual(lifestyle(events({meals,[k]:v},7,seed)),base,`seed ${seed}: ${k}`);
  }
  // Through instance specs: every applicable pack keeps the person's meal times; high-fat meals
  // change composition (by design) but not timing.
  const spec=events=>({seed:4,person:{type:'adult_female'},therapy:{mode:'pump',pump:{model:'dana_i',insulin:'aspart'}},
    sensors:{cgm:'dexcom_g6',meter:null},events,horizon_minutes:4320});
  const times=evs=>new World(buildInstanceConfig(spec(evs))).events.filter(e=>e.type==='meal').map(e=>[e.id,e.at]);
  const base=times(['baseline']);
  for(const id of Object.keys(EVENT_PACKS))assert.deepEqual(times([id]),base,`pack ${id}`);
  assert.deepEqual(times(Object.keys(EVENT_PACKS)),base,'all packs');
});
