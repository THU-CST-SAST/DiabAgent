// OpenDiabet reports in the benchmark directory: coverage.html (task x backend x setting matrix
// with reference scores, value distributions of every randomized dimension, reference summaries by
// category / backend / setting, clean -> randomized drop) and catalog.md (one line per environment).
import {TASKS,CATEGORIES} from './tasks.mjs';
import {BACKEND_IDS,SETTINGS,BACKENDS} from './generate.mjs';
import {REFERENCE_POLICIES} from './episodes.mjs';

const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const mean=xs=>{const v=xs.filter(x=>typeof x==='number'&&Number.isFinite(x));return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;};
const f2=v=>v==null?'–':v.toFixed(2);

/** Mean reference score per policy for groups of environments: {[group]: {n, [policy]: mean}}. */
export function referenceSummary(envs,refsTrack,key) {
  const groups={};
  for(const e of envs){const k=key(e);(groups[k]??=[]).push(e);}
  return Object.fromEntries(Object.entries(groups).map(([k,es])=>{
    const pols=[...new Set(es.flatMap(e=>Object.keys(refsTrack?.[e.env_id]??{})))];
    return [k,{n:es.length,...Object.fromEntries(pols.map(p=>[p,mean(es.map(e=>refsTrack[e.env_id]?.[p]))]))}];
  }));
}
/** Clean -> randomized drop per policy (mean over cells with both): {[policy]: {clean, randomized, drop}}. */
export function robustnessDrop(envs,refsTrack) {
  const pols=[...new Set(envs.flatMap(e=>Object.keys(refsTrack?.[e.env_id]??{})))],out={};
  for(const p of pols) {
    const pairs=[];
    for(const e of envs.filter(x=>x.setting==='clean')) {
      const r=envs.find(x=>x.setting==='randomized'&&x.task===e.task&&x.backend===e.backend&&x.seed_index===e.seed_index);
      const a=refsTrack[e.env_id]?.[p],b=r?refsTrack[r.env_id]?.[p]:null;if(a!=null&&b!=null)pairs.push([a,b]);
    }
    out[p]={cells:pairs.length,clean:mean(pairs.map(x=>x[0])),randomized:mean(pairs.map(x=>x[1])),drop:mean(pairs.map(x=>x[0]-x[1]))};
  }
  return out;
}
function counts(envs,get) {
  const c={};for(const e of envs)for(const v of [get(e)].flat())c[v??'none']=(c[v??'none']??0)+1;
  return Object.entries(c).sort((a,b)=>b[1]-a[1]||(a[0]<b[0]?-1:1));
}

// Single-hue sequential ramp (light -> dark) for scores 0..1; text switches to light ink on dark cells.
const RAMP=['#eef4fb','#d4e4f5','#b3cdec','#8db3e0','#6596d1','#3f78bf','#285da0','#1b4580'];
const cellColor=v=>v==null?'#f4f4f4':RAMP[Math.min(RAMP.length-1,Math.max(0,Math.floor(v*RAMP.length)))];
const ink=v=>v!=null&&v>=0.625?'#ffffff':'#1d2733';

export function coverageHtml({envs,references={},details={},redraws=[],tiers={},name='opendiabet-v1',generated=new Date().toISOString(),extraHtml=''}) {
  const full=references.full??{},assisted=references.assisted??{},seeds=[...new Set(envs.map(e=>e.seed_index))].sort((a,b)=>a-b);
  const byKey=new Map(envs.map(e=>[`${e.task}|${e.backend}|${e.setting}|${e.seed_index}`,e]));
  const head=BACKEND_IDS.flatMap(b=>SETTINGS.map(s=>`<th title="${esc(BACKENDS[b].label.en)}">${esc(b)}<br><span class="m">${s}</span></th>`)).join('');
  const policyLine=(r,track)=>REFERENCE_POLICIES[track].map(p=>`${p} ${f2(r?.[p])}`).join(' · ');
  const rows=TASKS.map(t=>`<tr><th class="t">${t.id} ${esc(t.title.zh)}<br><span class="m">${esc(t.title.en)} · ${esc(CATEGORIES[t.category].zh)}</span></th>${
    BACKEND_IDS.flatMap(b=>SETTINGS.map(s=>{
      const list=seeds.map(k=>byKey.get(`${t.id}|${b}|${s}|${k}`)).filter(Boolean);
      if(!list.length)return '<td class="na">–</td>';
      const e=list[0],v=full[e.env_id]?.causal??null;
      const tip=`${e.env_id}\nperson ${e.factors.person_type} · ${e.factors.observation_profile} · ${e.factors.cgm}/${e.factors.meter}`+
        `${e.factors.background_packs.length?`\nbackground ${e.factors.background_packs.join(', ')}`:''}\nfull: ${policyLine(full[e.env_id],'full')}\nassisted: ${policyLine(assisted[e.env_id],'assisted')}`+
        `${tiers[e.env_id]?`\ntier ${tiers[e.env_id]}`:''}${e.redraws?.length?`\nre-drawn ${e.redraws.length}x`:''}`;
      return `<td style="background:${cellColor(v)};color:${ink(v)}" title="${esc(tip)}"><b>${f2(v)}</b><br><span class="p">${esc(e.factors.person_type.replace('_male',' ♂').replace('_female',' ♀'))}</span>${e.redraws?.length?' *':''}</td>`;
    })).join('')}</tr>`).join('');
  const dims=[['person_type',e=>e.factors.person_type],['age_group',e=>e.factors.age_group],['backend',e=>e.backend],
    ['pens pair',e=>e.family==='pens'?`${e.factors.bolus_pen}+${e.factors.basal_pen}`:null],['rapid insulin',e=>e.factors.rapid_insulin],
    ['observation profile',e=>e.factors.observation_profile],['cgm',e=>e.factors.cgm],['meter',e=>e.factors.meter],['bmi',e=>e.factors.bmi],
    ['dawn',e=>e.factors.dawn],['carb counting',e=>e.factors.carb_counting],['event packs',e=>e.factors.event_packs.length?e.factors.event_packs:'none'],
    ['background packs',e=>e.factors.background_packs.length?e.factors.background_packs:'none'],['split',e=>e.split],['tier',e=>tiers[e.env_id]??null]];
  const distTables=dims.map(([label,get])=>{
    const cs=SETTINGS.map(s=>Object.fromEntries(counts(envs.filter(e=>e.setting===s),get)));
    const keys=[...new Set(cs.flatMap(Object.keys))].filter(k=>k!=='null'&&k!=='none'||label.includes('packs')||label==='meter'||label==='cgm').sort();
    return `<div class="dist"><h3>${esc(label)}</h3><table><tr><th></th>${SETTINGS.map(s=>`<th>${s}</th>`).join('')}</tr>${
      keys.map(k=>`<tr><td>${esc(k)}</td>${cs.map(c=>`<td class="n">${c[k]??0}</td>`).join('')}</tr>`).join('')}</table></div>`;
  }).join('');
  const sumTable=(track,label,key)=>{
    const refs=references[track];if(!refs)return '';
    const s=referenceSummary(envs,refs,key),pols=REFERENCE_POLICIES[track];
    return `<table class="sum"><tr><th>${esc(label)}</th><th>n</th>${pols.map(p=>`<th>${p}</th>`).join('')}</tr>${
      Object.entries(s).map(([k,v])=>`<tr><td>${esc(k)}</td><td class="n">${v.n}</td>${pols.map(p=>`<td class="n">${f2(v[p])}</td>`).join('')}</tr>`).join('')}</table>`;
  };
  const dropTable=track=>{const d=references[track]?robustnessDrop(envs,references[track]):null;if(!d)return '';
    return `<table class="sum"><tr><th>${track}</th><th>cells</th><th>clean</th><th>randomized</th><th>drop</th></tr>${
      Object.entries(d).map(([p,v])=>`<tr><td>${p}</td><td class="n">${v.cells}</td><td class="n">${f2(v.clean)}</td><td class="n">${f2(v.randomized)}</td><td class="n">${f2(v.drop)}</td></tr>`).join('')}</table>`;};
  const legend=RAMP.map((c,i)=>`<span style="background:${c};color:${ink((i+0.5)/RAMP.length)}">${(i/RAMP.length).toFixed(2)}</span>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(name)} coverage</title><style>
body{font:13px/1.45 system-ui,-apple-system,"PingFang SC",sans-serif;color:#1d2733;margin:24px;max-width:1500px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}h3{font-size:13px;margin:0 0 4px}
table{border-collapse:separate;border-spacing:2px}th,td{padding:4px 6px;text-align:center;border-radius:4px}
th{font-weight:600;color:#3b4754}th.t{text-align:left;min-width:220px}.m{font-weight:400;color:#6b7785;font-size:11px}
td.na{color:#b0b7bf}.p{font-size:11px}td.n{text-align:right;font-variant-numeric:tabular-nums}
.dist{display:inline-block;vertical-align:top;margin:0 18px 18px 0}.dist td:first-child,.sum td:first-child{text-align:left}
.legend span{display:inline-block;padding:2px 8px;font-size:11px}.note{color:#6b7785}
</style></head><body>
<h1>${esc(name)} 覆盖矩阵 / coverage</h1>
<p class="note">${envs.length} environments · ${TASKS.length} tasks × ${BACKEND_IDS.length} backends × ${SETTINGS.length} settings × ${seeds.length} seed(s) · generated ${esc(generated)} · re-draws ${redraws.length}</p>
<h2>任务 × 后端 × 设置（单元格：因果最优参照分数 S，全权赛道；悬停看全部参照）</h2>
<p class="legend">S: ${legend} · * = re-drawn seed · ♂/♀ person type</p>
<table><tr><th></th>${head}</tr>${rows}</table>
<h2>参照分数汇总 / reference scores (mean S)</h2>
<div class="dist">${sumTable('full','full · category',e=>CATEGORIES[e.category].en)}</div>
<div class="dist">${sumTable('full','full · backend',e=>e.backend)}</div>
<div class="dist">${sumTable('full','full · setting',e=>e.setting)}</div>
<div class="dist">${sumTable('full','full · split',e=>e.split)}</div>
<div class="dist">${sumTable('assisted','assisted · category',e=>CATEGORIES[e.category].en)}</div>
<div class="dist">${sumTable('assisted','assisted · backend',e=>e.backend)}</div>
<div class="dist">${sumTable('assisted','assisted · setting',e=>e.setting)}</div>
<h2>干净 → 随机化的掉分 / clean → randomized drop</h2>
<div class="dist">${dropTable('full')}</div><div class="dist">${dropTable('assisted')}</div>
${extraHtml}
<h2>各维度取值分布 / value distributions</h2>
${distTables}
</body></html>
`;
}

export function catalogMd({envs,references={},tiers={},name='opendiabet-v1'}) {
  const full=references.full??{},as=references.assisted??{};
  const lines=[`# ${name} catalog`,'',`${envs.length} environments. Columns: what the environment tests, person, sensors, split, difficulty tier, reference scores S`,
    '(full track: wait / patient / oref0 / causal / omniscient; assisted track: wait / oref0 / causal / omniscient). Harbor task ids: lower-case env id; the assisted track adds `-assisted`.','',
    '| env | task | tests | backend | setting | person | sensors | split | tier | full w/p/o/c/Ω | assisted w/o/c/Ω |','|---|---|---|---|---|---|---|---|---|---|---|'];
  const t=Object.fromEntries(TASKS.map(x=>[x.id,x]));
  for(const e of envs) {
    const r=full[e.env_id]??{},a=as[e.env_id]??{};
    lines.push(`| ${e.env_id} | ${t[e.task].title.zh} / ${t[e.task].title.en} | ${t[e.task].capability.zh} | ${e.backend} | ${e.setting} | ${e.factors.person_type} | ${e.factors.observation_profile} (${e.factors.cgm}/${e.factors.meter}) | ${e.split}${e.unseen_task?' ·unseen task':''}${e.unseen_backend?' ·unseen backend':''} | ${tiers[e.env_id]??'–'} | ${['wait','patient','oref0','causal','omniscient'].map(p=>f2(r[p])).join(' / ')} | ${['wait','oref0','causal','omniscient'].map(p=>f2(a[p])).join(' / ')} |`);
  }
  return lines.join('\n')+'\n';
}
