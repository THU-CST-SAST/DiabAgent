// Particle dynamics for the causal decider's belief (src/oracle/belief.mjs) and its planning
// rollouts (src/oracle/causal.mjs).
//
// Each particle is one hypothesis about the hidden world: person parameters (insulin
// sensitivity, carb bioavailability, meal absorption speed, interstitial lag, daily sensitivity
// levels, menstrual phase), the physiological state on the Deichmann2023 kernel (insulin
// depots, plasma insulin, remote action, glucose compartments, exercise states, gut meal pools,
// long-acting depots), the CGM sensor's calibration error as a small Kalman filter
// (Rao-Blackwellised: given the particle's interstitial glucose the sensor model is linear
// Gaussian), plus discrete hidden events (unannounced meals, an infusion-set occlusion).
//
// Why not one World per particle: a World integrates in 6-second substeps (~27 ms per 6 h);
// the belief needs hundreds of particles and the planner tens of thousands of particle-hours
// per simulated day. This stepper uses the same equations as src/core/physiology.mjs and the
// trace2sim replay driver (src/trace2sim/replay.mjs): 1-minute RK4 on a flat state vector
// while no exercise states are active, the full kernel (ported without allocations) in
// 0.1-minute steps otherwise. Parity with World is checked in test/oracle-causal.test.mjs.
import {Physiology} from '../core/physiology.mjs';
import {INSULINS} from '../core/insulins.mjs';
import {longActingRates} from '../core/pk.mjs';
import {dawnShape} from '../trace2sim/replay.mjs';

export const CORE=14;              // x1 x2 I X Q1 Q2 Y Z rGU rGP tPA PAint rdepl th
export const MAX_MEALS=12,MAX_DEPOTS=8;
const MEAL0=CORE,DEP0=CORE+2*MAX_MEALS;
export const STATE_LEN=DEP0+3*MAX_DEPOTS;
export const MIN_MS=60000,DAY_MS=86400000;

/** Kernel parameters shared by all particles of an instance (body weight and rapid insulin are public). */
export function sharedParams({weightKg,rapidInsulin}) {
  const ph=new Physiology({weightKg,initialGlucose:120,basalUph:0,pk:INSULINS[rapidInsulin].pk});
  const P={...ph.params};
  P.fast=ph.fast;P.vol=P.Vi*P.BW;P.k2v=P.k2/P.vol;
  P.Xb=P.p3/P.p2*P.Ib;P.Qb=P.Gb*P.Vg;P.basalTerm=(P.p1+P.Xb)*P.Qb;P.invBW=1/P.BW;
  P.rapidInsulin=rapidInsulin;P.weightKg=weightKg;
  return P;
}

/** Initial kernel state for a pump at its scheduled basal (as World does), with sensitivity S. */
export function pumpInitialState(P,{basalUph,glucose,S}) {
  const ph=new Physiology({weightKg:P.weightKg,initialGlucose:glucose,basalUph,pk:INSULINS[P.rapidInsulin].pk,person:{sensitivity:S}});
  return {core:ph.state,depots:[]};
}

/**
 * Long-acting preload for MDI, computed once at sensitivity 1 (X scales linearly with
 * sensitivity, as in the trace2sim replay). doses: [{at_minute (<0), units, depot}].
 */
export function mdiPreload(P,doses,glucose) {
  const ph=new Physiology({weightKg:P.weightKg,initialGlucose:glucose,basalUph:0,pk:INSULINS[P.rapidInsulin].pk});
  ph.preloadLongActing(doses,glucose);
  return {core:ph.state,depots:ph.depots.map(d=>({kLag:d.kLag,ka:d.ka,k2:d.k2,k3:d.k3,a:d.a,b:d.b,c:d.c}))};
}

// --- particles ---------------------------------------------------------------------------

/**
 * Creates a particle. params: {S, AG, absScale, tauIG, dawnF, carbsDay, menPhase, dayLv:Float64Array}
 * init: {core (kernel state object), depots, glucose}
 */
export function makeParticle(P,params,init) {
  const s=new Float64Array(STATE_LEN),keys=['x1','x2','I','X','Q1','Q2','Y','Z','rGU','rGP','tPA','PAint','rdepl','th'];
  keys.forEach((k,i)=>{s[i]=init.core[k]??0;});
  const p={s,tau:new Float64Array(MAX_MEALS),nm:0,dep:new Float64Array(4*MAX_DEPOTS),nd:0,ig:s[4]/P.Vg,
    ...params,kf:null,slots:{},occl:null,logw:0,alarm:0,extra:[]};
  for(const d of init.depots??[])addDepot(p,d,d.a,d.b,d.c);
  return p;
}

export function cloneParticle(p) {
  const q={...p};
  q.s=p.s.slice();q.tau=p.tau.slice();q.dep=p.dep.slice();
  q.kf=p.kf?p.kf.slice():null;
  q.slots={};for(const k in p.slots)q.slots[k]={...p.slots[k]};
  q.occl=p.occl?{...p.occl}:null;
  q.extra=p.extra.length?p.extra.map(e=>({...e})):[];
  return q;
}

export function glucoseOf(p,P) {return p.s[4]/P.Vg;}
/** Grams of carbohydrate still in the gut pools. */
export function gutCarbs(p,P) {let g=0;for(let i=0;i<p.nm;i++)g+=(p.s[MEAL0+2*i]+p.s[MEAL0+2*i+1])/(p.AG*1000);return g;}
/** Rapid insulin still in the subcutaneous depot (U). */
export function rapidDepotU(p) {return (p.s[0]+p.s[1])/1e6;}

export function addMeal(p,grams,tauMinutes) {
  if(!(grams>0))return;
  if(p.nm>=MAX_MEALS) {
    // Merge into the smallest pool rather than drop carbohydrate.
    let k=0;for(let i=1;i<p.nm;i++)if(p.s[MEAL0+2*i]+p.s[MEAL0+2*i+1]<p.s[MEAL0+2*k]+p.s[MEAL0+2*k+1])k=i;
    p.s[MEAL0+2*k]+=grams*1000*p.AG;return;
  }
  const o=MEAL0+2*p.nm;p.s[o]=grams*1000*p.AG;p.s[o+1]=0;p.tau[p.nm]=tauMinutes*p.absScale;p.nm++;
}
export function addDepot(p,rates,a,b=0,c=0) {
  if(p.nd>=MAX_DEPOTS) {
    // Oldest depot is nearly exhausted by the time 8 are active; fold it into plasma-bound c.
    let k=0;for(let i=1;i<p.nd;i++){const o=DEP0+3*i,q=DEP0+3*k;if(p.s[o]+p.s[o+1]+p.s[o+2]<p.s[q]+p.s[q+1]+p.s[q+2])k=i;}
    removeDepot(p,k);
  }
  const j=p.nd++,o=DEP0+3*j;p.s[o]=a;p.s[o+1]=b;p.s[o+2]=c;
  p.dep[4*j]=rates.kLag;p.dep[4*j+1]=rates.ka;p.dep[4*j+2]=rates.k2;p.dep[4*j+3]=rates.k3;
}
function removeDepot(p,k) {
  const last=p.nd-1;
  if(k!==last){for(let r=0;r<3;r++)p.s[DEP0+3*k+r]=p.s[DEP0+3*last+r];for(let r=0;r<4;r++)p.dep[4*k+r]=p.dep[4*last+r];}
  p.nd--;
}
export function longActingDepotRates(insulin) {return longActingRates(INSULINS[insulin].depot);}
export function bolus(p,P,units) {p.s[0]+=(1-P.fast)*units*1e6;p.s[1]+=P.fast*units*1e6;}

// --- integration -------------------------------------------------------------------------

function hill(value,threshold,power) {
  if(value===0)return 0;
  const ratio=value/threshold,exponent=power*Math.log(Math.abs(ratio));
  const sign=ratio<0&&power%2!==0?-1:1;
  return exponent>=0?1/(1+sign*Math.exp(-exponent)):sign*Math.exp(exponent)/(1+sign*Math.exp(exponent));
}

const TMP=new Float64Array(STATE_LEN),D1=new Float64Array(STATE_LEN),D2=new Float64Array(STATE_LEN),
  D3=new Float64Array(STATE_LEN),D4=new Float64Array(STATE_LEN);
// Inputs held constant over one step.
const IN={uSlow:0,uFast:0,kIns:1,hepQ:0,AC:0,full:false};

function deriv(P,p,x,d) {
  const nm=p.nm,nd=p.nd;let Ra=0;
  for(let i=0;i<nm;i++){const o=MEAL0+2*i,a=x[o],b=x[o+1],tau=p.tau[i];Ra+=b/tau;d[o]=-a/tau;d[o+1]=(a-b)/tau;}
  let dI=P.k2v*x[1]-P.k4*x[2];
  for(let j=0;j<nd;j++){const o=DEP0+3*j,r=4*j,a=x[o],b=x[o+1],c=x[o+2],kLag=p.dep[r],ka=p.dep[r+1],k2=p.dep[r+2],k3=p.dep[r+3];
    d[o]=-kLag*a;d[o+1]=kLag*a-ka*b;d[o+2]=ka*b-(k2+k3)*c;dI+=k2/P.vol*c;}
  const X=x[3],Q1=x[4],Q2=x[5],Y=x[6],Z=x[7],rGU=x[8],rGP=x[9],tPA=x[10],PAint=x[11],rdepl=x[12],th=x[13];
  d[0]=-P.k1*x[0]+IN.uSlow;d[1]=P.k1*x[0]-(P.k2+P.k3)*x[1]+IN.uFast;d[2]=dI;d[3]=-P.p2*X+P.p3*IN.kIns*x[2];
  d[4]=-(P.p1+rGU-(rGP-rdepl)+(1+Z)*X)*Q1-P.p4*Q1+P.p5*Q2+P.basalTerm+Ra*P.invBW+IN.hepQ;
  d[5]=P.p4*Q1-P.p5*Q2;
  if(!IN.full) {
    d[6]=-Y/P.tau_AC;d[7]=-Z/P.tau_Z;d[8]=-P.q2*rGU;d[9]=-P.q4l*rGP;d[10]=-tPA;d[11]=-PAint;d[12]=-P.q6*rdepl;d[13]=-P.q5*th;
    return;
  }
  const AC=IN.AC,fY=hill(Y,P.aY,P.n1),fAC=hill(AC,P.aAC,P.n2),fHI=hill(AC,P.ah,P.n2),fp=hill(th,P.tp,P.n2);
  const depletion=tPA!==0?-P.adepl*PAint/tPA+P.bdepl:P.bdepl,ft=hill(tPA,depletion,P.n1);
  const q3=(1-fp)*P.q3l+fp*P.q3h,q4=(1-fp)*P.q4l+fp*P.q4h,rm=P.beta*(q3/q4*Y+(1-P.alpha)*(P.p1+P.Xb));
  d[6]=(AC-Y)/P.tau_AC;d[7]=P.b*fY*Y-(1-fY)/P.tau_Z*Z;d[8]=P.q1*fY*Y-P.q2*rGU;d[9]=q3*fY*Y-q4*rGP;
  d[10]=fAC-(1-fAC)*tPA;d[11]=fAC*AC-(1-fAC)*PAint;d[12]=P.q6*(ft*rm-rdepl);d[13]=fHI-(1-fHI)*P.q5*th;
}

function rk4(P,p,h,L) {
  const s=p.s;
  deriv(P,p,s,D1);for(let i=0;i<L;i++)TMP[i]=s[i]+h/2*D1[i];
  deriv(P,p,TMP,D2);for(let i=0;i<L;i++)TMP[i]=s[i]+h/2*D2[i];
  deriv(P,p,TMP,D3);for(let i=0;i<L;i++)TMP[i]=s[i]+h*D3[i];
  deriv(P,p,TMP,D4);for(let i=0;i<L;i++)s[i]+=h*(D1[i]+2*D2[i]+2*D3[i]+D4[i])/6;
}

/**
 * Advances a particle by one minute with constant inputs: primary insulin uph (U/h, actually
 * reaching the depot), accelerometer counts AC, hepatic delta (mg/dL/min) and the total
 * insulin-sensitivity factor kIns (person sensitivity x time-varying multiplier). Also moves the
 * interstitial glucose toward plasma glucose with the particle's lag. Returns false if the state
 * became nonphysical.
 */
export function stepMinute(P,p,uph,AC,hep,kIns) {
  const s=p.s,f=P.fast;
  IN.uSlow=(1-f)*uph*1e6/60;IN.uFast=f*uph*1e6/60;IN.kIns=kIns;IN.hepQ=hep*P.Vg;IN.AC=AC;
  IN.full=AC>0||s[6]>1||s[10]>1e-6||s[11]>1e-6||s[13]>1e-6;
  const L=DEP0+3*p.nd;   // meal slots beyond nm are zero and have zero derivative
  const g0=s[4]/P.Vg;
  if(IN.full)for(let k=0;k<10;k++)rk4(P,p,0.1,L);
  else rk4(P,p,1,L);
  const g1=s[4]/P.Vg;
  if(!(g1>0)||!Number.isFinite(g1)){s[4]=Math.max(1,Number.isFinite(g1)?g1:1)*P.Vg;s[5]=P.p4/P.p5*s[4];return false;}
  p.ig+=((g0+g1)/2-p.ig)*p.alphaIG;
  // Drop exhausted meal pools (< 1 mg glucose) and long-acting depots (< 0.001 U), as Physiology does.
  for(let i=p.nm-1;i>=0;i--){const o=MEAL0+2*i;if(s[o]+s[o+1]<1){const last=p.nm-1;
    if(i!==last){s[o]=s[MEAL0+2*last];s[o+1]=s[MEAL0+2*last+1];p.tau[i]=p.tau[last];}
    s[MEAL0+2*last]=0;s[MEAL0+2*last+1]=0;p.nm--;}}
  for(let j=p.nd-1;j>=0;j--){const o=DEP0+3*j;if(s[o]+s[o+1]+s[o+2]<1e3){removeDepot(p,j);const q=DEP0+3*p.nd;s[q]=s[q+1]=s[q+2]=0;}}
  return true;
}

// --- time-varying sensitivity (same structure as World.sensitivityMultiplier) -------------

export const localMinute=(t,off)=>(((t+off*MIN_MS)%DAY_MS)+DAY_MS)%DAY_MS/MIN_MS;
export const localDay=(t,off)=>new Date(t+off*MIN_MS).toISOString().slice(0,10);

/**
 * Multiplier from dawn phenomenon, the particle's daily sensitivity levels (log-normal, linear
 * between local noons) and menstrual phase. Announced life events are applied by the caller.
 */
export function baseMultiplier(p,t,ctx) {
  const local=localMinute(t,ctx.off);let m=1;
  if(p.dawnF>0)m/=1+p.dawnF*dawnShape(local);
  if(p.dayLv) {
    const x=(t-ctx.start)/DAY_MS+(local-720)/1440,i=Math.floor(x+1e-9),fr=x-i;
    const lv=k=>p.dayLv[Math.min(p.dayLv.length-1,Math.max(0,k+2))];
    m*=lv(i)*(1-fr)+lv(i+1)*fr;
  }
  if(ctx.menstrual&&p.menPhase!=null) {
    const c=ctx.menstrual.cycle_days,day=(((t-ctx.start)/DAY_MS+p.menPhase)%c),half=c/2;
    const luteal=day<half?0:Math.min(1,(day-half)/2,(c-day)/2);
    m/=1+ctx.menstrual.luteal_need_increase*luteal;
  }
  return m;
}

// --- CGM sensor error: Kalman filter over [gain a, offset b, AR noise v_k, v_{k-1}] ---------

/** Sensor model from the public sensor catalog (knowledge/sensors.json). */
export function sensorModel(spec,errorModels) {
  if(!spec)return null;
  const e=spec.error??{};
  if(e.kind!=='padova')return {kind:'direct',sd:Math.max(0.5,(e.amplitude_mg_dl??0)/Math.sqrt(3)),range:spec.range,tau:{median:0}};
  const m=errorModels[e.model],k=e.spread??1,wear=spec.wear_days??10;
  const [ar1,ar2]=m.ar,sigma=k*m.sigma.median;
  const varV=sigma*sigma*(1-ar2)/((1+ar2)*((1-ar2)**2-ar1*ar1)),cov1=ar1/(1-ar2)*varV;
  // Gain drift a1 ~ N(median, k*sd) per day, clamped to |a1|*wear <= max_drift_over_wear when the
  // catalog bounds it (World.Cgm): moments of the clamped normal by quadrature.
  const maxA1=Number.isFinite(m.bounds?.max_drift_over_wear)?m.bounds.max_drift_over_wear/wear:Infinity;
  const mu1=m.a1_per_day.median,s1=k*m.a1_per_day.sd;
  let e1=mu1,e2=mu1*mu1+s1*s1;
  if(Number.isFinite(maxA1)){e1=0;e2=0;const n=400;for(let i=0;i<n;i++){const z=-5+10*(i+0.5)/n,w=Math.exp(-z*z/2)/Math.sqrt(2*Math.PI)*10/n,v=Math.max(-maxA1,Math.min(maxA1,mu1+s1*z));e1+=w*v;e2+=w*v*v;}}
  // A sensor is inserted at a uniformly random point of its wear (World.Cgm), so the gain drift
  // a1*d adds to the gain uncertainty at the start; afterwards the drift is a random walk.
  const a1sd=Math.sqrt(Math.max(0,e2-e1*e1)),driftVar=e2*(wear*wear/3)-(e1*wear/2)**2;
  return {kind:'padova',ar:[ar1,ar2],sigma,gainBounds:m.bounds?.gain??null,
    a:{mean:m.a0.median+e1*wear/2,var:(k*m.a0.sd)**2+Math.max(0,driftVar)},
    aFresh:{mean:m.a0.median,var:(k*m.a0.sd)**2},
    b:{mean:m.b0.median,var:(k*m.b0.sd)**2},
    v:{var:varV,cov1},qa:a1sd*a1sd*(5/1440),
    tau:{median:m.tau_min.median*1,iqr:m.tau_min.iqr,spread:k},range:spec.range,calibration:spec.calibration??null};
}

export function kfInit(model,{fresh=false}={}) {
  const kf=new Float64Array(20);
  const a=fresh?model.aFresh:model.a;
  kf[0]=a.mean;kf[1]=model.b.mean;kf[2]=0;kf[3]=0;
  kf[4+0]=a.var;kf[4+5]=model.b.var;kf[4+10]=model.v.var;kf[4+15]=model.v.var;kf[4+11]=kf[4+14]=model.v.cov1;
  return kf;
}
/** AR step of the sensor noise at a sensor sample time (every 5 minutes). */
export function kfPredict(kf,model) {
  const [f1,f2]=model.ar,m=kf,P=kf.subarray(4);
  // F = [[1,0,0,0],[0,1,0,0],[0,0,f1,f2],[0,0,1,0]]
  const v0=m[2],v1=m[3];m[2]=f1*v0+f2*v1;m[3]=v0;
  // P' = F P F^T + Q, done row/column-wise on the 2x2 noise block and its cross terms.
  const g=(i,j)=>P[4*i+j];
  const n=new Float64Array(16);
  const row=(i,j)=>i<2?g(i,j):i===2?f1*g(2,j)+f2*g(3,j):g(2,j);   // (F P)_{ij}
  for(let i=0;i<4;i++)for(let j=0;j<4;j++)n[4*i+j]=j<2?row(i,j):j===2?f1*row(i,2)+f2*row(i,3):row(i,2);
  n[0]+=model.qa;n[10]+=model.sigma*model.sigma;
  P.set(n);
}
/** Predictive mean and variance of a reading given interstitial glucose ig. */
export function kfPredictive(kf,ig,r2=1) {
  const P=kf.subarray(4),h=[ig,1,1,0];
  let mu=0,v=r2;
  for(let i=0;i<4;i++){mu+=h[i]*kf[i];let s=0;for(let j=0;j<4;j++)s+=P[4*i+j]*h[j];v+=h[i]*s;}
  return {mu,v};
}
export function kfUpdate(kf,ig,y,r2=1) {
  const P=kf.subarray(4),h=[ig,1,1,0],Ph=new Float64Array(4);
  let mu=0,S=r2;
  for(let i=0;i<4;i++){let s=0;for(let j=0;j<4;j++)s+=P[4*i+j]*h[j];Ph[i]=s;mu+=h[i]*kf[i];}
  for(let i=0;i<4;i++)S+=h[i]*Ph[i];
  const e=y-mu;
  for(let i=0;i<4;i++)kf[i]+=Ph[i]/S*e;
  for(let i=0;i<4;i++)for(let j=0;j<4;j++)P[4*i+j]-=Ph[i]*Ph[j]/S;
}
/**
 * Fingerstick calibration (World.Cgm.calibrate): the sensor sets a = (meter - b - v0) / IG, an
 * exact linear map of the filter state given the particle's IG and the visible meter value.
 */
export function kfCalibrate(kf,ig,meter) {
  const g=Math.max(ig,20),P=kf.subarray(4);
  const T=[[0,-1/g,-1/g,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
  const m=[meter/g-kf[1]/g-kf[2]/g,kf[1],kf[2],kf[3]];
  const n=new Float64Array(16);
  for(let i=0;i<4;i++)for(let j=0;j<4;j++){let s=0;for(let k=0;k<4;k++)for(let l=0;l<4;l++)s+=T[i][k]*P[4*k+l]*T[j][l];n[4*i+j]=s;}
  for(let i=0;i<4;i++)kf[i]=m[i];P.set(n);
}

// --- meter error (knowledge/sensors.json meters) -------------------------------------------

/** Mean and sd of a fingerstick reading for true glucose g. */
export function meterPredictive(meter,g) {
  const e=meter.error;
  return g<e.threshold_mg_dl?{mu:g+e.abs_bias_mg_dl,sd:e.abs_sd_mg_dl}:{mu:g*(1+e.rel_bias),sd:Math.max(1,g*e.rel_sd)};
}

// --- likelihood helpers --------------------------------------------------------------------

const SQ2=Math.SQRT2;
function erf(x) {
  // Abramowitz-Stegun 7.1.26
  const s=Math.sign(x),a=Math.abs(x),t=1/(1+0.3275911*a);
  const y=1-((((1.061405429*t-1.453152027)*t+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-a*a);
  return s*y;
}
export const normCdf=z=>0.5*(1+erf(z/SQ2));
/** Log-likelihood of y under N(mu, v) with a small outlier floor (robust to model misfit). */
export function logNormalRobust(y,mu,v,floor=0.02) {
  const e=y-mu,d=Math.exp(-0.5*e*e/v)/Math.sqrt(2*Math.PI*v);
  return Math.log((1-floor)*d+floor/400);
}
