// Multi-day LLM episodes (experiment 2, src/bench/controller.mjs) with canned models (no API):
// per-day context reset with day summaries, the persistent notes board (note_to_self) injected at
// the start of each day, memory none / notes / notes+profile (SET_PROFILE only with notes+profile),
// and the within-day context modes rolling / full / none.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {KNOWLEDGE as K} from '../src/knowledge.mjs';
import {runEpisode} from '../src/bench/harness.mjs';

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'llm-multiday-'));
test.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
const inst=(preset,seed=11,extra={})=>{
  const s=K.instances[preset].spec;
  return {id:`${preset}-s${seed}`,spec:{...s,seed,person:s.person?{...s.person,sample:true}:s.person,...extra}};
};
const readLines=f=>fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const readJson=f=>JSON.parse(fs.readFileSync(f,'utf8'));
function fnModel(fn) {
  const requests=[];let i=0;
  return {name:'fn',adapter:'test',config:{},requests,
    async complete(req) {
      requests.push(structuredClone({system:req.system,messages:req.messages,tools:req.tools,time:req.obs.virtual_time}));
      return {tool_call:{id:`tu_${i}`,name:'act',input:fn(req,i++)},text:'',usage:{input_tokens:10,output_tokens:5},latency_ms:1};
    }};
}
const WAIT=(extra={})=>({action:{type:'WAIT'},wait_minutes:240,note:'w',...extra});
const DAY=86400000;
const actionTypes=tools=>tools[0].input_schema.properties.action.oneOf.map(v=>v.properties.type.const);

test('memory notes: day summaries and notes injected at the start of each day; conversation reset per day',async()=>{
  const out=path.join(tmp,'notes');
  const m=fnModel((req,i)=>WAIT(i===0?{note_to_self:'basal looks high; carb ratio ok'}:{}));
  await runEpisode({instance:inst('adult_dana_g6'),model:m,outDir:out,hours:48,agentOptions:{memory:'notes'}});
  const lines=readLines(path.join(out,'transcript.jsonl')),st=readJson(path.join(out,'status.json'));
  const t0=Date.parse(lines[0].sim_time);
  assert.match(lines[0].system,/next 2 days of simulated time/);
  assert.match(lines[0].system,/## Multiple days[\s\S]*The episode lasts 2 days[\s\S]*note_to_self/);
  assert.ok(lines[0].tools[0].input_schema.properties.note_to_self,'act offers note_to_self');
  assert.match(lines[0].observation_text,/^Time 00:00 day 1 of 2/);
  // Day 1: notes board in every request (empty first, then the note), no previous days yet.
  assert.match(m.requests[0].messages[0].content,/## Your notes \(note_to_self\)\n\(empty\)/);
  assert.match(m.requests[1].messages[0].content,/## Your notes \(note_to_self\)\nbasal looks high; carb ratio ok/);
  assert.doesNotMatch(m.requests[1].messages[0].content,/Previous days/);
  // Day 2: a fresh conversation that starts with the day-1 summary and the notes.
  const d2=m.requests.findIndex(r=>Date.parse(r.time)>=t0+DAY);
  const first=m.requests[d2].messages;
  assert.equal(first.length,1,'conversation reset at the day boundary');
  assert.match(first[0].content,/## Previous days \(what your devices recorded\)\n### Day 1 \(\d{4}-\d\d-\d\d\)\nglucose \(sensor, n \d+/);
  assert.match(first[0].content,/basal looks high; carb ratio ok/);
  assert.match(first[0].content,/--- current context ---\nTime \d\d:\d\d day 2 of 2/);
  assert.ok(m.requests[d2+1].messages.length>1,'within the day the conversation grows again');
  assert.ok(!JSON.stringify(m.requests[d2+1].messages).includes(lines[1].observation_text),'no day-1 turns verbatim on day 2');
  assert.equal(lines[d2].day,2);
  assert.equal(st.stats.notes,'basal looks high; carb ratio ok');assert.equal(st.stats.notes_updates,1);assert.equal(st.stats.day_summaries,1);
  assert.deepEqual(lines[0].parsed.note_to_self,'basal looks high; carb ratio ok');
});

test('memory none: each day starts fresh (no summaries, no notes)',async()=>{
  const out=path.join(tmp,'none');
  const m=fnModel(()=>WAIT({note_to_self:'ignored'}));
  await runEpisode({instance:inst('adult_dana_g6'),model:m,outDir:out,hours:48,agentOptions:{memory:'none'}});
  const lines=readLines(path.join(out,'transcript.jsonl')),t0=Date.parse(lines[0].sim_time);
  assert.match(lines[0].system,/You keep no memory between days/);
  assert.ok(!lines[0].tools[0].input_schema.properties.note_to_self);
  const d2=m.requests.findIndex(r=>Date.parse(r.time)>=t0+DAY);
  assert.equal(m.requests[d2].messages.length,1);
  assert.ok(m.requests.every(r=>!/Previous days|Your notes/.test(r.messages[0].content)));
  assert.equal(readJson(path.join(out,'status.json')).stats.notes_updates,0);
});

test('SET_PROFILE only with memory notes+profile (hidden otherwise, even when the instance enables it)',async()=>{
  const withSwitch=inst('adult_dana_g6',11,{overrides:{profile_switch:{enabled:true}}});
  const setCr=req=>({action:{type:'SET_PROFILE',carb_ratio_g_per_u:Math.round(req.obs.profile.carb_ratio_g_per_u*1.1*10)/10},wait_minutes:240,note:'cr up'});
  const a=path.join(tmp,'profile-notes'),ma=fnModel((req,i)=>i===0?setCr(req):WAIT());
  await runEpisode({instance:withSwitch,model:ma,outDir:a,hours:24,agentOptions:{memory:'notes'}});
  const la=readLines(path.join(a,'transcript.jsonl'));
  assert.ok(!actionTypes(la[0].tools).includes('SET_PROFILE'),'not offered');
  assert.match(la[0].parse_error,/SET_PROFILE is not available in this setup/);
  assert.doesNotMatch(la[0].system,/SET_PROFILE/);
  // notes+profile: the harness enables profile_switch; the change is applied and counted.
  const b=path.join(tmp,'profile-on'),mb=fnModel((req,i)=>i===0?setCr(req):WAIT());
  await runEpisode({instance:inst('adult_dana_g6'),model:mb,outDir:b,hours:24,agentOptions:{memory:'notes+profile'}});
  const lb=readLines(path.join(b,'transcript.jsonl')),bundle=readJson(path.join(b,'bundle.json'));
  assert.ok(actionTypes(lb[0].tools).includes('SET_PROFILE'));
  assert.match(lb[0].system,/You may reprogram the person's therapy profile with SET_PROFILE/);
  assert.equal(lb[0].receipt.status,'applied',JSON.stringify(lb[0].receipt));
  assert.equal(bundle.manifest.config.profile_switch.enabled,true);
  assert.equal(readJson(path.join(b,'status.json')).stats.profile_changes,1);
  assert.match(lb[1].observation_text,/SET_PROFILE carb_ratio_g_per_u=/);
});

test('memory_mode rolling / full / none: within-day context',async()=>{
  const lens={};
  for(const mode of ['rolling','full','none']) {
    const m=fnModel(()=>({action:{type:'WAIT'},wait_minutes:30,wake_on:[],note:'n'}));
    await runEpisode({instance:inst('adult_dana_g6'),model:m,outDir:path.join(tmp,`mode-${mode}`),hours:6,agentOptions:{memory_mode:mode,keep_turns:4}});
    lens[mode]=m.requests.map(r=>r.messages.length);
    if(mode==='rolling')assert.match(m.requests.at(-1).messages[0].content,/^Day log of earlier turns/);
  }
  const n=lens.full.length;
  assert.equal(n,12);
  assert.deepEqual(lens.full,Array.from({length:n},(_,i)=>2*i+1),'full: every turn of the day verbatim');
  assert.equal(lens.rolling.at(-1),2*4+1,'rolling: last keep_turns turns');
  assert.ok(lens.none.every(l=>l===1),'none: only the current observation');
});
