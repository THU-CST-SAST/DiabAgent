// Bench HTML report (docs/BENCH.zh-CN.md §1, §5.4): one self-contained page per suite with, per
// track (full / assisted, ranked separately), a leaderboard over every scored run (baselines and
// models), per-factor heatmaps, suite
// composition and the worst episodes of each run, linked to generated player pages
// (scripts/video/player.html with the selected run records inlined).
// Glucose values are shown in mmol/L by default with a mg/dL toggle (data stays in mg/dL).
import fs from 'node:fs';
import path from 'node:path';
import {loadSuite,baselineRoot} from './suite.mjs';
import {readJson,readJsonl,FACTOR_KEYS,DEFAULT_SCORING_VERSION} from './score.mjs';
import {TRACKS,TRACK_IDS,DEFAULT_TRACK} from './tracks.mjs';

const PLAYER_DIR=new URL('../../scripts/video/',import.meta.url);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slug=s=>String(s).replace(/[^A-Za-z0-9._-]+/g,'_');
const f3=v=>v==null||!Number.isFinite(v)?'–':v.toFixed(3);
const pct=v=>v==null||!Number.isFinite(v)?'–':(v*100).toFixed(1)+'%';
const ci=c=>c&&c[0]!=null?`[${f3(c[0])}, ${f3(c[1])}]`:'';
const glu=v=>v==null||!Number.isFinite(v)?'–':`<span class="g" data-mgdl="${v}">${(v/18.016).toFixed(1)}</span>`;

/** Player page with the given run records inlined (same injection as scripts/demo-video.mjs page()). */
export function playerPage(runs) {
  const read=f=>fs.readFileSync(new URL(f,PLAYER_DIR),'utf8');
  return read('player.html').replace('<script>/*RUNS*/</script>',()=>`<script>window.RUNS=${JSON.stringify(runs).replace(/</g,'\\u003c')};</script>`)
    .replace('<script src="player.js"></script>',()=>`<script>${read('player.js')}</script>`);
}

/**
 * Scored runs of one track: the track's baselines (<suite>/baselines/<track>/<policy>) and model runs
 * (<runsDir>/<track>/<model>): [{name, kind, track, dir, scores, episodes}].
 */
export function collectRuns(suiteDir,runsDir,track=DEFAULT_TRACK) {
  const out=[];
  const add=(name,kind,dir)=>{const f=path.join(dir,'scores.json');if(fs.existsSync(f))out.push({name,kind,track,dir,scores:readJson(f),episodes:readJsonl(path.join(dir,'episodes.jsonl'))});};
  for(const p of TRACKS[track].baselines)add(`baseline:${p}`,'baseline',path.join(baselineRoot(suiteDir,track),p));
  const dir=runsDir&&path.join(runsDir,track);
  if(dir&&fs.existsSync(dir))for(const d of fs.readdirSync(dir).sort())if(fs.statSync(path.join(dir,d)).isDirectory())add(d,'model',path.join(dir,d));
  return out;
}

const heat=v=>{
  if(v==null||!Number.isFinite(v))return 'background:#f3f4f6;color:#6b7280';
  const t=Math.max(0,Math.min(1,v)),mix=(a,b)=>Math.round(a+(b-a)*t);
  return `background:rgb(${mix(238,23)},${mix(244,84)},${mix(251,158)});color:${t>0.55?'#fff':'#1f2328'}`;
};

/**
 * Writes the report. split: only runs scored on this split are ranked (others are listed).
 * worst: episodes per run in the failure table. Returns {out, runs, players}.
 */
export function buildReport({suiteDir,runsDir,out,split='test',worst=5,tracks=TRACK_IDS,scoringVersion=DEFAULT_SCORING_VERSION}) {
  const suite=loadSuite(suiteDir),outDir=path.dirname(out);
  fs.mkdirSync(path.join(outDir,'players'),{recursive:true});
  const inst=new Map(suite.instances.map(x=>[x.id,x]));
  let players=0;const ranked=[];let w=null;
  const sections=tracks.map(track=>{
  const all=collectRuns(suiteDir,runsDir,track),compatible=r=>r.scores.split===split&&(r.scores.scoring_version??'bench-v0.2')===scoringVersion;
  const runs=all.filter(compatible),skipped=all.filter(r=>!compatible(r));
  runs.sort((a,b)=>(b.scores.score.mean??-1)-(a.scores.score.mean??-1));
  ranked.push(...runs.map(r=>`${track}/${r.name}`));w??=runs[0]?.scores;

  // Leaderboard
  const lb=runs.map((r,i)=>{const s=r.scores;return `<tr><td>${i+1}</td><td><b>${esc(r.name)}</b><div class="muted">${r.kind}</div></td>
    <td class="num">${f3(s.score.mean)}<div class="muted">${ci(s.score.ci95)}</div></td>
    <td class="num">${f3(s.normalized.mean)}<div class="muted">${ci(s.normalized.ci95)}</div></td>
    <td class="num">${pct(s.safety_rate)}</td><td class="num">${pct(s.pass_k?.rate)}<div class="muted">k=${s.pass_k?.k??'–'}</div></td>
    <td class="num">${pct(s.complete_rate)}</td><td class="num">${pct(s.glucose?.tir)}</td><td class="num">${pct(s.glucose?.tbr70)}</td>
    <td class="num">${pct(s.glucose?.tbr54)}</td><td class="num">${glu(s.glucose?.mean)}</td>
    <td class="num">${s.episodes}</td><td class="num">${s.cost?.mean_turns!=null?s.cost.mean_turns.toFixed(1):'–'}</td>
    <td class="num">${s.cost?.usd?'$'+s.cost.usd.toFixed(2):'–'}<div class="muted">${s.cost?.input_tokens?`${(s.cost.input_tokens/1e6).toFixed(2)}M in / ${(s.cost.output_tokens/1e6).toFixed(2)}M out`:''}</div></td></tr>`;}).join('');

  // Per-factor heatmaps (score mean; tooltip with CI, N, safety)
  const factorTables=FACTOR_KEYS.map(f=>{
    const levels=[...new Set(runs.flatMap(r=>Object.keys(r.scores.by_factor?.[f]??{})))].sort();
    if(!levels.length)return '';
    const rows=levels.map(v=>`<tr><th>${esc(v)}</th>${runs.map(r=>{const c=r.scores.by_factor[f]?.[v];
      if(!c)return '<td class="cell" style="background:#f3f4f6">–</td>';
      const tip=`${r.name} · ${f}=${v}\nS ${f3(c.score)} ${ci(c.ci95)}\nN ${f3(c.normalized)} ${ci(c.normalized_ci95)}\nsafety ${pct(c.safety_rate)} · ${c.n} episodes / ${c.instances} instances`;
      return `<td class="cell" style="${heat(c.score)}" title="${esc(tip)}">${f3(c.score)}<span class="n">${c.n}</span></td>`;}).join('')}</tr>`).join('');
    return `<div><h4>${esc(f)}</h4><table class="heat"><thead><tr><th></th>${runs.map(r=>`<th>${esc(r.name)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join('');

  // Worst episodes + player pages
  const worstSections=runs.map(r=>{
    const eps=[...r.episodes].sort((a,b)=>a.score-b.score||(b.tbr54??0)-(a.tbr54??0)||(a.tir??0)-(b.tir??0)).slice(0,worst);
    const recs=[];
    for(const e of eps) {
      const f=path.join(r.dir,e.dir??path.join(e.instance,`r${e.repeat}`),'run.json');
      if(fs.existsSync(f)){const run=readJson(f);run.id=`${e.instance}-r${e.repeat}`;recs.push(run);}
    }
    const page=`players/${slug(track)}_${slug(r.name)}.html`;
    if(recs.length){fs.writeFileSync(path.join(outDir,page),playerPage(recs));players++;}
    const rows=eps.map(e=>{const x=inst.get(e.instance),fx=x?.factors??{};
      const link=recs.some(q=>q.id===`${e.instance}-r${e.repeat}`)?`<a class="play" data-href="${page}?id=${encodeURIComponent(`${e.instance}-r${e.repeat}`)}" href="${page}?id=${encodeURIComponent(`${e.instance}-r${e.repeat}`)}">回放</a>`:'';
      return `<tr><td>${esc(e.instance)} r${e.repeat}</td><td>${esc(fx.observation_profile)}</td><td>${esc(fx.mode==='pump'?fx.pump:'pen')}</td>
        <td>${esc(fx.person_type)}</td><td>${esc((fx.event_packs??[]).join(', ')||'–')}</td><td>${esc(e.tier??'')}</td>
        <td class="num">${f3(e.score)}${e.safety_fail?' <span class="bad">safety</span>':''}</td><td class="num">${f3(e.normalized)}</td>
        <td class="num">${pct(e.tir)}</td><td class="num">${pct(e.tbr70)}</td><td class="num">${glu(e.min_glucose)}</td><td class="num">${e.hypo_events??'–'}</td>
        <td>${esc(e.state)}</td><td>${link}</td></tr>`;}).join('');
    const excl=r.scores.normalization_excluded?.length?`<details><summary>${r.scores.normalization_excluded.length} episode(s) excluded from N (denominator &lt; 0.05 or missing baselines)</summary><p class="muted">${esc(r.scores.normalization_excluded.join(', '))}</p></details>`:'';
    return `<h4>${esc(r.name)}</h4><table><thead><tr><th>episode</th><th>observation</th><th>device</th><th>person</th><th>event packs</th><th>tier</th>
      <th>S</th><th>N</th><th>TIR</th><th>TBR&lt;<span class="th" data-mgdl="70">3.9</span></th><th>min <span class="u">mmol/L</span></th><th>hypo events</th><th>state</th><th></th></tr></thead><tbody>${rows}</tbody></table>${excl}`;
  }).join('');

  const ref=track==='assisted'?'S_oref0 (the loop on top of the person; no scripted patient baseline on this track)':'max(S_patient, S_oref0)';
  return `<h2 id="track-${esc(track)}">赛道 ${esc(track)} · ${esc(TRACKS[track].label)}</h2>
<p class="muted">self_care = <b>${esc(TRACKS[track].self_care)}</b>; baselines ${esc(TRACKS[track].baselines.join(' / '))}; N reference = ${esc(ref)}.</p>
<h3>排行榜 Leaderboard</h3>
<table><thead><tr><th>#</th><th>run</th><th>S</th><th>N</th><th>safety</th><th>pass^k</th><th>complete</th><th>TIR</th><th>TBR&lt;<span class="th" data-mgdl="70">3.9</span></th><th>TBR&lt;<span class="th" data-mgdl="54">3.0</span></th><th>mean <span class="u">mmol/L</span></th><th>episodes</th><th>turns</th><th>cost</th></tr></thead><tbody>${lb||'<tr><td colspan="14">no scored runs for this split</td></tr>'}</tbody></table>
${skipped.length?`<p class="muted">Scored on other splits (not ranked): ${skipped.map(r=>`${esc(r.name)} (${esc(r.scores.split)})`).join(', ')}</p>`:''}
<h3>分维度 Score by factor</h3><p class="muted">Cell = mean S (small number: episodes). Hover for CI, N and safety rate. Event packs overlap (an instance counts under each of its packs).</p>
<div class="factors">${factorTables}</div>
<h3>最差回合 Worst episodes</h3><p class="muted">Lowest S per run; “回放” opens the episode in the player (true glucose, readings, treatments, events).</p>
${worstSections}`;
  }).join('\n');

  // Suite composition (selected split)
  const ins=suite.instances.filter(x=>split==='all'||x.split===split);
  const countBy=fn=>{const m={};for(const x of ins)for(const v of [].concat(fn(x)))m[v]=(m[v]??0)+1;return Object.entries(m).sort(([a],[b])=>a<b?-1:1);};
  const comp=[['observation_profile',x=>x.factors.observation_profile],['mode',x=>x.factors.mode],['device',x=>x.factors.mode==='pump'?x.factors.pump:'pen'],
    ['person_type',x=>x.factors.person_type],['event_pack',x=>x.factors.event_packs.length?x.factors.event_packs:['none']],['tier',x=>x.tier??'–']]
    .map(([k,fn])=>`<div class="comp"><b>${k}</b>${countBy(fn).map(([v,n])=>`<div><span>${esc(v)}</span><span class="num">${n}</span></div>`).join('')}</div>`).join('');

  const m=suite.meta;
  const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Sweet-Sim Bench · ${esc(m.name)}</title>
<style>
body{margin:0;padding:24px 32px;font:14px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;color:#1f2328;background:#fff}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 8px;border-bottom:1px solid #e5e7eb;padding-bottom:4px}h3{font-size:15px;margin:22px 0 6px}h4{font-size:14px;margin:16px 0 6px}
.muted{color:#6b7280;font-size:12px}table{border-collapse:collapse;margin:4px 0 8px}th,td{padding:5px 8px;border-bottom:1px solid #eef0f3;text-align:left;vertical-align:top}
thead th{font-weight:600;color:#4b5563;font-size:12px;border-bottom:1px solid #d1d5db}.num{text-align:right;font-variant-numeric:tabular-nums}
.heat td.cell{text-align:right;min-width:86px;font-variant-numeric:tabular-nums;border:2px solid #fff}.heat .n{font-size:10px;opacity:.75;margin-left:6px}
.heat th{white-space:nowrap}.bad{color:#b42318;font-size:11px;font-weight:600}.comps{display:flex;flex-wrap:wrap;gap:24px}
.factors{display:flex;flex-wrap:wrap;gap:8px 40px;align-items:flex-start}.comp{min-width:180px}.comp div{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid #f3f4f6}
.bar{display:flex;gap:16px;align-items:center;flex-wrap:wrap}select{font:inherit;padding:2px 6px}a.play{color:#1f5fa8}
</style></head><body>
<div class="bar"><div><h1>Sweet-Sim Bench · ${esc(m.name)}</h1>
<div class="muted">split <b>${esc(split)}</b> · ${ins.length} instances · ${m.hours} h · commit ${esc(m.sweet_sim_commit??'?')}${m.sweet_sim_dirty?' (dirty)':''} · knowledge ${esc(String(m.knowledge_sha256).slice(0,12))} · kernel ${esc(String(m.kernel_sha256).slice(0,12))} · generated ${new Date().toISOString()}</div></div>
<label style="margin-left:auto">单位 <select id="units"><option value="mmol">mmol/L</option><option value="mgdl">mg/dL</option></select></label></div>
<p class="muted">Scoring ${esc(scoringVersion)}. ${scoringVersion===DEFAULT_SCORING_VERSION
  ?'S = clip(T(4–8) − 1.5*T(2–4) − 4*T(&lt;2) − 0.5*T(&gt;12) − 0.5*max(0,CV−0.36) − 0.5*T(|ROC|&gt;2mg/dL/min),0,1). Bins in mmol/L are disjoint; severe low &lt;3 mmol/L for 15 minutes vetoes S. N requires a newly certified causal reference. Legacy TIR columns below mean 70–180 mg/dL only.'
  :'Legacy S = clip(TIR70–180 − 1.5*TBR&lt;70 − 4*TBR&lt;54 − 0.5*TAR&gt;250,0,1), severe-low veto. N=(S−S_wait)/(S_ref−S_wait).'}
Only the selected scoring version is ranked; different versions are not comparable. 95% CIs: instance-clustered bootstrap. Weights ${esc(w?.weights_version??'')}.
Tracks are ranked separately: ${tracks.map(t=>`<a href="#track-${esc(t)}">${esc(t)}</a>`).join(' · ')}.</p>
${scoringVersion===DEFAULT_SCORING_VERSION?`<h2>METRICS-v0.3</h2><table><tr><th>Run</th><th>Safety</th><th>S</th><th>TIR4–8</th><th>GMI%</th><th>CV</th><th>Fast ROC</th></tr>${tracks.flatMap(track=>collectRuns(suiteDir,runsDir,track).filter(r=>r.scores.split===split&&r.scores.scoring_version===scoringVersion).map(r=>{const s=r.scores;return `<tr><td>${esc(track+'/'+r.name)}</td><td>${pct(s.safety_rate)}</td><td>${f3(s.score.mean)}</td><td>${pct(s.dynamic?.tir_4_8)}</td><td>${f3(s.dynamic?.gmi_percent)}</td><td>${pct(s.dynamic?.cv)}</td><td>${pct(s.dynamic?.fast_roc_fraction)}</td></tr>`;})).join('')}</table>`:''}
${sections}
<h2>测试集构成 Suite composition (${esc(split)})</h2><div class="comps">${comp}</div>
<p class="muted">Quotas ${m.quota_check?.ok?'met':'NOT met: '+esc((m.quota_check?.failures??[]).join('; '))} · screening dropped ${m.screening?.dropped?.length??0} instance(s) in ${m.screening?.rounds??0} round(s).</p>
<script>
(function(){
  var K=18.016,sel=document.getElementById('units'),u=localStorage.getItem('sweet-sim-units')||'mmol';
  function render(){
    document.querySelectorAll('.g').forEach(function(e){var v=Number(e.dataset.mgdl);e.textContent=u==='mmol'?(v/K).toFixed(1):String(Math.round(v));});
    document.querySelectorAll('.th').forEach(function(e){var v=Number(e.dataset.mgdl);e.textContent=u==='mmol'?(v/K).toFixed(1):String(v);});
    document.querySelectorAll('.u').forEach(function(e){e.textContent=u==='mmol'?'mmol/L':'mg/dL';});
    document.querySelectorAll('a.play').forEach(function(a){a.href=a.dataset.href+'&units='+u;});
  }
  sel.value=u;sel.onchange=function(){u=sel.value;localStorage.setItem('sweet-sim-units',u);render();};render();
})();
</script></body></html>`;
  fs.writeFileSync(out,html);
  return {out,runs:ranked,players};
}
