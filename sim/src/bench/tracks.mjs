// Bench tracks (docs/BENCH.zh-CN.md §2.5 赛道): the same instance list run under different care
// modes. A track only sets the instance's self_care; seeds, devices and events are identical, so
// results of one model on two tracks are paired by instance and repeat.
//
//   full      全权  self_care 'none'      the agent makes every treatment decision
//   assisted  辅助  self_care 'assisted'  the person boluses the meals they announce with their own
//                                         calculator and treats lows they can see; the agent acts on top
//
// Baselines per track: full = wait / patient / oref0. assisted = wait (the person managing alone) and
// oref0 (loop-like temp basals / MDI corrections on top of the person). The scripted 'patient'
// policy is not run on the assisted track: it would bolus the same announced meals again.
export const TRACKS=Object.freeze({
  full:Object.freeze({label:'全权 full: the agent makes every treatment decision',self_care:'none',baselines:Object.freeze(['wait','patient','oref0'])}),
  assisted:Object.freeze({label:'辅助 assisted: the person boluses announced meals and treats visible lows; the agent acts on top',
    self_care:'assisted',baselines:Object.freeze(['wait','oref0'])}),
});
export const TRACK_IDS=Object.keys(TRACKS);
export const DEFAULT_TRACK='full';

export function checkTrack(track=DEFAULT_TRACK) {
  if(!TRACKS[track])throw new Error(`Unknown track ${track}; one of ${TRACK_IDS.join(', ')}`);
  return track;
}
/** Instance spec with the track's care mode applied. */
export function trackSpec(spec,track=DEFAULT_TRACK) {
  return {...spec,self_care:TRACKS[checkTrack(track)].self_care};
}
