import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RecordBook} from '../src/bench/records.mjs';
import {readGlucoseHistory,glucoseHistoryAvailability,hasGlucoseHistory} from '../src/bench/glucose-history.mjs';
import {MEMORY_PROMPT_REVISION,CURRENT_PROMPT_REVISION} from '../src/bench/prompt-revisions.mjs';
import {runEpisode} from '../src/bench/harness.mjs';
import {KNOWLEDGE as K} from '../src/knowledge.mjs';

const t0=Date.parse('2026-10-21T00:00:00Z');
function fixture() {
  const r=new RecordBook({offsetMs:8*3600000});
  for(let i=0;i<2016;i++)r.continuous.set(t0+i*300000,{t:t0+i*300000,v:100+i%20,src:'cgm'});
  r.spot.set('meter',{time:new Date(t0+300000).toISOString(),value_mg_dl:123,source:'meter'});
  return r;
}

test('raw history preserves observed samples, sources, units, gaps and local timezone',()=>{
  const r=fixture();r.continuous.delete(t0+600000);
  const out=readGlucoseHistory(r,{start_time:'2026-10-21T08:00:00+08:00',end_time:'2026-10-21T08:15:00+08:00'}, {now:t0+900000,units:'mgdl'});
  assert.deepEqual(out.readings.map(p=>[p.time,p.source,p.value]),[
    ['2026-10-21T08:00:00.000+08:00','cgm',100],
    ['2026-10-21T08:05:00.000+08:00','cgm',101],
    ['2026-10-21T08:05:00.000+08:00','meter',123],
    ['2026-10-21T08:15:00.000+08:00','cgm',103]
  ]);
  const meter=readGlucoseHistory(r,{source:'meter'},{now:t0+900000,units:'mmol'});
  assert.equal(meter.readings[0].value,123/18.016);
  assert.equal(meter.units,'mmol/L');
});

test('entire week is retrievable with pagination; future and hidden data cannot enter',()=>{
  const r=fixture(),now=t0+2015*300000;
  r.true_glucose_mg_dl=23456789;
  r.continuous.set(now+300000,{t:now+300000,v:23456789,src:'cgm'});
  const pages=[];let offset=0;
  do {const p=readGlucoseHistory(r,{offset,limit:1000,end_time:'2030-01-01T00:00:00Z'},{now,units:'mgdl'});pages.push(...p.readings);offset=p.next_offset;
    assert.equal(p.end_clipped_to_now,true);assert.equal(p.total,2017);
  }while(offset!=null);
  assert.equal(pages.length,2017);assert.ok(!JSON.stringify(pages).includes('23456789'));
  assert.equal(glucoseHistoryAvailability(r,{now}).count,2017);
  assert.throws(()=>readGlucoseHistory(r,{start_time:'2030-01-01T00:00:00Z'},{now}),/Invalid history/);
  for(const args of [{limit:1001},{offset:-1},{source:'true_glucose'},{start_time:'2026-10-21 08:00'},{shell:'cat file'}])
    assert.throws(()=>readGlucoseHistory(r,args,{now}));
});

test('history tools are versioned; old experiments and no-memory variants do not gain them',()=>{
  assert.equal(hasGlucoseHistory({prompt_revision:CURRENT_PROMPT_REVISION,memory:'notes'}),false);
  assert.equal(hasGlucoseHistory({prompt_revision:MEMORY_PROMPT_REVISION,memory:'none'}),false);
  assert.equal(hasGlucoseHistory({prompt_revision:MEMORY_PROMPT_REVISION,memory:'notes'}),true);
});

test('controller permits read then act across days without advancing virtual time for reads',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'raw-glucose-memory-')),requests=[],readDays=new Set();
  let start;
  const model={name:'offline-history',config:{},async complete(req){
    start??=Date.parse(req.obs.virtual_time);requests.push(structuredClone(req));
    const day=Math.floor((Date.parse(req.obs.virtual_time)-start)/86400000);
    const lookup=!readDays.has(day);if(lookup)readDays.add(day);
    return {text:'',tool_call:{id:`call-${requests.length}`,name:lookup?'read_glucose_history':'act',input:lookup?{limit:1000}
      :{action:{type:'WAIT'},wait_minutes:240,wake_on:[],note:'local fixed fixture',note_to_self:'past observations are available'}},usage:{input_tokens:0,output_tokens:0}};
  }};
  try {
    const result=await runEpisode({instance:{spec:K.instances.adult_dana_g6.spec},model,outDir:dir,hours:48,
      agentOptions:{memory:'notes',decision_schedule:'hourly',max_extra_decisions_per_day:0,prompt_revision:MEMORY_PROMPT_REVISION}});
    assert.equal(result.state,'done');
    const tx=fs.readFileSync(path.join(dir,'transcript.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(tx.length,48);assert.equal(requests.length,50);
    assert.deepEqual(requests[0].tools.map(t=>t.name),['act','read_glucose_history']);
    assert.equal(requests[0].obs.virtual_time,requests[1].obs.virtual_time);
    const old=tx[24].history_reads[0].result;
    assert.ok(old.total>36,'sensor warm-up may leave fewer than 288 samples on the first day');
    assert.ok(Date.parse(old.readings[0].time)<Date.parse(tx[24].sim_time)-3*3600000,'raw records older than the ordinary 3h window remain available');
    const reply=requests[1].messages.at(-1);
    assert.ok(reply.tool_result_for);assert.ok(JSON.parse(reply.content).readings.length);
    assert.ok(tx.every(t=>!t.parse_error));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
