// Step with hooks: apply one action, then keep the world running until either `wait_minutes`
// have passed or something the agent subscribed to happens. Hooks only fire on information the
// agent could really receive (patient reports, device alarms, new readings it gets, thresholds on
// real-time CGM readings) — never on hidden state.
//
//   a_t, wait, hooks  ──step──>  s_{t+1} (hidden), o_{t+1} = observation + what happened meanwhile
//
// Hook names (wake_on):
//   meal       patient reports a meal, or that it is high-fat (meal_announced, meal_composition_reported)
//   exercise   patient plans or starts announced exercise (exercise_planned, exercise_started)
//   life       alcohol / illness / poor-sleep reports     (alcohol_reported, illness_reported, poor_sleep_reported)
//   alarm      device alarms: CGM low/high, flash alarms, pump alarms, sensor replaced
//   reading    a new fingerstick or scan result arrives   (routine measurements by the patient)
//   injection  routine long-acting injection taken (pens)
//   patient    the person bolused or treated a low by themselves (self_care 'assisted')
//   below:X / above:X   a real-time CGM reading below/above X mg/dL (only with a real-time CGM)
const HOOK_TYPES={
  meal:t=>t==='meal_announced'||t==='meal_composition_reported'||t==='meal_record',
  exercise:t=>t==='exercise_started'||t==='exercise_planned'||t==='exercise_record',
  life:t=>['alcohol_reported','illness_reported','poor_sleep_reported','stress_reported','cycle_history_reported','daily_pattern_reported','life_record'].includes(t),
  alarm:t=>t.startsWith('cgm_')||t.startsWith('flash_alarm')||t.startsWith('pump_')||t.endsWith('_alarm')||t==='fault_record',
  reading:t=>t==='fingerstick'||t==='flash_scan',
  injection:t=>t==='basal_injection_taken',
  patient:t=>t==='patient_bolus'||t==='patient_treated_low',
};
export const HOOKS=[...Object.keys(HOOK_TYPES),'below:X','above:X'];
export const DEFAULT_HOOKS=['meal','exercise','life','alarm','reading','patient'];
export const MAX_WAIT_MINUTES=240;

/** Which hooks are meaningful for this observation's hardware (thresholds need a real-time CGM). */
export function availableHooks(obs) {
  return [...Object.keys(HOOK_TYPES),...(obs.cgm?['below','above']:[])];
}

/** Splits wake_on into event hook names and mg/dL thresholds; throws on unknown hooks. */
export function parseHooks(wakeOn) {
  const types=[],thresholds=[];
  for(const h of wakeOn??DEFAULT_HOOKS) {
    const m=/^(below|above):(\d+(?:\.\d+)?)$/.exec(h);
    if(m)thresholds.push({dir:m[1],mgdl:Number(m[2])});
    else if(HOOK_TYPES[h])types.push(h);
    else throw new Error(`Unknown hook ${h}; known: ${HOOKS.join(', ')}`);
  }
  return {types,thresholds};
}

/** Device alarms that always wake a gated agent (minimum decision interval / daily cap). */
export const URGENT_EVENTS=Object.freeze(['cgm_urgent_low','pump_occlusion_alarm']);
/** Hook name (from `types`) that a notice type triggers, or undefined. */
export const hookFor=(type,types)=>types.find(k=>HOOK_TYPES[k](type));

/**
 * Wake bookkeeping for one wait (shared by stepWithHooks and the LLM controller over HTTP).
 * Options: wake_on (hook names, thresholds in mg/dL), until (ms: timer end), lastReadingTime (ISO of
 * the reading already seen), and decision gating:
 *   minWakeAt (ms)   subscribed hooks firing earlier are held and wake the agent at minWakeAt
 *                    (wake_reason {..., deferred:true, fired_at}); urgent alarms are not held
 *   urgentOnly       only urgent alarms wake (daily decision cap reached)
 *   urgentAlways     urgent alarms wake even when not subscribed (gating active)
 * observe(o) after every step; wakeAfterAction(reason) after the action step; done(t) says whether to stop.
 */
export function wakeTracker({wake_on,until,lastReadingTime=null,minWakeAt=-Infinity,urgentOnly=false,urgentAlways=false}) {
  const {types,thresholds}=parseHooks(wake_on);
  const notices=[],readings=[];let lastReading=lastReadingTime,wake=null,deferred=null;
  const candidate=(c,t)=>{
    if(wake||urgentOnly)return;
    if(t<minWakeAt){deferred??={...c,deferred:true};return;}
    wake=c;
  };
  return {
    notices,readings,
    get wake(){return wake;},
    observe(o) {
      const t=Date.parse(o.virtual_time);
      for(const n of o.events) {
        notices.push(n);
        if(wake)continue;
        if((urgentAlways||urgentOnly)&&URGENT_EVENTS.includes(n.type)){wake={hook:'urgent',event:n.type,time:n.time};continue;}
        const h=hookFor(n.type,types);if(h)candidate({hook:h,event:n.type,time:n.time},t);
      }
      if(o.glucose&&o.glucose.time!==lastReading) {
        lastReading=o.glucose.time;readings.push({time:o.glucose.time,value_mg_dl:o.glucose.value_mg_dl,source:o.glucose.source});
        if(!wake&&o.glucose.source==='cgm')for(const th of thresholds)
          if(th.dir==='below'?o.glucose.value_mg_dl<th.mgdl:o.glucose.value_mg_dl>th.mgdl){candidate({hook:`${th.dir}:${th.mgdl}`,event:'cgm_reading',time:o.glucose.time},t);break;}
      }
      if(!wake&&deferred&&t>=minWakeAt)wake=deferred;
    },
    /** A wake right after the action (measurement result); suppressed when only urgent alarms may wake. */
    wakeAfterAction(reason){if(!wake&&reason&&!urgentOnly)wake=reason;},
    /** True when the wait is over at virtual time t (ms). */
    done(t,envDone){return !!wake||envDone||t>=until;},
  };
}

/**
 * One agent decision on a SimEnv: applies `action`, then advances with WAIT steps until
 * `wait_minutes` (5–240) elapse or a subscribed hook fires. Returns the next observation and
 * everything that happened in between (notices, visible readings, receipts).
 * Options for runners that need more control (the LLM bench harness):
 *   actionId(k)          id of the k-th env step (default `${idPrefix}-${step_count}`)
 *   waitRationale        rationale recorded on the WAIT steps
 *   onStep(res)          called after every env step with the step result
 *   wakeAfterAction(receipt)  returns a wake reason ({hook, ...}) to stop right after the action
 *                        (e.g. a measurement whose result the agent should see now), or null
 *   gate                 {minWakeMinutes, untilMs, urgentOnly, urgentAlways}: decision gating (wakeTracker)
 */
export function stepWithHooks(env,{action,rationale='',wait_minutes=30,wake_on,idPrefix='a',actionId=null,waitRationale='waiting',
  onStep=null,wakeAfterAction=null,gate=null}) {
  const wait=Math.max(5,Math.min(MAX_WAIT_MINUTES,Math.round(Number(wait_minutes)||5)));
  const t0=Date.parse(env.observe().virtual_time);
  const tr=wakeTracker({wake_on,until:gate?.untilMs??t0+wait*60000,lastReadingTime:env.observe().glucose?.time??null,
    minWakeAt:gate?.minWakeMinutes?t0+gate.minWakeMinutes*60000:-Infinity,urgentOnly:!!gate?.urgentOnly,urgentAlways:!!gate?.urgentAlways});
  let receipt=null,res,steps=0;
  const id=()=>actionId?actionId(steps):`${idPrefix}-${env.step_count}`;
  res=env.step({action_id:id(),expected_step:env.step_count,action:action??{type:'WAIT'},rationale});
  steps++;receipt=res.info.action_result;onStep?.(res);tr.observe(res.observation);
  if(wakeAfterAction&&!env.done())tr.wakeAfterAction(wakeAfterAction(receipt)??null);
  while(!tr.done(Date.parse(res.observation.virtual_time),env.done())) {
    res=env.step({action_id:id(),expected_step:env.step_count,action:{type:'WAIT'},rationale:waitRationale});
    steps++;onStep?.(res);tr.observe(res.observation);
  }
  const now=Date.parse(res.observation.virtual_time);
  return {observation:res.observation,receipt,elapsed_minutes:(now-t0)/60000,
    wake_reason:tr.wake??(env.done()?{hook:'end'}:{hook:'timer'}),notices:tr.notices,readings:tr.readings,
    terminated:res.terminated,truncated:res.truncated||env.done(),steps};
}
