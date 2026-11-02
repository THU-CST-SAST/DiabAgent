import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

export function inspectEmptyGatewayFailure(dir){
  const files=['SESSION.json','stdout.jsonl'];
  const bytes=files.map(name=>fs.readFileSync(dir+'/'+name));
  const session=JSON.parse(bytes[0]),events=bytes[1].toString().split('\n').filter(Boolean).map(JSON.parse);
  assert(session.exit!==null&&session.exit!==undefined,'Native process must be closed');
  assert.deepEqual(session.turns,[]);assert.deepEqual(session.native_internal??[],[]);
  assert.deepEqual(session.native_MCP_receipts??[],[]);
  assert(!fs.readdirSync(dir).some(n=>/^COMPLETE-NATIVE-REPLY-|^ACCEPTED-PROPOSAL-/.test(n)));
  assert(!events.some(e=>(e.type==='stream_event'&&e.event?.type!=='ping')||(e.type==='assistant'&&e.message?.content?.some(b=>['tool_use','thinking'].includes(b.type)))));
  assert(events.some(e=>e.type==='result'&&e.is_error===true));
  const mcp=dir+'/MCP-CALLS.jsonl';assert(!fs.existsSync(mcp)||fs.readFileSync(mcp,'utf8').trim()==='');
  return {session_dir:fs.realpathSync(dir),no_unaccepted_reply:true,no_native_turn_consumed:true,no_MCP_receipt:true,
    evidence_sha256:createHash('sha256').update(JSON.stringify(files.map((file,i)=>({file,sha256:createHash('sha256').update(bytes[i]).digest('hex')})))).digest('hex')};
}

// A wall-clock recovery policy, not a reset of native turns or scientific state.
export function createGatewayWaitModel({delegate,verifyEmptyFailure,onEvent,now=Date.now,
  sleep=null,maxAttempts=8,maxWindowMs=3600000,unlimited=false}){
  assert(delegate&&typeof verifyEmptyFailure==='function'&&typeof onEvent==='function');
  assert(Number.isInteger(maxAttempts)&&maxAttempts>=1&&maxAttempts<=8);
  assert(maxWindowMs>0&&maxWindowMs<=3600000);
  if(unlimited){maxAttempts=Infinity;maxWindowMs=Infinity;}
  let closed=false,cancelWait=null;
  const wait=ms=>sleep?sleep(ms):new Promise(resolve=>{
    const timer=setTimeout(()=>{cancelWait=null;resolve();},ms);
    cancelWait=()=>{clearTimeout(timer);cancelWait=null;resolve();};
  });
  return {
    get name(){return delegate.name;},get adapter(){return delegate.adapter;},get config(){return delegate.config;},
    async complete(request){
      const started=now();
      for(let attempt=1;;attempt++){
        assert(!closed,'Gateway recovery closed');
        try{return await delegate.complete(request);}catch(error){
          const text=String(error.message??'');
          const temporary=error.retryable===true&&[429,500,502,503,504].includes(error.status)
            &&! /quota|credit|balance|forbidden|unauthorized|authentication|permission/i.test(text);
          if(!temporary||attempt>=maxAttempts)throw error;
          // This must inspect original CLI files, not merely trust the thrown status.
          let evidence;try{evidence=await verifyEmptyFailure({error,attempt});}catch(proof){error.gateway_evidence_unavailable=String(proof?.message??proof).slice(0,500);throw error;}
          if(evidence.native_history_resume){
            assert.equal(evidence.all_native_outputs_retained,true);
            assert.equal(evidence.original_tool_results_present,true);
            assert.equal(evidence.no_ambiguous_partial_output,true);
            assert(Number.isInteger(evidence.remaining_native_turns)&&evidence.remaining_native_turns>0&&evidence.remaining_native_turns<=7);
            assert(Number.isInteger(evidence.consumed_retained_native_turns)&&evidence.consumed_retained_native_turns>0);
          }else{
            assert.equal(evidence.no_unaccepted_reply,true);
            assert.equal(evidence.no_native_turn_consumed,true);
            assert.equal(evidence.no_MCP_receipt,true);
          }
          assert.match(evidence.evidence_sha256,/^[a-f0-9]{64}$/);
          const delay=Math.max(60000,Math.min(600000,60000*2**Math.min(10,attempt-1)),error.retryAfterMs??0);
          if(now()-started+delay>=maxWindowMs)throw error;
          await onEvent({type:'gateway_wait',attempt,status:error.status,delay_ms:delay,
            session_dir:evidence.session_dir,evidence_sha256:evidence.evidence_sha256,
            ...(evidence.query_resume?{query_resume:evidence.query_resume,remaining_native_turns:evidence.remaining_native_turns}:{}),
            ...(evidence.native_history_resume?{native_history_resume:evidence.native_history_resume,remaining_native_turns:evidence.remaining_native_turns,retained_consumed_native_turns:evidence.consumed_retained_native_turns}:{}),elapsed_ms:now()-started});
          assert(!closed,'Gateway recovery closed');
          await wait(delay);
        }
      }
    },async discardForRedraw(){await delegate.discardForRedraw?.();},async close(){closed=true;cancelWait?.();await delegate.close?.();},
    get diagnostics(){return delegate.diagnostics;}
  };
}
