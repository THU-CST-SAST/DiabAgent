// Explicitly registered gateway spelling only; never normalize other model families or versions.
export const REGISTERED_CODE_MODELS=Object.freeze(['claude-opus-5-5','glm-5.3','qwen3.8-max','deepseek-v4.1-flash-1017','kimi-k3.1-pro','kimi-k3','MiniMax-M3.1-Flash','doubao-seed-evolving','glm-5.3-flash']);
// Moonshot gateway spellings that need the explicit-type tool schema below.
export const MOONSHOT_MODELS=Object.freeze(['kimi-k3.1-pro','kimi-k3']);
export function assertRegisteredCodeModel(model){
  if(!REGISTERED_CODE_MODELS.includes(model))throw Error('Unregistered Claude Code experiment model');
}
// Moonshot requires an explicit type even when a homogeneous finite enum already fixes it.
export function codeToolSchema(schema,model){
  if(!MOONSHOT_MODELS.includes(model))return schema;
  if(Array.isArray(schema))return schema.map(s=>codeToolSchema(s,model));
  if(!schema||typeof schema!=='object')return schema;
  const out=Object.fromEntries(Object.entries(schema).map(([k,v])=>[k,codeToolSchema(v,model)]));
  if(!out.type&&Array.isArray(out.enum)&&out.enum.length){
    const types=new Set(out.enum.map(v=>v===null?'null':typeof v==='number'?(Number.isInteger(v)?'integer':'number'):typeof v));
    if(types.size===1&&['string','integer','number','boolean','null'].includes([...types][0]))out.type=[...types][0];
  }
  return out;
}
export function modelIdentityMatches(requested,returned){
  return requested===returned||(requested==='claude-opus-5-5'&&returned==='claude-opus-5.5');
}
