// Preserve exactly what crossed the model boundary, without API keys or private World state.
//
// The log is one JSONL file per episode (`invocations.jsonl`) with one line per event, so a run
// that is killed mid-call still leaves its request on disk:
//   {event:'request',  sequence, started,  model, reasoning_effort, wire_api, base_url,
//                      request:{system, messages, tools}}
//   {event:'response', sequence, finished, usage, stop_reason, response:<the provider's raw body>}
//   {event:'error',    sequence, finished, error:{message, status, retryable}}
// Audits that want one record per call (model identity, token usage, duplicate response ids) read
// it back through `readInvocations`, which folds the events into
//   {call, sequence, started, finished, request:{model, reasoning_effort, wire_api, base_url,
//    system, messages, tools}, response:{id, model, status, reasoning_effort, usage, raw}, error?}
import fs from 'node:fs';
import path from 'node:path';
export {readInvocations,iterateInvocations} from './invocation-log.mjs';

/** Record the actual public model boundary, not adapter config, credentials or private world state. */
export function traceModel(model,outDir) {
  if(!outDir)return model;
  fs.mkdirSync(outDir,{recursive:true});
  const file=path.join(outDir,'invocations.jsonl');
  let sequence=0;
  return {...model,async complete(request) {
    const id=++sequence,cfg=model.config??{};
    fs.appendFileSync(file,JSON.stringify({event:'request',sequence:id,started:new Date().toISOString(),
      model:cfg.model??model.name,reasoning_effort:cfg.reasoning_effort??null,
      wire_api:model.wire_api??cfg.wire_api??null,base_url:cfg.base_url??null,
      request:{system:request.system,messages:request.messages,tools:request.tools}})+'\n');
    try {
      const response=await model.complete(request);
      fs.appendFileSync(file,JSON.stringify({event:'response',sequence:id,finished:new Date().toISOString(),
        usage:response.usage??null,stop_reason:response.stop_reason??null,
        response:response.raw??{tool_call:response.tool_call,text:response.text,usage:response.usage},
        ...(response.replay?{replay:response.replay}:{}),
        ...(response.contract_validation?{contract_validation:response.contract_validation}:{})})+'\n');
      return response;
    } catch(error) {
      fs.appendFileSync(file,JSON.stringify({event:'error',sequence:id,finished:new Date().toISOString(),
        error:{message:error.message,status:error.status??null,retryable:error.retryable??null,code:error.code??null,
          scope:error.failure_scope??null,failure_reason:error.failure_reason??null},
        ...(error.response_raw?{response:error.response_raw,usage:error.repair_result?.usage??error.response_raw.usage??null}:{}),
        ...(error.repair_result?.replay?{replay:error.repair_result.replay}:{})})+'\n');
      throw error;
    }
  }};
}
