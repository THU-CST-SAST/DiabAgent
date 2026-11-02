import assert from 'node:assert/strict';
import fs from 'node:fs';

export async function startBenchmarkThread(rpc,{system,tools,model='gpt-6.1-sol'}){
  assert(typeof system==='string'&&system.length>0);
  const names=new Set(['act','simulate','read_glucose_history','Read','Skill']);
  assert(tools.every(t=>names.has(t.name)),'No unrelated tools in a benchmark thread');
  await rpc.request('initialize',{clientInfo:{name:'sweetbench',version:'1'},capabilities:{experimentalApi:true}});
  rpc.notify('initialized');
  const listed=await rpc.request('skills/list',{cwds:[rpc.root+'/workspace'],forceReload:true});
  // Disable only the isolated runtime's bundled catalog, never the user's coding skills.
  let pinned=0;
  for(const data of listed.data??[])for(const skill of data.skills??[]){
    const selected=!!rpc.knowledge&&fs.realpathSync(skill.path)===fs.realpathSync(rpc.knowledge.path);
    if(selected){assert.equal(skill.name,'blood-glucose-management');pinned++;}
    else await rpc.request('skills/config/write',{path:skill.path,enabled:false});
  }
  if(rpc.knowledge)assert.equal(pinned,1,'Native Codex must discover exactly the pinned Skill');
  return rpc.request('thread/start',{
    model,baseInstructions:system,developerInstructions:'',
    cwd:rpc.root+'/workspace',approvalPolicy:'never',sandbox:'read-only',environments:[],experimentalRawEvents:true,
    config:{model_reasoning_effort:'high',project_doc_max_bytes:0,web_search:'disabled',
      include_collaboration_mode_instructions:false,include_permissions_instructions:false,
      'tools.update_plan.enabled':false,'tools.experimental_request_user_input.enabled':false,
      include_environment_context:false,include_environment_context_time:false,
      'features.shell_tool':false,'features.unified_exec':false,'features.apply_patch_freeform':false,
      'features.apps':false,'features.multi_agent_v2':false,'features.code_mode':false,
      'features.goals':false,'features.skip_host_skill_discovery':!rpc.knowledge,'features.context_management':false},
    dynamicTools:tools.map(t=>({type:'function',name:t.name,description:t.description,inputSchema:t.input_schema}))
  });
}
