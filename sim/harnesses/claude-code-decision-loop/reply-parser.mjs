import {modelIdentityMatches} from './model-identity.mjs';

export function parseCodeStream(text,{model}={}){
  if(text.trimStart().startsWith('{')){
    const message=JSON.parse(text);
    if(message.error)return parseCodeStream('data: '+JSON.stringify({type:'error',error:message.error})+'\n',{model});
    if(message.type!=='message'||message.role!=='assistant'||!message.id||!Array.isArray(message.content)
      ||!['tool_use','end_turn','max_tokens','refusal'].includes(message.stop_reason)){
      const error=new Error('Incomplete Claude Code JSON message; no action accepted');error.status=502;throw error;
    }
    if(model&&!modelIdentityMatches(model,message.model))throw new Error('Returned model identity mismatch');
    for(const block of message.content){
      if(!block||typeof block.type!=='string')throw new Error('Invalid Claude Code JSON content block');
      if(block.type==='tool_use'&&(!block.id||typeof block.name!=='string'||!Object.hasOwn(block,'input')))
        throw new Error('Incomplete Claude Code JSON tool block; no action accepted');
    }
    return {raw:message,unparsed:message.content.filter(b=>b.type==='tool_use'&&b.input?.__unparsedToolInput).length};
  }
  const events=text.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).filter(l=>l&&l!=='[DONE]').map(JSON.parse);
  let message,stopped=false;const inputs=new Map();let unparsed=0;
  for(const e of events){
    if(e.type==='message_start')message={...e.message,content:[]};
    else if(e.type==='content_block_start'&&message)message.content[e.index]=structuredClone(e.content_block);
    else if(e.type==='content_block_delta'&&message){const block=message.content[e.index],d=e.delta;
      if(d.type==='text_delta')block.text=(block.text??'')+d.text;
      else if(d.type==='thinking_delta')block.thinking=(block.thinking??'')+d.thinking;
      else if(d.type==='signature_delta')block.signature=(block.signature??'')+d.signature;
      else if(d.type==='input_json_delta')inputs.set(e.index,(inputs.get(e.index)??'')+d.partial_json);
    }else if(e.type==='message_delta'&&message){Object.assign(message,e.delta);message.usage={...message.usage,...e.usage};}
    else if(e.type==='message_stop')stopped=true;
    else if(e.type==='error'){
      const error=new Error('Streaming API error: '+JSON.stringify(e.error)),type=e.error?.type,text=e.error?.message??'';
      const status={rate_limit_error:429,overloaded_error:529,api_error:500,invalid_request_error:400,authentication_error:401,permission_error:403,not_found_error:404,billing_error:402}[type];
      error.status=status??(type==='upstream_error'?(/forbidden|unauthori[sz]ed|permission|invalid.*key|account.*(disabled|suspend)/i.test(text)?403:/timeout|timed out/i.test(text)?504:/temporarily unavailable|overload|capacity|busy/i.test(text)?503:502):undefined);
      error.stream_error_type=type;throw error;
    }
  }
  if(!message||!stopped){const e=new Error('Incomplete Claude Code model stream; no action accepted');e.status=502;throw e;}
  for(const [i,fragment]of inputs){try{message.content[i].input=JSON.parse(fragment);}catch{
    message.content[i].input={__unparsedToolInput:{raw:fragment,len:fragment.length}};unparsed++;
  }}
  if(model&&!modelIdentityMatches(model,message.model))throw new Error('Returned model identity mismatch');
  return {raw:message,unparsed};
}
