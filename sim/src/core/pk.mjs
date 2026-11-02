// Linear subcutaneous insulin pharmacokinetics on the Deichmann2023 insulin subsystem.
// Shared by the physiology (dynamics) and by calibration/tests (PK metrics).
import {DEFAULT_PARAMETERS as P} from '../../model/Deichmann2023.ts';

/**
 * Kernel-route insulin (pump or rapid pen): depot x1 -> x2 -> plasma.
 * depot_scale multiplies k1; transit_scale multiplies k2 and k3 together, so bioavailability
 * k2/(k2+k3) and therefore the equilibrium basal are unchanged. fast_fraction of each dose
 * bypasses the depot into x2. `scale` sets both when the specific ones are absent.
 */
export function kernelRates({scale=1,depot_scale=scale,transit_scale=scale}) {
  return {k1:P.k1*depot_scale,k2:P.k2*transit_scale,k3:P.k3*transit_scale};
}

/**
 * Long-acting insulin: lag compartment -> depot -> x2-like compartment -> plasma, using the
 * reference kernel's k2/k3 for the last step. The apparent half-life is absorption-limited
 * (flip-flop kinetics), so it is set by the depot rate.
 */
export function longActingRates({lag_minutes,half_life_hours}) {
  return {kLag:1/lag_minutes,ka:Math.LN2/(half_life_hours*60),k2:P.k2,k3:P.k3};
}

/** Plasma insulin excess (µU/mL) after a 1 U dose, one value per minute. */
export function doseResponse(insulin,{weightKg=66,minutes=720,dt=0.1}={}) {
  const vol=P.Vi*weightKg,out=[],sub=Math.round(1/dt);
  let I=0;
  if(insulin.class==='long') {
    const r=longActingRates(insulin.depot);let a=1e6,b=0,c=0;
    for(let m=0;m<=minutes;m++) {
      out.push(I);
      for(let s=0;s<sub;s++) {
        const da=-r.kLag*a,db=r.kLag*a-r.ka*b,dc=r.ka*b-(r.k2+r.k3)*c,dI=r.k2/vol*c-P.k4*I;
        a+=da*dt;b+=db*dt;c+=dc*dt;I+=dI*dt;
      }
    }
    return out;
  }
  const r=kernelRates(insulin.pk),f=insulin.pk.fast_fraction??0;
  let x1=(1-f)*1e6,x2=f*1e6;
  for(let m=0;m<=minutes;m++) {
    out.push(I);
    for(let s=0;s<sub;s++) {
      const d1=-r.k1*x1,d2=r.k1*x1-(r.k2+r.k3)*x2,dI=r.k2/vol*x2-P.k4*I;
      x1+=d1*dt;x2+=d2*dt;I+=dI*dt;
    }
  }
  return out;
}

/** Clamp-study PK descriptors of a 1-min-sampled concentration curve (minutes, AUC fractions). */
export function pkMetrics(c) {
  const cmax=Math.max(...c),tmax=c.indexOf(cmax),total=c.reduce((a,b)=>a+b,0);
  const early=f=>c.findIndex(v=>v>=f*cmax);
  const late=f=>{for(let i=tmax;i<c.length;i++)if(c[i]<=f*cmax)return i;return null;};
  const auc=(a,b)=>c.slice(a,b).reduce((s,v)=>s+v,0)/total;
  return {cmax,tmax,onset_10pct:early(.1),early_half:early(.5),late_half:late(.5),
    auc_0_15:auc(0,15),auc_0_30:auc(0,30),auc_0_60:auc(0,60),auc_after_180:auc(180,c.length)};
}
