import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {planScenarioPipeline} from '../src/experiments/scenario-pipeline.mjs';
import {adaptAgeQuantities, AGE_QUANTITY_POLICY} from '../src/experiments/age-quantities.mjs';
import {buildInstanceConfig} from '../src/sim/instance.mjs';

const original = JSON.parse(fs.readFileSync('bench/pipelines/weekly-patient224-20261022/pipeline-config.json'));
const sourceBytes = JSON.stringify(original);
const oldPlan = planScenarioPipeline(original);
const newConfig = {...original, input_quantity_policy: AGE_QUANTITY_POLICY};
const next = planScenarioPipeline(newConfig);

test('age quantities are opt-in and preserve the original224 physical patient assignments', () => {
  assert.equal(JSON.stringify(original), sourceBytes);
  assert.equal(next.rows.length, 224);
  for (const [i, row] of next.rows.entries()) {
    const old = oldPlan.rows[i], before = buildInstanceConfig(old.spec), after = buildInstanceConfig(row.spec);
    const group = old.factors.patient.split('-')[0];
    assert.deepEqual(row.factors, old.factors);
    const {scenario: s0, initial_state: h0, ...other0} = before;
    const {scenario: s1, initial_state: h1, ...other1} = after;
    assert.deepEqual(other1, other0, row.preset);
    assert.deepEqual({...s1, extra_events: []}, {...s0, extra_events: []});
    if (['adult', 'older'].includes(group)) assert.deepEqual(after, before);
    for (const mode of ['I0', 'I1', 'I2']) {
      const {information, ...physical} = buildInstanceConfig(row.variants[mode]);
      const {information: ignored, ...expected} = after;
      assert.deepEqual(physical, expected);
      assert.equal(information.own_records, true);
    }
  }
});

test('all minor meals, historical inputs, repeated inputs and visible quantity records scale consistently', () => {
  let child = 0, teen = 0;
  for (const [i, row] of next.rows.entries()) {
    const group = row.factors.patient.split('-')[0];
    if (!['child', 'adolescent'].includes(group)) continue;
    group === 'child' ? child++ : teen++;
    const factor = group === 'child' ? .65 : .85;
    const old = oldPlan.rows[i].spec.overrides, now = row.spec.overrides;
    const carbs = n => Number((n * factor).toFixed(2));
    assert.equal(now.scenario.extra_events.length, old.scenario.extra_events.length);
    for (const [j, e] of now.scenario.extra_events.entries()) {
      const b = old.scenario.extra_events[j];
      assert.equal(e.id, b.id); assert.equal(e.at_minute, b.at_minute);
      if (e.type === 'meal') {
        assert.equal(e.grams, carbs(b.grams));
        assert.equal(e.announced_grams, b.announced_grams == null ? null : carbs(b.announced_grams));
        assert.equal(e.absorption_minutes, b.absorption_minutes);
      } else if (e.type === 'patient_treatment') {
        if (e.action.type === 'INGEST_CARBS') assert.equal(e.action.grams, carbs(b.action.grams));
        else { assert.ok(e.action.units > 0 && e.action.units <= b.action.units * factor + 1e-8); assert.equal(e.action.duration_minutes, b.action.duration_minutes); }
      } else if (e.type === 'record') {
        const m = now.scenario.extra_events.find(m => m.id + '-plan' === e.id);
        if (m) assert.ok(e.text.startsWith(`Current intention: approximately ${m.announced_grams ?? m.grams} g carbohydrate `));
      } else assert.deepEqual(e, b);
    }
    for (const [j, h] of now.initial_state.history.entries()) {
      const b = old.initial_state.history[j];
      assert.equal(h.minutes_before, b.minutes_before);
      if (['meal', 'carbs'].includes(h.type)) assert.equal(h.grams, carbs(b.grams));
      if (h.type === 'meal') assert.equal(h.absorption_minutes, b.absorption_minutes);
      if (['bolus', 'extended_bolus'].includes(h.type)) assert.ok(h.units > 0 && h.units <= b.units * factor + 1e-8);
    }
  }
  assert.equal(child, 56); assert.equal(teen, 56);
});

test('unknown policy, routine meals and unregistered narrative quantities fail closed', () => {
  assert.throws(() => planScenarioPipeline({...original, input_quantity_policy: 'typo'}), /Unknown input quantity/);
  const row = oldPlan.rows.find(r => r.factors.patient.startsWith('child'));
  const cfg = buildInstanceConfig(row.spec);
  const routine = structuredClone(row.spec); routine.overrides.scenario.meals = {breakfast: {}};
  assert.throws(() => adaptAgeQuantities(routine, cfg), /Routine meals/);
  const text = structuredClone(row.spec);
  text.overrides.scenario.extra_events.push({type: 'record', id: 'new-record', category: 'meal', text: 'Unknown 50 g snack'});
  assert.throws(() => adaptAgeQuantities(text, cfg), /Unregistered quantity/);
});
