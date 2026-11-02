import fs from 'node:fs';
import {captureNativeRuntimeCheckpoint} from './native-runtime-recovery.mjs';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { toAnthropicMessages } from './runtime/src/bench/models/anthropic.mjs';
import { compileToolContract, enforceToolContract, toolContractError, truncatedToolReply } from './runtime/src/bench/models/tool-contract.mjs';
import { ModelError, retryableStatus } from './runtime/src/bench/models/http.mjs';
import { DecisionLoopSession, LOOP_TOOLS } from './native-session.mjs';
import { PREFIX } from './history.mjs';
import { STANDARD_HARNESS } from './standard.mjs';
import {emptyTerminalDeadline} from './deadline-policy.mjs';
import {NATIVE_SKILL_VERSION,validateKnowledgeGuidance} from './native-skill.mjs';
import {inspectNativeQueryFailure} from './native-query-wait.mjs';
import {createHash} from 'node:crypto';
import {inspectEmptyGatewayFailure} from './gateway-wait.mjs';
import {captureNativeSegmentCheckpoint,inspectNativeHistoryRetry} from './native-history-checkpoint.mjs';
import {assertRegisteredCodeModel,codeToolSchema} from './model-identity.mjs';

export function compileControllerRequest(config, { system, messages, tools }) {
  assertRegisteredCodeModel(config.model); assert(Number.isInteger(config.max_tokens)&&config.max_tokens>0);
  // Output cap and reasoning effort are independently registered; both high and max are supported.
  assert(typeof (config.reasoning_effort??config.effort)==='string'); assert.equal(typeof config.strict_tools,'boolean');
  return { model: config.model, max_tokens: config.max_tokens, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages: toAnthropicMessages(messages), tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: codeToolSchema(compileToolContract(t, 'anthropic').schema,config.model), strict: config.strict_tools&&(config.strict_tool_names == null || config.strict_tool_names.includes(t.name)) })), output_config: { effort: config.reasoning_effort ?? config.effort }, thinking: config.thinking, tool_choice: { type: 'auto', disable_parallel_tool_use: true } };
}

/**
 * When the controller's next request equals the live decision's request plus exactly the assistant query-tool
 * call and its tool_result, returns the controller answer to hand back through MCP; otherwise null.
 */
export function decisionContinuation(previous, next, useId) {
  if (!previous || !useId || next.messages.length !== previous.messages.length + 2) return null;
  if (!isDeepStrictEqual(next.system, previous.system) || !isDeepStrictEqual(next.tools, previous.tools)) return null;
  if (!isDeepStrictEqual(next.messages.slice(0, previous.messages.length), previous.messages)) return null;
  const [assistant, user] = next.messages.slice(-2);
  const uses = (assistant.content ?? []).filter(b => b.type === 'tool_use');
  if (assistant.role !== 'assistant' || uses.length !== 1 || uses[0].id !== useId) return null;
  const results = Array.isArray(user.content) ? user.content : [];
  if (user.role !== 'user' || results.length !== 1 || results[0].type !== 'tool_result' || results[0].tool_use_id !== useId) return null;
  const content = results[0].content;
  const text = typeof content === 'string' ? content : Array.isArray(content) && content.every(b => b.type === 'text') ? content.map(b => b.text).join('') : null;
  return text == null ? null : { text, is_error: !!results[0].is_error };
}

export function createDecisionLoopModel({ config, root, key, binary, registration, offlineEndpoint, timeoutMs, nativeSkillAssetsRoot=null, nativeKnowledgeGuidance='legacy-v1', nativeSkillEntry='automatic', initialParallelCorrection=null, initialNativeHistoryCheckpoint=null, releaseClosedSessions=false, maxTurns = STANDARD_HARNESS.max_native_turns_per_decision, initialSessionMaxTurns = maxTurns, maxReferenceReads=3 }) {
  assert(['automatic','task-command-v1'].includes(nativeSkillEntry),'Unknown native Skill entry mode');
  assert(nativeSkillAssetsRoot||nativeSkillEntry==='automatic','Task Skill entry requires native Skill mode');
  validateKnowledgeGuidance(nativeKnowledgeGuidance);
  assert(nativeSkillAssetsRoot||nativeKnowledgeGuidance==='legacy-v1','Knowledge guidance requires native Skill mode');
  assert.ok(Number.isInteger(initialSessionMaxTurns) && initialSessionMaxTurns >= 1 && initialSessionMaxTurns <= maxTurns);
  if(initialNativeHistoryCheckpoint){assert(!initialParallelCorrection);assert.equal(initialNativeHistoryCheckpoint.attestation.remaining_native_turns,initialSessionMaxTurns);}
  fs.mkdirSync(root, { recursive: false });
  const sessions = [];
  const knowledgeOps=()=>sessions.flatMap(s=>s.nativeInternal??[]).flatMap(r=>r.operations);
  const knowledgeStats=()=>({native_skill_mode:NATIVE_SKILL_VERSION,native_skill_invocations:knowledgeOps().filter(o=>o.tool==='Skill'&&o.allowed&&!o.result.is_error).length,
    native_reference_reads:knowledgeOps().filter(o=>o.tool==='Read'&&o.allowed&&!o.result.is_error).length,
    native_reference_denials:knowledgeOps().filter(o=>o.tool==='Read'&&(!o.allowed||o.result.is_error)).length});
  let busy = false, closed = false, current, live = null, nativeCalls = 0, continuations = 0, nativeCorrections = 0;
  let firstReplyAccepted=false,queryRetry=null,checkpointReplyReceived=false,nativeHistoryRetry=null;
  return {
    name: config.name ?? 'claude-Code-decision-loop-v1', adapter: 'anthropic', config: { ...config, native_Code_direct: true, native_decision_loop: true },
    async complete(request) {
      assert.ok(!closed && !busy, 'Closed model or parallel calls inside one trajectory');
      busy = true;
      try {
        const expected = compileControllerRequest(config, request),attemptStarted=Date.now();
        const activeCheckpoint=nativeHistoryRetry?.registration??(!firstReplyAccepted&&!checkpointReplyReceived?initialNativeHistoryCheckpoint:null);
        const requestBudget=activeCheckpoint?.attestation.remaining_logical_ms??timeoutMs;
        const retainRuntime=async()=>{
          await current.close();
          const remainingLogicalMs=requestBudget-Math.max(Date.now()-attemptStarted,current.turns.at(-1)?.elapsed_ms??0);
          const registration=captureNativeRuntimeCheckpoint({sessionDir:current.root,expected,remainingLogicalMs});
          const digest=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
          const checkpoint={registration,expected,failed_session:current.root,failed_session_sha256:digest(current.root+'/SESSION.json'),failed_stdout_sha256:digest(current.root+'/stdout.jsonl')};
          const proof=inspectNativeHistoryRetry(checkpoint);
          current.save('REGISTERED-NATIVE-RETRY.json',{...checkpoint,proof});
          nativeHistoryRetry=checkpoint;queryRetry=null;return checkpoint;
        };
        const answer = live?.session.alive ? decisionContinuation(live.expected, expected, live.receipt._meta?.['claudecode/toolUseId']) : null;
        const queryCursor=answer?{turns:current.turns.length,receipts:current.receipts.length,events:current.events.length,max_turns:current.maxTurns}:null;
        let response;
        try {
          if (answer) { continuations++; response = await live.session.continue(live.receipt, answer, expected); }
          else {
            // Any other request (new decision, correction turn, changed tool budget) starts a fresh process
            // from the controller's exact rolling context, exactly like the per-call harness.
            await live?.session.close(); live = null;
            if(releaseClosedSessions&&current&&!current.released)await current.release();
            const checkpoint=nativeHistoryRetry?.registration??(!firstReplyAccepted&&!checkpointReplyReceived?initialNativeHistoryCheckpoint:null);
            current = new DecisionLoopSession({maxReferenceReads, root: root + '/session-' + (sessions.length + 1), key, binary, registration, offlineEndpoint, timeoutMs:checkpoint?.attestation.remaining_logical_ms??timeoutMs,nativeSkillAssetsRoot,nativeKnowledgeGuidance,nativeSkillEntry,
              initialParallelCorrection:!firstReplyAccepted?initialParallelCorrection:null,
              nativeHistoryCheckpoint:checkpoint,
              maxTurns: checkpoint?checkpoint.attestation.remaining_native_turns:queryRetry?queryRetry.remaining_native_turns:!firstReplyAccepted?initialSessionMaxTurns:maxTurns });
            if(queryRetry){assert.deepEqual(expected,queryRetry.expected);current.save('QUERY-RESUME.json',queryRetry.evidence);}
            if(!firstReplyAccepted&&initialSessionMaxTurns<maxTurns)current.save('INITIAL-RESUME-ALLOWANCE.json',{remaining_native_turns:initialSessionMaxTurns});
            sessions.push(current);
            response = await current.start(expected);
          }
        } catch (cause) {
          live = null;
          if (cause.complete_native_reply?.stop_reason) throw toolContractError('Complete native response retained without proven MCP delivery; do not redraw it: ' + cause.message, cause.complete_native_reply, { scope: 'endpoint' });
          const emptyDeadline=emptyTerminalDeadline(cause,current);
          // Local ablation runs (ABL_RETRY_TRANSPORT=1): a CLI transport failure without an HTTP status (DNS, refused,
          // reset, request timeout) produced no reply, so the bounded outer retry may resend the same request.
          const transport = !nativeSkillAssetsRoot && process.env.ABL_RETRY_TRANSPORT === '1' && !Number.isInteger(cause.status) && cause.code !== 'CODE_NATIVE_DEADLINE'
            && /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|Can't reach the API server|socket hang up|fetch failed|timed out/i.test(cause.message);
          // Local ablation runs (ABL_RETRY_DEADLINE=1): a logical deadline without a complete native reply (that case
          // throws above) executed no action, so the decision may be resent instead of discarding the whole trajectory.
          const ablDeadline = !nativeSkillAssetsRoot && process.env.ABL_RETRY_DEADLINE === '1' && cause.code === 'CODE_NATIVE_DEADLINE';
          const error = new ModelError(cause.message, { status: transport ? 503 : cause.status ?? null, retryAfterMs: emptyDeadline||transport||ablDeadline||cause.status===429||cause.status>=500 ? 60000 : null, retryable: transport || ablDeadline || ((cause.code !== 'CODE_NATIVE_DEADLINE'||emptyDeadline) && Number.isInteger(cause.status) && retryableStatus(cause.status)) });
          if(cause.code==='CODE_NATIVE_DEADLINE'){
            error.code=cause.code;error.deadline_no_native_reply_confirmed=emptyDeadline;
            error.failure_reason=emptyDeadline?'empty_terminal_deadline':'partial_or_ambiguous_terminal_deadline';
          }
          let retained=false;
          const temporary=[429,500,502,503,504].includes(error.status)&&! /quota|credit|balance|forbidden|unauthori[sz]ed|permission/i.test(cause.message??'');
          if(nativeSkillAssetsRoot&&temporary){
            try{
              if(cause.complete_native_reply?.stop_reason===null){error.native_history_retry=await retainRuntime();error.retryable=true;retained=true;}
              else {
              await current.close();
              let registration;
              try{registration=captureNativeSegmentCheckpoint({sessionDir:current.root,codeRoot:root,expected,allowOffline:!!offlineEndpoint});}
              catch(captureError){
                if(!current.nativeHistoryCheckpoint)throw captureError;
                inspectEmptyGatewayFailure(current.root);registration=current.nativeHistoryCheckpoint;
              }
              const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
              const checkpoint={registration,expected,failed_session:current.root,failed_session_sha256:digest(current.root+'/SESSION.json'),failed_stdout_sha256:digest(current.root+'/stdout.jsonl')};
              const proof=inspectNativeHistoryRetry(checkpoint);
              current.save('REGISTERED-NATIVE-RETRY.json',{...checkpoint,proof});
              nativeHistoryRetry=checkpoint;queryRetry=null;error.native_history_retry=checkpoint;error.retryable=true;retained=true;
              }
            }catch{ /* Any partial output or missing original result remains fail-closed. */ }
          }
          if(cause.native_internal_continuation_required&&!retained){error.retryable=false;error.code='NATIVE_INTERNAL_CONTINUATION_REQUIRED';}
          error.cause = cause; error.failure_scope = [401, 402, 403].includes(error.status) ? 'endpoint' : 'request';
          if(!retained&&error.retryable&&queryCursor&&current.nativeHistoryCheckpoint){error.retryable=false;error.code='NATIVE_HISTORY_QUERY_CHECKPOINT_REQUIRED';}
          else if(!retained&&error.retryable&&queryCursor){
            try{
              await current.close();
              const evidence=inspectNativeQueryFailure({session_dir:current.root,cursor:queryCursor});
              queryRetry={expected,remaining_native_turns:evidence.remaining_native_turns,evidence};
              error.native_query_retry=evidence.query_resume;
            }catch{error.retryable=false;error.code='NATIVE_QUERY_RESUME_UNPROVEN';}
          }
          throw error;
        }
        assert.ok(!closed, 'No proposal after controller closed');
        if(current.nativeHistoryCheckpoint)checkpointReplyReceived=true;
        nativeCorrections += response.native_corrections?.length ?? 0;
        live = response.native_MCP_called && LOOP_TOOLS.includes(response.local_name) ? { session: current, expected, receipt: response.receipt } : null;
        const original = response.raw;
        // A stream that ended without stop_reason (gateway cut after message_start; empty or thinking-only content)
        // is a transport failure, not the model's format error: no action is accepted and the request is retried.
        if (original?.stop_reason == null) {
          await live?.session.close(); live = null;
          const error = new ModelError('Incomplete native stream without stop_reason; no action accepted', { status: 502, retryAfterMs: 60000, retryable: !nativeSkillAssetsRoot });
          error.failure_scope = 'request'; error.response_raw = original;
          if(nativeSkillAssetsRoot){try{error.native_history_retry=await retainRuntime();error.retryable=true;}catch(captureError){error.runtime_recovery_unavailable=captureError.message;}}
          throw error;
        }
        const content = original.content.map(b => b.type === 'tool_use' && b.name.startsWith(PREFIX) ? { ...b, name: b.name.slice(PREFIX.length) } : b);
        const raw = { ...original, __code_harness: { version: nativeSkillAssetsRoot?NATIVE_SKILL_VERSION:'native-decision-loop/v1', call_dir: response.call_dir, native_turn: response.turn, in_process_continuation: !!answer, native_corrections: (response.native_corrections ?? []).map(c => ({ file: c.file, reason: c.reason, name: c.name })), native_MCP_called: response.native_MCP_called, native_direct_HTTPS: !offlineEndpoint, original_native_content: true,native_reply_source:response.native_reply_source??'stream_event', actual_HTTP: null, wire_requests: null,
          ...(nativeSkillAssetsRoot?{native_internal:response.native_internal,native_skill_assets_sha256:response.native_skill_assets_sha256}:{}),
          ...(current.nativeHistoryCheckpoint?{native_history_checkpoint:{registration_file:current.root+'/NATIVE-RESUME-REGISTRATION.json',checkpoint_file:current.root+'/NATIVE-RESUME-CHECKPOINT.json'}}:{}) } };
        const uses = content.filter(b => b.type === 'tool_use'), use = uses[0], usage = original.usage ?? {};
        const result = { tool_call: use ? { id: use.id, name: use.name, input: use.input } : null, text: content.filter(b => b.type === 'text').map(b => b.text).join('\n'), usage: { input_tokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0), output_tokens: usage.output_tokens ?? 0, cache_read_input_tokens: usage.cache_read_input_tokens ?? 0, cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0 }, latency_ms: response.latency_ms, stop_reason: original.stop_reason, provider: { adapter: 'anthropic', content }, raw };
        for(const entry of response.native_internal??[]){const u=entry.raw.usage??{};
          result.usage.input_tokens+=(u.input_tokens??0)+(u.cache_creation_input_tokens??0)+(u.cache_read_input_tokens??0);
          result.usage.output_tokens+=u.output_tokens??0;result.usage.cache_read_input_tokens+=u.cache_read_input_tokens??0;
          result.usage.cache_creation_input_tokens+=u.cache_creation_input_tokens??0;}
        if (original.stop_reason === 'max_tokens') { await live?.session.close(); live = null; throw truncatedToolReply(raw, response.latency_ms); }
        if (original.stop_reason === 'refusal') throw toolContractError('Native Code refused; no action executed', raw);
        try {
          const validated = enforceToolContract(result, request.tools, 'anthropic', { calls: uses.length, normalizeAct: config.act_normalization ?? null });
          if (validated.tool_call && !response.native_MCP_called) throw toolContractError('Native proposal lacks matching MCP invocation; no action executed', raw, { scope: 'endpoint' });
          if (validated.tool_call) nativeCalls++;
          firstReplyAccepted=true;
          if(validated.tool_call&&!LOOP_TOOLS.includes(validated.tool_call.name)){queryRetry=null;nativeHistoryRetry=null;}
          return validated;
        } catch (error) {
          if (config.tool_contract_repair === true && uses.length === 1 && LOOP_TOOLS.includes(use?.name)) return { ...result, tool_validation_error: error.message };
          await live?.session.close(); live = null;
          throw error;
        }
      } finally { busy = false; }
    },
    /** decision-redraw/v1: forget retained partial/native state so the same request starts a fresh session. */
    async discardForRedraw() {
      assert.ok(!busy, 'Redraw while a call is active');
      await live?.session.close(); live = null; nativeHistoryRetry = null; queryRetry = null;
    },
    async close() {
      if (closed) return;
      closed = true; await current?.close(); live = null; key = '';
      fs.writeFileSync(root + '/MODEL.json', JSON.stringify({ closed: new Date().toISOString(), sessions: sessions.length, nativeCalls, in_process_continuations: continuations, native_corrections: nativeCorrections, native_Code_direct: true, native_decision_loop: true, local_HTTP_proxy: false, extra_body: false, actual_HTTP: null, wire_requests: null,...(nativeSkillAssetsRoot?knowledgeStats():{}) }, null, 2) + '\n');
    },
    get diagnostics() { return { sessions: sessions.length, nativeCalls, in_process_continuations: continuations, native_corrections: nativeCorrections, direct_native_Code: true, decision_loop: true, actual_HTTP: null, wire_requests: null,...(nativeSkillAssetsRoot?knowledgeStats():{}) }; }
  };
}
