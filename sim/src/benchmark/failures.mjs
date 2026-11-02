// Failure classification of the local Harbor runner (docs/BENCH.zh-CN.md §8.11).
//
// Agent side (agent-main.mjs / llm-agent.mjs): classifyError(e) turns an exception into a reason that
// goes into AGENT_LOGS_DIR/status.json {state:'error'|'incomplete', reason, error, error_status}.
// Runner side (runner.mjs): agentFailure(...) combines the agent process result, status.json, the
// LLM transcript and stderr into trial.json `failure` {reason, exit_code, signal, timed_out, last_error, ...}.
//
// Reasons:
//   auth          401/403 or missing API key: fail fast, the trial is not retried until the key changes
//   rate_limit    HTTP 429 after the agent's own API retries          } retried within the run
//   server        HTTP 5xx / 529 / invalid JSON from the API           } (trial-level, with backoff)
//   network       API request failed without an HTTP answer (timeout)  }
//   sim_transport the agent lost the simulator sidecar after retries   }
//   api_error     other 4xx from the API (bad request, context too long)
//   format        3 consecutive invalid replies (no valid act tool call)
//   max_turns     the agent hit --max-turns before the horizon
//   timeout       the agent process exceeded the task's agent timeout (killed)
//   crash         uncaught exception / non-zero exit
//   early_exit    exit code 0 but the agent did not reach the horizon
export const FAILURE_REASONS=['auth','rate_limit','server','network','sim_transport','api_error','tool_contract','format','max_turns','timeout','crash','early_exit'];
/** Reasons worth an immediate trial-level retry (with backoff) inside the same run. */
export const TRANSIENT_REASONS=new Set(['rate_limit','server','network','sim_transport']);
/** Exit code of agent-main when the agent stopped before the horizon without crashing (status.json state 'incomplete'). */
export const EXIT_INCOMPLETE=3;

/** Reason from an error message (also used on logs of agents frozen before reasons existed). */
export function classifyText(text) {
  const s=String(text??'');
  if(/Tool contract violation:/.test(s))return 'tool_contract';
  if(/Missing API key|HTTP 40[13]\b|\b(401|403)\b.*(unauthori[sz]ed|forbidden|invalid.*key|permission)|authentication_error|permission_error|invalid[_ ]api[_ ]key/i.test(s))return 'auth';
  if(/HTTP 429\b|rate[_ ]limit/i.test(s))return 'rate_limit';
  if(/HTTP (5\d\d)\b|overloaded_error|Invalid JSON from/i.test(s))return 'server';
  if(/HTTP 4\d\d\b/.test(s))return 'api_error';
  if(/Request to \S+ failed/.test(s))return 'network';
  if(/fetch failed|ECONNREFUSED|ECONNRESET|UND_ERR_SOCKET|other side closed/i.test(s))return 'sim_transport';
  return null;
}

/** Reason of an exception thrown inside an agent (ModelError from src/bench/models, sim client errors, bugs). */
export function classifyError(e) {
  if(!e)return 'crash';
  if(e.code==='TOOL_CONTRACT')return 'tool_contract';
  if(['auth','rate_limit','server','api_error'].includes(e.failure_reason))return e.failure_reason;
  if(e.name==='ModelError'||e.status!=null&&typeof e.retryable==='boolean') {
    const st=e.status;
    if(/Missing API key/i.test(e.message)||st===401||st===403)return 'auth';
    if(st===429)return 'rate_limit';
    if(st>=500||st===408||st===409)return 'server';
    if(st>=400)return 'api_error';
    if(st==null)return e.retryable?'network':'api_error';
    return 'server';                                     // 2xx with an unusable body
  }
  return classifyText(`${e.message??e} ${e.cause?.code??''} ${e.cause?.message??''}`)??'crash';
}

/** A bad reply belongs to one trial; only proven endpoint incompatibility blocks its model queue. */
export function blocksModelQueue(failure) {
  if(failure?.reason!=='tool_contract')return false;
  if(failure.error_scope==='endpoint')return true;
  if(['trial','request'].includes(failure.error_scope))return false;
  // Old records lack scope. Do not turn an action mistake or conversation error into a global block.
  const text=failure.last_error??'';
  const configError=/Schema cannot be compiled:|extra_body must not (?:change|replace) strict|strict_tool_names must retain act|strict schemas? (?:is |are )?(?:unsupported|not supported)/i.test(text);
  const strictEndpoint=/Strict request rejected:/i.test(text)
    &&/\binvalid_json_schema\b|\bunsupported_json_schema\b|\b(?:unsupported|invalid) (?:json )?schema\b|\bstrict tools? (?:is |are )?(?:unsupported|not supported)\b|\b(?:schema|grammar).*(?:compilation|compile|too large|too complex|capacity)/i.test(text);
  return configError||strictEndpoint;
}

const readJson=f=>{try{return JSON.parse(f);}catch{return null;}};

/** Last API error of an LLM transcript (transcript.jsonl lines with api_error), or null. */
export function lastTranscriptError(text) {
  const lines=String(text??'').trim().split('\n');
  for(let i=lines.length-1;i>=0;i--){const l=readJson(lines[i]);if(l?.api_error)return l.api_error;}
  return null;
}

/**
 * The error of an agent's stderr: the last `XxxError: message` line (uncaught exceptions print a code
 * frame first), else the last meaningful lines (no retry chatter), at most `max` chars.
 */
export function stderrTail(text,max=800) {
  const lines=String(text??'').split('\n').map(l=>l.trimEnd()).filter(l=>l&&!/^agent: retrying /.test(l));
  const err=lines.findLast(l=>/^(agent \S+: )?([A-Z]\w*)?(Error|Exception)\b(\s*\[[^\]]*\])?:/.test(l));
  if(err)return err.slice(0,max);
  let out='';for(let i=lines.length-1;i>=0&&out.length<max;i--)out=lines[i]+(out?'\n'+out:'');
  return out.slice(-max)||null;
}

/**
 * Failure record of an agent that did not reach the horizon. `proc`: {exit_code, signal, timed_out};
 * `status`: parsed status.json (or null); `transcript`/`stderr`: file contents (or null).
 */
export function agentFailure({proc,status,transcript=null,stderr=null}) {
  const statusReason=status&&status.state!=='done'?status.reason:null;
  const known=FAILURE_REASONS.includes(statusReason)?statusReason:statusReason==='format_errors'?'format':null;
  const lastError=String(status?.error??(known||statusReason==null?null:statusReason)??lastTranscriptError(transcript)??stderrTail(stderr)??'')
    .split('\n').slice(0,6).join('\n').slice(0,1000)||null;
  let reason;
  if(proc?.timed_out)reason='timeout';
  else if(known&&known!=='api_error')reason=known;
  else reason=classifyText(lastError)??known??(status?.state==='error'||(proc?.exit_code??0)!==0||proc?.signal?'crash':'early_exit');
  return {reason,exit_code:proc?.exit_code??null,signal:proc?.signal??null,timed_out:!!proc?.timed_out,
    agent_state:status?.state??null,last_error:lastError,error_status:status?.error_status??null,
    error_scope:status?.error_scope??null};
}
