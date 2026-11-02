import assert from 'node:assert/strict';
import {PUMPS, PENS, quantize} from '../core/devices.mjs';

export const AGE_QUANTITY_POLICY = 'weekly-minor-quantities/v1';
export const AGE_QUANTITY_FACTORS = Object.freeze({child: 0.65, adolescent: 0.85, adult: 1});
const rounded = x => Number(x.toFixed(2));

/** A fixed research quantity intervention, not a nutritional or insulin prescription. */
export function adaptAgeQuantities(source, config) {
  const age = config.patient.age_years;
  assert.ok(Number.isFinite(age) && age > 0, 'A resolved patient age is required');
  const group = age < 12 ? 'child' : age < 18 ? 'adolescent' : 'adult';
  const factor = AGE_QUANTITY_FACTORS[group];
  const spec = structuredClone(source);
  const provenance = {policy: AGE_QUANTITY_POLICY, age_group: group, factor,
    affected: ['meal_carbs', 'announced_carbs', 'historical_carbs', 'scripted_rescue_carbs', 'scripted_insulin', 'quantity_records'],
    unchanged: ['patient', 'profile', 'safety', 'timing', 'absorption', 'activity', 'faults', 'sensors', 'scoring'],
    insulin_rounding: 'down to the existing device dose grid', outcome_fitting: false};
  if (factor === 1) return {spec, provenance};
  assert.equal(spec.horizon_minutes, 10080, 'This policy is registered for the frozen seven-day templates');
  assert.deepEqual(spec.overrides.scenario.meals, {}, 'Routine meals would escape the scripted quantity intervention');
  const carb = x => { assert.ok(Number.isFinite(x) && x >= 0); return rounded(x * factor); };
  const insulin = (x, extended = false) => {
    const step = config.therapy.mode === 'pump'
      ? (extended ? PUMPS[config.therapy.pump.model].extended?.step_u : PUMPS[config.therapy.pump.model].bolus_step_u)
      : PENS[config.therapy.mdi.bolus_pen].step_u;
    assert.ok(Number.isFinite(step) && step > 0, 'Scripted insulin needs a supported delivery grid');
    const units = rounded(quantize(x * factor, step, 'down'));
    assert.ok(units > 0 && units <= config.safety.max_bolus_u, 'Scaled scripted dose outside the existing age limit');
    return units;
  };
  for (const h of spec.overrides.initial_state.history) {
    if (['meal', 'carbs'].includes(h.type)) {
      h.grams = carb(h.grams);
      if (h.announced_grams != null) h.announced_grams = carb(h.announced_grams);
    } else if (['bolus', 'extended_bolus'].includes(h.type)) h.units = insulin(h.units, h.type === 'extended_bolus');
    else assert.equal(h.type, 'calibrate_cgm', 'Unregistered historical input in age quantity policy');
  }
  const events = spec.overrides.scenario.extra_events;
  const originalMeals = new Map(source.overrides.scenario.extra_events.filter(e => e.type === 'meal').map(e => [e.id, e]));
  for (const e of events) {
    if (e.type === 'meal') {
      e.grams = carb(e.grams);
      if (e.announced_grams != null) e.announced_grams = carb(e.announced_grams);
    } else if (e.type === 'patient_treatment') {
      if (e.action.type === 'INGEST_CARBS') e.action.grams = carb(e.action.grams);
      else {
        assert.ok(['BOLUS', 'EXTENDED_BOLUS'].includes(e.action.type), 'Unregistered scripted action');
        e.action.units = insulin(e.action.units, e.action.type === 'EXTENDED_BOLUS');
      }
    } else if (e.type === 'record') {
      // Only known derived quantity sentences are rewritten; clocks and clinical evidence stay intact.
      const meal = originalMeals.get(e.id.replace(/-plan$/, ''));
      if (meal && e.id.endsWith('-plan')) {
        const prefix = `Current intention: approximately ${meal.announced_grams ?? meal.grams} g carbohydrate `;
        assert.ok(e.text.startsWith(prefix), 'Meal plan text no longer matches its structured event');
        e.text = `Current intention: approximately ${carb(meal.announced_grams ?? meal.grams)} g carbohydrate ` + e.text.slice(prefix.length);
      } else if (e.id.endsWith('-cancelled-lunch')) {
        assert.ok(e.text.startsWith('A planned 40 g meal was cancelled'));
        e.text = e.text.replace('A planned 40 g meal', `A planned ${carb(40)} g meal`);
      } else if (e.id.endsWith('-recent-rescue')) {
        assert.ok(e.text.startsWith('Person reports a 15 g rescue drink'));
        e.text = e.text.replace('a 15 g rescue drink', `a ${carb(15)} g rescue drink`);
      } else assert.ok(!/\d\s*(?:g\b|U\b|units\b|grams?\b)/i.test(e.text), 'Unregistered quantity-bearing narrative');
    }
  }
  return {spec, provenance};
}
