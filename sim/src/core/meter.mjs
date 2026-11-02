// Fingerstick blood glucose meter (SMBG), specs loaded from knowledge/sensors.json `meters`.
// Error model: below threshold_mg_dl an absolute normal error (mg/dL), above it a relative
// normal error (normal approximation of the two-zone skew-normal SMBG models).
// Capillary-vs-plasma site differences after meals are not modeled.
import {Rng} from './rng.mjs';
import {KNOWLEDGE} from '../knowledge.mjs';

export const METERS=KNOWLEDGE.meters;

export class Meter {
  constructor({model,seed}) {
    if(!METERS[model])throw new Error(`Unknown meter ${model}`);
    this.model=model;this.rng=Rng.stream(seed,'meter');this.readings=[];
  }
  static restore(s) {
    const m=Object.assign(Object.create(Meter.prototype),structuredClone(s));
    m.rng=Object.assign(Object.create(Rng.prototype),m.rng);return m;
  }
  snapshot() {return structuredClone({...this});}
  get spec() {return METERS[this.model];}

  /** One fingerstick at time `at` for true glucose bg; returns the displayed reading. */
  measure(at,bg,source) {
    const e=this.spec.error,[lo,hi]=this.spec.range;
    const raw=bg<e.threshold_mg_dl?bg+this.rng.normal(e.abs_bias_mg_dl,e.abs_sd_mg_dl):bg*(1+this.rng.normal(e.rel_bias,e.rel_sd));
    const reading={at,value:Math.min(hi,Math.max(lo,raw)),display:raw<lo?'LO':raw>hi?'HI':null,source};
    this.readings.push(reading);
    if(this.readings.length>500)this.readings=this.readings.slice(-200);
    return reading;
  }
  latest() {return this.readings.at(-1)??null;}
  countSince(t) {return this.readings.filter(r=>r.at>=t).length;}
}
