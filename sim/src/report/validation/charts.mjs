// Inline SVG charts of the validation report: dot plot, ordinal line chart with CI whiskers,
// forest plot, histogram. No external assets. One y-axis per chart, 2px lines, >= 8px markers
// with a surface ring, recessive grid, text in neutral ink; identity by a fixed agent -> color
// map (never by rank), always with an HTML legend for >= 2 series; native <title> tooltips on a
// hit target larger than the mark.
import {esc,fin,f3} from './util.mjs';

export const INK='#1f2328',INK2='#57606a',GRID='#e6e8eb',AXIS='#8c959f',SURFACE='#ffffff';
// Fixed categorical order (Okabe-Ito derived; CVD-separable). Color follows the agent, never its rank.
const PALETTE=['#0072B2','#E69F00','#009E73','#CC79A7','#D55E00','#56B4E9','#7F6000'];
const FIXED={wait:'#8c959f',patient:'#CC79A7',oref0:'#E69F00',causal:'#0072B2',omniscient:'#009E73',oracle:'#D55E00',
  adaptive:'#D55E00',fixed:'#CC79A7','cmd:scripts/exp3-agent-adaptive.mjs':'#D55E00'};
const assigned=new Map();
export function colorOf(key) {
  if(FIXED[key])return FIXED[key];
  if(!assigned.has(key))assigned.set(key,PALETTE[(assigned.size+5)%PALETTE.length]);
  return assigned.get(key);
}
export const labelOf=k=>k==='cmd:scripts/exp3-agent-adaptive.mjs'?'adaptive (cmd)':k;

export function legend(keys,{note=''}={}) {
  if(keys.length<2)return '';
  return `<div class="legend">${keys.map(k=>`<span><i style="background:${colorOf(k)}"></i>${esc(labelOf(k))}</span>`).join('')}${note?`<span class="lnote">${esc(note)}</span>`:''}</div>`;
}

const xScale=(x0,x1,a,b)=>v=>a+(v-x0)/(x1-x0)*(b-a);
const ticks=(lo,hi,n=4)=>Array.from({length:n+1},(_,i)=>lo+(hi-lo)*i/n);
const tickTxt=v=>Math.abs(v)<1e-9?'0':Math.abs(v-Math.round(v))<1e-9?String(Math.round(v)):v.toFixed(2).replace(/0$/,'');
const svgOpen=(w,h,label)=>`<svg class="chart" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}" font-family="inherit" font-size="11">`;

/**
 * Horizontal dot plot: one row per group, one dot per series on a shared x scale.
 * rows: [{label, values: {series: v}, n?}]; series: keys in fixed order.
 */
export function dotPlot({rows,series,title='',x0=0,x1=1,width=680,labelW=190,xLabel='mean score S (0–1)'}) {
  const rowH=24,top=8,h=top+rows.length*rowH+34,X=xScale(x0,x1,labelW,width-16);
  const o=[svgOpen(width,h,title)];
  for(const t of ticks(x0,x1))o.push(`<line x1="${X(t)}" x2="${X(t)}" y1="${top}" y2="${top+rows.length*rowH}" stroke="${GRID}"/>`,
    `<text x="${X(t)}" y="${top+rows.length*rowH+14}" text-anchor="middle" fill="${INK2}">${tickTxt(t)}</text>`);
  o.push(`<text x="${(labelW+width-16)/2}" y="${h-4}" text-anchor="middle" fill="${INK2}">${esc(xLabel)}</text>`);
  rows.forEach((r,i)=>{
    const y=top+i*rowH+rowH/2,vals=series.map(s=>[s,r.values[s]]).filter(([,v])=>fin(v));
    o.push(`<text x="${labelW-8}" y="${y+4}" text-anchor="end" fill="${INK}">${esc(r.label)}${r.n!=null?` <tspan fill="${INK2}">n=${r.n}</tspan>`:''}</text>`);
    if(vals.length>1){const xs=vals.map(([,v])=>X(v));o.push(`<line x1="${Math.min(...xs)}" x2="${Math.max(...xs)}" y1="${y}" y2="${y}" stroke="${GRID}" stroke-width="2"/>`);}
    for(const [s,v] of vals)o.push(`<g><circle cx="${X(v)}" cy="${y}" r="5" fill="${colorOf(s)}" stroke="${SURFACE}" stroke-width="1.5"/><circle cx="${X(v)}" cy="${y}" r="9" fill="transparent"><title>${esc(`${r.label} · ${labelOf(s)}: ${f3(v)}`)}</title></circle></g>`);
  });
  o.push('</svg>');
  return legend(series)+o.join('');
}

/**
 * Line chart over an ordinal (or day) x axis. series: [{key, points: [{x (index), y, lo?, hi?, tip?}]}].
 * CI whiskers are thin and nudged per series so overlapping intervals stay readable.
 */
export function lineChart({xLabels,series,title='',y0=0,y1=1,width=460,height=230,yLabel='score S (0–1)',xLabel='',directLabels=true}) {
  const L=44,R=directLabels&&series.length<=4?92:14,T=10,B=xLabel?46:32,X=xScale(-0.4,xLabels.length-0.6,L,width-R),Y=xScale(y0,y1,height-B,T);
  const o=[svgOpen(width,height,title)];
  for(const t of ticks(y0,y1))o.push(`<line x1="${L}" x2="${width-R}" y1="${Y(t)}" y2="${Y(t)}" stroke="${GRID}"/><text x="${L-6}" y="${Y(t)+4}" text-anchor="end" fill="${INK2}">${tickTxt(t)}</text>`);
  xLabels.forEach((l,i)=>o.push(`<text x="${X(i)}" y="${height-B+15}" text-anchor="middle" fill="${INK2}">${esc(l)}</text>`));
  if(xLabel)o.push(`<text x="${(L+width-R)/2}" y="${height-6}" text-anchor="middle" fill="${INK2}">${esc(xLabel)}</text>`);
  o.push(`<text transform="translate(11 ${(T+height-B)/2}) rotate(-90)" text-anchor="middle" fill="${INK2}">${esc(yLabel)}</text>`);
  const k=series.length,nud=j=>(j-(k-1)/2)*Math.min(5,60/Math.max(1,xLabels.length)/Math.max(1,k));
  const clampY=v=>Y(Math.max(y0,Math.min(y1,v)));
  series.forEach((s,j)=>{
    const c=colorOf(s.key),pts=s.points.filter(p=>fin(p.y));
    for(const p of pts)if(fin(p.lo)&&fin(p.hi))o.push(`<line x1="${X(p.x)+nud(j)}" x2="${X(p.x)+nud(j)}" y1="${clampY(p.lo)}" y2="${clampY(p.hi)}" stroke="${c}" stroke-width="1" opacity="0.55"/>`);
    if(pts.length>1)o.push(`<polyline points="${pts.map(p=>`${X(p.x)+nud(j)},${clampY(p.y)}`).join(' ')}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>`);
    for(const p of pts)o.push(`<g><circle cx="${X(p.x)+nud(j)}" cy="${clampY(p.y)}" r="4" fill="${c}" stroke="${SURFACE}" stroke-width="1.5"/><circle cx="${X(p.x)+nud(j)}" cy="${clampY(p.y)}" r="9" fill="transparent"><title>${esc(p.tip??`${labelOf(s.key)} · ${xLabels[p.x]}: ${f3(p.y)}${fin(p.lo)?` [${f3(p.lo)}, ${f3(p.hi)}]`:''}`)}</title></circle></g>`);
  });
  if(directLabels&&k<=4) {   // end labels, de-collided vertically, in neutral ink beside a colored key
    const ends=series.map(s=>{const p=[...s.points].reverse().find(q=>fin(q.y));return p?{key:s.key,y:clampY(p.y),x:X(p.x)}:null;}).filter(Boolean).sort((a,b)=>a.y-b.y);
    for(let i=1;i<ends.length;i++)if(ends[i].y-ends[i-1].y<13)ends[i].y=ends[i-1].y+13;
    for(const e of ends)o.push(`<rect x="${width-R+8}" y="${e.y-4}" width="8" height="8" rx="2" fill="${colorOf(e.key)}"/><text x="${width-R+20}" y="${e.y+4}" fill="${INK}">${esc(labelOf(e.key))}</text>`);
  }
  o.push('</svg>');
  return o.join('');
}

/** Forest plot: one row per estimate (point + 95% CI), reference line at 0. rows: [{label, key, mean, lo, hi, n?}]. */
export function forest({rows,title='',x0=-0.2,x1=0.6,width=680,labelW=250,xLabel='paired Δ score (95% bootstrap CI)'}) {
  const rowH=24,top=8,h=top+rows.length*rowH+34,X=xScale(x0,x1,labelW,width-16);
  const o=[svgOpen(width,h,title)];
  for(const t of ticks(x0,x1))o.push(`<line x1="${X(t)}" x2="${X(t)}" y1="${top}" y2="${top+rows.length*rowH}" stroke="${GRID}"/><text x="${X(t)}" y="${top+rows.length*rowH+14}" text-anchor="middle" fill="${INK2}">${tickTxt(t)}</text>`);
  if(x0<0&&x1>0)o.push(`<line x1="${X(0)}" x2="${X(0)}" y1="${top-4}" y2="${top+rows.length*rowH}" stroke="${AXIS}" stroke-width="1.5"/>`);
  o.push(`<text x="${(labelW+width-16)/2}" y="${h-4}" text-anchor="middle" fill="${INK2}">${esc(xLabel)}</text>`);
  const cl=v=>X(Math.max(x0,Math.min(x1,v)));
  rows.forEach((r,i)=>{
    const y=top+i*rowH+rowH/2,c=colorOf(r.key);
    o.push(`<text x="${labelW-8}" y="${y+4}" text-anchor="end" fill="${INK}">${esc(r.label)}${r.n!=null?` <tspan fill="${INK2}">n=${r.n}</tspan>`:''}</text>`);
    if(!fin(r.mean))return;
    if(fin(r.lo)&&fin(r.hi))o.push(`<line x1="${cl(r.lo)}" x2="${cl(r.hi)}" y1="${y}" y2="${y}" stroke="${c}" stroke-width="2"/>`);
    o.push(`<g><circle cx="${cl(r.mean)}" cy="${y}" r="5" fill="${c}" stroke="${SURFACE}" stroke-width="1.5"/><circle cx="${cl(r.mean)}" cy="${y}" r="10" fill="transparent"><title>${esc(`${r.label}: ${f3(r.mean)}${fin(r.lo)?` [${f3(r.lo)}, ${f3(r.hi)}]`:''}${r.n!=null?` n=${r.n}`:''}`)}</title></circle></g>`);
  });
  o.push('</svg>');
  return o.join('');
}

/** Histogram of values on [x0, x1] with fixed bins; optional threshold line (e.g. certification 0.95). */
export function histogram({values,key,title='',x0=0,x1=1,bins=20,width=230,height=130,threshold=null}) {
  const L=30,R=8,T=18,B=24,v=values.filter(fin),cnt=new Array(bins).fill(0);
  for(const x of v)cnt[Math.min(bins-1,Math.max(0,Math.floor((x-x0)/(x1-x0)*bins)))]++;
  const ymax=Math.max(1,...cnt),X=xScale(x0,x1,L,width-R),Y=xScale(0,ymax,height-B,T),bw=(width-R-L)/bins;
  const o=[svgOpen(width,height,title),`<text x="${L}" y="12" fill="${INK}" font-weight="600">${esc(title)} <tspan fill="${INK2}" font-weight="400">n=${v.length}</tspan></text>`];
  o.push(`<line x1="${L}" x2="${width-R}" y1="${height-B}" y2="${height-B}" stroke="${AXIS}"/>`);
  for(const t of [x0,(x0+x1)/2,x1])o.push(`<text x="${X(t)}" y="${height-B+13}" text-anchor="middle" fill="${INK2}">${tickTxt(t)}</text>`);
  o.push(`<text x="${L-4}" y="${Y(ymax)+4}" text-anchor="end" fill="${INK2}">${ymax}</text>`);
  cnt.forEach((c,i)=>{if(!c)return;const x=X(x0+(x1-x0)*i/bins)+1,y=Y(c),hh=height-B-y;
    o.push(`<rect x="${x}" y="${y}" width="${Math.max(1,bw-2)}" height="${hh}" rx="${Math.min(2,hh/2)}" fill="${colorOf(key)}"><title>${esc(`${tickTxt(x0+(x1-x0)*i/bins)}–${tickTxt(x0+(x1-x0)*(i+1)/bins)}: ${c}`)}</title></rect>`);});
  if(fin(threshold))o.push(`<line x1="${X(threshold)}" x2="${X(threshold)}" y1="${T}" y2="${height-B}" stroke="${INK}" stroke-dasharray="3 3"/>`);
  o.push('</svg>');
  return o.join('');
}
