// Harbor reward of one sweet-sim episode (docs/BENCH.zh-CN.md §8.4). Self-contained apart from the
// bench scoring module, which is passed in (`S` = the namespace of src/bench/score.mjs): in the
// repository that is ../../bench/score.mjs; in an exported task the sim sidecar's scoring endpoint
// (sim-entry.mjs POST /harbor/score) passes the copy in its own snapshot. So the reward is computed
// by exactly the same code as the bench (episodeMetrics + episodeScore: bench v0.2 weights,
// severe-hypo veto), never a re-implementation.
//
// verifier 'episode' (default): one score over the whole horizon.
// verifier 'daily' (multi-day horizons): additionally day_<k>_reward (k = 1..days; day k covers
// minutes [(k-1)*1440, k*1440) of the true-glucose 5-minute grid, scored with the same rule incl. the
// veto) and learning_slope = OLS slope of the daily rewards over the day index (needs >= 2 days).

export const SCORING_VERSION='METRICS-v0.3';
export const VERIFIERS=['episode','daily'];
const DAY=1440;
const fin=v=>typeof v==='number'&&Number.isFinite(v);

/** OLS slope of ys over x = 1..n (null for n < 2). */
export function olsSlope(ys) {
  const n=ys.length;if(n<2)return null;
  const mx=(n+1)/2,my=ys.reduce((a,b)=>a+b,0)/n;
  let sxy=0,sxx=0;
  ys.forEach((y,i)=>{const dx=i+1-mx;sxy+=dx*(y-my);sxx+=dx*dx;});
  return sxy/sxx;
}

/** Daily scores from the true-glucose grid with the bench rule: [{day, score, raw, safety_fail, tir, ...}]. */
export function dailyScores(bundle,S,weights,version=SCORING_VERSION) {
  const grid=S.trueGrid(bundle),H=bundle.manifest.config.horizon_minutes,days=Math.ceil(H/DAY),out=[];
  for(let d=0;d<days;d++) {
    const pts=grid.filter(p=>p.m>=d*DAY&&p.m<(d+1)*DAY).map(p=>p.g);
    const {events,...glucose}=S.glucoseMetrics(pts);
    const dynamic=S.dynamicMetrics(grid.filter(p=>p.m>=d*DAY&&p.m<(d+1)*DAY),{expected_samples:Math.ceil(Math.min(DAY,H-d*DAY)/5)});
    const s=S.episodeScore({glucose,events:events??{},dynamic},weights,{version});
    out.push({day:d+1,minutes:Math.min(DAY,H-d*DAY),score:s.score,raw:s.raw,safety_fail:s.safety_fail,
      tir:glucose.tir??null,tbr70:glucose.tbr70??null,tbr54:glucose.tbr54??null,hypo_events:events?.hypo_events??0,dynamic});
  }
  return out;
}

/**
 * Scores an evaluator bundle (SimEnv.exportBundle()). Returns
 * {reward (flat finite numbers for reward.json), metrics (bench §5 metrics), score, daily|null, normalization|null}.
 * `reward.reward` is exactly episodeScore(episodeMetrics(bundle), weights).score.
 * opts: weights (default S.DEFAULT_WEIGHTS), verifier ('episode'|'daily'), references ({wait, patient?, oref0?}
 * for this episode's seed; gives `normalized` by S.normalizeScore), agent_completed, agent_steps, verifier_wait_steps.
 */
export function scoreBundle(bundle,S,{weights,verifier='episode',references=null,agent_completed=null,agent_steps=null,verifier_wait_steps=null,
  surprises=null,certificate=null,scoring_version=SCORING_VERSION}={}) {
  if(!VERIFIERS.includes(verifier))throw new Error(`verifier must be one of ${VERIFIERS.join(', ')}`);
  const cogi=['COGI-v1','COGI-4-8/v1'].includes(scoring_version);
  const w=cogi?{tir:.50,hypo:.35,gv:.15}:{...S.DEFAULT_WEIGHTS,...(weights??{})};
  for(const [k,v] of Object.entries(w))if(!fin(v))throw new Error(`weights.${k} must be a finite number`);
  const metrics=S.episodeMetrics(bundle),score=S.episodeScore(metrics,w,{version:scoring_version}),g=metrics.glucose;
  const completed=bundle.metrics?.completed_horizon!==false&&!bundle.metrics?.error;
  const reward={reward:score.score};
  const put=(k,v)=>{if(fin(v))reward[k]=v;};
  put('raw_reward',score.raw);
  for(const [k,src] of [['tir','tir'],['tbr70','tbr70'],['tbr54','tbr54'],['tar180','tar180'],['tar250','tar250'],['mean_mgdl','mean'],['cv','cv']])put(k,g[src]);
  reward.severe_hypo=score.safety_fail?1:0;
  if(scoring_version===SCORING_VERSION) {
    const d=metrics.dynamic;
    reward.safety_pass=d.safety_pass?1:0;
    for(const k of ['severe_hypo_events','tir_4_8','gmi_percent','cv','fast_roc_fraction'])put(k,d[k]);
    put('score_v03',score.score);
  }
  put('hypo_events',metrics.events?.hypo_events);
  reward.completed=completed?1:0;
  if(agent_completed!==null)reward.agent_completed=agent_completed?1:0;
  put('agent_steps',agent_steps);put('verifier_wait_steps',verifier_wait_steps);
  let normalization=null;
  if(references&&fin(references.wait)) {
    normalization=cogi?{normalized:null,reason:'cogi_absolute_0_100'}:scoring_version===SCORING_VERSION
      ?{normalized:fin(certificate)&&certificate>0?reward.reward/certificate:null,reason:'causal_certificate_required'}
      :S.normalizeScore(reward.reward,references);
    put('normalized',normalization.normalized);
  }
  let daily=null;
  if(verifier==='daily') {
    daily=dailyScores(bundle,S,w,scoring_version);
    for(const d of daily)reward[`day_${d.day}_reward`]=d.score;
    put('learning_slope',olsSlope(daily.map(d=>d.score)));
    reward.days=daily.length;
  }
  // bench v0.3 (OpenDiabet v1.1-hard): surprise handling and the score relative to the certificate.
  // Only when the task asks for it (scoring.json surprises / certificate); otherwise v0.2 unchanged.
  let surprise=null,version=scoring_version;
  if(Array.isArray(surprises)&&S.surpriseMetrics) {
    surprise=S.surpriseMetrics(bundle,surprises);
    reward.surprise_events=surprise.surprise_events;put('surprise_score',surprise.surprise_score);
    metrics.surprise=surprise;
  }
  if(fin(certificate)&&certificate>0){put('normalized_vs_certificate',reward.reward/certificate);reward.certificate_score=certificate;}
  return {reward,metrics,score:{...score,weights:w,scoring_version:version},daily,normalization,surprise};
}

/**
 * What the verifier writes for one episode: {reward (reward.json), metrics (metrics.json)}, from the
 * evaluator bundle and the task's tests/scoring.json. References and the certificate were computed
 * for the task's own episode seed, so other seeds (repeats) get neither `normalized` nor
 * `normalized_vs_certificate`; generator-placed surprises are timed from the start and hold for
 * every seed. agent: {episode_id, agent_completed, agent_steps, verifier_wait_steps}.
 */
export function verifierReport(bundle,S,scoring={},{episode_id=null,agent_completed=null,agent_steps=null,verifier_wait_steps=null}={}) {
  const seed=bundle.manifest.config.seed,ownSeed=scoring.episode_seed==null||scoring.episode_seed===seed;
  const verifier=scoring.verifier??'episode';
  const out=scoreBundle(bundle,S,{weights:scoring.weights,verifier,references:ownSeed?scoring.references??null:null,
    scoring_version:scoring.scoring_version??'bench-v0.2',
    agent_completed,agent_steps,verifier_wait_steps,
    surprises:Array.isArray(scoring.surprises)?scoring.surprises:null,
    certificate:ownSeed&&(scoring.scoring_version!==SCORING_VERSION||scoring.certificate?.scoring_version===SCORING_VERSION)?scoring.certificate?.score??null:null});
  const m=bundle.manifest;
  return {reward:out.reward,metrics:{episode_id,seed,scoring_version:out.score.scoring_version,verifier,score:out.score,
    normalization:out.normalization,daily:out.daily,reward:out.reward,metrics:out.metrics,
    manifest:{environment_version:m.environment_version,knowledge_sha256:m.knowledge_sha256,kernel_sha256:m.model.kernel_sha256,trajectory_sha256:m.trajectory_sha256}}};
}
