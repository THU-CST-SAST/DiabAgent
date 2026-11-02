import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export function evaluateNativeRead(config,state,event){
  const input=event.tool_input??{},id=event.tool_use_id;
  if(typeof id!=='string'||!id)return {allowed:false,reason:'Missing native tool identity'};
  const previous=state.attempts.find(t=>t.id===id);
  if(previous){
    if(JSON.stringify(previous.input)!==JSON.stringify(input)||previous.tool!==event.tool_name)
      return {allowed:false,reason:'Native tool identity changed arguments'};
    return previous;
  }
  const row={id,tool:event.tool_name,input,allowed:false,at:new Date().toISOString()};
  try{
    if(event.tool_name==='Skill'){
      if(input.skill!==config.skill_name||input.args?.trim())throw Error('Only the pinned knowledge Skill without extra arguments is allowed');
      row.allowed=true;row.source_sha256=config.assets_sha256;
    }else if(event.tool_name==='Read'){
      const file=fs.realpathSync(input.file_path);
      const rel=path.relative(config.skill_root,file);
      if(!Object.hasOwn(config.files,rel)||!file.startsWith(config.skill_root+path.sep))throw Error('Read only pinned Skill Markdown, not other runtime or patient files');
      const bytes=fs.readFileSync(file),digest=createHash('sha256').update(bytes).digest('hex');
      if(digest!==config.files[rel])throw Error('Pinned knowledge changed');
      const offset=input.offset??1,limit=input.limit??2000;
      if(!Number.isInteger(offset)||offset<1||!Number.isInteger(limit)||limit<1)throw Error('Read uses positive line offsets and limits');
      const lines=bytes.toString('utf8').split('\n'),text=lines.slice(offset-1,offset-1+limit).join('\n');
      if(text.length>48000)throw Error('Reference page exceeds48000characters; reduce the native line limit');
      if(state.attempts.filter(t=>t.tool==='Read'&&t.allowed).length>=config.max_reads)
        throw Error('Original reference budget exhausted; use existing knowledge or act');
      Object.assign(row,{allowed:true,path:rel,offset_lines:offset,limit_lines:limit,characters:text.length,
        source_sha256:digest,algorithm_section_covered:rel==='references/07-pump-basal-bolus-and-closed-loop.md'
          &&text.includes('Two closed-loop controllers in this benchmark')&&text.includes('B4')});
    }else throw Error('Unexpected native hook tool');
  }catch(e){row.reason=e.message;}
  state.attempts.push(row);return row;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let lock,owned=false;
  try{
    if(process.env.ANTHROPIC_API_KEY||process.env.ANTHROPIC_AUTH_TOKEN)throw Error('Budget hook must not inherit credentials');
    const file=path.resolve(process.argv[2]),config=JSON.parse(fs.readFileSync(file,'utf8'));
    let text='';for await(const chunk of process.stdin)text+=chunk;
    const event=JSON.parse(text);lock=config.ledger+'.lock';
    for(let n=0;n<100;n++){
      try{fs.closeSync(fs.openSync(lock,'wx',0o600));owned=true;break;}catch(e){if(e.code!=='EEXIST')throw e;await new Promise(r=>setTimeout(r,10));}
    }
    if(!owned){lock=null;throw Error('Native read-budget ledger busy; no read approved');}
    const state=JSON.parse(fs.readFileSync(config.ledger,'utf8')),result=evaluateNativeRead(config,state,event);
    fs.writeFileSync(config.ledger+'.tmp',JSON.stringify(state,null,2)+'\n',{mode:0o600});fs.renameSync(config.ledger+'.tmp',config.ledger);
    if(!result.allowed)process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:result.reason}})+'\n');
  }catch(e){process.stderr.write('Native knowledge boundary: '+e.message+'\n');process.exitCode=2;}
  finally{if(owned&&lock){try{fs.unlinkSync(lock);}catch(e){process.stderr.write('Native knowledge lock cleanup failed\n');process.exitCode=2;}}}
}
