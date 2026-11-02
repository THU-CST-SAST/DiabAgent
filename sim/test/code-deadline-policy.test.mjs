import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyTerminalDeadline} from '../harnesses/claude-code-decision-loop/deadline-policy.mjs';
const cause={code:'CODE_NATIVE_DEADLINE'},session={closed:true,exit:{signal:'SIGKILL'},receipts:[],frames:[{type:'ping'}],events:[{type:'system'}]};
test('only a closed no-reply no-MCP deadline is eligible for the unchanged outer retry',()=>{
  assert.equal(emptyTerminalDeadline(cause,session),true);
  for(const change of [{closed:false},{exit:null},{receipts:[{}]},{frames:[{type:'message_start'}]},
    {events:[{type:'assistant'}]},{events:[{type:'tool_progress'}]},{events:[{type:'result'}]}])
    assert.equal(emptyTerminalDeadline(cause,{...session,...change}),false);
});
test('saved complete replies and other failures are never reclassified as empty deadlines',()=>{
  assert.equal(emptyTerminalDeadline({...cause,complete_native_reply:{}},session),false);
  assert.equal(emptyTerminalDeadline({code:'OTHER'},session),false);
  assert.equal(emptyTerminalDeadline(cause,null),false);
});
