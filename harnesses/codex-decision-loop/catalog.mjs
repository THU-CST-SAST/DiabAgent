import fs from 'node:fs';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const reference=fileURLToPath(new URL('./model-catalog.json',import.meta.url));

export function benchmarkCatalog(model,sourceFile=null){
  assert(typeof model==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model));
  const catalogue=JSON.parse(fs.readFileSync(sourceFile??reference,'utf8'));
  assert(Array.isArray(catalogue.models),'Expected a Codex model catalogue');
  const matches=catalogue.models.filter(m=>m.slug===model);
  if(sourceFile)assert.equal(matches.length,1,'Catalogue must identify the selected model exactly once');
  if(matches.length===1)return {models:[structuredClone(matches[0])]};
  // Capability defaults for a Responses endpoint; callers may supply a model-specific catalogue.
  const entry=structuredClone(catalogue.models[0]);
  Object.assign(entry,{slug:model,display_name:model,description:'DiabAgent evaluation model',base_instructions:'',model_messages:null,
    prefer_websockets:false,use_responses_lite:false,context_window:128000,max_context_window:128000,
    default_reasoning_level:'high',supported_reasoning_levels:['low','medium','high','xhigh'].map(effort=>({effort,description:effort+' reasoning effort'})),
    availability_nux:null,upgrade:null,available_in_plans:[],service_tiers:[],additional_speed_tiers:[]});
  return {models:[entry]};
}
