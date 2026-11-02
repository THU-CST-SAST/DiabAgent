// Instance population: the space of valid instance specs (person x therapy x sensors x
// controller x event packs), with exact counting, pairwise-covering designs for diversity
// testing and prevalence-weighted samples for representative evaluation.
// Testing-only knowledge entries (ideal pump, ideal/legacy sensors) are excluded.
import {KNOWLEDGE} from '../knowledge.mjs';
import {Rng} from '../core/rng.mjs';
import {EVENT_PACKS,buildInstanceConfig} from '../sim/instance.mjs';

const K=KNOWLEDGE,TEST_ONLY=new Set(['ideal','legacy_uniform']);
const variantKeys=name=>Object.keys(K.personModel.variants[name]).filter(k=>k!=='evidence');

/** Enumerated values per dimension. Therapies and sensor setups are pre-filtered for compatibility. */
export function dimensions() {
  const pumps=Object.keys(K.pumps).filter(p=>!TEST_ONLY.has(p));
  const pumpInsulins=Object.entries(K.insulins).filter(([,i])=>['rapid','ultra_rapid'].includes(i.class)).map(([k])=>k);
  const bolusPens=Object.entries(K.penInsulins).flatMap(([pen,ins])=>ins.filter(i=>K.insulins[i].class!=='long').map(i=>[pen,i]));
  const basalPens=Object.entries(K.penInsulins).flatMap(([pen,ins])=>ins.filter(i=>K.insulins[i].class==='long').map(i=>[pen,i]));
  const therapies=[
    ...pumps.flatMap(model=>pumpInsulins.map(insulin=>({mode:'pump',pump:{model,insulin}}))),
    ...bolusPens.flatMap(([bp,bi])=>basalPens.map(([lp,li])=>({mode:'mdi',mdi:{bolus_pen:bp,bolus_insulin:bi,basal_pen:lp,basal_insulin:li}})))];
  const meters=Object.keys(K.meters);
  const sensorSetups=[];
  for(const [id,s] of Object.entries(K.sensors)) {
    if(TEST_ONLY.has(id))continue;
    const setup=s.modality==='flash'?'flash':s.calibration?.required?'calibrated_cgm':'cgm';
    for(const meter of setup==='calibrated_cgm'?meters:[null,...meters])sensorSetups.push({setup,cgm:id,meter});
  }
  for(const meter of meters)sensorSetups.push({setup:'meter_only',cgm:null,meter});
  return {
    person_type:Object.keys(K.persons),bmi:variantKeys('bmi'),dawn:variantKeys('dawn'),carb_counting:variantKeys('carb_counting'),
    therapy:therapies,sensors:sensorSetups,controller:['manual','open','closed','lgs'],
    event_packs:Object.keys(EVENT_PACKS).filter(k=>k!=='baseline'),
  };
}

/** The built-in AAPS-like controller needs a pump and a real-time glucose stream. */
export function controllerOptions(therapy,sensors) {
  return therapy.mode==='pump'&&sensors.cgm&&K.sensors[sensors.cgm].modality!=='flash'?['manual','open','closed','lgs']:['manual'];
}

/** Event packs that apply to a person/therapy (mirrors EVENT_PACKS[].requires). */
export function applicablePacks(personType,therapy) {
  const p=K.persons[personType];
  return Object.entries(EVENT_PACKS).filter(([id,pack])=>id!=='baseline'&&(!pack.requires||pack.requires(p,therapy))).map(([id])=>id);
}

/** Exact sizes of the instance space at three granularities. */
export function countConfigurations() {
  const d=dimensions(),variantsPerType=d.bmi.length*d.dawn.length*d.carb_counting.length;
  let base=0,withController=0,withEvents=0n;
  for(const type of d.person_type)for(const t of d.therapy)for(const s of d.sensors) {
    const c=controllerOptions(t,s).length;
    base+=variantsPerType;withController+=variantsPerType*c;
    withEvents+=BigInt(variantsPerType*c)*(1n<<BigInt(applicablePacks(type,t).length));
  }
  const byMode=m=>d.therapy.filter(t=>t.mode===m).length,bySetup=x=>d.sensors.filter(s=>s.setup===x).length;
  return {
    persons:{types:d.person_type.length,variants_per_type:variantsPerType,total:d.person_type.length*variantsPerType},
    therapies:{pump:byMode('pump'),mdi:byMode('mdi'),total:d.therapy.length},
    sensor_setups:{cgm:bySetup('cgm'),calibrated_cgm:bySetup('calibrated_cgm'),flash:bySetup('flash'),meter_only:bySetup('meter_only'),total:d.sensors.length},
    controller_modes:d.controller.length,event_packs:d.event_packs.length,
    instances:{person_therapy_sensors:base,with_controller:withController,with_event_pack_subsets:withEvents.toString()},
    note:'Counts are instance families: each instance also has a seed, and person.sample draws individual physiology within the class while daily life is stochastic.',
  };
}

const controllerSpec=mode=>mode==='manual'?{enabled:false}:{enabled:true,mode};

/** Assembles an instance spec from dimension choices. */
export function makeSpec({person_type,bmi,dawn,carb_counting,therapy,sensors,controller='manual',events=[]},{seed=0,sample=true,horizon_minutes}={}) {
  const spec={seed,person:{type:person_type,bmi,dawn,carb_counting,sample},therapy:structuredClone(therapy),
    sensors:{cgm:sensors.cgm,meter:sensors.meter},controller:controllerSpec(controller),events:['baseline',...events]};
  if(horizon_minutes)spec.horizon_minutes=horizon_minutes;
  return spec;
}

/** Factor levels of a choice, used for pairwise coverage. Undefined factors (e.g. pump for MDI) are omitted. */
function factors(c) {
  const t=c.therapy,f={person_type:c.person_type,bmi:c.bmi,dawn:c.dawn,carb_counting:c.carb_counting,mode:t.mode,
    sensor_setup:c.sensors.setup,cgm:c.sensors.cgm??'none',meter:c.sensors.meter??'none',controller:c.controller,
    event_pack:c.events.length===1?c.events[0]:c.events.length?'multiple':'baseline'};
  if(t.mode==='pump')Object.assign(f,{pump:t.pump.model,rapid_insulin:t.pump.insulin});
  else Object.assign(f,{bolus_pen:t.mdi.bolus_pen,rapid_insulin:t.mdi.bolus_insulin,basal_insulin:t.mdi.basal_insulin});
  return f;
}
function pairsOf(f) {
  const e=Object.entries(f).sort(([a],[b])=>a<b?-1:1),out=[];
  for(let i=0;i<e.length;i++)for(let j=i+1;j<e.length;j++)out.push(`${e[i][0]}=${e[i][1]}|${e[j][0]}=${e[j][1]}`);
  return out;
}
const pick=(rng,xs)=>xs[Math.floor(rng.next()*xs.length)];

/** Uniformly random valid choice with a single event pack (or none). */
function randomChoice(rng,d) {
  const therapy=pick(rng,d.therapy),sensors=pick(rng,d.sensors),person_type=pick(rng,d.person_type);
  const packs=applicablePacks(person_type,therapy),ev=Math.floor(rng.next()*(packs.length+1));
  return {person_type,bmi:pick(rng,d.bmi),dawn:pick(rng,d.dawn),carb_counting:pick(rng,d.carb_counting),therapy,sensors,
    controller:pick(rng,controllerOptions(therapy,sensors)),events:ev<packs.length?[packs[ev]]:[]};
}

/**
 * Greedy pairwise-covering design: every feasible pair of factor levels (person type x pump,
 * CGM x controller, insulin x event pack, ...) appears in at least one instance.
 * Stops when `patience` consecutive candidate pools add no new pair.
 */
export function pairwiseDesign({seed=1,candidates=100,patience=5,sample=true,horizon_minutes}={}) {
  const rng=Rng.stream(seed,'population:pairwise'),d=dimensions(),covered=new Set(),chosen=[];
  let stale=0;
  while(stale<patience) {
    let best=null,bestGain=0;
    for(let i=0;i<candidates;i++) {
      const c=randomChoice(rng,d),gain=pairsOf(factors(c)).filter(p=>!covered.has(p)).length;
      if(gain>bestGain){best=c;bestGain=gain;}
    }
    if(!best){stale++;continue;}
    stale=0;for(const p of pairsOf(factors(best)))covered.add(p);
    chosen.push(best);
  }
  return {pairs_covered:covered.size,instances:chosen.map((c,i)=>({id:`pw-${seed}-${String(i).padStart(4,'0')}`,factors:factors(c),
    spec:makeSpec(c,{seed:seed*100000+i,sample,horizon_minutes})}))};
}

/**
 * Fixed-size maximally diverse sample: candidates are drawn uniformly from the valid space
 * (with 0-3 event packs each) and greedily chosen to cover the most new factor levels and
 * level pairs. Use for previews and small diverse test sets; pairwiseDesign for full coverage.
 */
export function diverseSample(n,{seed=1,candidates=150,max_packs=3,sample=true,horizon_minutes}={}) {
  const rng=Rng.stream(seed,'population:diverse'),d=dimensions(),covered=new Set(),chosen=[];
  const keyed=c=>{const f=factors(c);delete f.event_pack;for(const e of c.events)f[`event:${e}`]='on';f.event_count=String(c.events.length);return f;};
  const units=f=>[...Object.entries(f).map(([k,v])=>`${k}=${v}`),...pairsOf(f)];
  while(chosen.length<n) {
    let best=null,bestGain=-1;
    for(let i=0;i<candidates;i++) {
      const c=randomChoice(rng,d),packs=applicablePacks(c.person_type,c.therapy);
      const k=Math.floor(rng.next()*(Math.min(max_packs,packs.length)+1)),pool=[...packs];
      c.events=Array.from({length:k},()=>pool.splice(Math.floor(rng.next()*pool.length),1)[0]);
      const gain=units(keyed(c)).filter(u=>!covered.has(u)).length;
      if(gain>bestGain){best=c;bestGain=gain;}
    }
    for(const u of units(keyed(best)))covered.add(u);
    chosen.push(best);
  }
  return {units_covered:covered.size,instances:chosen.map((c,i)=>({id:`dv-${seed}-${String(i).padStart(3,'0')}`,factors:factors(c),
    spec:makeSpec(c,{seed:seed*100000+i,sample,horizon_minutes})}))};
}

function weighted(rng,weights) {
  const e=Object.entries(weights),total=e.reduce((s,[,w])=>s+w,0);let r=rng.next()*total;
  for(const [k,w] of e){if((r-=w)<0)return k;}
  return e.at(-1)[0];
}

/**
 * Prevalence-weighted sample approximating the treated T1D population
 * (knowledge/instances.json prevalence). Each applicable event pack is enabled with
 * probability `event_probability`; where a built-in controller is possible its mode
 * follows `controller_weights`.
 */
export function representativeSample(n,{seed=1,event_probability=0.25,controller_weights={manual:0.5,closed:0.4,open:0.05,lgs:0.05},sample=true,horizon_minutes}={}) {
  const P=K.prevalence,rng=Rng.stream(seed,'population:representative'),d=dimensions(),out=[];
  const pumpable=Object.fromEntries(Object.entries(P.rapid_insulin).filter(([k])=>K.insulins[k].class!=='regular'));
  const penFor=ins=>Object.entries(K.penInsulins).filter(([,xs])=>xs.includes(ins)).map(([p])=>p);
  for(let i=0;i<n;i++) {
    const person_type=`${weighted(rng,P.age_group)}_${rng.next()<0.5?'male':'female'}`;
    const mode=weighted(rng,P.therapy_mode);
    let therapy;
    if(mode==='pump')therapy={mode,pump:{model:weighted(rng,P.pump_model),insulin:weighted(rng,pumpable)}};
    else {
      const rapid=weighted(rng,P.rapid_insulin),basal=weighted(rng,P.basal_insulin);
      therapy={mode,mdi:{bolus_pen:pick(rng,penFor(rapid)),bolus_insulin:rapid,basal_pen:pick(rng,penFor(basal)),basal_insulin:basal}};
    }
    const setup=weighted(rng,P.sensor_setup);
    let options=d.sensors.filter(s=>s.setup===setup);
    if(setup==='cgm'||setup==='flash')options=rng.next()<0.5?options.filter(s=>s.meter===null):options.filter(s=>s.meter!==null);
    const sensors=pick(rng,options),ctl=controllerOptions(therapy,sensors);
    const choice={person_type,bmi:weighted(rng,P.bmi),dawn:rng.next()<(K.persons[person_type].dawn_prevalence??0.24)?'present':'absent',
      carb_counting:weighted(rng,{typical:0.6,accurate:0.2,poor:0.2}),therapy,sensors,
      controller:ctl.length>1?weighted(rng,controller_weights):'manual',
      events:applicablePacks(person_type,therapy).filter(()=>rng.next()<event_probability)};
    out.push({id:`rep-${seed}-${String(i).padStart(5,'0')}`,factors:factors(choice),spec:makeSpec(choice,{seed:seed*100000+i,sample,horizon_minutes})});
  }
  return {instances:out};
}

/** Returns the instances whose specs cannot be built into a config. */
export function validatePopulation(instances) {
  const errors=[];
  for(const x of instances){try{buildInstanceConfig(x.spec);}catch(e){errors.push({id:x.id,error:e.message});}}
  return errors;
}
