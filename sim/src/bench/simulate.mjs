// `simulate` what-if tool of the LLM controller (agent option simulate, experiment 2c). The model
// asks what a candidate action would do; we run it on a PRIVATE simulator copy built only from
// public information: the instance's public description (src/oracle/belief.mjs publicDescription:
// devices, insulins, person type, programmed settings; never the seed or the sampled person), the
// current programmed profile from the observation, and the agent-visible records (its insulin log,
// reported carbs, latest readings). The person in that copy is the population MEDIAN of the public
// person type (person.sample false), not the hidden person, so the answer is "under assumed
// parameters" by construction and two persons with the same public description get the same answer
// from the same records. No future meals, exercise or life events are assumed (only the optional
// extra_carbs_g eaten now). The prediction is anchored to the latest visible reading.
import {buildInstanceConfig} from '../sim/instance.mjs';
import {SimEnv} from '../env/pomdp.mjs';
import {fmtG,unitLabel,actionArgs} from './prompt.mjs';

export const SIMULATE_VERSION='sweet-sim.simulate/v2-own-receipts';
const MIN=60000,FIVE=5*MIN;
const HISTORY_MINUTES=360;
const REPLAY_ACTIONS=new Set(['BOLUS','INGEST_CARBS','BASAL_INJECTION','TEMP_BASAL','CANCEL_TEMP_BASAL',
  'EXTENDED_BOLUS','CANCEL_EXTENDED_BOLUS','CANCEL_BOLUS','SUSPEND_PUMP','RESUME_PUMP','CHANGE_INFUSION_SET']);

/** Replay only public records and successful own receipts, never the hidden patient's state. */
export function privateHistory(obs,records) {
  const t=Date.parse(obs.virtual_time),from=t-HISTORY_MINUTES*MIN;
  const own=(records?.ownActions(from,t)??[]).filter(a=>REPLAY_ACTIONS.has(a.action.type));
  const history=[];
  for(const b of records?.ledger.values()??[]) {
    if(b.kind!=='bolus'||b.t<from||b.t>t||own.some(a=>a.action.type==='BOLUS'&&a.t===b.t))continue;
    history.push({t:b.t,action:{type:'BOLUS',units:b.units},source:'visible_ledger'});
  }
  for(const c of records?.carbs.values()??[]) {
    if(c.t<from||c.t>t||own.some(a=>a.action.type==='INGEST_CARBS'&&a.t===c.t&&c.source==='agent_rescue_carbs'))continue;
    history.push(c.source==='announced_meal'?{t:c.t,meal:c.grams,source:'visible_meal'}
      :{t:c.t,action:{type:'INGEST_CARBS',grams:c.grams},source:'visible_carbs'});
  }
  for(const a of own) {
    const action={...a.action},ap=a.receipt.applied??{};
    // Use the device's acknowledged grid-rounded setting, not the requested dose/rate.
    if(['BOLUS','EXTENDED_BOLUS'].includes(action.type)&&ap.units!=null)action.units=ap.units;
    if(action.type==='BASAL_INJECTION'&&ap.delivered_u!=null)action.units=ap.delivered_u;
    if(action.type==='TEMP_BASAL'&&ap.rate_u_h!=null){delete action.percent;action.rate_u_h=ap.rate_u_h;}
    if(ap.duration_minutes!=null)action.duration_minutes=ap.duration_minutes;
    history.push({t:a.t,action,source:'own_receipt',action_id:a.receipt.action_id});
  }
  return history.sort((a,b)=>a.t-b.t);
}

function modelWithOwnHistory(spec,history,now=Date.parse(spec.start_time)) {
  const t=Date.parse(spec.start_time),from=t-HISTORY_MINUTES*MIN;
  const env=new SimEnv(buildInstanceConfig({...spec,start_time:new Date(from).toISOString(),horizon_minutes:spec.horizon_minutes+HISTORY_MINUTES,
    overrides:{...spec.overrides,initial_state:{history_minutes:0,history:[]}}}));
  const w=env.world;
  for(const [i,e] of history.entries()) {
    w.advanceTo(e.t);
    if(w.terminated)throw new Error(`private history failed: ${w.error}`);
    if(e.meal!=null)w.physiology.ingest(`known-meal:${i}`,e.meal,45);
    else {
      const receipt=w.apply(e.action,`known-history:${i}`,'before_episode');
      if(receipt.status!=='applied')throw new Error(`private history could not replay ${e.action.type}: ${receipt.reason}`);
    }
  }
  w.advanceTo(now);
  if(w.terminated)throw new Error(`private history failed: ${w.error}`);
  // Only future samples belong to the what-if answer; history is not a scored episode.
  env.evaluator=[];env.recordEvaluator();
  return env;
}

/** Public spec of the private model at virtual time t (ms). */
export function privateSpec(desc,obs,{records=null,hours=4}={}) {
  const t=Math.floor(Date.parse(obs.virtual_time)/FIVE)*FIVE,p=obs.profile,mdi=desc.therapy.mode==='mdi';
  const latest=obs.glucose?.value_mg_dl??null;
  // Start the history from the visible reading closest to HISTORY_MINUTES ago (else the latest one).
  let g0=latest??120;
  if(records) {
    const from=t-HISTORY_MINUTES*MIN,near=records.series(from-30*MIN,from+30*MIN);
    const spot=records.spotReadings(from-30*MIN).filter(r=>Date.parse(r.time)<=from+30*MIN);
    const pick=[...near,...spot].sort((a,b)=>Math.abs(Date.parse(a.time)-from)-Math.abs(Date.parse(b.time)-from))[0];
    if(pick)g0=pick.value_mg_dl;
  }
  const history=[];
  if(records) {
    let lastBolus=null;
    for(const b of [...records.ledger.values()].filter(e=>e.kind==='bolus'&&e.t>t-HISTORY_MINUTES*MIN&&e.t<=t).sort((a,b)=>a.t-b.t)) {
      // The device refuses boluses closer than its minimum interval: merge them (same insulin, same hour).
      if(lastBolus&&b.t-lastBolus.t<20*MIN){lastBolus.units=Math.min(25,lastBolus.units+b.units);continue;}
      lastBolus={type:'bolus',t:b.t,units:Math.min(25,Number(b.units.toFixed(2)))};history.push(lastBolus);
    }
    for(const c of [...records.carbs.values()].filter(c=>c.t>t-HISTORY_MINUTES*MIN&&c.t<=t))
      history.push(c.source==='announced_meal'?{type:'meal',t:c.t,grams:Math.min(200,c.grams),announced_grams:Math.min(300,c.grams),absorption_minutes:45}
        :{type:'carbs',t:c.t,grams:Math.min(c.grams,p.max_rescue_carbs_g??50)});
  }
  const entries=history.sort((a,b)=>a.t-b.t).slice(-50).map(({t:ms,...e})=>({...e,minutes_before:Math.min(HISTORY_MINUTES,Math.max(5,Math.round((t-ms)/FIVE)*5))}))
    .filter(e=>(e.units??e.grams)>0);
  const therapy=mdi?{mode:'mdi',mdi:{...desc.therapy.mdi,basal_times:[...desc.therapy.mdi.basal_times],basal_dose_u:p.basal_injection?.units??desc.therapy.mdi.basal_dose_u}}
    :{mode:'pump',pump:{...desc.therapy.pump}};
  return {seed:1,start_time:new Date(t).toISOString(),horizon_minutes:hours*60,
    person:desc.person?{type:desc.person.type,bmi:desc.person.bmi,dawn:desc.person.dawn==='random'?'absent':desc.person.dawn,carb_counting:desc.person.carb_counting,sample:false}:null,
    therapy,sensors:{cgm:null,meter:'generic_iso15197'},events:['baseline'],self_care:'none',
    overrides:{utc_offset_minutes:desc.utc_offset_minutes,patient:{initial_glucose_mg_dl:Math.min(400,Math.max(40,g0))},
      profile:{...(mdi?{}:{basal_u_h:p.basal_u_h}),isf_mg_dl_per_u:p.isf_mg_dl_per_u,carb_ratio_g_per_u:p.carb_ratio_g_per_u,target_mg_dl:p.target_mg_dl,
        dia_hours:p.dia_hours,max_basal_u_h:p.max_basal_u_h},
      physiology:{daily_sensitivity_cv:0},meter:{routine_times:[]},faults:{occlusion_rate_per_day:0,occlusions:[]},
      scenario:{meals:{},extra_events:[],activity:{enabled:false},stress:{enabled:false}},
      ...(entries.length?{initial_state:{history_minutes:HISTORY_MINUTES,history:entries}}:{})},
    _history_entries:entries.length};
}

/**
 * Runs one what-if: {action, hours, extra_carbs_g?} on the private model. Returns {ok, text (agent
 * units), result:{points:[{minutes, mg_dl}], min, max, minutes_below_70, offset_mg_dl, ...}} or {ok:false, text}.
 */
export function simulateWhatIf({desc,obs,records,action,hours=4,extra_carbs_g=0,units='mmol'}) {
  const u=unitLabel(units),g=v=>fmtG(v,units);
  if(!desc)return {ok:false,text:'simulate is not available (no public description of this setup)'};
  let env,spec,history=[],ownHistoryEntries=0;
  try {
    spec=privateSpec(desc,obs,{records,hours});
    const {_history_entries,...s}=spec;
    // Reconstruct physiology from available history, then apply the visible aggregate quota at now.
    // A partial six-hour history is not a complete count of today's injections.
    if(s.therapy.mode==='mdi'&&obs.device?.injection_budget?.limit!=null)delete s.therapy.mdi.max_daily_injections;
    const now=Date.parse(obs.virtual_time);
    if(now>Date.parse(s.start_time))s.horizon_minutes+=5;
    history=privateHistory(obs,records);
    ownHistoryEntries=history.filter(e=>e.source==='own_receipt').length;
    env=ownHistoryEntries?modelWithOwnHistory(s,history,now):new SimEnv(buildInstanceConfig(s));
    if(env.now<now){env.world.advanceTo(now);env.evaluator=[];env.recordEvaluator();}
  } catch(e){return {ok:false,text:`simulate failed to build the private model: ${String(e.message).slice(0,300)}`};}
  const w=env.world,t0=w.now,start=w.physiology.glucose();
  const quota=obs.device?.injection_budget;
  if(w.mdi&&quota?.limit!=null) {
    w.config.therapy.mdi.max_daily_injections=quota.limit;
    w.device.maxDailyInjections=quota.limit;w.device.utcOffsetMinutes=desc.utc_offset_minutes;
    w.device.injectionCounts={[quota.local_date]:quota.used};
  }
  const latest=obs.glucose?.value_mg_dl??null,offset=latest!=null&&(obs.glucose.age_minutes??0)<=60?latest-start:0;
  const tb=obs.device?.temp_basal;
  if(tb&&obs.device.type==='pump') {
    const left=Math.round((Date.parse(tb.ends_at)-t0)/MIN/15)*15;
    if(left>=15)try{w.apply({type:'TEMP_BASAL',rate_u_h:tb.rate_u_h,duration_minutes:left},'whatif:current-temp','agent');}catch{}
  }
  if(extra_carbs_g>0)w.physiology.ingest('whatif:extra',Math.min(200,extra_carbs_g),45);
  const pts=[];let receipt;
  try {
    receipt=w.apply(action,'whatif-0','agent');
    // Custom events may wake the agent off the absolute five-minute grid. Sample relative to
    // this decision time so +30/+60-minute predictions do not silently disappear.
    for(let at=t0+FIVE;at<=t0+hours*60*MIN;at+=FIVE) {
      w.advanceTo(at);
      if(w.terminated)throw new Error(w.error);
      env.recordEvaluator();
    }
  } catch(e){return {ok:false,text:`simulate failed: ${String(e.message).slice(0,300)}`};}
  for(const s of env.evaluator) {
    const m=(Date.parse(s.time)-t0)/MIN;
    if(m>=0&&m%5===0)pts.push({minutes:m,mg_dl:Math.max(20,s.true_glucose_mg_dl+offset)});
  }
  const vals=pts.map(p=>p.mg_dl),min=Math.min(...vals),max=Math.max(...vals);
  const at=v=>pts.find(p=>p.mg_dl===v).minutes,clock=m=>`+${Math.floor(m/60)}:${String(m%60).padStart(2,'0')}`;
  const below=5*pts.filter(p=>p.mg_dl<70).length;
  const every=pts.filter(p=>p.minutes%30===0);
  const who=desc.person?`a population-median ${desc.person.type.replace(/_/g,' ')}`:'the reference patient';
  const text=[`What-if for ${action.type}${actionArgs(action)}${extra_carbs_g>0?` plus ${extra_carbs_g} g eaten now`:''}, next ${hours} h `
      +`(private model of ${who} with the current profile, NOT the person's real physiology; no other meals or exercise assumed; ${offset!==0||(latest!=null&&(obs.glucose.age_minutes??0)<=60)
        ?`anchored to the latest reading ${g(latest)} ${u}`:`not anchored: no reading in the last hour${latest!=null?` (latest ${g(latest)} ${u}, ${Math.round(obs.glucose.age_minutes)} min old)`:''}`}):`,
    ...(ownHistoryEntries?[`Known history replayed: ${ownHistoryEntries} own action receipt(s), ${history.length-ownHistoryEntries} available external record(s); hidden records remain unknown.`]:[]),
    `${receipt?.status==='rejected'?`the device would REJECT this action: ${receipt.reason}. `:''}glucose ${every.map(p=>`${clock(p.minutes)} ${g(p.mg_dl)}`).join(', ')}`,
    `min ${g(min)} at ${clock(at(min))}, max ${g(max)} at ${clock(at(max))}, predicted time below ${g(70)} ${u}: ${below} min`].join('\n');
  return {ok:true,text,result:{version:SIMULATE_VERSION,hours,extra_carbs_g,action,rejected:receipt?.status==='rejected'?receipt.reason:null,
    offset_mg_dl:Number(offset.toFixed(1)),history_entries:ownHistoryEntries?history.length:spec._history_entries,
    own_history_entries:ownHistoryEntries,history_sources:ownHistoryEntries?history.map(e=>({time:new Date(e.t).toISOString(),type:e.action?.type??'meal',source:e.source})):[],
    min,max,minutes_below_70:below,points:every}};
}
