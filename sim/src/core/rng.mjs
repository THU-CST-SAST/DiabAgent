import {createHash} from 'node:crypto';

// Derives independent 32-bit seeds per named stream, so changing one
// stream (e.g. sensor noise) never shifts another (e.g. meal timing).
export function streamSeed(seed,name) {
  return createHash('sha256').update(`${seed}:${name}`).digest().readUInt32LE(0);
}

// mulberry32, the generator upstream sweet-sim uses. State is a plain
// integer so environment snapshots stay JSON-serializable.
export class Rng {
  constructor(seed) {this.state=seed>>>0;}
  static stream(seed,name) {return new Rng(streamSeed(seed,name));}
  next() {
    const a=this.state=(this.state+0x6D2B79F5)>>>0;
    let t=Math.imul(a^a>>>15,1|a);
    t=t+Math.imul(t^t>>>7,61|t)^t;
    return ((t^t>>>14)>>>0)/4294967296;
  }
  symmetric(amplitude) {return (this.next()*2-1)*amplitude;}
  normal(mean=0,sd=1) {
    const u=1-this.next(),v=this.next();
    return mean+sd*Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
  }
}
