import {parseAgentOptions,gatingActive} from '../bench/agent-options.mjs';
import {POLICY_AGENTS} from './agents.mjs';
import {baselineAgentOptions,baselinePolicyProtocol} from '../bench/hourly-policy.mjs';

/** Explicit hourly mode is supported for models and observation-only policies. */
export function executionProtocol(agent,options=null) {
  const opts=effectiveAgentOptions(agent,options),llm=agent.startsWith('llm:')||agent==='llm';
  if(llm)return opts.decision_schedule==='hourly'
    ?{kind:'llm-hourly',fixed_interval_minutes:60,max_extra_decisions_per_day:opts.max_extra_decisions_per_day,
      label:`LLM: fixed 60 min + up to ${opts.max_extra_decisions_per_day} extra decisions per local day`}
    :{kind:'llm-event-driven',minimum_interval_minutes:opts.min_decision_minutes,label:'LLM: event-driven controller'};
  if(!POLICY_AGENTS.includes(agent))return {kind:'external',label:'External agent: independently specified protocol'};
  if(opts.decision_schedule==='hourly')return baselinePolicyProtocol(opts);
  if(gatingActive(opts))return {kind:'policy-legacy-gated',minimum_interval_minutes:opts.min_decision_minutes,
    max_decisions_per_day:opts.max_decisions_per_day,label:'Baseline: explicit legacy decision gating'};
  return {kind:'policy-per-step',fixed_interval_minutes:5,label:'Baseline: native 5 min policy decisions'};
}

export function effectiveAgentOptions(agent,options=null) {
  return POLICY_AGENTS.includes(agent)?baselineAgentOptions(agent,options):parseAgentOptions(options);
}
