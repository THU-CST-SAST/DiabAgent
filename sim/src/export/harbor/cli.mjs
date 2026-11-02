#!/usr/bin/env node
// `sim`: agent-side command line for a sweet-sim Harbor task. Self-contained (Node >= 24,
// no imports outside node:*): the exporter copies it into the agent container as
// /opt/sweet-sim-cli/sim.mjs with a /usr/local/bin/sim wrapper. Talks HTTP only to the
// simulation sidecar (src/env/http.mjs semantics, as scripts/interact.mjs); the sidecar
// keeps hidden state and evaluator data. Also imported as a library by the oracle and verifier.
//
//   sim status                      compact current state (glucose, trend, IOB, COB, basal, events)
//   sim observe                     full observation JSON (incl. profile, action_specs, history)
//   sim specs                       observation.action_specs (allowed actions and their limits)
//   sim step '<json action>' [rationale...]   one decision, e.g. sim step '{"type":"BOLUS","units":2}' "meal"
//   sim wait [N] [rationale...]     up to N WAIT steps (default 1, max 288); stops early on events,
//                                   a glucose change >= 10 mg/dL or glucose < 80 mg/dL
//
// Environment: SWEET_SIM_URL (default: try http://sim:8765, then http://127.0.0.1:8765).
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const CANDIDATES=process.env.SWEET_SIM_URL?[process.env.SWEET_SIM_URL]:['http://sim:8765','http://127.0.0.1:8765'];
let base=null;

export async function request(path,{body,token,timeout=60000}={}) {
  const headers={};
  if(body!==undefined)headers['Content-Type']='application/json';
  if(token)headers.Authorization=`Bearer ${token}`;
  const r=await fetch((await baseUrl())+path,{method:body!==undefined?'POST':'GET',headers,body:body!==undefined?JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeout)});
  const d=await r.json();
  if(!r.ok)throw new Error(`${r.status} ${JSON.stringify(d)}`);
  return d;
}

/** First reachable simulator URL (waits up to `waitMs` for the sidecar to come up). */
export async function baseUrl(waitMs=Number(process.env.SWEET_SIM_WAIT_MS??60000)) {
  if(base)return base;
  const deadline=Date.now()+waitMs;
  for(;;) {
    for(const url of CANDIDATES) {
      try{const r=await fetch(url+'/health',{signal:AbortSignal.timeout(2000)});if(r.ok&&(await r.json()).episodes>0)return base=url;}catch{}
    }
    if(Date.now()>deadline)throw new Error(`simulator not reachable at ${CANDIDATES.join(' or ')}`);
    await new Promise(r=>setTimeout(r,500));
  }
}

/** The task's single episode id. */
export async function episodeId() {
  const {episodes}=await request('/episodes');
  if(episodes.length!==1)throw new Error(`expected exactly one episode, found ${episodes.length}`);
  return episodes[0];
}

/** {observation, step, done} */
export async function current(id) {return request(`/episodes/${id??await episodeId()}`);}

/** One decision. Action ids are `${prefix}-${step}` so a retried request is idempotent. */
export async function step(id,action,rationale='',{prefix='agent',expected_step}={}) {
  const at=expected_step??(await current(id)).step;
  return request(`/episodes/${id}/step`,{body:{action_id:`${prefix}-${at}`,expected_step:at,action,rationale:String(rationale).slice(0,4000)}});
}

const bgOf=o=>o?.glucose?.value_mg_dl??null;
const r1=v=>v===null||v===undefined?null:Math.round(v*10)/10;
export function compact(o) {
  return {time:o.local_time,elapsed_minutes:o.elapsed_minutes,glucose:r1(bgOf(o)),source:o.glucose?.source??null,age_minutes:o.glucose?.age_minutes??null,
    trend:o.cgm?.direction??null,iob_u:r1(o.iob?.total_u),cob_g:r1(o.cob?.estimate_g),basal_u_h:o.device?.current_basal_u_h===undefined?null:r1(o.device.current_basal_u_h),
    events:(o.events??[]).map(e=>e.type==='meal_announced'?`meal_announced ${e.grams}g`:e.type)};
}

/** Up to n WAIT steps, interrupted like scripts/interact.mjs. */
export async function waitSteps(id,n,rationale='',{prefix='agent',interrupt=true}={}) {
  let cur=await current(id);const g0=bgOf(cur.observation),rows=[];
  for(let i=0;i<n&&!cur.done;i++) {
    const r=await step(id,{type:'WAIT'},i?`WAIT continuation: ${rationale}`:rationale,{prefix,expected_step:cur.step});
    cur={observation:r.observation,step:r.info.step,done:r.terminated||r.truncated};
    rows.push({step:cur.step,...compact(r.observation),stop_reason:r.info.stop_reason});
    const g=bgOf(r.observation);
    if(interrupt&&(r.observation.events.length||(g!==null&&g0!==null&&Math.abs(g-g0)>=10)||(g??Infinity)<80))break;
  }
  return {step:cur.step,done:cur.done,rows};
}

async function main(argv) {
  const [cmd='status',a,...rest]=argv,id=await episodeId(),out=x=>console.log(JSON.stringify(x,null,cmd==='observe'||cmd==='specs'?2:0));
  if(cmd==='status'){const c=await current(id);return out({step:c.step,done:c.done,...compact(c.observation)});}
  if(cmd==='observe'){const c=await current(id);return out({step:c.step,done:c.done,observation:c.observation});}
  if(cmd==='specs')return out((await current(id)).observation.action_specs);
  if(cmd==='step') {
    if(!a)throw new Error(`usage: sim step '{"type":"WAIT"}' [rationale]`);
    const r=await step(id,JSON.parse(a),rest.join(' '));
    return out({step:r.info.step,done:r.terminated||r.truncated,action_result:r.info.action_result,stop_reason:r.info.stop_reason,...compact(r.observation)});
  }
  if(cmd==='wait') {
    const n=Number(a??1);if(!Number.isInteger(n)||n<1||n>288)throw new Error('usage: sim wait [1..288] [rationale]');
    return out(await waitSteps(id,n,rest.join(' ')));
  }
  throw new Error('usage: sim status | observe | specs | step \'<json action>\' [rationale] | wait [N] [rationale]');
}

// realpath: /usr/local/bin/sim and tmp dirs may be symlinks.
const isMain=()=>{try{return fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url));}catch{return false;}};
if(process.argv[1]&&isMain())
  main(process.argv.slice(2)).catch(e=>{console.error(`sim: ${e.message}`);process.exit(1);});
