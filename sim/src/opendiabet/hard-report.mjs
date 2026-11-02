// Reports of the certified hard set (OpenDiabet v1.1-hard): the hardness section of coverage.html,
// catalog.md (knobs, surprises, certificate and baseline scores per environment) and the
// comparison v1 vs v1.1-hard (mean S per reference policy overall and by category / backend /
// setting, certification counts).
import {TASKS,CATEGORIES} from './tasks.mjs';

const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const mean=xs=>{const v=xs.filter(x=>typeof x==='number'&&Number.isFinite(x));return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;};
const f2=v=>v==null?'–':v.toFixed(2);
const hm=m=>m==null?'?':`${String(Math.floor(m/60)).padStart(2,'0')}:${String(Math.round(m%60)).padStart(2,'0')}`;
export const COMPARE_POLICIES={full:['wait','patient','oref0','causal','omniscient'],assisted:['wait','oref0','causal','omniscient']};

/** Reference scores of the hard set from the certificates: {[track]: {[env_id]: {policy: S}}}. */
export function hardReferences(envs) {
  const out={};
  for(const e of envs)for(const [track,c] of Object.entries(e.certificate??{}))(out[track]??={})[e.env_id]=c.references??{};
  return out;
}

/** Certification counts of a track: certified, ordinary <= max, both, total. */
export function certificationCounts(envs,track='full',key=null) {
  const groups={};
  for(const e of envs){const c=e.certificate?.[track];if(!c)continue;const k=key?key(e):'all';const g=groups[k]??={n:0,certified:0,meets_ordinary:0,both:0};
    g.n++;if(c.certified)g.certified++;if(c.meets_ordinary)g.meets_ordinary++;if(c.certified&&c.meets_ordinary)g.both++;}
  return groups;
}

/**
 * v1 vs v1.1-hard mean S per policy: {overall, by_category, by_backend, by_setting}, each
 * {[group]: {n, v1: {policy: S}, hard: {policy: S}}}. v1Refs/hardRefs: {[env_id]: {policy: S}} of one track.
 */
export function compareSets(envs,v1Refs,hardRefs,policies) {
  const group=key=>{
    const g={};
    for(const e of envs){const k=key(e);(g[k]??=[]).push(e.env_id);}
    return Object.fromEntries(Object.entries(g).map(([k,ids])=>[k,{n:ids.length,
      v1:Object.fromEntries(policies.map(p=>[p,mean(ids.map(id=>v1Refs?.[id]?.[p]))])),
      hard:Object.fromEntries(policies.map(p=>[p,mean(ids.map(id=>hardRefs?.[id]?.[p]))]))}]));
  };
  return {overall:group(()=>'all'),by_category:group(e=>CATEGORIES[e.category].en),by_backend:group(e=>e.backend),by_setting:group(e=>e.setting)};
}

function compareTable(cmp,policies,title) {
  const rows=[];
  for(const [section,groups] of Object.entries(cmp))for(const [k,v] of Object.entries(groups))
    rows.push(`<tr><td>${esc(section.replace('by_',''))}</td><td>${esc(k)}</td><td class="n">${v.n}</td>${policies.map(p=>`<td class="n">${f2(v.v1[p])}</td><td class="n"><b>${f2(v.hard[p])}</b></td>`).join('')}</tr>`);
  return `<table class="sum"><tr><th colspan="3">${esc(title)}</th>${policies.map(p=>`<th colspan="2">${p}</th>`).join('')}</tr>
<tr><th></th><th></th><th>n</th>${policies.map(()=>'<th>v1</th><th>hard</th>').join('')}</tr>${rows.join('')}</table>`;
}

/** The hardness section appended to coverage.html. */
export function hardnessHtml({envs,v1References={},tracks=['full'],options={}}) {
  const hard=hardReferences(envs),parts=[];
  parts.push(`<h2>难度认证 / hardness certification (v1.1-hard)</h2>
<p class="note">Certified: S_causal ≥ ${options.causalMin??0.95} with full causal settings (solvable from visible information). Hard: ordinary agents max(patient, oref0) ≤ ${options.ordinaryMax??0.6} (assisted: oref0). ${options.candidates??'K'} candidates per cell, intensity ladder 1, 1, .75, .75, .5, .5.</p>`);
  for(const track of tracks) {
    const by=(label,key)=>{const c=certificationCounts(envs,track,key);return `<div class="dist"><table class="sum"><tr><th>${esc(track)} · ${esc(label)}</th><th>n</th><th>certified</th><th>ordinary ≤ max</th><th>both</th></tr>${
      Object.entries(c).map(([k,v])=>`<tr><td>${esc(k)}</td><td class="n">${v.n}</td><td class="n">${v.certified}</td><td class="n">${v.meets_ordinary}</td><td class="n">${v.both}</td></tr>`).join('')}</table></div>`;};
    parts.push(by('all',null),by('setting',e=>e.setting),by('category',e=>CATEGORIES[e.category].en),by('backend',e=>e.backend));
    if(v1References[track])parts.push(`<div class="dist">${compareTable(compareSets(envs,v1References[track],hard[track],COMPARE_POLICIES[track]),COMPARE_POLICIES[track],`${track}: mean S, v1 vs v1.1-hard`)}</div>`);
  }
  const count=get=>{const c={};for(const e of envs)for(const v of [get(e)].flat())c[v]=(c[v]??0)+1;return Object.entries(c).sort((a,b)=>b[1]-a[1]);};
  const dist=(label,get)=>`<div class="dist"><h3>${esc(label)}</h3><table>${count(get).map(([k,v])=>`<tr><td>${esc(k)}</td><td class="n">${v}</td></tr>`).join('')}</table></div>`;
  parts.push(`<h3>Surprises and knobs</h3>`,dist('surprise types (explicit)',e=>e.hard.surprises.map(s=>s.type)),dist('withheld / late notices (derived)',e=>e.hard.masked_events.map(s=>s.type)),
    dist('compound packs added',e=>e.hard.knobs.compound_packs.length?e.hard.knobs.compound_packs:'none'),dist('chosen candidate intensity',e=>String(e.hard.intensity)),
    dist('certificate reason (full)',e=>e.certificate?.full?.reason??'none'));
  const bad=envs.filter(e=>tracks.some(t=>e.certificate?.[t]&&!e.certificate[t].certified));
  if(bad.length)parts.push(`<h3>Not certified</h3><table class="sum"><tr><th>env</th><th>track</th><th>causal</th><th>omniscient</th><th>ordinary</th><th>reason</th></tr>${
    bad.flatMap(e=>tracks.filter(t=>e.certificate?.[t]&&!e.certificate[t].certified).map(t=>{const c=e.certificate[t];
      return `<tr><td>${esc(e.env_id)}</td><td>${t}</td><td class="n">${f2(c.score)}</td><td class="n">${f2(c.references?.omniscient)}</td><td class="n">${f2(c.ordinary)}</td><td>${esc(c.reason)}</td></tr>`;})).join('')}</table>`);
  return parts.join('\n');
}

/** catalog.md of the hard set: one line per environment. */
export function hardCatalogMd({envs,name='opendiabet-v1.1-hard',tracks=['full']}) {
  const t=Object.fromEntries(TASKS.map(x=>[x.id,x]));
  const lines=[`# ${name} catalog`,'',`${envs.length} environments. Knobs: m = meal-announcement masking, d = late-report probability, carb = report bias/sd, +packs = compound packs; surprises at local episode time (minutes from the start as HH:MM); withheld = notices withheld or late on this seed.`,
    `Certificate = causal (full settings) S; ✓ certified (≥ 0.95), ★ ordinary agents ≤ 0.6. Scores: full w/p/o/c/Ω${tracks.includes('assisted')?'; assisted w/o/c/Ω':''}.`,'',
    `| env | task | backend | setting | knobs | surprises | withheld | certificate | full w/p/o/c/Ω |${tracks.includes('assisted')?' assisted w/o/c/Ω | assisted cert |':''}`,
    `|---|---|---|---|---|---|---|---|---|${tracks.includes('assisted')?'---|---|':''}`];
  for(const e of envs) {
    const k=e.hard.knobs,c=e.certificate?.full??{},r=c.references??{},a=e.certificate?.assisted;
    const knobs=`m ${f2(k.masking.meal_announcement??0)} · d ${f2(k.report_delay.probability)}${k.carb_report?` · carb ${k.carb_report.bias}/${k.carb_report.sd}`:''}${k.compound_packs.length?` · +${k.compound_packs.join('+')}`:''} · i ${e.hard.intensity}`;
    const sur=e.hard.surprises.map(s=>`${s.type}@${hm(s.at_minute)}${s.track==='assisted'?' (assisted)':''}`).join(', ')||'–';
    const wh=e.hard.masked_events.filter(s=>s.type!=='masked_injection_notice').map(s=>`${s.type}@${hm(s.at_minute)}`).join(', ')||'–';
    const cert=`${f2(c.score)}${c.certified?' ✓':''}${c.meets_ordinary?' ★':''}`;
    lines.push(`| ${e.env_id} | ${t[e.task].title.en} | ${e.backend} | ${e.setting} | ${knobs} | ${sur} | ${wh} | ${cert} | ${['wait','patient','oref0','causal','omniscient'].map(p=>f2(r[p])).join(' / ')} |${
      tracks.includes('assisted')?` ${a?['wait','oref0','causal','omniscient'].map(p=>f2(a.references?.[p])).join(' / '):'–'} | ${a?`${f2(a.score)}${a.certified?' ✓':''}${a.meets_ordinary?' ★':''}`:'–'} |`:''}`);
  }
  return lines.join('\n')+'\n';
}

/** Plain-text (markdown) comparison table for the docs / CLI. */
export function comparisonMarkdown(cmp,policies,title) {
  const out=[`### ${title}`,'',`| group | n | ${policies.map(p=>`${p} v1 → hard`).join(' | ')} |`,`|---|---|${policies.map(()=>'---').join('|')}|`];
  for(const [section,groups] of Object.entries(cmp))for(const [k,v] of Object.entries(groups))
    out.push(`| ${section==='overall'?'all':`${section.replace('by_','')}: ${k}`} | ${v.n} | ${policies.map(p=>`${f2(v.v1[p])} → ${f2(v.hard[p])}`).join(' | ')} |`);
  return out.join('\n')+'\n';
}
