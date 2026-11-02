// Verifier of an exported sweet-sim Harbor task (copied to tests/verify.mjs; run by tests/test.sh).
// 1. Finds the task's episode on the sim sidecar and records how far the agent got.
// 2. If the agent stopped before the horizon, plays the rest with WAIT (no further treatment):
//    physiology does not pause when the agent stops, so ending early cannot avoid later lows/highs.
//    `agent_completed` (0/1) in reward.json records whether the agent itself reached the horizon.
// 3. Has the sidecar score the episode (POST /harbor/score with the admin token, never visible to
//    the agent; sim-entry.mjs): the bench scoring code in the sidecar's snapshot (bench v0.2 weights,
//    severe-hypo veto; daily rewards and learning slope when scoring.json says verifier 'daily').
// 4. Writes reward.json (finite numbers only, docs/BENCH.zh-CN.md §8.4), metrics.json (full bench
//    metrics, score, daily scores), run.json (sweet-sim.run/v1 record for the player) and
//    bundle.json.gz (the evaluator bundle: the exact episode, replayable; SWEET_SIM_SAVE_BUNDLE=0
//    skips it, e.g. when the orchestrator saves the bundle itself). A failed bundle save is reported
//    on stderr and does not affect the reward.
//
// Env: SWEET_SIM_ADMIN_TOKEN (from task.toml [verifier.env]; or SWEET_SIM_ADMIN_TOKEN_STDIN=1 with the
//      token as the first line of stdin, as the local runner passes it), LOGS_DIR (/logs/verifier),
//      SCORING_FILE (alongside this file: scoring.json), SWEET_SIM_URL (optional), SWEET_SIM_SAVE_BUNDLE.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {request,baseUrl,episodeId,current,step} from './sim-client.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const readStdinLine=async()=>{let s='';for await(const c of process.stdin){s+=c;if(s.includes('\n'))break;}return s.split('\n')[0].trim();};
const logs=process.env.LOGS_DIR||'/logs/verifier';
const token=process.env.SWEET_SIM_ADMIN_TOKEN||(process.env.SWEET_SIM_ADMIN_TOKEN_STDIN==='1'?await readStdinLine():'');
if(!token)throw new Error('SWEET_SIM_ADMIN_TOKEN (or SWEET_SIM_ADMIN_TOKEN_STDIN=1 with the token on stdin) is required');
const scoringFile=process.env.SCORING_FILE||path.join(here,'scoring.json');
const scoring=fs.existsSync(scoringFile)?JSON.parse(fs.readFileSync(scoringFile,'utf8')):{};
fs.mkdirSync(logs,{recursive:true});

const id=await episodeId();
let cur=await current(id);
const agentSteps=cur.step,agentCompleted=cur.done;
let filled=0;const prefix=`verifier-${randomUUID()}`;   // unguessable: the agent cannot pre-claim these action ids
while(!cur.done) {
  const r=await step(id,{type:'WAIT'},'verifier: agent stopped before the horizon; remaining time without treatment',{prefix,expected_step:cur.step});
  cur={step:r.info.step,done:r.terminated||r.truncated};filled++;
}
const out=await request('/harbor/score',{token,timeout:300000,
  body:{scoring,agent_completed:agentCompleted,agent_steps:agentSteps,verifier_wait_steps:filled}});
fs.writeFileSync(path.join(logs,'reward.json'),JSON.stringify(out.reward)+'\n');
fs.writeFileSync(path.join(logs,'metrics.json'),JSON.stringify(out.metrics,null,1)+'\n');
fs.writeFileSync(path.join(logs,'run.json'),JSON.stringify(out.run));
if(process.env.SWEET_SIM_SAVE_BUNDLE!=='0') {
  try {
    const r=await fetch(`${await baseUrl()}/episodes/${id}/export`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(300000)});
    if(!r.ok)throw new Error(`${r.status} ${await r.text()}`);
    fs.writeFileSync(path.join(logs,'bundle.json.gz'),zlib.gzipSync(Buffer.from(await r.arrayBuffer()),{level:9}));
  } catch(e){console.error(`verifier: bundle not saved: ${e.message}`);}
}
console.log(JSON.stringify(out.reward));
