import test from 'node:test';
import assert from 'node:assert/strict';
import {createGatewayWaitModel} from './gateway-wait.mjs';

const retained=()=>({native_history_resume:{source_session:'/offline/source',failed_session:'/offline/failed'},all_native_outputs_retained:true,original_tool_results_present:true,no_ambiguous_partial_output:true,remaining_native_turns:4,consumed_retained_native_turns:3,evidence_sha256:'a'.repeat(64)});
const temporary=()=>Object.assign(new Error('offline mock upstream limit'),{status:429,retryable:true});
function fixture(evidence,error=temporary()){
 let calls=0,verified=0;const waits=[];
 const delegate={async complete(){calls++;if(calls===1)throw error;return {ok:true};},async close(){}};
 const model=createGatewayWaitModel({delegate,unlimited:true,verifyEmptyFailure:async()=>{verified++;return evidence();},onEvent:async event=>waits.push(event),sleep:async()=>{}});
 return {model,waits,counts:()=>({calls,verified})};
}
test('mock retained-history evidence records consumed turns without legacy empty-MCP claims',async()=>{
 const f=fixture(retained);assert.deepEqual(await f.model.complete({}),{ok:true});assert.deepEqual(f.counts(),{calls:2,verified:1});
 assert.equal(f.waits[0].delay_ms,60000);assert.equal(f.waits[0].remaining_native_turns,4);assert.equal(f.waits[0].retained_consumed_native_turns,3);
 assert(!('no_MCP_receipt' in f.waits[0]));await f.model.close();
});
for(const [name,edit]of [
 ['partial output',e=>e.no_ambiguous_partial_output=false],
 ['missing original tool results',e=>e.original_tool_results_present=false],
 ['unretained native outputs',e=>e.all_native_outputs_retained=false],
 ['exhausted native budget',e=>e.remaining_native_turns=0],
 ['unaccounted consumed turns',e=>e.consumed_retained_native_turns=0],
 ['missing evidence digest',e=>delete e.evidence_sha256]
])test('mock evidence rejects '+name+' before another delegate call',async()=>{
 const f=fixture(()=>{const e=retained();edit(e);return e;});await assert.rejects(f.model.complete({}));assert.deepEqual(f.counts(),{calls:1,verified:1});assert.equal(f.waits.length,0);await f.model.close();
});
for(const [status,message]of [[403,'offline mock forbidden'],[429,'offline mock quota exhausted']])test('auth/quota remains fail-fast with mock retained evidence '+status,async()=>{
 const f=fixture(retained,Object.assign(new Error(message),{status,retryable:true}));await assert.rejects(f.model.complete({}));assert.deepEqual(f.counts(),{calls:1,verified:0});assert.equal(f.waits.length,0);await f.model.close();
});
test('legacy verified empty failures retain the original gateway path',async()=>{
 const f=fixture(()=>({no_unaccepted_reply:true,no_native_turn_consumed:true,no_MCP_receipt:true,evidence_sha256:'b'.repeat(64)}));
 assert.deepEqual(await f.model.complete({}),{ok:true});assert.equal(f.waits.length,1);assert(!('native_history_resume' in f.waits[0]));await f.model.close();
});
test('human close interrupts a pending original backoff without another call',async()=>{
 let observed,release;const ready=new Promise(r=>observed=r);let calls=0;
 const model=createGatewayWaitModel({delegate:{async complete(){calls++;throw temporary();},async close(){}},unlimited:true,verifyEmptyFailure:async()=>retained(),onEvent:async()=>observed()});
 const running=model.complete({});await ready;await model.close();await assert.rejects(running);assert.equal(calls,1);
});
