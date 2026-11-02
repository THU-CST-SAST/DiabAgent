// Code policies posing as a model, to exercise the whole bench pipeline without API calls.
// Config: {name, adapter:'scripted', policy:'wait'|'patient'|'oref0', wait_minutes?}
// complete() reads the structured observation the harness passes alongside the text (`obs`, whose
// `events` are all notices since the previous turn); it never parses the prompt. Usage is zero.
import {patientPolicy} from '../../policies/patient.mjs';
import {oref0Policy} from '../../policies/oref0.mjs';

const POLICIES={
  wait:()=>()=>({action:{type:'WAIT'},rationale:'scripted: no intervention'}),
  patient:()=>patientPolicy(),
  oref0:()=>obs=>oref0Policy(obs),
};
/** Default wait per policy: oref0 re-evaluates often (temp basals), the patient hourly, wait rarely. */
const DEFAULT_WAIT={wait:240,patient:60,oref0:15};

export function createScriptedModel(config) {
  const policy=config.policy??'patient';
  if(!POLICIES[policy])throw new Error(`Unknown scripted policy ${policy} (wait|patient|oref0)`);
  const waitMinutes=config.wait_minutes??DEFAULT_WAIT[policy];
  let decide=null,n=0;
  return {
    name:config.name??`scripted-${policy}`,adapter:'scripted',config,
    /** Policies are stateful: the harness asks for a fresh instance per episode (safe with parallel lanes). */
    forEpisode() {return createScriptedModel(config);},
    async complete({obs}) {
      if(!obs)throw new Error('scripted model needs the structured observation (obs)');
      decide??=POLICIES[policy]();
      const d=decide(obs);
      const input={action:d.action,wait_minutes:waitMinutes,note:String(d.rationale??'').slice(0,500)};
      return {tool_call:{id:`scripted_${n++}`,name:'act',input},text:'',usage:{input_tokens:0,output_tokens:0},latency_ms:0,raw:{scripted:policy,input}};
    },
  };
}
