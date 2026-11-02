// Agents of the local Harbor runner (docs/BENCH.zh-CN.md §8.5). Every agent runs as its own
// process and reaches the task only through the task's `sim` client (environment/cli/sim.mjs,
// i.e. the simulator's HTTP API) plus the task's public facts (environment/public.json). Like the
// Harbor agent image, the runner copies just these two files into <trial>/agent/app/ (and the
// solution/ dir for the oracle); the agent gets no path into the task directory, no admin token
// and no instance config.
//
//   wait | patient | oref0     code policies (src/policies) on the observations fetched over HTTP
//   causal                     causal-optimal decider (src/oracle/causal.mjs makeCausalAgent) built
//                              from public.json; options: fast (fewer particles / shorter lookahead)
//   oracle                     the task's own solution/solve.sh
//   llm:<model config>         LLM through src/bench model adapters and prompts (bench/models/x.json);
//                              the API key env var named by the config is passed through
//   cmd:<file.mjs>             any external agent script run with node and the same environment
//                              (SWEET_SIM_URL, SWEET_SIM_CLI, SWEET_SIM_PUBLIC, AGENT_LOGS_DIR, and
//                              SWEET_SIM_AGENT_OPTIONS = the agent options JSON when given)
// Agent options (src/bench/agent-options.mjs; options.agentOptions) go to agent-main as
// --agent-options JSON (llm: all options; policy agents: decision gating).
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadModelConfig} from '../bench/models/index.mjs';

export const AGENT_MAIN=fileURLToPath(new URL('./agent-main.mjs',import.meta.url));
export const POLICY_AGENTS=['wait','patient','oref0','causal','standard','guideline','hcl','oref1'];   // + classical care baselines B1-B4

/** Parses an agent name: {kind, name, slug, arg}. */
export function parseAgent(name) {
  if(POLICY_AGENTS.includes(name))return {kind:'policy',name,slug:name,arg:null};
  if(name==='oracle')return {kind:'oracle',name,slug:'oracle',arg:null};
  const m=/^(llm|cmd):(.+)$/.exec(name);
  if(m) {
    const base=path.basename(m[2]).replace(/\.(json|mjs|js)$/,'');
    return {kind:m[1],name,slug:`${m[1]}-${base}`.toLowerCase().replace(/[^a-z0-9._-]+/g,'-'),arg:m[2]};
  }
  throw new Error(`unknown agent ${name} (wait, patient, oref0, causal, oracle, llm:<bench/models/x.json>, cmd:<file.mjs>)`);
}

/**
 * Whether an agent may run on a track; returns null or the refusal reason. The scripted patient
 * policy is not defined on the assisted track: the person already boluses announced meals.
 */
export function refusal(agent,track) {
  return parseAgent(agent).name==='patient'&&track==='assisted'
    ?'patient baseline is not defined on the assisted track (it would bolus the announced meals twice)':null;
}

/** Env var names an LLM agent needs (API key), from its model config. */
export function llmKeyEnv(configPath) {
  const cfg=loadModelConfig(configPath);
  if(cfg.adapter==='anthropic')return [cfg.api_key_env??'ANTHROPIC_API_KEY'];
  if(cfg.adapter==='openai-compatible')return cfg.api_key_env===null?[]:[cfg.api_key_env??'OPENAI_API_KEY'];
  return [];
}

/**
 * Short fingerprint of the API key(s) an llm agent would get now (sha256 prefix of the values; 'none'
 * when a key is unset; null for agents without keys). Recorded with auth failures so that a resumed
 * job retries them only after the key changed. The key itself is never written anywhere.
 */
export function keyFingerprint(agent) {
  const a=parseAgent(agent);if(a.kind!=='llm')return null;
  let names;try{names=llmKeyEnv(a.arg);}catch{return null;}
  if(!names.length)return null;
  const vals=names.map(k=>process.env[k]);
  if(vals.some(v=>!v))return 'none';
  return crypto.createHash('sha256').update(vals.join('\0')).digest('hex').slice(0,12);
}

/**
 * Agent-visible copy of a task (what the Harbor agent image contains): <agentDir>/app/{sim.mjs,
 * public.json} and, for the oracle, <agentDir>/app/solution/. Returns the app dir.
 */
export function prepareAgentApp(taskDir,agentDir,agent) {
  const app=path.join(agentDir,'app');fs.mkdirSync(app,{recursive:true});
  fs.copyFileSync(path.join(taskDir,'environment','cli','sim.mjs'),path.join(app,'sim.mjs'));
  fs.copyFileSync(path.join(taskDir,'environment','public.json'),path.join(app,'public.json'));
  if(parseAgent(agent).kind==='oracle')fs.cpSync(path.join(taskDir,'solution'),path.join(app,'solution'),{recursive:true});
  return app;
}

/**
 * Process spec of an agent for one trial: {command, args, env (additions), cwd}. `ctx`: {appDir
 * (prepareAgentApp), agentDir, simUrl, options:{causalFast, units, maxTurns, apiTries, apiBaseDelayMs, agentOptions}, agentMain (frozen copy of
 * agent-main.mjs; default the working tree)}. The environment is
 * built from scratch by the runner (PATH and HOME only); nothing else from the parent leaks in.
 */
export function agentProcess(agent,{appDir,agentDir,simUrl,options={},agentMain=AGENT_MAIN}) {
  const a=parseAgent(agent);
  const env={SWEET_SIM_URL:simUrl,SWEET_SIM_CLI:path.join(appDir,'sim.mjs'),
    SWEET_SIM_PUBLIC:path.join(appDir,'public.json'),AGENT_LOGS_DIR:agentDir,SWEET_SIM_WAIT_MS:'30000'};
  if(a.kind==='oracle')return {command:'bash',args:[path.join(appDir,'solution','solve.sh')],env,cwd:agentDir};
  const aoJson=options.agentOptions&&Object.keys(options.agentOptions).length?JSON.stringify(options.agentOptions):null;
  if(a.kind==='cmd') {
    const file=path.resolve(a.arg);if(!fs.existsSync(file))throw new Error(`agent script not found: ${file}`);
    if(aoJson)env.SWEET_SIM_AGENT_OPTIONS=aoJson;
    return {command:process.execPath,args:[file],env,cwd:agentDir};
  }
  const args=[agentMain,'--agent',a.kind==='llm'?'llm':a.name];
  if(aoJson)args.push('--agent-options',aoJson);
  if(a.name==='causal'&&options.causalFast)args.push('--fast');
  if(a.kind==='llm') {
    const cfg=loadModelConfig(a.arg);
    const cfgFile=path.join(agentDir,'model.json');
    fs.writeFileSync(cfgFile,JSON.stringify(cfg,null,1));                   // config only; keys stay in env vars
    args.push('--model',cfgFile);
    if(options.units)args.push('--units',options.units);
    if(options.maxTurns)args.push('--max-turns',String(options.maxTurns));
    if(options.apiTries)args.push('--api-tries',String(options.apiTries));
    if(options.apiBaseDelayMs!=null)args.push('--api-base-delay-ms',String(options.apiBaseDelayMs));
    for(const k of llmKeyEnv(cfg))if(process.env[k]!==undefined)env[k]=process.env[k];
    // Explicit network settings only; keep unrelated credentials and simulator secrets isolated.
    for(const k of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NODE_USE_ENV_PROXY','NODE_EXTRA_CA_CERTS'])
      if(process.env[k]!==undefined)env[k]=process.env[k];
    if(env.NODE_USE_ENV_PROXY==='1') {
      const bypass=[process.env.NO_PROXY,process.env.no_proxy,'127.0.0.1,localhost,::1'].filter(Boolean).join(',');
      env.NO_PROXY=bypass;env.no_proxy=bypass;
    }
  }
  return {command:process.execPath,args,env,cwd:agentDir};
}
