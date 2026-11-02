import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export const PREFIX = 'mcp__experiment__';
export const NATIVE_RESUME_CONTROL = 'Continue from where you left off.';
export function codeMessages(messages) {
  return messages.map(m => ({...m, content: Array.isArray(m.content)
    ? m.content.map(b => b.type === 'tool_use' && !b.name.startsWith(PREFIX) ? {...b, name: PREFIX + b.name} : b) : m.content}));
}

export function sessionEntries(messages, {sessionId, cwd, model = 'claude-opus-5-5'}) {
  let parentUuid = null;
  return messages.map((message, i) => {
    const uuid = randomUUID();
    const entry = {parentUuid, isSidechain: false, type: message.role,
      ...(message.role === 'assistant' ? {apiBlockIndex: 0} : {}),
      message: message.role === 'assistant'
        ? {id: 'msg_seed_' + i, type: 'message', model, stop_reason: 'tool_use', ...message}
        : message,
      uuid, timestamp: new Date().toISOString(), userType: 'external', entrypoint: 'sdk-cli',
      cwd, sessionId, version: '2.1.296', gitBranch: 'HEAD'};
    parentUuid = uuid;
    return entry;
  });
}

function normalize(value, keepThinking = false) {
  if (Array.isArray(value)) return value.filter(b => keepThinking || !['thinking', 'redacted_thinking'].includes(b?.type)).map(b => normalize(b, keepThinking));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key, v]) => key !== 'cache_control'
    && !(key === 'caller' && v?.type === 'direct')).map(([key, v]) =>
    [key, key === 'content' && typeof v === 'string' ? [{type: 'text', text: v}] : normalize(v, keepThinking)]));
}

function singleText(message, role, text) {
  const content = typeof message?.content === 'string' ? [{type: 'text', text: message.content}] : message?.content;
  return message?.role === role && content?.length === 1 && content[0].type === 'text' && content[0].text === text;
}

function factualMessages(messages, keepThinking = false) {
  const merged=[];
  for(const message of normalize(messages, keepThinking)){
    const prior=merged.at(-1);
    if(prior?.role===message.role&&Array.isArray(prior.content)&&Array.isArray(message.content))
      prior.content.push(...message.content);
    else merged.push(structuredClone(message));
  }
  return merged;
}

export function assertCodeRequest(expected, actual, {resumed}) {
  const fail = reason => {const e = new Error('Code harness request guard: ' + reason);e.code = 'CODE_INPUT_MISMATCH';throw e;};
  if (actual.model !== expected.model || actual.max_tokens !== expected.max_tokens
    || actual.output_config?.effort !== expected.output_config?.effort) fail('model/output/effort changed');
  const system = typeof expected.system === 'string' ? expected.system : expected.system.map(b => b.text).join('\n');
  if (!actual.system?.some(b => b.type === 'text' && b.text === system)) fail('v6 system text not preserved');
  if (actual.system.filter(b => b.text === system).length !== 1
    || actual.system.some(b => b.type !== 'text' || (b.text !== system
      && b.text !== "You are a Claude agent, built on Anthropic's Claude Agent SDK."
      && !/^x-anthropic-billing-header: cc_version=2\.1\.296(?:\.[a-f0-9]+)?; cc_entrypoint=sdk-cli;$/.test(b.text))))
    fail('unexpected additional system instructions');
  const names = expected.tools.map(t => PREFIX + t.name).sort();
  if (!isDeepStrictEqual(actual.tools?.map(t => t.name).sort(), names)) fail('unexpected tool set');
  for (const t of expected.tools) {
    const wire = actual.tools.find(x => x.name === PREFIX + t.name);
    if (wire.description !== t.description || !isDeepStrictEqual(normalize(wire.input_schema), normalize(t.input_schema)))
      fail('tool schema or description changed: ' + t.name);
  }
  let messages = actual.messages.filter(m => !(m.role === 'system' && Array.isArray(m.content) && m.content.length === 0));
  const expectedFacts = factualMessages(codeMessages(expected.messages));
  let nativeResumeControlAdded = false;
  if (resumed && !isDeepStrictEqual(expectedFacts, factualMessages(messages))) {
    // Code appends its exact resume control to the resumed tail; in a decision loop that tail can be followed
    // by later in-process turns, so accept exactly one such final user block wherever it sits, nothing else.
    const at = messages.flatMap((m, i) => m.role === 'user' && Array.isArray(m.content)
      && singleText({role: 'user', content: m.content.slice(-1)}, 'user', NATIVE_RESUME_CONTROL) ? [i] : []);
    if (at.length !== 1) fail('unexpected native automatic-resume control');
    messages = structuredClone(messages);
    messages[at[0]].content.pop();
    if (!messages[at[0]].content.length) messages.splice(at[0], 1);
    nativeResumeControlAdded = true;
  }
  if (!isDeepStrictEqual(expectedFacts, factualMessages(messages)))
    fail('factual history/notes/glucose/receipts changed');
  const thoughts=rows=>rows.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>['thinking','redacted_thinking'].includes(b.type));
  if(!isDeepStrictEqual(thoughts(codeMessages(expected.messages)),thoughts(messages)))fail('signed thinking history changed');
  if(!isDeepStrictEqual(factualMessages(codeMessages(expected.messages),true),factualMessages(messages,true)))
    fail('signed history block binding changed');
  return {factual_history_preserved: true, thinking_history_preserved:true, original_messages: expected.messages.length,
    native_resume_control_added:nativeResumeControlAdded, added_synthetic_assistant_resume:false,
    signed_history_block_binding_preserved:true,
    actual_messages: actual.messages.length, resumed, strict_generation: false, local_schema_validation: true,
    differences: ['MCP tool namespace', 'Claude Agent SDK identity/billing prefix', 'native thinking/context controls',
      ...(resumed ? ['native automatic interrupted-turn continuation; optional exact native control text, no added assistant No response requested. turn'] : [])]};
}
