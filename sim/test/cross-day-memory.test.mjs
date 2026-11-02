// cross_day_memory (amnesic control for the learning-over-time ablation): default true with unchanged prompts;
// false clears notes at each episode-day boundary and limits decision history / glucose history to the current day.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {KNOWLEDGE as K} from '../src/knowledge.mjs';
import {runEpisode} from '../src/bench/harness.mjs';
import {parseAgentOptions} from '../src/bench/agent-options.mjs';

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cross-day-'));
test.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
const inst=()=>{const s=K.instances.adult_dana_g6.spec;return {id:'xday',spec:{...s,seed:11}};};
const BASE={memory:'notes',decision_schedule:'hourly',prompt_revision:'availability-consistency/v5-memory-alerts'};
function fnModel() {
  const requests=[];let i=0;
  return {name:'fn',adapter:'test',config:{},requests,
    async complete(req) {
      requests.push(structuredClone({messages:req.messages,tools:req.tools}));
      return {tool_call:{id:`tu_${i++}`,name:'act',input:{action:{type:'WAIT'},note:'w',note_to_self:`note ${i}`}},text:'',usage:{input_tokens:1,output_tokens:1},latency_ms:1};
    }};
}
const run=async(name,extra)=>{const m=fnModel();await runEpisode({instance:inst(),model:m,outDir:path.join(tmp,name),hours:48,agentOptions:{...BASE,...extra}});return m;};
const text=r=>JSON.stringify(r.messages);
const day2=m=>m.requests.find(r=>/day 2 of 2/.test(text(r)));

test('cross_day_memory defaults on and is incompatible with day_reflection when off',()=>{
  assert.equal(parseAgentOptions({}).cross_day_memory,true);
  assert.equal(parseAgentOptions({cross_day_memory:false}).cross_day_memory,false);
  assert.throws(()=>parseAgentOptions({memory:'notes',day_reflection:true,cross_day_memory:false}),/needs cross_day_memory/);
});

test('explicit true produces the same requests as the default',async()=>{
  const a=await run('default',{}),b=await run('explicit',{cross_day_memory:true});
  assert.deepEqual(b.requests,a.requests);
});

test('off: first day-2 request has no earlier notes, day summaries or day-1 decisions',async()=>{
  const on=await run('on',{}),off=await run('off',{cross_day_memory:false});
  assert.equal(on.requests.length,off.requests.length,'same decision clock');
  const a=day2(on),b=day2(off);
  assert.match(text(a),/Previous days \(what your devices recorded\)/);
  assert.doesNotMatch(text(b),/Previous days \(what your devices recorded\)/);
  assert.match(text(a),/## Your notes \(note_to_self\)\\nnote \d+/);
  assert.match(text(b),/## Your notes \(note_to_self\)\\n\(empty\)/);
  const available=s=>Number(s.match(/available via read_glucose_history: (\d+) observed/)?.[1]);
  assert.ok(available(text(b))<available(text(a)),'glucose history limited to the current day');
  const historyLines=s=>(s.match(/\[fixed\]|\[extra\]/g)??[]).length;
  assert.ok(historyLines(text(b))<historyLines(text(a)),'decision history limited to the current day');
});
