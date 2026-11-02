// OpenAI-compatible adapter for other vendors and local servers, two wire APIs:
//   wire_api 'chat'      (default) POST <base_url>/chat/completions, function tools, choices[0].message.tool_calls
//   wire_api 'responses'           POST <base_url>/responses (OpenAI Responses API), function tools, output items
// ('chat_completions' / 'chat-completions' are accepted for 'chat'; 'anthropic' hands the config to the
// Anthropic Messages adapter with the same base_url / model / key, for gateways that speak both.)
// Config:
// {name, adapter:'openai-compatible', model, base_url:'https://host/v1', api_key_env:'X_API_KEY'|null,
//  wire_api:'chat'|'responses', max_tokens:1024, max_tokens_param:'max_tokens'|'max_completion_tokens' (chat only),
//  temperature?, reasoning_effort?:'low'|'medium'|'high', tool_choice:'function'|'required'|'auto',
//  extra_body?, timeout_ms?}
// Every field may instead come from an environment variable via <field>_env (src/bench/models/index.mjs).
// base_url includes the version prefix (e.g. .../v1); the key, if any, is sent as a Bearer token.
import {postJson,apiKey,extractJson,ModelError} from './http.mjs';
import {createAnthropicModel} from './anthropic.mjs';
import {compileToolContract,enforceToolContract,toolContractError,truncatedToolReply,strictRequestError,responseStateError} from './tool-contract.mjs';

export const WIRE_APIS=['chat','responses'];
const WIRE_ALIASES={chat:'chat',chat_completions:'chat','chat-completions':'chat',completions:'chat',responses:'responses',anthropic:'anthropic'};

/** Normalises a wire_api value ('chat' when unset); throws on unknown values. */
export function wireApi(v) {
  if(v==null||v==='')return 'chat';
  const w=WIRE_ALIASES[String(v).trim().toLowerCase()];
  if(!w)throw new Error(`Unknown wire_api ${v} (chat | responses | anthropic)`);
  return w;
}

/** oneOf -> anyOf (wider support among OpenAI-compatible servers). */
function compatSchema(s) {
  if(Array.isArray(s))return s.map(compatSchema);
  if(!s||typeof s!=='object')return s;
  const out={};
  for(const [k,v] of Object.entries(s))out[k==='oneOf'?'anyOf':k]=compatSchema(v);
  return out;
}

/** Neutral messages -> chat messages. */
export function toChatMessages(system,messages) {
  const out=[{role:'system',content:system}];
  for(const m of messages) {
    if(m.role==='assistant') {
      out.push({role:'assistant',content:m.content||null,
        ...(m.tool_call?{tool_calls:[{id:m.tool_call.id,type:'function',function:{name:m.tool_call.name,arguments:JSON.stringify(m.tool_call.input??{})}}]}:{})});
    } else if(m.tool_result_for)out.push({role:'tool',tool_call_id:m.tool_result_for,content:m.content});
    else out.push({role:'user',content:m.content});
  }
  return out;
}

/**
 * Neutral messages -> Responses API input items (the system prompt goes to `instructions`).
 * Assistant turns become an assistant message (if it had text) plus a function_call item; tool
 * results become function_call_output items. Reasoning items are not replayed (store:false).
 */
export function toResponsesInput(messages) {
  const out=[];
  for(const m of messages) {
    if(m.role==='assistant') {
      if(m.content)out.push({role:'assistant',content:m.content});
      if(m.tool_call)out.push({type:'function_call',call_id:m.tool_call.id,name:m.tool_call.name,arguments:JSON.stringify(m.tool_call.input??{})});
      if(!m.content&&!m.tool_call)out.push({role:'assistant',content:'(no reply)'});
    } else if(m.tool_result_for)out.push({type:'function_call_output',call_id:m.tool_result_for,output:m.content});
    else out.push({role:'user',content:m.content});
  }
  return out;
}

/** Parses tool-call arguments (a JSON string, or an object as some servers return). */
function parseArgs(id,name,args) {
  if(args&&typeof args==='object')return {id,name,input:args};
  let input=null;
  try{input=JSON.parse(args||'{}');}catch{input=extractJson(args);}
  return {id,name,input,...(input==null?{arguments:args}:{})};
}

const optional=(k,v)=>v==null?{}:{[k]:v};

/** Chat completions response -> neutral result. */
export function parseChatResponse(raw) {
  const msg=raw?.choices?.[0]?.message;
  if(!msg)throw new ModelError('Chat completion without choices[0].message',{retryable:true});
  const call=msg.tool_calls?.find(c=>c.type==='function'||c.function);
  const u=raw.usage??{};
  return {tool_call:call?parseArgs(call.id??'call_0',call.function.name,call.function.arguments):null,
    text:typeof msg.content==='string'?msg.content:'',
    usage:{input_tokens:u.prompt_tokens??0,output_tokens:u.completion_tokens??0,
      ...optional('cache_read_input_tokens',u.prompt_tokens_details?.cached_tokens),
      ...optional('reasoning_tokens',u.completion_tokens_details?.reasoning_tokens)},
    stop_reason:raw.choices[0].finish_reason??null};
}

/** Responses API response -> neutral result (first function_call item; text from output_text parts). */
export function parseResponsesResponse(raw) {
  if(raw?.status==='incomplete'||raw?.status==='failed'||raw?.error)throw responseStateError(raw);
  if(!Array.isArray(raw?.output))throw new ModelError('Response without an output array',{retryable:true});
  const call=raw.output.find(o=>o.type==='function_call');
  const text=raw.output.filter(o=>o.type==='message').flatMap(o=>Array.isArray(o.content)?o.content:[])
    .filter(c=>c.type==='output_text'&&typeof c.text==='string').map(c=>c.text).join('\n');
  const u=raw.usage??{};
  return {tool_call:call?parseArgs(call.call_id??call.id??'call_0',call.name,call.arguments):null,text,
    usage:{input_tokens:u.input_tokens??0,output_tokens:u.output_tokens??0,
      ...optional('cache_read_input_tokens',u.input_tokens_details?.cached_tokens),
      ...optional('reasoning_tokens',u.output_tokens_details?.reasoning_tokens)},
    stop_reason:raw.status==='incomplete'?`incomplete:${raw.incomplete_details?.reason??'unknown'}`:raw.status??null};
}

export function createOpenAICompatibleModel(config) {
  const wire=wireApi(config.wire_api);
  const hint=f=>config[`${f}_env`]?` (set the ${config[`${f}_env`]} environment variable)`:'';
  if(!config.base_url)throw new Error(`openai-compatible adapter needs base_url, e.g. https://api.example.com/v1${hint('base_url')}`);
  if(!config.model)throw new Error(`openai-compatible adapter needs model${hint('model')}`);
  if(wire==='anthropic') {
    const tc={function:'tool',required:'any'}[config.tool_choice]??config.tool_choice;
    const m=createAnthropicModel({...config,adapter:'anthropic',tool_choice:tc,api_key_env:config.api_key_env===undefined?'ANTHROPIC_API_KEY':config.api_key_env});
    return {...m,adapter:'openai-compatible',wire_api:'anthropic'};
  }
  const keyEnv=config.api_key_env===undefined?'OPENAI_API_KEY':config.api_key_env;
  apiKey(keyEnv);
  const base=config.base_url.replace(/\/$/,'');
  return {
    name:config.name??config.model,adapter:'openai-compatible',wire_api:wire,config,
    async complete({system,messages,tools}) {
      const choice=config.tool_choice??'function';
      let url,body;
      if(wire==='responses') {
        url=`${base}/responses`;
        body={model:config.model,instructions:system,input:toResponsesInput(messages),
          tools:tools.map(t=>({type:'function',name:t.name,description:t.description,
            parameters:config.strict_tools===true?compileToolContract(t,'openai').schema:compatSchema(t.input_schema),strict:config.strict_tools===true})),
          tool_choice:choice==='function'?{type:'function',name:tools[0].name}:choice,
          max_output_tokens:config.max_tokens??1024,store:false,stream:false,
          // Reasoning models reject sampling parameters: temperature only without reasoning_effort.
          ...(config.reasoning_effort?{reasoning:{effort:config.reasoning_effort}}:config.temperature!=null?{temperature:config.temperature}:{}),
          ...(config.extra_body??{})};
      } else {
        url=`${base}/chat/completions`;
        body={model:config.model,messages:toChatMessages(system,messages),
          tools:tools.map(t=>({type:'function',function:{name:t.name,description:t.description,
            parameters:config.strict_tools===true?compileToolContract(t,'openai').schema:compatSchema(t.input_schema),
            ...(config.strict_tools===true?{strict:true}:{})}})),
          tool_choice:choice==='function'?{type:'function',function:{name:tools[0].name}}:choice,
          [config.max_tokens_param??'max_tokens']:config.max_tokens??1024,
          ...(config.temperature!=null?{temperature:config.temperature}:{}),
          ...(config.reasoning_effort?{reasoning_effort:config.reasoning_effort}:{}),...(config.extra_body??{})};
      }
      if(config.strict_tools===true) {
        const expectedChoice=choice==='function'?(wire==='responses'?{type:'function',name:tools[0].name}:{type:'function',function:{name:tools[0].name}}):choice;
        if(JSON.stringify(body.tool_choice)!==JSON.stringify(expectedChoice))throw toolContractError('extra_body must not change strict tool choice',undefined,{scope:'endpoint'});
        if(JSON.stringify(body.tools)!==JSON.stringify(tools.map(t=>wire==='responses'
          ?{type:'function',name:t.name,description:t.description,parameters:compileToolContract(t,'openai').schema,strict:true}
          :{type:'function',function:{name:t.name,description:t.description,parameters:compileToolContract(t,'openai').schema,strict:true}})))
          throw toolContractError('extra_body must not replace strict tool definitions',undefined,{scope:'endpoint'});
        body.parallel_tool_calls=false;
      }
      const key=apiKey(keyEnv),t0=Date.now();
      let raw;
      try {raw=await postJson(url,body,{timeoutMs:config.timeout_ms??180000,headers:key?{authorization:`Bearer ${key}`}:{}});}
      catch(e){throw config.strict_tools===true?strictRequestError(e):e;}
      const latency_ms=Date.now()-t0;
      if(config.strict_tools===true) {
        if(config.tool_contract_repair===true&&wire==='responses'&&raw.status==='incomplete'&&raw.incomplete_details?.reason==='max_output_tokens')
          throw truncatedToolReply(raw,latency_ms);
        if(wire==='responses'&&raw.status!=='completed')throw responseStateError(raw);
        if(wire==='chat'&&raw.choices?.[0]?.finish_reason!=='tool_calls')throw toolContractError('Response did not complete a tool call',raw);
        const call=wire==='responses'?raw.output?.find(o=>o.type==='function_call'):raw.choices?.[0]?.message?.tool_calls?.[0];
        const args=wire==='responses'?call?.arguments:call?.function?.arguments;
        if(typeof args==='string')try{JSON.parse(args);}catch{throw toolContractError('Tool arguments are not exact JSON',raw);}
      }
      const r=wire==='responses'?parseResponsesResponse(raw):parseChatResponse(raw);
      const result={...r,latency_ms,raw};
      const calls=wire==='responses'?raw.output?.filter(o=>o.type==='function_call').length:raw.choices?.[0]?.message?.tool_calls?.length;
      if(config.strict_tools!==true)return result;
      try{return enforceToolContract(result,tools,'openai',{calls});}
      catch(e) {
        if(config.tool_contract_repair===true&&calls===1
          &&['simulate','read_glucose_history'].includes(result.tool_call?.name)
          &&tools.some(t=>t.name===result.tool_call.name))
          return {...result,tool_validation_error:e.message};
        throw e;
      }
    },
  };
}
