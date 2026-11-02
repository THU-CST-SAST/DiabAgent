import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ROOT,read} from './lib.mjs';
import {merge} from './experiment.mjs';

export function resolveHarness(options,overrides={}){
  assert(['claude-code','codex','adapter','custom'].includes(options.harness),'--harness must be claude-code, codex, adapter, or custom');
  assert(typeof options.model==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(options.model)&&options.model!=='true','--model must be your provider model identifier');
  const profile=options.harness==='custom'?{harness:'custom',config:{}}:read(ROOT+'configs/harnesses/'+options.harness+'.json');
  const fileOptions=options['harness-config']?read(options['harness-config']):{};
  const settings=merge(merge(profile.config,overrides),fileOptions.config??fileOptions);
  assert(!['api_key','key','token'].some(k=>Object.hasOwn(settings,k)),'Use a credential environment variable');
  const moduleFile=options['harness-module']?fs.realpathSync(options['harness-module']):null;
  assert(options.harness!=='custom'||moduleFile,'custom harness requires --harness-module');
  assert(!options['model-catalog']||options.harness==='codex','--model-catalog applies to the codex harness');
  const catalogFile=options['model-catalog']?fs.realpathSync(path.resolve(options['model-catalog'])):null;
  if(catalogFile){
    const entries=read(catalogFile).models;
    assert(Array.isArray(entries)&&entries.filter(m=>m.slug===options.model).length===1,'Catalog must contain exactly one entry for the requested model');
  }
  return {...profile,config:{...settings,model:options.model,name:options.model+' / '+options.harness},catalogFile,moduleFile};
}
