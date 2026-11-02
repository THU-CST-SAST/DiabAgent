// Deterministic open-loop replay of a recorded trace on the Deichmann2023 kernel.
//
// The recorded insulin (basal timeline, boluses, extended boluses, long-acting injections) and
// carbs are injected exactly at their times: no controller, no device rules, no scenario
// randomness. Physiology parameters, initial state and meal/depot pools come from
// src/core/physiology.mjs (same equations as World); integration here is a lighter driver:
// fixed 1-minute RK4 steps on a flat state vector (0.1-minute steps while exercise states are
// active, using the kernel's own derivative function), which is ~50x faster than stepping a
// World and accurate to well below CGM resolution (see test/trace2sim.test.mjs parity test).
//
// Initial state: steady state of the basal rate at the first CGM time with glucose equal to
// the first CGM value (pump), or the long-acting history before the trace (MDI; doses before
// the first reading are taken from the trace, otherwise the first day's doses are repeated).
import {Physiology} from '../core/physiology.mjs';
import {INSULINS} from '../core/insulins.mjs';
import {longActingRates} from '../core/pk.mjs';
import {basalTimeline} from './ingest.mjs';
import {MIN_MS,DAY_MS,localMinuteOfDay,localDayKey} from './util.mjs';

const CORE=14;   // x1 x2 I X Q1 Q2 Y Z rGU rGP tPA PAint rdepl th
const PRELOAD_DAYS=10;
export const DEFAULT_ABSORPTION_MINUTES=45;
export const CORRECTION_ABSORPTION_MINUTES=20;

/** Accelerometer counts for a recorded exercise bout (Deichmann 2023 Fig. 4 anchors). */
export function exerciseAC(e) {
  if(Number.isFinite(e.accelerometer_counts))return e.accelerometer_counts;
  const pct=typeof e.intensity==='number'?e.intensity:{light:25,moderate:30,vigorous:60}[e.intensity]??30;
  return pct<=30?pct/30*2095:2095+(pct-30)/30*2222;
}

/** Dawn-phenomenon shape (0..1) at a local minute of day, identical to World.sensitivityMultiplier. */
export function dawnShape(local) {
  return local<180?0:local<300?(local-180)/120:local<480?1:local<600?(600-local)/120:0;
}

export function rapidInsulinOf(meta) {
  const t=meta.therapy;
  const name=t.mode==='mdi'?t.mdi?.bolus_insulin:t.pump?.insulin;
  return INSULINS[name]?name:'aspart';
}

/**
 * Precomputes everything that does not depend on the fitted parameters.
 * opts: {from, to} epoch ms window (default: first..last CGM); cgmTauMinutes.
 */
export function buildPlan(trace,opts={}) {
  const off=trace.meta.utc_offset_minutes;
  const from=opts.from??trace.cgm[0].t,to=opts.to??trace.cgm.at(-1).t;
  const t0=Math.floor(from/MIN_MS)*MIN_MS,N=Math.max(1,Math.ceil((to-t0)/MIN_MS)+1);
  const end=t0+N*MIN_MS,mOf=t=>Math.round((t-t0)/MIN_MS);
  const inRange=t=>t>=t0&&t<end;

  // Primary insulin rate per minute (U/h): delivered basal plus extended boluses, overlap-weighted.
  const rate=new Float64Array(N);
  const addRate=(a,b,uph)=>{
    a=Math.max(a,t0);b=Math.min(b,end);if(!(b>a))return;
    for(let m=Math.floor((a-t0)/MIN_MS);m<N&&t0+m*MIN_MS<b;m++) {
      const s=Math.max(a,t0+m*MIN_MS),e=Math.min(b,t0+(m+1)*MIN_MS);
      if(e>s)rate[m]+=uph*(e-s)/MIN_MS;
    }
  };
  for(const seg of basalTimeline(trace,t0,end))addRate(seg.from,seg.to,seg.rate_u_h);
  const boluses=[];
  for(const b of trace.boluses) {
    if(b.extended_minutes>0)addRate(b.t,b.t+b.extended_minutes*MIN_MS,b.units*60/b.extended_minutes);
    else if(inRange(b.t))boluses.push({m:mOf(b.t),units:b.units});
  }
  const meals=trace.carbs.filter(c=>inRange(c.t)).map((c,i)=>({i,t:c.t,m:mOf(c.t),grams:c.grams,kind:c.kind,
    absorption:c.absorption_minutes??(c.kind==='correction'?CORRECTION_ABSORPTION_MINUTES:DEFAULT_ABSORPTION_MINUTES),
    day:localDayKey(c.t,off)}));
  const basalInsulin=trace.meta.therapy.mdi?.basal_insulin;
  const depotOf=name=>(INSULINS[name]??INSULINS[basalInsulin]??INSULINS.glargine_u100??Object.values(INSULINS).find(x=>x.class==='long')).depot;
  const longActing=trace.basal_injections.filter(d=>inRange(d.t)).map(d=>({m:mOf(d.t),units:d.units,depot:depotOf(d.insulin)}));
  let ac=null;
  for(const e of trace.exercise) {
    const a=Math.max(0,mOf(e.t)),b=Math.min(N,mOf(e.t+e.duration_minutes*MIN_MS));if(b<=a)continue;
    ac??=new Float32Array(N);const v=exerciseAC(e);for(let m=a;m<b;m++)ac[m]=Math.max(ac[m],v);
  }
  const dawn=new Float32Array(N),day=new Int32Array(N),dayKeys=[];
  for(let m=0;m<N;m++) {
    const t=t0+m*MIN_MS;dawn[m]=dawnShape(localMinuteOfDay(t,off));
    const k=localDayKey(t,off);if(dayKeys.at(-1)!==k)dayKeys.push(k);day[m]=dayKeys.length-1;
  }
  const samples=trace.cgm.filter(r=>r.t>=t0&&r.t<=t0+(N-1)*MIN_MS).map(r=>({t:r.t,y:r.mg_dl,x:(r.t-t0)/MIN_MS,day:localDayKey(r.t,off)}));
  const sensor=String(trace.meta.cgm_model??'');
  return {t0,N,off,rate,boluses,meals,longActing,ac,dawn,day,dayKeys,samples,
    weightKg:trace.meta.weight_kg,mdi:trace.meta.therapy.mode==='mdi',rapid:rapidInsulinOf(trace.meta),
    initialGlucose:trace.cgm[0].mg_dl,initialBasalUph:rate[0],
    cgmTauMinutes:opts.cgmTauMinutes??(/libre/.test(sensor)?5:/ideal|legacy/.test(sensor)?0:3.8),
    preloadDoses:mdiPreloadDoses(trace,t0,depotOf),_preload:null};
}

function mdiPreloadDoses(trace,t0,depotOf) {
  if(trace.meta.therapy.mode!=='mdi')return [];
  const before=trace.basal_injections.filter(d=>d.t<t0&&d.t>=t0-PRELOAD_DAYS*DAY_MS);
  let doses=before;
  if(!before.some(d=>d.t>=t0-2*DAY_MS)) {
    // Steady-state assumption: the first day's routine repeated over the preceding days.
    const first=trace.basal_injections.filter(d=>d.t>=t0&&d.t<t0+DAY_MS);
    doses=[];for(let k=1;k<=PRELOAD_DAYS;k++)for(const d of first)doses.push({...d,t:d.t-k*DAY_MS});
  }
  return doses.map((d,i)=>({id:`pre:${i}`,at_minute:(d.t-t0)/MIN_MS,units:d.units,depot:depotOf(d.insulin)}));
}

/** Natural-scale physiology parameters (missing keys use kernel defaults). */
function physiologyFor(plan,p) {
  return new Physiology({weightKg:plan.weightKg,initialGlucose:p.initial_glucose??plan.initialGlucose,
    basalUph:plan.mdi?0:plan.initialBasalUph,pk:INSULINS[plan.rapid].pk,
    person:{sensitivity:p.sensitivity??1,glucose_effectiveness:p.glucose_effectiveness??null,basal_glucose:p.basal_glucose??null,
      carb_bioavailability:p.carb_bioavailability??null,meal_absorption_scale:p.meal_absorption_scale??1}});
}

/**
 * Integrates the plan with parameters p and latent effects.
 * p: {sensitivity, glucose_effectiveness, basal_glucose, carb_bioavailability, meal_absorption_scale, dawn_fraction}
 * latent: {mealScale?: number[] per plan meal, extraMeals?: [{m, grams, absorption}],
 *          daySens?: number[] per plan day, anchors?: [{m, glucose}]}
 * Returns {ok, G, IG} (plasma and interstitial glucose per minute, length N+1).
 */
export function simulate(plan,p,latent={}) {
  const phys=physiologyFor(plan,p),P=phys.params,f=phys.fast;
  const N=plan.N,G=new Float64Array(N+1),IG=new Float64Array(N+1);
  const sens=p.sensitivity??1,dawnF=p.dawn_fraction??0,AG=P.AG,absScale=p.meal_absorption_scale??1;
  const vol=P.Vi*P.BW,k2v=P.k2/vol,Xb=P.p3/P.p2*P.Ib,basalTerm=(P.p1+Xb)*P.Gb*P.Vg,invBW=1/P.BW;

  // Initial state.
  const st=phys.state;
  if(plan.mdi&&plan.preloadDoses.length) {
    if(!plan._preload) {
      const ref=physiologyFor(plan,{});ref.preloadLongActing(plan.preloadDoses,plan.initialGlucose);
      plan._preload={I:ref.state.I,X:ref.state.X,depots:ref.depots.map(d=>({...d}))};
    }
    Object.assign(st,{x1:0,x2:0,I:plan._preload.I,X:plan._preload.X*sens});
  }
  let L=CORE;
  let s=new Float64Array(256),tmp=new Float64Array(256),d1=new Float64Array(256),d2=new Float64Array(256),d3=new Float64Array(256),d4=new Float64Array(256);
  const keys=['x1','x2','I','X','Q1','Q2','Y','Z','rGU','rGP','tPA','PAint','rdepl','th'];
  keys.forEach((k,i)=>s[i]=st[k]);
  const mealTau=[],dep=[];   // dep: {kLag, ka, k2, k3}
  const grow=()=>{if(L+3>s.length){const n=s.length*2,g=a=>{const b=new Float64Array(n);b.set(a);return b;};
    s=g(s);tmp=new Float64Array(n);d1=new Float64Array(n);d2=new Float64Array(n);d3=new Float64Array(n);d4=new Float64Array(n);}};
  const addMeal=(grams,tau)=>{
    // Meal pools occupy [CORE, CORE+2*nMeals); depots follow, so shift them up.
    grow();const at=CORE+2*mealTau.length;
    for(let i=L-1;i>=at;i--)s[i+2]=s[i];
    s[at]=grams*1000*AG;s[at+1]=0;mealTau.push(tau);L+=2;
  };
  const addDepot=(units,d)=>{grow();dep.push(d);s[L]=units*1e6;s[L+1]=0;s[L+2]=0;L+=3;};
  if(plan.mdi&&plan._preload)for(const d of plan._preload.depots)addDepot(0,{kLag:d.kLag,ka:d.ka,k2:d.k2,k3:d.k3}),s[L-3]=d.a,s[L-2]=d.b,s[L-1]=d.c;

  // Event cursors.
  const bol=plan.boluses,meals=plan.meals,la=plan.longActing,extra=(latent.extraMeals??[]).slice().sort((a,b)=>a.m-b.m);
  const anchors=(latent.anchors??[]).slice().sort((a,b)=>a.m-b.m);
  let bi=0,mi=0,li=0,ei=0,ai=0;
  const mealScale=latent.mealScale,daySens=latent.daySens;
  const rate=plan.rate,ac=plan.ac,dawn=plan.dawn,day=plan.day;
  const igAlpha=plan.cgmTauMinutes>0?1-Math.exp(-1/plan.cgmTauMinutes):1;
  let ig=s[4]/P.Vg;G[0]=ig;IG[0]=ig;

  let uSlow=0,uFast=0,kIns=0;
  const fast=(x,d)=>{
    const nm=mealTau.length;let Ra=0;
    for(let i=0;i<nm;i++){const o=CORE+2*i,a=x[o],b=x[o+1],tau=mealTau[i];Ra+=b/tau;d[o]=-a/tau;d[o+1]=(a-b)/tau;}
    let dI=k2v*x[1]-P.k4*x[2];
    for(let j=0,o=CORE+2*nm;j<dep.length;j++,o+=3){const c=dep[j],a=x[o],b=x[o+1],cc=x[o+2];
      d[o]=-c.kLag*a;d[o+1]=c.kLag*a-c.ka*b;d[o+2]=c.ka*b-(c.k2+c.k3)*cc;dI+=c.k2/vol*cc;}
    const X=x[3],Q1=x[4],Q2=x[5],Z=x[7],rGU=x[8],rGP=x[9],rdepl=x[12];
    d[0]=-P.k1*x[0]+uSlow;d[1]=P.k1*x[0]-(P.k2+P.k3)*x[1]+uFast;d[2]=dI;d[3]=-P.p2*X+P.p3*kIns*x[2];
    d[4]=-(P.p1+rGU-(rGP-rdepl)+(1+Z)*X)*Q1-P.p4*Q1+P.p5*Q2+basalTerm+Ra*invBW;
    d[5]=P.p4*Q1-P.p5*Q2;
    d[6]=-x[6]/P.tau_AC;d[7]=-Z/P.tau_Z;d[8]=-P.q2*rGU;d[9]=-P.q4l*rGP;d[10]=-x[10];d[11]=-x[11];d[12]=-P.q6*rdepl;d[13]=-P.q5*x[13];
  };
  let acNow=0;const obj={};
  const full=(x,d)=>{
    fast(x,d);   // meals, depots and insulin rows are shared
    let Ra=0;for(let i=0;i<mealTau.length;i++)Ra+=x[CORE+2*i+1]/mealTau[i];
    for(let i=0;i<CORE;i++)obj[keys[i]]=x[i];
    // Insulin rows (0-3) come from fast(); the kernel supplies glucose and exercise rows.
    const k=phys.model.computeDerivatives(null,obj,{iir:0,AC:acNow,Ra});
    for(let i=4;i<CORE;i++)d[i]=k[keys[i]];
  };
  const rk4=(h,deriv)=>{
    deriv(s,d1);for(let i=0;i<L;i++)tmp[i]=s[i]+h/2*d1[i];
    deriv(tmp,d2);for(let i=0;i<L;i++)tmp[i]=s[i]+h/2*d2[i];
    deriv(tmp,d3);for(let i=0;i<L;i++)tmp[i]=s[i]+h*d3[i];
    deriv(tmp,d4);for(let i=0;i<L;i++)s[i]+=h*(d1[i]+2*d2[i]+2*d3[i]+d4[i])/6;
  };

  for(let m=0;m<N;m++) {
    while(ai<anchors.length&&anchors[ai].m<=m){if(anchors[ai].m===m){const q=anchors[ai].glucose*P.Vg;s[4]=q;s[5]=P.p4/P.p5*q;ig=anchors[ai].glucose;G[m]=ig;IG[m]=ig;}ai++;}
    while(bi<bol.length&&bol[bi].m<=m){const u=bol[bi++].units*1e6;s[0]+=(1-f)*u;s[1]+=f*u;}
    while(mi<meals.length&&meals[mi].m<=m){const ml=meals[mi];addMeal(ml.grams*(mealScale?mealScale[ml.i]:1),ml.absorption*absScale);mi++;}
    while(ei<extra.length&&extra[ei].m<=m){const e=extra[ei++];addMeal(e.grams,(e.absorption??DEFAULT_ABSORPTION_MINUTES)*absScale);}
    while(li<la.length&&la[li].m<=m){const d=la[li++];addDepot(d.units,longActingRates(d.depot));}
    const uph=rate[m];uSlow=(1-f)*uph*1e6/60;uFast=f*uph*1e6/60;
    kIns=sens*(daySens?daySens[day[m]]??1:1)/(1+dawnF*dawn[m]);
    acNow=ac?ac[m]:0;
    const g0=s[4]/P.Vg;
    if(acNow>0||s[6]>1||s[10]>1e-6||s[11]>1e-6||s[13]>1e-6){for(let k=0;k<10;k++)rk4(0.1,full);}
    else rk4(1,fast);
    const g1=s[4]/P.Vg;
    if(!(g1>0)||!Number.isFinite(g1))return {ok:false,G,IG,failedAt:m};
    ig+=((g0+g1)/2-ig)*igAlpha;
    G[m+1]=g1;IG[m+1]=ig;
    // Drop exhausted meal pools (< 1 mg glucose), as Physiology does.
    if((m&15)===0&&mealTau.length) {
      for(let i=mealTau.length-1;i>=0;i--){const o=CORE+2*i;if(s[o]+s[o+1]<1){for(let j=o;j<L-2;j++)s[j]=s[j+2];L-=2;mealTau.splice(i,1);}}
    }
  }
  return {ok:true,G,IG};
}

/**
 * CGM-equivalent at each plan sample: gain * interstitial glucose + offset, with an optional
 * per-sample gain multiplier (sensor-session calibration error and drift).
 */
export function predictSamples(plan,sim,{cgm_gain=1,cgm_offset=0}={},gainMultiplier=null) {
  const out=new Float64Array(plan.samples.length),IG=sim.IG;
  plan.samples.forEach((s,i)=>{const m=Math.floor(s.x),fr=s.x-m,v=fr?IG[m]*(1-fr)+IG[m+1]*fr:IG[m];
    out[i]=cgm_gain*(gainMultiplier?gainMultiplier[i]:1)*v+cgm_offset;});
  return out;
}

/** Convenience: replay a trace with natural parameters; returns per-sample rows. */
export function replayTrace(trace,params={},latent={},opts={}) {
  const plan=buildPlan(trace,opts),sim=simulate(plan,params,latent);
  const yhat=predictSamples(plan,sim,params);
  return {plan,ok:sim.ok,rows:plan.samples.map((s,i)=>({t:s.t,recorded:s.y,cgm:yhat[i],plasma:sim.G[Math.round(s.x)]}))};
}
