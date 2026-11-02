import {createScriptedModel} from '../../sim/src/bench/models/scripted.mjs';

// Replace this factory with your trusted harness implementation.
// complete(request) receives system, messages, tools, and the public observation.
export async function createHarness({config}){
  return createScriptedModel({...config,adapter:'scripted',policy:config.policy??'wait'});
}
