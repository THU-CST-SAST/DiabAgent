import {Rng} from '../core/rng.mjs';

export const ANTHROPOMETRY_SOURCE='https://www.cdc.gov/nchs/data/series/sr_03/sr03-046-508.pdf';
export const AGE_GROUPS=Object.freeze({child:9,adolescent:15,adult:39,older:70});
// NHANES 2015-2018, tables 7/9/11 (height) and 13/14/15 (BMI), P10/P25/P50/P75/P90.
// General US population reference, not a fitted T1D or Chinese population distribution.
export const BODY_REFERENCE=Object.freeze({
  child_male:{height:[125.7,131,136.4,140.3,144.4],bmi:[14.7,15.9,17.4,20.6,25.4]},
  child_female:{height:[128.2,131.8,136.5,142.5,145.9],bmi:[15.2,16,17.2,20,22.9]},
  adolescent_male:{height:[161.8,167.3,172.7,176.4,181.6],bmi:[17.4,19.1,22.6,28.5,33]},
  adolescent_female:{height:[153.1,156.1,160,165.4,171.3],bmi:[18.7,19.7,21.8,25.9,33.4]},
  adult_male:{height:[166.6,171.2,176.7,181.4,186.3],bmi:[23,25.4,28.9,33.7,38.3]},
  adult_female:{height:[154.1,157.9,162.6,167.7,171.3],bmi:[21.2,23.6,28.3,34.2,41.1]},
  older_male:{height:[164.6,168.6,173.1,177.5,182.5],bmi:[22.9,25.9,28.2,32.8,35.6]},
  older_female:{height:[150.6,153.9,157.9,162.6,165.9],bmi:[22,25.3,28.8,33.3,37.9]},
});
const P=[10,25,50,75,90],BODY_BANDS={small:[10,25],typical:[25,75],large:[75,90]};
const interpolate=(xs,p)=>{
  const i=Math.min(P.length-2,P.findIndex((v,j)=>j<P.length-1&&p>=v&&p<=P[j+1]));
  return xs[i]+(xs[i+1]-xs[i])*(p-P[i])/(P[i+1]-P[i]);
};
const round=x=>Math.round(x*10)/10;

/** Opt-in anthropometry; keeps old person draws and frozen worlds unchanged. */
export function createPatientProfile(input,{seed=0}={}) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('demographics must be an object');
  for(const key of Object.keys(input))if(!['age_group','sex','body_size','seed','sample_physiology'].includes(key))
    throw Error(`Unknown demographics field: ${key}`);
  const {age_group,sex,body_size='typical',sample_physiology=false}=input;
  seed=input.seed??seed;
  if(!Object.hasOwn(AGE_GROUPS,age_group)||!['male','female'].includes(sex))throw Error('demographics requires a supported age_group and male/female sex');
  if(!Object.hasOwn(BODY_BANDS,body_size))throw Error('body_size must be small, typical or large');
  if(typeof sample_physiology!=='boolean')throw Error('sample_physiology must be boolean');
  if(!Number.isInteger(seed)||seed<0||seed>4294967295)throw Error('demographics seed must be a uint32');
  const type=`${age_group}_${sex}`,ref=BODY_REFERENCE[type],band=BODY_BANDS[body_size];
  const heightPercentile=10+80*Rng.stream(seed,`body:${type}:height`).next();
  const bmiPercentile=band[0]+(band[1]-band[0])*Rng.stream(seed,`body:${type}:bmi`).next();
  const height=round(interpolate(ref.height,heightPercentile)),bmi=interpolate(ref.bmi,bmiPercentile);
  const weight=round(bmi*(height/100)**2);
  return {person:{type,bmi:'normal',dawn:'absent',carb_counting:'typical',sample:sample_physiology,seed,
    anthropometry:{height_cm:height,weight_kg:weight}},
    provenance:{version:'sweet-sim.anthropometry/v1',source:ANTHROPOMETRY_SOURCE,age_group,
      age_years:AGE_GROUPS[age_group],sex,body_size,seed,height_percentile:heightPercentile,bmi_percentile:bmiPercentile,
      reference_height_cm:[ref.height[0],ref.height.at(-1)],reference_bmi:[interpolate(ref.bmi,band[0]),interpolate(ref.bmi,band[1])],
      assumption:'Independent uniform percentile draws with linear interpolation; weight = BMI * height_m^2. Not an empirical joint distribution or a clinical BMI category. No added resistance mechanism.'}};
}
