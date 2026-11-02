// Oracle for an exported sweet-sim Harbor task (copied to solution/oracle.mjs; run by solve.sh).
// Plays the causal-optimal decider (src/oracle/causal.mjs, full settings) to the horizon through the
// same HTTP interface and the same public facts (/app/public.json) an agent gets; nothing else. It is
// the decider behind the task's `references.causal` (src/opendiabet/episodes.mjs) and decides
// identically over HTTP, with the reference run's action ids and rationales, so the episode (its
// trajectory_sha256) and the reward of `harbor run --agent oracle` equal that reference: the task is
// solvable from visible information alone. Not an upper bound (the omniscient decider, which sees
// hidden state, is).
// Env: ORACLE_POLICY = causal (default) | causal-fast (fewer particles, shorter lookahead) | oref0 |
//      patient | baseline (the earlier oracle: oref0 for pumps and assisted care, the patient
//      baseline for pens or meter only); SWEET_SIM_PUBLIC (default /app/public.json; the local
//      runner sets it); ORACLE_MAX_STEPS (default: unlimited); AGENT_LOGS_DIR (default /logs/agent
//      when it exists): the causal decision log is written there as oracle.decisions.json.
import fs from 'node:fs';
import path from 'node:path';
import {episodeId,current,step,compact} from './sim-client.mjs';
import {makeCausalAgent} from './lib/src/oracle/causal.mjs';
import {oref0Policy} from './lib/src/policies/oref0.mjs';
import {patientPolicy} from './lib/src/policies/patient.mjs';

const id=await episodeId();
let cur=await current(id);
const requested=process.env.ORACLE_POLICY||'causal';
// Assisted care: the person already boluses announced meals, so the baseline is oref0 on top of it.
const assisted=cur.observation.profile?.self_care==='assisted';
const name=requested==='baseline'?(assisted||cur.observation.device?.type==='pump'?'oref0':'patient'):requested;
let policy,causal=null;
if(name==='causal'||name==='causal-fast') {
  const file=process.env.SWEET_SIM_PUBLIC||'/app/public.json';
  const pub=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!pub.description)throw new Error(`${file} has no description; re-export the task`);
  causal=makeCausalAgent(pub.description,{fast:name==='causal-fast'});policy=causal.policy;
} else if(name==='oref0')policy=oref0Policy;
else if(name==='patient')policy=patientPolicy();
else throw new Error(`unknown ORACLE_POLICY ${requested} (causal, causal-fast, oref0, patient, baseline)`);
// Action ids `${prefix}-${step}` and rationales as in the in-process reference episodes.
const prefix=name==='causal-fast'?'causal':name;
const max=Number(process.env.ORACLE_MAX_STEPS||Infinity);
let n=0;
while(!cur.done&&n<max) {
  const d=policy(cur.observation);
  const r=await step(id,d.action,String(d.rationale??'').slice(0,4000),{prefix,expected_step:cur.step});
  cur={observation:r.observation,step:r.info.step,done:r.terminated||r.truncated};n++;
}
const logs=process.env.AGENT_LOGS_DIR||(fs.existsSync('/logs/agent')?'/logs/agent':null);
if(causal&&logs) {
  try{fs.writeFileSync(path.join(logs,'oracle.decisions.json'),JSON.stringify({policy:name,options:causal.options,decisions:causal.log.decisions,timing:causal.log.timing}));}
  catch(e){console.error(`oracle: decision log not written: ${e.message}`);}
}
console.log(JSON.stringify({policy:name,steps:n,done:cur.done,...compact(cur.observation)}));
