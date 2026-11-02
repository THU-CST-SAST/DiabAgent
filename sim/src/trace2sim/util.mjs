// Small shared helpers for trace2sim: time handling, local days, statistics, parameter transforms.

export const MIN_MS=60000;
export const DAY_MS=86400000;

/** Epoch ms from an ISO string, epoch ms or epoch seconds; NaN if unparsable. */
export function toMs(v) {
  if(v instanceof Date)return v.getTime();
  if(typeof v==='number')return v<1e11?v*1000:v;          // seconds vs milliseconds
  if(typeof v==='string') {
    if(/^\d+$/.test(v))return toMs(Number(v));
    return Date.parse(v);
  }
  return NaN;
}

/** Offset (minutes east of UTC) of an IANA zone at a given instant, via Intl. */
export function zoneOffsetMinutes(tz,atMs) {
  const f=new Intl.DateTimeFormat('en-US',{timeZone:tz,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const p=Object.fromEntries(f.formatToParts(new Date(atMs)).map(x=>[x.type,x.value]));
  const asUtc=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);
  return Math.round((asUtc-Math.floor(atMs/1000)*1000)/MIN_MS);
}

export const localMinuteOfDay=(ms,off)=>(((ms+off*MIN_MS)%DAY_MS+DAY_MS)%DAY_MS)/MIN_MS;
export const localDayKey=(ms,off)=>new Date(ms+off*MIN_MS).toISOString().slice(0,10);
/** Epoch ms of local midnight that starts the given local day key. */
export const localDayStart=(key,off)=>Date.parse(`${key}T00:00:00Z`)-off*MIN_MS;
export const hhmmToMinutes=s=>{const [h,m]=String(s).split(':').map(Number);return h*60+(m||0);};
export const minutesToHhmm=m=>{m=((Math.round(m)%1440)+1440)%1440;return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;};

export const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
export const sum=a=>a.reduce((s,v)=>s+v,0);
export const mean=a=>a.length?sum(a)/a.length:NaN;
export function sd(a) {if(a.length<2)return 0;const m=mean(a);return Math.sqrt(sum(a.map(v=>(v-m)**2))/(a.length-1));}
export function median(a) {
  if(!a.length)return NaN;const s=[...a].sort((x,y)=>x-y),k=s.length>>1;
  return s.length%2?s[k]:(s[k-1]+s[k])/2;
}
export function quantile(a,q) {
  if(!a.length)return NaN;const s=[...a].sort((x,y)=>x-y),i=(s.length-1)*q,lo=Math.floor(i),hi=Math.ceil(i);
  return s[lo]+(s[hi]-s[lo])*(i-lo);
}
export const round=(v,d=3)=>v==null||!Number.isFinite(v)?v:Number(v.toFixed(d));

/**
 * Parameter transforms between natural values and the unconstrained optimiser space.
 * log: (0, inf); bounded: (lo, hi) via a logistic; linear: identity.
 */
export function toZ(v,t) {
  if(t.transform==='log')return Math.log(v);
  if(t.transform==='bounded') {
    const [lo,hi]=t.bounds,u=clamp((v-lo)/(hi-lo),1e-6,1-1e-6);
    return Math.log(u/(1-u));
  }
  return v;
}
export function fromZ(z,t) {
  let v;
  if(t.transform==='log')v=Math.exp(z);
  else if(t.transform==='bounded'){const [lo,hi]=t.bounds;v=lo+(hi-lo)/(1+Math.exp(-z));}
  else v=z;
  if(t.bounds&&t.transform!=='bounded')v=clamp(v,t.bounds[0],t.bounds[1]);
  return v;
}
/** d(natural)/dz, for delta-method standard errors. */
export function dNaturalDz(z,t) {
  if(t.transform==='log')return Math.exp(z);
  if(t.transform==='bounded'){const [lo,hi]=t.bounds,s=1/(1+Math.exp(-z));return (hi-lo)*s*(1-s);}
  return 1;
}

/** Deterministic PRNG (mulberry32) for bootstrap resampling. */
export function prng(seed) {
  let a=seed>>>0;
  return ()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
}
