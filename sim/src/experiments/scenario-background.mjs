import {Rng} from '../core/rng.mjs';

export const BACKGROUND_PROTOCOL='background-clock/v1';
export const BASE_START='2026-10-17T04:00:00.000Z';
export const CLOCK_RANGE_MINUTES=Object.freeze([-30,30]);

/** Move the clock origin, not the intervals that define each clinical event mechanism. */
export function backgroundClock(preset,seed) {
  if(!Number.isSafeInteger(seed)||seed<0)throw new Error('background seed must be a non-negative safe integer');
  const rng=Rng.stream(seed,`${BACKGROUND_PROTOCOL}:${preset}`);
  const offset=(Math.floor(rng.next()*13)-6)*5;
  return {protocol:BACKGROUND_PROTOCOL,seed,stream:preset,range_minutes:[...CLOCK_RANGE_MINUTES],
    clock_offset_minutes:offset,start_time:new Date(Date.parse(BASE_START)+offset*60000).toISOString(),
    scope:'Absolute clock origin only. All relative event/history times, quantities, durations, faults, patient and device parameters are unchanged.'};
}
