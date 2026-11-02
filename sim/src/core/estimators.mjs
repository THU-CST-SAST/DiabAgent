// Agent-visible estimates, computed only from information a phone app would hold:
// the pump's delivery ledger and patient-reported carbs. Never from model state.
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const iobCalc=require('../../vendor/oref0/lib/iob/calculate.js');

export const COB_DEFINITION='reported carbs absorbed linearly over the configured window; g; not the model gut pool';
export const iobDefinition=({curve,peak_minutes},dia)=>
  `oref0 ${curve} exponential curve, peak ${peak_minutes} min, DIA ${dia} h, over device-recorded boluses and net basal vs schedule; U`;

/** IOB as AAPS computes it, with the insulin's AAPS curve preset (peak in minutes). */
export function iobAt(ledger,time,diaHours,{curve='rapid-acting',peak_minutes=75}={}) {
  const profile={curve,useCustomPeakTime:true,insulinPeakTime:peak_minutes};
  let iob=0,activity=0,bolus=0,basal=0;
  for(const d of ledger) {
    if(d.at>time||d.at<=time-diaHours*3600000)continue;
    const r=iobCalc({insulin:d.units,date:d.at},new Date(time),curve,diaHours,peak_minutes,profile);
    iob+=r.iobContrib??0;activity+=r.activityContrib??0;
    if(d.kind==='basal')basal+=r.iobContrib??0;else bolus+=r.iobContrib??0;
  }
  return {iob,activity,bolus_iob:bolus,basal_iob:basal};
}

/** carbs: [{at, grams}]. Returns remaining grams and the reported total still absorbing. */
export function cobAt(carbs,time,windowMinutes) {
  let cob=0,absorbing=0,lastAt=0;
  for(const c of carbs) {
    const left=c.grams*Math.max(0,1-(time-c.at)/(windowMinutes*60000));
    if(c.at<=time&&left>0){cob+=left;absorbing+=c.grams;}
    if(c.at<=time)lastAt=Math.max(lastAt,c.at);
  }
  return {cob,absorbing_carbs:absorbing,last_carb_at:lastAt};
}
