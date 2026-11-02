// Loads the type library in knowledge/ (data, not code), validates evidence records and
// source references, and exposes it to the runtime. Every episode manifest records
// KNOWLEDGE_SHA256 so results can be tied to the exact parameter set used.
import fs from 'node:fs';
import {createHash} from 'node:crypto';

const DIR=new URL('../knowledge/',import.meta.url);
const FILES=['sources.json','insulins.json','devices.json','sensors.json','persons.json','instances.json'];
export const EVIDENCE_LEVELS=['primary','label','review','fitted','assumed'];

const text=Object.fromEntries(FILES.filter(f=>fs.existsSync(new URL(f,DIR))).map(f=>[f,fs.readFileSync(new URL(f,DIR),'utf8')]));
export const KNOWLEDGE_SHA256=createHash('sha256').update(Object.entries(text).map(([f,t])=>f+'\n'+t).join('\n')).digest('hex');
const load=f=>text[f]?JSON.parse(text[f]):{};
/** Drops documentation keys (leading underscore). */
export const entries=o=>Object.fromEntries(Object.entries(o??{}).filter(([k])=>!k.startsWith('_')));

export const SOURCES=load('sources.json');
const devices=load('devices.json'),sensors=load('sensors.json');
export const KNOWLEDGE={
  insulins:entries(load('insulins.json')),
  pumps:entries(devices.pumps),pens:entries(devices.pens),penInsulins:entries(devices.pen_insulins),faults:entries(devices.faults),
  sensors:entries(sensors.sensors),meters:entries(sensors.meters),errorModels:entries(sensors.error_models),gapsDefault:sensors.gaps_default,
  persons:entries(load('persons.json').persons),populations:entries(load('persons.json').populations),
  personModel:(({reference,variants,profile_mismatch,daily_sensitivity_cv})=>({reference,variants,profile_mismatch,daily_sensitivity_cv}))(load('persons.json')),
  aaps:devices.aaps??{},
  instances:entries(load('instances.json').presets),prevalence:entries(load('instances.json').prevalence),
};

/** Evidence for a field path: exact, then nearest parent, then the entity default '*'. */
export function evidenceFor(entity,path) {
  const ev=entity?.evidence??{};
  for(let p=path;p;p=p.includes('.')?p.slice(0,p.lastIndexOf('.')):'')if(ev[p])return ev[p];
  return ev['*']??{level:'assumed',sources:[],note:'no evidence record'};
}

function checkRecord(where,rec) {
  if(!EVIDENCE_LEVELS.includes(rec.level))throw new Error(`${where}: evidence level '${rec.level}' not in ${EVIDENCE_LEVELS.join(', ')}`);
  for(const s of rec.sources??[])if(!SOURCES[s])throw new Error(`${where}: unknown source '${s}'`);
}
/** Walks every evidence record in the library; throws on unknown levels or sources. */
export function validateKnowledge() {
  const groups={insulins:KNOWLEDGE.insulins,pumps:KNOWLEDGE.pumps,pens:KNOWLEDGE.pens,sensors:KNOWLEDGE.sensors,meters:KNOWLEDGE.meters,
    error_models:KNOWLEDGE.errorModels,persons:KNOWLEDGE.persons,populations:KNOWLEDGE.populations};
  let n=0;
  for(const [g,items] of Object.entries(groups))for(const [id,item] of Object.entries(items))
    for(const [path,rec] of Object.entries(item.evidence??{})){checkRecord(`${g}.${id}.${path}`,rec);n++;}
  for(const [id,f] of Object.entries(KNOWLEDGE.faults)){checkRecord(`faults.${id}`,f.evidence);n++;}
  checkRecord('sensors.gaps_default',KNOWLEDGE.gapsDefault.evidence);
  for(const [pen,ins] of Object.entries(KNOWLEDGE.penInsulins)) {
    if(!KNOWLEDGE.pens[pen])throw new Error(`pen_insulins: unknown pen ${pen}`);
    for(const i of ins)if(!KNOWLEDGE.insulins[i])throw new Error(`pen_insulins.${pen}: unknown insulin ${i}`);
  }
  return n;
}
validateKnowledge();
