import test from 'node:test';
import assert from 'node:assert/strict';
import {executionProtocol,effectiveAgentOptions} from '../src/benchmark/execution-protocol.mjs';

test('four classical baselines default to hourly; explicit modes and unrelated agents stay available',()=>{
  for(const agent of ['wait','standard','guideline','hcl','oref1']) {
    const options=effectiveAgentOptions(agent,{decision_schedule:'hourly',memory:'notes'});
    assert.equal(options.decision_schedule,'hourly');
    assert.equal(options.min_decision_minutes,5);
    assert.equal(options.memory,'notes');
    assert.equal(executionProtocol(agent,options).fixed_interval_minutes,60);
    assert.equal(executionProtocol(agent,options).kind,'policy-hourly');
    assert.equal(executionProtocol(agent,options).max_extra_decisions_per_day,6);
    assert.equal(executionProtocol(agent).fixed_interval_minutes,agent==='wait'?5:60);
    assert.equal(executionProtocol(agent,{decision_schedule:'event-driven'}).fixed_interval_minutes,5);
  }
  for(const agent of ['patient','oref0','causal'])assert.equal(executionProtocol(agent).fixed_interval_minutes,5);
  assert.equal(effectiveAgentOptions('hcl',{memory:'notes'}).decision_schedule,'hourly');
  assert.equal(effectiveAgentOptions('hcl','{"decision-schedule":"event-driven"}').decision_schedule,'event-driven');
  assert.equal(effectiveAgentOptions('hcl',{decisionSchedule:'event-driven'}).decision_schedule,'event-driven');
  assert.equal(executionProtocol('llm').kind,'llm-event-driven');
});

test('LLM hourly interaction and explicit historical policy gating remain unchanged',()=>{
  const options=effectiveAgentOptions('llm:model.json',{decision_schedule:'hourly',max_extra_decisions_per_day:6});
  assert.equal(options.decision_schedule,'hourly');
  assert.deepEqual(executionProtocol('llm:model.json',options),{kind:'llm-hourly',fixed_interval_minutes:60,
    max_extra_decisions_per_day:6,label:'LLM: fixed 60 min + up to 6 extra decisions per local day'});
  assert.equal(executionProtocol('standard',{min_decision_minutes:30}).kind,'policy-legacy-gated');
});
