// A static relative import lets the existing offline freezer retain the installed validator closure.
import * as z from '../../../node_modules/zod/index.js';
import {ModelError} from './http.mjs';

const cache=new WeakMap();
const bounds=new Set(['minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','minLength','maxLength','maxItems','uniqueItems']);

// Diagnostics only; Zod below remains the validator. Follow the selected action discriminator.
function missingFields(schema,input,prefix='') {
  if(!input||typeof input!=='object'||Array.isArray(input))return [];
  const variant=(schema.oneOf??schema.anyOf)?.find(v=>v.properties?.type?.const===input.type);
  if(variant)return missingFields(variant,input,prefix);
  return [...(schema.required??[]).filter(k=>!Object.hasOwn(input,k)).map(k=>prefix+k),
    ...Object.entries(schema.properties??{}).filter(([k])=>Object.hasOwn(input,k))
      .flatMap(([k,s])=>missingFields(s,input[k],prefix+k+'.'))];
}

function unexpectedFields(schema,input,prefix='') {
  if(!input||typeof input!=='object'||Array.isArray(input))return [];
  const variant=(schema.oneOf??schema.anyOf)?.find(v=>v.properties?.type?.const===input.type);
  if(variant)return unexpectedFields(variant,input,prefix);
  return [...(schema.additionalProperties===false?Object.keys(input).filter(k=>!Object.hasOwn(schema.properties??{},k)).map(k=>prefix+k):[]),
    ...Object.entries(schema.properties??{}).filter(([k])=>Object.hasOwn(input,k))
      .flatMap(([k,s])=>unexpectedFields(s,input[k],prefix+k+'.'))];
}

function disjointVariants(variants) {
  const tags=variants.map(v=>v.properties?.type?.const);
  return tags.every(v=>typeof v==='string')&&new Set(tags).size===tags.length;
}

/** Provider-compatible grammar; original numeric/length constraints remain locally enforced. */
export function strictToolSchema(schema,provider) {
  if(!['anthropic','openai'].includes(provider))throw Error('Unknown strict schema provider');
  function visit(s) {
    if(!s||typeof s!=='object'||Array.isArray(s))throw Error('Expected a JSON Schema object');
    const out={},described=[];
    for(const [key,value] of Object.entries(s)) {
      if(key==='properties'||key==='required')continue;
      if(bounds.has(key)) {described.push(`${key}=${JSON.stringify(value)}`);continue;}
      if(key==='oneOf') {
        if(!disjointVariants(value))throw Error('Strict oneOf conversion requires distinct action type discriminators');
        out.anyOf=value.map(visit);
      } else if(key==='anyOf'||key==='allOf')out[key]=value.map(visit);
      else if(key==='items')out.items=visit(value);
      else out[key]=structuredClone(value);
    }
    if(s.type==='object'||s.properties) {
      if(s.additionalProperties!==false)throw Error('Strict tool objects must explicitly prohibit additional properties');
      out.properties={};
      for(const [name,prop] of Object.entries(s.properties??{})) {
        const compiled=visit(prop),optional=!(s.required??[]).includes(name);
        out.properties[name]=provider==='openai'&&optional?{anyOf:[compiled,{type:'null'}]}:compiled;
      }
      out.required=provider==='openai'?Object.keys(out.properties):[...(s.required??[])];
    }
    if(described.length)out.description=[out.description,'Additional locally enforced constraints: '+described.join(', ')+'.'].filter(Boolean).join(' ');
    return out;
  }
  return visit(schema);
}

function optionalNulls(schema,input) {
  if(Array.isArray(input))return input.map(value=>optionalNulls(schema.items??{},value));
  if(!input||typeof input!=='object')return input;
  const variants=schema.oneOf??schema.anyOf;
  if(variants) {
    const selected=variants.find(v=>v.properties?.type?.const===input.type);
    if(selected)return optionalNulls(selected,input);
  }
  const out={};
  for(const [key,value] of Object.entries(input)) {
    if(value===null&&schema.properties?.[key]&&!(schema.required??[]).includes(key))continue;
    out[key]=optionalNulls(schema.properties?.[key]??{},value);
  }
  return out;
}

// A gateway may omit an optional property instead of serializing its wire-only null.
// Complete only those transport placeholders; never supply an original required value.
function optionalWireFields(schema,input) {
  if(Array.isArray(input))return input.map(value=>optionalWireFields(schema.items??{},value));
  if(!input||typeof input!=='object')return input;
  const variants=schema.oneOf??schema.anyOf;
  const selected=variants?.find(v=>v.properties?.type?.const===input.type);
  if(selected)return optionalWireFields(selected,input);
  const out=Object.fromEntries(Object.entries(input).map(([key,value])=>[key,optionalWireFields(schema.properties?.[key]??{},value)]));
  for(const key of Object.keys(schema.properties??{}))
    if(!Object.hasOwn(input,key)&&!(schema.required??[]).includes(key))out[key]=null;
  return out;
}

export function compileToolContract(tool,provider) {
  let byProvider=cache.get(tool.input_schema);
  if(!byProvider){byProvider=new Map();cache.set(tool.input_schema,byProvider);}
  if(byProvider.has(provider))return byProvider.get(provider);
  let schema,wire,original;
  try {
    if(typeof z.fromJSONSchema!=='function')throw Error('Installed Zod lacks fromJSONSchema; strict mode is not ready');
    schema=strictToolSchema(tool.input_schema,provider);
    wire=z.fromJSONSchema(schema);original=z.fromJSONSchema(tool.input_schema);
  } catch(e){throw toolContractError(`Schema cannot be compiled: ${e.message}`,undefined,{scope:'endpoint'});}
  const contract={schema,wireConformant:input=>wire.safeParse(input).success,parse(input) {
    const checked=wire.safeParse(provider==='openai'?optionalWireFields(tool.input_schema,input):input);
    if(!checked.success) {
      const missing=missingFields(tool.input_schema,input);
      const unexpected=unexpectedFields(tool.input_schema,input);
      throw Error(missing.length?'Missing required field(s): '+missing.join(', ')
        :unexpected.length?'Unexpected field(s): '+unexpected.join(', '):'Tool arguments violate the strict wire schema');
    }
    const normalized=provider==='openai'?optionalNulls(tool.input_schema,input):input;
    const originalCheck=original.safeParse(normalized);
    if(!originalCheck.success)throw Error('Original schema: '+originalCheck.error.issues.slice(0,4)
      .map(issue=>`${issue.path.join('.')||'arguments'}: ${issue.message}`).join('; '));
    return normalized;
  }};
  byProvider.set(provider,contract);
  return contract;
}

export function toolContractError(message,raw,{scope='trial'}={}) {
  const error=new ModelError(`Tool contract violation: ${message}`,{retryable:false});
  error.code='TOOL_CONTRACT';
  error.failure_scope=scope;
  if(raw)error.response_raw=raw;
  return error;
}

/** Only an explicit schema/strict-capability rejection establishes endpoint incompatibility. */
export function strictRequestError(error) {
  if(error.status!==400)return error;
  let body;try{body=JSON.parse(error.body??'{}');}catch{return error;}
  const detail=body.error??body,code=String(detail.code??detail.type??''),message=String(detail.message??''),param=String(detail.param??'');
  const schemaCode=['invalid_json_schema','invalid_schema','unsupported_json_schema'].includes(code);
  const schemaParam=/^(tools(?:\.|\[)|response_format(?:\.|$)|text\.format(?:\.|$))/.test(param);
  const unsupported=/\bstrict (?:tool(?:s| schemas?)?|schemas?) (?:is |are )?(?:not supported|unsupported)\b|\b(?:unsupported|invalid) (?:json )?schema\b|\b(?:grammar|schema).*(?:compilation|compile|too large|too complex|capacity)/i.test(message);
  if(!schemaCode&&!unsupported&&!(schemaParam&&code==='unsupported_parameter'))return error;
  const classified=toolContractError(`Strict request rejected: ${error.message}`,undefined,{scope:'endpoint'});
  classified.status=error.status;
  classified.cause=error;
  return classified;
}

/** An unsuccessful Responses envelope is not a malformed model action. */
export function responseStateError(raw) {
  const code=String(raw?.error?.code??raw?.error?.type??'');
  const reason=raw?.status==='incomplete'?raw.incomplete_details?.reason:null;
  const permanent=['invalid_prompt','invalid_request_error','content_filter','content_policy_violation','context_length_exceeded'].includes(code)
    ||reason==='content_filter';
  const failure_reason=['rate_limit_exceeded','rate_limit_error'].includes(code)?'rate_limit'
    :['authentication_error','permission_error'].includes(code)?'auth':permanent?'api_error':'server';
  const error=new ModelError(raw?.status==='incomplete'
    ?`Incomplete response: ${reason??'unknown'}; no partial action executed`
    :`Response ${raw?.status??'failed'}: ${String(raw?.error?.message??(code||'unknown error')).slice(0,300)}`,
    {retryable:!permanent&&failure_reason!=='auth'});
  error.failure_scope='request';error.failure_reason=failure_reason;error.response_raw=raw;
  return error;
}

export function truncatedToolReply(raw,latency_ms=0) {
  const error=toolContractError('Response truncated at max_output_tokens; no partial action was applied. Return one concise act tool call',raw);
  if(raw?.status==='incomplete'&&raw.incomplete_details?.reason==='max_output_tokens'||raw?.stop_reason==='max_tokens') {
    const u=raw.usage??{};
    error.repair_result={tool_call:null,text:'',raw,latency_ms,contract_error:error.message,
      usage:{input_tokens:(u.input_tokens??0)+(u.cache_creation_input_tokens??0)+(u.cache_read_input_tokens??0),output_tokens:u.output_tokens??0}};
  }
  return error;
}

export const ACT_NORMALIZATION='controller-semantics-v1';
const XML_PARAM=/<parameter name="([A-Za-z_]+)">([\s\S]*?)(?=<\/parameter>|<parameter name=|$)/g;
const XML_TAIL=/\s*(?:<\/(?:parameter|note|note_to_self)>\s*)+$/;

/** Structural act repairs that only reproduce what parseActReply already accepts (notes clipped to
 *  500/2000, a missing note read as ''), plus unambiguous relocation of top-level fields the model
 *  placed inside `action` and leaked `<parameter name=…>` tool syntax. The action itself is never
 *  changed, guessed or defaulted; every repair is recorded. */
export function normalizeActInput(schema,input) {
  const repairs=[];
  if(!input||typeof input!=='object'||Array.isArray(input))return {input,repairs};
  const top=new Set(Object.keys(schema.properties??{}));
  let out={...input};
  if(out.action&&typeof out.action==='object'&&!Array.isArray(out.action)) {
    let action={...out.action};
    if(action.action&&typeof action.action==='object'&&!Array.isArray(action.action)&&action.type==null) {
      const {action:inner,...rest}=action;action={...inner};
      for(const [k,v] of Object.entries(rest))if(top.has(k)&&!Object.hasOwn(out,k)){out[k]=v;repairs.push('unwrapped_action.'+k);}else action[k]=v;
      repairs.push('unwrapped_nested_action');
    }
    for(const k of ['note','note_to_self','wake_on','wait_minutes'])
      if(top.has(k)&&Object.hasOwn(action,k)&&(!Object.hasOwn(out,k)||JSON.stringify(out[k])===JSON.stringify(action[k]))){
        if(!Object.hasOwn(out,k))out[k]=action[k];delete action[k];repairs.push('relocated_action.'+k);}
    out.action=action;
  }
  for(const field of ['note','note_to_self']) {
    const value=out[field];
    if(typeof value!=='string'||!value.includes('<parameter name="'))continue;
    const head=value.slice(0,value.indexOf('<parameter name="')).replace(XML_TAIL,'');
    const found=[...value.matchAll(XML_PARAM)].map(m=>[m[1],m[2].replace(XML_TAIL,'').trim()]);
    if(!found.length||!found.every(([k])=>top.has(k)&&k!=='action'&&k!==field&&!Object.hasOwn(out,k)))continue;
    out[field]=head;
    for(const [k,v] of found){let parsed=v;if(k!=='note'&&k!=='note_to_self'){try{parsed=JSON.parse(v);}catch{continue;}}out[k]=parsed;}
    repairs.push('split_leaked_parameter_syntax.'+field);
  }
  if(top.has('note')&&out.note==null){out.note='';repairs.push('missing_note_read_as_empty');}
  for(const [field,limit] of [['note',schema.properties?.note?.maxLength],['note_to_self',schema.properties?.note_to_self?.maxLength]])
    if(typeof out[field]==='string'&&Number.isInteger(limit)&&out[field].length>limit){repairs.push(`clipped_${field}_${out[field].length}_to_${limit}`);out[field]=out[field].slice(0,limit);}
  return {input:out,repairs};
}

/** Fail closed if a relay ignores strict mode. Never infer or manufacture an action. */
export function enforceToolContract(result,tools,provider,{calls=1,allowActText=false,normalizeAct=null}={}) {
  try {
    if(calls>1)throw Error('Multiple tool calls despite serial tool contract');
    if(result.tool_call) {
      const tool=tools.find(t=>t.name===result.tool_call.name);
      if(!tool)throw Error('Unadvertised tool name');
      if(normalizeAct!=null&&normalizeAct!==ACT_NORMALIZATION)throw Error('Unknown act normalization');
      const normalized=normalizeAct&&tool.name==='act'?normalizeActInput(tool.input_schema,result.tool_call.input):{input:result.tool_call.input,repairs:[]};
      const contract=compileToolContract(tool,provider),input=contract.parse(normalized.input);
      const validation={...(!contract.wireConformant(normalized.input)?{wire_conformant:false,compatibility:'omitted_optional_fields'}:{}),
        ...(normalized.repairs.length?{normalization:ACT_NORMALIZATION,repairs:normalized.repairs}:{})};
      return {...result,tool_call:{...result.tool_call,input},...(Object.keys(validation).length?{contract_validation:validation}:{})};
    }
    if(allowActText) {
      const tool=tools.find(t=>t.name==='act');
      if(!tool)throw Error('No act schema for structured final response');
      const input=compileToolContract(tool,provider).parse(JSON.parse(result.text));
      return {...result,text:JSON.stringify(input)};
    }
    throw Error(normalizeAct?'Required tool call absent: the reply ended with text or thinking only. Decide now and call the act tool once':'Required tool call absent');
  } catch(e){
    const error=toolContractError(e.message,result.raw);
    // Only a completed serial reply can enter the controller's bounded same-turn repair.
    // HTTP failures, refusals, truncation and parallel calls never reach this branch as repairable.
    if(calls<=1&&(!result.tool_call||result.tool_call.name==='act')&&result.raw)
      error.repair_result={...result,contract_error:error.message};
    throw error;
  }
}
