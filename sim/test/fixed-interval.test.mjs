import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SimEnv} from '../src/env/pomdp.mjs';
import {runLlmAgent} from '../src/benchmark/llm-agent.mjs';
import {HourlySchedule} from '../src/bench/hourly-schedule.mjs';
import {parseAgentOptions} from '../src/bench/agent-options.mjs';

const harness=fileURLToPath(new URL('../harnesses/claude-code-decision-loop/',import.meta.url));
const capture=JSON.parse(fs.readFileSync(harness+'CAPTURE-FIXTURES.json','utf8')).cases[0].neutral;
const fixture=JSON.parse(fs.readFileSync(harness+'fixtures/a01-child-male-typical-pump-pct-ageqty-v1-3d-v1-s20261020-bnone-i2.json','utf8'));
const OPTIONS={simulate:true,simulate_calls:1,memory:'notes',memory_mode:'rolling',keep_turns:12,history_hours:3,decision_schedule:'hourly',
  max_extra_decisions_per_day:6,prompt_revision:'availability-consistency/v6-shared-observation',score_range_alerts:true,reasoning_effort:'high'};

/** First controller request for the fixture, without any model call. */
async function firstRequest(extra={}) {
  const env=new SimEnv(fixture.instance.config);let request=null;
  const client={episodeId:async()=>fixture.instance.id,current:async()=>({observation:env.observe(),step:env.step_count,done:env.done()}),
    step:async(_i,action,rationale,{prefix,expected_step})=>env.step({action_id:`${prefix}-${expected_step}`,expected_step,action,rationale})};
  const model={name:'capture',adapter:'anthropic',config:{model:'capture'},async complete(r){request=r;throw Object.assign(Error('captured'),{status:400,retryable:false});}};
  try{await runLlmAgent({client,pub:fixture.pub,model,logsDir:fs.mkdtempSync(path.join(os.tmpdir(),'fixed-interval-')),units:'mgdl',
    agentOptions:{...OPTIONS,...extra},maxTurns:3,maxConsecutiveErrors:1,retry:{tries:1}});}catch{}
  assert.ok(request,'controller sent no request');
  return {system:typeof request.system==='string'?request.system:request.system.map(b=>b.text).join(''),user:request.messages[0].content,tools:request.tools};
}

test('default and explicit 60 min reproduce the captured final-profile request byte for byte',async()=>{
  for(const extra of [{},{fixed_interval_minutes:60}]) {
    const r=await firstRequest(extra);
    assert.equal(r.system,capture.system);assert.equal(r.user,capture.messages[0].content);assert.deepEqual(r.tools,capture.tools);
  }
});

test('a 30 min interval changes every schedule statement and nothing else',async()=>{
  const base=await firstRequest(),r=await firstRequest({fixed_interval_minutes:30});
  assert.ok(r.system.includes('## Fixed 30-minute decisions and optional follow-ups'));
  assert.ok(r.system.includes('elapsed 0, 30, 60, ... minutes'));
  assert.ok(!/fixed hourly|Fixed hourly/.test(r.system+r.user+JSON.stringify(r.tools)));
  assert.ok(r.user.includes('Fixed 30-minute schedule: this is a fixed decision. Next fixed decision at 2026-10-17T04:15:00.000Z'));
  assert.ok(JSON.stringify(r.tools).includes('A value >=30 normally waits for the next fixed slot'));
  const norm=s=>s.replaceAll('30-minute','hourly').replaceAll('0, 30, 60,','0, 60, 120,').replaceAll('>=30','>=60')
    .replace('04:15:00.000Z','04:45:00.000Z');
  assert.equal(norm(r.system),base.system);assert.equal(norm(r.user),base.user);assert.equal(norm(JSON.stringify(r.tools)),JSON.stringify(base.tools));
});

test('schedule grid follows the interval; extra cap is per date, not scaled',()=>{
  const start=Date.parse('2026-10-17T03:45:00Z'),s=new HourlySchedule({start,end:start+86400000,intervalMinutes:30,extraLimit:6});
  assert.ok(s.isFixed(start+30*60000));assert.ok(!s.isFixed(start+15*60000));
  assert.equal(s.nextFixed(start+5*60000),start+30*60000);assert.equal(s.extraLimit,6);
  assert.throws(()=>parseAgentOptions({fixed_interval_minutes:30}),/decision_schedule hourly/);
  assert.throws(()=>parseAgentOptions({decision_schedule:'hourly',fixed_interval_minutes:32}),/multiple of 5|integer/);
  assert.equal(parseAgentOptions({decision_schedule:'hourly',fixed_interval_minutes:120}).fixed_interval_minutes,120);
});
