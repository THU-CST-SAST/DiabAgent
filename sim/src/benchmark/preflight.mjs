import fs from 'node:fs';
import path from 'node:path';
import {createModel,loadModelConfig,costUsd} from '../bench/models/index.mjs';
import {traceModel} from '../bench/models/trace.mjs';
import {validateBudget} from './runner.mjs';
import {probeToolContract} from './contract-probe.mjs';

/** An effort echo is verifiable metadata, not proof of a relay's internal computation. */
export function effortVerification(responses,requested) {
  const returned=responses.map(r=>r.raw?.reasoning?.effort??null);
  const status=requested==null?'not_requested':returned.some(v=>v!=null&&v!==requested)?'mismatch'
    :returned.length>0&&returned.every(v=>v===requested)?'verified_echo':'not_returned';
  return {requested:requested??null,returned,status,
    note:'Provider metadata echo only; absence is not a verified inference setting.'};
}

/** One bounded tool request, separate from scored trials. Budget validation must precede any call. */
export async function probeModel({modelConfig,outDir,budgetUsd=null,maxTokens=512,requireEffortEcho=false}) {
  const cfg=loadModelConfig(modelConfig);
  if(requireEffortEcho&&!cfg.reasoning_effort)throw Error('requireEffortEcho needs an explicit reasoning_effort');
  if(!Number.isInteger(maxTokens)||maxTokens<32||maxTokens>1024)throw new Error('Probe maxTokens must be an integer in [32,1024]');
  validateBudget(['llm:preflight'],budgetUsd,()=>cfg);
  if(fs.existsSync(outDir))throw new Error(`No overwrite: ${outDir}`);
  const bounded={...cfg,max_tokens:maxTokens,timeout_ms:Math.min(cfg.timeout_ms??60000,60000)};
  // Match the controller's multi-tool selection; the adapter default pins only the first tool.
  if(cfg.strict_tools===true&&cfg.adapter==='openai-compatible'&&cfg.wire_api!=='anthropic')bounded.tool_choice='required';
  const result={started:new Date().toISOString(),purpose:'Connectivity/tool/identity probe, not a scored benchmark trajectory',
    endpoint:new URL(cfg.base_url).origin+new URL(cfg.base_url).pathname,
    requested_model:cfg.model,requested_effort:cfg.reasoning_effort??null,wire_api:cfg.adapter==='anthropic'?'anthropic':cfg.wire_api??'chat',max_output_tokens:maxTokens,
    pricing:cfg.price_per_mtok?.input>0&&cfg.price_per_mtok?.output>0?'configured':'unpriced',budget_usd:budgetUsd};
  fs.mkdirSync(outDir,{recursive:true});
  try {
    const model=traceModel(await createModel(bounded),outDir);
    const contract=cfg.strict_tools===true?await probeToolContract(model):null;
    if(contract&&!contract.ok)throw Error(contract.error);
    const r=contract?contract.responses.at(-1).response:await model.complete({system:'Connectivity test only. Call ping with ok=true. Do not discuss or perform any other task.',
      messages:[{role:'user',content:'ping'}],tools:[{name:'ping',description:'Harmless connectivity check; returns no patient information and controls no device.',
        input_schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}}]});
    const actual=r.raw?.model??null;
    Object.assign(result,{ok:contract?contract.ok:r.tool_call?.name==='ping'&&r.tool_call.input?.ok===true,
      response_id:r.raw?.id??null,response_model:actual,model_matches:actual===cfg.model||actual?.startsWith(cfg.model+'-')||false,
      returned_effort:r.raw?.reasoning?.effort??null,effort_verified:r.raw?.reasoning?.effort===cfg.reasoning_effort,
      response_status:r.raw?.status??r.stop_reason,tool_call:r.tool_call,usage:r.usage,
      estimated_usd:result.pricing==='configured'?costUsd(cfg,r.usage):null});
    if(contract) {
      result.contract_probe={strict_requested:true,requests:contract.responses.length,
        steps:contract.responses.map(({stage,response})=>({stage,response_model:response.raw?.model??null,
          returned_effort:response.raw?.reasoning?.effort??null,tool_name:response.tool_call?.name??'structured-act-text'})),
        note:'Finite interface check only, not proof of a relay internal constrained decoder or long-run reliability.'};
      result.usage=contract.responses.reduce((u,{response:r})=>({input_tokens:u.input_tokens+(r.usage?.input_tokens??0),
        output_tokens:u.output_tokens+(r.usage?.output_tokens??0)}),{input_tokens:0,output_tokens:0});
      result.estimated_usd=result.pricing==='configured'?costUsd(cfg,result.usage):null;
      result.ok=contract.responses.every(({response:r})=>r.raw?.model===cfg.model||r.raw?.model?.startsWith(cfg.model+'-'));
    }
    result.effort_verification=effortVerification(contract?contract.responses.map(r=>r.response):[r],cfg.reasoning_effort);
    result.effort_verified=result.effort_verification.status==='verified_echo';
    result.require_effort_echo=requireEffortEcho;
    result.ok=!!(result.ok&&result.model_matches&&(!requireEffortEcho||result.effort_verified));
  } catch(e){Object.assign(result,{ok:false,error:{message:e.message,status:e.status??null,retryable:e.retryable??false}});}
  result.finished=new Date().toISOString();
  const key=cfg.api_key_env?process.env[cfg.api_key_env]:null;
  const text=JSON.stringify(result,null,2)+'\n';
  fs.writeFileSync(path.join(outDir,'result.json'),key?text.replaceAll(key,'[REDACTED]'):text,{flag:'wx'});
  return result;
}
