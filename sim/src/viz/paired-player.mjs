import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const escape=x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
/** Reuses the existing native drawFrame renderer; trajectory records are not transformed. */
export function pairedPlayer({singlePlayerHtml,runs,groups,title='笔与泵 · 同场景对照',singlePlayerHref='player.html'}) {
  const scripts=[...singlePlayerHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length,2,'Expected a generated native player');
  const marker='// ---- page modes';
  assert.equal(scripts[1][1].split(marker).length,2,'Native renderer boundary changed');
  const renderer=scripts[1][1].split(marker)[0];
  const original=JSON.parse(scripts[0][1].replace(/^window.RUNS=/,'').replace(/;$/,''));
  assert.equal(new Set(runs.map(r=>r.id)).size,runs.length);
  assert(groups.length>0);
  const ids=new Set();
  for(const group of groups){
    assert(group.id&&group.label&&group.left&&group.right);assert(!ids.has(group.id));ids.add(group.id);
    const left=runs.find(r=>r.id===group.left),right=runs.find(r=>r.id===group.right);assert(left&&right&&left!==right);
    for(const run of [left,right]){assert.deepEqual(original.find(r=>r.id===run.id),run);assert.equal(run.hours,72);assert.equal(run.truth.length,865);assert(run._meta?.native_audit_valid&&run._meta.no_tail_fill);}
    assert.equal(left.start,right.start);assert.equal(left.utc_offset_minutes,right.utc_offset_minutes);
  }
  const data=JSON.stringify({runs,groups}).replaceAll('<','\\u003c');
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:#1f2328;font:14px system-ui,sans-serif;letter-spacing:0}header{display:flex;align-items:center;gap:16px;padding:14px 20px;background:#fff;border-bottom:1px solid #d0d7de;flex-wrap:wrap}h1{font-size:18px;margin:0}header a{margin-left:auto;color:#2f5d9e}#controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 20px;background:#fff;border-bottom:1px solid #d0d7de;position:sticky;top:0;z-index:2}button,select{font:inherit;background:#fff;color:inherit;border:1px solid #d0d7de;border-radius:4px;min-height:34px;max-width:100%}button{width:36px;font-size:17px;cursor:pointer}button:hover{background:#eef1f5}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #2f5d9e;outline-offset:2px}select{padding:0 6px}label{display:flex;gap:6px;align-items:center;min-width:0}#scrub{flex:1;min-width:150px;accent-color:#2f5d9e}#elapsed{font-variant-numeric:tabular-nums;min-width:114px}.pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);max-width:2560px;margin:auto}section{min-width:0}section+section{border-left:1px solid #d0d7de}.heading{display:flex;gap:10px;align-items:center;justify-content:space-between;background:#fff;padding:12px 20px;border-bottom:1px solid #d0d7de;flex-wrap:wrap}h2{font-size:16px;margin:0}.score{font-variant-numeric:tabular-nums;color:#57606a;overflow-wrap:anywhere}canvas{display:block;width:100%;height:auto;aspect-ratio:16/9}@media(max-width:800px){.pair{grid-template-columns:minmax(0,1fr)}section+section{border-left:0;border-top:1px solid #d0d7de}header,#controls{padding:10px 12px;gap:8px}#scrub{order:3;flex-basis:100%}.heading{padding:10px 12px}}</style>
<header><h1>${escape(title)}</h1><a href="${escape(singlePlayerHref)}">单轨迹报告</a></header>
<div id="controls"><label>场景<select id="scene">${groups.map(g=>`<option value="${escape(g.id)}">${escape(g.label)}</option>`).join('')}</select></label><button id="play" title="播放" aria-label="播放">&#9654;</button><button id="reset" title="回到起点" aria-label="回到起点">&#8634;</button><label>速度<select id="speed"><option value="10">10分钟/秒</option><option value="32" selected>32分钟/秒</option><option value="60">1小时/秒</option><option value="120">2小时/秒</option></select></label><label>单位<select id="units"><option value="mmol">mmol/L</option><option value="mgdl">mg/dL</option></select></label><input id="scrub" type="range" min="0" max="4320" step="1" value="0" aria-label="两条轨迹的共同模拟时间"><output id="elapsed">00:00 / 72:00</output></div>
<main class="pair"><section><div class="heading"><h2 id="left-title"></h2><span class="score" id="left-score"></span></div><canvas id="left" width="1280" height="720" aria-label="笔的完整72小时轨迹"></canvas></section><section><div class="heading"><h2 id="right-title"></h2><span class="score" id="right-score"></span></div><canvas id="right" width="1280" height="720" aria-label="泵的完整72小时轨迹"></canvas></section></main>
<script>window.PAIRED_DATA=${data};window.RUNS=window.PAIRED_DATA.runs;</script><script>
${renderer}
const data=window.PAIRED_DATA,canvases=[document.getElementById('left'),document.getElementById('right')],scene=document.getElementById('scene'),play=document.getElementById('play'),scrub=document.getElementById('scrub'),speed=document.getElementById('speed'),units=document.getElementById('units'),elapsed=document.getElementById('elapsed');
const params=new URLSearchParams(location.search);let minute=Math.max(0,Math.min(4320,Number(params.get('t')??0)||0)),playing=false,last=performance.now(),pair=[];
units.value=UNITS;scene.value=data.groups.some(g=>g.id===params.get('scene'))?params.get('scene'):data.groups[0].id;
function choose(){const group=data.groups.find(g=>g.id===scene.value);pair=[group.left,group.right].map(id=>prepare(structuredClone(data.runs.find(r=>r.id===id))));const ymin=Math.min(...pair.map(r=>r._ymin)),ymax=Math.max(...pair.map(r=>r._ymax));for(const run of pair){run._ymin=ymin;run._ymax=ymax;}['left','right'].forEach((side,i)=>{const run=pair[i],version=run.metrics.scoring_version??'METRICS-v0.3';document.getElementById(side+'-title').textContent=(i===0?'笔':'泵')+' · '+run.therapy.device;document.getElementById(side+'-score').textContent=version+' '+run.metrics.score.toFixed(version.startsWith('COGI')?2:4)+(version.startsWith('COGI')?' /100':' /1');});render();}
function render(){for(let i=0;i<pair.length;i++){ctx=canvases[i].getContext('2d');drawFrame(pair[i],minute);canvases[i].dataset.minute=minute.toFixed(3);canvases[i].dataset.scene=scene.value;}scrub.value=String(minute);elapsed.value=String(Math.floor(minute/60)).padStart(2,'0')+':'+String(Math.floor(minute%60)).padStart(2,'0')+' / 72:00';play.textContent=String.fromCodePoint(playing?0x23f8:0x25b6);play.title=playing?'暂停':'播放';play.setAttribute('aria-label',play.title);}
play.onclick=()=>{if(minute>=4320)minute=0;playing=!playing;last=performance.now();render();};document.getElementById('reset').onclick=()=>{minute=0;playing=false;render();};scrub.oninput=()=>{minute=Number(scrub.value);playing=false;render();};units.onchange=()=>{UNITS=units.value;render();};scene.onchange=()=>{playing=false;choose();};document.addEventListener('keydown',e=>{if(e.code==='Space'&&e.target===document.body){e.preventDefault();play.click();}});
function tick(now){const dt=Math.min(.25,(now-last)/1000);last=now;if(playing){minute=Math.min(4320,minute+dt*Number(speed.value));if(minute>=4320)playing=false;render();}requestAnimationFrame(tick);}choose();requestAnimationFrame(tick);
</script></html>`;
  return {html,renderer_sha256:createHash('sha256').update(renderer).digest('hex'),groups:groups.map(g=>({...g})),unchanged_runs:true};
}
