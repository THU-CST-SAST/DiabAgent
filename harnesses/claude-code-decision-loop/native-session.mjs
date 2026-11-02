import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PREFIX, codeMessages, sessionEntries } from './history.mjs';
import {assertRegisteredCodeModel} from './model-identity.mjs';
import { parseCodeStream } from './reply-parser.mjs';
import { STANDARD_HARNESS } from './standard.mjs';
import { nativeTerminalFailure } from './native-failure.mjs';
import {assistantReplies} from './native-assistant.mjs';
import {nativeStreamJsonNote} from './native-note-json-binding.mjs';
import {pendingParallelControllerIds} from './native-parallel-fragments.mjs';
import {verifyPendingCorrection} from './native-pending-parallel.mjs';
import {prepareNativeSkill,nativeKnowledgeManifest,nativeToolResult,nativeWitnessMatches,NATIVE_SKILL_VERSION,NATIVE_SKILL_REGISTRATION} from './native-skill.mjs';
import {prepareNativeHistoryCheckpoint} from './native-history-checkpoint.mjs';

export const REGISTRATION = 'native-decision-loop/v1-three-day-fixed4';
// Query tools the original controller answers inside one decision; act always ends the Code process.
export const LOOP_TOOLS = ['read_glucose_history', 'simulate', 'read_glucose_skill'];
// Claude Code cannot send disable_parallel_tool_use; a parallel batch is answered with this error for every
// call (nothing run, no budget used) so the model re-issues one call, preserving the serial controller contract.
export const PARALLEL_REJECTION = 'Rejected: exactly one tool call per reply is accepted (parallel tool use is disabled). None of these calls was run and no budget was used. Re-issue a single tool call.';

/**
 * One genuine Claude Code process per controller decision (harness B). Claude Code runs its own native
 * multi-turn tool loop inside the decision: query tool calls are answered through MCP with the original
 * controller's exact result, and the first act proposal ends the process before any action is applied.
 */
export class DecisionLoopSession {
  constructor({ root, key, binary, registration, offlineEndpoint, nativeSkillAssetsRoot=null, nativeKnowledgeGuidance='legacy-v1', nativeSkillEntry='automatic', initialParallelCorrection=null, nativeHistoryCheckpoint=null, timeoutMs = 120000, maxTurns = STANDARD_HARNESS.max_native_turns_per_decision }) {
    assert(['automatic','task-command-v1'].includes(nativeSkillEntry));
    assert(nativeSkillAssetsRoot||nativeSkillEntry==='automatic');
    assert.ok(offlineEndpoint || registration === (nativeSkillAssetsRoot?NATIVE_SKILL_REGISTRATION:REGISTRATION), 'Unregistered production invocation');
    if (offlineEndpoint) {
      const url = new URL(offlineEndpoint);
      assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
      assert.equal(key, 'offline-dummy-not-a-credential');
    }
    assert.ok(key && timeoutMs > 0 && timeoutMs <= 480000 && Number.isInteger(maxTurns) && maxTurns >= 1 && maxTurns <= 8);
    // Linux claude.exe 2.1.296 by default; another platform's same-version build is pinned via CLAUDE_BINARY_SHA256.
    assert.equal(createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), process.env.CLAUDE_BINARY_SHA256 ?? '24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de');
    if(initialParallelCorrection){assert.equal(initialParallelCorrection.consumed_native_turns,1);
      assert.equal(initialParallelCorrection.remaining_native_turns,6);assert.equal(maxTurns,6);}
    if(nativeHistoryCheckpoint){assert(nativeSkillAssetsRoot&&nativeSkillEntry==='task-command-v1');assert(!initialParallelCorrection);assert.equal(nativeHistoryCheckpoint.attestation.remaining_native_turns,maxTurns);}
    Object.assign(this, { root, key, binary, offlineEndpoint, timeoutMs, maxTurns, initialParallelCorrection,nativeKnowledgeGuidance,nativeSkillEntry,nativeHistoryCheckpoint });
    this.productionEndpoint=process.env.DIABAGENT_CODE_BASE_URL??'https://api.anthropic.com';
    const endpoint=new URL(this.productionEndpoint);
    assert(endpoint.protocol==='https:'&&!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash,'Invalid production endpoint');
    if(nativeSkillAssetsRoot){
      if(initialParallelCorrection)assert.equal(initialParallelCorrection.version,'registered-native-pending-parallel/v1','Native Skill needs a proven original native reply, not an old reader prefix');
      this.nativeSkillAssetsRoot=nativeSkillAssetsRoot;this.nativeInternal=[];
    }
    fs.mkdirSync(root, { recursive: false });
    this.stdout = ''; this.stderr = ''; this.events = []; this.frames = []; this.closed = false; this.receipts = []; this.turns = [];
    this.rejectIds = new Set(); this.rejectedRpc = new Set();
  }
  answerRejected() {
    for (const receipt of this.receipts) {
      if (!this.rejectIds.has(receipt._meta?.['claudecode/toolUseId']) || this.rejectedRpc.has(receipt.rpc_id)) continue;
      this.rejectedRpc.add(receipt.rpc_id);
      const file = this.root + '/results/' + receipt.rpc_id + '.json';
      fs.writeFileSync(file + '.tmp', JSON.stringify({ text: PARALLEL_REJECTION, is_error: true }), { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
    }
  }
  safe(value) { return String(value).split(this.key || '\0').join('[REDACTED]').replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'); }
  save(name, value) { fs.writeFileSync(this.root + '/' + name, this.safe(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'), { mode: 0o600 }); }
  stop(signal = 'SIGTERM') { if (this.child?.pid) { try { process.kill(-this.child.pid, signal); } catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error; } } }
  get alive() { return !!this.child && !this.exit && !this.closed; }
  readReceipts() { if (fs.existsSync(this.receiptsFile)) this.receipts = fs.readFileSync(this.receiptsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  nativeWitnesses(){
    if(!this.nativeKnowledge)return [];
    return JSON.parse(fs.readFileSync(this.nativeKnowledge.ledger,'utf8')).attempts.map(attempt=>({...attempt,cwd:this.nativeWorkspace??this.root+'/workspace',result:nativeToolResult(this.events,attempt.id)})).filter(w=>w.result);
  }

  /** Waits for the next complete assistant message (and its MCP receipt when it proposes a tool). */
  nextProposal(expected) {
    const turn = this.turns.length + 1, from = this.frames.length, started = Date.now();
    this.save('EXPECTED-CONTROLLER-REQUEST-' + turn + '.json', expected);
    if(this.initialParallelCorrection)this.save('EXPECTED-NATIVE-CORRECTION-REQUEST-'+turn+'.json',this.seededExpected(expected));
    let raw, timer, poll, start = from,eventStart=this.events.length,nativeReplySource='stream_event',consumedFrames=from;
    const internalStart=this.nativeInternal?.length??0;
    const priorCorrections = this.initialParallelCorrection&&turn===1?[{
      file:this.initialParallelCorrection.source_manifest,reason:'registered_prior_parallel_batch',
      name:this.initialParallelCorrection.raw.content.filter(b=>b.type==='tool_use').map(b=>b.name).join(','),
      raw:this.initialParallelCorrection.raw}]:[];
    const corrections=[];
    const proposal = new Promise((settle, reject) => {
      this.pending = { reject };
      this.check = () => {
        try {
          // Code may dispatch a JSON-native parallel batch sequentially. Reject known-invalid
          // calls as they arrive so the next MCP receipt can appear; acceptance still needs all receipts.
          for(const id of pendingParallelControllerIds(this.events.slice(eventStart),{model:expected.model}))this.rejectIds.add(id);
          if (this.rejectIds.size) { this.readReceipts(); this.answerRejected(); }
          const frames = this.frames.slice(start), file = 'COMPLETE-NATIVE-REPLY-' + turn + (this.nativeKnowledge?'-n'+(this.nativeInternal.length+1):'') + (corrections.length ? '-c' + corrections.length : '') + '.json';
          if (!raw && frames.some(frame => frame.type === 'message_stop')) {
            const end=this.nativeKnowledge?frames.findIndex(e=>e.type==='message_stop')+1:frames.length;
            raw = parseCodeStream(frames.slice(0,end).map(e => 'data: ' + JSON.stringify(e)).join('\n'), { model: expected.model }).raw;
            consumedFrames=start+end;
            this.save(file, raw);
          }
          if(!raw){
            this.readReceipts();
            const complete=assistantReplies(this.events.slice(eventStart),this.receipts,{model:expected.model,nativeWitnesses:this.nativeWitnesses()});
            if(complete.length){raw=complete[0];nativeReplySource='native-assistant-chunks/v1';this.save(file,raw);}
          }
          // Code stopped (e.g. its max-turns) after only invalid replies: the last one enters the original format path.
          if (!raw && this.exit && corrections.length) {
            const failure = nativeTerminalFailure(this.events);
            if (failure) return reject(failure);
            return settle({ raw: corrections.at(-1).raw, native_MCP_called: false, native_corrections: corrections });
          }
          if (!raw) return;
          this.readReceipts();
          const uses = raw.content.filter(b => b.type === 'tool_use');
          const single = uses.length === 1 && raw.stop_reason === 'tool_use';
          const localName = single ? (uses[0].name.startsWith(PREFIX) ? uses[0].name.slice(PREFIX.length) : uses[0].name) : null;
          if(this.nativeKnowledge&&uses.length&&raw.stop_reason==='tool_use'&&uses.every(u=>['Skill','Read'].includes(u.name))){
            const witnesses=uses.map(u=>this.nativeWitnesses().find(w=>nativeWitnessMatches(u,w)));
            if(witnesses.some(w=>!w))return;
            const record={file,raw,operations:witnesses.map(w=>({...w,result:w.result.block})),native_reply_source:nativeReplySource};
            this.nativeInternal.push(record);this.save('NATIVE-INTERNAL-'+this.nativeInternal.length+'.json',record);
            start=consumedFrames;eventStart=Math.max(...witnesses.map(w=>this.events.indexOf(w.result.event)))+1;raw=undefined;
            return;
          }
          // Malformed tool JSON or an unadvertised tool name: Claude Code answers with its own tool error and
          // re-asks inside this decision. That native correction is part of harness B; keep every reply as evidence.
          if (single && (uses[0].input?.__unparsedToolInput || !expected.tools.some(t => t.name === localName) || !uses[0].name.startsWith(PREFIX))) {
            if (this.exit) return settle({ raw, native_MCP_called: false, native_corrections: corrections });
            corrections.push({ file, reason: uses[0].input?.__unparsedToolInput ? 'unparsed_tool_input' : 'unadvertised_tool', name: uses[0].name, raw });
            start = this.frames.length;eventStart=this.events.length; raw = undefined;
            return;
          }
          if (uses.length > 1 && raw.stop_reason === 'tool_use' && !this.exit) {
            for (const use of uses) this.rejectIds.add(use.id);
            corrections.push({ file, reason: 'parallel_tool_calls', name: uses.map(use => use.name).join(','), raw });
            start = this.frames.length;eventStart=this.events.length; raw = undefined;
            this.answerRejected();
            return;
          }
          const valid = single && uses[0].input && typeof uses[0].input === 'object';
          if (!valid) return settle({ raw, native_MCP_called: false, native_corrections: corrections });
          let use = uses[0];
          const receipt = this.receipts.find(r => r._meta?.['claudecode/toolUseId'] === use.id);
          if (!receipt) return;
          assert.equal(receipt.name, localName);
          if(!isDeepStrictEqual(receipt.arguments,use.input)){
            const bound=nativeStreamJsonNote(raw,this.events.slice(eventStart),this.receipts);
            if(bound){
              this.save(file.replace('.json','-STREAM-JSON-BINDING.json'),{version:'native-stream-json-note/v1',stream_file:file,message_id:raw.id,tool_id:use.id,stream_header_and_signed_blocks_preserved:true,original_JSON_blocks_used:true,no_action_or_memory_change:true});
              raw=bound;use=raw.content.find(b=>b.type==='tool_use');nativeReplySource='native-stream-json-note/v1';
              this.save(file.replace('.json','-BOUND-NATIVE-JSON.json'),raw);
            }else if(!this.exit&&this.events.slice(eventStart).filter(e=>e.type==='assistant'&&e.message?.id===raw.id).flatMap(e=>e.message.content??[]).length<raw.content.length)return;
          }
          assert.deepEqual(receipt.arguments, use.input);
          settle({ raw, native_MCP_called: true, receipt, local_name: localName, native_corrections: corrections,native_reply_source:nativeReplySource });
        } catch (error) { reject(error); }
      };
      timer = setTimeout(() => reject(Object.assign(new Error('Decision-loop Code logical deadline; no partial action accepted or saved complete reply redrawn'), { status: 504, code: 'CODE_NATIVE_DEADLINE' })), this.timeoutMs);
      poll = setInterval(() => this.check(), 10);
      this.check();
    });
    return proposal.then(answer => {
      if(priorCorrections.length)answer={...answer,native_corrections:[...priorCorrections,...answer.native_corrections]};
      this.turns.push({ turn, tool: answer.local_name ?? null, mcp: answer.native_MCP_called, native_corrections: answer.native_corrections.length, elapsed_ms: Date.now() - started });
      this.save('ACCEPTED-PROPOSAL-' + turn + '.json', { ...answer, elapsed_ms: Date.now() - started });
      const internal=this.nativeInternal?.slice(internalStart)??[];
      return { ...answer, turn, latency_ms: Date.now() - started, call_dir: this.root,
        ...(this.nativeKnowledge?{native_internal:internal,native_skill_assets_sha256:this.nativeKnowledge.assets_sha256}:{}) };
    }, error => { this.error = this.safe(error.message); error.message = this.error; if (raw) error.complete_native_reply = raw;
      if((this.nativeInternal?.length??0)>internalStart)error.native_internal_continuation_required=true;
      throw error; })
      .finally(() => { clearTimeout(timer); clearInterval(poll); this.pending = null; });
  }

  async start(expected) {
    if(this.nativeHistoryCheckpoint)return this.startHistoryCheckpoint(expected);
    if(this.nativeKnowledge===undefined&&this.nativeSkillAssetsRoot&&this.initialParallelCorrection)verifyPendingCorrection(this.initialParallelCorrection,expected);
    assertRegisteredCodeModel(expected.model); assert([8192,16384].includes(expected.max_tokens)); assert(['high','max'].includes(expected.output_config.effort),'Registered effort must be high or max');
    assert(['high','max'].includes(expected.output_config.effort));
    assert.equal(expected.messages.at(-1).role, 'user'); assert.ok(expected.tools.length);
    const taskEntry=this.nativeSkillEntry==='task-command-v1';
    const home = this.root + '/home', cwd = this.root + '/workspace', sid = randomUUID(), project = 'decision-loop', resumed = taskEntry || expected.messages.length > 1 || !!this.initialParallelCorrection;
    fs.mkdirSync(home); fs.mkdirSync(cwd); fs.mkdirSync(home + '/projects/' + project, { recursive: true }); fs.mkdirSync(this.root + '/results');
    if(this.nativeSkillAssetsRoot){
      assert(!expected.tools.some(t=>t.name==='read_glucose_skill'),'Do not mix native Skill with a custom reference reader');
      this.nativeKnowledge=prepareNativeSkill({assetsRoot:this.nativeSkillAssetsRoot,workspace:cwd,sessionRoot:this.root,guidanceRevision:this.nativeKnowledgeGuidance});
      this.save('NATIVE-SKILL-MANIFEST.json',nativeKnowledgeManifest(this.nativeKnowledge));
    }
    this.initialControllerMessageCount=expected.messages.length;
    if(taskEntry)this.save('NATIVE-TASK-ENTRY.json',{mode:this.nativeSkillEntry,command:'/'+this.nativeKnowledge.name,
      original_controller_messages:expected.messages.length,manual_body_injection:false,model_selected_activation:false,
      native_model_turn_budget:this.maxTurns,reference_read_budget:3});
    if(this.initialParallelCorrection){
      assert(resumed);this.save('REGISTERED-PARALLEL-CORRECTION.json',this.initialParallelCorrection);
      if(this.nativeKnowledge)this.save('DERIVED-PARALLEL-REJECTIONS.json',{origin:'New registered policy results; not original MCP results',source_manifest:this.initialParallelCorrection.source_manifest,
        consumed_original_native_turns:1,remaining_native_turns:this.maxTurns,results:this.initialParallelCorrection.raw.content.filter(b=>b.type==='tool_use').map(u=>({type:'tool_result',tool_use_id:u.id,content:PARALLEL_REJECTION,is_error:true}))});
    }
    if (resumed) this.save('home/projects/' + project + '/' + sid + '.jsonl', sessionEntries(codeMessages(this.seededExpected(expected).messages), { sessionId: sid, cwd, model: expected.model }).map(JSON.stringify).join('\n') + '\n');
    if(taskEntry)this.nativeTaskHistory=home+'/projects/'+project+'/'+sid+'.jsonl';
    this.receiptsFile = this.root + '/MCP-CALLS.jsonl'; this.tools = expected.tools.map(t => t.name);
    this.save('mcp-tools.json', { receipts: this.receiptsFile, results: this.root + '/results', loop_tools: LOOP_TOOLS, tools: expected.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
    this.save('mcp.json', { mcpServers: { experiment: { alwaysLoad: true, type: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./native-mcp.mjs', import.meta.url)), this.root + '/mcp-tools.json'], env: { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_EXTRA_BODY: '' } } } });
    const system = typeof expected.system === 'string' ? expected.system : expected.system.map(b => b.text).join('\n');
    const args = ['--bare', '-p', '--tools', '', '--disable-slash-commands', '--allowedTools', ...expected.tools.map(t => PREFIX + t.name), '--strict-mcp-config', '--mcp-config', this.root + '/mcp.json', '--setting-sources', '', '--settings', '{}', '--permission-mode', 'dontAsk', '--model', expected.model, '--effort', expected.output_config.effort, '--system-prompt', system, '--system-prompt-snapshot', 'on', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--max-turns', String(this.maxTurns), ...(resumed ? ['--resume', sid] : ['--session-id', sid])];
    const env = { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', HOME: home, TMPDIR: home, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_PROJECT_DIR_NAME: project, ANTHROPIC_BASE_URL: this.offlineEndpoint ?? this.productionEndpoint, ANTHROPIC_API_KEY: this.key, CLAUDE_CODE_MAX_RETRIES: '0', API_TIMEOUT_MS: '90000', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_ATTACHMENTS: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', MCP_CONNECTION_NONBLOCKING: 'false', CLAUDE_CODE_MCP_ALWAYS_LOAD_JOIN_BEFORE_INPUT: 'true', CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '10000', ...(resumed ? { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: 'true' } : {}) };
    if(this.nativeKnowledge){
      const k=this.nativeKnowledge;
      args.splice(0,args.length,'-p','--restricted','--tools','Skill,Read','--allowedTools',...k.allowed,...expected.tools.map(t=>PREFIX+t.name),'--plugin-dir',k.plugin,'--strict-mcp-config','--mcp-config',this.root+'/mcp.json','--setting-sources','','--settings',JSON.stringify(k.settings),'--permission-mode','dontAsk','--model',expected.model,'--effort',expected.output_config.effort,'--append-system-prompt',system+'\n\n'+k.instructions,'--system-prompt-snapshot','on','--input-format','stream-json','--output-format','stream-json','--include-partial-messages','--verbose','--max-turns',String(this.maxTurns),...(resumed?['--resume',sid]:['--session-id',sid]));
      delete env.CLAUDE_CODE_DISABLE_ATTACHMENTS;delete env.CLAUDE_CODE_DISABLE_CLAUDE_MDS;delete env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS;
    }
    if(taskEntry)delete env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN;
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS=String(expected.max_tokens);
    this.save('LAUNCH.json', { started: new Date().toISOString(), cwd, binary: this.binary, argv: args, endpoint: env.ANTHROPIC_BASE_URL, environment_names: Object.keys(env), max_output_tokens:Number(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS), native_http_sender: true, extra_body: false, http_forwarder: false, max_native_retries: 0, max_native_model_turns: this.maxTurns, loop_tools: LOOP_TOOLS, harness: 'per-decision native loop', actual_HTTP: null, wire_requests: null });
    let pendingLine = '';
    const event = row => {
      this.events.push(row);
      if (row.type === 'stream_event') {
        this.frames.push(row.event);
        if (row.event.type === 'error') { try { parseCodeStream('data: ' + JSON.stringify(row.event), { model: expected.model }); } catch (error) { this.pending?.reject(error); } }
        this.check?.();
      }
    };
    try {
      this.child = cp.spawn(this.binary, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child.stdout.setEncoding('utf8'); this.child.stderr.setEncoding('utf8');
      this.child.stdout.on('data', chunk => { this.stdout += chunk; pendingLine += chunk; while (pendingLine.includes('\n')) { const end = pendingLine.indexOf('\n'), line = pendingLine.slice(0, end); pendingLine = pendingLine.slice(end + 1); if (!line.trim()) continue; try { event(JSON.parse(line)); } catch (error) { this.pending?.reject(error); } } });
      this.child.stderr.on('data', chunk => this.stderr += chunk);
      this.child.stdin.on('error', () => {});
      this.exited = new Promise(resolve => { this.child.once('error', error => { this.pending?.reject(error); resolve(); }); this.child.once('close', (code, signal) => { this.exit = { code, signal }; this.check?.(); const result = this.events.findLast(e => e.type === 'result'); const error = nativeTerminalFailure(this.events)??new Error(this.safe(result?.errors?.join('; ') || result?.result || this.stderr || 'Code exited without a complete native proposal')); error.status ??= Number.isInteger(result?.api_error_status) ? result.api_error_status : null; this.pending?.reject(error); resolve(); }); });
      const answer = this.nextProposal(expected);
      const input=taskEntry?{role:'user',content:'/'+this.nativeKnowledge.name}:expected.messages[0];
      this.child.stdin.end(resumed&&!taskEntry ? '' : JSON.stringify({ type: 'user', session_id: sid, parent_tool_use_id: null, message: input }) + '\n');
      return await this.settleTurn(answer);
    } catch (error) { await this.close(); throw error; }
  }

  async startHistoryCheckpoint(expected){
    assert([8192,16384].includes(expected.max_tokens));
    assert(['high','max'].includes(expected.output_config.effort));
    const prepared=prepareNativeHistoryCheckpoint({...this.nativeHistoryCheckpoint,destination:this.root,expected});
    assert.equal(prepared.proof.remaining_native_turns,this.maxTurns);this.nativeKnowledge=prepared.knowledge;this.nativeTaskHistory=prepared.history;this.nativeWorkspace=prepared.cwd;
    this.initialControllerMessageCount=expected.messages.length;this.receiptsFile=prepared.receipts;this.tools=prepared.tools;
    this.save('NATIVE-SKILL-MANIFEST.json',nativeKnowledgeManifest(this.nativeKnowledge));
    this.save('NATIVE-RESUME-REGISTRATION.json',this.nativeHistoryCheckpoint);
    const env={PATH:path.dirname(process.execPath)+':/usr/bin:/bin',HOME:prepared.home,TMPDIR:prepared.home,CLAUDE_CONFIG_DIR:prepared.home,CLAUDE_CODE_PROJECT_DIR_NAME:'decision-loop',ANTHROPIC_BASE_URL:this.offlineEndpoint??this.productionEndpoint,ANTHROPIC_API_KEY:this.key,CLAUDE_CODE_MAX_RETRIES:'0',API_TIMEOUT_MS:'90000',CLAUDE_CODE_MAX_OUTPUT_TOKENS:'8192',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',MCP_CONNECTION_NONBLOCKING:'false',CLAUDE_CODE_MCP_ALWAYS_LOAD_JOIN_BEFORE_INPUT:'true',CLAUDE_CODE_MCP_STARTUP_WAIT_MS:'10000',CLAUDE_CODE_RESUME_INTERRUPTED_TURN:'true'};
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS=String(expected.max_tokens);
    this.save('LAUNCH.json',{started:new Date().toISOString(),cwd:prepared.cwd,binary:this.binary,argv:prepared.args,endpoint:env.ANTHROPIC_BASE_URL,environment_names:Object.keys(env),max_output_tokens:Number(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS),native_http_sender:true,extra_body:false,http_forwarder:false,max_native_retries:0,max_native_model_turns:this.maxTurns,loop_tools:LOOP_TOOLS,harness:'per-decision native loop',actual_HTTP:null,wire_requests:null,native_history_checkpoint:true});
    let pendingLine='';
    const event=row=>{this.events.push(row);if(row.type==='stream_event'){this.frames.push(row.event);if(row.event.type==='error'){try{parseCodeStream('data: '+JSON.stringify(row.event),{model:expected.model});}catch(error){this.pending?.reject(error);}}this.check?.();}};
    try{
      this.child=cp.spawn(this.binary,prepared.args,{cwd:prepared.cwd,env,detached:true,stdio:['pipe','pipe','pipe']});this.child.stdout.setEncoding('utf8');this.child.stderr.setEncoding('utf8');
      this.child.stdout.on('data',chunk=>{this.stdout+=chunk;pendingLine+=chunk;while(pendingLine.includes('\n')){const end=pendingLine.indexOf('\n'),line=pendingLine.slice(0,end);pendingLine=pendingLine.slice(end+1);if(line.trim()){try{event(JSON.parse(line));}catch(error){this.pending?.reject(error);}}}});
      this.child.stderr.on('data',chunk=>this.stderr+=chunk);this.child.stdin.on('error',()=>{});
      this.exited=new Promise(resolve=>{this.child.once('error',error=>{this.pending?.reject(error);resolve();});this.child.once('close',(code,signal)=>{this.exit={code,signal};this.check?.();const result=this.events.findLast(e=>e.type==='result'),error=nativeTerminalFailure(this.events)??new Error(this.safe(result?.errors?.join('; ')||result?.result||this.stderr||'Code exited without complete resumed proposal'));error.status??=Number.isInteger(result?.api_error_status)?result.api_error_status:null;this.pending?.reject(error);resolve();});});
      const answer=this.nextProposal(expected);this.child.stdin.end();return await this.settleTurn(answer);
    }catch(error){await this.close();throw error;}
  }

  seededExpected(expected){
    if(!this.initialParallelCorrection)return expected;
    const raw=this.initialParallelCorrection.raw,uses=raw.content.filter(b=>b.type==='tool_use');assert(uses.length>1);
    const insertion=[{role:'assistant',content:structuredClone(raw.content)},
      {role:'user',content:uses.map(u=>({type:'tool_result',tool_use_id:u.id,content:PARALLEL_REJECTION,is_error:true}))}];
    const at=this.initialControllerMessageCount;
    return {...expected,messages:[...expected.messages.slice(0,at),...insertion,...expected.messages.slice(at)]};
  }

  /** Hands the original controller's exact query-tool answer back through MCP and waits for Code's next turn. */
  async continue(receipt, answer, expected) {
    assert.ok(this.alive, 'Decision-loop Code process already ended');
    assert.ok(LOOP_TOOLS.includes(receipt.name), 'Only query tools may continue inside one decision');
    const next = this.nextProposal(expected);
    const file = this.root + '/results/' + receipt.rpc_id + '.json';
    fs.writeFileSync(file + '.tmp', JSON.stringify({ text: answer.text, is_error: !!answer.is_error }), { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
    try { return await this.settleTurn(next); } catch (error) { await this.close(); throw error; }
  }

  async settleTurn(promise) {
    const answer = await promise;
    if(this.nativeTaskHistory&&!this.nativeTaskWitness){
      const body=fs.readFileSync(this.nativeKnowledge.root+'/SKILL.md','utf8').replace(/^---\n[\s\S]*?\n---\n/,'').trim();
      const exact=`Base directory for this skill: ${this.nativeKnowledge.root}\n\n${body}\n`,started=Date.now();
      // MCP is awaiting the host answer here; waiting for native persistence cannot execute an action.
      while(Date.now()-started<1000){
        let rows=[];
        try{rows=fs.readFileSync(this.nativeTaskHistory,'utf8').split('\n').filter(Boolean).map(JSON.parse);}catch{}
        const witness=rows.find(e=>e.type==='user'&&e.isMeta===true&&e.message?.content?.length===1&&e.message.content[0].text===exact);
        if(witness){this.nativeTaskWitness=true;this.save('NATIVE-TASK-ENTRY-WITNESS.json',{source:this.nativeTaskHistory,native_record:witness,wait_ms:Date.now()-started});break;}
        await new Promise(r=>setTimeout(r,10));
      }
      if(!this.nativeTaskWitness){await this.close();throw Object.assign(new Error('Complete proposal retained but native task entry persistence not witnessed; do not redraw'),{complete_native_reply:answer.raw});}
    }
    // Keep the process only while it waits for a controller answer to a query tool; act or any non-proposal ends it.
    if (!(answer.native_MCP_called && LOOP_TOOLS.includes(answer.local_name))) await this.close();
    return answer;
  }

  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.closed = true; this.pending?.reject(new Error('Decision-loop Code process closed'));
      // With max-turns > 1, a graceful SIGTERM lets the MCP child die first; Code then sees "Connection closed"
      // as the act tool_result and starts an extra (paid) model request. Kill Code itself first, uncatchably.
      if (this.child?.pid && !this.exit) { try { process.kill(this.child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error; } }
      this.stop('SIGKILL');
      if (this.exited) await this.exited;
      this.readReceipts();
      this.save('stdout.jsonl', this.stdout); this.save('stderr.txt', this.stderr);
      this.save('SESSION.json', { closed: new Date().toISOString(), pid: this.child?.pid, exit: this.exit, error: this.error ?? null, turns: this.turns, native_MCP_receipts: this.receipts, original_controller_executes: true, original_controller_answers_query_tools: true, official_Code_direct_HTTP: !this.offlineEndpoint, offline_only: !!this.offlineEndpoint, actual_HTTP: null, wire_requests: null, no_body_override: true,
        ...(this.nativeKnowledge?{harness:NATIVE_SKILL_VERSION,native_internal:this.nativeInternal,native_knowledge_ledger:JSON.parse(fs.readFileSync(this.nativeKnowledge.ledger,'utf8'))}:{}) });
      this.key = '';
    })();
    return this.closing;
  }
  /** After close() has written stdout.jsonl/SESSION.json, drop the in-memory copies (a 72h trajectory keeps ~90 sessions). */
  async release() {
    await this.close();
    this.stdout = ''; this.stderr = ''; this.events = []; this.frames = []; this.released = true;
  }
}
