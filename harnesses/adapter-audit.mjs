import fs from 'node:fs';
import {parseInvocations} from '../sim/src/bench/models/invocation-log.mjs';
import {SimEnv} from '../sim/src/env/pomdp.mjs';
import {configuredScore,configuredChecks} from '../sim/src/bench/evaluation-contract.mjs';
import {replayWorldEvidence} from './claude-code-decision-loop/world-replay.mjs';

export function auditAdapterTrial({dir,expectedConfig,evaluation,modelConfig}){
  const read=p=>JSON.parse(fs.readFileSync(p,'utf8')),bundle=read(dir+'/bundle.json'),stats=read(dir+'/stats.json');
  const transcript=fs.readFileSync(dir+'/transcript.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const calls=parseInvocations(fs.readFileSync(dir+'/invocations.jsonl','utf8'),{strict:true});
  const replay=replayWorldEvidence(bundle,expectedConfig,c=>new SimEnv(c));
  const checks={...configuredChecks(bundle,stats,transcript,expectedConfig,evaluation),controller_done:stats.state==='done',world_replay:replay.valid,
    model_requests:calls.length>0&&calls.every(c=>c.request.model===modelConfig.model),
    public_request_logs:calls.every(c=>typeof c.request.system==='string'&&Array.isArray(c.request.messages)&&Array.isArray(c.request.tools)),
    complete_invocations:calls.filter(c=>c.response&&!c.error).length>0,
    no_verifier_fill:!bundle.trajectory.some(r=>/harness:.*remaining horizon|validator.*WAIT/i.test(r.rationale??''))};
  const valid=Object.values(checks).every(Boolean),result={valid,audit_kind:'adapter-invocations-and-world-replay',checks,
    scientific_score:valid?configuredScore(bundle,evaluation).score:null,world_replay:replay};
  fs.writeFileSync(dir+'/ADAPTER-AUDIT.json',JSON.stringify(result,null,2));return result;
}
