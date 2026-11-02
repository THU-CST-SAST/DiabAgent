import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const calculate=require('../../../vendor/oref0/lib/iob/calculate.js');
const determineBasal=require('../../../vendor/oref0/lib/determine-basal/determine-basal.js');
const tempFunctions=require('../../../vendor/oref0/lib/basal-set-temp.js');

/** oref0 action-curve IOB in U, relative to scheduled basal, never plasma concentration. */
export function iobAt(world,time=world.now) {
  const p=world.config.profile,curve={curve:'rapid-acting',dia:p.diaHours,useCustomPeakTime:false};
  let iob=0,activity=0,bolusiob=0,basaliob=0;
  for(const dose of world.doses)if(dose.at<=time&&dose.at>time-p.diaHours*3600000) {
    const r=calculate({insulin:dose.units,date:dose.at},new Date(time),'rapid-acting',p.diaHours,75,curve);
    iob+=r.iobContrib??0;activity+=r.activityContrib??0;
    if(dose.kind==='basal')basaliob+=r.iobContrib??0;else bolusiob+=r.iobContrib??0;
  }
  return {iob,activity,basaliob,bolusiob,time:new Date(time).toISOString()};
}
export function controllerRecommendation(world) {
  const points=world.recentSamples,p=world.config.profile,target=world.tempTarget&&world.tempTarget.until>world.now?world.tempTarget.value:p.targetMgdl;
  const current=points.at(-1),last=points.at(-2)??current;
  const delta=(current.observed-last.observed)/Math.max(1,(current.at-last.at)/300000);
  const average=minutes=>{const old=[...points].reverse().find(r=>r.at<=world.now-minutes*60000)??points[0];return (current.observed-old.observed)/Math.max(1,(current.at-old.at)/300000);};
  const profile={current_basal:p.basalUph,max_basal:p.maxBasalUph,max_daily_basal:p.basalUph,
    max_daily_safety_multiplier:3,current_basal_safety_multiplier:4,max_iob:p.maxIobU,min_bg:target,max_bg:target,
    sens:p.isfMgdlPerU,carb_ratio:p.carbRatioGPerU,dia:p.diaHours,curve:'rapid-acting',
    autosens_max:1.2,autosens_min:.7,enableUAM:true,enableSMB_always:false,temptargetSet:target!==p.targetMgdl,
    bolus_increment:.05,skip_neutral_temps:false,carbsReqThreshold:1,out_units:'mg/dL'};
  const iobs=Array.from({length:48},(_,i)=>{
    const r=iobAt(world,world.now+i*300000);
    return {...r,iobWithZeroTemp:{iob:r.iob,activity:r.activity},
      lastBolusTime:Math.max(0,...world.doses.filter(d=>d.kind!=='basal').map(d=>d.at)),
      lastTemp:{date:world.manualBasal?.at??world.now,duration:world.manualBasal?(world.manualBasal.until-world.manualBasal.at)/60000:0,rate:world.basalRate()}};
  });
  const meal={mealCOB:world.cob(),carbs:world.meals.filter(m=>world.now-m.at<=6*3600000).reduce((s,m)=>s+m.grams,0),
    lastCarbTime:Math.max(0,...world.meals.map(m=>m.at)),slopeFromMaxDeviation:0,slopeFromMinDeviation:0,bwFound:false};
  // oref0 emits verbose diagnostics; capture synchronously rather than flooding service logs.
  const saved=console.error,savedWrite=process.stderr.write,log=[];console.error=(...v)=>log.push(v.join(' '));
  process.stderr.write=(chunk,encoding,callback)=>{log.push(String(chunk));if(typeof encoding==='function')encoding();else if(callback)callback();return true;};
  try {
    const r=determineBasal({glucose:current.observed,date:current.at,delta,short_avgdelta:average(15),long_avgdelta:average(40),noise:0,device:'fakecgm'},
      {rate:world.basalRate(),duration:world.manualBasal?Math.max(0,(world.manualBasal.until-world.now)/60000):0},iobs,profile,{ratio:1},meal,tempFunctions,false,100,new Date(world.now));
    return {...r,algorithm:'oref0-0.7.1',simulation:true,diagnostics:log.slice(-6)};
  } finally {console.error=saved;process.stderr.write=savedWrite;}
}
