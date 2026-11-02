// LLM controller: the decision loop shared by the in-process bench harness (src/bench/harness.mjs,
// a SimEnv) and the Harbor llm agent (src/benchmark/llm-agent.mjs, the task's HTTP API). One `act`
// tool call per decision, then the wait with wake hooks (src/env/hooks.mjs wakeTracker), plus the
// agent options of src/bench/agent-options.mjs:
//   history_hours            observation history window (records of everything the agent received)
//   min_decision_minutes /   decision gating: no wake before the minimum interval except urgent
//   max_decisions_per_day    alarms and measurement results; after the daily cap only urgent alarms
//   memory / memory_mode     multi-day: context reset per episode day, previous days as summaries,
//                            persistent notes (note_to_self), SET_PROFILE only with notes+profile;
//                            within a day rolling / full / none context
//   samples                  k model calls per decision, majority action type then the medoid
//   simulate                 what-if tool on a private median-person model (src/bench/simulate.mjs)
// Warm-up days are played before the controller starts (runWarmup) and summarized into the system
// prompt by the caller.
//
// The stepper abstracts the environment: {current() -> {observation, done}, step(action, rationale,
// {turn, k}) -> {observation, receipt, done}}; both may be async.
import {observationText,buildMessages,eventText,receiptText,actionArgs,clockOf,fmtG,unitLabel,toolSchema,simulateToolSchema,
  WAIT_MIN,WAIT_MAX} from './prompt.mjs';
import {completeWithRetry,costUsd,createModel} from './models/index.mjs';
import {extractJson} from './models/http.mjs';
import {wakeTracker} from '../env/hooks.mjs';
import {gatingActive} from './agent-options.mjs';
import {RecordBook} from './records.mjs';
import {simulateWhatIf} from './simulate.mjs';
import {patientPolicy} from '../policies/patient.mjs';
import {HourlySchedule} from './hourly-schedule.mjs';
import {scheduledPrompt} from './prompt.mjs';
import {memoryRevision,sharedObservationRevision} from './prompt-revisions.mjs';
import {hasGlucoseHistory,glucoseHistoryTool,readGlucoseHistory,glucoseHistoryAvailability,HISTORY_READ_LIMIT} from './glucose-history.mjs';

export const MEASUREMENTS=new Set(['MEASURE_BG','SCAN','CALIBRATE_CGM']);
const DEFAULT_WAIT=15,DAY=86400000;

/**
 * The episode's model with the per-trial adapter settings the options need: reasoning_effort
 * (openai-compatible reasoning_effort; anthropic output_config.effort) and, with the simulate tool,
 * a tool choice that lets the model pick simulate (forced-first-tool becomes "any tool"). Models
 * without an API adapter config (scripted, test fakes) are returned unchanged.
 */
export async function configureModel(model,opts) {
  const cfg=model.config;
  if(!cfg||!['anthropic','openai-compatible'].includes(cfg.adapter))return model;
  const patch={};
  if(opts.reasoning_effort&&cfg.reasoning_effort!==opts.reasoning_effort)patch.reasoning_effort=opts.reasoning_effort;
  if((opts.simulate||cfg.skill_context||hasGlucoseHistory(opts))&&cfg.adapter==='anthropic'&&(cfg.tool_choice??'tool')==='tool')patch.tool_choice='any';
  if((opts.simulate||cfg.skill_context||hasGlucoseHistory(opts))&&cfg.adapter==='openai-compatible'&&(cfg.tool_choice??'function')==='function')patch.tool_choice='required';
  return Object.keys(patch).length?createModel({...cfg,...patch}):model;
}

/** Fresh stats object (status.json `stats`). */
export function newStats() {
  return {env_steps:0,parse_errors:0,api_errors:0,api_retries:0,rejected_actions:0,agent_actions:0,measurements:0,
    waits_requested_minutes:0,input_tokens:0,output_tokens:0,latency_ms:0,cost_usd:0,wake_reasons:{},
    model_calls:0,decisions:0,simulate_calls:0,samples_discarded:0,notes_updates:0,profile_changes:0,decisions_by_day:[]};
}

/** Action types hidden from the agent by its options (SET_PROFILE unless memory notes+profile). */
export const hiddenActions=opts=>opts.memory==='notes+profile'?[]:['SET_PROFILE'];
/** The observation as the agent sees it under its options. */
const SHARED_KEYS=['virtual_time','local_time','elapsed_minutes','glucose','cgm','cgm_history','meter','iob','cob','insulin','device','reported_carbs','profile'];
/** v6-shared-observation: exact public observation fields as JSON after the rounded summary. */
export function sharedObservationBlock(view) {
  const json={version:'sweet-sim.shared-observation/v1'};
  for(const k of SHARED_KEYS)if(Object.hasOwn(view,k))json[k]=view[k];
  return '\n\n## Shared sensor and treatment records\n'
    +'Exact public records; glucose values are sensor/meter readings with their existing errors, lag and gaps, NOT physiological truth. Numeric glucose uses mg/dL; insulin uses U; carbohydrate uses g.\n'
    +'IOB/COB and delivery logs use available records only, not true tissue delivery or hidden intake. Missing records and zero estimates do not establish absence of insulin or carbohydrate. This JSON is authoritative over rounded display summaries.\n'
    +'```json\n'+JSON.stringify(json)+'\n```';
}

export function agentView(obs,opts) {
  const hide=hiddenActions(opts).filter(t=>obs.action_specs?.[t]);
  if(!hide.length)return obs;
  const action_specs={...obs.action_specs};for(const t of hide)delete action_specs[t];
  return {...obs,action_specs,available_actions:(obs.available_actions??[]).filter(t=>!hide.includes(t))};
}

/**
 * Model reply -> {action, wait_minutes, note, note_to_self?, wake_on?, wake_on_mgdl?} or {error}.
 * Accepts the `act` tool call or a JSON object in the text. validate(action) throws on invalid
 * actions; parseWakeOn(wake_on, {obs, units}) validates hooks. minWait raises wait_minutes.
 */
export function parseActReply(res,{validate,parseWakeOn,obs,units='mmol',minWait=WAIT_MIN,hidden=[],hourly=false,interval=60}) {
  let input;
  if(res.tool_call) {
    if(res.tool_call.name!=='act')return {error:`Unknown tool "${res.tool_call.name}"; the only tool is act`};
    input=res.tool_call.input;
    if(input==null||typeof input!=='object')return {error:'act arguments are not a JSON object'};
  } else {
    input=extractJson(res.text);
    if(!input)return {error:'No act tool call and no JSON object found in the reply'};
  }
  if(input.act&&typeof input.act==='object')input=input.act;
  let action=input.action;
  if(action==null&&typeof input.type==='string') {           // bare action with wait/note mixed in
    const {wait_minutes,note,wake_on,note_to_self,...a}=input;action=a;
  }
  if(typeof action==='string')action={type:action};
  if(!action||typeof action!=='object'||Array.isArray(action))return {error:'Missing "action" object (e.g. {"type":"WAIT"})'};
  if(typeof action.type==='string')action={...action,type:action.type.trim().toUpperCase()};
  if(hidden.includes(action.type))return {error:`Invalid action: ${action.type} is not available in this setup`};
  try{validate(action);}catch(e){return {error:`Invalid action: ${e.message}`};}
  let wait=input.wait_minutes;
  if(wait==null||wait==='')wait=Math.max(hourly?interval:DEFAULT_WAIT,minWait);
  wait=Number(wait);
  if(!Number.isFinite(wait))return {error:`wait_minutes must be a number between ${minWait} and ${WAIT_MAX}`};
  wait=Math.min(WAIT_MAX,Math.max(minWait,Math.round(wait)));
  const note=typeof input.note==='string'?input.note.slice(0,500):input.note==null?'':String(input.note).slice(0,500);
  const out={action,wait_minutes:wait,note};
  if(typeof input.note_to_self==='string')out.note_to_self=input.note_to_self.slice(0,2000);
  if(input.wake_on==null)return out;
  const w=parseWakeOn(input.wake_on,{obs,units});
  if(w.error)return {error:w.error};
  return {...out,...w};
}

/** Text and stats key of a wake reason. */
export function wakeText(w,{units,clock,capped=false}) {
  if(w.hook==='timer')return capped?['daily decision limit reached; slept until the next day','cap_sleep']:['wait elapsed','wait_elapsed'];
  if(w.hook==='end')return ['episode end','episode_end'];
  if(w.hook==='measurement')return ['measurement result','measurement_result'];
  if(w.hook==='urgent')return [`URGENT alarm: ${w.event} at ${clock(w.time)}`,`urgent:${w.event}`];
  const held=w.deferred?` at ${clock(w.time)}; held until your minimum decision interval had passed`:'';
  const m=/^(below|above):(.+)$/.exec(w.hook);
  if(m)return [`CGM reading ${m[1]} ${fmtG(Number(m[2]),units)} ${unitLabel(units)} at ${clock(w.time)} (wake_on ${m[1]}:${fmtG(Number(m[2]),units)})${w.deferred?'; held until your minimum decision interval had passed':''}`,
    `${w.deferred?'deferred':'hook'}:${m[1]}`];
  return [`event: ${w.event} (wake_on ${w.hook})${held}`,`${w.deferred?'deferred':'hook'}:${w.hook}`];
}

/** Majority action type, then the sample nearest the per-field medians (ties: earliest). Returns {index, votes}. */
export function aggregateSamples(parsed) {
  const votes={};parsed.forEach(p=>{votes[p.action.type]=(votes[p.action.type]??0)+1;});
  const best=Math.max(...Object.values(votes)),type=parsed.find(p=>votes[p.action.type]===best).action.type;
  const group=parsed.map((p,i)=>({p,i})).filter(x=>x.p.action.type===type);
  const keys=[...new Set(group.flatMap(x=>Object.keys(x.p.action).filter(k=>typeof x.p.action[k]==='number')))];
  const median=a=>{const s=[...a].sort((x,y)=>x-y),n=s.length;return n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2;};
  const med=Object.fromEntries(keys.map(k=>[k,median(group.map(x=>x.p.action[k]).filter(Number.isFinite))]));
  const medWait=median(group.map(x=>x.p.wait_minutes));
  const dist=x=>keys.reduce((s,k)=>s+(Number.isFinite(x.p.action[k])?Math.abs(x.p.action[k]-med[k])/Math.max(Math.abs(med[k]),1e-6):1),0)
    +0.1*Math.abs(x.p.wait_minutes-medWait)/Math.max(medWait,1);
  let chosen=group[0];for(const x of group)if(dist(x)<dist(chosen)-1e-12)chosen=x;
  return {index:chosen.i,votes};
}

/**
 * Plays warm-up days before the scored period with the usual-care player: the patient baseline
 * (src/policies/patient.mjs) in full care, no action in assisted care (the person self-manages).
 * Steps the stepper until virtual time >= untilMs; records go into `records`. Returns {steps, cur}.
 */
export async function runWarmup(stepper,{untilMs,selfCare='none',records,onStep}) {
  const policy=selfCare==='assisted'?()=>({action:{type:'WAIT'},rationale:'warm-up: person self-manages'}):patientPolicy();
  let cur=await stepper.current(),steps=0;
  records.observe(cur.observation);
  while(!cur.done&&Date.parse(cur.observation.virtual_time)<untilMs) {
    const d=policy(cur.observation);
    const r=await stepper.step(d.action,`warm-up (usual care): ${String(d.rationale??'').slice(0,300)}`,{warmup:true,k:steps});
    steps++;records.observe(r.observation);onStep?.(r);
    if(d.action.type!=='WAIT'&&r.receipt?.status==='applied')records.addAction(cur.observation.virtual_time,`${d.action.type}${actionArgs(d.action)}`,'usual care');
    cur={observation:r.observation,done:r.done};
  }
  return {steps,cur};
}

/**
 * Runs the controller to the horizon or until it gives up. Arguments:
 *   stepper, model, system (full system prompt), opts (normalized agent options), units,
 *   validate(action), parseWakeOn, desc (public description, for simulate), records (RecordBook,
 *   may hold warm-up records), scoredStart (ms, start of the scored period), horizonMinutes (scored),
 *   maxTurns, maxConsecutiveErrors, retry, writeLine(line), stats (newStats()).
 * Returns {stopKind: null | 'api' | 'format' | 'max_turns', error, errorObj, turns}.
 */
export async function runController({stepper,model,system,opts,units='mmol',validate,parseWakeOn,desc=null,records=null,skillContext=null,
  scoredStart,horizonMinutes,scoringVersion='METRICS-v0.3',maxTurns=200,maxConsecutiveErrors=3,retry={},writeLine,stats}) {
  system=scheduledPrompt(system,opts);
  let cur=await stepper.current();
  const obs0=cur.observation;
  records??=RecordBook.fromObservation(obs0);
  records.observe(obs0);
  const notesOn=opts.memory!=='none',hidden=hiddenActions(opts),gating=gatingActive(opts);
  const days=Math.max(1,Math.ceil(horizonMinutes/1440));
  const view0=agentView(obs0,opts);
  const historyOn=hasGlucoseHistory(opts);
  const hourly=opts.decision_schedule==='hourly'?new HourlySchedule({start:scoredStart,end:scoredStart+horizonMinutes*60000,
    offsetMs:records.offsetMs,extraLimit:opts.max_extra_decisions_per_day,intervalMinutes:opts.fixed_interval_minutes??60}):null;
  const tools=[toolSchema(view0,{units,minWait:opts.min_decision_minutes,notes:notesOn,cap:opts.max_decisions_per_day,
    hourly:!!hourly,extraLimit:opts.max_extra_decisions_per_day,interval:opts.fixed_interval_minutes??60}),
    ...(skillContext?[skillContext.tool]:[]),
    ...(historyOn?[glucoseHistoryTool]:[]),
    ...(opts.simulate?[simulateToolSchema(view0,{maxHours:opts.simulate_max_hours,calls:opts.simulate_calls})]:[])];
  const keep=opts.memory_mode==='full'?Infinity:opts.keep_turns;
  const memoryOnce=memoryRevision(opts.prompt_revision);
  let turns=[],dayLog=[],treatments=[],notes='',daySummaries=[],lessons='';
  let pending=[...obs0.events],receipt=null,wake=null,errorMsg=null,prevCallId=null,consecutive=0,turn=0;
  let dayIndex=Math.max(0,Math.floor((Date.parse(obs0.virtual_time)-scoredStart)/DAY)),decisionsToday=0;
  const endMs=scoredStart+horizonMinutes*60000;

  const preambleText=()=>{
    if(!notesOn)return null;
    const parts=[];
    if(daySummaries.length)parts.push(`## Previous days (what your devices recorded)\n${daySummaries.join('\n')}`);
    if(opts.day_reflection)parts.push(`## Lessons from your end-of-day reviews\n${lessons||'(none yet)'}`);
    parts.push(`## Your notes (note_to_self)\n${notes||'(empty)'}`);
    return parts.join('\n\n');
  };

  /**
   * day_reflection: one model call after an episode day ends. It sees only what the agent could see
   * (device-recorded day summary, its own decisions, notes, previous lessons) and rewrites `lessons`.
   * No simulated time passes and nothing is executed. Failures keep the previous lessons.
   */
  async function reflect(k,obs) {
    const from=scoredStart+k*DAY,to=from+DAY;
    const own=records.ownActions(from,to).filter(a=>!/^WAIT\b/.test(a.text)).map(a=>`- ${records.hm(a.t)} ${a.text}`);
    const content=[`## End-of-day review: day ${k+1} of ${days} has ended`,
      'No simulated time passes during this review and no treatment is executed. Use only what you observed; do not assume hidden events, records or future schedules you were not shown.',
      '',daySummaries.at(-1)??records.dayLines(from,to,{units,label:`Day ${k+1}`}).join('\n'),
      '',`### Your non-WAIT actions on day ${k+1}`,own.length?own.join('\n'):'(none)',
      '',`### Your notes (note_to_self)`,notes||'(empty)',
      '',`### Your previous lessons`,lessons||'(none yet)',
      '','Rewrite your lessons (at most 2000 characters) so they help you on the remaining days: recurring times and sizes of glucose rises and falls you observed, '
      +'how your treatments worked out (too much, too little, too late), and concrete rules you will follow tomorrow. Keep what still holds, correct what did not. '
      +'Call record_lessons exactly once.'].join('\n');
    const tool={name:'record_lessons',description:'Store your rewritten lessons (replaces the previous lessons). No treatment is executed.',
      input_schema:{type:'object',properties:{lessons:{type:'string',description:'Lessons for the remaining days, at most 2000 characters'}},required:['lessons'],additionalProperties:false}};
    const line={turn,reflection:{day:k+1}};
    try {
      const res=await completeWithRetry(model,{system,messages:[{role:'user',content}],tools:[tool],obs},
        {...retry,onRetry:(e)=>{stats.api_retries++;retry.onRetry?.(e);}});
      stats.model_calls++;
      const usage=res.usage??{input_tokens:0,output_tokens:0};
      stats.input_tokens+=usage.input_tokens??0;stats.output_tokens+=usage.output_tokens??0;stats.latency_ms+=res.latency_ms??0;
      stats.cost_usd+=costUsd(model.config,usage);
      const text=res.tool_call?.name==='record_lessons'?res.tool_call.input?.lessons:null;
      if(typeof text==='string'&&text.trim()){lessons=text.slice(0,2000);stats.reflections=(stats.reflections??0)+1;}
      else stats.reflection_errors=(stats.reflection_errors??0)+1;
      writeLine({...line,reflection:{day:k+1,prompt:content,lessons:typeof text==='string'?text.slice(0,2000):null,usage}});
    } catch(e) {
      stats.reflection_errors=(stats.reflection_errors??0)+1;
      writeLine({...line,reflection:{day:k+1,prompt:content,error:String(e?.message??e).slice(0,500)}});
    }
  }

  /** One sample: model call(s), with simulate tool calls answered in between. */
  async function sample(baseMessages,obsForModel,view) {
    const msgs=[...baseMessages],calls=[],sims=[],skillReads=[],historyReads=[];let simUsed=0;
    for(;;) {
      let res;
      try {
        const offered=tools.filter(t=>(!skillContext||skillReads.length<skillContext.maxReads||t.name!==skillContext.tool.name)
          &&(!historyOn||historyReads.length<HISTORY_READ_LIMIT||t.name!==glucoseHistoryTool.name));
        res=await completeWithRetry(model,{system,messages:msgs,tools:offered,obs:obsForModel},
          {...retry,onRetry:(e)=>{stats.api_retries++;retry.onRetry?.(e);}});
      } catch(e){
        if(model.config?.tool_contract_repair===true&&e.code==='TOOL_CONTRACT'&&e.repair_result)
          res={...e.repair_result,attempts:e.attempts??1};
        else return {apiError:e,calls,sims,historyReads};
      }
      stats.model_calls++;
      if(res.replay?.historical_transport_errors?.length) {
        stats.replayed_api_retries=(stats.replayed_api_retries??0)+res.replay.historical_transport_errors.length;
        stats.api_retries+=res.replay.historical_transport_errors.length;
      }
      const usage=res.usage??{input_tokens:0,output_tokens:0};
      stats.input_tokens+=usage.input_tokens??0;stats.output_tokens+=usage.output_tokens??0;stats.latency_ms+=res.latency_ms??0;
      const cost=costUsd(model.config,usage);stats.cost_usd+=cost;
      calls.push({usage,latency_ms:res.latency_ms??null,attempts:res.attempts??1,cost_usd:cost});
      if(res.contract_error)return {res,calls,sims,skillReads,historyReads,parsed:{error:res.contract_error}};
      if(historyOn&&res.tool_call?.name===glucoseHistoryTool.name) {
        if(historyReads.length>=HISTORY_READ_LIMIT)return {res,calls,sims,skillReads,historyReads,parsed:{error:'History read budget exhausted; use act'}};
        const id=res.tool_call.id??`history_${turn}_${historyReads.length}`;
        let out;
        try{if(res.tool_validation_error)throw Error(res.tool_validation_error);out=readGlucoseHistory(records,res.tool_call.input,{now:Date.parse(obsForModel.virtual_time),units,from:opts.cross_day_memory?-Infinity:scoredStart+dayIndex*DAY});}
        catch(e){out={ok:false,error:e.message};}
        historyReads.push({input:res.tool_call.input,result:out});stats.history_reads=(stats.history_reads??0)+1;
        msgs.push({role:'assistant',content:res.text??'',tool_call:{id,name:glucoseHistoryTool.name,input:res.tool_call.input},
          ...(res.provider?{provider:res.provider}:{})},{role:'user',content:JSON.stringify(out),tool_result_for:id,...(out.ok?{}:{is_error:true})});
        continue;
      }
      if(skillContext&&res.tool_call?.name===skillContext.tool.name) {
        if(skillReads.length>=skillContext.maxReads)return {res,calls,sims,skillReads,historyReads,parsed:{error:'Reference read budget exhausted; use act'}};
        const id=res.tool_call.id??`skill_${turn}_${skillReads.length}`;let out;
        try{out={ok:true,...skillContext.read(res.tool_call.input)};}catch(e){out={ok:false,error:e.message};}
        skillReads.push({input:res.tool_call.input,result:out});stats.skill_reads=(stats.skill_reads??0)+1;
        msgs.push({role:'assistant',content:res.text??'',tool_call:{id,name:skillContext.tool.name,input:res.tool_call.input},
          ...(res.provider?{provider:res.provider}:{})},{role:'user',content:JSON.stringify(out),tool_result_for:id,...(out.ok?{}:{is_error:true})});
        continue;
      }
      if(opts.simulate&&res.tool_call?.name==='simulate') {
        const id=res.tool_call.id??`sim_${turn}_${simUsed}`,input=res.tool_call.input??{};
        let out;
        if(simUsed>=opts.simulate_calls)return {res,calls,sims,skillReads,historyReads,parsed:{error:`simulate budget of ${opts.simulate_calls} call(s) per decision exhausted; call act`}};
        simUsed++;stats.simulate_calls++;
        let action=input.action;
        if(typeof action==='string')action={type:action};
        if(action&&typeof action.type==='string')action={...action,type:action.type.trim().toUpperCase()};
        try {
          if(res.tool_validation_error)throw Error(res.tool_validation_error);
          if(!action||typeof action!=='object')throw new Error('simulate needs an action object');
          if(hidden.includes(action.type))throw new Error(`${action.type} is not available in this setup`);
          validate(action);
          const hours=Math.min(opts.simulate_max_hours,Math.max(1,Math.round(Number(input.hours??4))||4));
          const extra=Math.min(150,Math.max(0,Number(input.extra_carbs_g??0)||0));
          out=simulateWhatIf({desc,obs:view,records,action,hours,extra_carbs_g:extra,units});
        } catch(e){out={ok:false,text:`simulate: invalid request: ${e.message}`};}
        const left=opts.simulate_calls-simUsed;
        const text=`${out.text}\n(${left} simulate call(s) left for this decision${left?'':'; now call act'})`;
        sims.push({input:res.tool_call.input,ok:out.ok,text:out.text,result:out.result??null});
        msgs.push({role:'assistant',content:res.text??'',tool_call:{id,name:'simulate',input:res.tool_call.input},...(res.provider?{provider:res.provider}:{})},
          {role:'user',content:text,tool_result_for:id,...(out.ok?{}:{is_error:true})});
        continue;
      }
      const parsed=parseActReply(res,{validate,parseWakeOn,obs:view,units,minWait:opts.min_decision_minutes,hidden,hourly:!!hourly,interval:opts.fixed_interval_minutes??60});
      return {res,calls,sims,skillReads,historyReads,parsed};
    }
  }

  let stop=null;
  while(!cur.done) {
    if(turn>=maxTurns){stop={stopKind:'max_turns',error:`reached max turns ${maxTurns} before the horizon`};break;}
    const obs=cur.observation,clock=clockOf(obs),t=Date.parse(obs.virtual_time);
    const day=Math.max(0,Math.floor((t-scoredStart)/DAY));
    if(day>dayIndex) {
      // New episode day: summarize the finished day(s) and reset the conversation.
      // Amnesic control: nothing the agent wrote or saw on earlier days survives the day boundary.
      if(!opts.cross_day_memory){notes='';lessons='';}
      else if(notesOn)for(let k=dayIndex;k<day;k++) {
        daySummaries.push(records.dayLines(scoredStart+k*DAY,scoredStart+(k+1)*DAY,{units,label:`Day ${k+1} (${records.date(scoredStart+k*DAY)})`}).join('\n'));
        if(opts.day_reflection)await reflect(k,obs);
      }
      turns=[];dayLog=[];prevCallId=null;dayIndex=day;decisionsToday=0;
    }
    const view=agentView(obs,opts),obsForModel={...view,events:pending};
    const cap=opts.max_decisions_per_day;
    const decisionNote=hourly?hourly.context(t):gating?`Decision limits: next call no earlier than ${opts.min_decision_minutes} min after this decision (urgent alarms excepted)`
      +(cap!=null?`; decisions today: ${decisionsToday} of ${cap} used${decisionsToday+1>=cap?' (this is your LAST decision today unless an urgent alarm wakes you)':''}`:''):null;
    const observation=observationText(obsForModel,{units,readings:records.spotReadings(),events:pending,treatments,receipt,wake_reason:wake,error:errorMsg,
      horizon_minutes:horizonMinutes,elapsed_minutes:(t-scoredStart)/60000,history_hours:opts.history_hours,
      series:records.series(t-opts.history_hours*3600000,t+1),day_label:days>1?`day ${day+1} of ${days}`:null,decision_note:decisionNote,
      score_range_alerts:opts.score_range_alerts,scoring_version:scoringVersion});
    const memoryFrom=opts.cross_day_memory?-Infinity:scoredStart+dayIndex*DAY;
    const history=historyOn?glucoseHistoryAvailability(records,{now:t,from:memoryFrom}):null;
    const historyNotice=history?`\nPast glucose records available via read_glucose_history: ${history.count} observed readings${history.from?`, ${history.from} to ${history.until}`:''}.`:'';
    const shared=sharedObservationRevision(opts.prompt_revision)?sharedObservationBlock(view):'';
    const text=observation+shared+historyNotice+(hourly?'\n\n'+records.decisionHistoryText(memoryFrom):'');
    for(const e of pending)dayLog.push({turn,line:`- ${eventText(e,{units,clock})}`});
    const current={content:text,...(prevCallId?{tool_result_for:prevCallId,...(errorMsg?{is_error:true}:{})}:{})};
    const messages=opts.memory_mode==='none'?[{role:'user',content:current.content}]
      :buildMessages({turns,current,dayLog,keep});
    const pre=preambleText();
    if(pre)messages[0]={...messages[0],content:`${pre}\n\n--- current context ---\n${messages[0].content}`};
    const base={turn,sim_time:obs.virtual_time,local_time:obs.local_time,day:day+1,...(turn===0?{system,tools}:{}),observation_text:text};

    // k samples per decision; the first API failure ends control as before.
    const results=[];let apiError=null;
    for(let s=0;s<opts.samples;s++) {
      const r=await sample(messages,obsForModel,view);
      results.push(r);
      if(r.apiError){apiError=r.apiError;break;}
    }
    if(apiError) {
      stats.api_errors++;
      writeLine({...base,request_tokens:null,response_raw:null,parsed:null,parse_error:null,api_error:String(apiError.message).slice(0,1000),
        api_error_status:apiError.status??null,attempts:apiError.attempts??null,receipt:null,latency_ms:null,usage:null,wake_reason:null});
      stop={stopKind:'api',error:String(apiError.message).slice(0,1000),errorObj:apiError};break;
    }
    const valid=results.map((r,i)=>({r,i})).filter(x=>!x.r.parsed.error);
    let pick=0,votes=null;
    if(opts.samples>1&&valid.length) {
      const ag=aggregateSamples(valid.map(x=>x.r.parsed));pick=valid[ag.index].i;votes=ag.votes;
      stats.samples_discarded+=results.length-valid.length;
    } else if(valid.length)pick=valid[0].i;
    const chosen=results[pick],res=chosen.res,p=chosen.parsed;
    const usage=results.flatMap(r=>r.calls).reduce((a,c)=>({input_tokens:a.input_tokens+(c.usage.input_tokens??0),output_tokens:a.output_tokens+(c.usage.output_tokens??0)}),{input_tokens:0,output_tokens:0});
    const latency=results.flatMap(r=>r.calls).reduce((a,c)=>a+(c.latency_ms??0),0);
    const callId=res.tool_call?(res.tool_call.id??`call_${turn}`):null;
    // The latest request still gets every own receipt, but old copies need not be replayed.
    turns.push({turn,user:memoryOnce?{...current,content:observation}:current,assistant:{content:res.text??'',tool_call:res.tool_call?{id:callId,name:res.tool_call.name,input:res.tool_call.input}:null,
      ...(res.provider?{provider:res.provider}:{})}});
    prevCallId=callId;
    const lineBase={...base,request_tokens:usage.input_tokens,response_raw:res.raw??null,response_text:res.text??'',tool_call:res.tool_call??null,
      latency_ms:latency,usage,attempts:chosen.calls.at(-1)?.attempts??1,model_calls:results.reduce((a,r)=>a+r.calls.length,0),
      cost_usd:results.flatMap(r=>r.calls).reduce((a,c)=>a+c.cost_usd,0),
      ...(chosen.sims.length?{simulate:chosen.sims}:{}),
      ...(chosen.skillReads?.length?{skill_reads:chosen.skillReads}:{}),
      ...(chosen.historyReads?.length?{history_reads:chosen.historyReads}:{}),
      ...(opts.samples>1?{samples:results.map(r=>({parsed:r.parsed.error?null:{action:r.parsed.action,wait_minutes:r.parsed.wait_minutes},error:r.parsed.error??null,
        simulate_calls:r.sims.length})),chosen_sample:pick,votes}:{})};

    if(p.error) {
      stats.parse_errors++;consecutive++;
      receipt={parse_error:p.error};wake='your previous reply was invalid';
      errorMsg=`${p.error}. Nothing was applied and time did not advance. Reply with one act tool call (${maxConsecutiveErrors-consecutive} attempt(s) left before you lose control of the day).`;
      dayLog.push({turn,line:`${clock(obs.virtual_time)} invalid reply: ${p.error}`});
      writeLine({...lineBase,parsed:null,parse_error:p.error,receipt:null,wake_reason:null,waited_minutes:0,env_steps:0});
      turn++;
      if(consecutive>=maxConsecutiveErrors){stop={stopKind:'format',error:`${consecutive} consecutive invalid replies; last: ${p.error}`.slice(0,1000)};break;}
      continue;                                   // pending events stay pending
    }
    consecutive=0;errorMsg=null;
    const {action,wait_minutes,note,wake_on,wake_on_mgdl}=p;
    if(p.note_to_self!=null&&notesOn&&p.note_to_self!==notes){notes=p.note_to_self;stats.notes_updates++;}
    stats.decisions++;decisionsToday++;
    const decisionKind=hourly?.begin(t);
    if(hourly){stats.fixed_decisions=hourly.fixed;stats.extra_decisions_by_local_day={...hourly.extras};}
    (stats.decisions_by_day[day]??=0);stats.decisions_by_day[day]++;
    stats.waits_requested_minutes+=wait_minutes;
    if(action.type!=='WAIT')stats.agent_actions++;
    if(MEASUREMENTS.has(action.type))stats.measurements++;

    // Apply, then wait with the hook semantics and the decision gating.
    const capped=cap!=null&&decisionsToday>=cap;
    const nextDay=Math.min(endMs,scoredStart+(day+1)*DAY);
    const hourlyWindow=hourly?.window(t,wait_minutes);
    const tr=wakeTracker({wake_on:hourly?(wake_on_mgdl??[]):wake_on_mgdl,until:hourlyWindow?.fixed??(capped?Math.max(nextDay,t+wait_minutes*60000):t+wait_minutes*60000),
      lastReadingTime:obs.glucose?.time??null,minWakeAt:gating?t+opts.min_decision_minutes*60000:-Infinity,urgentOnly:capped,urgentAlways:gating});
    let r=await stepper.step(action,note,{turn,k:0}),steps=1;
    const rec={...r.receipt,action};
    records.observe(r.observation);tr.observe(r.observation);
    if(MEASUREMENTS.has(action.type)&&rec.status==='applied'&&!r.done)tr.wakeAfterAction({hook:'measurement'});
    while(hourly?!r.done&&!hourly.due(Date.parse(r.observation.virtual_time),hourlyWindow,!!tr.wake)
      :!tr.done(Date.parse(r.observation.virtual_time),r.done)) {
      r=await stepper.step({type:'WAIT'},`waiting (turn ${turn}, up to ${wait_minutes} min)`,{turn,k:steps});
      steps++;records.observe(r.observation);tr.observe(r.observation);
    }
    if(rec.status==='rejected')stats.rejected_actions++;
    if(action.type==='SET_PROFILE'&&rec.status==='applied')stats.profile_changes++;
    stats.env_steps+=steps;
    const w=hourly?(r.done?{hook:'end'}:Date.parse(r.observation.virtual_time)>=hourlyWindow.fixed-1e-6
      ?{hook:'timer'}:tr.wake??{hook:'timer'}):tr.wake??(r.done?{hook:'end'}:{hook:'timer'});
    const [wakeReason,wkey]=wakeText(w,{units,clock,capped});
    stats.wake_reasons[wkey]=(stats.wake_reasons[wkey]??0)+1;
    const at=rec.at??obs.virtual_time;
    if(hourly)records.addDecision(at,{action,receipt:rec,note,kind:decisionKind,wait_minutes});
    if(action.type!=='WAIT') {
      const text=receiptText(rec,{units,clock});
      treatments.push({time:at,text});
      if(rec.status==='applied')records.addAction(at,text,'agent',rec);
    }
    dayLog.push({turn,line:`${clock(at)} you: ${receiptText(rec,{units,clock})}; wait ${wait_minutes} min${wake_on?` (wake_on ${wake_on.join(', ')||'none'})`:''}${note?` — ${note.slice(0,200)}`:''}`});
    const waited=(Date.parse(r.observation.virtual_time)-t)/60000;
    writeLine({...lineBase,parsed:{action,wait_minutes,note,...(wake_on?{wake_on}:{}),...(p.note_to_self!=null?{note_to_self:p.note_to_self}:{})},parse_error:null,receipt:rec,
      wake_reason:wakeReason,wake:w,waited_minutes:waited,env_steps:steps,...(gating?{decisions_today:decisionsToday,capped}:{}),
      ...(hourly?{decision_kind:decisionKind,extra_decisions_by_local_day:{...hourly.extras},next_fixed_decision:hourlyWindow.fixed}:{})});
    pending=tr.notices;receipt=rec;wake=wakeReason;turn++;
    cur={observation:r.observation,done:r.done};
  }
  stats.notes=notesOn?notes:undefined;
  stats.day_summaries=notesOn?daySummaries.length:undefined;
  if(opts.day_reflection)stats.lessons=lessons;
  return {...(stop??{stopKind:null}),turns:turn};
}
