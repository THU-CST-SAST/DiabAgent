// Sections of the validation report (scripts/validation-report.mjs), one per experiment in the
// numbering of docs/PLAN-v2.zh-CN.md: Exp0 default set (+ v1.1-hard), Exp1 observation, Exp2 time,
// Exp3 assisted vs autonomous, Exp4 backends / insulins, Exp5 Real2Sim, Exp6 Sim2Real.
// Every section returns {id, num, title, status, headline, html}; inputs that do not exist yet turn
// into "pending" checks carrying the command that produces them.
import fs from 'node:fs';
import path from 'node:path';
import {readJson,readJsonl,listDir,exists,mtime,fin,mean,bootMean,spearman,esc,f2,f3,sgn3,pct,ci,mmol} from './util.mjs';
import {dotPlot,lineChart,forest,histogram,legend,colorOf,labelOf} from './charts.mjs';
import {analyzeLadders,agentOrder} from './paired.mjs';

// ---- shared rendering ---------------------------------------------------------------------------
const BADGE={pass:'PASS',fail:'FAIL',weak:'WEAK',pending:'PENDING',running:'RUNNING',partial:'PARTIAL',info:'INFO'};
export const badge=(s,t)=>`<span class="badge b-${s}">${esc(t??BADGE[s]??s)}</span>`;
/** Overall status of a list of check statuses. */
export function combine(ss) {
  const s=ss.filter(x=>x&&x!=='info');
  if(!s.length)return 'pending';
  if(s.includes('fail'))return 'fail';
  if(s.every(x=>x==='pass'))return 'pass';
  if(s.every(x=>x==='pending'||x==='running'))return s.includes('running')?'running':'pending';
  if(s.some(x=>x==='pending'||x==='running'))return 'partial';
  return 'weak';
}
const checksHtml=checks=>`<table class="checks"><thead><tr><th>status</th><th>validation criterion</th><th>evidence</th></tr></thead><tbody>${
  checks.map(c=>`<tr><td>${badge(c.status)}</td><td>${c.label}</td><td>${c.evidence??''}</td></tr>`).join('')}</tbody></table>`;
const cmdHtml=cmds=>`<pre class="cmd">${cmds.map(c=>c.startsWith('#')?`<span class="cm">${esc(c)}</span>`:esc(c)).join('\n')}</pre>`;
const artifactsHtml=(ctx,list)=>`<ul class="arts">${list.map(a=>{const ok=exists(path.join(ctx.root,a.path));
  return `<li>${ok?`<a href="${esc(ctx.href(a.path))}">${esc(a.path)}</a>`:`<code>${esc(a.path)}</code> <span class="miss">missing</span>`}${a.note?` <span class="mut">— ${a.note}</span>`:''}</li>`;}).join('')}</ul>`;
function table(head,rows,{sortable=false,cls='',scroll=false}={}) {
  return `<div class="tw${scroll?' scroll':''}"><table class="data ${cls}${sortable?' sortable':''}"><thead><tr>${head.map(h=>`<th${typeof h==='object'&&h.num?' class="n"':''}>${esc(typeof h==='object'?h.t:h)}</th>`).join('')}</tr></thead><tbody>${
    rows.map(r=>`<tr>${r.map(c=>{if(c&&typeof c==='object'&&'html' in c)return `<td${c.num?' class="n"':''}${c.v!=null?` data-v="${esc(c.v)}"`:''}>${c.html}</td>`;
      const num=fin(c);return `<td${num?` class="n" data-v="${c}"`:''}>${num?f3(c):esc(c??'–')}</td>`;}).join('')}</tr>`).join('')}</tbody></table></div>`;
}
const pendingBlock=(what,cmds)=>`<div class="pending"><b>Pending / not run yet:</b> ${what}${cmds?cmdHtml(cmds):''}</div>`;
const details=(summary,body,open=false)=>`<details${open?' open':''}><summary>${summary}</summary>${body}</details>`;
const numCell=(v,html)=>({html:html??f3(v),v:fin(v)?v:'',num:true});
const linkCell=(href,text)=>({html:href?`<a href="${esc(href)}">${esc(text)}</a>`:'–'});
const verdictStatus=v=>v==='expected'||v==='differs'?'pass':v==='reversed'?'fail':v==='insufficient'?'pending':'weak';
function section({id,num,title,question,status,headline,checks,run,artifacts,body,ctx}) {
  return {id,num,title,status,headline,html:`<section id="${id}" class="exp"><h2><span class="num">${esc(num)}</span> ${esc(title)} ${badge(status)}</h2>
<p class="q">${question}</p>
<div class="grid2"><div><h3>Validation criteria</h3>${checksHtml(checks)}</div>
<div><h3>How to run</h3>${cmdHtml(run)}<h3>Artifacts</h3>${artifactsHtml(ctx,artifacts)}</div></div>
${body}</section>`};
}

// ---- jobs ---------------------------------------------------------------------------------------
/** Scans artifacts/benchmarks/jobs (+ extra job dirs): config, result, trial.json of every trial dir. */
export function scanJobs(root,extra=[]) {
  const base=path.join(root,'artifacts','benchmarks','jobs');
  const dirs=[...listDir(base).filter(d=>d.isDirectory()).map(d=>path.join(base,d.name)),...extra.map(d=>path.resolve(root,d))];
  const jobs=new Map();
  for(const dir of dirs) {
    const config=readJson(path.join(dir,'config.json'));
    const trials=[],counts={done:0,agent_failed:0,infra_failed:0,other:0,incomplete:0};let newest=0;
    for(const d of listDir(dir)) {
      if(!d.isDirectory()||!d.name.includes('__'))continue;
      const f=path.join(dir,d.name,'trial.json'),t=readJson(f);
      if(!t){counts.incomplete++;continue;}
      newest=Math.max(newest,mtime(f)??0);
      const s=t.status;if(s in counts&&s!=='incomplete')counts[s]++;else counts.other++;
      trials.push({...t,trial_id:t.trial_id??d.name,_dir:path.relative(root,path.join(dir,d.name))});
    }
    const id=config?.job_id??path.basename(dir);
    jobs.set(id,{id,dir:path.relative(root,dir),config,result:readJson(path.join(dir,'result.json')),trials,counts,newest,
      paired:exists(path.join(dir,'paired-analysis','analysis.json'))?path.relative(root,path.join(dir,'paired-analysis')):null});
  }
  return jobs;
}
const NEW_NUMBER={'mvp2-exp1-exp2':'Exp3 (full + assisted tracks)','mvp-exp1-exp2':'Exp3 (superseded by mvp2)','mvp2-exp3':'Exp2 (time / adaptive)',
  'opendiabet-exp3':'Exp2 (superseded by mvp2)','mvp2-exp4':'Exp5/6 (Real→Sim→Real MVP)','mvp-exp4':'Exp5/6 (superseded by mvp2)','opendiabet-mvp':'MVP smoke'};
export function jobsSection(ctx) {
  const rows=[...ctx.jobs.values()].sort((a,b)=>a.id.localeCompare(b.id)).map(j=>{
    const n=j.trials.length+j.counts.incomplete,bench=j.config?.benchmark??'?';
    const exp=NEW_NUMBER[j.id]??(bench==='exp1-obs-scaling'?'Exp1':bench==='exp4-backends'?'Exp4':/^exp2/.test(j.id)?'Exp2':'');
    return [{html:`<a href="${esc(ctx.href(j.dir))}">${esc(j.id)}</a>`},bench,exp,j.config?.created?.slice(0,16).replace('T',' ')??'–',
      {html:String(n),num:true,v:n},{html:String(j.counts.done),num:true,v:j.counts.done},{html:j.counts.agent_failed?`<b class="warn">${j.counts.agent_failed}</b>`:'0',num:true,v:j.counts.agent_failed},
      {html:j.counts.infra_failed?`<b class="warn">${j.counts.infra_failed}</b>`:'0',num:true,v:j.counts.infra_failed},{html:String(j.counts.other+j.counts.incomplete),num:true,v:j.counts.other+j.counts.incomplete},
      {html:j.result?`<a href="${esc(ctx.href(path.join(j.dir,'summary.html')))}">summary</a>`:j.paired?`<a href="${esc(ctx.href(path.join(j.paired,'summary.html')))}">paired analysis</a>`:'–'}];});
  return `<section id="jobs" class="exp"><h2>Jobs and trial status</h2>
<p class="q">Every job directory under <code>artifacts/benchmarks/jobs</code>. Status per trial from <code>trial.json</code>: done = agent reached the horizon;
agent_failed = crash / gave up / timeout (verifier still scored); infra_failed = harness problem (no score); other / incomplete = running or without trial.json.
Old MVP job names use the old numbering; the column "experiment" maps them to the new one.</p>
${table(['job','benchmark','experiment (new numbering)','created (UTC)',{t:'trials',num:true},{t:'done',num:true},{t:'agent_failed',num:true},{t:'infra_failed',num:true},{t:'other / incomplete',num:true},'report'],rows,{sortable:true})}</section>`;
}
const statusLine=j=>`${j.trials.length+j.counts.incomplete} trials: ${j.counts.done} done, ${j.counts.agent_failed} agent_failed, ${j.counts.infra_failed} infra_failed${j.counts.other+j.counts.incomplete?`, ${j.counts.other+j.counts.incomplete} other/incomplete`:''}`;

// ---- Exp0: default set v1 + v1.1-hard ------------------------------------------------------------
const V1='artifacts/benchmarks/opendiabet-v1',HARD='artifacts/benchmarks/opendiabet-v1.1-hard';
/** Loads v1 references, environments and task cards (null when references.json is missing). */
export function loadV1(root) {
  const ref=readJson(path.join(root,V1,'references.json'));
  if(!ref)return null;
  const envs=new Map(readJsonl(path.join(root,V1,'environments.jsonl')).map(e=>[e.env_id,e]));
  const cards=new Map();
  for(const d of listDir(path.join(root,V1,'task-cards')))if(d.name.endsWith('.json')){const c=readJson(path.join(root,V1,'task-cards',d.name));if(c)cards.set(c.id,c);}
  const info=id=>{const e=envs.get(id)??{},c=cards.get(e.task)??{};const m=/^(T\d+)-(\w+?)-(clean|randomized)-s(\d+)$/.exec(id)??[];
    return {task:e.task??m[1],title:c.title?.en??'',category:c.category_title?.en??e.category??'?',backend:e.backend??m[2],setting:e.setting??m[3],split:e.split??'',person:e.factors?.person_type??''};};
  return {ref,envs,cards,info};
}
const groupMeans=(ids,scores,policies,key)=>{const g=new Map();for(const id of ids){const k=key(id);(g.get(k)??g.set(k,[]).get(k)).push(id);}
  return [...g.entries()].map(([k,xs])=>({label:k,n:xs.length,values:Object.fromEntries(policies.map(p=>[p,mean(xs.map(id=>scores[id]?.[p]))]))}));};

export function exp0Section(ctx) {
  const v1=ctx.v1,run=['# generate the 200 environments (25 tasks x 4 backends x 2 settings), task cards, coverage.html, catalog.md',
    'node scripts/opendiabet.mjs generate --track full,assisted','# reference policies on every environment and track (cached under artifacts/opendiabet/runs, resumable)',
    'node scripts/opendiabet.mjs references --tracks full,assisted --parallel 6'];
  const artifacts=[{path:`${V1}/references.json`,note:'reference scores, tiers, re-draws'},{path:`${V1}/coverage.html`,note:'coverage report'},
    {path:`${V1}/catalog.md`,note:'one line per environment'},{path:`${V1}/environments.jsonl`},{path:`${V1}/task-cards`,note:'T01–T25'}];
  const question='Under the default, realistic setting (partial observation, sensor error, unannounced meals, background events), is the v1 set well posed: is the ceiling reachable (omniscient high), is it non-trivial (doing nothing scores low), and is there headroom between the visible-information reference (causal) and the ceiling? Units: bench score S in 0–1.';
  if(!v1)return section({id:'exp0',num:'Exp0',title:'Default set (OpenDiabet v1)',question,status:'pending',headline:'references.json missing',ctx,run,artifacts,
    checks:[{label:'reference scores exist',status:'pending',evidence:`${V1}/references.json not found`}],body:pendingBlock('reference scores',run)});
  const {ref,info}=v1,checks=[],parts=[];
  const trackStats={};
  for(const track of Object.keys(ref.tracks??{})) {
    const sc=ref.tracks[track],ids=Object.keys(sc),pols=ref.policies?.[track]??Object.keys(sc[ids[0]]??{});
    const m=Object.fromEntries(pols.map(p=>[p,bootMean(ids.map(id=>sc[id]?.[p]),{seed:11})]));
    const missing=ids.filter(id=>pols.some(p=>!fin(sc[id]?.[p]))).length;
    trackStats[track]={ids,pols,m,missing};
  }
  const F=trackStats.full,A=trackStats.assisted;
  if(F) {
    const sc=ref.tracks.full,om=F.m.omniscient?.mean,wt=F.m.wait?.mean,ca=F.m.causal?.mean;
    const degenerate=F.ids.filter(id=>sc[id].wait>=0.98||Math.max(...F.pols.filter(p=>p!=='wait').map(p=>sc[id][p]))<=0.02).length;
    const headroom=F.ids.filter(id=>sc[id].causal<sc[id].omniscient-0.01).length;
    const ordinary=mean(F.ids.map(id=>Math.max(sc[id].patient??-1,sc[id].oref0??-1)));
    checks.push({label:'Ceiling reachable (full): mean S<sub>omniscient</sub> ≥ 0.90',status:om>=0.9?'pass':'fail',evidence:`${f3(om)} ${ci(F.m.omniscient.lo,F.m.omniscient.hi)}; min ${f3(Math.min(...F.ids.map(id=>sc[id].omniscient)))}`});
    checks.push({label:'Not trivial (full): mean S<sub>wait</sub> ≤ 0.60 and no degenerate env (S<sub>wait</sub> ≥ 0.98 or every reference ≤ 0.02)',status:wt<=0.6&&degenerate===0?'pass':'fail',
      evidence:`wait ${f3(wt)}; degenerate ${degenerate}/${F.ids.length}; re-draws applied ${(ref.redraws??[]).length}`});
    checks.push({label:'Headroom (full): S<sub>causal</sub> &lt; S<sub>omniscient</sub> and ordinary agents (max of patient, oref0) well below the ceiling',status:ca<om&&om-ordinary>=0.1?'pass':'weak',
      evidence:`causal ${f3(ca)} vs omniscient ${f3(om)} (gap ${f3(om-ca)}; causal below ceiling in ${headroom}/${F.ids.length} envs); ordinary ${f3(ordinary)} (gap ${f3(om-ordinary)})`});
    const order=['wait','oref0','causal','omniscient'].map(p=>F.m[p]?.mean);
    checks.push({label:'Reference ladder (full): wait &lt; oref0 &lt; causal ≤ omniscient, patient &lt; causal',status:order.every((v,i)=>i===0||v>=order[i-1])&&F.m.patient?.mean<ca?'pass':'fail',
      evidence:F.pols.map(p=>`${p} ${f3(F.m[p].mean)}`).join(' · ')});
    checks.push({label:'Complete: every environment has every reference score (both tracks)',status:F.missing+(A?.missing??0)===0?'pass':'fail',
      evidence:`full ${F.ids.length} envs, ${F.missing} incomplete${A?`; assisted ${A.ids.length} envs, ${A.missing} incomplete`:''}`});
  }
  if(A) {
    const om=A.m.omniscient?.mean,wt=A.m.wait?.mean;
    checks.push({label:'Assisted track headroom over the patient alone (wait = patient self-care): S<sub>omniscient</sub> − S<sub>wait</sub> ≥ 0.10',status:om-wt>=0.1?'pass':'weak',
      evidence:`omniscient ${f3(om)} − wait ${f3(wt)} = ${f3(om-wt)}; causal ${f3(A.m.causal?.mean)}`});
  }
  const hard=hardPart(ctx);
  checks.push(...hard.checks);
  checks.push({label:'LLM runs on the default set',status:ctx.llmJobs.length?'info':'pending',evidence:ctx.llmJobs.length?ctx.llmJobs.join(', '):'none yet (no job with an llm: agent)'});

  // charts: per track policy means, by category, by backend / setting, distributions
  const tierCount={};for(const t of Object.values(ref.tiers??{}))tierCount[t]=(tierCount[t]??0)+1;
  parts.push(`<h3>Per-track means (bootstrap 95% CI over environments)</h3>`,table(['track',{t:'envs',num:true},...['wait','patient','oref0','causal','omniscient'].map(p=>({t:p,num:true}))],
    Object.entries(trackStats).map(([t,s])=>[t,{html:String(s.ids.length),num:true},...['wait','patient','oref0','causal','omniscient'].map(p=>s.m[p]?{html:`${f3(s.m[p].mean)} <span class="mut">${ci(s.m[p].lo,s.m[p].hi)}</span>`,num:true,v:s.m[p].mean}:{html:'n/a',num:true})])));
  parts.push(`<p class="mut">patient is not defined on the assisted track (it would bolus announced meals twice); there, wait = the patient's own self-care.</p>`);
  parts.push(`<div class="tiles">${['easy','medium','hard'].map(t=>`<div class="tile"><div class="tv">${tierCount[t]??0}</div><div class="tl">${t} tier</div></div>`).join('')}
<div class="tile"><div class="tv">${(ref.redraws??[]).length}</div><div class="tl">degenerate re-draws</div></div><div class="tile"><div class="tv">${Array.isArray(ref.degenerate_kept)?ref.degenerate_kept.length:typeof ref.degenerate_kept==='object'&&ref.degenerate_kept?Object.keys(ref.degenerate_kept).length:ref.degenerate_kept??0}</div><div class="tl">degenerate kept</div></div></div>`);
  for(const [track,s] of Object.entries(trackStats)) {
    const sc=ref.tracks[track];
    const cat=groupMeans(s.ids,sc,s.pols,id=>info(id).category).sort((a,b)=>(a.values.causal??0)-(b.values.causal??0));
    const be=[...groupMeans(s.ids,sc,s.pols,id=>info(id).backend),...groupMeans(s.ids,sc,s.pols,id=>`setting: ${info(id).setting}`)];
    parts.push(`<h3>${esc(track)} track — mean S by task category</h3>`,dotPlot({rows:cat,series:s.pols,title:`${track} by category`}),
      `<h3>${esc(track)} track — mean S by backend and setting</h3>`,dotPlot({rows:be,series:s.pols,title:`${track} by backend`,xLabel:'mean score S (0–1)'}),
      details('table view',table(['group',{t:'n',num:true},...s.pols.map(p=>({t:p,num:true}))],[...cat,...be].map(r=>[r.label,{html:String(r.n),num:true},...s.pols.map(p=>numCell(r.values[p]))]))));
  }
  if(F)parts.push(`<h3>full track — distribution of per-environment scores</h3><div class="multiples">${F.pols.map(p=>histogram({values:F.ids.map(id=>ref.tracks.full[id][p]),key:p,title:p})).join('')}</div>`);
  // per-env sortable table
  const pl=ctx.exp0Players;
  const envRows=(F?.ids??[]).map(id=>{const i=info(id),f=ref.tracks.full?.[id]??{},a=ref.tracks.assisted?.[id]??{};
    const links=[pl.full?`<a href="${esc(pl.full)}?id=${encodeURIComponent(`${id}-causal-r0`)}">causal</a> · <a href="${esc(pl.full)}?id=${encodeURIComponent(`${id}-omniscient-r0`)}">omni</a>`:'',
      pl.assisted?`<a href="${esc(pl.assisted)}?id=${encodeURIComponent(`${id}-causal-r0`)}">assisted</a>`:''].filter(Boolean).join(' · ');
    return [{html:`<code>${esc(id)}</code>`,v:id},i.title,i.category,i.backend,i.setting,i.split,ref.tiers?.[id]??'–',
      ...['wait','patient','oref0','causal','omniscient'].map(p=>numCell(f[p])),numCell(fin(f.omniscient)&&fin(f.causal)?f.omniscient-f.causal:null),
      ...['wait','oref0','causal','omniscient'].map(p=>numCell(a[p])),{html:links||'–'}];});
  parts.push(`<h3>Per-environment table <span class="mut">(click a column header to sort; players: causal / omniscient run records)</span></h3>`,
    table(['env','task','category','backend','setting','split','tier','full wait','full patient','full oref0','full causal','full omni','omni − causal','asst wait','asst oref0','asst causal','asst omni','player'],envRows,{sortable:true,cls:'small',scroll:true}));
  parts.push(`<p>Links: <a href="${esc(ctx.href(`${V1}/coverage.html`))}">coverage.html</a> · <a href="${esc(ctx.href(`${V1}/catalog.md`))}">catalog.md</a> · <a href="${esc(ctx.href(`${V1}/references.json`))}">references.json</a></p>`);
  parts.push(hard.html);
  const status=combine(checks.map(c=>c.status));
  return section({id:'exp0',num:'Exp0',title:'Default set (OpenDiabet v1) + v1.1-hard',question,status,ctx,run:[...run,...hard.run],artifacts:[...artifacts,...hard.artifacts],checks,
    headline:F?`full: omniscient ${f2(F.m.omniscient?.mean)}, causal ${f2(F.m.causal?.mean)}, wait ${f2(F.m.wait?.mean)}; hard: ${hard.headline}`:'',body:parts.join('\n')});
}

function hardPart(ctx) {
  const root=ctx.root,cert=readJson(path.join(root,HARD,'certification.json')),href=readJson(path.join(root,HARD,'references.json'));
  const run=['# v1.1-hard: 6 candidates per cell, screened (wait/patient/oref0/fast causal), certified with full causal (S >= 0.95)',
    'node scripts/opendiabet.mjs generate-hard --out artifacts/benchmarks/opendiabet-v1.1-hard --candidates 6 --parallel 6 --tracks full'];
  const artifacts=[{path:`${HARD}/certification.json`,note:'counts, uncertified cells, v1 vs hard comparison'},{path:`${HARD}/coverage.html`},{path:`${HARD}/comparison.md`},{path:'artifacts/opendiabet/hard-runs',note:'candidate cache (progress while running)'}];
  const parts=['<h3 id="exp0-hard">v1.1-hard certified set</h3>'],checks=[];let headline='';
  const running=ctx.running.filter(p=>p.includes('generate-hard'));
  if(cert) {
    for(const [track,c] of Object.entries(cert.counts??{})) {
      const a=c.all?.all??c.all??{},n=a.n??0,cn=a.certified??0,fr=n?cn/n:0;
      checks.push({label:`v1.1-hard (${esc(track)}): every cell certified solvable (S<sub>causal</sub> ≥ ${cert.options?.causalMin??0.95})`,status:fr===1?'pass':fr>=0.8?'weak':'fail',
        evidence:`${cn}/${n} certified (${pct(fr)}); ordinary ≤ ${cert.options?.ordinaryMax??0.6}: ${a.meets_ordinary??'–'}; both ${a.both??'–'}; uncertified listed in certification.json`});
      headline+=`${track} ${cn}/${n} certified `;
      const cmp=cert.comparison?.[track];
      if(cmp?.overall){const o=Object.values(cmp.overall)[0]??{},ordV1=Math.max(o.v1?.patient??-1,o.v1?.oref0??-1),ordH=Math.max(o.hard?.patient??-1,o.hard?.oref0??-1);
        checks.push({label:`v1.1-hard (${esc(track)}) is harder for ordinary agents than v1 (mean max(patient, oref0) drops ≥ 0.10)`,status:ordV1-ordH>=0.1?'pass':ordV1>ordH?'weak':'fail',
          evidence:`v1 ${f3(ordV1)} → hard ${f3(ordH)}`});
        const pols=Object.keys(o.v1??{});
        parts.push(table(['group',{t:'n',num:true},...pols.flatMap(p=>[{t:`${p} v1`,num:true},{t:`${p} hard`,num:true}])],
          ['overall','by_setting','by_backend','by_category'].flatMap(sec=>Object.entries(cmp[sec]??{}).map(([k,v])=>[`${sec.replace('by_','')}: ${k}`,{html:String(v.n),num:true},...pols.flatMap(p=>[numCell(v.v1?.[p]),numCell(v.hard?.[p])])]))));
      }
    }
    const sc=href?.tracks?.full;
    if(sc){const ids=Object.keys(sc);parts.push(`<div class="multiples">${['wait','patient','oref0','causal','omniscient'].filter(p=>ids.some(id=>fin(sc[id][p]))).map(p=>histogram({values:ids.map(id=>sc[id][p]),key:p,title:`hard ${p}`,threshold:p==='causal'?0.95:null})).join('')}</div>`);}
    parts.push(`<p>Links: <a href="${esc(ctx.href(`${HARD}/coverage.html`))}">coverage.html</a> · <a href="${esc(ctx.href(`${HARD}/catalog.md`))}">catalog.md</a> · <a href="${esc(ctx.href(`${HARD}/comparison.md`))}">comparison.md</a></p>`);
    return {checks,html:parts.join('\n'),run,artifacts,headline:headline.trim()};
  }
  // in progress: read the candidate cache
  const cache=path.join(root,'artifacts','opendiabet','hard-runs','full'),screen={wait:[],patient:[],oref0:[],'causal-fast':[]},finals=[];
  let cells=0,candidates=0,screened=0;
  for(const c of listDir(cache)){if(!c.isDirectory())continue;cells++;let cellFinal=null;
    for(const k of listDir(path.join(cache,c.name))){if(!k.isDirectory())continue;candidates++;let all=true;
      for(const lab of Object.keys(screen)){const r=readJson(path.join(cache,c.name,k.name,lab,'result.json'));if(r&&fin(r.score))screen[lab].push(r.score);else all=false;}
      if(all)screened++;
      const f=readJson(path.join(cache,c.name,k.name,'causal','result.json'));if(f&&fin(f.score))cellFinal=Math.max(cellFinal??-1,f.score);}
    if(cellFinal!=null)finals.push(cellFinal);}
  const st=running.length?'running':'pending';
  headline=cells?`in progress (${finals.length}/200 cells with a full-causal certificate run)`:'not run yet';
  checks.push({label:'v1.1-hard: every cell certified solvable (S<sub>causal</sub> ≥ 0.95)',status:st,
    evidence:cells?`generation ${running.length?'running':'not running'}; cache: ${cells} cells, ${screened}/${cells*6} candidates fully screened, ${finals.length} cells with full-causal runs, ${finals.filter(v=>v>=0.95).length} of them ≥ 0.95 so far`:`${HARD}/certification.json not found`});
  parts.push(pendingBlock(`certification.json does not exist yet${running.length?' (generate-hard is running now)':''}. Provisional view from the candidate cache <code>artifacts/opendiabet/hard-runs/full</code>: ${cells} cells, ${candidates} candidates, ${screened} fully screened, ${finals.length} cells with full-causal certificate runs.`,run));
  if(candidates)parts.push(`<div class="multiples">${Object.entries(screen).map(([k,v])=>histogram({values:v,key:k==='causal-fast'?'causal':k,title:`screen ${k}`})).join('')}${histogram({values:finals,key:'causal',title:'best full causal per cell',threshold:0.95})}</div>
<p class="mut">Screen histograms pool all candidates (not only the chosen one); the dashed line is the certification threshold 0.95.</p>`);
  return {checks,html:parts.join('\n'),run,artifacts,headline};
}

// ---- paired ladders (Exp1, Exp4) ---------------------------------------------------------------
function ladderRows(ctx,benchName) {
  const js=[...ctx.jobs.values()].filter(j=>j.config?.benchmark===benchName),seen=new Map();
  for(const j of js)for(const t of j.trials){if(!t.base_env||!t.level)continue;const prev=seen.get(t.trial_id);if(!prev||(t.finished??'')>(prev.finished??''))seen.set(t.trial_id,{...t,_job:j.id});}
  const rows=[...seen.values()].filter(t=>t.status==='done'||t.status==='agent_failed').map(t=>({experiment:t.experiment,base_env:t.base_env,level:t.level,level_index:t.level_index,agent:t.agent,reward:t.reward?.reward}));
  return {jobs:js,rows};
}
function ladderBlock(a,{invariantAgent='wait',trendAgent='causal'}={}) {
  const checks=[],xl=a.levels.map(l=>l.label??l.level),short=a.levels.map(l=>l.level);
  if(!a.agents.length){checks.push({label:`${esc(a.id)}: reference agents run on the ladder`,status:'pending',evidence:'no trials yet'});
    return {checks,html:`<h3>${esc(a.title??a.id)}</h3>${pendingBlock(`no trials for ${esc(a.id)} yet (${a.planned_bases??'?'} base environments × ${a.levels.length} levels planned).`)}`};}
  const w=a.agents.find(x=>x.agent===invariantAgent),c=a.agents.find(x=>x.agent===trendAgent);
  const dir=a.expected_trend===1?'increasing':a.expected_trend===-1?'decreasing':'any difference';
  if(w&&invariantAgent)checks.push({label:`${esc(a.id)} sanity: ${invariantAgent} is invariant to the level (paired, every base)`,status:w.complete_bases?(w.max_within_base_range<1e-6?'pass':'fail'):'pending',
    evidence:`max within-base range ${f3(w.max_within_base_range)} over ${w.complete_bases} complete bases`});
  if(c){const t=c.trend;checks.push({label:`${esc(a.id)}: ${trendAgent} ${a.expected_trend?`trend is ${dir} over levels (mean Spearman ρ CI excludes 0)`:'differs between levels (some paired Δ CI excludes 0)'}`,
    status:c.verdict==='no_effect'&&a.expected_trend&&fin(c.first_to_last)&&c.first_to_last*a.expected_trend<-0.02?'fail':verdictStatus(c.verdict),evidence:`verdict <b>${c.verdict}</b>; ρ ${f3(t.mean)} ${ci(t.lo,t.hi)} (n=${t.n}); first→last ${sgn3(c.first_to_last)}`});}
  else checks.push({label:`${esc(a.id)}: ${trendAgent} trend`,status:'pending',evidence:`${trendAgent} not run`});
  for(const x of a.agents.filter(x=>x!==c&&x!==w))checks.push({label:`${esc(a.id)}: ${esc(x.agent)} trend (${dir})`,status:'info',evidence:`verdict ${x.verdict}; ρ ${f3(x.trend.mean)} ${ci(x.trend.lo,x.trend.hi)}; first→last ${sgn3(x.first_to_last)}`});
  const series=a.agents.map(x=>({key:x.agent,points:x.levels.map((l,i)=>({x:i,y:l.mean,lo:l.lo,hi:l.hi,tip:`${x.agent} · ${l.label??l.level}: ${f3(l.mean)} ${ci(l.lo,l.hi)} n=${l.n}`}))}));
  const chart=lineChart({xLabels:short,series,title:a.title,width:560,height:250,xLabel:`${a.factor} (${a.expected_trend===1?'expected ↑':a.expected_trend===-1?'expected ↓':'categorical'}; ref ${a.reference_level})`});
  const tbl=table(['level','label',...a.agents.flatMap(x=>[{t:`${x.agent} mean [CI]`,num:true},{t:`Δ vs ${a.reference_level}`,num:true}])],
    a.levels.map((l,i)=>[l.level,l.label??'',...a.agents.flatMap(x=>{const L=x.levels[i],d=x.diffs.find(d=>d.level===l.level);
      return [{html:`${f3(L.mean)} <span class="mut">${ci(L.lo,L.hi)}</span>`,num:true,v:L.mean},{html:d?`${sgn3(d.mean)} <span class="mut">${ci(d.lo,d.hi)}</span>${fin(d.lo)&&(d.lo>0||d.hi<0)?' *':''}`:'ref',num:true}];})]));
  return {checks,html:`<h3>${esc(a.title??a.id)} <span class="mut">${a.agents[0]?.bases??0} bases with trials of ${a.planned_bases??'?'} planned; ${a.trials} trials</span></h3>
${a.design_notes?`<p class="mut">${esc(a.design_notes)}</p>`:''}<div class="chartrow">${legend(a.agents.map(x=>x.agent),{note:'points: mean over base environments; whiskers: 95% bootstrap CI'})}${chart}</div>${details('table view (paired Δ vs reference level, * = CI excludes 0)',tbl)}`};
}

export function exp1Section(ctx) {
  const B='artifacts/benchmarks/exp1-obs-scaling',bench=readJson(path.join(ctx.root,B,'benchmark.json'));
  const run=['# paired variants of v1 along ladders 1a–1e','node scripts/exp-obs.mjs build',
    '# reference agents on 12 base environments, then the paired analysis (default job artifacts/benchmarks/jobs/exp1-validation)',
    'node scripts/exp-obs.mjs validate --experiments exp1a,exp1b,exp1c --subset 12 --parallel 3 --analyze',
    '# harness-side ladders (history window, decision interval)','node scripts/exp-obs.mjs validate --experiments exp1d,exp1e --subset 12 --parallel 3 --analyze'];
  const {jobs,rows}=ladderRows(ctx,'exp1-obs-scaling');
  const artifacts=[{path:B+'/benchmark.json'},{path:B+'/variants.jsonl'},...jobs.map(j=>({path:j.dir,note:statusLine(j)})),...jobs.filter(j=>j.paired).map(j=>({path:j.paired+'/summary.html',note:'paired-analysis output of scripts/paired-analysis.mjs'}))];
  const question='Does richer / less noisy observation and better event visibility improve control? Valid design: the causal reference (acts on visible information only) improves monotonically along each ladder, while wait (never acts) is exactly invariant — a sanity check that only the observation changed.';
  if(!bench)return section({id:'exp1',num:'Exp1',title:'Observation scaling',question,status:'pending',headline:'benchmark not built',ctx,run,artifacts,checks:[{label:'benchmark built',status:'pending',evidence:`${B} missing`}],body:pendingBlock('benchmark build',run)});
  const an=analyzeLadders(rows,bench.experiments);
  const blocks=an.map(a=>ladderBlock(a));
  const checks=blocks.flatMap(b=>b.checks);
  const stale=jobs.filter(j=>j.paired&&mtime(path.join(ctx.root,j.paired,'analysis.json'))<j.newest-1000).map(j=>j.id);
  const st=combine(checks.map(c=>c.status));
  const done=an.filter(a=>a.agents.length).map(a=>{const c=a.agents.find(x=>x.agent==='causal');return `${a.id} ${c?c.verdict:'–'}`;});
  return section({id:'exp1',num:'Exp1',title:'Observation scaling',question,status:st,ctx,run,artifacts,checks,headline:`causal trend: ${done.join(', ')||'none run'}`,
    body:`<p class="mut">Computed on the fly from trial.json of ${jobs.map(j=>`<code>${esc(j.id)}</code>`).join(', ')||'no job'} (bootstrap over base environments, B=2000).${stale.length?` Note: paired-analysis output of ${stale.join(', ')} is older than its newest trial; re-run with --analyze.`:''}
${ctx.running.filter(p=>p.includes('exp-obs')).map(p=>`<br>Running now: <code>${esc(p)}</code> (not in the default job dir unless --job points there)`).join('')}</p>${blocks.map(b=>b.html).join('\n')}`});
}

export function exp4Section(ctx) {
  const B='artifacts/benchmarks/exp4-backends',bench=readJson(path.join(ctx.root,B,'benchmark.json'));
  const run=['# 4a backends (incl. pump_loop), 4b pump insulins, 4c pen insulins','node scripts/exp-backends.mjs build',
    '# reference agents, default job artifacts/benchmarks/jobs/exp4-validation','node scripts/exp-backends.mjs validate --subset 12 --parallel 3 --analyze'];
  const {jobs,rows}=ladderRows(ctx,'exp4-backends');
  const artifacts=[{path:B+'/benchmark.json'},{path:B+'/variants.jsonl'},{path:'artifacts/benchmarks/jobs/exp4-validation',note:jobs.length?jobs.map(statusLine).join('; '):'default validation job'}];
  const question='Same people and days, only the hardware backend or the rapid insulin changes: do reference agents show a paired difference, and is the reference ordering stable? Note: the old MVP job <code>mvp2-exp4</code> is Real→Sim→Real (now Exp5/6), not a backend sweep.';
  const checks=[],parts=[];
  if(!bench){checks.push({label:'benchmark built',status:'pending',evidence:`${B} missing`});}
  else {
    const an=analyzeLadders(rows,bench.experiments);
    for(const a of an){const b=ladderBlock(a,{invariantAgent:null});
      const lv=a.agents.length?a.levels.map((l,i)=>Object.fromEntries(a.agents.map(x=>[x.agent,x.levels[i].mean]))):[];
      if(a.agents.some(x=>x.agent==='causal')&&a.agents.some(x=>x.agent==='wait')){const ok=lv.every(m=>!fin(m.causal)||!fin(m.wait)||m.causal>=m.wait);
        b.checks.push({label:`${esc(a.id)}: ordering causal ≥ wait at every level`,status:ok?'pass':'fail',evidence:lv.map((m,i)=>`${a.levels[i].level} ${f2(m.causal)}/${f2(m.wait)}`).join(' · ')});}
      checks.push(...b.checks);parts.push(b.html);}
  }
  // preliminary evidence from the v1 reference matrix
  if(ctx.v1){const {ref,info}=ctx.v1;
    for(const track of ['full','assisted']){const sc=ref.tracks?.[track];if(!sc)continue;const ids=Object.keys(sc),pols=ref.policies[track];
      const rows=groupMeans(ids,sc,pols,id=>info(id).backend);
      parts.push(`<h3>Backend × agent matrix from the v1 references (${track} track; not paired, different people per backend)</h3>`,dotPlot({rows,series:pols,title:`backend matrix ${track}`}),
        details('table view',table(['backend',{t:'n',num:true},...pols.map(p=>({t:p,num:true}))],rows.map(r=>[r.label,{html:String(r.n),num:true},...pols.map(p=>numCell(r.values[p]))]))));
      if(track==='full'){const m=Object.fromEntries(rows.map(r=>[r.label,r.values.causal])),pumps=['pump_pct','pump_abs','pump_combo'].map(k=>m[k]).filter(fin);
        checks.push({label:'Preliminary (v1 matrix, unpaired): pens harder than pumps for causal',status:'info',evidence:`pens ${f3(m.pens)} vs pumps ${pumps.map(f3).join(' / ')}`});}}}
  const st=combine(checks.map(c=>c.status));
  return section({id:'exp4',num:'Exp4',title:'Backends and insulins',question,status:st,ctx,run,artifacts,checks,
    headline:jobs.length?`${rows.length} paired trials`:'paired job not run yet (v1 backend matrix shown)',body:(jobs.length?'':pendingBlock('paired validation job <code>exp4-validation</code>.',run.slice(2)))+parts.join('\n')});
}

// ---- Exp2: time scaling --------------------------------------------------------------------------
export function exp2Section(ctx) {
  const job=ctx.jobs.get('mvp2-exp3'),mvp=readJson(path.join(ctx.root,'artifacts','exp3','mvp-results.json'));
  const run=['# reference: fixed (patient baseline) vs adaptive (cross-day memory + daily SET_PROFILE), 4 persons x 7 days, mis-programmed profiles',
    'node scripts/exp3-mvp.mjs --agents fixed,adaptive,causal --out artifacts/exp3',
    'node scripts/benchmark.mjs run --benchmark artifacts/benchmarks/opendiabet-exp3 --agents patient,cmd:scripts/exp3-agent-adaptive.mjs --job-id mvp2-exp3',
    '# LLM multi-day (2a memory / 2b warm-up / 2c test-time scaling): see docs/RUNBOOK-BATCH.zh-CN.md §7.1'];
  const artifacts=[{path:'artifacts/benchmarks/jobs/mvp2-exp3',note:job?statusLine(job):''},{path:'artifacts/exp3/mvp-results.json',note:'in-process run incl. causal and parameter error'},{path:'artifacts/exp3/mvp-table.md'},
    {path:'results/mvp-2026-10-15/players/exp3-longitudinal.html',note:'trial players'}];
  const question='Over days, does an agent that models the person better also control better (self-evolving / warm-up / test-time scaling)? Valid design: an adaptive reference beats the fixed profile late in the episode and its parameter error falls; the persistent causal decider is the upper reference. Old job name: mvp2-exp3 (old "Exp3 longitudinal").';
  const checks=[],parts=[];
  const slope=ys=>{const xs=ys.map((_,i)=>i+1),mx=mean(xs),my=mean(ys);let n=0,d=0;xs.forEach((x,i)=>{n+=(x-mx)*(ys[i]-my);d+=(x-mx)**2;});return d?n/d:null;};
  if(job?.result) {
    const e=job.result.experiments?.[0],ag=e?.agents??[];
    const ad=ag.find(a=>a.agent.includes('adaptive')),fx=ag.find(a=>a.agent==='patient');
    const days=Math.max(...ag.map(a=>a.curve?.length??0));
    parts.push(`<h3>Job mvp2-exp3: daily score per agent (mean over ${e?.tasks??'?'} persons, 95% CI)</h3><div class="chartrow">${legend(ag.map(a=>a.agent))}${lineChart({xLabels:Array.from({length:days},(_,i)=>`day ${i+1}`),
      series:ag.map(a=>({key:a.agent,points:(a.curve??[]).map(c=>({x:c.day-1,y:c.mean,lo:c.ci95?.[0],hi:c.ci95?.[1]}))})),y0:0.6,y1:1,width:620,height:260,title:'Exp2 daily score'})}</div>`);
    if(ad&&fx){const l2=a=>mean((a.curve??[]).slice(-2).map(c=>c.mean)),s=ad.learning_slope;
      checks.push({label:'Adaptive learns: learning slope (S/day) of adaptive &gt; fixed profile, CI excluding 0',status:s?.mean>(fx.learning_slope?.mean??0)?(s.ci95?.[0]>0?'pass':'weak'):'fail',
        evidence:`adaptive ${f3(s?.mean)} ${ci(s?.ci95?.[0],s?.ci95?.[1])} vs fixed ${f3(fx.learning_slope?.mean)} ${ci(fx.learning_slope?.ci95?.[0],fx.learning_slope?.ci95?.[1])}; n=${s?.n} persons`});
      checks.push({label:'Adaptive beats the fixed profile on the last 2 days',status:l2(ad)>l2(fx)?'pass':'fail',evidence:`${f3(l2(ad))} vs ${f3(l2(fx))}`});}
    // per-trial table with players
    const tr=job.trials.sort((a,b)=>a.task_id.localeCompare(b.task_id)||a.agent.localeCompare(b.agent));
    const D=Math.max(0,...tr.map(t=>t.reward?.days??0));
    parts.push(details(`per-trial daily scores (${tr.length} trials) with players`,table(['task','agent','status',{t:'S',num:true},...Array.from({length:D},(_,i)=>({t:`d${i+1}`,num:true})),{t:'slope',num:true},'player'],
      tr.map(t=>[t.task_id,labelOf(t.agent),t.status,numCell(t.reward?.reward),...Array.from({length:D},(_,i)=>numCell(t.reward?.[`day_${i+1}_reward`],f2(t.reward?.[`day_${i+1}_reward`]))),numCell(t.reward?.learning_slope),linkCell(ctx.mvpPlayer(job.id,t.trial_id),'play')]),{sortable:true})));
  } else checks.push({label:'Job mvp2-exp3 (fixed vs adaptive, benchmark harness)',status:'pending',evidence:'job not found'});
  if(mvp?.curve) {
    const agents=mvp.agents??[...new Set(mvp.curve.map(c=>c.agent))],days=Math.max(...mvp.curve.map(c=>c.day));
    const S=a=>Array.from({length:days},(_,i)=>mvp.curve.find(c=>c.agent===a&&c.day===i+1));
    parts.push(`<h3>In-process MVP (artifacts/exp3): daily score and parameter error</h3><div class="row2"><div class="chartrow">${legend(agents)}${lineChart({xLabels:Array.from({length:days},(_,i)=>`d${i+1}`),
      series:agents.map(a=>({key:a,points:S(a).map((c,i)=>({x:i,y:c?.reward}))})),y0:0.6,y1:1,width:440,height:240,title:'daily S'})}</div>
<div class="chartrow">${legend(agents)}${lineChart({xLabels:Array.from({length:days},(_,i)=>`d${i+1}`),series:agents.map(a=>({key:a,points:S(a).map((c,i)=>({x:i,y:c?.param_error}))})),y0:0,y1:0.4,width:440,height:240,yLabel:'parameter error (rel.)',title:'parameter error'})}</div></div>`);
    const sm=mvp.summary??{};
    if(sm.adaptive)checks.push({label:'Adaptive parameter error falls over the episode (in-process MVP)',status:sm.adaptive.param_error_final<sm.adaptive.param_error_first-0.05?'pass':sm.adaptive.param_error_final<sm.adaptive.param_error_first?'weak':'fail',
      evidence:`${f3(sm.adaptive.param_error_first)} → ${f3(sm.adaptive.param_error_final)}; fixed ${f3(sm.fixed?.param_error_first)} → ${f3(sm.fixed?.param_error_final)}`});
    if(sm.causal&&sm.adaptive)checks.push({label:'Persistent causal is an upper reference (mean S ≥ adaptive)',status:sm.causal.reward_mean>=sm.adaptive.reward_mean?'pass':'weak',evidence:`causal ${f3(sm.causal.reward_mean)} vs adaptive ${f3(sm.adaptive.reward_mean)} (causal slope ${f3(sm.causal.learning_slope)})`});
    parts.push(details('summary table (in-process MVP)',table(['agent',{t:'mean S',num:true},{t:'slope',num:true},{t:'S d1–2',num:true},{t:'S last 2',num:true},{t:'param err first',num:true},{t:'param err final',num:true},{t:'profile changes',num:true}],
      Object.entries(sm).map(([a,s])=>[a,numCell(s.reward_mean),numCell(s.learning_slope),numCell(s.reward_days_1_2),numCell(s.reward_last_2),numCell(s.param_error_first),numCell(s.param_error_final),numCell(s.profile_changes,String(s.profile_changes))]))));
  }
  const llm=[...ctx.jobs.values()].filter(j=>/^exp2[abc]/.test(j.id)||(j.config?.benchmark==='opendiabet-exp3'&&(j.config?.agents??[]).some(a=>String(a).startsWith('llm:'))));
  checks.push({label:'LLM multi-day runs (2a memory, 2b warm-up, 2c test-time scaling)',status:llm.length?'info':'pending',evidence:llm.length?llm.map(j=>`${j.id}: ${statusLine(j)}`).join('<br>'):'no exp2a/b/c job yet'});
  const st=combine(checks.map(c=>c.status));
  return section({id:'exp2',num:'Exp2',title:'Time scaling (self-evolving / warm-up / test-time)',question,status:st,ctx,run,artifacts,checks,
    headline:mvp?.summary?.adaptive?`adaptive last-2 ${f2(mvp.summary.adaptive.reward_last_2)} vs fixed ${f2(mvp.summary.fixed?.reward_last_2)}`:'',body:parts.join('\n')});
}

// ---- Exp3: assisted vs autonomous ---------------------------------------------------------------
export function exp3Section(ctx) {
  const job=ctx.jobs.get('mvp2-exp1-exp2');
  const run=['# 200 environments x both tracks (paired by environment): the Exp0 references',
    'node scripts/opendiabet.mjs references --tracks full,assisted --parallel 6',
    '# MVP job (8 instances, both tracks; old naming exp1-full / exp2-assisted)',
    'node scripts/benchmark.mjs run --benchmark artifacts/benchmarks/opendiabet-mvp --agents wait,patient,oref0,causal,oracle --job-id mvp2-exp1-exp2'];
  const artifacts=[{path:`${V1}/references.json`,note:'tracks.full / tracks.assisted per environment'},{path:'artifacts/benchmarks/jobs/mvp2-exp1-exp2',note:job?statusLine(job):''},
    {path:'results/mvp-2026-10-15/players/exp1-full.html',note:'full-track players'},{path:'results/mvp-2026-10-15/players/exp2-assisted.html',note:'assisted-track players'}];
  const question='Same environments, two tracks: full (the agent does all treatment) vs assisted (the patient boluses and treats lows, the agent corrects). Valid design: on the assisted track a good reference improves on the patient alone (wait), and there is headroom above the patient; the full − assisted difference is reported as paired Δ.';
  const checks=[],parts=[];
  if(ctx.v1?.ref?.tracks?.assisted&&ctx.v1.ref.tracks.full) {
    const F=ctx.v1.ref.tracks.full,A=ctx.v1.ref.tracks.assisted,ids=Object.keys(A).filter(id=>F[id]);
    const pd=(f)=>bootMean(ids.map(f),{seed:23});
    const rows=[];
    for(const p of ['wait','oref0','causal','omniscient'])rows.push({label:`${p}: assisted − full`,key:p,...pd(id=>A[id][p]-F[id][p])});
    for(const p of ['oref0','causal','omniscient'])rows.push({label:`assisted: ${p} − patient alone`,key:p,...pd(id=>A[id][p]-A[id].wait)});
    rows.push({label:'causal full − patient (full track)',key:'patient',...pd(id=>F[id].causal-F[id].patient)});
    const g=rows.find(r=>r.label==='assisted: causal − patient alone'),o=rows.find(r=>r.label==='assisted: omniscient − patient alone');
    checks.push({label:'Assisted: causal improves on the patient alone (paired Δ CI &gt; 0, 200 envs)',status:g.lo>0?'pass':g.mean>0?'weak':'fail',evidence:`Δ ${sgn3(g.mean)} ${ci(g.lo,g.hi)} n=${g.n}`});
    checks.push({label:'Assisted: headroom above the patient alone (omniscient − wait ≥ 0.10)',status:o.mean>=0.1?'pass':'weak',evidence:`Δ ${sgn3(o.mean)} ${ci(o.lo,o.hi)}`});
    const c=rows.find(r=>r.label==='causal: assisted − full');
    checks.push({label:'Report: paired Δ assisted − full per reference (no direction required)',status:'info',evidence:`causal ${sgn3(c.mean)} ${ci(c.lo,c.hi)}; wait ${sgn3(rows[0].mean)} ${ci(rows[0].lo,rows[0].hi)}`});
    parts.push(`<h3>Paired Δ over the 200 v1 environments (references; bootstrap over environments)</h3>`,
      forest({rows,title:'Exp3 paired differences',x0:-0.2,x1:0.6}),details('table view',table(['comparison',{t:'n',num:true},{t:'mean Δ',num:true},{t:'95% CI',num:true}],rows.map(r=>[r.label,{html:String(r.n),num:true},numCell(r.mean,sgn3(r.mean)),{html:ci(r.lo,r.hi),num:true}]))));
  } else checks.push({label:'Paired Δ on the 200 v1 environments',status:'pending',evidence:'references.json with both tracks missing'});
  if(job?.result) {
    const as=job.result.experiments?.find(e=>e.track==='assisted'),c=as?.agents?.find(a=>a.agent==='causal');
    if(c)checks.push({label:'MVP replication (8 instances): assisted causal − wait CI &gt; 0',status:c.delta_vs_wait?.ci95?.[0]>0?'pass':'weak',evidence:`${sgn3(c.delta_vs_wait?.mean)} ${ci(c.delta_vs_wait?.ci95?.[0],c.delta_vs_wait?.ci95?.[1])}`});
    const ct=job.result.cross_track??[];
    parts.push(`<h3>MVP job mvp2-exp1-exp2: same instances, assisted − full</h3>`,forest({rows:ct.map(x=>({label:`${x.agent}: assisted − full`,key:x.agent,mean:x.b_minus_a?.mean,lo:x.b_minus_a?.ci95?.[0],hi:x.b_minus_a?.ci95?.[1],n:x.n})),x0:-0.2,x1:0.6,title:'MVP cross-track'}));
    const byTask=new Map();for(const t of job.trials){const k=`${t.instance_id}|${t.agent}`;(byTask.get(k)??byTask.set(k,{}).get(k))[t.track]=t;}
    parts.push(details('per-instance paired table with players',table(['instance','agent',{t:'full S',num:true},{t:'assisted S',num:true},{t:'Δ',num:true},'players'],
      [...byTask.entries()].sort().map(([k,v])=>{const [inst,ag]=k.split('|'),f=v.full?.reward?.reward,a=v.assisted?.reward?.reward;
        return [inst,ag,numCell(f),numCell(a),numCell(fin(f)&&fin(a)?a-f:null,fin(f)&&fin(a)?sgn3(a-f):'–'),{html:[v.full&&ctx.mvpPlayer(job.id,v.full.trial_id)?`<a href="${esc(ctx.mvpPlayer(job.id,v.full.trial_id))}">full</a>`:'',v.assisted&&ctx.mvpPlayer(job.id,v.assisted.trial_id)?`<a href="${esc(ctx.mvpPlayer(job.id,v.assisted.trial_id))}">assisted</a>`:''].filter(Boolean).join(' · ')||'–'}];}),{sortable:true})));
  }
  checks.push({label:'Duplicate-dosing metric (agent bolus ≤ 30 min after the patient\'s) and advice-acceptance mode',status:'pending',evidence:'not implemented in scoring yet (docs/PLAN-v2 Exp3)'});
  const st=combine(checks.map(c=>c.status));
  return section({id:'exp3',num:'Exp3',title:'Assisted vs autonomous',question,status:st,ctx,run,artifacts,checks,headline:checks[0]?.evidence?.replace(/<[^>]+>/g,'')??'',body:parts.join('\n')});
}

// ---- Exp5 / Exp6 --------------------------------------------------------------------------------
export function exp5Section(ctx) {
  const S=readJson(path.join(ctx.root,'artifacts','exp4','mvp','summary.json'));
  const synth=['artifacts/trace2sim/synthetic-validation.json','results/validation/trace2sim-synthetic.json'].find(p=>exists(path.join(ctx.root,p)));
  const run=['# trace2sim on 6 synthetic "real" people (14 days usual care, 4 holdout days) — the Real→Sim half of the old Exp4 MVP',
    'node scripts/exp4.mjs --out artifacts/exp4/mvp','# known-truth parameter recovery (batch, ~50 people planned; batch CLI not written yet)',
    'node scripts/trace2sim-synthetic.mjs --seeds 1,2,3 --days 6 --json artifacts/trace2sim/synthetic-validation.json'];
  const artifacts=[{path:'artifacts/exp4/mvp/summary.json',note:'fit per person'},{path:'artifacts/exp4/mvp/persons',note:'fit report, twin export, synthetic record'},{path:'artifacts/trace2sim/synthetic-validation.json',note:'synthetic round-trip (planned)'}];
  const question='Can a person\'s physiology be reconstructed from an uploaded record? Validation on synthetic people with known truth: holdout-day prediction error and parameter recovery. Planned criteria: parameter error 2–7%, holdout MARD 2–13%; real data anchored on independent fingersticks.';
  const checks=[],parts=[];
  if(S?.fit) {
    const n=S.fit.length,ok1=S.fit.filter(f=>f.holdout_mard<=0.13).length,ok2=S.fit.filter(f=>Math.abs(f.sensitivity_error)<=0.07).length;
    checks.push({label:'Holdout MARD (twin vs CGM) ≤ 13% per person',status:ok1===n?'pass':ok1>=n/2?'weak':'fail',evidence:`${ok1}/${n} persons; median ${f3(S.fit.map(f=>f.holdout_mard).sort((a,b)=>a-b)[n>>1])}`});
    checks.push({label:'Sensitivity recovery |error| ≤ 7% per person',status:ok2===n?'pass':ok2>=n/2?'weak':'fail',evidence:`${ok2}/${n} persons; errors ${S.fit.map(f=>sgn3(f.sensitivity_error)).join(', ')}`});
    const grades={};for(const f of S.fit)grades[f.grade]=(grades[f.grade]??0)+1;
    checks.push({label:'Fit grades (A/B/C)',status:'info',evidence:Object.entries(grades).map(([g,c])=>`${g}: ${c}`).join(' · ')});
    const keys=['holdout_mard','twin_vs_true_mard','twin_vs_smbg_mard','cgm_vs_smbg_mard'];
    parts.push(`<h3>Reconstruction fit per synthetic person (Real2Sim MVP, ${S.options?.days??'?'} days, ${S.options?.holdoutDays??'?'} holdout)</h3>`,
      dotPlot({rows:S.fit.map(f=>({label:`${f.person} (grade ${f.grade})`,values:Object.fromEntries(keys.map(k=>[k,f[k]]))})),series:keys,x0:0,x1:0.24,xLabel:'MARD (0–1; criterion 0.13)',title:'Exp5 fit'}),
      details('table view',table(['person','grade',...keys.map(k=>({t:k,num:true})),{t:'sensitivity error',num:true},{t:'TIR diff',num:true}],S.fit.map(f=>[f.person,f.grade,...keys.map(k=>numCell(f[k])),numCell(f.sensitivity_error,sgn3(f.sensitivity_error)),numCell(f.tir_diff,sgn3(f.tir_diff))]))));
  } else checks.push({label:'Real2Sim MVP fit',status:'pending',evidence:'artifacts/exp4/mvp/summary.json missing'});
  checks.push({label:'Batch reconstruct CLI + synthetic round-trip on ~50 people (all person types, pump/pens, sensors)',status:synth?'info':'pending',evidence:synth?`found ${synth}`:'not run yet'});
  checks.push({label:'Real data (OhioT1DM / Jaeb / volunteers), fingerstick-anchored',status:'pending',evidence:'data access pending'});
  const st=combine(checks.map(c=>c.status));
  return section({id:'exp5',num:'Exp5',title:'Real2Sim (trace2sim)',question,status:st,ctx,run,artifacts,checks,headline:S?.fit?checks[0].evidence:'not run',
    body:parts.join('\n')+`<p class="mut">trace2sim pipeline: <code>src/trace2sim/</code> (ingest, fit, replay, validate, export), CLI <code>scripts/trace2sim.mjs</code>. Glucose errors are relative (MARD), unit-free.</p>`});
}

export function exp6Section(ctx) {
  const job=ctx.jobs.get('mvp2-exp4'),S=readJson(path.join(ctx.root,'artifacts','exp4','mvp','summary.json'));
  const run=['# Real→Sim→Real MVP: agents on the reconstructed twin vs the hidden "real" person, same future days (old job name mvp2-exp4)',
    'node scripts/exp4.mjs --out artifacts/exp4/mvp --bench-dir artifacts/benchmarks --bench-name opendiabet-mvp',
    'node scripts/benchmark.mjs run --benchmark artifacts/benchmarks/opendiabet-mvp --experiments exp4-real2sim2real --agents wait,patient,oref0,causal --job-id mvp2-exp4',
    '# evolve-on-twin loop (LLM self-reflection / RL), then paired evaluation on the "real" person: not implemented yet'];
  const artifacts=[{path:'artifacts/benchmarks/jobs/mvp2-exp4',note:job?statusLine(job):''},{path:'artifacts/exp4/mvp/summary.json',note:'transfer rows per person × agent'},
    {path:'results/mvp-2026-10-15/players/exp4-real2sim2real.html',note:'trial players (real and twin)'}];
  const question='Does improving an agent on the twin transfer to the (synthetic) real person? The harness part is validated by twin-vs-real agreement: the ranking of agents on the twin should match the ranking on the real person and the transfer gap should be small. The evolution step itself has not started.';
  const checks=[],parts=[];
  const pairs=job?.result?.experiments?.[0]?.pairs;
  if(pairs?.agents?.length) {
    const ag=pairs.agents;
    const rho=spearman(ag.map(a=>a.twin_reward.mean),ag.map(a=>a.real_reward.mean));
    checks.push({label:'Twin ranks agents like the real person (Spearman ρ of mean S across agents ≥ 0.8)',status:rho>=0.8?'pass':rho>0?'weak':'fail',evidence:`ρ ${f3(rho)} over ${ag.length} agents`});
    const c=ag.find(a=>a.agent==='causal');
    if(c)checks.push({label:'Transfer gap of causal (twin − real) CI includes 0 and |mean| ≤ 0.05',status:c.transfer_gap.ci95[0]<=0&&c.transfer_gap.ci95[1]>=0&&Math.abs(c.transfer_gap.mean)<=0.05?'pass':'weak',
      evidence:`${sgn3(c.transfer_gap.mean)} ${ci(...c.transfer_gap.ci95)} (n=${c.pairs} pairs)`});
    parts.push(`<h3>Transfer gap per agent (twin − real; job mvp2-exp4, ${pairs.n} real/twin pairs)</h3>`,forest({rows:ag.map(a=>({label:`${a.agent}`,key:a.agent,mean:a.transfer_gap.mean,lo:a.transfer_gap.ci95[0],hi:a.transfer_gap.ci95[1],n:a.pairs})),x0:-0.3,x1:0.3,xLabel:'transfer gap S_twin − S_real (95% CI)',title:'transfer gap'}),
      details('table view',table(['agent',{t:'pairs',num:true},{t:'real S',num:true},{t:'twin S',num:true},{t:'gap',num:true},{t:'|gap|',num:true}],ag.map(a=>[a.agent,{html:String(a.pairs),num:true},numCell(a.real_reward.mean),numCell(a.twin_reward.mean),numCell(a.transfer_gap.mean,sgn3(a.transfer_gap.mean)),numCell(a.abs_transfer_gap)]))));
  } else checks.push({label:'Twin vs real paired evaluation',status:'pending',evidence:'mvp2-exp4 result missing'});
  if(S?.transfer?.rows) {
    const per=new Map();for(const r of S.transfer.rows)(per.get(r.person)??per.set(r.person,[]).get(r.person)).push(r);
    let agree=0;const rows=[];
    for(const [p,rs] of per){const bt=rs.reduce((a,b)=>b.twin_reward>a.twin_reward?b:a),br=rs.reduce((a,b)=>b.real_reward>a.real_reward?b:a);if(bt.agent===br.agent)agree++;
      rows.push([p,bt.agent,br.agent,numCell(spearman(rs.map(r=>r.twin_reward),rs.map(r=>r.real_reward)))]);}
    checks.push({label:'Best agent on the twin is best on the real person (per person)',status:agree===per.size?'pass':agree>=per.size/2?'weak':'fail',evidence:`${agree}/${per.size} persons`});
    parts.push(details('per-person best agent and rank correlation',table(['person','best on twin','best on real',{t:'Spearman ρ',num:true}],rows)));
  }
  if(job)parts.push(`<p>Players: <a href="${esc(ctx.href('results/mvp-2026-10-15/players/exp4-real2sim2real.html'))}">exp4-real2sim2real.html</a> (all ${job.trials.length} real / twin trials).</p>`);
  checks.push({label:'Evolve on the twin (LLM self-improvement or RL), evaluate paired on the real person',status:'pending',evidence:'not started (C3 recipe)'});
  const st=combine(checks.map(c=>c.status));
  return section({id:'exp6',num:'Exp6',title:'Sim2Real',question,status:st,ctx,run,artifacts,checks,headline:checks[0]?.evidence??'',body:parts.join('\n')});
}
