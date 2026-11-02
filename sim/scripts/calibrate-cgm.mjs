// Fits each CGM's dispersion multiplier (`spread`) so that simulated MARD against true plasma
// glucose matches the labeled adult MARD, and reports the G6 model's MARD at spread 1.
// Glucose traces come from oref0-controlled episodes with an ideal CGM. Fingerstick-calibrated
// sensors are calibrated with a meter (CALIBRATION_METER) at insertion (startup_calibrations
// readings averaged) and then every calibration.interval_hours, as the patient routine does.
// Labels report MARD over the whole sensor life, so the 8 sensors per trace are placed evenly
// over the wear period (sensor k starts k/7 of the way between day 0 and wear_days - 2).
// Usage: node scripts/calibrate-cgm.mjs
import {SimEnv} from '../src/env/pomdp.mjs';
import {oref0Policy} from '../src/policies/oref0.mjs';
import {Cgm,CGMS} from '../src/core/cgm.mjs';
import {Meter} from '../src/core/meter.mjs';

const TRACE_SEEDS=Array.from({length:12},(_,i)=>1000+i),SENSORS_PER_TRACE=8;
export const CALIBRATION_METER='contour_next_one';
/** Sensors whose spread is fitted here (all non-test padova sensors). */
export const FITTED_SENSORS=Object.keys(CGMS).filter(id=>CGMS[id].kind==='padova'&&!CGMS[id].test_only);

/** Per-minute true glucose, linearly interpolated from the evaluator's step records. */
export function traces() {
  return TRACE_SEEDS.map(seed=>{
    const env=new SimEnv({seed,horizon_minutes:2880,cgm:{model:'ideal'}});
    while(!env.done())env.step({action_id:`o${env.step_count}`,expected_step:env.step_count,action:oref0Policy(env.observe()).action});
    const pts=env.evaluator.map(e=>({t:(Date.parse(e.time)-env.start)/60000,g:e.true_glucose_mg_dl})),out=[];
    for(let i=1;i<pts.length;i++)for(let m=Math.ceil(pts[i-1].t);m<pts[i].t;m++)
      out.push(pts[i-1].g+(pts[i].g-pts[i-1].g)*(m-pts[i-1].t)/(pts[i].t-pts[i-1].t));
    return {start:env.start,bg:out};
  });
}

/** Age (ms) at the trace start of sensor k: evenly spread so the trace windows tile the wear period. */
export function sensorAge(model,k,traceMinutes) {
  const wear=CGMS[model].wear_days;
  if(!Number.isFinite(wear))return 0;
  return Math.max(0,wear*86400000-traceMinutes*60000)*k/(SENSORS_PER_TRACE-1);
}

/** MARD, %20/20 and missing fraction of a CGM model over the traces. */
export function evaluate(model,spread,data,{meter=CALIBRATION_METER,calibrate=true}={}) {
  let ard=0,n=0,within=0,missing=0,total=0;
  const cal=calibrate&&CGMS[model].calibration?.required?CGMS[model].calibration:null,every=cal?cal.interval_hours*60:Infinity;
  data.forEach((tr,ti)=>{for(let k=0;k<SENSORS_PER_TRACE;k++) {
    const cgm=new Cgm({model,seed:ti*1000+k,start:tr.start,spread});
    const fingerstick=cal?new Meter({model:meter,seed:ti*1000+k}):null;
    // Fresh sensor of age `age` at the trace start (no warm-up, so the sample is not shrunk).
    cgm.sensor=cgm.newSensor(tr.start-sensorAge(model,k,tr.bg.length),false);
    for(let m=0;m<tr.bg.length;m++) {
      cgm.integrate(1,tr.bg[m]);
      if(cal&&m%every===0) {
        // Startup uses the mean of several fingersticks; later calibrations use one.
        const count=m===0?cal.startup_calibrations??1:1,at=tr.start+m*60000;
        let sum=0;for(let i=0;i<count;i++)sum+=fingerstick.measure(at,tr.bg[m],'calibration').value;
        cgm.calibrate(at,sum/count);
      }
      if(m%5)continue;
      const r=cgm.sample(tr.start+m*60000,tr.bg[m]);total++;
      if(!r){missing++;continue;}
      const ref=tr.bg[m],e=Math.abs(r.value-ref);
      ard+=e/ref;n++;if(ref<100?e<=20:e/ref<=0.2)within++;
    }
  }});
  return {mard:ard/n,pct_20_20:within/n,missing:missing/total,samples:n};
}

export function fitSpread(model,data) {
  let lo=0.2,hi=2;
  for(let i=0;i<30;i++){const mid=(lo+hi)/2;if(evaluate(model,mid,data).mard<CGMS[model].label_mard)lo=mid;else hi=mid;}
  return +((lo+hi)/2).toFixed(3);
}

if(import.meta.url===`file://${process.argv[1]}`) {
  const data=traces();
  // Independent sampling of the published G6 parameter dispersions ignores their correlation
  // and overshoots the labeled MARD, so G6 is rescaled as well.
  const g6=evaluate('dexcom_g6',1,data);
  console.log('dexcom_g6 unscaled',JSON.stringify({...g6,label_mard:CGMS.dexcom_g6.label_mard}));
  for(const model of FITTED_SENSORS) {
    const spread=fitSpread(model,data),r=evaluate(model,spread,data);
    console.log(model,JSON.stringify({spread,...r,label_mard:CGMS[model].label_mard}));
  }
}
