// Nightscout v1 read-only API (upstream routes and payloads unchanged): status, entries,
// treatments, profile, devicestatus. Timestamps are virtual time plus the publication offset,
// so an accelerated or fast-forwarded patient never publishes future-dated CGM.
import {direction} from '../core/cgm.mjs';
import {UTC_OFFSET_MINUTES} from './compat.mjs';

const TIMEZONE=UTC_OFFSET_MINUTES===480?'Asia/Shanghai':'UTC';

/** NS find[...] / start / end / count query -> Store.list options in virtual time. */
export function nsQuery(req,offset) {
  const q=req.query.find??{};
  const toTime=x=>x===undefined?undefined:/^\d+$/.test(String(x))?Number(x):Date.parse(x);
  const start=toTime(q.date?.$gte??q.dateString?.$gte??q.created_at?.$gte??req.query.start);
  const end=toTime(q.date?.$lte??q.dateString?.$lte??q.created_at?.$lte??req.query.end);
  return {limit:Math.min(20000,Math.max(1,Number(req.query.count??1000)||1000)),...(Number.isFinite(start)?{start:start-offset}:{}),...(Number.isFinite(end)?{end:end-offset}:{})};
}

/** Store samples (newest first) -> NS sgv entries. */
export function entries(points,offset) {
  return points.map((p,i)=>{
    const old=points[i+1],slope=old?(p.observed-old.observed)/((p.at-old.at)/60000):0,date=p.at+offset;
    const d=direction(slope);
    return {_id:String(p.at),date,dateString:new Date(date).toISOString(),sgv:Math.round(p.observed),type:'sgv',device:'sweet-sim',
      direction:d==='NONE'?'Flat':d,simulation:true,simulationTime:new Date(p.at).toISOString()};
  });
}

export function treatments(rows,offset) {
  return rows.map(p=>({...p,_id:p.id,created_at:new Date(p.at+offset).toISOString(),timestamp:p.at+offset,enteredBy:p.source,simulationTime:new Date(p.at).toISOString()}));
}

export function profile(service) {
  const p=service.config.profile,start=service.start+service.publicationOffset,at=value=>[{time:'00:00',timeAsSeconds:0,value}];
  return {_id:service.sessionId,defaultProfile:'Virtual',startDate:new Date(start).toISOString(),mills:start,units:'mg/dl',simulation:true,
    store:{Virtual:{dia:p.diaHours,timezone:TIMEZONE,units:'mg/dl',basal:at(p.basalUph),sens:at(p.isfMgdlPerU),carbratio:at(p.carbRatioGPerU),
      target_low:at(p.targetMgdl),target_high:at(p.targetMgdl)}}};
}

export function deviceStatus(service) {
  const s=service.status();
  return [{_id:s.sessionId,created_at:s.sampleTime,device:'sweet-sim',pump:{battery:{percent:s.battery},reservoir:s.reservoirU},
    openaps:{iob:{iob:s.iob,timestamp:s.sampleTime},suggested:{...s.recommendation,COB:s.cob}},simulation:true}];
}

export function mountNightscout(app,service,relay) {
  app.get('/health',(_,res)=>res.json({ok:!service.simulationError,simulation:true,simulationError:service.simulationError,relay:relay.health}));
  app.get('/api/v1/status.json',(_,res)=>res.json({status:'ok',name:'Sweet Sim Virtual Patient',version:'0.1.0',units:'mg/dl',simulation:true,
    subject:service.config.subject,settings:{units:'mg/dl'},extendedSettings:{},serverTime:new Date().toISOString()}));
  app.get(['/api/v1/entries.json','/api/v1/entries'],(req,res)=>{
    const offset=service.publicationOffset;
    res.json(entries(service.store.list('samples',nsQuery(req,offset)),offset));
  });
  app.get(['/api/v1/treatments.json','/api/v1/treatments'],(req,res)=>{
    const offset=service.publicationOffset;
    res.json(treatments(service.store.list('treatments',nsQuery(req,offset)),offset));
  });
  app.get('/api/v1/profile.json',(_,res)=>res.json([profile(service)]));
  app.get('/api/v1/profile/current',(_,res)=>res.json(profile(service)));
  app.get('/api/v1/devicestatus.json',(_,res)=>res.json(deviceStatus(service)));
}
