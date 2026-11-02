// Read-only access to raw glucose records already received by this agent.
import {MGDL_PER_MMOL} from './prompt.mjs';
import {memoryRevision} from './prompt-revisions.mjs';

export const HISTORY_READ_LIMIT=3;
export const hasGlucoseHistory=opts=>memoryRevision(opts.prompt_revision)&&opts.memory!=='none';

function localIso(time,offsetMs) {
  const minutes=Math.round(offsetMs/60000),abs=Math.abs(minutes);
  const zone=`${minutes<0?'-':'+'}${String(Math.floor(abs/60)).padStart(2,'0')}:${String(abs%60).padStart(2,'0')}`;
  return new Date(time+offsetMs).toISOString().replace('Z',zone);
}

function observedPoints(records,now) {
  const points=new Map();
  for(const p of records.continuous.values()) {
    if(Number.isFinite(p.t)&&p.t<=now&&Number.isFinite(p.v))
      points.set(`${p.t}|${p.src}`,{t:p.t,source:p.src,value:p.v});
  }
  for(const p of records.spot.values()) {
    const t=Date.parse(p.time),source=p.source==='flash_scan'?'flash':'meter';
    if(!Number.isFinite(t)||t>now||(!Number.isFinite(p.value_mg_dl)&&!p.display))continue;
    points.set(`${t}|${source}`,{t,source,value:Number.isFinite(p.value_mg_dl)?p.value_mg_dl:null,...(p.display?{display:p.display}:{})});
  }
  return [...points.values()].sort((a,b)=>a.t-b.t||a.source.localeCompare(b.source));
}

function parseTime(value,label) {
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))
    throw Error(`${label} must be an ISO timestamp with Z or a numeric timezone offset`);
  return Date.parse(value);
}

export const glucoseHistoryTool=Object.freeze({
  name:'read_glucose_history',
  description:`Read previously observed glucose records, including earlier days, without advancing time or changing anything. Sensor gaps remain gaps; no hidden or future glucose is returned. At most ${HISTORY_READ_LIMIT} reads per decision. Use next_offset to continue the same time/source query.`,
  input_schema:{type:'object',properties:{
    start_time:{type:'string',description:'Inclusive ISO timestamp with timezone; omit for the earliest available observation.'},
    end_time:{type:'string',description:'Inclusive ISO timestamp with timezone; omit for now. Future end times are clipped to now.'},
    source:{enum:['all','cgm','flash','meter'],description:'Default all; distinct sensors and meter measurements keep their sources.'},
    offset:{type:'integer',minimum:0,description:'Pagination offset within the same query; default 0.'},
    limit:{type:'integer',minimum:1,maximum:1000,description:'Maximum records in this page; default 288.'}
  },additionalProperties:false}
});

// from (amnesic learning control): readings before this time are not available.
export function glucoseHistoryAvailability(records,{now,from=-Infinity}) {
  const points=observedPoints(records,now).filter(p=>p.t>=from);
  return {count:points.length,from:points.length?localIso(points[0].t,records.offsetMs):null,
    until:points.length?localIso(points.at(-1).t,records.offsetMs):null};
}

export function readGlucoseHistory(records,args={}, {now,units='mmol',from=-Infinity}={}) {
  if(!Number.isFinite(now)||!['mgdl','mmol'].includes(units))throw Error('Invalid history clock or units');
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['start_time','end_time','source','offset','limit'].includes(k)))
    throw Error('Invalid glucose-history query');
  const start=args.start_time==null?-Infinity:parseTime(args.start_time,'start_time');
  const requestedEnd=args.end_time==null?now:parseTime(args.end_time,'end_time'),end=Math.min(requestedEnd,now);
  const source=args.source??'all',offset=args.offset??0,limit=args.limit??288;
  if(!['all','cgm','flash','meter'].includes(source)||!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>1000||start>end)
    throw Error('Invalid history range, source or pagination');
  const all=observedPoints(records,now).filter(p=>p.t>=from);
  const matched=all.filter(p=>p.t>=start&&p.t<=end&&(source==='all'||p.source===source));
  const page=matched.slice(offset,offset+limit);
  return {ok:true,as_of:localIso(now,records.offsetMs),units:units==='mgdl'?'mg/dL':'mmol/L',
    available_from:all.length?localIso(all[0].t,records.offsetMs):null,available_until:all.length?localIso(all.at(-1).t,records.offsetMs):null,
    total:matched.length,offset,next_offset:offset+page.length<matched.length?offset+page.length:null,
    end_clipped_to_now:requestedEnd>now,
    readings:page.map(p=>({time:localIso(p.t,records.offsetMs),source:p.source,
      value:p.value==null?null:units==='mgdl'?p.value:p.value/MGDL_PER_MMOL,...(p.display?{display:p.display}:{})})),
    note:'Only previously observed readings; missing periods are not filled. No inferred events or true glucose.'};
}
