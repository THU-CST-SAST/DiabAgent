// Shared command-line helpers of scripts/benchmark.mjs and scripts/harbor-local.mjs.
import {runJob,defaultParallel} from './runner.mjs';
import {markdown} from './summarize.mjs';
import {agentOptionsFromFlags} from '../bench/agent-options.mjs';

export function parseArgs(argv) {
  const opt={_:[]};
  for(let i=0;i<argv.length;i++) {
    if(!argv[i].startsWith('--')){opt._.push(argv[i]);continue;}
    const k=argv[i].slice(2);opt[k]=argv[i+1]===undefined||argv[i+1].startsWith('--')?'true':argv[++i];
  }
  return opt;
}
/** Simulation data (bundle.json.gz + journal) is kept unless --no-keep-sim-data (--keep-sim-data is the default). */
export const keepSimData=opt=>opt['no-keep-sim-data']!=='true';
export const list=v=>v&&v!=='true'?v.split(',').map(s=>s.trim()).filter(Boolean):null;
const num=(v,name)=>{if(v==null)return null;const n=Number(v);if(!Number.isFinite(n)||n<0)throw new Error(`--${name} must be a non-negative number`);return n;};

/**
 * Failure-handling options of `run` (docs/BENCH.zh-CN.md §8.11): --max-attempts N (3),
 * --retry-failed (default) / --no-retry-failed, --max-concurrent-llm N, --budget-usd X,
 * --include-failed, --retry-backoff-ms MS (30000), --api-tries N / --api-base-delay-ms MS (LLM agent).
 */
export function failureOptions(opt) {
  const maxAttempts=num(opt['max-attempts'],'max-attempts')??3;
  if(maxAttempts<1||!Number.isInteger(maxAttempts))throw new Error('--max-attempts must be an integer >= 1');
  const mcl=num(opt['max-concurrent-llm'],'max-concurrent-llm');
  if(mcl!=null&&(mcl<1||!Number.isInteger(mcl)))throw new Error('--max-concurrent-llm must be an integer >= 1');
  return {maxAttempts,retryFailed:opt['no-retry-failed']!=='true'&&opt['retry-failed']!=='false',maxConcurrentLlm:mcl,
    budgetUsd:num(opt['budget-usd'],'budget-usd'),includeFailed:opt['include-failed']==='true',retryBackoffMs:num(opt['retry-backoff-ms'],'retry-backoff-ms')??30000};
}
/**
 * Runner agent options. LLM/agent options (src/bench/agent-options.mjs) come from --agent-options
 * JSON and/or single flags (--history-hours, --warmup-days, --min-decision-minutes,
 * --max-decisions-per-day, --memory, --memory-mode, --keep-turns, --reasoning-effort, --samples,
 * --simulate, --simulate-calls, --simulate-max-hours); flags override the JSON.
 */
const agentOptions=opt=>({causalFast:opt['causal-fast']==='true',units:opt.units??undefined,maxTurns:opt['max-turns']?Number(opt['max-turns']):undefined,
  apiTries:opt['api-tries']?Number(opt['api-tries']):undefined,apiBaseDelayMs:opt['api-base-delay-ms']!=null?Number(opt['api-base-delay-ms']):undefined,
  agentOptions:agentOptionsFromFlags(opt)??undefined});
export {agentOptions};

/** One progress line per trial event. */
export function progressLine(t,p) {
  if(p.retry_in_ms!=null)return `[${p.done}/${p.total}] ${t.trial_id} ${t.status}${t.failure?` (${t.failure.reason})`:''} attempt ${t.attempt}: retrying in ${(p.retry_in_ms/1000).toFixed(0)} s${t.error||t.failure?.last_error?` ${String(t.error??t.failure.last_error).slice(0,200)}`:''}`;
  if(p.cached)return `[${p.done}/${p.total}] ${t?.trial_id??''} ${t?.status??''} (${p.why?`kept: ${p.why}`:'cached'})`;
  if(t.status==='not_started')return `[${p.done}/${p.total}] ${t.trial_id} not_started (${t.not_started?.reason}): ${String(t.not_started?.detail??'').slice(0,200)}`;
  const why=t.failure?` (${t.failure.reason}${t.failure.exit_code!=null?`, exit ${t.failure.exit_code}`:''})`:t.not_started?` (${t.not_started.reason})`:'';
  return `[${p.done}/${p.total}] ${t.trial_id} ${t.status}${why}${t.attempt>1?` attempt ${t.attempt}`:''} reward=${t.reward?.reward?.toFixed?.(4)??'-'}${t.scored_with_fill?' (WAIT-filled, excluded)':''} ${t.seconds??''}s${t.error||t.failure?.last_error?` ${String(t.error??t.failure.last_error).split('\n')[0].slice(0,200)}`:''}`;
}

/** `run --benchmark DIR ...` (see scripts/benchmark.mjs). */
export async function runCommand(opt) {
  if(!opt.benchmark)throw new Error('--benchmark DIR required');
  const t0=performance.now();
  const r=await runJob({benchmarkDir:opt.benchmark,jobsDir:opt['jobs-dir']??null,jobId:opt['job-id']??null,
    agents:list(opt.agents),experiments:list(opt.experiments),repeats:opt.repeats?Number(opt.repeats):null,modelDraws:opt['model-draws']?Number(opt['model-draws']):1,
    parallel:opt.parallel?Number(opt.parallel):defaultParallel(),fresh:opt.fresh==='true',keepSimData:keepSimData(opt),
    agentOptions:agentOptions(opt),...failureOptions(opt),onTrial:(t,p)=>console.error(progressLine(t,p))});
  console.log(markdown(r.result));
  const T=r.result.trials;
  console.error(JSON.stringify({job_dir:r.job_dir,ran:r.ran,skipped:r.skipped,errors:r.errors.length,incomplete:r.incomplete,
    trials:{planned:T.planned,done:T.done,agent_failed:T.agent_failed,infra_failed:T.infra_failed,not_started:T.not_started,failure_reasons:T.failure_reasons},
    kept_failed:r.kept_failed.length,budget_stopped:r.budget_stopped,spent_usd:r.spent_usd,wall_seconds:Number(((performance.now()-t0)/1000).toFixed(1))}));
  // Exit 1 when the job is not complete (failed or not started trials remain); rerun the same command to retry.
  if(r.incomplete)process.exitCode=1;
  return r;
}

