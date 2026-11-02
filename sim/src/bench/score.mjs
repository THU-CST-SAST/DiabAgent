// Bench scoring (docs/BENCH.zh-CN.md §5): per-episode metrics from an exported SimEnv bundle,
// the episode score with its safety veto, normalization against the same instance+repeat
// baselines, instance-clustered bootstrap summaries, per-factor tables and paired comparisons.
//
// Glucose metrics use the evaluator's true plasma glucose on the 5-minute decision grid
// (every SimEnv step ends on or before the next grid tick, so each grid point has a state).
// Thresholds are mg/dL internally: 70/180 (3.9/10.0 mmol/L), 54 (3.0), 250 (13.9), 140 (7.8).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {Rng} from '../core/rng.mjs';
import {kovatchevRisk} from '../oracle/common.mjs';
import {loadSuite,factorLevels,baselineRoot} from './suite.mjs';
import {TRACKS,DEFAULT_TRACK,checkTrack} from './tracks.mjs';
import {METRICS_TARGET} from './scoring-target.mjs';
import {COGI_VERSION,COGI_WEIGHTS,cogiFromStats,cogiMetrics} from './cogi.mjs';
import {COGI48_VERSION,cogi48FromStats,isCogiVersion} from './cogi48.mjs';

export const METRICS_VERSION='sweet-sim.bench-metrics/v3';
export const DEFAULT_SCORING_VERSION='METRICS-v0.3';
export const SCORES_FORMAT='sweet-sim.bench-scores/v1';
export const WEIGHTS_VERSION='metrics-weights/v0.3';
/** Score weights (§5.2): S = clip(tir*TIR − tbr70*TBR<70 − tbr54*TBR<54 − tar250*TAR>250, 0, 1). */
export const DEFAULT_WEIGHTS=Object.freeze({tir:1,tbr70:1.5,tbr54:4,tar250:0.5,cv:0.5,roc:0.5});
export const THRESHOLDS=Object.freeze({low:70,very_low:54,high:180,very_high:250,tight_high:140});
export const EVENT_RULES=Object.freeze({hypo:{below:54,min_minutes:15},hyper:{above:250,min_minutes:120}});
/** All baseline policies; each track runs a subset (TRACKS[track].baselines). */
export const BASELINE_POLICIES=['wait','patient','oref0'];
export const MIN_DENOMINATOR=0.05;
const GRID_MIN=5;
const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
const frac=(xs,pred)=>xs.length?xs.filter(pred).length/xs.length:null;
const r4=v=>v==null||!Number.isFinite(v)?v??null:Number(v.toFixed(4));

// ---- file helpers ---------------------------------------------------------------------------

/** Reads JSON, transparently gunzipping *.gz. */
export function readJson(file) {
  const buf=fs.readFileSync(file);
  return JSON.parse((file.endsWith('.gz')?zlib.gunzipSync(buf):buf).toString('utf8'));
}
export function readJsonl(file) {
  if(!fs.existsSync(file))return [];
  return fs.readFileSync(file,'utf8').split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l));
}
/** bundle.json or bundle.json.gz in an episode dir, or null. */
export function bundlePath(dir) {
  for(const f of ['bundle.json','bundle.json.gz'])if(fs.existsSync(path.join(dir,f)))return path.join(dir,f);
  return null;
}
/** Episode directories of a run dir: <runDir>/<instance>/r<k>/ → [{instance, repeat, dir}]. */
export function listEpisodes(runDir,instanceIds=null) {
  const out=[];
  if(!fs.existsSync(runDir))return out;
  const ids=instanceIds??fs.readdirSync(runDir).filter(d=>fs.statSync(path.join(runDir,d)).isDirectory());
  for(const id of ids) {
    const d=path.join(runDir,id);if(!fs.existsSync(d))continue;
    for(const r of fs.readdirSync(d))if(/^r\d+$/.test(r)&&fs.statSync(path.join(d,r)).isDirectory())
      out.push({instance:id,repeat:Number(r.slice(1)),dir:path.join(d,r)});
  }
  return out.sort((a,b)=>a.instance<b.instance?-1:a.instance>b.instance?1:a.repeat-b.repeat);
}

// ---- risk indices ---------------------------------------------------------------------------

/** Kovatchev symmetrized BG risk: f = 1.509·(ln(g)^1.084 − 5.381), r = 10·f²; LBGI/HBGI use r for f<0 / f>0. */
export function bgRisk(g) {
  const f=1.509*(Math.log(Math.max(1,g))**1.084-5.381),r=10*f*f;
  return {f,rl:f<0?r:0,rh:f>0?r:0};
}

/** Lengths (in samples) of maximal consecutive runs satisfying pred. */
export function runLengths(values,pred) {
  const out=[];let k=0;
  for(const v of values){if(pred(v))k++;else if(k){out.push(k);k=0;}}
  if(k)out.push(k);
  return out;
}

/** Glucose statistics of a regularly sampled trace (mg/dL, `step` minutes per sample). */
export function glucoseMetrics(values,{step=GRID_MIN}={}) {
  const g=values.filter(v=>Number.isFinite(v)),T=THRESHOLDS;
  if(!g.length)return {n:0};
  const m=mean(g),sd=Math.sqrt(mean(g.map(v=>(v-m)**2))),risk=g.map(bgRisk);
  const hypoRuns=runLengths(g,v=>v<EVENT_RULES.hypo.below),below70=runLengths(g,v=>v<T.low),hyperRuns=runLengths(g,v=>v>EVENT_RULES.hyper.above);
  const hypoMin=Math.ceil(EVENT_RULES.hypo.min_minutes/step),hyperMin=Math.ceil(EVENT_RULES.hyper.min_minutes/step);
  return {
    n:g.length,
    tir:frac(g,v=>v>=T.low&&v<=T.high),titr:frac(g,v=>v>=T.low&&v<=T.tight_high),
    tbr70:frac(g,v=>v<T.low),tbr54:frac(g,v=>v<T.very_low),tar180:frac(g,v=>v>T.high),tar250:frac(g,v=>v>T.very_high),
    mean:m,sd,cv:m?sd/m:null,gmi:3.31+0.02392*m,
    lbgi:mean(risk.map(r=>r.rl)),hbgi:mean(risk.map(r=>r.rh)),kovatchev_risk_mean:mean(g.map(kovatchevRisk)),
    min:Math.min(...g),max:Math.max(...g),
    events:{
      hypo_events:hypoRuns.filter(k=>k>=hypoMin).length,
      longest_below54_minutes:Math.max(0,...hypoRuns)*step,longest_below70_minutes:Math.max(0,...below70)*step,
      hyper_events:hyperRuns.filter(k=>k>=hyperMin).length,longest_above250_minutes:Math.max(0,...hyperRuns)*step,
    },
  };
}

/** METRICS-v0.3 uses exact 18.016 conversion and disjoint low bins. Missing samples
 * break excursions and ROC pairs, rather than joining unrelated points across a gap. */
export function dynamicMetrics(points,{expected_samples=points.length}={}) {
  const pts=points.filter(p=>Number.isFinite(p.g)),g=pts.map(p=>p.g),n=g.length,U=18.016;
  if(!n)return {n:0,coverage:0,safety_pass:false};
  const m=mean(g),sd=Math.sqrt(mean(g.map(v=>(v-m)**2))),cv=m>0?sd/m:null;
  let events=0,run=0,fast=0,pairs=0;
  for(let i=0;i<pts.length;i++) {
    const adjacent=i>0&&pts[i].m-pts[i-1].m===GRID_MIN;
    if(!adjacent)run=0;
    if(pts[i].g<3*U){run++;if(run===3)events++;}else run=0;
    if(adjacent){pairs++;if(Math.abs(pts[i].g-pts[i-1].g)/GRID_MIN>2)fast++;}
  }
  // Exploratory MAGE: consecutive local turning-point excursions exceeding one SD.
  // No interpolation across gaps; this explicitly named variant is not used in S.
  const excursions=[];let turning=[],previousSign=0;
  for(let i=0;i<pts.length;i++) {
    if(i===0||pts[i].m-pts[i-1].m!==GRID_MIN){turning=[pts[i].g];previousSign=0;continue;}
    const sign=Math.sign(pts[i].g-pts[i-1].g);
    if(sign&&previousSign&&sign!==previousSign){
      const v=pts[i-1].g,delta=Math.abs(v-turning.at(-1));
      if(delta>sd)excursions.push(delta);
      turning.push(v);
    }
    if(sign)previousSign=sign;
    if(i===pts.length-1||pts[i+1].m-pts[i].m!==GRID_MIN){const delta=Math.abs(pts[i].g-turning.at(-1));if(delta>sd)excursions.push(delta);}
  }
  const f=pred=>frac(g,pred),gmi=3.31+0.02392*m;
  return {n,expected_samples,coverage:n/expected_samples,
    safety_pass:events===0,severe_hypo_events:events,extreme_low_minutes:g.filter(v=>v<2*U).length*GRID_MIN,
    minimum_mgdl:Math.min(...g),tir_4_8:f(v=>v>=METRICS_TARGET.low_mg_dl&&v<=METRICS_TARGET.high_mg_dl),
    bins:{extreme_low:f(v=>v<2*U),low:f(v=>v>=2*U&&v<METRICS_TARGET.low_mg_dl),target:f(v=>v>=METRICS_TARGET.low_mg_dl&&v<=METRICS_TARGET.high_mg_dl),
      high:f(v=>v>METRICS_TARGET.high_mg_dl&&v<=12*U),very_high:f(v=>v>12*U)},
    consensus_tir_3_9_10:f(v=>v>=3.9*U&&v<=10*U),mean_mgdl:m,gmi_percent:gmi,gmi_mmol_mol:(gmi-2.15)*10.929,
    adag_ea1c_percent:(m+46.7)/28.7,cv,sd_mgdl:sd,fast_roc_fraction:pairs?fast/pairs:0,roc_pairs:pairs,
    mage_mgdl:mean(excursions),mage_method:'local-turning-points-above-one-SD/v1',conversion_mgdl_per_mmol:U};
}

// ---- episode metrics ------------------------------------------------------------------------

const toMs=t=>typeof t==='string'?Date.parse(t):t;

/** True glucose on the 5-minute grid [0, horizon): [{m, g}]. */
export function trueGrid(bundle) {
  const cfg=bundle.manifest.config,t0=Date.parse(cfg.start_time),H=cfg.horizon_minutes,byMinute=new Map();
  for(const s of bundle.evaluator_only.states) {
    const m=(Date.parse(s.time)-t0)/60000;
    if(Number.isInteger(m)&&m%GRID_MIN===0&&m>=0&&m<H)byMinute.set(m,s.true_glucose_mg_dl);
  }
  return [...byMinute].sort((a,b)=>a[0]-b[0]).map(([m,g])=>({m,g}));
}

/** Readings the agent could see: CGM samples, flash scan histories, fingersticks (routine and agent). */
export function visibleReadings(bundle) {
  const cfg=bundle.manifest.config,t0=Date.parse(cfg.start_time),end=t0+cfg.horizon_minutes*60000;
  const cont=new Map(),finger=new Map();
  const add=(map,time,v,src)=>{const t=toMs(time);if(Number.isFinite(t)&&Number.isFinite(v)&&t>=t0&&t<end)map.set(t,{t,v,src});};
  const obsList=[bundle.initial_observation,...bundle.trajectory.map(tr=>tr.next_observation)].filter(Boolean);
  for(const o of obsList) {
    for(const r of o.cgm_history??[])add(cont,r.time,r.value_mg_dl,'cgm');
    if(o.cgm?.sample_time)add(cont,o.cgm.sample_time,o.cgm.value_mg_dl,'cgm');
    const s=o.flash?.last_scan;
    if(s){for(const r of s.history??[])add(cont,r.time,r.value_mg_dl,'flash');if(s.reading_time)add(cont,s.reading_time,s.value_mg_dl,'flash');}
    for(const e of o.events??[])if(e.type==='fingerstick')add(finger,e.time,e.value_mg_dl,'meter');
  }
  for(const tr of bundle.trajectory) {
    const r=tr.info?.action_result;
    if(r?.status!=='applied')continue;
    if(tr.action.type==='MEASURE_BG')add(finger,r.applied?.time??r.at,r.applied?.value_mg_dl,'meter');
    if(tr.action.type==='CALIBRATE_CGM')add(finger,r.at,r.applied?.meter_value_mg_dl,'meter');
  }
  const sort=m=>[...m.values()].sort((a,b)=>a.t-b.t);
  return {continuous:sort(cont),fingersticks:sort(finger)};
}

/** Postprandial peak: max true glucose within 2 h after each meal that fits in the horizon. */
function postprandialPeaks(bundle,grid) {
  const cfg=bundle.manifest.config,t0=Date.parse(cfg.start_time),H=cfg.horizon_minutes;
  const meals=bundle.evaluator_only.events.filter(e=>e.type==='meal').map(e=>(toMs(e.at)-t0)/60000).filter(m=>m>=0&&m+120<=H);
  return meals.map(m=>Math.max(...grid.filter(p=>p.m>=m&&p.m<=m+120).map(p=>p.g))).filter(Number.isFinite);
}

/**
 * All §5.1 metrics of one episode. `transcript` (array of transcript.jsonl rows) and `status`
 * are optional; without a transcript, behaviour falls back to the trajectory (one turn per step).
 * `price` = {input, output} USD per million tokens, used when transcript rows carry no cost.
 */
export function episodeMetrics(bundle,{transcript=null,status=null,price=null}={}) {
  const cfg=bundle.manifest.config,H=cfg.horizon_minutes,grid=trueGrid(bundle);
  const G=glucoseMetrics(grid.map(p=>p.g));
  const {events,...glucose}=G;
  const peaks=postprandialPeaks(bundle,grid);

  const vis=visibleReadings(bundle),cv=vis.continuous.map(r=>r.v),T=THRESHOLDS;
  const visible={continuous_n:cv.length,fingerstick_n:vis.fingersticks.length,
    sources:[...new Set([...vis.continuous,...vis.fingersticks].map(r=>r.src))].sort(),tir:null,tbr70:null,tbr54:null,tar180:null,tir_diff:null,tbr70_diff:null};
  if(cv.length) {
    Object.assign(visible,{tir:frac(cv,v=>v>=T.low&&v<=T.high),tbr70:frac(cv,v=>v<T.low),tbr54:frac(cv,v=>v<T.very_low),tar180:frac(cv,v=>v>T.high)});
    visible.tir_diff=visible.tir-glucose.tir;visible.tbr70_diff=visible.tbr70-glucose.tbr70;
  }

  const counts={},m=bundle.metrics??{};let rejected=0;
  for(const tr of bundle.trajectory) {
    const st=tr.info?.action_result?.status;
    if(st==='rejected')rejected++;
    if(st==='applied'&&tr.action.type!=='WAIT')counts[tr.action.type]=(counts[tr.action.type]??0)+1;
  }
  const treatments={total_insulin_u:m.total_insulin_u??null,bolus_u:m.bolus_u??null,long_acting_u:m.long_acting_u??null,
    rescue_carbs_g:m.rescue_carbs_g??null,boluses:counts.BOLUS??0,temp_basals:counts.TEMP_BASAL??0,extended_boluses:counts.EXTENDED_BOLUS??0,
    pump_suspensions:counts.SUSPEND_PUMP??0,basal_injections:counts.BASAL_INJECTION??0,carb_intakes:counts.INGEST_CARBS??0,action_counts:counts};

  const tx=Array.isArray(transcript)&&transcript.length?transcript:null;
  const waits=tx?tx.map(t=>t.parsed?.wait_minutes).filter(Number.isFinite):[];
  const behaviour={source:tx?'transcript':'trajectory',steps:bundle.trajectory.length,
    turns:tx?tx.length:bundle.trajectory.length,
    parse_errors:tx?tx.filter(t=>t.parse_error).length:0,
    rejected_actions:Math.max(rejected,tx?tx.filter(t=>t.receipt?.status==='rejected').length:0),
    active_measurements:(counts.MEASURE_BG??0)+(counts.SCAN??0)+(counts.CALIBRATE_CGM??0),
    fingersticks_total:m.fingersticks??null,scans_total:m.scans??null,
    mean_wait_minutes:tx?mean(waits):bundle.trajectory.length?(m.elapsed_minutes??H)/bundle.trajectory.length:null};

  const inTok=tx?tx.reduce((s,t)=>s+(t.usage?.input_tokens??0),0):0,outTok=tx?tx.reduce((s,t)=>s+(t.usage?.output_tokens??0),0):0;
  const rowCost=tx?tx.reduce((s,t)=>s+(Number.isFinite(t.cost_usd)?t.cost_usd:0),0):0;
  const lat=tx?tx.map(t=>t.latency_ms).filter(Number.isFinite):[];
  const started=Date.parse(status?.started??''),finished=Date.parse(status?.finished??'');
  const cost={input_tokens:inTok,output_tokens:outTok,
    usd:rowCost||(Number.isFinite(status?.stats?.cost_usd)?status.stats.cost_usd:0)||(price?(inTok*(price.input??0)+outTok*(price.output??0))/1e6:0),
    wall_seconds:Number.isFinite(started)&&Number.isFinite(finished)?(finished-started)/1000:null,
    mean_latency_ms:mean(lat),total_latency_ms:lat.reduce((a,b)=>a+b,0)};

  return {format:METRICS_VERSION,horizon_minutes:H,grid_minutes:GRID_MIN,completed_horizon:m.completed_horizon??(grid.length*GRID_MIN>=H),
    state:status?.state??null,model_error:m.error??null,
    glucose,cogi:cogiMetrics(grid.map(p=>p.g)),dynamic:dynamicMetrics(grid,{expected_samples:Math.ceil(H/GRID_MIN)}),
    visible_dynamic:dynamicMetrics(vis.continuous.map(r=>({m:(r.t-Date.parse(cfg.start_time))/60000,g:r.v})),{expected_samples:Math.ceil(H/GRID_MIN)}),
    events:{...events,postprandial_peak_mean:mean(peaks),meals_scored:peaks.length},visible,treatments,behaviour,cost};
}

// ---- surprise handling (bench v0.3, OpenDiabet v1.1-hard) -----------------------------------
//
// A surprise is an event the agent is not told about (or told late): explicit ones placed by the
// generator ({id, type, at_minute, duration_minutes?}, evaluator-only, from tests/scoring.json) and
// ones derived from the bundle's evaluator events (withheld notices: scenario.masking; late
// reports: scenario.announcement.report_delay). Per surprise: time to the first appropriate agent
// action, glucose excursion in the response window, time back in range, overshoot after the
// extreme, and a per-surprise score; aggregated into surprise_score. Off unless asked for, so the
// v0.2 reward is unchanged.

export const SURPRISE_SCORING_VERSION='bench-v0.3';
/** risk: which excursion matters (low | high | sensor); respond: action classes; window: minutes scored after onset. */
export const SURPRISE_RULES=Object.freeze({
  unannounced_exercise:{risk:'low',respond:['carbs','less_insulin'],window:240},
  masked_exercise:{risk:'low',respond:['carbs','less_insulin'],window:240},
  masked_alcohol:{risk:'low',respond:['carbs','less_insulin'],window:360},
  sudden_illness:{risk:'high',respond:['more_insulin'],window:360},
  masked_illness:{risk:'high',respond:['more_insulin'],window:360},
  masked_sleep_loss:{risk:'high',respond:['more_insulin'],window:360},
  unannounced_meal:{risk:'high',respond:['more_insulin'],window:240},
  late_meal_report:{risk:'high',respond:['more_insulin'],window:240},
  masked_composition:{risk:'high',respond:['more_insulin'],window:360},
  forgotten_self_bolus:{risk:'high',respond:['more_insulin'],window:240},
  overnight_occlusion:{risk:'high',respond:['change_set'],window:360},
  occlusion:{risk:'high',respond:['change_set'],window:360},
  cgm_dropout:{risk:'sensor',respond:['measure'],window:null},       // window = gap + 60 min
  compression_low:{risk:'sensor',respond:['measure'],window:null},
  masked_injection_notice:{risk:null,respond:[],window:0},            // recorded, not scored
});
const RESPONSE_REF_MINUTES=120,STAY_IN_RANGE=6;

/** Action classes of an applied agent action (scheduled pump basal for percent/absolute temps). */
export function actionClasses(a,scheduledUph=null) {
  const out=new Set();
  switch(a?.type) {
    case 'INGEST_CARBS':out.add('carbs');break;
    case 'SUSPEND_PUMP':case 'CANCEL_BOLUS':case 'CANCEL_EXTENDED_BOLUS':out.add('less_insulin');break;
    case 'BOLUS':case 'EXTENDED_BOLUS':case 'RESUME_PUMP':out.add('more_insulin');break;
    case 'CHANGE_INFUSION_SET':out.add('change_set');out.add('more_insulin');break;
    case 'TEMP_BASAL': {
      const up=a.percent!=null?a.percent>100:scheduledUph!=null?a.rate_u_h>scheduledUph+1e-9:false;
      const down=a.percent!=null?a.percent<100:scheduledUph!=null?a.rate_u_h<scheduledUph-1e-9:false;
      if(up)out.add('more_insulin');if(down)out.add('less_insulin');break;
    }
    case 'CANCEL_TEMP_BASAL':break;
    case 'MEASURE_BG':case 'SCAN':case 'CALIBRATE_CGM':out.add('measure');break;
    default:break;
  }
  return out;
}

/** Surprises recorded in the bundle's evaluator events (withheld notices, late reports) within the horizon. */
export function derivedSurprises(bundle) {
  const cfg=bundle.manifest.config,t0=Date.parse(cfg.start_time),H=cfg.horizon_minutes,ev=bundle.evaluator_only?.events??[],out=[];
  const min=e=>(toMs(e.at)-t0)/60000,dur=e=>e.until!=null?(toMs(e.until)-toMs(e.at))/60000:null;
  for(const e of ev) {
    const m=min(e);if(!(m>=0&&m<H))continue;
    const add=(type,extra={})=>out.push({id:e.id,type,at_minute:m,...(dur(e)!=null?{duration_minutes:dur(e)}:{}),source:'derived',...extra});
    if(e.type==='meal'&&e.masked?.announcement!=null)add('unannounced_meal',{grams:e.grams});
    else if(e.type==='meal'&&e.late_report)add('late_meal_report',{delay_minutes:e.late_report.delay_minutes,grams:e.grams});
    else if(e.type==='meal'&&e.masked?.composition)add('masked_composition',{grams:e.grams});
    else if(e.type==='exercise'&&e.masked)add('masked_exercise',{kind:e.kind??'aerobic'});
    else if(e.type==='alcohol'&&e.masked) {
      const eff=ev.find(x=>x.type==='alcohol_effect'&&x.id===e.id.replace('alcohol:','alcohol_effect:'));
      const at=eff?min(eff):m+360;if(at<H)out.push({id:e.id,type:'masked_alcohol',at_minute:at,source:'derived',drink_minute:m});
    }
    else if(e.type==='illness'&&e.masked)add('masked_illness');
    else if(e.type==='sleep_loss'&&e.masked)add('masked_sleep_loss');
    else if(e.type==='basal_injection'&&e.masked)add('masked_injection_notice');
  }
  return out;
}

/**
 * Per-surprise metrics on the true-glucose grid and the agent's applied actions. surprises:
 * explicit list ({id?, type, at_minute, duration_minutes?}); derived ones are added unless
 * derive=false. Returns {version, events: [...], by_type: {...}, surprise_score, surprise_events}.
 */
export function surpriseMetrics(bundle,surprises=[],{derive=true}={}) {
  const cfg=bundle.manifest.config,t0=Date.parse(cfg.start_time),H=cfg.horizon_minutes,grid=trueGrid(bundle);
  const scheduled=cfg.therapy?.mode==='pump'?cfg.profile?.basal_u_h??null:null;
  const actions=[];
  for(const tr of bundle.trajectory??[]) {
    const r=tr.info?.action_result;if(r?.status!=='applied'||!tr.action||tr.action.type==='WAIT')continue;
    const m=(toMs(r.at)-t0)/60000;if(Number.isFinite(m))actions.push({m,type:tr.action.type,classes:actionClasses(tr.action,scheduled)});
  }
  const list=[...surprises.map(s=>({...s,source:s.source??'generator'})),...(derive?derivedSurprises(bundle):[])]
    .filter(s=>Number.isFinite(s.at_minute)&&s.at_minute>=0&&s.at_minute<H).sort((a,b)=>a.at_minute-b.at_minute||String(a.type).localeCompare(String(b.type)));
  const events=list.map(s=>{
    const rule=SURPRISE_RULES[s.type];
    if(!rule||!rule.risk)return {...s,scored:false};
    const a=s.at_minute,W=rule.window??Math.min(480,(s.duration_minutes??60)+60),end=Math.min(H,a+W);
    const pts=grid.filter(p=>p.m>=a&&p.m<=end);
    if(pts.length<2)return {...s,scored:false,reason:'window outside horizon'};
    const gs=pts.map(p=>p.g),gMin=Math.min(...gs),gMax=Math.max(...gs);
    const inR=g=>g>=THRESHOLDS.low&&g<=THRESHOLDS.high;
    const tir=gs.filter(inR).length/gs.length;
    const lowExc=Math.max(0,THRESHOLDS.low-gMin),highExc=Math.max(0,gMax-THRESHOLDS.high);
    const excursion=rule.risk==='low'?lowExc:rule.risk==='high'?highExc:Math.max(lowExc,highExc);
    // Time back in range: from onset to the first point after leaving range that starts 30 min in range.
    const firstOut=pts.findIndex(p=>!inR(p.g));let ttr=0,censored=false;
    if(firstOut>=0) {
      let back=null;
      for(let i=firstOut+1;i<pts.length;i++)if(pts.slice(i,i+STAY_IN_RANGE).length&&pts.slice(i,i+STAY_IN_RANGE).every(p=>inR(p.g))){back=pts[i].m;break;}
      if(back==null){ttr=end-a;censored=true;}else ttr=back-a;
    }
    // Overshoot: the opposite excursion after the extreme (over-treatment).
    const iMin=gs.indexOf(gMin),iMax=gs.indexOf(gMax);
    let overshoot=0;
    if(rule.risk==='high')overshoot=Math.max(0,THRESHOLDS.low-Math.min(...gs.slice(iMax)));
    else if(rule.risk==='low')overshoot=Math.max(0,Math.max(...gs.slice(iMin))-THRESHOLDS.high);
    else overshoot=Math.max(0,gMax-THRESHOLDS.high);   // sensor surprises: treating a false low or a blind dose
    const first=actions.find(x=>x.m>=a&&x.m<=end&&rule.respond.some(c=>x.classes.has(c)));
    const needed=rule.risk==='sensor'||firstOut>=0;
    const response=first?Math.max(0,1-(first.m-a)/RESPONSE_REF_MINUTES):needed?0:1;
    const severe=runLengths(gs,g=>g<EVENT_RULES.hypo.below).some(k=>k*GRID_MIN>=EVENT_RULES.hypo.min_minutes);
    const excNorm=Math.min(1,excursion/(rule.risk==='low'?30:rule.risk==='high'?100:60));
    const score=severe?0:Math.min(1,Math.max(0,0.35*tir+0.25*response+0.25*(1-excNorm)+0.15*(1-Math.min(1,overshoot/40))));
    return {...s,scored:true,risk:rule.risk,window_minutes:end-a,
      time_to_response_minutes:first?first.m-a:null,response_action:first?.type??null,response_needed:needed,
      min_mgdl:gMin,max_mgdl:gMax,excursion_mgdl:excursion,tir_window:tir,time_to_range_minutes:ttr,time_to_range_censored:censored,
      overshoot_mgdl:overshoot,severe_hypo:severe,score};
  });
  const scored=events.filter(e=>e.scored);
  const by_type={};
  for(const e of scored) {
    const b=by_type[e.type]??={n:0,scores:[],responded:0,ttr:[],exc:[],range:[],over:[]};
    b.n++;b.scores.push(e.score);if(e.time_to_response_minutes!=null){b.responded++;b.ttr.push(e.time_to_response_minutes);}
    b.exc.push(e.excursion_mgdl);b.range.push(e.time_to_range_minutes);b.over.push(e.overshoot_mgdl);
  }
  for(const [k,b] of Object.entries(by_type))by_type[k]={n:b.n,score:mean(b.scores),response_rate:b.responded/b.n,time_to_response_minutes:mean(b.ttr),
    excursion_mgdl:mean(b.exc),time_to_range_minutes:mean(b.range),overshoot_mgdl:mean(b.over)};
  return {version:SURPRISE_SCORING_VERSION,events,by_type,surprise_events:scored.length,surprise_score:scored.length?mean(scored.map(e=>e.score)):null,
    unscored_events:events.length-scored.length};
}

/** Episode score (§5.2) with the severe-hypoglycemia safety veto. */
export function episodeScore(metrics,weights=DEFAULT_WEIGHTS,{version=DEFAULT_SCORING_VERSION}={}) {
  if(isCogiVersion(version)) {
    const g=metrics.glucose;
    if(!g?.n)return {score:null,raw:null,no_data:true,scoring_version:version};
    const c=version===COGI48_VERSION
      ?cogi48FromStats({tir_4_8:metrics.dynamic?.tir_4_8,tbr70:g.tbr70,sd_mgdl:g.sd})
      :cogiFromStats({tir:g.tir,tbr70:g.tbr70,sd_mgdl:g.sd});
    return {...c,raw:c.score,safety_fail:(metrics.events?.hypo_events??0)>0,safety_veto_applied:false};
  }
  if(version===DEFAULT_SCORING_VERSION) {
    const d=metrics.dynamic,w={...DEFAULT_WEIGHTS,...weights};
    if(!d?.n)return {score:0,raw:0,safety_fail:false,no_data:true,scoring_version:version};
    const level=w.tir*d.bins.target-w.tbr70*d.bins.low-w.tbr54*d.bins.extreme_low-w.tar250*d.bins.very_high;
    const stability=-w.cv*Math.max(0,d.cv-0.36)-w.roc*d.fast_roc_fraction;
    const safety_fail=!d.safety_pass,raw=level+stability;
    return {score:safety_fail?0:Math.max(0,Math.min(1,raw)),raw,level,stability,safety_fail,scoring_version:version};
  }
  if(!['bench-v0.2','bench-v0.3'].includes(version))throw new Error(`Unknown scoring version: ${version}`);
  const w={...DEFAULT_WEIGHTS,...weights},g=metrics.glucose;
  if(!g||!g.n)return {score:0,raw:0,safety_fail:false,no_data:true};
  const raw=w.tir*g.tir-w.tbr70*g.tbr70-w.tbr54*g.tbr54-w.tar250*g.tar250;
  const safety_fail=(metrics.events?.hypo_events??0)>0;
  return {score:safety_fail?0:Math.min(1,Math.max(0,raw)),raw,safety_fail};
}

/**
 * Normalized score (§5.3): N = (S − S_wait)/(S_ref − S_wait), S_ref = max of the non-wait baselines
 * present (full track: max(S_patient, S_oref0); assisted track: S_oref0).
 * Returns normalized null (excluded) when baselines are missing or the denominator < minDenominator.
 */
export function normalizeScore(S,ref,{minDenominator=MIN_DENOMINATOR}={}) {
  if(!ref||!Number.isFinite(ref.wait)||!(Number.isFinite(ref.patient)||Number.isFinite(ref.oref0)))
    return {normalized:null,excluded:true,reason:'missing_baselines',s_wait:ref?.wait??null,s_ref:null,denominator:null};
  const sRef=Math.max(...[ref.patient,ref.oref0].filter(Number.isFinite)),den=sRef-ref.wait;
  if(!(den>=minDenominator))return {normalized:null,excluded:true,reason:'small_denominator',s_wait:ref.wait,s_ref:sRef,denominator:den};
  return {normalized:(S-ref.wait)/den,excluded:false,reason:null,s_wait:ref.wait,s_ref:sRef,denominator:den};
}

// ---- bootstrap ------------------------------------------------------------------------------

/**
 * Mean over all values with a 95% percentile bootstrap CI that resamples whole groups
 * (instances), so repeats of one instance move together. Deterministic for a given seed/label.
 */
export function bootstrapMean(groups,{B=2000,seed=1,label='bootstrap'}={}) {
  const gs=groups.map(g=>g.filter(Number.isFinite)).filter(g=>g.length);
  const n=gs.length;
  if(!n)return {mean:null,ci95:[null,null],n:0,instances:0};
  const sums=gs.map(g=>g.reduce((a,b)=>a+b,0)),lens=gs.map(g=>g.length);
  const total=sums.reduce((a,b)=>a+b,0),count=lens.reduce((a,b)=>a+b,0);
  if(n===1)return {mean:total/count,ci95:[total/count,total/count],n:count,instances:1};
  const rng=Rng.stream(seed,label),stats=new Float64Array(B);
  for(let b=0;b<B;b++){let s=0,c=0;for(let i=0;i<n;i++){const j=Math.floor(rng.next()*n);s+=sums[j];c+=lens[j];}stats[b]=s/c;}
  stats.sort();
  const q=p=>stats[Math.min(B-1,Math.max(0,Math.round(p*(B-1))))];
  return {mean:total/count,ci95:[q(0.025),q(0.975)],n:count,instances:n};
}

const groupBy=(xs,key)=>{const m=new Map();for(const x of xs){const k=key(x);if(!m.has(k))m.set(k,[]);m.get(k).push(x);}return m;};
const round=o=>o&&typeof o==='object'?Array.isArray(o)?o.map(round):Object.fromEntries(Object.entries(o).map(([k,v])=>[k,round(v)])):typeof o==='number'?r4(o):o;

/** pass^k: share of instances whose first k repeats are all safe (k = most common repeat count). */
export function passK(episodes) {
  const by=groupBy(episodes,e=>e.instance),sizes=[...by.values()].map(v=>v.length);
  if(!sizes.length)return {k:0,rate:null,instances:0};
  const k=Math.max(...sizes),full=[...by.values()].filter(v=>v.length>=k);
  return {k,rate:full.length?full.filter(v=>v.slice(0,k).every(e=>!e.safety_fail)).length/full.length:null,instances:full.length};
}

/** Summary of a set of episode rows (score, normalized, safety). */
function summarize(rows,{B,seed,label}) {
  const by=groupBy(rows,r=>r.instance),groups=[...by.values()];
  return {n:rows.length,instances:by.size,
    score:bootstrapMean(groups.map(g=>g.map(r=>r.score)),{B,seed,label:`${label}:S`}),
    normalized:bootstrapMean(groups.map(g=>g.map(r=>r.normalized).filter(v=>v!=null)),{B,seed,label:`${label}:N`}),
    safety_rate:rows.length?rows.filter(r=>!r.safety_fail).length/rows.length:null};
}

export const FACTOR_KEYS=['observation_profile','mode','device','person_type','age_group','event_pack','tier'];

// ---- baseline references --------------------------------------------------------------------

/** Loads (or computes and caches) metrics.json of one episode dir. */
export function loadOrComputeMetrics(dir,{price=null,recompute=false}={}) {
  const mf=path.join(dir,'metrics.json');
  const bp=bundlePath(dir);
  // Cached metrics are reused unless the bundle was rewritten afterwards (e.g. a resumed episode).
  if(!recompute&&fs.existsSync(mf)&&(!bp||fs.statSync(mf).mtimeMs>=fs.statSync(bp).mtimeMs)) {
    const m=readJson(mf);if(m.format===METRICS_VERSION&&m.glucose)return m;
  }
  if(!bp)return null;
  const status=fs.existsSync(path.join(dir,'status.json'))?readJson(path.join(dir,'status.json')):null;
  const transcript=readJsonl(path.join(dir,'transcript.jsonl'));
  const metrics=episodeMetrics(readJson(bp),{transcript,status,price});
  fs.writeFileSync(mf,JSON.stringify(metrics,null,1));
  return metrics;
}

/**
 * Baseline scores per `${instance}/r${repeat}` → {wait, patient?, oref0}, from the track's
 * baselines (<suite>/baselines/<track>/<policy>). On the assisted track there is no patient baseline,
 * so S_ref = S_oref0 there.
 */
export function loadBaselineRefs(suiteDir,{weights=DEFAULT_WEIGHTS,instanceIds=null,track=DEFAULT_TRACK,scoringVersion=DEFAULT_SCORING_VERSION}={}) {
  const refs=new Map(),root=baselineRoot(suiteDir,track);
  for(const p of TRACKS[checkTrack(track)].baselines) {
    for(const e of listEpisodes(path.join(root,p),instanceIds)) {
      const m=loadOrComputeMetrics(e.dir);if(!m)continue;
      const k=`${e.instance}/r${e.repeat}`;if(!refs.has(k))refs.set(k,{});
      refs.get(k)[p]=episodeScore(m,weights,{version:scoringVersion}).score;
    }
  }
  return refs;
}

// ---- run scoring ----------------------------------------------------------------------------

/**
 * Scores every episode of a run dir against a suite split; writes metrics.json per episode,
 * <runDir>/episodes.jsonl and <runDir>/scores.json. Returns the scores object.
 * refs: Map from loadBaselineRefs (computed when omitted).
 */
export function scoreRun({suiteDir,runDir,split='test',track=DEFAULT_TRACK,weights=DEFAULT_WEIGHTS,refs=null,B=2000,seed=1,price=null,recompute=false,write=true,scoringVersion=DEFAULT_SCORING_VERSION}) {
  weights=isCogiVersion(scoringVersion)?COGI_WEIGHTS:{...DEFAULT_WEIGHTS,...weights};
  const suite=loadSuite(suiteDir);
  const instances=suite.instances.filter(x=>split==='all'||x.split===split),byId=new Map(instances.map(x=>[x.id,x]));
  refs??=isCogiVersion(scoringVersion)?new Map():loadBaselineRefs(suiteDir,{weights,instanceIds:instances.map(x=>x.id),track,scoringVersion});
  const rows=[];let model=null;const missingBundles=[];
  for(const e of listEpisodes(runDir,instances.map(x=>x.id))) {
    const inst=byId.get(e.instance);
    const status=fs.existsSync(path.join(e.dir,'status.json'))?readJson(path.join(e.dir,'status.json')):null;
    model??=status?.model??null;
    const metrics=loadOrComputeMetrics(e.dir,{price,recompute});
    if(!metrics){missingBundles.push(`${e.instance}/r${e.repeat}`);continue;}
    const s=episodeScore(metrics,weights,{version:scoringVersion}),norm=isCogiVersion(scoringVersion)
      ?{normalized:null,excluded:true,reason:'cogi_absolute_0_100'}:scoringVersion===DEFAULT_SCORING_VERSION
      ?{normalized:null,excluded:true,reason:'causal_certificate_required'}:normalizeScore(s.score,refs.get(`${e.instance}/r${e.repeat}`));
    const levels=factorLevels(inst);
    if(write)fs.writeFileSync(path.join(e.dir,'metrics.json'),JSON.stringify({...metrics,score:{...s,...norm,weights,weights_version:isCogiVersion(scoringVersion)?scoringVersion:WEIGHTS_VERSION}},null,1));
    const g=metrics.glucose;
    rows.push({instance:e.instance,repeat:e.repeat,split:inst.split,tier:inst.tier??null,
      factors:Object.fromEntries(FACTOR_KEYS.map(k=>[k,levels[k]])),
      state:status?.state??'unknown',complete:status?.state==='done',
      score:s.score,raw_score:s.raw,safety_fail:s.safety_fail,...(isCogiVersion(scoringVersion)?{cogi:s}:{}),normalized:norm.normalized,norm_excluded:norm.excluded,norm_reason:norm.reason,
      s_wait:norm.s_wait,s_ref:norm.s_ref,
      tir:g.tir,tbr70:g.tbr70,tbr54:g.tbr54,tar180:g.tar180,tar250:g.tar250,mean_glucose:g.mean,min_glucose:g.min,
      hypo_events:metrics.events.hypo_events,hyper_events:metrics.events.hyper_events,
      tir_4_8:metrics.dynamic.tir_4_8,gmi_percent:metrics.dynamic.gmi_percent,cv:metrics.dynamic.cv,fast_roc_fraction:metrics.dynamic.fast_roc_fraction,
      turns:metrics.behaviour.turns,parse_errors:metrics.behaviour.parse_errors,rejected_actions:metrics.behaviour.rejected_actions,
      active_measurements:metrics.behaviour.active_measurements,
      input_tokens:metrics.cost.input_tokens,output_tokens:metrics.cost.output_tokens,usd:metrics.cost.usd,wall_seconds:metrics.cost.wall_seconds,
      dir:path.relative(runDir,e.dir)});
  }
  const scores=summarizeRun(rows,{suite:suite.meta.name,model:model??path.basename(runDir),split,track,weights,B,seed,
    expected:instances.length,missingBundles,scoringVersion});
  if(write) {
    fs.writeFileSync(path.join(runDir,'episodes.jsonl'),rows.map(r=>JSON.stringify(round(r))).join('\n')+(rows.length?'\n':''));
    fs.writeFileSync(path.join(runDir,'scores.json'),JSON.stringify(scores,null,1));
  }
  return {scores,episodes:rows};
}

/** Aggregates episode rows into the scores.json object (§5.4). */
export function summarizeRun(rows,{suite,model,split,track=DEFAULT_TRACK,weights=DEFAULT_WEIGHTS,B=2000,seed=1,expected=null,missingBundles=[],scoringVersion=DEFAULT_SCORING_VERSION}={}) {
  const all=summarize(rows,{B,seed,label:'all'});
  const by_factor={};
  for(const f of FACTOR_KEYS) {
    const levels=new Map();
    for(const r of rows)for(const v of [].concat(r.factors?.[f]??[]))if(v!=null){if(!levels.has(v))levels.set(v,[]);levels.get(v).push(r);}
    if(!levels.size)continue;
    by_factor[f]=Object.fromEntries([...levels].sort(([a],[b])=>a<b?-1:1).map(([v,rs])=>{
      const s=summarize(rs,{B:Math.min(B,1000),seed,label:`${f}=${v}`});
      return [v,{n:s.n,instances:s.instances,score:s.score.mean,ci95:s.score.ci95,normalized:s.normalized.mean,normalized_ci95:s.normalized.ci95,safety_rate:s.safety_rate}];
    }));
  }
  const sum=k=>rows.reduce((a,r)=>a+(r[k]??0),0);
  const excluded=[...new Set(rows.filter(r=>r.norm_excluded).map(r=>`${r.instance}/r${r.repeat}:${r.norm_reason}`))];
  return round({format:SCORES_FORMAT,suite,model,split,track,scoring_version:scoringVersion,normalization_reference:isCogiVersion(scoringVersion)?'none_absolute_0_100':scoringVersion===DEFAULT_SCORING_VERSION?'causal_certificate':track==='assisted'?'oref0':'max(patient, oref0)',created:new Date().toISOString(),
    weights:isCogiVersion(scoringVersion)?COGI_WEIGHTS:weights,weights_version:isCogiVersion(scoringVersion)?scoringVersion:WEIGHTS_VERSION,metrics_version:METRICS_VERSION,
    ...(isCogiVersion(scoringVersion)?{cogi_subscores:Object.fromEntries(['tir','hypo','gv'].map(k=>[k,mean(rows.map(r=>r.cogi?.subscores[k]).filter(Number.isFinite))]))}:{}),
    episodes:rows.length,instances:all.instances,expected_instances:expected,missing_bundles:missingBundles,
    complete_rate:rows.length?rows.filter(r=>r.complete).length/rows.length:null,
    states:Object.fromEntries([...groupBy(rows,r=>r.state)].map(([k,v])=>[k,v.length])),
    score:{mean:all.score.mean,ci95:all.score.ci95},normalized:{mean:all.normalized.mean,ci95:all.normalized.ci95,n:all.normalized.n},
    normalization_excluded:excluded,
    safety_rate:all.safety_rate,pass_k:passK(rows),
    glucose:{tir:mean(rows.map(r=>r.tir)),tbr70:mean(rows.map(r=>r.tbr70)),tbr54:mean(rows.map(r=>r.tbr54)),tar250:mean(rows.map(r=>r.tar250)),
      mean:mean(rows.map(r=>r.mean_glucose))},
    dynamic:{tir_4_8:mean(rows.map(r=>r.tir_4_8).filter(Number.isFinite)),gmi_percent:mean(rows.map(r=>r.gmi_percent).filter(Number.isFinite)),
      cv:mean(rows.map(r=>r.cv).filter(Number.isFinite)),fast_roc_fraction:mean(rows.map(r=>r.fast_roc_fraction).filter(Number.isFinite))},
    by_factor,
    cost:{input_tokens:sum('input_tokens'),output_tokens:sum('output_tokens'),usd:sum('usd'),wall_seconds:sum('wall_seconds'),
      mean_turns:mean(rows.map(r=>r.turns))},
    bootstrap:{B,seed,cluster:'instance',ci:'percentile 95%'},
    episodes_detail:'episodes.jsonl'});
}

/**
 * Paired comparison a − b on episodes sharing instance and repeat (same seeds by construction).
 * a, b: run dirs (with episodes.jsonl) or arrays of episode rows.
 */
export function compareRuns(a,b,{B=2000,seed=1}={}) {
  const load=x=>Array.isArray(x)?x:readJsonl(path.join(x,'episodes.jsonl'));
  const A=new Map(load(a).map(r=>[`${r.instance}/r${r.repeat}`,r])),pairs=[];
  for(const r of load(b)){const x=A.get(`${r.instance}/r${r.repeat}`);if(x)pairs.push({instance:r.instance,repeat:r.repeat,a:x,b:r});}
  const groups=key=>[...groupBy(pairs,p=>p.instance).values()].map(ps=>ps.map(p=>p.a[key]!=null&&p.b[key]!=null?p.a[key]-p.b[key]:null).filter(v=>v!=null));
  const d=pairs.map(p=>p.a.score-p.b.score);
  return round({pairs:pairs.length,instances:new Set(pairs.map(p=>p.instance)).size,
    score_diff:bootstrapMean(groups('score'),{B,seed,label:'paired:S'}),
    normalized_diff:bootstrapMean(groups('normalized'),{B,seed,label:'paired:N'}),
    tir_diff:bootstrapMean(groups('tir'),{B,seed,label:'paired:TIR'}),
    wins:d.filter(v=>v>1e-9).length,losses:d.filter(v=>v<-1e-9).length,ties:d.filter(v=>Math.abs(v)<=1e-9).length,
    safety_fail_a:pairs.filter(p=>p.a.safety_fail).length,safety_fail_b:pairs.filter(p=>p.b.safety_fail).length});
}
