import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

/** Report/audit selection follows the frozen manifest, never an older same-folder config. */
export function loadWeeklyCampaign(root) {
  const runtime=path.resolve(root),source=JSON.parse(fs.readFileSync(path.join(runtime,'SKILL-ONLY-SOURCE.json'),'utf8'));
  if(source.format!=='sweet-sim.skill-only-campaign-source/v2'
    ||!/^bench\/campaigns\/[a-z0-9][a-z0-9._-]*\.json$/.test(source.campaign_file??''))throw Error('Invalid frozen campaign selection');
  const file=path.join(runtime,source.campaign_file),bytes=fs.readFileSync(file);
  const digest=createHash('sha256').update(bytes).digest('hex');
  if(source.files?.[source.campaign_file]!==digest)throw Error('Selected campaign differs from frozen source');
  const cfg=JSON.parse(bytes);
  if(cfg.id!==source.campaign)throw Error('Frozen campaign identity differs');
  if(![cfg.jobs_dir,cfg.state_dir].every(value=>/^artifacts\/[A-Za-z0-9._/-]+$/.test(value??'')
    &&!value.split('/').some(part=>!part||part==='.'||part==='..')))throw Error('Invalid campaign output paths');
  return {runtime,source,cfg};
}
