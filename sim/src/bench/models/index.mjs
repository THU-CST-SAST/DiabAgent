// Model adapters for the LLM bench (docs/BENCH.zh-CN.md §3.4).
// createModel(configOrPath) -> {name, adapter, config, complete({system, messages, tools, obs}) ->
//   {tool_call:{id,name,input}|null, text, usage:{input_tokens,output_tokens}, latency_ms, raw}}
// Model configs live in bench/models/<name>.json; API keys come only from environment variables.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAnthropicModel} from './anthropic.mjs';
import {createOpenAICompatibleModel} from './openai-compatible.mjs';
import {createScriptedModel} from './scripted.mjs';
import {ModelError} from './http.mjs';

export {ModelError};
export const ADAPTERS={anthropic:createAnthropicModel,'openai-compatible':createOpenAICompatibleModel,scripted:createScriptedModel};
const MODELS_DIR=fileURLToPath(new URL('../../../bench/models/',import.meta.url));

// Fields kept as strings when taken from the environment; all others are JSON-parsed if possible
// (numbers such as max_tokens / temperature, objects such as extra_body).
const STRING_FIELDS=new Set(['name','adapter','model','base_url','wire_api','tool_choice','max_tokens_param','reasoning_effort','policy']);

/**
 * Resolves environment references: every `<field>_env: "VAR"` (except api_key_env, which stays a
 * name and is read only when the request is sent) sets `<field>` from process.env.VAR when that
 * variable is non-empty; otherwise `<field>` keeps its literal value (a default) or stays unset, and
 * the adapter reports the missing variable. Returns a new object; the `_env` keys are kept as provenance.
 * Example: {"adapter":"openai-compatible","base_url_env":"LLM_API_BASE_URL","model_env":"LLM_MODEL",
 *           "api_key_env":"LLM_API_KEY","wire_api":"chat","wire_api_env":"LLM_WIRE_API"}
 */
export function resolveEnvRefs(config,env=process.env) {
  const out={...config},resolved=[];
  for(const [k,v] of Object.entries(config)) {
    if(!k.endsWith('_env')||k==='api_key_env'||typeof v!=='string'||!v)continue;
    const field=k.slice(0,-4),raw=env[v];
    if(raw==null||String(raw).trim()==='')continue;
    let val=String(raw).trim();
    if(!STRING_FIELDS.has(field)){try{val=JSON.parse(val);}catch{}}
    out[field]=val;resolved.push(field);
  }
  if(resolved.length)out.env_resolved=[...new Set([...(config.env_resolved??[]),...resolved])];
  return out;
}

/** Loads a model config: an object, a JSON file path, or a name under bench/models/ (env references resolved). */
export function loadModelConfig(configOrPath) {
  if(configOrPath&&typeof configOrPath==='object')return resolveEnvRefs(configOrPath);
  if(typeof configOrPath!=='string'||!configOrPath)throw new Error('Model config or path required');
  const candidates=[configOrPath,path.join(MODELS_DIR,configOrPath),path.join(MODELS_DIR,`${configOrPath}.json`)];
  const file=candidates.find(f=>fs.existsSync(f)&&fs.statSync(f).isFile());
  if(!file)throw new Error(`Model config not found: ${configOrPath} (looked in ${MODELS_DIR})`);
  const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
  return resolveEnvRefs({name:path.basename(file,'.json'),...cfg});
}

export async function createModel(configOrPath) {
  const config=loadModelConfig(configOrPath);
  const make=ADAPTERS[config.adapter];
  if(!make)throw new Error(`Unknown model adapter ${config.adapter} (${Object.keys(ADAPTERS).join(', ')})`);
  return make(config);
}

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

/**
 * complete() with exponential backoff on retryable errors (network, 408/409/429/5xx/529).
 * tries: total attempts (default 3); delay = baseDelayMs * 2^attempt (or Retry-After), capped.
 * Throws the last error, with .attempts set.
 */
export async function completeWithRetry(model,request,{tries=3,baseDelayMs=2000,maxDelayMs=60000,onRetry,sleepFn=sleep}={}) {
  let last;
  for(let i=0;i<tries;i++) {
    try {return {...(await model.complete(request)),attempts:i+1};}
    catch(e) {
      last=e;e.attempts=i+1;
      const retryable=e instanceof ModelError?e.retryable:true;
      if(!retryable||i===tries-1)break;
      const delay=Math.min(maxDelayMs,Math.max(baseDelayMs*2**i,e.retryAfterMs??0));
      onRetry?.(e,i+1,delay);
      await sleepFn(delay);
    }
  }
  throw last;
}

/** USD cost from usage and config.price_per_mtok {input, output}. */
export function costUsd(config,usage) {
  const p=config?.price_per_mtok??{};
  return ((usage.input_tokens??0)*(p.input??0)+(usage.output_tokens??0)*(p.output??0))/1e6;
}
