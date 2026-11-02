// Entry point of the `sim` sidecar in an exported Harbor task: serves src/env/http.mjs with
// an admin token (episode creation and evaluator export/summary need it; observe/step do not)
// and creates the task's single episode from the shipped instance config on first start.
// A restart recovers the episode from the journal in DATA_DIR instead of creating a new one.
//
// Scoring endpoint (admin token): POST /harbor/score {scoring (tests/scoring.json), agent_completed,
// agent_steps, verifier_wait_steps} -> {reward, metrics, run}: the task's verifier (verify.mjs) gets
// reward.json / metrics.json / run.json from here, scored with the bench code in this snapshot
// (score.mjs verifierReport over src/bench/score.mjs; run record by src/viz/run.mjs). So the verifier
// carries no code snapshot of its own, and the reward comes from the same code that ran the episode.
//
// Repeats (docs/BENCH.zh-CN.md §5.4): SWEET_SIM_REPEAT=r (default 0) rebuilds the config from
// instance.build_spec with episode seed = build_spec.seed + r; person.seed stays (the same person on
// another day). r = 0 uses the shipped config unchanged. Only the orchestrator sets this variable.
//
// Env: INSTANCE_FILE (JSON with .config, .build_spec), SWEET_SIM_ADMIN_TOKEN (required; or
//      SWEET_SIM_ADMIN_TOKEN_STDIN=1: the token is the first line of stdin, so it never appears in the
//      process environment, which same-user processes can read with `ps -E`; the local runner uses
//      this), PORT (8765), HOST (0.0.0.0), DATA_DIR (/var/lib/sweet-sim), SWEET_SIM_REPEAT (0).
import fs from 'node:fs';
import {timingSafeEqual} from 'node:crypto';
import {createServer} from '../../env/http.mjs';
import {buildInstanceConfig} from '../../sim/instance.mjs';
import * as S from '../../bench/score.mjs';
import {runFromBundle} from '../../viz/run.mjs';
import {verifierReport} from './score.mjs';

const port=Number(process.env.PORT||8765),host=process.env.HOST||'0.0.0.0';
const readStdinLine=async()=>{let s='';for await(const c of process.stdin){s+=c;if(s.includes('\n'))break;}return s.split('\n')[0].trim();};
const token=process.env.SWEET_SIM_ADMIN_TOKEN||(process.env.SWEET_SIM_ADMIN_TOKEN_STDIN==='1'?await readStdinLine():'');
if(!token)throw new Error('SWEET_SIM_ADMIN_TOKEN (or SWEET_SIM_ADMIN_TOKEN_STDIN=1 with the token on stdin) is required');
const instance=JSON.parse(fs.readFileSync(process.env.INSTANCE_FILE||'/opt/sweet-sim-instance/instance.json','utf8'));
const repeat=Number(process.env.SWEET_SIM_REPEAT||0);
if(!Number.isInteger(repeat)||repeat<0)throw new Error('SWEET_SIM_REPEAT must be a non-negative integer');
let config=instance.config;
if(repeat>0) {
  if(!instance.build_spec)throw new Error('instance.json has no build_spec; re-export the task to use repeats');
  config=buildInstanceConfig({...instance.build_spec,seed:(instance.build_spec.seed??0)+repeat});
}

const server=createServer({dataDir:process.env.DATA_DIR||'/var/lib/sweet-sim',adminToken:token,maxEpisodes:1});
const self=()=>`http://127.0.0.1:${server.address().port}`;
const auth={Authorization:`Bearer ${token}`};
const isAdmin=req=>{const a=Buffer.from(req.headers.authorization??''),b=Buffer.from(auth.Authorization);return a.length===b.length&&timingSafeEqual(a,b);};

/** POST /harbor/score: the evaluator export of the single episode (over this server's own API), scored. */
async function scoreRoute(req,res) {
  const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  try {
    if(req.method!=='POST'||new URL(req.url,'http://localhost').pathname!=='/harbor/score')return send(404,{error:'Unknown route'});
    if(!isAdmin(req))return send(403,{error:'Scoring is restricted on this server'});
    let text='';for await(const chunk of req){text+=chunk;if(text.length>1000000)throw new Error('Request too large');}
    const body=JSON.parse(text||'{}'),get=async p=>{const r=await fetch(self()+p,{headers:auth});if(!r.ok)throw new Error(`GET ${p}: ${r.status} ${await r.text()}`);return r.json();};
    const {episodes}=await get('/episodes');
    if(episodes.length!==1)throw new Error(`expected exactly one episode, found ${episodes.length}`);
    const bundle=await get(`/episodes/${episodes[0]}/export`),scoring=body.scoring??{};
    const {reward,metrics}=verifierReport(bundle,S,scoring,{episode_id:episodes[0],agent_completed:body.agent_completed??null,
      agent_steps:body.agent_steps??null,verifier_wait_steps:body.verifier_wait_steps??null});
    send(200,{reward,metrics,run:runFromBundle(bundle,{id:scoring.task_id??'episode'})});
  } catch(e){send(400,{error:e.message});}
}
const [simRoutes]=server.listeners('request');
server.removeAllListeners('request');
server.on('request',(req,res)=>req.url.startsWith('/harbor/')?scoreRoute(req,res):simRoutes(req,res));

await new Promise(r=>server.listen(port,host,r));
const {episodes}=await (await fetch(self()+'/episodes')).json();
if(!episodes.length) {
  const r=await fetch(self()+'/episodes',{method:'POST',headers:{'Content-Type':'application/json',...auth},body:JSON.stringify(config)});
  if(!r.ok)throw new Error(`episode creation failed: ${await r.text()}`);
}
console.log(`sweet-sim sidecar ${instance.id??''} on ${host}:${server.address().port} (simulation only, repeat ${repeat})`);
