import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ROOT,read} from './lib.mjs';

export function resolveHarness(options){
  assert(['claude-code','codex'].includes(options.harness),'--harness must be claude-code or codex');
  assert(typeof options.model==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(options.model)&&options.model!=='true','--model must be your provider model identifier');
  const profile=read(ROOT+'configs/harnesses/'+options.harness+'.json');
  assert(!options['model-catalog']||options.harness==='codex','--model-catalog applies to the codex harness');
  const catalogFile=options['model-catalog']?fs.realpathSync(path.resolve(options['model-catalog'])):null;
  if(catalogFile){
    const entries=read(catalogFile).models;
    assert(Array.isArray(entries)&&entries.filter(m=>m.slug===options.model).length===1,'Catalog must contain exactly one entry for the requested model');
  }
  return {...profile,config:{...profile.config,model:options.model,name:options.model+' / '+options.harness},catalogFile};
}
