// Anthropic Messages API adapter (fetch, no SDK). Config:
// {name, adapter:'anthropic', model:'claude-opus-5-5', max_tokens:1024, temperature?, base_url?,
//  api_key_env:'ANTHROPIC_API_KEY', tool_choice:'tool'|'auto'|'any', thinking?, timeout_ms?, prompt_cache:true,
//  reasoning_effort? (or effort): 'low'|'medium'|'high'|'xhigh'|'max' -> output_config.effort}
// 'tool' forces the first tool when only one tool is offered; with several tools it means 'any'.
// The key is read from the environment and sent only in the x-api-key header.
import {postJson,apiKey,ModelError} from './http.mjs';
import {compileToolContract,enforceToolContract,toolContractError,truncatedToolReply,strictRequestError} from './tool-contract.mjs';

export const ANTHROPIC_VERSION='2023-06-01';

/** Neutral messages (src/bench/prompt.mjs buildMessages) -> Anthropic messages. */
export function toAnthropicMessages(messages) {
  return messages.map(m=>{
    if(m.role==='assistant') {
      // Replay our own raw content verbatim (keeps thinking blocks valid across tool use).
      if(m.provider?.adapter==='anthropic'&&Array.isArray(m.provider.content))return {role:'assistant',content:m.provider.content};
      const content=[];
      if(m.content)content.push({type:'text',text:m.content});
      if(m.tool_call)content.push({type:'tool_use',id:m.tool_call.id,name:m.tool_call.name,input:m.tool_call.input??{}});
      if(!content.length)content.push({type:'text',text:'(no reply)'});
      return {role:'assistant',content};
    }
    if(m.tool_result_for)return {role:'user',content:[{type:'tool_result',tool_use_id:m.tool_result_for,content:m.content,...(m.is_error?{is_error:true}:{})}]};
    return {role:'user',content:m.content};
  });
}

export function createAnthropicModel(config) {
  const strictNames=config.strict_tool_names;
  if(strictNames!=null&&(!config.strict_tools||!Array.isArray(strictNames)||!strictNames.includes('act')
    ||strictNames.some(n=>!['act','read_glucose_history'].includes(n))))
    throw toolContractError('strict_tool_names must retain act and may include read_glucose_history',undefined,{scope:'endpoint'});
  const keyEnv=config.api_key_env??'ANTHROPIC_API_KEY';
  apiKey(keyEnv);                                    // fail fast when the key is missing
  const base=(config.base_url??'https://api.anthropic.com').replace(/\/$/,'');
  const model=config.model??'claude-opus-5-5';
  return {
    name:config.name??model,adapter:'anthropic',config,
    async complete({system,messages,tools}) {
      const choice=config.thinking?'auto':config.tool_choice??'tool';
      const body={model,max_tokens:config.max_tokens??1024,
        system:config.prompt_cache===false?system:[{type:'text',text:system,cache_control:{type:'ephemeral'}}],
        messages:toAnthropicMessages(messages),
        tools:tools.map(t=>({name:t.name,description:t.description,
          input_schema:config.strict_tools===true?compileToolContract(t,'anthropic').schema:t.input_schema,
          ...(config.strict_tools===true?{strict:strictNames==null||strictNames.includes(t.name)}:{})})),
        tool_choice:choice==='tool'&&tools.length===1?{type:'tool',name:tools[0].name}:{type:choice==='tool'?'any':choice}};
      if(config.disable_parallel_tool_use===true||config.strict_tools===true)body.tool_choice.disable_parallel_tool_use=true;
      const effort=config.reasoning_effort??config.effort;
      if(effort)body.output_config={...(body.output_config??{}),effort};
      // Native strict tools already constrain their inputs. Repeating the action union as a
      // final-text grammar exceeds provider compilation limits on real task schemas.
      if(config.temperature!=null&&!config.thinking)body.temperature=config.temperature;
      if(config.thinking)body.thinking=config.thinking;
      const t0=Date.now();
      let raw;
      try {raw=await postJson(`${base}/v1/messages`,body,{timeoutMs:config.timeout_ms??180000,
        headers:{'x-api-key':apiKey(keyEnv),'anthropic-version':ANTHROPIC_VERSION,
          ...(config.thinking?.block_binding?{'anthropic-beta':'thinking-binding-controls-2026-08-01'}:{})}});}
      catch(e){throw config.strict_tools===true?strictRequestError(e):e;}
      const latency_ms=Date.now()-t0;
      if(!Array.isArray(raw.content))throw new ModelError('Anthropic response without content',{retryable:true});
      if(config.strict_tools===true&&config.tool_contract_repair===true&&raw.stop_reason==='max_tokens')throw truncatedToolReply(raw,latency_ms);
      if(config.strict_tools===true&&['max_tokens','refusal'].includes(raw.stop_reason))throw toolContractError(`Incomplete or refused response (${raw.stop_reason})`,raw);
      const use=raw.content.find(b=>b.type==='tool_use');
      const text=raw.content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
      const u=raw.usage??{};
      const result={tool_call:use?{id:use.id,name:use.name,input:use.input}:null,text,
        usage:{input_tokens:(u.input_tokens??0)+(u.cache_creation_input_tokens??0)+(u.cache_read_input_tokens??0),output_tokens:u.output_tokens??0,
          cache_read_input_tokens:u.cache_read_input_tokens??0,cache_creation_input_tokens:u.cache_creation_input_tokens??0},
        latency_ms,stop_reason:raw.stop_reason??null,provider:{adapter:'anthropic',content:raw.content},raw};
      if(config.strict_tools!==true)return result;
      try{return enforceToolContract(result,tools,'anthropic',{calls:raw.content.filter(b=>b.type==='tool_use').length});}
      catch(e) {
        if(config.tool_contract_repair===true&&raw.content.filter(b=>b.type==='tool_use').length===1
          &&['simulate','read_glucose_history'].includes(result.tool_call?.name))
          return {...result,tool_validation_error:e.message};
        throw e;
      }
    },
  };
}
