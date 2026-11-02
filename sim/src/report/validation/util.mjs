// Shared helpers of the validation report (scripts/validation-report.mjs): tolerant file reading,
// small statistics (mean, seeded percentile bootstrap) and HTML formatting.
import fs from 'node:fs';
import path from 'node:path';

export const exists=f=>{try{fs.accessSync(f);return true;}catch{return false;}};
export const readJson=f=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return null;}};
export const readJsonl=f=>{try{return fs.readFileSync(f,'utf8').split('\n').filter(l=>l.trim()).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean);}catch{return [];}};
export const listDir=d=>{try{return fs.readdirSync(d,{withFileTypes:true});}catch{return [];}};
export const mtime=f=>{try{return fs.statSync(f).mtimeMs;}catch{return null;}};

export const fin=v=>typeof v==='number'&&Number.isFinite(v);
export const mean=xs=>{const v=xs.filter(fin);return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;};

/** mulberry32: deterministic bootstrap so the page does not change between runs on the same data. */
function rng(seed){let a=seed>>>0;return ()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};}

/** Mean and percentile-bootstrap 95% CI of xs (resampling the units themselves). */
export function bootMean(xs,{B=2000,seed=7}={}) {
  const v=xs.filter(fin),n=v.length;
  if(!n)return {mean:null,lo:null,hi:null,n:0};
  const r=rng(seed),ms=new Float64Array(B);
  for(let b=0;b<B;b++){let s=0;for(let i=0;i<n;i++)s+=v[(r()*n)|0];ms[b]=s/n;}
  ms.sort();
  return {mean:mean(v),lo:ms[Math.floor(0.025*(B-1))],hi:ms[Math.ceil(0.975*(B-1))],n};
}

/** Spearman rank correlation of two equally long arrays (average ranks for ties). */
export function spearman(a,b) {
  const rank=xs=>{const o=xs.map((v,i)=>[v,i]).sort((p,q)=>p[0]-q[0]),r=new Array(xs.length);
    for(let i=0;i<o.length;){let j=i;while(j+1<o.length&&o[j+1][0]===o[i][0])j++;for(let k=i;k<=j;k++)r[o[k][1]]=(i+j)/2;i=j+1;}return r;};
  if(a.length<2)return null;
  const ra=rank(a),rb=rank(b),ma=mean(ra),mb=mean(rb);
  let num=0,da=0,db=0;for(let i=0;i<a.length;i++){num+=(ra[i]-ma)*(rb[i]-mb);da+=(ra[i]-ma)**2;db+=(rb[i]-mb)**2;}
  return da&&db?num/Math.sqrt(da*db):null;
}

export const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const f2=v=>fin(v)?v.toFixed(2):'–';
export const f3=v=>fin(v)?v.toFixed(3):'–';
export const sgn3=v=>fin(v)?(v>=0?'+':'−')+Math.abs(v).toFixed(3):'–';
export const pct=v=>fin(v)?(100*v).toFixed(1)+'%':'–';
export const ci=(lo,hi)=>fin(lo)&&fin(hi)?`[${f3(lo)}, ${f3(hi)}]`:'';
/** mg/dL -> mmol/L (glucose is shown in mmol/L on this page). */
export const mmol=mgdl=>fin(mgdl)?(mgdl/18.016).toFixed(1):'–';

/** Relative href from the report directory to a repo path (posix separators). */
export const hrefFrom=(outDir,root)=>p=>path.relative(outDir,path.resolve(root,p)).split(path.sep).join('/');
