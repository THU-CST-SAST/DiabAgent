import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {parseResponsesResponse} from './openai-compatible.mjs';
import {enforceToolContract,toolContractError,truncatedToolReply} from './tool-contract.mjs';
import {retryableStatus} from './http.mjs';
import {parseInvocations} from './invocation-log.mjs';

/** Reconstruct an interrupted controller from exact old responses, without calling the LLM again. */
export function replayPrefix(model,{logsDir,sourceJob,fallbackJob=null,allowTransportResume=false,interruptedTrials=[]}) {
  if(!sourceJob)return model;
  const anthropic=model.adapter==='anthropic';
  if(!anthropic&&(model.adapter!=='openai-compatible'||model.config.wire_api!=='responses'))throw Error('Replay supports Responses or native Anthropic only');
  const trial=path.basename(path.dirname(logsDir)),dir=path.join(sourceJob,trial),file=path.join(dir,'agent/invocations.jsonl');
  if(!fs.existsSync(file))return model;
  const record=JSON.parse(fs.readFileSync(path.join(dir,'trial.json'),'utf8'));
  if(fallbackJob&&/Tool contract violation: Replay source response was not complete/.test(record.failure?.last_error??'')) {
    const before=JSON.parse(fs.readFileSync(path.join(sourceJob,'config.json'),'utf8'));
    const fallback=JSON.parse(fs.readFileSync(path.join(fallbackJob,'config.json'),'utf8'));
    if(before.benchmark_sha256!==fallback.benchmark_sha256)throw Error('Replay fallback world mismatch');
    return replayPrefix(model,{logsDir,sourceJob:fallbackJob});
  }
  const authorizedInterruption=Array.isArray(interruptedTrials)&&interruptedTrials.includes(trial)
    &&record.failure?.reason==='crash'&&record.failure?.signal==='SIGTERM';
  const transportSource=allowTransportResume&&record.status==='agent_failed'
    &&(['server','network','timeout'].includes(record.failure?.reason)||authorizedInterruption);
  if(record.status!=='agent_failed'||(record.failure?.reason!=='tool_contract'&&!transportSource))
    throw Error('Replay source must be an interrupted tool-contract trial or explicitly enabled transport interruption');
  const bytes=fs.readFileSync(file),entries=parseInvocations(bytes.toString(),{strict:true});
  const digest=createHash('sha256').update(bytes).digest('hex');let index=0;
  return {...model,async complete(request) {
    if(index===entries.length)return model.complete(request);
    const {system,messages,tools}=request,skipped=[];
    let entry;
    for(;;) {
      entry=entries[index];
      if(!entry) {
        if(transportSource&&skipped.length)return model.complete(request);
        throw toolContractError('Replay prefix ended inside a transport retry; reconcile original source');
      }
      if(!isDeepStrictEqual({system,messages,tools},{system:entry.request.system,messages:entry.request.messages,tools:entry.request.tools}))
        throw toolContractError(`Replay request mismatch at original call ${entry.call}; no live call sent`);
      const transient=entry.error&&!entry.response?.raw&&entry.error.code!=='TOOL_CONTRACT'
        &&(entry.error.status!=null?retryableStatus(entry.error.status):/Request to .+ failed|Response body read failed|Invalid JSON from/.test(entry.error.message));
      if(!transient) {
        if(transportSource&&!entry.finished&&!entry.response&&!entry.error&&index===entries.length-1) {
          index++;return model.complete(request);
        }
        break;
      }
      skipped.push({original_call:entry.call,error:entry.error});index++;
      if(skipped.length>4)throw toolContractError('Replay transport retry bound exceeded');
    }
    const replay={source:file,source_sha256:digest,original_call:entry.call,no_new_api_call:true,
      ...(skipped.length?{historical_transport_errors:skipped}:{})};
    const raw=entry.response?.raw;
    if(model.config.tool_contract_repair===true&&(raw?.status==='incomplete'&&raw.incomplete_details?.reason==='max_output_tokens'||raw?.stop_reason==='max_tokens')) {
      index++;
      const error=truncatedToolReply(raw,Math.max(0,Date.parse(entry.finished)-Date.parse(entry.started)));
      error.repair_result.replay=replay;
      throw error;
    }
    if(!raw||(!anthropic&&raw.status!=='completed')||(anthropic&&!['tool_use','end_turn'].includes(raw.stop_reason)))
      throw toolContractError('Replay source response was not complete',raw);
    index++;
    let parsed,calls;
    if(anthropic) {
      const use=raw.content.find(b=>b.type==='tool_use'),u=raw.usage??{};
      parsed={tool_call:use?{id:use.id,name:use.name,input:use.input}:null,
        text:raw.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'),
        usage:{input_tokens:(u.input_tokens??0)+(u.cache_creation_input_tokens??0)+(u.cache_read_input_tokens??0),output_tokens:u.output_tokens??0,
          cache_read_input_tokens:u.cache_read_input_tokens??0,cache_creation_input_tokens:u.cache_creation_input_tokens??0},
        stop_reason:raw.stop_reason,provider:{adapter:'anthropic',content:raw.content}};
      calls=raw.content.filter(b=>b.type==='tool_use').length;
    } else {parsed=parseResponsesResponse(raw);calls=raw.output.filter(x=>x.type==='function_call').length;}
    const result={...parsed,raw,latency_ms:Math.max(0,Date.parse(entry.finished)-Date.parse(entry.started)),
      replay};
    try{return enforceToolContract(result,tools,anthropic?'anthropic':'openai',{calls});}
    catch(e) {
      if(!anthropic&&model.config.tool_contract_repair===true&&calls===1
        &&['simulate','read_glucose_history'].includes(result.tool_call?.name)
        &&tools.some(t=>t.name===result.tool_call.name))
        return {...result,tool_validation_error:e.message};
      throw e;
    }
  }};
}
