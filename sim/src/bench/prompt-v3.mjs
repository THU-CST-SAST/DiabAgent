// Prompt construction for the LLM bench (docs/BENCH.zh-CN.md §3.2–3.3): system prompt, per-turn
// observation text, the single `act` tool schema, and log compaction. Everything here is derived
// from what the agent may see: the observation (World.observe()) and public parts of the instance
// config (profile, device and sensor models, routine times, safety limits). Hidden state (true
// glucose, unannounced meals, sampled physiology, scheduled-but-unseen events) never enters.
// Internally all glucose values are mg/dL; the agent sees mmol/L by default (1 decimal, /18.016).
import {buildInstanceConfig} from '../sim/instance.mjs';
import {availableHooks,DEFAULT_HOOKS} from '../env/hooks.mjs';

export const MGDL_PER_MMOL=18.016;
export const WAIT_MIN=5,WAIT_MAX=240,KEEP_TURNS=12;
export const PROMPT_REVISION='availability-consistency/v3-neutral-missingness';
export const RECORD_AVAILABILITY_NOTICE='Carbohydrate, treatment, activity and other records may be missing or withheld. Missing records do not establish that the underlying events did not occur. IOB/COB estimates use available records and can differ from actual active insulin or absorbing carbohydrate.';
/** What each wake hook means, in the agent's words (names from src/env/hooks.mjs). */
export const HOOK_DOC={
  meal:'the person reports a meal',exercise:'announced exercise starts',life:'alcohol, illness or poor-sleep reports',
  alarm:'device alarms (CGM/flash low or high, pump alarms, sensor replaced)',reading:'a routine fingerstick or scan result arrives',
  injection:'the routine long-acting injection is taken',patient:'the person bolused or treated a low by themselves',
};
const thresholdsOffered=obs=>availableHooks(obs).includes('below');
/** One-line description of the wake hooks this setup offers (for the tool schema and system prompt). */
export function hooksText(obs,units='mmol') {
  const list=availableHooks(obs).filter(h=>HOOK_DOC[h]).map(h=>`${h} (${HOOK_DOC[h]})`);
  if(thresholdsOffered(obs))list.push(`below:X / above:X (a CGM reading below/above X ${unitLabel(units)}, e.g. below:${units==='mgdl'?'80':'4.5'})`);
  return list.join('; ');
}

const AGE_GROUPS={child:'child (6-12 y)',adolescent:'adolescent (13-17 y)',adult:'adult (18-64 y)',older:'older adult (65+ y)'};
const ACTION_DOC={
  WAIT:'Do nothing now (scheduled basal / routine long-acting insulin continue).',
  INGEST_CARBS:'The person eats/drinks fast carbohydrate now (e.g. hypo treatment). Logged as reported carbs.',
  BOLUS:'Rapid-acting insulin bolus now.',
  CANCEL_BOLUS:'Stop a bolus that is still being delivered.',
  TEMP_BASAL:'Temporary basal for a duration (give exactly one of rate_u_h or percent of the scheduled basal).',
  CANCEL_TEMP_BASAL:'Return to the scheduled basal rate.',
  EXTENDED_BOLUS:'Extended (square-wave) bolus delivered evenly over the duration.',
  CANCEL_EXTENDED_BOLUS:'Stop a running extended bolus (insulin already delivered stays).',
  SUSPEND_PUMP:'Suspend all insulin delivery for a fixed time (pump disconnect).',
  RESUME_PUMP:'Resume delivery after a suspension.',
  CHANGE_INFUSION_SET:'Replace the infusion set/cannula (fixes an occlusion).',
  BASAL_INJECTION:'Extra long-acting insulin injection now (the routine dose is taken by the person automatically).',
  MEASURE_BG:'Fingerstick glucose measurement now; the value is shown in the next message.',
  SCAN:'Scan the flash sensor now; current value, trend and 8 h sensor history are shown in the next message.',
  CALIBRATE_CGM:'Fingerstick and calibrate the CGM with it.',
  SET_PROFILE:'Reprogram the therapy profile from now on (basal, ISF, carb ratio, target; long-acting dose on pens), each within a factor of the current value; the person and devices keep using it.',
  SET_LOOP_MODE:'Change the built-in loop mode.',SUSPEND_LOOP:'Suspend the built-in loop.',SET_TEMP_TARGET:'Set a temporary target preset.',
};

// --- units and formatting --------------------------------------------------------------------

export const unitLabel=units=>units==='mgdl'?'mg/dL':'mmol/L';
/** Glucose value in agent units (string, no unit). */
export function fmtG(mg,units='mmol') {
  if(mg==null||!Number.isFinite(mg))return '?';
  return units==='mgdl'?String(Math.round(mg)):(mg/MGDL_PER_MMOL).toFixed(1);
}
/** Rate of change in agent units per 5 min. */
function fmtTrend(mgPerMin,units) {
  if(mgPerMin==null||!Number.isFinite(mgPerMin))return null;
  const v=mgPerMin*5,s=units==='mgdl'?String(Math.round(v)):(v/MGDL_PER_MMOL).toFixed(2);
  return `${v>=0?'+':''}${s} ${unitLabel(units)} per 5 min`;
}
const num=(v,d=2)=>v==null||!Number.isFinite(v)?'?':String(Number(v.toFixed(d)));
const reading=(r,units)=>r.display?`${r.display} (outside meter range)`:fmtG(r.value_mg_dl,units);

/** Clock helper from an observation: local "HH:MM" for any ISO time, "(yesterday)" for earlier days. */
export function clockOf(obs) {
  const off=Date.parse(obs.local_time.replace(' ','T')+':00Z')-Date.parse(obs.virtual_time),today=obs.local_time.slice(0,10);
  return iso=>{
    if(!iso)return '?';
    const d=new Date(Date.parse(iso)+off),day=d.toISOString().slice(0,10);
    const hm=`${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
    return day<today?`${hm} (yesterday)`:day>today?`${hm} (tomorrow)`:hm;
  };
}

// --- events ----------------------------------------------------------------------------------

/** One-line text for a visible notice (obs.events item). */
export function eventText(e,{units='mmol',clock}) {
  const t=clock(e.time),u=unitLabel(units);
  switch(e.type) {
    case 'meal_announced':return `${t} meal eaten, person reports ${e.grams} g carbs (${e.accuracy==='exact'?'accurately recorded dietary carbohydrate':'their estimate; may be inaccurate'})`;
    case 'exercise_planned':return `${t} the person plans ${e.kind??'exercise'}${e.duration_minutes?` for about ${e.duration_minutes} min`:''} starting around ${e.planned_time?clock(e.planned_time):'later'}`;
    case 'meal_composition_reported':return `${t} the person says this meal is ${e.composition==='high_fat'?'high in fat/protein (slower absorption)':e.composition}`;
    case 'exercise_started':return `${t} exercise started: ${e.kind??'activity'}${e.duration_minutes?`, about ${e.duration_minutes} min`:''}`;
    case 'fingerstick':return `${t} routine fingerstick: ${e.display??fmtG(e.value_mg_dl,units)} ${u}${e.cgm_calibrated?' (CGM calibrated)':''}`;
    case 'flash_scan':return `${t} routine scan: ${fmtG(e.value_mg_dl,units)} ${u}${e.direction?` ${e.direction}`:''}`;
    case 'patient_bolus':return `${t} the person bolused ${e.units} U by themselves for their reported ${e.grams} g${e.includes_correction?' (including a correction)':''}`;
    case 'patient_treated_low':return `${t} the person saw a low and ate ${e.grams} g by themselves`;
    case 'basal_injection_taken':return `${t} person took routine long-acting injection ${e.units} U`;
    case 'cgm_low':case 'cgm_urgent_low':case 'cgm_high':
      return `${t} ALARM ${{cgm_low:'CGM low',cgm_urgent_low:'CGM URGENT LOW',cgm_high:'CGM high'}[e.type]}: ${fmtG(e.value_mg_dl,units)} ${u}`;
    case 'flash_alarm_low':case 'flash_alarm_high':return `${t} ALARM flash sensor ${e.type.endsWith('low')?'LOW':'HIGH'} (no value shown; SCAN to see it)`;
    case 'pump_occlusion_alarm':return `${t} ALARM pump occlusion detected (insulin not delivered; CHANGE_INFUSION_SET fixes it)`;
    case 'cgm_sensor_replaced':return `${t} CGM sensor replaced (warm-up, no readings for a while)`;
    default: {
      const extra=Object.entries(e).filter(([k,v])=>!['type','time','id'].includes(k)&&v!=null&&typeof v!=='object').map(([k,v])=>`${k}=${v}`).join(', ');
      return `${t} ${e.type.replace(/_/g,' ')}${extra?` (${extra})`:''}`;
    }
  }
}
export const isAlarm=e=>/^(cgm_(low|urgent_low|high)$|flash_alarm_|pump_occlusion_alarm)/.test(e.type);

// --- action table and tool schema ----------------------------------------------------------

function paramText(name,r) {
  if(r.enum)return `${name} one of {${r.enum.join(', ')}}${r.unit?` ${r.unit}`:''}`;
  const lo=r.exclusive_min?`>${r.min}`:`${r.min}`;
  const extra=[r.step?`step ${r.step}`:null,r.integer?'integer':null,r.optional?'optional':null,r.note??null].filter(Boolean);
  return `${name}: ${lo} to ${num(r.max,3)}${r.unit?` ${r.unit}`:''}${extra.length?` (${extra.join('; ')})`:''}`;
}
/** Action table (one line per action) from obs.action_specs. */
export function actionTable(specs) {
  return Object.entries(specs).map(([type,spec])=>{
    const params=Object.entries(spec).filter(([k])=>k!=='note').map(([k,r])=>paramText(k,r));
    return `- ${type}${params.length?` — ${params.join('; ')}`:''}. ${ACTION_DOC[type]??''}${spec.note?` (${spec.note})`:''}`.trim();
  }).join('\n');
}

function paramSchema(r) {
  if(r.enum)return {enum:[...r.enum],...(r.unit?{description:r.unit}:{})};
  const s={type:r.integer?'integer':'number'};
  if(r.exclusive_min)s.exclusiveMinimum=r.min;else s.minimum=r.min;
  s.maximum=r.max;
  const d=[r.unit,r.step?`step ${r.step}`:null,r.note].filter(Boolean).join('; ');
  if(d)s.description=d;
  return s;
}
/** The single `act` tool for the instance's action set and wake hooks: {name, description, input_schema}. */
export function toolSchema(obs,{units='mmol',minWait=WAIT_MIN,notes=false,cap=null}={}) {
  const variants=actionVariants(obs);
  const gated=minWait>WAIT_MIN||cap!=null;
  return {name:'act',
    description:'Take one action now, then let simulated time pass. Use action {"type":"WAIT"} to only let time pass.',
    input_schema:{type:'object',properties:{
      action:{oneOf:variants,description:'One action from the action table.'},
      wait_minutes:{type:'integer',minimum:minWait,maximum:WAIT_MAX,
        description:`Minutes until you are called again at the latest; something in wake_on can wake you earlier${gated?` (but never earlier than ${minWait} min after this decision, except urgent alarms and measurement results${cap!=null?`; after ${cap} decisions in a day only urgent alarms wake you until the next day`:''})`:''}.`},
      wake_on:{type:'array',items:thresholdsOffered(obs)
          ?{anyOf:[{enum:availableHooks(obs).filter(h=>HOOK_DOC[h])},{type:'string',pattern:'^(below|above):[0-9]+(\\.[0-9]+)?$'}]}
          :{enum:availableHooks(obs).filter(h=>HOOK_DOC[h])},
        description:`Optional. What may wake you before wait_minutes is over (default ${JSON.stringify(DEFAULT_HOOKS)}; [] = sleep the full wait${gated?'; urgent alarms always wake you':''}). Hooks: ${hooksText(obs,units)}.`},
      note:{type:'string',maxLength:500,description:'Short reason for this decision (shown in the replay and kept in your day log).'},
      ...(notes?{note_to_self:{type:'string',maxLength:2000,description:'Optional. Replaces your persistent notes (what you learned about this person: real basal/ISF/carb-ratio needs, habits, what worked). Shown to you at the start of every day and every message; omit to keep the current notes.'}}:{})},
    required:['action','wait_minutes','note'],additionalProperties:false}};
}

/** Action variants (oneOf) of the act / simulate schemas. */
function actionVariants(obs) {
  return Object.entries(obs.action_specs).map(([type,spec])=>{
    const props={type:{type:'string',const:type}},required=['type'];
    for(const [k,r] of Object.entries(spec)) {
      if(k==='note')continue;
      props[k]=paramSchema(r);
      if(!r.optional)required.push(k);
    }
    return {type:'object',description:ACTION_DOC[type]??type,properties:props,required,additionalProperties:false};
  });
}

/** The optional `simulate` what-if tool (agent option simulate; src/bench/simulate.mjs). */
export function simulateToolSchema(obs,{maxHours=6,calls=3}={}) {
  return {name:'simulate',
    description:`Ask "what if": predicts glucose for a candidate action on a private simulator of a population-median person of this type with the current profile `
      +`(NOT this person's real physiology, which you must infer yourself; no future meals or exercise assumed). Nothing is applied and time does not pass. `
      +`At most ${calls} simulate call(s) per decision; then call act.`,
    input_schema:{type:'object',properties:{
      action:{oneOf:actionVariants(obs),description:'The candidate action.'},
      hours:{type:'integer',minimum:1,maximum:maxHours,description:'How far ahead to predict (default 4).'},
      extra_carbs_g:{type:'number',minimum:0,maximum:150,description:'Optional: assume the person eats this many grams of carbohydrate now (e.g. a suspected unreported meal).'}},
      required:['action'],additionalProperties:false}};
}

/**
 * System prompt section for non-default agent options (decision limits, memory, simulate) and the
 * warm-up records. opts: normalized agent options (src/bench/agent-options.mjs).
 */
export function optionsPromptText(opts,{days=1,warmupText=null,profileAvailable=false}={}) {
  const out=[];
  if(opts.min_decision_minutes>WAIT_MIN||opts.max_decisions_per_day!=null) {
    out.push('','## Decision limits');
    if(opts.min_decision_minutes>WAIT_MIN)out.push(`- After each decision you are not called again for at least ${opts.min_decision_minutes} min (wait_minutes below that is raised to it). Events you subscribed to in that time are held and shown when you are called. Exceptions: urgent alarms (CGM urgent low, pump occlusion) always wake you at once, and a measurement result (MEASURE_BG, SCAN, CALIBRATE_CGM) is shown right away.`);
    if(opts.max_decisions_per_day!=null)out.push(`- At most ${opts.max_decisions_per_day} decisions per day (each act call counts). After the last one, only urgent alarms wake you until the next day starts; plan long waits and robust settings (temp basals, extended boluses) accordingly. Each message shows how many decisions you have left today.`);
  }
  if(days>1) {
    out.push('',`## Multiple days`,`- The episode lasts ${days} days; every day is scored on its own. Your conversation is reset at the start of each day.`);
    if(opts.memory==='none')out.push('- You keep no memory between days: each day you start fresh from the observation.');
    else {
      out.push('- At the start of each day you get a summary of every previous day (what your sensors and devices recorded) and your own notes.');
      out.push('- Use `note_to_self` in act to rewrite your persistent notes: what you learned about this person (their real basal need, carb ratio, sensitivity, meal habits, what worked and what did not). The notes are all you keep in your own words.');
    }
  } else if(opts.memory!=='none')out.push('','## Notes','- Use `note_to_self` in act to keep persistent notes; they are shown at the top of every message.');
  if(opts.memory==='notes+profile'&&profileAvailable)out.push('- You may reprogram the person\'s therapy profile with SET_PROFILE (basal, ISF, carb ratio, target; long-acting dose on pens). The new settings stay in effect for all later days and are used by the device calculators and by the person.');
  if(opts.simulate)out.push('','## What-if tool',`- Besides act you may call \`simulate\` (up to ${opts.simulate_calls} times per decision) to predict glucose for a candidate action on a private model of a typical person of this type with the current profile. It does not know this person's real sensitivity or unreported meals; treat it as a rough guide and correct it with what you observe.`);
  if(opts.samples>1)out.push('',`(Your reply is sampled ${opts.samples} times per decision; the most common action is applied.)`);
  if(warmupText)out.push('',warmupText);
  return out.join('\n');
}

// --- system prompt ---------------------------------------------------------------------------

/**
 * World-config-shaped view of public.json (src/export/harbor.mjs publicInfo: `prompt_context` and the
 * built-in loop setting from `description`): the public config fields taskDescription reads. Used by
 * agents that only have public.json.
 */
export function publicPromptConfig(pub) {
  const pc=pub?.prompt_context??{};
  return {person:pc.person??null,patient:pc.patient??{},meter:pc.meter??{},alarms:pc.alarms??{},safety:pc.safety??{},
    controller:pub?.description?.controller??null};
}

/** The scoring sentence of the objective: the bench v0.2 rule in words, or the given non-default weights. */
function penaltyText(weights) {
  if(!weights)return 'Hypoglycemia is much worse than hyperglycemia: time below 3.9 mmol/L is penalised 1.5x, below 3.0 mmol/L 4x, and a severe low (below 3.0 mmol/L for 15 min or more) scores the whole day as zero. Time above 13.9 mmol/L is also penalised.';
  const w=weights,terms=[`${w.tir===1?'':`${w.tir} x `}fraction of time in 3.9–10.0 mmol/L`];
  if(w.tbr70)terms.push(`${w.tbr70} x fraction below 3.9 mmol/L`);
  if(w.tbr54)terms.push(`${w.tbr54} x fraction below 3.0 mmol/L`);
  if(w.tar250)terms.push(`${w.tar250} x fraction above 13.9 mmol/L`);
  return `Score = ${terms.join(' - ')}, clipped to [0, 1]; a severe low (below 3.0 mmol/L for 15 min or more) scores the whole day as zero.`;
}

/**
 * The task description shared by every agent interface: the LLM harness system prompt
 * (systemPrompt below: the in-process harness and the Harbor runner's llm agent) and the Harbor
 * task's instruction.md (src/export/harbor.mjs), which only add how to act. `config` (the resolved
 * World config, or publicPromptConfig(public.json)) is optional and built from instance.spec when
 * missing; only public fields are used (person type/age/sex/weight, profile, device/sensor models,
 * built-in loop mode, routine times, alarms, safety). `scanTimes`: routine flash scan clock times. `weights`: non-default
 * score weights (null: the bench v0.2 rule). `seeLine`: what this interface shows, in the agent's
 * words (default: the LLM harness observation text). Returns lines.
 */
export function taskDescription({instance,obs,units='mmol',config,scanTimes,hours=24,weights=null,seeLine=null,scoring_version='METRICS-v0.3'}) {
  const cfg=config??buildInstanceConfig(instance?.spec??instance);
  const u=unitLabel(units),p=obs.profile,d=obs.device,r=cfg.person?.resolved,pt=cfg.patient??{};
  const pump=d.type==='pump',lines=[];
  lines.push(
    `You are managing the blood glucose of one person with type 1 diabetes for the next ${hours%24===0&&hours>24?`${hours/24} days`:`${hours} hours`} of simulated time.`,
    'This is a research simulation (a virtual patient in a physiological model). No real person or device is affected; act as a careful diabetes clinician/self-manager would.',
    '',
    '## Objective',
    scoring_version==='METRICS-v0.3'
      ? 'Keep true blood glucose in 4–8 mmol/L (72.064–144.128 mg/dL) and avoid rapid changes. METRICS-v0.3: S = clip(T(4–8) - 1.5*T(2–4) - 4*T(<2) - 0.5*T(>12) - 0.5*max(0,CV-0.36) - 0.5*T(|ROC|>2 mg/dL/min),0,1). Low bins are disjoint. Below 3 mmol/L for at least 15 minutes scores zero. True glucose is sampled every 5 minutes; ROC uses adjacent samples. GMI and MAGE are descriptive, not separate score terms.'
      : 'Keep true blood glucose in the target range 3.9–10.0 mmol/L (70–180 mg/dL) as much of the time as possible.',
    ...(scoring_version==='METRICS-v0.3'?[]:[penaltyText(weights)]),
    `Glucose values shown to you are in ${u}${units==='mgdl'?'':' (1 mmol/L = 18.016 mg/dL)'}. Insulin is in U, carbohydrate in g, times are local clock time.`,
    '',
    '## The person (public information)');
  const who=r?`${AGE_GROUPS[r.age_group]??r.age_group}, ${r.sex}`:`adult, ${pt.sex??'male'} (reference patient)`;
  lines.push(`- ${who}; age ${pt.age_years??'?'} y; weight ${num(pt.weight_kg,1)} kg${pt.height_cm?`; height ${pt.height_cm} cm`:''}.`);
  lines.push(`- Therapy profile (their usual settings; may not be perfect): ${pump?`basal ${num(p.basal_u_h,3)} U/h, `:''}ISF ${fmtG(p.isf_mg_dl_per_u,units)} ${u} per U, carb ratio ${num(p.carb_ratio_g_per_u,1)} g/U, target ${fmtG(p.target_mg_dl,units)} ${u}, insulin action time ${p.dia_hours} h.`);
  if(!pump&&p.basal_injection)lines.push(`- Long-acting insulin: the person injects ${p.basal_injection.units} U ${obs.insulin.long_acting??''} at ${p.basal_injection.times.join(', ')} every day by themselves (you see an event). Do not repeat that dose.`);
  lines.push(p.self_care==='assisted'
    ?'- Care mode: ASSISTED. The person manages themselves: for each meal they report, they bolus with their own calculator (reported carbs / carb ratio, plus a correction when above 10.0 mmol/L, minus IOB), sometimes a few minutes late and occasionally they forget; when they see a low they eat 15 g. You see these as events. Your job is to correct and improve on top of that, without double-dosing.'
    :'- Care mode: FULL. The person does not dose insulin or treat lows by themselves; every treatment decision is yours.');
  lines.push('- Meals: the person eats on their own schedule. When they report a meal you get an event with their carb estimate once they have started eating; estimates can be wrong and some meals or snacks may never be reported. Other life events (exercise, alcohol, illness, poor sleep, stress) may happen; some are reported, some are not.');
  lines.push('','## Devices and sensors');
  if(pump) {
    const tbr=d.limits?.tbr;
    lines.push(`- Insulin pump: ${d.name} (${d.form}), rapid insulin ${obs.insulin.rapid}. The scheduled basal ${num(d.scheduled_basal_u_h,3)} U/h runs automatically.`
      +(tbr?` Temporary basal on this pump is ${tbr.type==='percent'?`percent-based (steps of ${tbr.step}%, up to ${tbr.max}%)`:'absolute (U/h)'}, duration in steps of ${tbr.duration_step_min} min.`:''));
    // The built-in loop acts only with a real-time CGM; 'open' mode changes nothing on its own.
    const c=cfg.controller;
    if(obs.cgm&&c?.enabled&&c.mode==='closed')lines.push('- Built-in automated loop (closed loop): the phone app adjusts the basal rate automatically from the CGM readings.');
    if(obs.cgm&&c?.enabled&&c.mode==='lgs')lines.push('- Low-glucose suspend (LGS): the pump suspends basal automatically on low CGM readings.');
  } else {
    lines.push(`- Insulin pens (multiple daily injections): bolus pen ${d.bolus_pen} with ${obs.insulin.rapid} (dose step ${d.limits.bolus_step_u} U); long-acting pen ${d.basal_pen} with ${obs.insulin.long_acting}. There is no pump: no temporary basal, no suspension.`);
  }
  const routine=cfg.meter?.routine_times??[];
  if(obs.cgm) {
    lines.push(`- Real-time CGM: ${obs.cgm.model}. A new interstitial reading about every 5 min with a trend; readings lag blood glucose by several minutes and have sensor error; gaps can occur.`
      +` Alarms below ${fmtG(cfg.alarms?.low_mg_dl??70,units)}, urgent below ${fmtG(cfg.alarms?.urgent_low_mg_dl??54,units)} and above ${fmtG(cfg.alarms?.high_mg_dl??250,units)} ${u}.`);
    if(obs.cgm.calibration)lines.push(`- This CGM needs a fingerstick calibration about every 12 h (CALIBRATE_CGM); without it readings stop. `
      +(routine.length?`The person does routine fingersticks at ${routine.join(', ')}, which also calibrate.`:'No automatic routine fingersticks are scheduled; use the available measurement/calibration actions when needed.'));
  } else if(obs.flash) {
    const st=scanTimes??[];
    lines.push(`- Flash glucose sensor: ${obs.flash.model}. You only see glucose when the sensor is scanned; a scan shows the current value, a trend arrow and the last 8 h of sensor readings.`
      +(st.length?` The person scans by themselves at about ${st.join(', ')};`:' No automatic routine scans are scheduled;')+' you can SCAN at any time.');
  } else {
    lines.push(`- No continuous sensor. Glucose is only known from fingerstick meter readings.${routine.length?` The person measures by routine at ${routine.join(', ')}.`:''}`);
  }
  if(obs.meter)lines.push(`- Blood glucose meter: ${obs.meter.model}.${obs.action_specs.MEASURE_BG?' You can MEASURE_BG at any time; every extra fingerstick is a burden for the person, so use them when the result can change a decision.':''}`);
  const s=cfg.safety??{};
  lines.push('','## Actions available with this setup',actionTable(obs.action_specs));
  lines.push(`Device safety rules: a bolus is rejected within ${s.bolus_min_interval_minutes??15} min of the previous bolus and when the latest fresh reading is below ${fmtG(s.block_bolus_below_mg_dl??70,units)} ${u}. Values outside the table are rejected. Doses may be rounded to the device step.`);
  lines.push('','## What you can and cannot see',
    seeLine??(obs.information?.policy==='record-derived-v3'
      ? `- You see: the clock, available glucose readings, static therapy parameters, necessary current device state, record-derived IOB/COB estimates, available event records, and receipts and memory of your own actions. Current information status: ${RECORD_AVAILABILITY_NOTICE}`
      : obs.information?.policy==='minimal-v2'&&obs.information.mode==='I2'
      ? '- You see: the clock, available glucose readings, static therapy parameters, necessary current device state, and receipts and memory of your own actions. Meal, treatment, activity, life and fault records are withheld. IOB and COB are unknown, not zero; do not interpret an empty record list as absence of those events.'
      : `- You see: the clock, the readings this setup provides (latest value, source and age, trend if available, a 3 h summary), insulin on board (IOB) and carbs on board (COB) as estimated by the device app from available logged insulin and *reported* carbs, ${pump?'basal/temp basal status, ':''}your recent treatments, available reported events and alarms, and the result of your last action. Missing records do not imply the underlying events did not occur; incomplete IOB/COB estimates are marked in the observation.`),
    '- You do not see: true blood glucose, unreported meals or the real size of reported ones, the person\'s real insulin sensitivity, effects of unreported stress/alcohol/illness, or unreported delivery faults before a visible report or alarm.');
  return lines;
}

/**
 * System prompt of the LLM harness for one episode: taskDescription plus the `act` tool protocol.
 * Arguments as taskDescription.
 */
export function systemPrompt({instance,obs,units='mmol',config,scanTimes,hours=24,weights=null,scoring_version='METRICS-v0.3'}) {
  const lines=taskDescription({instance,obs,units,config,scanTimes,hours,weights,scoring_version});
  lines.push('','## How to respond',
    'Each message gives the current observation. End each decision with exactly one call of the `act` tool. If the optional simulate tool is provided, you may call it beforehand within its stated limit. A format-only example (not a treatment recommendation):',
    '{"action": {"type": "WAIT"}, "wait_minutes": 30, "note": "Review available observations at the next wake-up."}',
    '- `action`: one action from the table above ({"type": "WAIT"} to do nothing).',
    `- \`wait_minutes\` (${WAIT_MIN}–${WAIT_MAX}): the longest simulated time that may pass before you are asked again (or the day ends). After MEASURE_BG, SCAN or CALIBRATE_CGM you are asked again right away with the result.`,
    `- \`wake_on\` (optional): what may wake you earlier. Default: ${DEFAULT_HOOKS.join(', ')}. Available here: ${hooksText(obs,units)}.`
      +(thresholdsOffered(obs)?' Glucose thresholds apply to real-time CGM readings only.':' There is no real-time CGM, so there are no glucose-threshold wake-ups: you only learn about glucose from readings and alarms you actually receive.'),
    '- `note`: a short reason (one sentence). Notes are kept in your day log; older turns are summarised there.',
    'If tool calling is unavailable, reply with only that JSON object. Invalid replies are not applied and time does not advance; 3 invalid replies in a row end your control of the day.');
  return lines.join('\n');
}

// --- observation text ------------------------------------------------------------------------

/** Points of a series spaced at least ~15 min apart, newest kept. */
function every15(points) {
  const out=[];let last=Infinity;
  for(let i=points.length-1;i>=0;i--) {
    const t=Date.parse(points[i].time);
    if(t<=last-14*60000){out.push(points[i]);last=t;}
  }
  return out.reverse();
}

/**
 * Compact per-turn observation text (§3.3).
 * ctx: {units, readings: visible spot readings [{time,value_mg_dl,display?,source:'meter'|'flash_scan'}]
 *   tracked by the harness, events: notices since the last turn, treatments: [{time,text}] the agent's
 *   recent treatments, receipt: result of the previous action, wake_reason, error: text to prepend}
 */
export function observationText(obs,ctx={}) {
  const units=ctx.units??'mmol',u=unitLabel(units),clock=clockOf(obs),now=Date.parse(obs.virtual_time),out=[];
  if(ctx.error)out.push(`ERROR: ${ctx.error}`,'');
  const elapsed=ctx.elapsed_minutes??obs.elapsed_minutes,left=Math.max(0,Math.round((ctx.horizon_minutes??1440)-elapsed));
  out.push(`Time ${obs.local_time.slice(11)}${ctx.day_label?` ${ctx.day_label}`:''} (${Math.round(elapsed)} min elapsed, ${left} min left)${ctx.wake_reason?`; woke because: ${ctx.wake_reason}`:''}`);
  if(ctx.decision_note)out.push(ctx.decision_note);
  const g=obs.glucose;
  if(g) {
    const trend=obs.cgm&&g.source==='cgm'?[obs.cgm.direction,fmtTrend(obs.cgm.trend_mg_dl_per_min,units)]
      :g.source==='flash_scan'&&obs.flash?.last_scan?[obs.flash.last_scan.direction,fmtTrend(obs.flash.last_scan.trend_mg_dl_per_min,units)]:[];
    const tr=trend.filter(Boolean).join(', ');
    const src={cgm:'CGM',meter:'fingerstick',flash_scan:'flash scan'}[g.source]??g.source;
    out.push(`Latest glucose: ${g.display??fmtG(g.value_mg_dl,units)} ${u} (${src} at ${clock(g.time)}, ${Math.round(g.age_minutes)} min ago${tr?`; trend ${tr}`:''})`);
  } else out.push('Latest glucose: none available yet');
  if(obs.cgm) {
    const c=obs.cgm,flags=[];
    if(c.warming_up_until)flags.push(`sensor warming up until ${clock(c.warming_up_until)}`);
    if(c.status&&c.status!=='ok')flags.push(`status ${c.status}`);
    if(c.calibration)flags.push(c.calibration.required_now?'CALIBRATION REQUIRED NOW':`next calibration due ${c.calibration.due_at?clock(c.calibration.due_at):'?'}`);
    if(flags.length)out.push(`CGM: ${flags.join('; ')}`);
  }
  if(obs.flash?.warming_up_until)out.push(`Flash sensor warming up until ${clock(obs.flash.warming_up_until)}`);

  // History window (history_hours, default 3 h): continuous sensor every 15 min for the last
  // min(H, 3) h; older parts of the window as hourly mean (min-max); all spot readings in the window.
  // ctx.series: continuous readings the agent has received (src/bench/records.mjs); default: this
  // observation's CGM history or the last scan's stored history.
  const H=ctx.history_hours??3,recentH=Math.min(H,3),hl=h=>`${h} h`;
  const since=now-H*3600000,recentSince=now-recentH*3600000;
  const series=ctx.series??(obs.cgm_history?.length?obs.cgm_history:obs.flash?.last_scan?.history??[]);
  const valid=series.filter(r=>Number.isFinite(r.value_mg_dl));
  const fromScan=!obs.cgm_history?.length&&obs.flash;
  if(H>3) {
    const older=valid.filter(r=>{const t=Date.parse(r.time);return t>=since&&t<recentSince;}),byH=new Map();
    for(const r of older){const k=Math.floor((now-Date.parse(r.time))/3600000);if(!byH.has(k))byH.set(k,[]);byH.get(k).push(r.value_mg_dl);}
    if(byH.size)out.push(`Earlier, ${hl(H)} to ${hl(recentH)} ago (${fromScan?'scanned sensor history':'CGM'}, hourly mean (min-max)): ${[...byH].sort((a,b)=>b[0]-a[0])
      .map(([k,a])=>`${clock(new Date(now-(k+1)*3600000).toISOString())} ${fmtG(a.reduce((x,y)=>x+y,0)/a.length,units)} (${fmtG(Math.min(...a),units)}-${fmtG(Math.max(...a),units)})`).join(', ')}`);
  }
  const pts=every15(valid.filter(r=>Date.parse(r.time)>=recentSince));
  if(pts.length) {
    const lab=!fromScan?'CGM, every 15 min':`sensor history from scans${obs.flash.last_scan?` (last scan ${clock(obs.flash.last_scan.at)})`:''}, every 15 min`;
    out.push(`Last ${hl(recentH)} (${lab}): ${pts.map(r=>`${clock(r.time)} ${fmtG(r.value_mg_dl,units)}`).join(', ')}`);
  }
  const spot=(ctx.readings??[]).filter(r=>Date.parse(r.time)>=since);
  if(spot.length)out.push(`Fingersticks/scans in last ${hl(H)}: ${spot.map(r=>`${clock(r.time)} ${reading(r,units)} (${r.source==='meter'?'meter':'scan'})`).join(', ')}`);
  else if(!obs.cgm)out.push(`Fingersticks/scans in last ${hl(H)}: none`);

  out.push(`${obs.information?.policy==='record-derived-v3'?'Record-derived estimates: ':''}IOB ${num(obs.iob.total_u)} U (bolus ${num(obs.iob.bolus_u)}, basal ${num(obs.iob.basal_u)}); COB ${num(obs.cob.estimate_g,0)} g (from reported carbs)`);
  if(obs.information?.policy==='record-derived-v3') {
    // The model gets the same uncertainty notice in every arm, never the experimental mask label.
    out.push(`Current information status: ${RECORD_AVAILABILITY_NOTICE}`);
  } else {
    if(obs.information)out.push(`Record availability ${obs.information.mode}: ${obs.information.note}`);
    if(obs.iob.history_complete===false)out.push(`IOB caution: ${obs.iob.note??obs.iob.definition??'Insulin history is incomplete; unknown insulin is not zero.'}`);
    if(obs.cob.history_complete===false)out.push(`COB caution: ${obs.cob.note??obs.cob.definition??'Meal history is incomplete; unknown intake is not zero.'}`);
  }
  const d=obs.device;
  if(d.type==='pump') {
    const parts=[`scheduled ${num(d.scheduled_basal_u_h,3)} U/h`,`current ${num(d.current_basal_u_h,3)} U/h`];
    if(d.temp_basal)parts.push(`temp ${num(d.temp_basal.rate_u_h,3)} U/h${d.temp_basal.percent!=null?` (${d.temp_basal.percent}%)`:''} until ${clock(d.temp_basal.ends_at)}`);
    if(d.suspended)parts.push(`SUSPENDED${d.stop_reason?` (${d.stop_reason})`:''}${d.suspended_until?` until ${clock(d.suspended_until)}`:''}`);
    if(d.bolus_in_progress)parts.push(`bolus ${num(d.bolus_in_progress.units)} U delivering until ${clock(d.bolus_in_progress.ends_at)}`);
    if(d.extended_bolus)parts.push(`extended bolus ${num(d.extended_bolus.delivered_u)}/${num(d.extended_bolus.units)} U until ${clock(d.extended_bolus.ends_at)}`);
    if(d.reservoir_u!=null&&d.reservoir_u<30)parts.push(`reservoir low: ${num(d.reservoir_u,0)} U`);
    out.push(`Pump: ${parts.join('; ')}`);
  } else {
    const lb=d.last_basal_injection;
    out.push(`Pens: last long-acting injection ${lb?`${lb.units} U at ${clock(lb.time)}${now-Date.parse(lb.time)>=86400000?' (24 h or more ago)':''}`:'none'}`
      +`${obs.profile.basal_injection?`; routine ${obs.profile.basal_injection.units} U at ${obs.profile.basal_injection.times.join(', ')}`:''}`);
  }
  const trH=Math.max(6,H),tr=(ctx.treatments??[]).filter(t=>Date.parse(t.time)>=now-trH*3600000);
  out.push(`Your treatments in last ${trH} h: ${tr.length?tr.map(t=>`${clock(t.time)} ${t.text}`).join('; '):'none'}`);
  const ev=ctx.events??obs.events??[];
  if(ev.length)out.push('New events since your last action:',...ev.map(e=>`- ${eventText(e,{units,clock})}`));
  else out.push('New events since your last action: none');
  if(ctx.receipt)out.push(`Result of your last action: ${receiptText(ctx.receipt,{units,clock})}`);
  return out.join('\n');
}

/** Human-readable receipt. r: World action receipt plus {action}, or {parse_error}. */
export function receiptText(r,{units='mmol',clock}) {
  if(!r)return 'none';
  if(r.parse_error)return `not applied (${r.parse_error})`;
  const a=r.action?`${r.action.type}${actionArgs(r.action)}`:'action';
  if(r.status==='rejected')return `${a} REJECTED: ${r.reason}`;
  const ap=r.applied??{},extra=[];
  if(ap.value_mg_dl!=null)extra.push(`glucose ${ap.display??fmtG(ap.value_mg_dl,units)} ${unitLabel(units)}${ap.direction?` ${ap.direction}`:''}`);
  else if(r.action?.type==='SCAN')extra.push('no sensor value available');
  if(ap.meter_value_mg_dl!=null)extra.push(`meter ${fmtG(ap.meter_value_mg_dl,units)} ${unitLabel(units)}, next calibration due ${clock(ap.next_due)}`);
  if(r.action?.type==='BOLUS'&&ap.units!=null)extra.push(`delivered ${num(ap.units,3)} U${ap.delivery_minutes?` over ${num(ap.delivery_minutes,1)} min`:''}`);
  if(r.action?.type==='TEMP_BASAL'&&ap.rate_u_h!=null)extra.push(`temp ${num(ap.rate_u_h,3)} U/h${ap.percent!=null?` (${ap.percent}%)`:''} for ${ap.duration_minutes} min`);
  if(ap.suspended_until)extra.push(`suspended until ${clock(ap.suspended_until)}`);
  return `${a} applied${extra.length?`: ${extra.join(', ')}`:''}`;
}
export function actionArgs(a) {
  const ks=Object.keys(a).filter(k=>k!=='type');
  return ks.length?` ${ks.map(k=>`${k}=${a[k]}`).join(' ')}`:'';
}

// --- rolling messages and compaction ---------------------------------------------------------

/**
 * Provider-neutral message list for one request.
 * turns: [{turn, user:{content, tool_result_for?, is_error?}, assistant:{content, tool_call:{id,name,input}|null}}]
 * current: the new user message {content, tool_result_for?, is_error?}.
 * dayLog: [{turn, line}] compact lines (treatments, events, the model's notes) tagged with their turn.
 * Keeps the last `keep` turns verbatim; older turns are replaced by their day-log lines, prepended
 * to the first kept user message (which loses its tool-result link, as its tool call is gone).
 * Messages: {role:'user', content, tool_result_for?, is_error?} | {role:'assistant', content, tool_call}.
 */
export function buildMessages({turns,current,dayLog=[],keep=KEEP_TURNS,preamble=null}) {
  const first=Math.max(0,turns.length-keep),kept=turns.slice(first),msgs=[];
  for(const t of kept)msgs.push({role:'user',...t.user},{role:'assistant',...t.assistant});
  msgs.push({role:'user',...current});
  if(first>0) {
    const lines=dayLog.filter(l=>l.turn<turns[first].turn).map(l=>l.line);
    const head=`Day log of earlier turns (compressed; one line per treatment, event and note):\n${lines.join('\n')||'(nothing yet)'}\n\n--- recent turns follow ---\n`;
    const {tool_result_for,is_error,...m}=msgs[0];
    msgs[0]={...m,content:head+m.content};
  }
  // Memory preamble (multi-day summaries, notes): always at the top of the first message.
  if(preamble)msgs[0]={...msgs[0],content:`${preamble}\n\n--- current context ---\n${msgs[0].content}`};
  return msgs;
}
