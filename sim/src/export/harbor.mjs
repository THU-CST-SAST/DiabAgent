// Optional export: sweet-sim instances as Harbor tasks (harborframework.com, Terminal-Bench 2.0
// task format). One task = one instance spec played for a fixed horizon by an agent.
//
//   <task>/task.toml                 Harbor config (schema_version 1.4) + provenance metadata
//   <task>/instruction.md            English task text: the task description every agent interface
//                                    shares (src/bench/prompt.mjs taskDescription, also the LLM
//                                    harness system prompt) + the `sim` command line + scoring
//   <task>/environment/Dockerfile    agent container `main`: node:24-slim + the `sim` CLI only
//   <task>/environment/docker-compose.yaml   adds the `sim` sidecar (no shared volumes)
//   <task>/environment/sim/          sidecar image: pinned sweet-sim snapshot (simulator + scoring
//                                    endpoint) + instance.json
//   <task>/environment/public.json   public information for agents (no hidden state), /app/public.json
//   <task>/tests/                    verifier (test.sh, verify.mjs, sim CLI module, scoring.json; no code
//                                    snapshot): finish horizon with WAIT, score via the sidecar,
//                                    reward.json, metrics.json, run.json, bundle.json.gz
//   <task>/solution/solve.sh         oracle: the causal-optimal decider (src/oracle/causal.mjs, full
//                                    settings) from public.json over the sim HTTP API; its reward is
//                                    the task's references.causal. ORACLE_POLICY switches to baselines.
//   <task>/solution/lib/             code snapshot for the oracle (agent container; no simulator data)
//
// Hidden state (instance config, scenario, true glucose, evaluator export) lives only in the
// sidecar; evaluator routes need a per-task admin token that only the verifier receives
// ([verifier.env]). Field names follow harbor-framework/harbor src/harbor/models/task/config.py
// and examples/tasks (checked 2026-10-14); see docs/ARCHITECTURE.zh-CN.md "可选导出：Harbor".
// Reward and [metadata] follow docs/BENCH.zh-CN.md §8 (sweet-sim.benchmark/v1).
//
// Copies: each task carries the sidecar snapshot (environment/sim/app, Docker build context) and the
// oracle snapshot (solution/lib, uploaded into the agent container) so it builds and runs on any
// Harbor backend without a registry. Within one export (a dataset, a benchmark build) every snapshot
// file is written once and hard-linked into the other tasks (falls back to copying), so a 400-task
// set stores one copy on disk (and in tar archives).
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire,builtinModules} from 'node:module';
import {buildInstanceConfig} from '../sim/instance.mjs';
import {SimEnv} from '../env/pomdp.mjs';
import * as BenchScore from '../bench/score.mjs';
import {trackSpec} from '../bench/tracks.mjs';
import {taskDescription,publicPromptConfig,careContext} from '../bench/prompt.mjs';
import {publicDescription} from '../oracle/belief.mjs';
import {scoreBundle,SCORING_VERSION,VERIFIERS,olsSlope} from './harbor/score.mjs';

export {SCORING_VERSION,VERIFIERS,olsSlope};
export const DEFAULT_WEIGHTS=BenchScore.DEFAULT_WEIGHTS;
/** Reward of an evaluator bundle exactly as the exported verifier computes it (see harbor/score.mjs). */
export const scoreHarborBundle=(bundle,opts={})=>scoreBundle(bundle,BenchScore,opts);
export const SIM_PORT=8765;
export const PUBLIC_FORMAT='sweet-sim.public/v1';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const HERE=fileURLToPath(new URL('./harbor/',import.meta.url));
const KNOWLEDGE_FILES=['sources.json','insulins.json','devices.json','sensors.json','persons.json','instances.json'];
// Data every snapshot carries. The only third-party code is what vendor/oref0 require()s from
// node_modules (lodash/endsWith and its internals); cjsClosure() copies exactly those files, so the
// images build offline without npm install.
// knowledge/persons/reconstructed (real-volunteer reconstructions) is deliberately excluded.
const DATA_PATHS=['package.json','LICENSE','model','vendor/oref0','vendor/deichmann2023/LICENSE','vendor/deichmann2023/PROVENANCE.md',
  ...KNOWLEDGE_FILES.map(f=>`knowledge/${f}`)];
// The sidecar: the simulator runtime and sim-entry.mjs with its static import closure (the scoring
// endpoint: src/bench/score.mjs, src/viz/run.mjs).
const SIM_PATHS=['src/knowledge.mjs','src/env','src/sim','src/core','src/policies'];
const SIM_ROOTS=['src/export/harbor/sim-entry.mjs'];
// The oracle (solution/lib): the causal decider and the baselines ORACLE_POLICY switches back to.
const ORACLE_ROOTS=['src/oracle/causal.mjs','src/policies/oref0.mjs','src/policies/patient.mjs'];
// Copied verbatim into every task (CLI, verifier, oracle) or generating its text (instruction.md):
// hashed with the snapshots so that a change to any of them marks built tasks as stale.
const TASK_CODE=['src/export/harbor.mjs','src/bench/prompt.mjs',...['cli.mjs','verify.mjs','oracle.mjs'].map(f=>`src/export/harbor/${f}`)];

function listFiles(rel) {
  const abs=path.join(ROOT,rel);
  if(!fs.existsSync(abs))return [];
  if(fs.statSync(abs).isFile())return [rel];
  return fs.readdirSync(abs).sort().flatMap(n=>n.startsWith('.')?[]:listFiles(path.join(rel,n)));
}

/** Repo-relative files reachable by require() from the given .js files (plus package.json/LICENSE of node_modules packages). */
function cjsClosure(rels) {
  const seen=new Set(),todo=rels.filter(f=>f.endsWith('.js')).map(f=>path.join(ROOT,f)),builtin=new Set(builtinModules);
  while(todo.length) {
    const file=todo.pop();if(seen.has(file))continue;seen.add(file);
    const req=createRequire(file);
    for(const [,spec] of fs.readFileSync(file,'utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if(builtin.has(spec)||spec.startsWith('node:'))continue;
      const dep=req.resolve(spec);
      if(path.relative(ROOT,dep).startsWith('..')||path.isAbsolute(path.relative(ROOT,dep)))
        throw new Error(`Cannot freeze dependency ${spec}: it resolves outside the sweet-sim package. Install dependencies locally instead of using an external node_modules symlink.`);
      if(dep.endsWith('.js'))todo.push(dep);
      const m=path.relative(ROOT,dep).match(/^(node_modules\/(?:@[^/]+\/)?[^/]+)\//);
      if(m)for(const extra of ['package.json','LICENSE'])if(fs.existsSync(path.join(ROOT,m[1],extra)))seen.add(path.join(ROOT,m[1],extra));
    }
  }
  return [...seen].map(f=>path.relative(ROOT,f)).filter(f=>!f.startsWith('..'));
}

/** Repo-relative .mjs/.js files reachable by static relative ESM imports from the given files. */
function esmClosure(rels) {
  const seen=new Set(),todo=rels.map(f=>path.join(ROOT,f));
  while(todo.length) {
    const file=todo.pop();if(seen.has(file)||!fs.existsSync(file))continue;seen.add(file);
    const text=fs.readFileSync(file,'utf8');
    for(const m of text.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|(?:^|[\s;])import\s*['"](\.{1,2}\/[^'"]+)['"]/gm))
      todo.push(path.resolve(path.dirname(file),m[1]??m[2]));
  }
  return [...seen].map(f=>path.relative(ROOT,f)).filter(f=>!f.startsWith('..'));
}
function git(args) {
  try{return execFileSync('git',args,{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return null;}
}

/** The given files plus their require() closure, sorted and unique. */
const closed=rels=>[...new Set([...rels,...cjsClosure(rels)])].sort();

/**
 * Files, content hash and git provenance of the sweet-sim code frozen into every task: the sidecar
 * snapshot (`files`: simulator + scoring endpoint, environment/sim/app) and the oracle's
 * (`solution_files`, solution/lib). sha256 covers both plus TASK_CODE (the CLI, verifier and oracle
 * scripts every task gets, and the instruction.md generator).
 */
export function snapshotInfo() {
  const data=DATA_PATHS.flatMap(listFiles);
  const files=closed([...data,...SIM_PATHS.flatMap(listFiles),...esmClosure(SIM_ROOTS)]);
  const solutionFiles=closed([...data,...esmClosure(ORACLE_ROOTS)]);
  const all=[...new Set([...files,...solutionFiles,...TASK_CODE])].sort(),h=createHash('sha256');
  for(const f of all){h.update(f+'\0');h.update(fs.readFileSync(path.join(ROOT,f)));h.update('\0');}
  const commit=git(['rev-parse','HEAD']),status=commit===null?null:git(['status','--porcelain','--',...DATA_PATHS,...SIM_PATHS,...all]);
  return {files,solution_files:solutionFiles,sha256:h.digest('hex'),git_commit:commit,git_dirty:status===null?null:status.length>0};
}

/**
 * Copies a frozen code snapshot rooted at the given repo-relative ES modules (their static import
 * closure, the require() closure of vendored CommonJS, knowledge/model data and package.json) into
 * dest; returns {files, sha256}. Used by the local runner to freeze agent code for a job.
 */
export function freezeCode(roots,dest) {
  const data=DATA_PATHS.flatMap(listFiles);
  const code=esmClosure(roots),packageMeta=new Set();
  for(const file of code) {
    const prefix=file.match(/^(node_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1];
    if(prefix)for(const name of ['package.json','LICENSE'])if(fs.existsSync(path.join(ROOT,prefix,name)))packageMeta.add(path.join(prefix,name));
  }
  const files=[...new Set([...data,...code,...packageMeta,...cjsClosure([...data,...code])])].sort();
  const h=createHash('sha256');
  for(const f of files){h.update(f+'\0');h.update(fs.readFileSync(path.join(ROOT,f)));h.update('\0');}
  copyInto(dest,files);
  return {files,sha256:h.digest('hex')};
}

/**
 * Copies repo-relative files/dirs into dest. With `links` (a Map shared by one export, see
 * snapshotLinks) a file already written by this export is hard-linked instead of copied when the
 * earlier copy is unchanged (same size and mtime); otherwise, or when linking fails (other file
 * system, no permission), it is copied. Snapshot files are frozen: edit the source and re-export,
 * never a task's copy (an in-place edit would show in every linked task).
 */
function copyInto(dest,rels,links=null) {
  for(const rel of rels)for(const f of listFiles(rel)) {
    const to=path.join(dest,f);fs.mkdirSync(path.dirname(to),{recursive:true});
    const prev=links?.get(f);
    if(prev)try {
      const st=fs.statSync(prev.path);
      if(st.size===prev.size&&st.mtimeMs===prev.mtimeMs){fs.linkSync(prev.path,to);continue;}
    } catch {}
    fs.copyFileSync(path.join(ROOT,f),to);
    if(links){const st=fs.statSync(to);links.set(f,{path:to,size:st.size,mtimeMs:st.mtimeMs});}
  }
}
// One link table per snapshot object (all tasks of an export share the snapshot; a fresh
// snapshotInfo() starts a new table).
const LINKS=new WeakMap();
function snapshotLinks(snap) {
  if(!LINKS.has(snap))LINKS.set(snap,new Map());
  return LINKS.get(snap);
}

// --- minimal TOML writer (strings, numbers, booleans, arrays of scalars, nested tables) ---
const tomlKey=k=>/^[A-Za-z0-9_-]+$/.test(k)?k:JSON.stringify(k);
function tomlValue(v) {
  if(typeof v==='string')return JSON.stringify(v);
  if(typeof v==='number'){if(!Number.isFinite(v))throw new Error('TOML: non-finite number');return String(v);}
  if(typeof v==='boolean')return String(v);
  if(Array.isArray(v))return `[${v.map(tomlValue).join(', ')}]`;
  throw new Error(`TOML: unsupported value ${JSON.stringify(v)}`);
}
const isTable=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function tomlTable(name,obj,out) {
  const scalars=Object.entries(obj).filter(([,v])=>!isTable(v)&&v!==null&&v!==undefined);
  out.push(`[${name}]`,...scalars.map(([k,v])=>`${tomlKey(k)} = ${tomlValue(v)}`),'');
  for(const [k,v] of Object.entries(obj))if(isTable(v))tomlTable(`${name}.${tomlKey(k)}`,v,out);
}
const float=x=>Number.isInteger(x)?`${x}.0`:String(x);

function taskToml({name,description,keywords,metadata,agentTimeoutSec,verifierTimeoutSec,token}) {
  const out=['# Harbor task config (schema per harbor-framework/harbor src/harbor/models/task/config.py).',
    '# Generated by sweet-sim scripts/export-harbor.mjs. Simulation only; not medical advice.','schema_version = "1.4"',''];
  tomlTable('task',{name,description,keywords},out);
  tomlTable('metadata',metadata,out);
  out.push('[verifier]',`timeout_sec = ${float(verifierTimeoutSec)}`,'',
    '[verifier.env]','# Lets the verifier read the evaluator export from the sim sidecar; never given to the agent.',
    `SWEET_SIM_ADMIN_TOKEN = ${tomlValue(token)}`,'',
    '[agent]',`timeout_sec = ${float(agentTimeoutSec)}`,'',
    '[environment]','build_timeout_sec = 900.0','cpus = 1','memory_mb = 2048','storage_mb = 10240','gpus = 0',
    '# No internet (older Harbor: allow_internet = false). main and sim still talk over the compose network.',
    'network_mode = "no-network"','mcp_servers = []','','[solution.env]',
    '# Oracle policy: causal (default; reproduces metadata.references.causal) | causal-fast | oref0 | patient | baseline.',
    '# ORACLE_POLICY = "causal"','');
  return out.join('\n');
}

/** The "You see" line of instruction.md: what `sim` shows (the shared description has the LLM harness's). */
export function cliSeeLine(obs) {
  return `- You see (\`sim observe\`, glucose in mg/dL): the clock, the readings this setup provides (latest value with source and age, trend if available, recent sensor history), insulin on board (IOB) and carbs on board (COB) as estimated by the device app from logged insulin and *reported* carbs, the device state (${obs.device.type==='pump'?'basal/temp basal, last bolus':'last injections'}), the therapy profile, notices since your last step (\`events\`: reported meals, routine readings, alarms) and the result of your last action (\`action_result\`).`;
}

const scoreRule=w=>{
  const terms=[`${w.tir===1?'':`${w.tir} × `}TIR(70–180)`];
  if(w.tbr70)terms.push(`${w.tbr70} × TBR(<70)`);
  if(w.tbr54)terms.push(`${w.tbr54} × TBR(<54)`);
  if(w.tar250)terms.push(`${w.tar250} × TAR(>250)`);
  return `${terms.join(' − ')}`;
};
/**
 * The scoring rule as the agent is told it, for the version the verifier will actually use.
 * bench-v0.2 / v0.3 score time in 70-180 mg/dL with hypoglycaemia and severe-hyperglycaemia
 * penalties and have no CV or rate-of-change term; METRICS-v0.3 scores time in 4-8 mmol/L and adds
 * those two. Printing one formula while the verifier applies the other tells the agent to optimise
 * a target it will not be scored on, which is worse than either version alone.
 */
const scoreFormula=(version,w)=>version==='METRICS-v0.3'
  ?`Score = T(4–8 mmol/L) - ${w.tbr70}*T(2–4) - ${w.tbr54}*T(<2) - ${w.tar250}*T(>12)
- ${w.cv}*max(0,CV-0.36) - ${w.roc}*T(|ROC|>2 mg/dL/min), clipped to [0, 1].`
  :`Score = ${scoreRule(w)}, clipped to [0, 1] (T(.) = fraction of the episode in that range).`;
const sameWeights=w=>Object.keys(DEFAULT_WEIGHTS).every(k=>w[k]===DEFAULT_WEIGHTS[k]);

/**
 * instruction.md: the shared task description (src/bench/prompt.mjs taskDescription, built from
 * public.json and the first observation exactly as the LLM agent builds its system prompt, in
 * mg/dL) followed by how to act through the `sim` command line and how the task is scored.
 */
export function instructionText({pub,obs,hours,weights=DEFAULT_WEIGHTS,verifier='episode',scoringVersion=SCORING_VERSION}) {
  const description=taskDescription({obs,units:'mgdl',config:publicPromptConfig(pub),scanTimes:pub.prompt_context?.scan_times??null,hours,
    weights:sameWeights(weights)?null:weights,seeLine:cliSeeLine(obs),scoring_version:scoringVersion});
  const dt=pub.decision_interval_minutes;
  return `# Manage a virtual person with type 1 diabetes for ${hours} h

**Simulation only: a virtual patient in sweet-sim, not a real person, not medical advice.**

${description.join('\n')}

## How to act: the \`sim\` command line
The simulator is a separate service; you act only through the \`sim\` command in this container
(HTTP to the simulator). There is nothing else to inspect here.
\`\`\`bash
sim status                                   # compact state: time, glucose, trend, IOB, COB, basal, new events
sim observe                                  # full observation JSON (everything you can see)
sim specs                                    # allowed actions and their limits (observation.action_specs)
sim step '{"type":"BOLUS","units":2}' "why"  # apply one action; then ${dt} min of simulated time pass
sim step '{"type":"INGEST_CARBS","grams":15}' "treat low"
sim wait 6 "why"                             # up to 6 WAIT steps; stops early on new events, a glucose
                                             # change of 10 mg/dL or more, or glucose below 80 mg/dL
\`\`\`
- Each step (an action or WAIT) advances simulated time by ${dt} min. A rejected action still advances
  time; check \`action_result\` in the reply.
- The public facts above, plus the kinds of events that may occur (event packs), are in
  \`/app/public.json\` (machine-readable; no hidden state).

## End and scoring
The episode ends at the ${hours} h horizon. If you stop earlier, the remaining time is simulated
with no further treatment (WAIT) before scoring.
${scoreFormula(scoringVersion,weights)}
A severe low (<3 mmol/L for 15 min or more) scores 0 (sweet-sim scoring ${scoringVersion}).${verifier==='daily'?`
Each simulated day is also scored separately with the same rule (day_<k>_reward), and the slope of
the daily scores over the days is reported.`:''}
`;
}

function composeYaml(token) {
  return `# Merged on top of Harbor's base compose config. Harbor configures the agent service \`main\`
# (built from ./Dockerfile). \`sim\` is the simulator sidecar: the agent reaches it only over HTTP
# (port ${SIM_PORT}); no volumes are shared, so instance config, hidden state and evaluator data stay in it.
# No \`expose\`/\`networks\`: with network_mode="no-network" Harbor puts main and sim into its
# egress-control sidecar's network namespace (sim is then at 127.0.0.1:${SIM_PORT}), and Docker
# rejects exposed ports there. Otherwise sim is at http://sim:${SIM_PORT}. The CLI tries both.
services:
  main:
    depends_on:
      sim:
        condition: service_healthy

  sim:
    build:
      context: ./sim
    environment:
      SWEET_SIM_ADMIN_TOKEN: "${token}"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:${SIM_PORT}/health').then(r=>r.json()).then(d=>process.exit(d.episodes>0?0:1),()=>process.exit(1))"]
      interval: 2s
      timeout: 5s
      retries: 30
      start_period: 3s
`;
}

const MAIN_DOCKERFILE=`# Agent container (Harbor service \`main\`): Node 24 + the \`sim\` CLI + public task facts. No simulator code or data.
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \\
    && rm -rf /var/lib/apt/lists/*
COPY cli/sim.mjs /opt/sweet-sim-cli/sim.mjs
RUN printf '#!/bin/sh\\nexec node /opt/sweet-sim-cli/sim.mjs "$@"\\n' > /usr/local/bin/sim && chmod 755 /usr/local/bin/sim
WORKDIR /app
COPY public.json /app/public.json
`;
const MAIN_DOCKERIGNORE='# The sidecar build context must never enter the agent image.\nsim\ndocker-compose.yaml\n';
const SIM_DOCKERFILE=`# Simulator sidecar: pinned sweet-sim snapshot (see task.toml metadata) serving one episode and,
# to the verifier only (admin token), its score. Builds offline: the only third-party files (lodash/endsWith for vendored oref0) are in app/node_modules.
FROM node:24-slim
WORKDIR /opt/sweet-sim
COPY app/ /opt/sweet-sim/
COPY instance.json /opt/sweet-sim-instance/instance.json
RUN mkdir -p /var/lib/sweet-sim && chown node:node /var/lib/sweet-sim
ENV PORT=${SIM_PORT} HOST=0.0.0.0 DATA_DIR=/var/lib/sweet-sim INSTANCE_FILE=/opt/sweet-sim-instance/instance.json
USER node
CMD ["node", "src/export/harbor/sim-entry.mjs"]
`;
const TEST_SH=`#!/bin/bash
# Verifier: finishes the horizon with WAIT if the agent stopped early, has the sim sidecar score the
# episode with the bench code in its snapshot (admin token from [verifier.env]; weights and verifier
# mode in tests/scoring.json) and writes $LOGS_DIR/reward.json (numbers only: reward, tir, tbr70,
# tbr54, tar180, tar250, mean_mgdl, cv, severe_hypo, completed, agent_completed, agent_steps,
# [normalized], [day_<k>_reward, learning_slope]), metrics.json, run.json and bundle.json.gz (the
# evaluator bundle; SWEET_SIM_SAVE_BUNDLE=0 skips it). LOGS_DIR defaults to /logs/verifier (Harbor).
# A failure leaves no reward file, so Harbor reports a verifier error instead of a silent 0.
set -euo pipefail
export LOGS_DIR="\${LOGS_DIR:-/logs/verifier}"
mkdir -p "$LOGS_DIR"
node "$(dirname "$0")/verify.mjs"
`;
const SOLVE_SH=`#!/bin/bash
# Oracle: plays the causal-optimal decider (full settings) from /app/public.json through the
# simulator HTTP API to the horizon, like an agent; its reward is the task's references.causal.
# ORACLE_POLICY=oref0|patient|baseline|causal-fast switches policy (see oracle.mjs). Simulation only.
set -euo pipefail
cd "$(dirname "$0")"
node oracle.mjs
`;

export const slug=s=>String(s).toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'')||'task';
const writeFile=(file,text,mode)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);if(mode)fs.chmodSync(file,mode);};
const tomlSafe=v=>v===null||v===undefined?undefined:Array.isArray(v)?v.filter(x=>x!==null&&x!==undefined).map(x=>typeof x==='object'?JSON.stringify(x):x)
  :typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,tomlSafe(x)]).filter(([,x])=>x!==undefined))
  :typeof v==='number'&&!Number.isFinite(v)?undefined:v;

/**
 * The spec actually simulated by a task: track applied (self_care), horizon set and, for sampled
 * persons, person.seed made explicit (= spec.seed, the default) so repeats (seed + r) keep the person.
 */
export function taskBuildSpec(spec,{track=null,horizonMinutes}) {
  const s={...(track?trackSpec(spec,track):spec),horizon_minutes:horizonMinutes};
  if(s.person&&typeof s.person==='object'&&s.person.seed==null)s.person={...s.person,seed:s.seed??0};
  return s;
}

/**
 * Public information about a task (what the person and their care team know; no hidden state):
 * the causal decider's public description (src/oracle/belief.mjs publicDescription) and the public
 * config fields the LLM prompt uses (person age group/sex, body data, routine times, alarms, safety rules).
 */
export function publicInfo(buildSpec,config,{taskId=null}={}) {
  const world=new SimEnv(config).world,r=config.person?.resolved,p=config.patient??{};
  return {format:PUBLIC_FORMAT,task_id:taskId,simulation_only:true,horizon_minutes:config.horizon_minutes,
    decision_interval_minutes:config.decision_interval_minutes,self_care:config.self_care?.mode??'none',
    ...(careContext(buildSpec.care_context)?{care_context:careContext(buildSpec.care_context)}:{}),
    description:publicDescription(buildSpec),
    prompt_context:{person:r?{resolved:{age_group:r.age_group,sex:r.sex,type:r.type}}:null,
      patient:{sex:p.sex??null,age_years:p.age_years??null,height_cm:p.height_cm??null,weight_kg:p.weight_kg??null},
      meter:{routine_times:[...(config.meter?.routine_times??[])]},alarms:{...(config.alarms??{})},safety:{...(config.safety??{})},
      scan_times:world.cgm?.modality==='flash'?world.scanTimes():null}};
}

/**
 * Exports one instance spec as a Harbor task directory (docs/BENCH.zh-CN.md §8).
 * opts:
 *   outDir (task directory), id (task id; Harbor name sweet-sim/<id>), hours (default spec.horizon_minutes/60 or 24),
 *   track ('full' | 'assisted': sets spec.self_care; null = the spec as given),
 *   verifier ('episode' default | 'daily': adds day_<k>_reward and learning_slope),
 *   weights (partial override of the bench weights {tir, tbr70, tbr54, tar250}),
 *   factors (metadata), metadata (extra [metadata] fields: experiment, instance_id, references
 *   {wait, patient, oref0, causal, omniscient} for this task's episode seed, role, pair_id, ...),
 *   adminToken (default random), agentTimeoutSec (default max(1800, 600 per simulated hour)),
 *   snapshot (snapshotInfo() to reuse; tasks exported with the same snapshot object hard-link its
 *   files, see copyInto), dedupe (default true; false always copies).
 * Returns {dir, name, config, build_spec, metadata}.
 */
export function exportHarborTask(spec,{outDir,id='instance',hours,track=null,verifier='episode',weights={},scoring,factors=null,metadata:extra={},
  adminToken,agentTimeoutSec,snapshot,scoringExtra=null,dedupe=true,scoringVersion=SCORING_VERSION}={}) {
  if(!outDir)throw new Error('outDir required');
  if(scoring!==undefined)throw new Error('exportHarborTask: `scoring` was replaced by `weights` (bench weights {tir, tbr70, tbr54, tar250})');
  if(!VERIFIERS.includes(verifier))throw new Error(`verifier must be one of ${VERIFIERS.join(', ')}`);
  const w={...DEFAULT_WEIGHTS,...weights};
  // scoringExtra (bench v0.3, OpenDiabet v1.1-hard): {surprises: [...] (evaluator-only), certificate: {...}}.
  // A task carrying either is scored bench-v0.3; otherwise it declares the caller's version.
  const sx=scoringExtra&&(Array.isArray(scoringExtra.surprises)||scoringExtra.certificate)?scoringExtra:null;
  // One effective version for every file this task declares it in (task.toml, public.json,
  // instruction.md, tests/scoring.json): a task carrying surprises or a certificate is bench-v0.3.
  const sv=sx?'bench-v0.3':scoringVersion;
  for(const [k,v] of Object.entries(w))if(!(k in DEFAULT_WEIGHTS)||typeof v!=='number'||!Number.isFinite(v))throw new Error(`weights.${k} must be a finite number (keys: ${Object.keys(DEFAULT_WEIGHTS).join(', ')})`);
  const horizon=hours!==undefined&&hours!==null?Math.round(Number(hours)*60):spec.horizon_minutes??1440;
  if(!Number.isFinite(horizon)||horizon<5)throw new Error(`invalid horizon ${hours} h`);
  const buildSpec=taskBuildSpec(spec,{track,horizonMinutes:horizon});
  const config=buildInstanceConfig(buildSpec);
  const env=new SimEnv(config),manifest=env.manifest(),obs=env.observe();
  const snap=snapshot??snapshotInfo(),token=adminToken??randomBytes(24).toString('hex');
  const h=horizon/60,name=`sweet-sim/${slug(id)}`,selfCare=config.self_care?.mode??'none';
  const references=extra.references?Object.fromEntries(Object.entries(extra.references).filter(([,v])=>typeof v==='number'&&Number.isFinite(v))):null;
  const metadata=tomlSafe({category:'simulation',tags:['t1d','glucose','pomdp','sweet-sim','simulation-only'],
    experiment:extra.experiment??null,track:track??(selfCare==='assisted'?'assisted':'full'),
    instance_id:String(extra.instance_id??id),task_id:String(id),
    horizon_minutes:horizon,horizon_hours:h,decision_interval_minutes:config.decision_interval_minutes,
    person_seed:buildSpec.person?.seed??null,episode_seed:config.seed,
    device:obs.device.type,self_care:selfCare,environment_version:manifest.environment_version,
    sweet_sim_commit:snap.git_commit??'unknown',sweet_sim_git_commit:snap.git_commit??'unknown',sweet_sim_git_dirty:snap.git_dirty??true,
    sweet_sim_snapshot_sha256:snap.sha256,knowledge_sha256:manifest.knowledge_sha256,kernel_sha256:manifest.model.kernel_sha256,
    scoring_version:sv,verifier,weights:w,
    ...Object.fromEntries(Object.entries(extra).filter(([k])=>!['experiment','instance_id','references','factors'].includes(k))),
    ...(references&&Object.keys(references).length?{references}:{}),
    ...((factors??extra.factors)?{factors:factors??extra.factors}:{})});
  if(fs.existsSync(outDir)&&fs.readdirSync(outDir).length) {
    if(!fs.existsSync(path.join(outDir,'task.toml')))throw new Error(`${outDir} exists and is not a Harbor task directory; refusing to overwrite`);
    fs.rmSync(outDir,{recursive:true,force:true});
  }

  const description=`Manage a simulated person with type 1 diabetes (${obs.device.type}, ${selfCare==='assisted'?'assisted':'full'} care) for ${h} h in sweet-sim; reward = bench ${sv} score (time in range minus hypoglycaemia penalties, severe-hypo veto).`;
  writeFile(path.join(outDir,'task.toml'),taskToml({name,description,keywords:['t1d','diabetes','simulation','pomdp','sweet-sim'],metadata,
    agentTimeoutSec:agentTimeoutSec??Math.max(1800,Math.round(600*h)),verifierTimeoutSec:Math.max(600,Math.round(60*h)),token}));
  // The agent's view: public.json and the first observation as it arrives over HTTP (JSON).
  const json=x=>JSON.parse(JSON.stringify(x)),pub=json(publicInfo(buildSpec,config,{taskId:String(id)})),obs0=json(obs);
  pub.scoring_version=sv;
  writeFile(path.join(outDir,'instruction.md'),instructionText({pub,obs:obs0,hours:h,weights:w,verifier,scoringVersion:sv}));

  const links=dedupe?snapshotLinks(snap):null;
  const envDir=path.join(outDir,'environment');
  writeFile(path.join(envDir,'Dockerfile'),MAIN_DOCKERFILE);
  writeFile(path.join(envDir,'.dockerignore'),MAIN_DOCKERIGNORE);
  writeFile(path.join(envDir,'docker-compose.yaml'),composeYaml(token));
  writeFile(path.join(envDir,'public.json'),JSON.stringify(pub,null,1)+'\n');
  fs.mkdirSync(path.join(envDir,'cli'),{recursive:true});
  fs.copyFileSync(path.join(HERE,'cli.mjs'),path.join(envDir,'cli','sim.mjs'));
  writeFile(path.join(envDir,'sim','Dockerfile'),SIM_DOCKERFILE);
  copyInto(path.join(envDir,'sim','app'),snap.files,links);
  writeFile(path.join(envDir,'sim','instance.json'),JSON.stringify({id,factors:factors??extra.factors??null,spec,build_spec:buildSpec,config,provenance:{
    sweet_sim_git_commit:metadata.sweet_sim_git_commit,sweet_sim_snapshot_sha256:snap.sha256,knowledge_sha256:metadata.knowledge_sha256,kernel_sha256:metadata.kernel_sha256}},null,2)+'\n');

  const tests=path.join(outDir,'tests');
  writeFile(path.join(tests,'test.sh'),TEST_SH,0o755);
  for(const [from,to] of [['verify.mjs','verify.mjs'],['cli.mjs','sim-client.mjs']])fs.copyFileSync(path.join(HERE,from),path.join(tests,to));
  // scoringExtra (bench v0.3, OpenDiabet v1.1-hard): {surprises: [{id, type, at_minute, ...}] (evaluator-only),
  // certificate: {score, policy, ...}}. The verifier then adds surprise_score / normalized_vs_certificate.
  writeFile(path.join(tests,'scoring.json'),JSON.stringify({scoring_version:sv,weights:w,verifier,task_id:String(id),
    episode_seed:config.seed,references:references&&Object.keys(references).length?references:null,
    ...(sx?{surprises:sx.surprises??[],certificate:sx.certificate??null}:{})},null,2)+'\n');

  const sol=path.join(outDir,'solution');
  writeFile(path.join(sol,'solve.sh'),SOLVE_SH,0o755);
  fs.copyFileSync(path.join(HERE,'oracle.mjs'),path.join(sol,'oracle.mjs'));
  fs.copyFileSync(path.join(HERE,'cli.mjs'),path.join(sol,'sim-client.mjs'));
  copyInto(path.join(sol,'lib'),snap.solution_files,links);
  return {dir:outDir,name,config,build_spec:buildSpec,metadata};
}

/**
 * Exports population instances ({id, factors, spec}, src/population/catalog.mjs format) as one
 * Harbor task per instance under outDir, plus outDir/index.json. Other opts as exportHarborTask.
 */
export function exportHarborDataset(instances,{outDir,...opts}={}) {
  if(!outDir)throw new Error('outDir required');
  const snapshot=opts.snapshot??snapshotInfo(),ids=new Set(),tasks=[];
  for(const x of instances) {
    const dirName=slug(x.id);if(ids.has(dirName))throw new Error(`duplicate instance id ${x.id}`);ids.add(dirName);
    const r=exportHarborTask(x.spec,{...opts,id:x.id,factors:x.factors??null,snapshot,outDir:path.join(outDir,dirName)});
    tasks.push({id:x.id,dir:dirName,name:r.name,factors:x.factors??null,horizon_hours:r.metadata.horizon_hours});
  }
  writeFile(path.join(outDir,'index.json'),JSON.stringify({format:'harbor-task-dirs',generator:'sweet-sim scripts/export-harbor.mjs',
    sweet_sim_git_commit:snapshot.git_commit,sweet_sim_git_dirty:snapshot.git_dirty,sweet_sim_snapshot_sha256:snapshot.sha256,tasks},null,2)+'\n');
  return {dir:outDir,tasks};
}
