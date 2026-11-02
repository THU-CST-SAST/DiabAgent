import test from 'node:test';
import assert from 'node:assert/strict';
import {createDecisionRedrawModel,redrawCategory} from './decision-redraw.mjs';

const err=(message,extra={})=>Object.assign(new Error(message),extra);
function fake(outcomes){
  const calls=[],discards=[];let i=0;
  return {calls,discards,name:'fake',adapter:'anthropic',config:{},diagnostics:{sessions:0},
    async complete(request){calls.push(request);const o=outcomes[i++];if(o instanceof Error)throw o;return o;},
    async discardForRedraw(){discards.push(calls.length);},async close(){}};
}
const run=(outcomes,opts={})=>{const d=fake(outcomes),events=[],slept=[];
  const m=createDecisionRedrawModel({delegate:d,onEvent:e=>events.push(e),sleep:ms=>{slept.push(ms);},...opts});return {d,m,events,slept};};

test('classifies terminal and redrawable failures',()=>{
  assert.equal(redrawCategory(err('Decision-loop Code logical deadline; no partial action accepted',{status:504,code:'CODE_NATIVE_DEADLINE'})),'deadline');
  assert.equal(redrawCategory(err('Incomplete native stream without stop_reason; no action accepted',{status:502})),'transport');
  assert.equal(redrawCategory(err('Service temporarily unavailable',{status:503})),'transport');
  assert.equal(redrawCategory(err('Complete native response retained without proven MCP delivery; do not redraw it',{code:'TOOL_CONTRACT',failure_scope:'endpoint'})),'runner_fault');
  assert.equal(redrawCategory(err('The expression evaluated to a falsy value',{code:'ERR_ASSERTION'})),'runner_fault');
  for(const e of [err('insufficient credit balance',{status:402}),err('forbidden',{status:403}),err('x',{status:401}),
    err('Tool contract violation: note too long',{code:'TOOL_CONTRACT',repair_result:{}}),
    err('Tool contract violation: Strict request rejected: unsupported',{code:'TOOL_CONTRACT',failure_scope:'endpoint'})])
    assert.equal(redrawCategory(e),null,e.message);
});

test('a deadline is redrawn with the identical request after discarding retained state',async()=>{
  const ok={tool_call:{name:'act',input:{action:{type:'WAIT'}}}};
  const {d,m,events,slept}=run([err('deadline',{code:'CODE_NATIVE_DEADLINE',status:504}),ok]);
  const req={messages:[1]};assert.equal(await m.complete(req),ok);
  assert.deepEqual(d.calls,[req,req]);assert.deepEqual(d.discards,[1]);
  assert.equal(events.length,1);assert.equal(events[0].category,'deadline');assert.deepEqual(slept,[5000]);
  assert.deepEqual({r:m.diagnostics.decision_redraws,d:m.diagnostics.decisions_redrawn},{r:1,d:1});
});

test('transport failures back off and are not capped by the per-decision limit',async()=>{
  const ok={tool_call:null};
  const fails=Array.from({length:6},()=>err('gateway',{status:502}));
  const {m,slept}=run([...fails,ok],{maxRedrawsPerDecision:1});
  assert.equal(await m.complete({}),ok);
  assert.deepEqual(slept,[60000,120000,240000,480000,600000,600000]);
});

test('non-transport redraws stop at the per-decision cap and rethrow the original error',async()=>{
  const e=err('deadline',{code:'CODE_NATIVE_DEADLINE',status:504});
  const {d,m}=run([e,e,e],{maxRedrawsPerDecision:2});
  await assert.rejects(m.complete({}),x=>x===e);assert.equal(d.calls.length,3);
});

test('authentication and quota failures are never redrawn',async()=>{
  const e=err('authentication_error: invalid key',{status:401});
  const {d,m,events}=run([e]);
  await assert.rejects(m.complete({}),x=>x===e);assert.equal(d.calls.length,1);assert.equal(events.length,0);
});

test('the per-decision counter resets for the next decision',async()=>{
  const e=err('deadline',{code:'CODE_NATIVE_DEADLINE'}),ok={};
  const {m}=run([e,ok,e,ok],{maxRedrawsPerDecision:1});
  await m.complete({});await m.complete({});
  assert.deepEqual({r:m.diagnostics.decision_redraws,d:m.diagnostics.decisions_redrawn},{r:2,d:2});
});
