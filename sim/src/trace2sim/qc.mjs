// Quality control of a normalised trace: CGM grid and gaps, coverage per local day, sensor
// warm-up, clipped values, compression-low heuristic, days with missing carb records, and the
// usable segments/days the fit and validation may use.
import {MIN_MS,DAY_MS,localDayKey,localDayStart,localMinuteOfDay,median,round} from './util.mjs';

export const QC_DEFAULTS=Object.freeze({
  gapMinutes:15,               // a gap is a missing stretch longer than this
  segmentBreakMinutes:60,      // segments split at gaps longer than this
  minSegmentHours:6,
  minDayCoverage:0.7,          // fraction of expected readings for a usable day
  minDailyCarbsG:30,           // below this a day is flagged as missing carb records
  sensorWarmupMinutes:120,
  sessionGapMinutes:100,       // a signal gap this long is taken as a sensor change
  compressionDropMgdlPerMin:2, // nocturnal fast drop ...
  compressionRecoverMinutes:60,// ... into a low that rebounds within this time
  clipLow:40,clipHigh:400,
});

/**
 * Returns {report, exclude:Set<t>, usableDays:[key], segments:[{from,to}]}.
 * exclude holds CGM timestamps that must not enter the fit or metrics.
 */
export function qualityControl(trace,opts={}) {
  const o={...QC_DEFAULTS,...opts},off=trace.meta.utc_offset_minutes,cgm=trace.cgm,warnings=[...trace.warnings];
  const diffs=[];for(let i=1;i<cgm.length;i++)diffs.push((cgm[i].t-cgm[i-1].t)/MIN_MS);
  const interval=Math.max(1,Math.round(median(diffs.filter(d=>d>0&&d<=15))||5));

  const gaps=[],segments=[];let segStart=cgm[0].t;
  for(let i=1;i<cgm.length;i++) {
    const d=(cgm[i].t-cgm[i-1].t)/MIN_MS;
    if(d>o.gapMinutes)gaps.push({from:cgm[i-1].t,to:cgm[i].t,minutes:d});
    if(d>o.segmentBreakMinutes){segments.push({from:segStart,to:cgm[i-1].t});segStart=cgm[i].t;}
  }
  segments.push({from:segStart,to:cgm.at(-1).t});
  const usableSegments=segments.filter(s=>s.to-s.from>=o.minSegmentHours*3600000);

  const exclude=new Map();   // t -> reason
  const mark=(t,why)=>{if(!exclude.has(t))exclude.set(t,why);};
  for(const r of cgm)if(r.mg_dl<=o.clipLow||r.mg_dl>=o.clipHigh)mark(r.t,'clipped');
  // Sensor warm-up after recorded sensor starts and after long signal gaps (likely new sensor).
  const starts=[...new Set([...trace.events.filter(e=>e.type==='sensor_start').map(e=>e.t),...gaps.filter(g=>g.minutes>=o.sessionGapMinutes).map(g=>g.to)])].sort((a,b)=>a-b);
  // Sensor sessions (each with its own calibration error): trace start, then every sensor start.
  const sessions=[cgm[0].t,...starts.filter(t=>t>cgm[0].t+3600000)];
  for(const s of starts)for(const r of cgm)if(r.t>=s&&r.t<s+o.sensorWarmupMinutes*MIN_MS)mark(r.t,'sensor_warmup');
  // Compression lows: at night (00-07 local) a fast drop into <70 that recovers to near the
  // pre-drop level within an hour, without recorded carbs in between.
  const compression=[];
  for(let i=1;i<cgm.length;i++) {
    const a=cgm[i-1],b=cgm[i],dt=(b.t-a.t)/MIN_MS,lm=localMinuteOfDay(b.t,off);
    if(lm>=420||dt>15||(a.mg_dl-b.mg_dl)/dt<o.compressionDropMgdlPerMin||b.mg_dl>=70)continue;
    let j=i;while(j<cgm.length&&cgm[j].t-b.t<=o.compressionRecoverMinutes*MIN_MS&&cgm[j].mg_dl<a.mg_dl-15)j++;
    const recovered=j<cgm.length&&cgm[j].t-b.t<=o.compressionRecoverMinutes*MIN_MS;
    const carbs=trace.carbs.some(c=>c.t>=a.t&&c.t<=(cgm[j]?.t??b.t));
    if(recovered&&!carbs){compression.push({from:b.t,to:cgm[j].t,nadir:Math.min(...cgm.slice(i,j).map(r=>r.mg_dl))});for(let k=i;k<j;k++)mark(cgm[k].t,'compression_low');}
  }

  // Per local day.
  const dayKeys=[...new Set(cgm.map(r=>localDayKey(r.t,off)))];
  const first=cgm[0].t,last=cgm.at(-1).t;
  const days=dayKeys.map(key=>{
    const a=Math.max(localDayStart(key,off),first),b=Math.min(localDayStart(key,off)+DAY_MS,last+interval*MIN_MS);
    const inDay=t=>localDayKey(t,off)===key;
    const n=cgm.filter(r=>inDay(r.t)&&!exclude.has(r.t)).length,expected=Math.max(1,(b-a)/(interval*MIN_MS));
    const carbs=trace.carbs.filter(c=>inDay(c.t)),bolus=trace.boluses.filter(x=>inDay(x.t));
    const fullDay=(b-a)>=0.95*DAY_MS;
    const coverage=Math.min(1,n/expected),flags=[];
    if(!fullDay)flags.push('partial_day');
    if(coverage<o.minDayCoverage)flags.push('low_coverage');
    const carbG=carbs.reduce((s,c)=>s+c.grams,0);
    if(fullDay&&carbG<o.minDailyCarbsG)flags.push('carbs_missing');
    return {day:key,coverage:round(coverage,3),readings:n,full_day:fullDay,carbs_g:carbG,n_carbs:carbs.length,
      bolus_u:round(bolus.reduce((s,x)=>s+x.units,0),2),flags,
      usable:coverage>=o.minDayCoverage&&!flags.includes('carbs_missing')&&(b-a)>=o.minSegmentHours*3600000};
  });
  const usableDays=days.filter(d=>d.usable).map(d=>d.day);
  const total=(last-first)/(interval*MIN_MS)+1,coverage=cgm.length/total;
  if(coverage<0.7)warnings.push(`CGM coverage ${(coverage*100).toFixed(0)}% is low`);
  if(!trace.carbs.length)warnings.push('no carb records: meals cannot be replayed');
  if(trace.meta.therapy.mode==='pump'&&!trace.temp_basals.length&&!trace.basal.length)warnings.push('pump trace without temp basals: assuming the profile basal ran unchanged');
  if(usableDays.length<2)warnings.push('fewer than 2 usable days: holdout validation not possible');
  const report={n_cgm:cgm.length,interval_minutes:interval,span_days:round((last-first)/DAY_MS,2),coverage:round(coverage,3),
    gaps:gaps.map(g=>({from:new Date(g.from).toISOString(),to:new Date(g.to).toISOString(),minutes:round(g.minutes,1)})),
    segments:segments.map(s=>({from:new Date(s.from).toISOString(),to:new Date(s.to).toISOString(),hours:round((s.to-s.from)/3600000,2),
      usable:usableSegments.includes(s)})),
    excluded:Object.fromEntries([...new Set(exclude.values())].map(k=>[k,[...exclude.values()].filter(v=>v===k).length])),
    compression_lows:compression.map(c=>({from:new Date(c.from).toISOString(),to:new Date(c.to).toISOString(),nadir:c.nadir})),
    sensor_sessions:sessions.map(t=>new Date(t).toISOString()),
    days,usable_days:usableDays,counts:{carbs:trace.carbs.length,boluses:trace.boluses.length,temp_basals:trace.temp_basals.length,
      basal_injections:trace.basal_injections.length,exercise:trace.exercise.length,smbg:trace.smbg.length},warnings};
  return {report,exclude,usableDays,segments,usableSegments,interval,sessions};
}
