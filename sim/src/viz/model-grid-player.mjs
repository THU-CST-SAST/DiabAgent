import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// One world, every model side by side: the same 72 hours replayed on N canvases that share one time
// cursor and one y-scale, so the trajectories are read against each other rather than each against
// its own axis. The frame renderer is taken verbatim from scripts/video/player.js; run records are
// passed through unchanged.
const escape=x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

/** Extracts the native drawFrame/prepare renderer from a generated single-trajectory player page. */
export function playerRenderer(singlePlayerHtml) {
  const scripts=[...singlePlayerHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length,2,'Expected a generated native player');
  const marker='// ---- page modes';
  const body=scripts[1][1];
  assert.equal(body.split(marker).length,2,'Native renderer boundary changed');
  return body.split(marker)[0];
}

/**
 * runs: run records for one world, in display order. Each needs _meta.model_name and _meta.score.
 * Returns {html, renderer_sha256}.
 */
export function modelGridPlayer({renderer,runs,world,title,subtitle,indexHref='../index.html',columns=2}) {
  assert(runs.length>=1&&runs.length<=6);
  assert.equal(new Set(runs.map(r=>r.id)).size,runs.length,'Duplicate run id: every panel must be a different run');
  for(const r of runs){
    assert(r._meta?.model_name,'Each run needs _meta.model_name');
    assert.equal(r.hours,72,'Expected a complete 72h world');assert.equal(r.truth.length,865,'Expected 865 truth samples');
    assert.equal(r.start,runs[0].start,'Panels must share one world start time');
    assert.equal(r.utc_offset_minutes,runs[0].utc_offset_minutes,'Panels must share one local time zone');
  }
  const data=JSON.stringify({runs,world}).replaceAll('<','\\u003c');
  const best=Math.max(...runs.map(r=>r._meta.score??-Infinity));
  const cards=runs.map((r,i)=>`<section class="cell">
  <div class="head"><h2>${escape(r._meta.model_name)}</h2><span class="score${r._meta.score===best?' best':''}">${r._meta.score==null?'–':r._meta.score.toFixed(1)}</span>${r._meta.stage&&r._meta.stage!=='original'?`<span class="tag" title="该世界经中断续跑或扩预算后完成">${escape(r._meta.stage)}</span>`:''}</div>
  <canvas id="c${i}" width="1280" height="720" aria-label="${escape(r._meta.model_name)} 的完整 72 小时轨迹"></canvas>
</section>`).join('\n');
  const html=`<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#eef1f4;color:#1f2328;font:14px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px;padding:12px 20px;background:#fff;border-bottom:1px solid #d8dee4;position:sticky;top:0;z-index:3}
header h1{font-size:17px;margin:0}
header .sub{color:#57606a;font-size:13px}
header a{margin-left:auto;color:#0969da}
#controls{display:flex;gap:10px;align-items:center;padding:10px 20px;flex-wrap:wrap;background:#fff;border-bottom:1px solid #d8dee4;position:sticky;top:46px;z-index:2}
#controls select,#controls button{font:inherit;padding:4px 8px;border:1px solid #d0d7de;border-radius:6px;background:#fff;cursor:pointer}
#scrub{flex:1;min-width:220px}
#clock{font-variant-numeric:tabular-nums;color:#57606a;min-width:122px}
main{display:grid;grid-template-columns:repeat(${columns},minmax(0,1fr));gap:14px;padding:14px 20px 40px}
@media (max-width:900px){main{grid-template-columns:1fr}#controls{top:64px}}
.cell{background:#fff;border:1px solid #d8dee4;border-radius:10px;padding:10px;min-width:0}
.head{display:flex;align-items:baseline;gap:8px;margin:0 0 6px}
.head h2{font-size:14px;margin:0}
.score{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600}
.score.best{color:#1a7f37}
.tag{font-size:11px;color:#9a6700;background:#fff4d6;border-radius:4px;padding:1px 5px}
canvas{display:block;width:100%;height:auto;background:#f6f7f9;border-radius:6px}
</style>
<header><h1>${escape(title)}</h1><span class="sub">${escape(subtitle??'')}</span><a href="${escape(indexHref)}">← 全部世界</a></header>
<div id="controls">
  <button id="play" aria-label="播放">播放</button>
  <button id="reset" aria-label="回到开头">⟲</button>
  <label>速度 <select id="speed"><option value="32">32 分钟/秒</option><option value="60" selected>1 小时/秒</option><option value="120">2 小时/秒</option><option value="240">4 小时/秒</option></select></label>
  <label>单位 <select id="units"><option value="mmol">mmol/L</option><option value="mgdl">mg/dL</option></select></label>
  <input id="scrub" type="range" min="0" max="4320" step="1" value="0" aria-label="时间">
  <span id="clock"></span>
</div>
<main>
${cards}
</main>
<script>window.GRID=${data};window.RUNS=window.GRID.runs;</script>
<script>
${renderer}
(()=>{
const data=window.GRID,canvases=data.runs.map((_,i)=>document.getElementById('c'+i));
const play=document.getElementById('play'),scrub=document.getElementById('scrub'),speed=document.getElementById('speed'),units=document.getElementById('units'),clock=document.getElementById('clock');
const params=new URLSearchParams(location.search);
let minute=Math.max(0,Math.min(4320,Number(params.get('t')??0)||0)),playing=false,last=performance.now();
units.value=UNITS;
// One shared y-scale, so a flat line in one panel means the same thing as a flat line in another.
const prepared=data.runs.map(r=>prepare(structuredClone(r)));
const ymin=Math.min(...prepared.map(r=>r._ymin)),ymax=Math.max(...prepared.map(r=>r._ymax));
for(const r of prepared){r._ymin=ymin;r._ymax=ymax;}
function stamp(m){const t=new Date(Date.parse(prepared[0].start)+prepared[0].utc_offset_minutes*60000+m*60000);
  return '第 '+(Math.floor(m/1440)+1)+' 天 '+String(t.getUTCHours()).padStart(2,'0')+':'+String(t.getUTCMinutes()).padStart(2,'0');}
function render(){for(let i=0;i<prepared.length;i++){ctx=canvases[i].getContext('2d');drawFrame(prepared[i],minute);}
  scrub.value=String(Math.round(minute));clock.textContent=stamp(minute);play.textContent=playing?'暂停':'播放';}
play.onclick=()=>{if(minute>=4320)minute=0;playing=!playing;last=performance.now();render();};
document.getElementById('reset').onclick=()=>{minute=0;playing=false;render();};
scrub.oninput=()=>{minute=Number(scrub.value);playing=false;render();};
units.onchange=()=>{UNITS=units.value;render();};
addEventListener('keydown',e=>{if(e.key===' '){e.preventDefault();play.click();}
  else if(e.key==='ArrowRight'){minute=Math.min(4320,minute+60);playing=false;render();}
  else if(e.key==='ArrowLeft'){minute=Math.max(0,minute-60);playing=false;render();}});
function tick(now){const dt=Math.min(.25,(now-last)/1000);last=now;
  if(playing){minute=Math.min(4320,minute+dt*Number(speed.value));if(minute>=4320)playing=false;render();}
  requestAnimationFrame(tick);}
render();requestAnimationFrame(tick);
})();
</script>
</html>`;
  return {html,renderer_sha256:createHash('sha256').update(renderer).digest('hex')};
}
