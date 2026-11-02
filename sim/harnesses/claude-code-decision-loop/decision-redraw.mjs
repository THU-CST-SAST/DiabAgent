import assert from 'node:assert/strict';

// Human 2026-11-01: "直接续并记录成绩就得了" / "提升运行框架对于 api 服务的鲁棒性，包括不因超时或中断而直接废掉".
// A decision that ends in a transport failure, a logical deadline or a runner fault never reached the
// world (actions apply only after the controller receives a validated proposal), so the decision is
// redrawn in a fresh native session instead of discarding the trajectory. Every redraw is recorded and
// the trajectory is labelled; scores with redraws are reported separately from clean ones.
export const DECISION_REDRAW='decision-redraw/v1';
const FATAL=/quota|credit|balance|forbidden|unauthori[sz]ed|authentication|permission|invalid api key/i;

/** Returns the redraw category, or null when the error must stay terminal. */
export function redrawCategory(error){
  const text=String(error?.message??'');
  if(!error||FATAL.test(text)||[400,401,402,403,404].includes(error.status))return null;
  // Contract errors the controller can repair in-loop arrive with repair_result and never reach here.
  if(error.code==='TOOL_CONTRACT'&&error.repair_result)return null;
  if(error.code==='TOOL_CONTRACT'&&error.failure_scope==='endpoint'&&/Strict request rejected/.test(text))return null;
  if(error.code==='CODE_NATIVE_DEADLINE'||error.code==='NATIVE_INTERNAL_CONTINUATION_REQUIRED'||/logical deadline/i.test(text))return 'deadline';
  if([429,500,502,503,504,529].includes(error.status)||/stream|socket|ECONNRESET|ETIMEDOUT|fetch failed|overloaded|Incomplete native/i.test(text))return 'transport';
  return 'runner_fault';
}

export function createDecisionRedrawModel({delegate,onEvent,maxRedrawsPerDecision=4,maxTransportRedraws=Infinity,
  sleep=null,now=Date.now}){
  assert(delegate&&typeof onEvent==='function');
  assert(Number.isInteger(maxRedrawsPerDecision)&&maxRedrawsPerDecision>=0&&maxRedrawsPerDecision<=8);
  let closed=false,cancel=null,total=0,decisionsRedrawn=0;const byCategory={};
  const wait=ms=>sleep?sleep(ms):new Promise(resolve=>{const t=setTimeout(()=>{cancel=null;resolve();},ms);cancel=()=>{clearTimeout(t);cancel=null;resolve();};});
  return {
    get name(){return delegate.name;},get adapter(){return delegate.adapter;},get config(){return delegate.config;},
    async complete(request){
      let other=0,transport=0;
      for(;;){
        assert(!closed,'Decision redraw closed');
        try{const result=await delegate.complete(request);if(other+transport>0)decisionsRedrawn++;return result;}
        catch(error){
          const category=redrawCategory(error);
          if(!category)throw error;
          if(category==='transport'){if(++transport>maxTransportRedraws)throw error;}
          else if(++other>maxRedrawsPerDecision)throw error;
          // Discard any retained partial/native state; the redraw starts from the controller's request.
          await delegate.discardForRedraw?.();
          const attempt=other+transport,delay=category==='transport'?Math.min(600000,Math.max(60000*2**Math.min(4,transport-1),error.retryAfterMs??0)):5000;
          total++;byCategory[category]=(byCategory[category]??0)+1;
          await onEvent({type:'decision_redraw',version:DECISION_REDRAW,category,attempt,delay_ms:delay,
            error:{message:String(error.message).slice(0,500),code:error.code??null,status:error.status??null},at:new Date(now()).toISOString()});
          assert(!closed,'Decision redraw closed');
          await wait(delay);
        }
      }
    },
    async close(){closed=true;cancel?.();await delegate.close?.();},
    get diagnostics(){return {...(delegate.diagnostics??{}),decision_redraws:total,decisions_redrawn:decisionsRedrawn,redraws_by_category:{...byCategory}};}
  };
}
