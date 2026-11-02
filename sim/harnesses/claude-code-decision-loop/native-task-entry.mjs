import assert from 'node:assert/strict';

// Only remove the exact, registered CLI command expansion for factual comparison.
// Original controller messages and native tool-result content remain untouched.
export function inspectTaskEntryMessages(messages,{skillName,skillRoot,entryBody}){
  const command=`<command-message>${skillName}</command-message>\n<command-name>/${skillName}</command-name>\n`;
  const body=`Base directory for this skill: ${skillRoot}\n\n${entryBody}\n`;
  const blocks=m=>typeof m.content==='string'?[{type:'text',text:m.content}]:m.content;
  const single=(m,role,text)=>m?.role===role&&blocks(m)?.length===1&&blocks(m)[0].type==='text'&&blocks(m)[0].text===text;
  const matches=messages.flatMap((m,i)=>m.role==='user'&&blocks(m)?.some(b=>b.type==='text'&&b.text===command)?[i]:[]);
  assert.equal(matches.length,1,'Expected exactly one registered native task command');
  const at=matches[0],expanded=blocks(messages[at]);
  assert.equal(expanded.length,2,'Unexpected extra native command content');
  assert.equal(expanded[0].type,'text');assert.equal(expanded[0].text,command);
  assert.equal(expanded[1].type,'text');assert.equal(expanded[1].text,body,'Native entry text or source directory changed');
  assert(single(messages[at-1],'assistant','No response requested.'),'Expected exact native pending-user separator');
  return {messages:messages.filter((_,i)=>i!==at&&i!==at-1),
    native_task_entry:{command:'/'+skillName,entry_loaded:true,model_selected_activation:false,native_pending_user_separator:true}};
}
