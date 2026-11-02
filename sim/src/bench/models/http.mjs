// Shared HTTP helpers for model adapters. Keys are read from the environment at call time and
// only ever placed in request headers; errors carry the status and a truncated body, never headers.

export class ModelError extends Error {
  constructor(message,{status=null,retryable=false,retryAfterMs=null,body=null}={}) {
    super(message);this.name='ModelError';
    Object.assign(this,{status,retryable,retryAfterMs,body});
  }
}

/** HTTP statuses worth retrying: timeouts, conflicts, rate limits, server errors, Anthropic 529 overload. */
export const retryableStatus=s=>s===408||s===409||s===429||s>=500;

/** Some Responses gateways stream even when stream:false was requested. Never accept a partial call. */
export function parseResponseSse(text) {
  let terminal=null;
  for(const frame of text.split(/\r?\n\r?\n/)) {
    const data=frame.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
    if(!data||data==='[DONE]')continue;
    let e;try{e=JSON.parse(data);}catch{throw new ModelError('Malformed Responses SSE frame',{retryable:true});}
    if(e.type==='error')throw new ModelError(`Responses stream error: ${String(e.message??e.error?.message??e.code??'unknown').slice(0,300)}`,{retryable:true});
    if(['response.completed','response.incomplete','response.failed'].includes(e.type)&&e.response)terminal=e.response;
  }
  if(!terminal)throw new ModelError('Responses stream ended without a terminal response',{retryable:true});
  return terminal;
}
/** Name used by the paired-generation study code. */
export const parseResponseStream=parseResponseSse;

/** Reads an API key from the environment; throws a ModelError naming only the variable. */
export function apiKey(envName,{required=true}={}) {
  if(!envName)return null;
  const v=process.env[envName];
  if(!v&&required)throw new ModelError(`Missing API key: set the ${envName} environment variable`,{retryable:false});
  return v||null;
}

/** POST JSON once. Returns the parsed body; throws ModelError (retryable for network/5xx/429/529). */
export async function postJson(url,body,{headers={},timeoutMs=120000}={}) {
  let res;
  try {
    res=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
  } catch(e) {
    throw new ModelError(`Request to ${new URL(url).host} failed: ${e.name==='TimeoutError'?`timeout after ${timeoutMs} ms`:e.message}`,{retryable:true});
  }
  let text;try{text=await res.text();}catch(e){throw new ModelError(`Response body read failed: ${e.message}`,{retryable:true});}
  if(!res.ok) {
    const ra=Number(res.headers.get('retry-after'));
    throw new ModelError(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0,500)}`,
      {status:res.status,retryable:retryableStatus(res.status),retryAfterMs:Number.isFinite(ra)&&ra>0?ra*1000:null,body:text.slice(0,2000)});
  }
  if(res.headers.get('content-type')?.includes('text/event-stream')||/^\s*(event:|data:)/.test(text))return parseResponseSse(text);
  try {return JSON.parse(text);}
  catch {throw new ModelError(`Invalid JSON from ${new URL(url).host}: ${text.slice(0,200)}`,{status:res.status,retryable:true});}
}

/** Extracts the first JSON object from free text (```json fences or a bare {...}). Returns null if none parses. */
export function extractJson(text) {
  if(typeof text!=='string')return null;
  const fence=text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates=fence?[fence[1],text]:[text];
  for(const c of candidates) {
    for(let i=c.indexOf('{');i>=0;i=c.indexOf('{',i+1)) {
      let depth=0,inStr=false,esc=false;
      for(let j=i;j<c.length;j++) {
        const ch=c[j];
        if(inStr){if(esc)esc=false;else if(ch==='\\')esc=true;else if(ch==='"')inStr=false;continue;}
        if(ch==='"')inStr=true;else if(ch==='{')depth++;
        else if(ch==='}'&&--depth===0){try{const v=JSON.parse(c.slice(i,j+1));if(v&&typeof v==='object')return v;}catch{}break;}
      }
    }
  }
  return null;
}
