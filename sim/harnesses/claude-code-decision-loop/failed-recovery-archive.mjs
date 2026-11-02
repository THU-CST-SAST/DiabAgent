import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectEmptyGatewayFailure} from './gateway-wait.mjs';
import {nativeTerminalFailure} from './native-failure.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const facts=r=>({system:r.system,messages:r.messages,tools:r.tools});

// A zero-progress attempt is an archive, not an invented new accepted-prefix generation.
export function inspectFailedRecoveryArchive(proof,archive,{loadCalls}){
  const source=fs.realpathSync(archive.source);assert.equal(source,archive.source);
  assert.notEqual(source,proof.source);
  assert.equal(path.basename(path.dirname(source)),'trials');
  assert.equal(path.dirname(path.dirname(path.dirname(source))),path.dirname(path.dirname(path.dirname(proof.source))));
  for(const [file,key] of [['invocations.jsonl','invocations_sha256'],['stats.json','stats_sha256'],['bundle.json','bundle_sha256']])assert.equal(sha(source+'/'+file),archive[key]);
  const calls=loadCalls(source),original=loadCalls(proof.source).filter(c=>c.response&&!c.error);
  const accepted=calls.filter(c=>c.response&&!c.error),failed=calls.filter(c=>c.error);
  assert.equal(accepted.length,proof.accepted_calls);assert.equal(original.length,accepted.length);
  assert(failed.length>=1&&failed.length<=2);assert.equal(calls.length,accepted.length+failed.length);
  for(let i=0;i<accepted.length;i++){
    const c=accepted[i],replay=c.replay??c.response.replay;
    assert(replay?.no_new_api_call);assert.equal(replay.registered_prefix_sha256,hash(proof));
    assert.equal(replay.source_sha256,proof.source_invocations_sha256);
    assert.equal(hash(c.response.raw),proof.prefix[i].response_sha256);
    assert.deepEqual(facts(c.request),facts(original[i].request));
  }
  const bundle=JSON.parse(fs.readFileSync(source+'/bundle.json'));
  assert.deepEqual(bundle,JSON.parse(fs.readFileSync(proof.source+'/bundle.json')));
  assert.equal(JSON.parse(fs.readFileSync(source+'/stats.json')).env_steps,proof.steps);
  assert.equal(archive.sessions.length,failed.length);
  const names=archive.sessions.map(s=>s.name).sort();
  assert.deepEqual(fs.readdirSync(source+'/Code').filter(n=>/^session-\d+$/.test(n)).sort(),names);
  for(let i=0;i<failed.length;i++){
    const c=failed[i];assert(c.call>accepted.at(-1).call);assert(!c.response);
    assert.equal(hash(facts(c.request)),proof.terminal_request_sha256);
    const s=archive.sessions[i];assert(/^session-\d+$/.test(s.name));
    const dir=source+'/Code/'+s.name;
    assert.equal(sha(dir+'/SESSION.json'),s.session_sha256);assert.equal(sha(dir+'/stdout.jsonl'),s.stdout_sha256);
    inspectEmptyGatewayFailure(dir);
    const events=fs.readFileSync(dir+'/stdout.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const error=nativeTerminalFailure(events);assert(error&&[429,500,502,503,504].includes(error.status));
    assert(c.error.status===error.status||(c.error.status==null&&c.error.code==='ERR_ASSERTION'));
  }
  return {valid:true,accepted_prefix_unchanged:true,new_accepted_calls:0,failed_attempts:failed.length};
}
