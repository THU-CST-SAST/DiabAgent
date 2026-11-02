// Interstitial glucose sensors (continuous, fingerstick-calibrated and flash), specs loaded
// from knowledge/sensors.json. Sensor model (Facchinetti/Vettoretti, Padova):
//   IG' = (BG - IG)/tau                     plasma-to-interstitial lag
//   CGM = a(d)*IG + b0 + v,  a(d)=a0+a1*d    per-sensor calibration error; d = days since
//                                            insertion (factory) or since calibration
//   v_k = ar1*v_{k-1} + ar2*v_{k-2} + w_k    AR(2) noise at 5-min sampling
// Each sensor type scales the published G6 dispersions by `spread`, fitted so simulated MARD
// over the wear period matches the label (scripts/calibrate-cgm.mjs).
//
// Physical bounds on the gain (error_models.padova_g6.bounds). The published model draws
// (a0, a1, ...) jointly with correlated parameters; drawing a1 ~ N(0.004, k*0.049)/day on its own
// lets a sensor drift by 30-50% over a 10-14 day wear, which no cleared sensor does (iCGM special
// controls, 21 CFR 862.1355: >99% of readings within +-40% and >87% within +-20% of reference,
// evaluated over the whole wear period; G6 per-day accuracy stays roughly flat over days 1-10,
// Shah 2018). So:
//   |a1| * wear_days <= max_drift_over_wear (0.15)   total drift over one sensor life
//   a0 + a1*d is clamped to gain [0.75, 1.25]          effective gain at any time
// Both bound values are assumptions (not stated by a source); see the evidence record.
//
// Error scale (config cgm.error_scale = s, default 1; Experiment 1b): every sensor error term is
// multiplied by s, relative to an ideal sensor (gain 1, no offset, no noise, no lag):
//   gain   1 + s*(a0 - 1 + a1*d)   calibration error and drift (also the gain error a fingerstick
//                                  calibration introduces: a0 is set from the meter reading)
//   offset s*b0,  noise s*v_k,     AR(2) noise (uniform sensors: s * the uniform amplitude)
//   lag    s*tau                   plasma-to-interstitial time constant (s = 0: IG = BG)
// The gain clamp still applies. s = 0 reads true plasma glucose (within the sensor range).
// Not scaled: signal gaps (cgm.gaps / forced_gaps), warm-up, calibration schedule, compression
// artefacts. The random draws are identical for every s (draws are scaled, not skipped), so
// episodes that differ only in s share the same sensor, noise path and gaps.
import {Rng} from './rng.mjs';
import {KNOWLEDGE} from '../knowledge.mjs';

const DAY_MS=86400000,HOUR_MS=3600000;

export const CGMS=Object.fromEntries(Object.entries(KNOWLEDGE.sensors).map(([id,s])=>[id,{
  ...s,kind:s.error.kind,params:s.error.model?KNOWLEDGE.errorModels[s.error.model]:null,spread:s.error.spread??1,
  noise_mg_dl:s.error.amplitude_mg_dl??0,label_mard:s.label?.mard??null,wear_days:s.wear_days??Infinity,
}]));
export const DEFAULT_GAPS={start_probability_per_sample:KNOWLEDGE.gapsDefault.start_probability_per_sample,
  mean_length_samples:KNOWLEDGE.gapsDefault.mean_length_samples};

const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
const DEFAULT_BOUNDS={max_drift_over_wear:Infinity,gain:[0,Infinity]};
const lognormal=(r,median,[q1,q3],k=1)=>median*Math.exp(r.normal(0,k*Math.log(q3/q1)/1.349));

export class Cgm {
  /**
   * Scenario controls (all default off; random draws are still taken so other draws do not shift):
   * errorDraw 'median' (median calibration error instead of a draw, also for replacement sensors),
   * sensorAgeDays (the current sensor was inserted that long before `origin`), forcedGaps
   * [{at_minute, duration_minutes}] (signal loss from `origin`), calibrationOverdue (a calibrated
   * sensor starts with its calibration overdue). origin defaults to start.
   */
  constructor({model,seed,start,noiseMgdl=null,gaps=DEFAULT_GAPS,spread=null,errorDraw='sampled',sensorAgeDays=null,forcedGaps=[],calibrationOverdue=false,
    compressionLows=[],errorScale=1,origin=start}) {
    if(!CGMS[model])throw new Error(`Unknown sensor ${model}`);
    if(!(Number.isFinite(errorScale)&&errorScale>=0))throw new Error('errorScale must be a finite number >= 0');
    Object.assign(this,{model,noiseMgdl:noiseMgdl??CGMS[model].noise_mg_dl,gaps,spreadOverride:spread});
    if(errorScale!==1)this.errorScale=errorScale;
    if(errorDraw==='median')this.errorDraw='median';
    if(forcedGaps?.length)this.forcedGaps=forcedGaps.map(g=>({from:origin+g.at_minute*60000,until:origin+(g.at_minute+g.duration_minutes)*60000}));
    // v1.1-hard: compression artefacts (reading drops by up to depth; 5-min ramps), true glucose unchanged.
    if(compressionLows?.length)this.compressionLows=compressionLows.map(g=>({from:origin+g.at_minute*60000,until:origin+(g.at_minute+g.duration_minutes)*60000,depth:g.depth_mg_dl}));
    this.rng=Rng.stream(seed,'cgm');
    this.history=[];this.ig=null;this.ar=[0,0];this.gapLeft=0;this.status='ok';
    // Start partway through a sensor's wear so episodes do not all begin on day 0.
    const wear=this.spec.wear_days,u=Number.isFinite(wear)?this.rng.next():0;
    const inserted=sensorAgeDays!=null?origin-Math.round(sensorAgeDays*DAY_MS/60000)*60000:Number.isFinite(wear)?start-Math.floor(u*wear*DAY_MS):start;
    this.sensor=this.newSensor(inserted,sensorAgeDays!=null&&origin-inserted<this.spec.warmup_min*60000);
    // Calibrated sensors start with the patient's last calibration somewhere in the past interval.
    if(this.calibration) {
      this.sensor.calibratedAt=start-Math.floor(this.rng.next()*this.calibration.interval_hours*HOUR_MS);
      if(calibrationOverdue)this.sensor.calibratedAt=origin-(this.calibration.interval_hours+1)*HOUR_MS;
    }
  }
  static restore(s) {
    const c=Object.assign(Object.create(Cgm.prototype),structuredClone(s));
    c.rng=Object.assign(Object.create(Rng.prototype),c.rng);return c;
  }
  snapshot() {return structuredClone({...this});}
  get spec() {return CGMS[this.model];}
  get spread() {return this.spreadOverride??this.spec.spread??1;}
  get bounds() {return {...DEFAULT_BOUNDS,...this.spec.params?.bounds};}
  /**
   * Effective gain a(d) = a0 + a1*d, d days since insertion or calibration, within the gain bounds
   * (with an error scale s: 1 + s*(a0 - 1 + a1*d)).
   */
  gainAt(now) {
    const sensor=this.sensor,since=this.calibration?sensor.calibratedAt:sensor.insertedAt,[lo,hi]=this.bounds.gain;
    const g=sensor.a0+sensor.a1*Math.max(0,now-since)/DAY_MS;
    return clamp(this.errorScale===undefined?g:1+this.errorScale*(g-1),lo,hi);
  }
  get calibration() {return this.spec.calibration?.required?this.spec.calibration:null;}
  get modality() {return this.spec.modality;}

  newSensor(insertedAt,warmup=true) {
    const s=this.spec,sensor={insertedAt,readyAt:warmup?insertedAt+s.warmup_min*60000:insertedAt,tau:0,calibratedAt:-Infinity};
    if(s.kind==='padova') {
      const p=s.params,k=this.spread,r=this.rng;
      const wear=s.wear_days,maxA1=Number.isFinite(wear)?this.bounds.max_drift_over_wear/wear:Infinity;
      Object.assign(sensor,{tau:clamp(lognormal(r,p.tau_min.median,p.tau_min.iqr,k),0.5,20),
        a0:clamp(r.normal(p.a0.median,k*p.a0.sd),0.6,1.4),a1:clamp(r.normal(p.a1_per_day.median,k*p.a1_per_day.sd),-maxA1,maxA1),
        b0:r.normal(p.b0.median,k*p.b0.sd),sigma:k*lognormal(r,p.sigma.median,p.sigma.iqr)});
      // Typical sensor: median lag and calibration error (the draws above are still taken).
      if(this.errorDraw==='median')Object.assign(sensor,{tau:clamp(p.tau_min.median,0.5,20),a0:clamp(p.a0.median,0.6,1.4),
        a1:clamp(p.a1_per_day.median,-maxA1,maxA1),b0:p.b0.median,sigma:k*p.sigma.median});
      this.ar=[0,0];
      for(let i=0;i<60;i++)this.arStep(sensor);   // burn in to the stationary distribution
    }
    return sensor;
  }
  arStep(sensor) {
    const [a1,a2]=this.spec.params.ar,v=a1*this.ar[0]+a2*this.ar[1]+this.rng.normal(0,sensor.sigma);
    this.ar=[v,this.ar[0]];return v;
  }

  /** Advances interstitial glucose over dt minutes toward plasma glucose bg. */
  integrate(dtMin,bg) {
    const tau=this.errorScale===undefined?this.sensor.tau:this.sensor.tau*this.errorScale;
    this.ig=this.ig===null||!tau?bg:this.ig+(bg-this.ig)*(1-Math.exp(-dtMin/tau));
  }
  nextExpiry() {return Number.isFinite(this.spec.wear_days)?this.sensor.insertedAt+this.spec.wear_days*DAY_MS:Infinity;}
  calibrationDue() {return this.calibration?this.sensor.calibratedAt+this.calibration.interval_hours*HOUR_MS:Infinity;}
  /** Replaces an expired sensor; returns a visible notice or null. */
  maybeReplace(now,iso) {
    if(now<this.nextExpiry())return null;
    this.sensor=this.newSensor(now,true);
    return {type:'cgm_sensor_replaced',warmup_until:iso(this.sensor.readyAt),
      ...(this.calibration?{calibration_required_after_warmup:true}:{}),time:iso(now)};
  }
  /**
   * Fingerstick calibration: the sensor sets its gain so the current interstitial estimate
   * reads the meter value (meter error propagates into the sensor).
   */
  calibrate(now,meterValue) {
    if(!this.calibration)throw new Error(`${this.spec.name} does not take calibrations`);
    if(now<this.sensor.readyAt)throw new Error('Sensor still warming up');
    const s=this.sensor,ig=Math.max(this.ig??meterValue,20),k=this.errorScale;
    s.a0=clamp((k===undefined?meterValue-s.b0-this.ar[0]:meterValue-k*(s.b0+this.ar[0]))/ig,0.6,1.4);s.calibratedAt=now;
    return {calibrated_at:now,next_due:this.calibrationDue()};
  }

  isSampleTime(now) {return now%(this.spec.interval_min*60000)===0;}
  /** Produces a reading, or null during warm-up, an overdue calibration or a signal gap. */
  sample(now,bg) {
    const s=this.spec,sensor=this.sensor;
    if(this.ig===null)this.ig=bg;
    let raw;
    if(s.kind==='ideal')raw=bg;
    else if(s.kind==='uniform')raw=bg+(this.errorScale??1)*this.rng.symmetric(this.noiseMgdl);
    else {
      raw=this.errorScale===undefined?this.gainAt(now)*this.ig+sensor.b0+this.arStep(sensor)
        :this.gainAt(now)*this.ig+this.errorScale*(sensor.b0+this.arStep(sensor));
    }
    if(this.compressionLows)for(const g of this.compressionLows)if(now>=g.from&&now<g.until)
      raw-=g.depth*Math.min(1,(now-g.from+300000)/600000,(g.until-now)/600000);
    for(const e of this.injectedBiases??[])if(now>=e.from&&now<e.until)
      raw+=e.bias*(e.ramp?Math.min(1,(now-e.from)/e.ramp,(e.until-now)/e.ramp):1);
    if(now<sensor.readyAt){this.status='warmup';return null;}
    if(this.calibration&&now>=this.calibrationDue()){this.status='calibration_required';return null;}
    if(this.forcedGaps?.some(g=>now>=g.from&&now<g.until)){this.status='signal_loss';return null;}
    if(s.kind==='padova') {
      if(this.gapLeft>0){this.gapLeft--;this.status='signal_loss';return null;}
      if(this.rng.next()<this.gaps.start_probability_per_sample) {
        const p=1/this.gaps.mean_length_samples;   // geometric length with the configured mean
        this.gapLeft=Math.max(0,Math.ceil(Math.log(1-this.rng.next())/Math.log(1-p))-1);
        this.status='signal_loss';return null;
      }
    }
    this.status='ok';
    const [lo,hi]=s.range;
    const reading={at:now,value:clamp(raw,lo,hi),display:raw<lo?'LO':raw>hi?'HI':null};
    this.history.push(reading);
    if(this.history[0].at<now-DAY_MS)this.history=this.history.filter(r=>r.at>=now-DAY_MS);
    return reading;
  }
  latest() {return this.history.at(-1)??null;}
  /** mg/dL per minute over the last two readings, or null if they are more than 15 min apart. */
  trend() {
    const [a,b]=this.history.slice(-2);
    return a&&b&&b.at-a.at<=15*60000?(b.value-a.value)/((b.at-a.at)/60000):null;
  }
  /** Flash scan: latest stored reading plus the stored history at the device's interval. */
  scan(now) {
    const h=this.spec.history,since=now-h.hours*HOUR_MS,step=h.interval_min*60000;
    const stored=this.history.filter(r=>r.at>since&&r.at%step===0);
    return {current:this.latest()&&now-this.latest().at<=15*60000?this.latest():null,trend:this.trend(),history:stored};
  }
}

export function direction(slope) {
  if(slope===null)return 'NONE';
  return slope>2?'DoubleUp':slope>1?'SingleUp':slope>.3?'FortyFiveUp':
    slope<-2?'DoubleDown':slope<-1?'SingleDown':slope<-.3?'FortyFiveDown':'Flat';
}
