import {KNOWLEDGE} from '../knowledge.mjs';
import {buildInstanceConfig} from '../sim/instance.mjs';
import {SimEnv} from '../env/pomdp.mjs';
import {toolSchema,simulateToolSchema} from '../bench/prompt.mjs';
import {glucoseHistoryTool} from '../bench/glucose-history.mjs';

/** Three bounded, inert interface requests using real schemas, never a patient/benchmark trajectory. */
export async function probeToolContract(model) {
  const env=new SimEnv(buildInstanceConfig({...KNOWLEDGE.instances.adult_dana_g6.spec,seed:1}));
  const obs=env.observe(),tools=[toolSchema(obs,{notes:true,hourly:true}),simulateToolSchema(obs,{calls:1}),glucoseHistoryTool];
  const messages=[],responses=[];
  const system='This is an inert API contract check, not patient care or a benchmark decision. No hardware or patient is connected. '
    +'Follow the tool requested at each step. All tool results are synthetic fixtures. Do not perform any other task.';
  const stages=[{name:'read_glucose_history',text:'Call read_glucose_history using its default query settings. Do not call act yet.',result:{ok:true,readings:[],next_offset:null}},
    {name:'simulate',text:'Now call simulate with action {"type":"WAIT"}. This is an inert hypothetical check.',result:{ok:true,text:'Synthetic fixture only: glucose unchanged.'}},
    {name:'act',text:'Finish with act: action {"type":"WAIT"} and a short note. Omit wait_minutes for the next fixed hourly slot, or explicitly set it to60. Leave persistent notes unchanged.'}];
  for(const stage of stages) {
    messages.push({role:'user',content:stage.text});
    const response=await model.complete({system,messages:[...messages],tools});
    const name=response.tool_call?.name??(stage.name==='act'?'act':null);
    responses.push({stage:stage.name,response});
    if(name!==stage.name)return {ok:false,error:`Expected ${stage.name}, received ${name??'no tool'}`,responses};
    if(stage.name==='act') {
      const input=response.tool_call?.input??JSON.parse(response.text);
      if(input.action?.type!=='WAIT'||(input.wait_minutes??60)!==60)return {ok:false,error:'Inert act check was not followed',responses};
    } else messages.push({role:'assistant',content:response.text??'',tool_call:response.tool_call,
      ...(response.provider?{provider:response.provider}:{})},
      {role:'user',tool_result_for:response.tool_call.id,content:JSON.stringify(stage.result)});
  }
  return {ok:true,responses};
}
