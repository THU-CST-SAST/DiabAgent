// Certified adversarial generation of OpenDiabet v1.1-hard (docs/OPENDIABET-V1.zh-CN.md §6).
//
// For every cell (task x backend x setting x seed index) K hard candidates are drawn
// (src/opendiabet/hard.mjs). Each candidate is screened on the full track with the cheap
// references (wait, patient, oref0) and the causal decider with `fast` settings; then, best
// candidates first, the causal decider with full settings (the information-matched smartest
// reference) produces the certificate. A candidate is certified when S_causal >= causalMin (it is
// solvable from visible information). Among certified candidates the one where the ordinary agents
// do worst wins: hardness = 1 - max(S_patient, S_oref0) (assisted track: 1 - S_oref0), preferring
// max(patient, oref0) <= ordinaryMax. When no candidate reaches causalMin the cell keeps the
// candidate with the best causal score, marked uncertified; when the omniscient decider is far
// above causal on it, the reason is `hidden_information_only` (solvable only with hidden
// information, i.e. unfair).
import fs from 'node:fs';
import path from 'node:path';
import {runJobs} from './references.mjs';
import {TASK_IDS} from './tasks.mjs';
import {BACKEND_IDS,SETTINGS,envIdOf} from './generate.mjs';

export const CERT_DEFAULTS=Object.freeze({candidates:6,causalMin:0.95,ordinaryMax:0.6,screenCausalMin:0.85,finalTries:3,unfairGap:0.1,
  omniscient:true,screenLabels:['wait','patient','oref0','causal-fast']});
export const ORDINARY=Object.freeze({full:['patient','oref0'],assisted:['oref0']});
const fin=v=>typeof v==='number'&&Number.isFinite(v);

/** max(S) of the ordinary agents of a track (null when none is known). */
export function ordinaryScore(scores,track='full') {
  const v=ORDINARY[track].map(p=>scores?.[p]).filter(fin);
  return v.length?Math.max(...v):null;
}
export const hardnessOf=(scores,track='full')=>{const o=ordinaryScore(scores,track);return o==null?null:1-o;};

/**
 * The certificate decision on numbers alone (testable). cands: [{k, scores: {wait, patient, oref0,
 * 'causal-fast'?, causal?, omniscient?}}]; `causal` is the full-settings certificate run.
 * Returns {chosen (k), certified, meets_ordinary, ordinary, hardness, causal, reason, candidates: [...]}.
 */
export function certifyDecision(cands,{track='full',causalMin=CERT_DEFAULTS.causalMin,ordinaryMax=CERT_DEFAULTS.ordinaryMax,unfairGap=CERT_DEFAULTS.unfairGap}={}) {
  const rows=cands.map(c=>{
    const causal=fin(c.scores?.causal)?c.scores.causal:null,ord=ordinaryScore(c.scores,track),om=c.scores?.omniscient;
    let status;
    if(causal==null)status='not_certified_run';
    else if(causal>=causalMin)status='certified';
    else status=fin(om)&&om-causal>unfairGap?'hidden_information_only':'causal_below_threshold';
    return {k:c.k,causal,causal_fast:c.scores?.['causal-fast']??null,omniscient:fin(om)?om:null,ordinary:ord,hardness:ord==null?null:1-ord,
      meets_ordinary:ord!=null&&ord<=ordinaryMax,status};
  });
  const ok=rows.filter(r=>r.status==='certified');
  const byHard=(a,b)=>(b.meets_ordinary-a.meets_ordinary)||((b.hardness??-1)-(a.hardness??-1))||((b.causal??0)-(a.causal??0))||a.k-b.k;
  let pick,certified;
  if(ok.length){pick=[...ok].sort(byHard)[0];certified=true;}
  else {
    const scored=rows.filter(r=>r.causal!=null);
    pick=(scored.length?scored:rows).sort((a,b)=>((b.causal??b.causal_fast??0)-(a.causal??a.causal_fast??0))||((b.hardness??-1)-(a.hardness??-1))||a.k-b.k)[0];
    certified=false;
  }
  const reason=certified?(pick.meets_ordinary?'certified_and_hard':'certified_ordinary_above_max')
    :pick?.status==='hidden_information_only'?'hidden_information_only':'no_candidate_reached_causal_min';
  return {chosen:pick?.k??null,certified,meets_ordinary:!!pick?.meets_ordinary,ordinary:pick?.ordinary??null,hardness:pick?.hardness??null,
    causal:pick?.causal??null,reason,candidates:rows.sort((a,b)=>a.k-b.k)};
}

/**
 * Order in which candidates get the full causal run: candidates whose fast causal reaches
 * screenCausalMin first (ordinary <= max first, then hardest), then the rest by fast causal.
 */
export function finalOrder(screened,{track='full',screenCausalMin=CERT_DEFAULTS.screenCausalMin,ordinaryMax=CERT_DEFAULTS.ordinaryMax}={}) {
  const rows=screened.map(s=>({k:s.k,fast:s.scores['causal-fast']??0,ord:ordinaryScore(s.scores,track)}));
  const good=rows.filter(r=>r.fast>=screenCausalMin).sort((a,b)=>((b.ord!=null&&b.ord<=ordinaryMax)-(a.ord!=null&&a.ord<=ordinaryMax))||((a.ord??1)-(b.ord??1))||b.fast-a.fast||a.k-b.k);
  const rest=rows.filter(r=>r.fast<screenCausalMin).sort((a,b)=>b.fast-a.fast||((a.ord??1)-(b.ord??1))||a.k-b.k);
  return [...good,...rest].map(r=>r.k);
}

export function cellsOf({tasks=TASK_IDS,backends=BACKEND_IDS,settings=SETTINGS,seeds=1}={}) {
  const out=[];
  for(const task of tasks)for(const backend of backends)for(const setting of settings)for(let s=1;s<=seeds;s++)
    out.push({task,backend,setting,seedIndex:s,env_id:envIdOf(task,backend,setting,s)});
  return out;
}

/**
 * Runs the certification for cells. Returns {envs (chosen, with env.certificate), cells: {[env_id]:
 * {decision, screened, final}}, assisted: {[env_id]: {...}} | null, timing}.
 * opts: candidates, causalMin, ordinaryMax, screenCausalMin, finalTries, unfairGap, omniscient, assistedOmniscient,
 * tracks (['full'] or ['full','assisted']), cacheDir, parallel, budgetSeconds (stop launching new
 * final rounds after this), log, onProgress.
 */
export async function certifyCells(cells,opts={}) {
  const o={...CERT_DEFAULTS,...opts},log=o.log??(()=>{}),t0=performance.now(),secs=()=>(performance.now()-t0)/1000;
  const tracks=o.tracks??['full'],cacheDir=o.cacheDir,parallel=o.parallel;
  const timing={};
  const progress=label=>(r,i)=>o.onProgress?.({label,result:r,i});
  // 1. Screen: K candidates x cheap references + fast causal (full track).
  const screenJobs=[];
  for(const c of cells)for(let k=0;k<o.candidates;k++)screenJobs.push({kind:'hard-screen',...c,k,track:'full',labels:o.screenLabels,cacheDir});
  let n=0;
  const screened=await runJobs(screenJobs,{parallel,onResult:r=>{n++;if(n%50===0||n===screenJobs.length)log(`screen ${n}/${screenJobs.length} (${secs().toFixed(0)} s)`);progress('screen')(r);}});
  timing.screen_s=secs();
  const byCell=new Map(cells.map(c=>[c.env_id,{cell:c,screened:[],final:{}}]));
  const failed=[];
  screened.forEach(s=>{if(s.failed){failed.push(s);log(`candidate failed: ${s.env_id} c${s.k}: ${s.failed.split('\n')[0]}`);return;}
    byCell.get(s.env.env_id).screened.push({k:s.env.hard.candidate,env:s.env,scores:{...s.scores},results:s.results});});
  for(const [id,x] of byCell)if(!x.screened.length)throw new Error(`${id}: every candidate failed (${failed.filter(f=>f.env_id===id).map(f=>f.failed.split('\n')[0]).join(' | ')})`);
  // 2. Certificates: full-settings causal, best candidates first, up to finalTries rounds.
  for(const x of byCell.values())x.order=finalOrder(x.screened,{screenCausalMin:o.screenCausalMin,ordinaryMax:o.ordinaryMax});
  for(let round=0;round<o.finalTries;round++) {
    if(o.budgetSeconds&&secs()>o.budgetSeconds){log(`budget reached before final round ${round}`);break;}
    const jobs=[];
    for(const x of byCell.values()) {
      const done=Object.values(x.final).some(f=>f.score>=o.causalMin);
      if(done||round>=x.order.length)continue;
      const k=x.order[round],s=x.screened.find(y=>y.k===k);
      jobs.push({kind:'hard-episode',env:s.env,track:'full',label:'causal',cacheDir,keep:true});
    }
    if(!jobs.length)break;
    let m=0;
    const res=await runJobs(jobs,{parallel,onResult:r=>{m++;if(m%25===0||m===jobs.length)log(`certificate round ${round}: ${m}/${jobs.length} (${secs().toFixed(0)} s)`);}});
    res.forEach(r=>{if(r.failed){failed.push(r);log(`certificate run failed: ${r.env_id} c${r.k}: ${r.failed.split('\n')[0]}`);return;}
      const x=byCell.get(r.env_id);x.final[r.k]=r;x.screened.find(y=>y.k===r.k).scores.causal=r.score;});
    log(`certificate round ${round}: ${res.filter(r=>r.score>=o.causalMin).length}/${res.length} reached ${o.causalMin}`);
  }
  timing.certificates_s=secs()-timing.screen_s;
  // 3. Omniscient (fast) on the chosen candidate (and uncertified best ones: unfairness check).
  const decide=x=>certifyDecision(x.screened.map(s=>({k:s.k,scores:s.scores})),{causalMin:o.causalMin,ordinaryMax:o.ordinaryMax,unfairGap:o.unfairGap});
  if(o.omniscient) {
    const jobs=[...byCell.values()].map(x=>{const d=decide(x),s=x.screened.find(y=>y.k===d.chosen);return {kind:'hard-episode',env:s.env,track:'full',label:'omniscient',cacheDir,keep:true};});
    let m=0;
    const res=await runJobs(jobs,{parallel,onResult:()=>{m++;if(m%25===0||m===jobs.length)log(`omniscient ${m}/${jobs.length} (${secs().toFixed(0)} s)`);}});
    res.forEach(r=>{if(r.failed){failed.push(r);return;}byCell.get(r.env_id).screened.find(y=>y.k===r.k).scores.omniscient=r.score;});
    timing.omniscient_s=secs()-timing.screen_s-timing.certificates_s;
  }
  const envs=[],cellsOut={};
  for(const [id,x] of byCell) {
    const d=decide(x),s=x.screened.find(y=>y.k===d.chosen),f=x.final[d.chosen]??null;
    const certificate={track:'full',policy:'causal',settings:'full',score:s.scores.causal??null,certified:d.certified,meets_ordinary:d.meets_ordinary,
      reason:d.reason,ordinary:d.ordinary,hardness:d.hardness,causal_min:o.causalMin,ordinary_max:o.ordinaryMax,
      references:Object.fromEntries(Object.entries(s.scores).filter(([,v])=>fin(v)).map(([k,v])=>[k,Number(v.toFixed(4))])),
      files_dir:f?.dir??null,candidates_evaluated:x.screened.length,certificate_runs:Object.keys(x.final).length};
    envs.push({...s.env,certificate:{full:certificate}});
    cellsOut[id]={decision:d,order:x.order,screened:x.screened.map(y=>({k:y.k,intensity:y.env.hard.intensity,scores:y.scores,
      knobs:y.env.hard.knobs,surprises:y.env.hard.surprises.map(z=>z.type)}))};
  }
  // 4. Assisted track on the chosen environments: wait, oref0, causal (full settings, kept), omniscient.
  let assisted=null;
  if(tracks.includes('assisted')) {
    const labels=['wait','oref0','causal',...(o.omniscient&&o.assistedOmniscient!==false?['omniscient']:[])],jobs=[];
    for(const e of envs)for(const label of labels)jobs.push({kind:'hard-episode',env:e,track:'assisted',label,cacheDir,keep:label==='causal'||label==='omniscient'});
    jobs.sort((a,b)=>(b.label==='omniscient')-(a.label==='omniscient')||(b.label==='causal')-(a.label==='causal'));
    let m=0;const t1=secs();
    const res=await runJobs(jobs,{parallel,onResult:()=>{m++;if(m%50===0||m===jobs.length)log(`assisted ${m}/${jobs.length} (${secs().toFixed(0)} s)`);}});
    assisted={};
    for(const r of res){if(r.failed){failed.push(r);continue;}(assisted[r.env_id]??={scores:{},dirs:{}}).scores[r.label]=r.score;assisted[r.env_id].dirs[r.label]=r.dir;}
    for(const e of envs) {
      const a=assisted[e.env_id]??{scores:{},dirs:{}},causal=a.scores.causal??null,ord=ordinaryScore(a.scores,'assisted');
      e.certificate.assisted={track:'assisted',policy:'causal',settings:'full',score:causal,certified:causal!=null&&causal>=o.causalMin,
        meets_ordinary:ord!=null&&ord<=o.ordinaryMax,ordinary:ord,hardness:ord==null?null:1-ord,
        reason:causal>=o.causalMin?(ord<=o.ordinaryMax?'certified_and_hard':'certified_ordinary_above_max')
          :fin(a.scores.omniscient)&&a.scores.omniscient-causal>o.unfairGap?'hidden_information_only':'causal_below_threshold',
        references:Object.fromEntries(Object.entries(a.scores).map(([k,v])=>[k,Number(v.toFixed(4))])),files_dir:a.dirs.causal};
    }
    timing.assisted_s=secs()-t1;
  }
  timing.total_s=secs();
  return {envs,cells:cellsOut,assisted,timing,failed:failed.map(f=>({env_id:f.env_id,k:f.k,kind:f.kind,track:f.track,label:f.label,error:f.failed.split('\n')[0]})),
    options:{...o,log:undefined,onProgress:undefined}};
}

/** Copies the certificate files (causal run.json, bundle, decisions, result) into outDir/certificates/<env>/<track>/. */
export function storeCertificates(outDir,envs) {
  const out={};
  for(const e of envs)for(const [track,c] of Object.entries(e.certificate??{})) {
    if(!c.files_dir||!fs.existsSync(c.files_dir))continue;
    const dest=path.join(outDir,'certificates',e.env_id,track);fs.mkdirSync(dest,{recursive:true});
    for(const f of ['result.json','run.json','bundle.json.gz','decisions.json.gz'])if(fs.existsSync(path.join(c.files_dir,f)))fs.copyFileSync(path.join(c.files_dir,f),path.join(dest,f));
    (out[e.env_id]??={})[track]=path.relative(outDir,dest);
  }
  return out;
}
