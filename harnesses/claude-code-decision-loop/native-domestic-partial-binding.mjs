import assert from 'node:assert/strict';
import {assertRegisteredCodeModel,modelIdentityMatches} from './model-identity.mjs';
export function assertDomesticPartialIdentity({planModel,launch,raw,sourcePlanSha,expectedPlanSha}){
 assert(['deepseek-v4.1-flash-1017','glm-5.3-flash'].includes(planModel));
 assertRegisteredCodeModel(planModel);
 assert.match(expectedPlanSha,/^[a-f0-9]{64}$/);assert.equal(sourcePlanSha,expectedPlanSha);
 assert.equal(launch.argv.filter(v=>v==='--model').length,1);
 assert.equal(launch.argv[launch.argv.indexOf('--model')+1],planModel);
 assert(modelIdentityMatches(planModel,raw.model),'Unexpected provider model identity');
 assert.equal(raw.role,'assistant');assert.equal(raw.type,'message');assert.equal(typeof raw.id,'string');assert(raw.id.length>0);
}
