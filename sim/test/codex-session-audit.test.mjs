import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {inspectCodexSession} from '../harnesses/codex-decision-loop/session-audit.mjs';
import {adaptCodexWire} from '../harnesses/codex-decision-loop/transport.mjs';
import {parseInvocations} from '../harnesses/claude-code-decision-loop/runtime/src/bench/models/invocation-log.mjs';

const trial=process.env.CODEX_AUDIT_TRIAL;
const read=f=>JSON.parse(fs.readFileSync(f)),write=(f,x)=>fs.writeFileSync(f,JSON.stringify(x));
test('independent native session audit rejects fabricated facts/results/schema despite saved green flags',{skip:!trial},()=>{
 const location=trial+'/Codex/session-1',calls=parseInvocations(fs.readFileSync(trial+'/invocations.jsonl','utf8'),{strict:true}),modelConfig={strict_tool_names:['act','read_glucose_history']};
 assert(inspectCodexSession(location,{calls,modelConfig}).independent_factual_contexts);
 function copy(){
  const dir=fs.mkdtempSync(os.tmpdir()+'/codex-audit-negative-');fs.mkdirSync(dir+'/native');
  for(const f of fs.readdirSync(location).filter(f=>f.endsWith('.json')))fs.copyFileSync(location+'/'+f,dir+'/'+f);
  fs.cpSync(location+'/transport',dir+'/transport',{recursive:true});
  for(const f of ['stdout.jsonl','client.jsonl','KNOWLEDGE-REGISTRATION.json','NATIVE-KNOWLEDGE-LEDGER.json'])fs.copyFileSync(location+'/native/'+f,dir+'/native/'+f);
  return dir;
 }
 const honest=copy(),fact=read(honest+'/FACTS-1.json');for(const k of ['system_exact','factual_history_exact','native_entry_exact','only_registered_native_catalog'])fact[k]=false;write(honest+'/FACTS-1.json',fact);
 assert(inspectCodexSession(honest,{calls,modelConfig}).independent_factual_contexts,'Stored flags must not be the evidence');
 const altered=copy(),before=read(altered+'/transport/1-NATIVE-REQUEST.json'),registration=read(altered+'/transport/REGISTRATION.json');
 const observation=before.input.find(i=>i.role==='user'&&i.content?.[0]?.text?.includes('current context'));assert(observation);observation.content[0].text+='\nFABRICATED_OBSERVATION';
 write(altered+'/transport/1-NATIVE-REQUEST.json',before);write(altered+'/transport/1-UPSTREAM-REQUEST.json',adaptCodexWire(before,registration.toolPolicy,{instructions:registration.instructions??null}).body);
 assert.throws(()=>inspectCodexSession(altered,{calls,modelConfig}),/commitment|history|output changed/i);
 const schema=copy(),policy=read(schema+'/transport/REGISTRATION.json');policy.toolPolicy[0].description+=' changed';write(schema+'/transport/REGISTRATION.json',policy);assert.throws(()=>inspectCodexSession(schema,{calls,modelConfig}));
 const ledger=copy();write(ledger+'/native/NATIVE-KNOWLEDGE-LEDGER.json',{attempts:[{tool:'Read',allowed:true}]});assert.throws(()=>inspectCodexSession(ledger,{calls,modelConfig}));
 const response=copy(),raw=read(response+'/NATIVE-REPLY-1.json');raw.output[0].arguments=JSON.stringify({action:{type:'WAIT'},note:'Fabricated native result'});write(response+'/NATIVE-REPLY-1.json',raw);assert.throws(()=>inspectCodexSession(response,{calls,modelConfig}));
});
