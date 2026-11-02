import Deichmann2023,{DEFAULT_PARAMETERS,initialState,insulinFromBasal,basalFromInsulin,rk4Step}
  from '../../model/Deichmann2023.ts';
import {kernelRates,longActingRates} from './pk.mjs';

// Upstream sweet-sim never integrates more than 6 s at a time.
export const MAX_STEP_MINUTES=0.1;

/** Equilibrium basal (U/h) that holds plasma insulin at the model's Ib for a body weight. */
export function equilibriumBasalUph(weightKg) {
  return basalFromInsulin({...DEFAULT_PARAMETERS,BW:weightKg})*60/1e6;
}

/**
 * Deichmann2023 kernel plus gut meal pools and subcutaneous insulin routes. Pure: no clock,
 * no randomness. Each meal is the upstream two-compartment chain a -> b -> plasma (Ra=b/tau),
 * in mg glucose. The primary insulin (pump or rapid pen) uses the kernel depot x1 -> x2 with
 * per-product rates and a depot-bypass fraction; each long-acting injection is its own
 * lag -> depot -> transit chain feeding plasma insulin I. Insulin amounts are in µU.
 */
export class Physiology {
  /**
   * person: individual physiology. sensitivity scales the insulin action term p3*I against a
   * fixed basal reference, so it changes both the basal requirement (Ib/sensitivity) and the
   * response to a bolus; glucose_effectiveness (p1), basal_glucose (Gb), carb_bioavailability
   * (AG) and meal_absorption_scale override the kernel defaults.
   */
  constructor({weightKg,initialGlucose,basalUph,pk={depot_scale:1,transit_scale:1,fast_fraction:0},person={}}) {
    const over={};
    if(person.glucose_effectiveness!=null)over.p1=person.glucose_effectiveness;
    if(person.basal_glucose!=null)over.Gb=person.basal_glucose;
    if(person.carb_bioavailability!=null)over.AG=person.carb_bioavailability;
    this.params={...DEFAULT_PARAMETERS,BW:weightKg,...kernelRates(pk),...over};
    this.fast=pk.fast_fraction??0;
    this.sensitivity=person.sensitivity??1;
    this.mealAbsorptionScale=person.meal_absorption_scale??1;
    const delivery=basalUph*1e6/60;
    this.state=initialState({...this.params,Ib:insulinFromBasal(delivery,this.params)},delivery,initialGlucose);
    this.state.X*=this.sensitivity;
    this.state.x1=(1-this.fast)*delivery/this.params.k1;   // x2 inflow stays equal to delivery
    this.meals=[];this.depots=[];
    this.model=new Deichmann2023(this.params);
  }
  static restore(snapshot) {
    const p=Object.create(Physiology.prototype);
    Object.assign(p,structuredClone(snapshot));p.model=new Deichmann2023(p.params);return p;
  }
  snapshot() {return structuredClone({params:this.params,fast:this.fast,sensitivity:this.sensitivity,mealAbsorptionScale:this.mealAbsorptionScale,
    state:this.state,meals:this.meals,depots:this.depots});}
  /** Changes body weight (kernel volumes scale with BW); the compartment state is kept as is. */
  setWeight(weightKg) {this.params={...this.params,BW:weightKg};this.model=new Deichmann2023(this.params);}
  /** Insulin delivery (U/h) that holds glucose at Gb for this person at rest. */
  basalRequirementUph() {return basalFromInsulin(this.params)/this.sensitivity*60/1e6;}

  glucose() {return this.state.Q1/this.params.Vg;}
  gutCarbsG() {return this.meals.reduce((s,m)=>s+(m.a+m.b)/this.params.AG/1000,0);}
  /** Long-acting insulin still in subcutaneous depots (U), evaluator-only. */
  longActingDepotU() {return this.depots.reduce((s,d)=>s+(d.a+d.b+d.c)/1e6,0);}

  ingest(id,grams,tauMinutes) {this.meals.push({id,grams,tau:tauMinutes*(this.mealAbsorptionScale??1),a:grams*1000*this.params.AG,b:0});}
  bolus(units) {this.state.x1+=(1-this.fast)*units*1e6;this.state.x2+=this.fast*units*1e6;}
  injectLongActing(id,units,depot) {this.depots.push({id,...longActingRates(depot),a:units*1e6,b:0,c:0});}

  /**
   * MDI start: no pump basal, plasma insulin and remote insulin action X taken from a
   * pre-simulation of the given long-acting injections (minutes relative to start, <= 0).
   */
  preloadLongActing(doses,initialGlucose) {
    const p=this.params,vol=p.Vi*p.BW,dt=0.1;
    const chains=doses.map(d=>({...d,...longActingRates(d.depot),a:0,b:0,c:0}));
    let I=0,X=0;
    const first=Math.min(...doses.map(d=>d.at_minute));
    for(let t=first;t<0-1e-9;t+=dt) {
      for(const c of chains)if(!c.given&&c.at_minute<=t+1e-9){c.a=c.units*1e6;c.given=true;}
      let appear=0;
      for(const c of chains) {
        const da=-c.kLag*c.a,db=c.kLag*c.a-c.ka*c.b,dc=c.ka*c.b-(c.k2+c.k3)*c.c;
        appear+=c.k2/vol*c.c;c.a+=da*dt;c.b+=db*dt;c.c+=dc*dt;
      }
      const dI=appear-p.k4*I,dX=-p.p2*X+p.p3*(this.sensitivity??1)*I;I+=dI*dt;X+=dX*dt;
    }
    const fresh=initialState(p,0,initialGlucose);
    this.state={...fresh,x1:0,x2:0,I,X};
    this.depots=chains.filter(c=>c.a+c.b+c.c>=1e3).map(c=>({id:c.id,kLag:c.kLag,ka:c.ka,k2:c.k2,k3:c.k3,a:c.a,b:c.b,c:c.c}));
  }

  /**
   * Advances dt minutes with constant inputs: primary insulin U/h, accelerometry AC, hepatic
   * delta mg/dL/min and a time-varying insulin sensitivity multiplier (dawn, illness, cycle...).
   */
  integrate(dt,{insulinUph,AC=0,hepaticDelta=0,sensitivityMultiplier=1}) {
    if(!(dt>0&&dt<=MAX_STEP_MINUTES+1e-12))throw new Error(`Invalid integration step ${dt}`);
    this.model.hepaticDelta=hepaticDelta;
    const p=this.params,vol=p.Vi*p.BW,f=this.fast,fastInflow=f*insulinUph*1e6/60;
    const x={...this.state};
    this.meals.forEach((m,i)=>{x[`a${i}`]=m.a;x[`b${i}`]=m.b;});
    this.depots.forEach((d,i)=>{x[`la${i}`]=d.a;x[`lb${i}`]=d.b;x[`lc${i}`]=d.c;});
    rk4Step(x,dt,s=>{
      let Ra=0;
      for(let i=0;i<this.meals.length;i++)Ra+=s[`b${i}`]/this.meals[i].tau;
      const d=this.model.computeDerivatives(null,s,{iir:(1-f)*insulinUph,AC,Ra});
      d.x2+=fastInflow;
      const k=(this.sensitivity??1)*sensitivityMultiplier;
      if(k!==1)d.X+=p.p3*(k-1)*s.I;
      this.meals.forEach((m,i)=>{d[`a${i}`]=-s[`a${i}`]/m.tau;d[`b${i}`]=(s[`a${i}`]-s[`b${i}`])/m.tau;});
      this.depots.forEach((c,i)=>{
        const a=s[`la${i}`],b=s[`lb${i}`],cc=s[`lc${i}`];
        d[`la${i}`]=-c.kLag*a;d[`lb${i}`]=c.kLag*a-c.ka*b;d[`lc${i}`]=c.ka*b-(c.k2+c.k3)*cc;
        d.I+=c.k2/vol*cc;
      });
      return d;
    });
    this.meals.forEach((m,i)=>{m.a=x[`a${i}`];m.b=x[`b${i}`];delete x[`a${i}`];delete x[`b${i}`];});
    this.depots.forEach((c,i)=>{c.a=x[`la${i}`];c.b=x[`lb${i}`];c.c=x[`lc${i}`];delete x[`la${i}`];delete x[`lb${i}`];delete x[`lc${i}`];});
    this.state=x;
    const G=this.glucose();
    if(!(G>0)||Object.values(x).some(v=>!Number.isFinite(v)))throw new Error('Nonphysical model state; no glucose clipping');
    // Drop exhausted pools: below 1 mg glucose or 0.001 U insulin they no longer matter.
    this.meals=this.meals.filter(m=>m.a+m.b>=1);
    this.depots=this.depots.filter(c=>c.a+c.b+c.c>=1e3);
  }
}
