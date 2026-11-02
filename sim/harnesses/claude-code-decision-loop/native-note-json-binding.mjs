import {isDeepStrictEqual} from 'node:util';

// Select an original native JSON message, never a rewritten stream response.
export function nativeNoteJsonBinding(stream,candidates){
  const uses=stream.content?.filter(b=>b.type==='tool_use')??[];
  if(stream.stop_reason!=='tool_use'||uses.length!==1)return null;
  const use=uses[0],note=use.input?.note;
  if(typeof note!=='string'||!/(?<!\\)\\u[0-9a-fA-F]{4}/.test(note))return null;
  const decodedForComparison=note.replace(/(?<!\\)\\u([0-9a-fA-F]{4})/g,(_,h)=>String.fromCharCode(parseInt(h,16)));
  const matches=candidates.filter(candidate=>{
    if(candidate.id!==stream.id)return false;
    const tools=candidate.content?.filter(b=>b.type==='tool_use')??[];
    if(tools.length!==1||tools[0].id!==use.id||typeof tools[0].input?.note!=='string')return false;
    if(tools[0].input.note!==decodedForComparison)return false;
    const a=structuredClone(stream),b=structuredClone(candidate);
    delete a.content.find(x=>x.type==='tool_use').input.note;
    delete b.content.find(x=>x.type==='tool_use').input.note;
    return isDeepStrictEqual(a,b);
  });
  return matches.length===1?matches[0]:null;
}

export function nativeStreamJsonNote(stream,events,receipts){
  const use=stream.content?.filter(b=>b.type==='tool_use');
  if(stream.stop_reason!=='tool_use'||use?.length!==1||use[0].name!=='mcp__experiment__act')return null;
  const chunks=events.filter(e=>e.type==='assistant'&&e.message?.id===stream.id);
  if(!chunks.length)return null;
  const first=chunks[0];
  for(const e of chunks){
    const m=e.message;
    if(e.session_id!==first.session_id||e.parent_tool_use_id!==first.parent_tool_use_id)return null;
    if(m.type!==stream.type||m.role!==stream.role||m.model!==stream.model||m.stop_reason!==null||m.context_management!==null)return null;
    if(!m.usage||!Object.values(m.usage).every(v=>v===0))return null;
    if(Object.keys(m).some(k=>!['id','type','role','content','model','stop_reason','usage','context_management'].includes(k)))return null;
    if(!Array.isArray(m.content))return null;
  }
  const candidate={...stream,content:chunks.flatMap(e=>e.message.content)};
  const chosen=nativeNoteJsonBinding(stream,[candidate]);
  if(!chosen)return null;
  const tool=chosen.content.find(b=>b.type==='tool_use');
  const matching=receipts.filter(r=>r._meta?.['claudecode/toolUseId']===tool.id&&'mcp__experiment__'+r.name===tool.name&&isDeepStrictEqual(r.arguments,tool.input));
  if(matching.length!==1)return null;
  return chosen;
}
