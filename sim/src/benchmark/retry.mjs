// Transport-error retries for agent-side simulator clients (the task's `sim` module,
// environment/cli/sim.mjs). Long agent think times between requests race with the sidecar's HTTP
// keep-alive timeout: a request on a socket the server is closing fails with `TypeError: fetch
// failed` (ECONNRESET / UND_ERR_SOCKET) although nothing went wrong in the simulation. Requests
// are safe to repeat: GETs are reads, and a step carries an action id `${prefix}-${step}` plus
// expected_step, so a step that was applied before its response was lost returns the cached
// response (SimEnv.step) instead of being applied twice.
//
//   const client=withRetry(await import(SWEET_SIM_CLI),{onRetry:r=>log(r)});
//
// Only transport failures and 5xx responses are retried; 4xx answers (bad action, stale step)
// are the agent's problem and surface immediately.

const TRANSIENT_CODES=new Set(['ECONNRESET','ECONNREFUSED','ECONNABORTED','EPIPE','ETIMEDOUT','EAI_AGAIN','UND_ERR_SOCKET',
  'UND_ERR_CLOSED','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT']);

/** Whether an error from the sim client is a transport failure worth retrying. */
export function isTransient(e) {
  if(!e)return false;
  if(e.name==='TimeoutError'||e.name==='AbortError')return true;
  const code=e.code??e.cause?.code??e.cause?.cause?.code;
  if(code&&TRANSIENT_CODES.has(code))return true;
  if(e instanceof TypeError&&/fetch failed|terminated|other side closed|socket/i.test(`${e.message} ${e.cause?.message??''}`))return true;
  return /^5\d\d /.test(String(e.message??''));      // sim client: `${status} ${body}`
}

/**
 * Wraps the client's episodeId / current / step / request with retries on transient errors:
 * exponential backoff from baseMs (x2, capped at maxMs, +-25 % jitter) for up to `retries` retries.
 * onRetry({fn, attempt, delay_ms, error}) is called before each retry. Returns a new client object
 * (other exports are passed through) with a `retryStats` {retries, by_fn} counter.
 */
export function withRetry(client,{retries=6,baseMs=250,maxMs=8000,onRetry=null,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  const stats={retries:0,by_fn:{}};
  const wrap=(name,fn)=>async(...args)=>{
    for(let attempt=1;;attempt++) {
      try {return await fn(...args);}
      catch(e) {
        if(attempt>retries||!isTransient(e))throw e;
        const delay=Math.round(Math.min(maxMs,baseMs*2**(attempt-1))*(0.75+0.5*Math.random()));
        stats.retries++;stats.by_fn[name]=(stats.by_fn[name]??0)+1;
        onRetry?.({fn:name,attempt,delay_ms:delay,error:String(e?.message??e).slice(0,300),cause:e?.cause?.code??e?.cause?.message??null});
        await sleep(delay);
      }
    }
  };
  const out={...client,retryStats:stats};
  for(const name of ['episodeId','current','step','request'])if(typeof client[name]==='function')out[name]=wrap(name,client[name]);
  return out;
}
