// Agent options of the LLM controller (src/bench/controller.mjs), shared by the in-process bench
// harness (src/bench/harness.mjs) and the Harbor llm agent (src/benchmark/llm-agent.mjs). They are
// the independent variables of experiments 1d/1e/2a/2b/2c (docs/PLAN-v2.zh-CN.md) and are recorded
// with every episode (status.json, bundle.bench, agent status.json, trial.json agent_options).
//
//   history_hours          1..24 (default 3): reading history shown in each observation (exp 1d)
//   warmup_days            0..14 (default 0): days played by usual care before the scored period;
//                          their records go into the system prompt as a Nightscout-style summary
//                          and they are not scored (exp 1d/2b)
//   min_decision_minutes   5..240 (default 5): the agent is not woken earlier than this after a
//                          decision, except by urgent alarms (cgm_urgent_low, pump_occlusion_alarm)
//                          and measurement results (exp 1e)
//   max_decisions_per_day  null or 1..288: after this many decisions in an episode day only urgent
//                          alarms wake the agent until the next day (exp 1e)
//   memory                 'none' | 'notes' | 'notes+profile' (default 'none'): across days, none =
//                          each day starts fresh; notes = day summaries + a persistent notes board the
//                          model writes with `note_to_self`; notes+profile = notes + SET_PROFILE (exp 2a)
//   memory_mode            'rolling' | 'full' | 'none' (default 'rolling'): within-day context;
//                          rolling = last keep_turns turns verbatim plus a day log, full = every turn of
//                          the day verbatim, none = only the current observation (plus memory)
//   keep_turns             1..200 (default 12): verbatim turns in rolling mode
//   reasoning_effort       null | string (e.g. low/medium/high): passed to the model adapter (exp 2c)
//   samples                1..15 (default 1): model calls per decision; the action is chosen by
//                          majority action type, then the sample nearest the per-field medians (exp 2c)
//   simulate               false | true: offer a `simulate` what-if tool run on a private model with
//                          the person type's median parameters, never the hidden person (exp 2c)
//   simulate_calls         1..10 (default 3): simulate calls allowed per decision (per sample)
//   simulate_max_hours     1..12 (default 6): longest what-if horizon
//   fixed_interval_minutes 5..525600, multiple of 5 (default 60): fixed-slot spacing of the 'hourly'
//                          protocol (decision_schedule 'hourly'); the per-date extra cap does not scale
//   prompt_revision        explicit immutable prompt version; default current v4, legacy v3 supported
//   cross_day_memory       true | false (default true): false = an amnesic control for the learning ablation; at each
//                          episode-day boundary notes and lessons are cleared, no previous-day summaries are shown,
//                          the decision history and read_glucose_history only cover the current episode day
//   day_reflection         false | true (default false; needs memory notes): at each episode-day boundary one
//                          extra model call reviews the finished day's visible records and rewrites a
//                          persistent 'lessons' memory (<=2000 chars) shown in later days; no time passes,
//                          no action is executed (learning-over-time ablation)
import {CURRENT_PROMPT_REVISION,resolvePromptRevision} from './prompt-revisions.mjs';

export const AGENT_OPTIONS_VERSION='sweet-sim.agent-options/v1';
export const AGENT_OPTION_DEFAULTS=Object.freeze({history_hours:3,warmup_days:0,min_decision_minutes:5,max_decisions_per_day:null,
  memory:'none',memory_mode:'rolling',keep_turns:12,reasoning_effort:null,samples:1,simulate:false,simulate_calls:3,simulate_max_hours:6,
  decision_schedule:'event-driven',max_extra_decisions_per_day:6,fixed_interval_minutes:60,
  score_range_alerts:false,day_reflection:false,cross_day_memory:true,
  prompt_revision:CURRENT_PROMPT_REVISION});
export const MEMORY=['none','notes','notes+profile'];
export const MEMORY_MODES=['rolling','full','none'];
const INT_RANGES={history_hours:[1,24],warmup_days:[0,14],min_decision_minutes:[5,240],max_decisions_per_day:[1,288],keep_turns:[1,200],
  samples:[1,15],simulate_calls:[1,10],simulate_max_hours:[1,12],max_extra_decisions_per_day:[0,288],fixed_interval_minutes:[5,525600]};
// Dashed / camelCase spellings accepted on input.
const ALIASES={historyHours:'history_hours',warmupDays:'warmup_days',minDecisionMinutes:'min_decision_minutes',maxDecisionsPerDay:'max_decisions_per_day',
  memoryMode:'memory_mode',keepTurns:'keep_turns',reasoningEffort:'reasoning_effort',simulateCalls:'simulate_calls',simulateMaxHours:'simulate_max_hours',promptRevision:'prompt_revision',
  decisionSchedule:'decision_schedule',maxExtraDecisionsPerDay:'max_extra_decisions_per_day',fixedIntervalMinutes:'fixed_interval_minutes',scoreRangeAlerts:'score_range_alerts',dayReflection:'day_reflection',crossDayMemory:'cross_day_memory'};

/**
 * Normalizes agent options: an object, a JSON string or null. Unknown keys and out-of-range values
 * throw. Returns a frozen object with every key (defaults filled in).
 */
export function parseAgentOptions(input) {
  let o=input??{};
  if(typeof o==='string'){o=o.trim();o=o?JSON.parse(o):{};}
  if(typeof o!=='object'||Array.isArray(o))throw new Error('agent options must be a JSON object');
  const out={...AGENT_OPTION_DEFAULTS};
  for(const [k0,v] of Object.entries(o)) {
    const k=ALIASES[k0]??k0.replace(/-/g,'_');
    if(!(k in AGENT_OPTION_DEFAULTS))throw new Error(`unknown agent option ${k0}; known: ${Object.keys(AGENT_OPTION_DEFAULTS).join(', ')}`);
    if(v==null||v===''){out[k]=AGENT_OPTION_DEFAULTS[k];continue;}
    if(INT_RANGES[k]) {
      const n=Number(v),[lo,hi]=INT_RANGES[k];
      if(!Number.isInteger(n)||n<lo||n>hi)throw new Error(`agent option ${k} must be an integer in [${lo}, ${hi}] (got ${JSON.stringify(v)})`);
      out[k]=n;
    } else if(k==='memory'){if(!MEMORY.includes(v))throw new Error(`agent option memory must be one of ${MEMORY.join(', ')}`);out[k]=v;}
    else if(k==='memory_mode'){if(!MEMORY_MODES.includes(v))throw new Error(`agent option memory_mode must be one of ${MEMORY_MODES.join(', ')}`);out[k]=v;}
    else if(k==='simulate'){if(![true,false,'true','false'].includes(v))throw new Error('agent option simulate must be true or false');out[k]=v===true||v==='true';}
    else if(k==='cross_day_memory') {
      if(![true,false,'true','false'].includes(v))throw Error('agent option cross_day_memory must be true or false');
      out[k]=v===true||v==='true';
    }
    else if(k==='day_reflection') {
      if(![true,false,'true','false'].includes(v))throw Error('agent option day_reflection must be true or false');
      out[k]=v===true||v==='true';
    }
    else if(k==='score_range_alerts') {
      if(![true,false,'true','false'].includes(v))throw Error('agent option score_range_alerts must be true or false');
      out[k]=v===true||v==='true';
    }
    else if(k==='reasoning_effort'){if(typeof v!=='string'||!/^[a-z_-]{1,20}$/.test(v))throw new Error('agent option reasoning_effort must be a short string (e.g. low, medium, high)');out[k]=v;}
    else if(k==='prompt_revision')out[k]=resolvePromptRevision(v);
    else if(k==='decision_schedule') {
      if(!['event-driven','hourly'].includes(v))throw Error('decision_schedule must be event-driven or hourly');
      out[k]=v;
    }
  }
  if(out.decision_schedule==='hourly'&&(out.min_decision_minutes!==5||out.max_decisions_per_day!==null))
    throw Error('hourly scheduling cannot be combined with legacy decision gating');
  if(out.day_reflection&&out.memory==='none')throw Error('day_reflection needs memory notes');
  if(out.day_reflection&&!out.cross_day_memory)throw Error('day_reflection needs cross_day_memory');
  if(out.fixed_interval_minutes!==60&&(out.decision_schedule!=='hourly'||out.fixed_interval_minutes%5!==0))
    throw Error('fixed_interval_minutes needs decision_schedule hourly (fixed-slot protocol) and a multiple of 5');
  return Object.freeze(out);
}

/** Only the options that differ from the defaults (compact record for summaries and labels). */
export function nonDefaultOptions(opts) {
  return Object.fromEntries(Object.entries(opts).filter(([k,v])=>AGENT_OPTION_DEFAULTS[k]!==v));
}

/** Whether decision gating (minimum interval, daily cap) is active: urgent alarms then always wake. */
export const gatingActive=o=>o.min_decision_minutes>5||o.max_decisions_per_day!=null;

/**
 * Agent options from CLI flags (--agent-options JSON plus single flags such as --history-hours 12,
 * --min-decision-minutes 30, --max-decisions-per-day 48, --memory notes, --memory-mode full,
 * --warmup-days 3, --reasoning-effort high, --samples 5, --simulate, --simulate-calls 3).
 * Returns the raw (unnormalized) object or null when none were given.
 */
export function agentOptionsFromFlags(opt) {
  let o=null;
  if(opt['agent-options']&&opt['agent-options']!=='true'){o=JSON.parse(opt['agent-options']);if(!o||typeof o!=='object'||Array.isArray(o))throw new Error('--agent-options must be a JSON object');}
  for(const k of Object.keys(AGENT_OPTION_DEFAULTS)) {
    const flag=k.replace(/_/g,'-');
    if(opt[flag]!==undefined){o??={};o[k]=opt[flag];}
  }
  if(o)parseAgentOptions(o);      // validate early
  return o;
}
