// Control-plane only. Scientific execution is imported from the verified frozen runtime.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

export const CAMPAIGN = 'v42-skill-only-low-20261019';
export const SOURCE_SHA256 = '18faf469110be8008db3e3fd076e12f52e12753a78c70c5206173bba7b275742';
const sha = x => createHash('sha256').update(x).digest('hex');
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const exists = f => fs.existsSync(f);
const ensure = (ok, why) => { if (!ok) throw Error(why); };
const equal = (a, b, why) => ensure(isDeepStrictEqual(a, b), why);
export const pending = reason => ({state: 'pending', reason, retry_after_seconds: 300});

export function inside(root, rel) {
  const f = path.resolve(root, rel);
  ensure(f.startsWith(root + path.sep), `Path escapes root: ${rel}`);
  // Never follow output symlinks into another campaign, including missing leaf paths.
  let p = f;
  while (p !== root) {
    if (exists(p)) ensure(!fs.lstatSync(p).isSymbolicLink(), `Symlink refused: ${p}`);
    p = path.dirname(p);
  }
  return f;
}

function files(root, rel = '') {
  return fs.readdirSync(path.join(root, rel)).sort().flatMap(n => {
    const r = path.join(rel, n), f = inside(root, r);
    return fs.statSync(f).isDirectory() ? files(root, r) : [r];
  });
}

export function writeJson(file, value) {
  const tmp = `${file}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  fs.renameSync(tmp, file);
}

export function verifyManifest(runtime, expectedSource = SOURCE_SHA256) {
  const m = read(inside(runtime, 'SKILL-ONLY-SOURCE.json'));
  ensure(m.campaign === CAMPAIGN && m.source_sha256 === expectedSource, 'Unrecognized frozen source identity');
  ensure(sha(JSON.stringify(m.files)) === m.source_sha256, 'Source manifest digest mismatch');
  for (const [rel, digest] of Object.entries(m.files))
    ensure(sha(fs.readFileSync(inside(runtime, rel))) === digest, `Frozen source mismatch: ${rel}`);
  return m;
}

export async function frozenFunctions(runtime) {
  const imp = rel => import(pathToFileURL(inside(runtime, rel)).href);
  const runner = await imp('src/benchmark/runner.mjs');
  const summary = await imp('src/benchmark/summarize.mjs');
  const build = await imp('src/benchmark/build.mjs');
  const probe = await imp('src/benchmark/preflight.mjs');
  const models = await imp('src/bench/models/index.mjs');
  const failures = await imp('src/benchmark/failures.mjs');
  const toml = await imp('src/benchmark/toml.mjs');
  return {...runner, ...summary, ...build, ...probe, ...models, ...failures, ...toml};
}

function verifyAgent(runtime, jobDir, config, handoff) {
  const root = inside(jobDir, config.agent_code.dir), meta = read(inside(root, 'FROZEN.json'));
  ensure(meta.sha256 === config.agent_code.sha256 && meta.sha256 === handoff.job_agent_code_sha256, 'Job agent identity mismatch');
  const base = files(root).filter(r => r !== 'FROZEN.json' && !r.startsWith('agent-harness/'));
  const hash = createHash('sha256');
  for (const rel of base) {
    const bytes = fs.readFileSync(inside(root, rel));
    ensure(bytes.equals(fs.readFileSync(inside(runtime, rel))), `Agent source mismatch: ${rel}`);
    hash.update(rel + '\0'); hash.update(bytes); hash.update('\0');
  }
  const asset = read(inside(root, 'agent-harness/assets/manifest.json'));
  equal(asset, read(inside(runtime, 'agent-harness/assets/manifest.json')), 'Skill manifest mismatch');
  ensure(sha(JSON.stringify(asset.files)) === asset.sha256 && asset.sha256 === meta.skill_context.sha256, 'Skill digest mismatch');
  const skillFiles = ['agent-harness/upstream.json', 'agent-harness/assets/manifest.json',
    ...Object.keys(asset.files).map(r => `agent-harness/assets/${r}`)];
  for (const rel of skillFiles) {
    const bytes = fs.readFileSync(inside(root, rel));
    ensure(bytes.equals(fs.readFileSync(inside(runtime, rel))), `Skill source mismatch: ${rel}`);
    const assetRel = rel.replace('agent-harness/assets/', '');
    if (asset.files[assetRel]) ensure(sha(bytes) === asset.files[assetRel], `Skill asset mismatch: ${rel}`);
  }
  equal(files(root).sort(), [...base, 'FROZEN.json', ...skillFiles].sort(), 'Unexpected frozen agent files');
  ensure(base.length + skillFiles.length === meta.files, 'Frozen agent file count mismatch');
  ensure(sha([hash.digest('hex'), asset.sha256].join('\n')) === meta.sha256, 'Frozen agent content digest mismatch');
  return inside(root, 'src/benchmark/agent-main.mjs');
}

// Process identity is PID + birth + actual argv, never a status-file state or kill(pid, 0) alone.
export function processInventory() {
  const r = spawnSync('ps', ['-axo', 'pid=,ppid=,lstart=,command='], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  ensure(r.status === 0, 'Cannot inspect process ownership');
  return r.stdout.split('\n').filter(Boolean).map(line => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/);
    ensure(m, 'Cannot parse process identity');
    const pid = Number(m[1]);
    let argv, cwd;
    if (process.platform === 'linux') {
      try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); cwd = fs.readlinkSync(`/proc/${pid}/cwd`); }
      catch (e) { if (e.code === 'ENOENT' || e.code === 'ESRCH') return null; }
    }
    return {pid, ppid: Number(m[2]), birth: m[3].replace(/\s+/g, ' '), command: m[4], argv, cwd};
  }).filter(Boolean);
}

export function sameIdentity(a, b) {
  return !!a && !!b && a.pid === b.pid && a.birth === b.birth && a.command === b.command;
}

function argvOf(p) {
  // ps on macOS does not preserve argument boundaries. Fail closed for relevant ambiguous paths.
  return p.argv ?? p.command.split(/\s+/);
}
function cwdOf(p) {
  if (p.cwd) return p.cwd;
  const r = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(p.pid), '-d', 'cwd', '-Fn'], {encoding: 'utf8', timeout: 10000});
  const cwd = r.stdout?.split('\n').find(l => l.startsWith('n'))?.slice(1);
  ensure(r.status === 0 && cwd, `Cannot verify cwd for PID ${p.pid}`);
  return cwd;
}

export function activeOwners(ctx, inventory, ignored = []) {
  const ignore = new Set(ignored);
  return inventory.filter(p => {
    if (ignore.has(p.pid)) return false;
    const args = argvOf(p), script = args[1], name = script && path.basename(script);
    if (!['paired-campaign.mjs', 'resume-campaign.mjs', 'harbor-local.mjs', 'agent-main.mjs', 'sim-entry.mjs', 'verify.mjs', 'test.sh'].includes(name)) return false;
    const resolve = s => path.resolve(cwdOf(p), s);
    const value = flag => args[args.indexOf(flag) + 1];
    if (name === 'resume-campaign.mjs') {
      if (!args.includes('--launch') && !args.includes('--worker')) return false;
      return args.includes('--runtime') && resolve(value('--runtime')) === ctx.runtime;
    }
    if (name === 'paired-campaign.mjs') {
      if (!args.includes('--run') && !args.includes('--launch')) return false;
      return args.includes('--config') && resolve(value('--config')) === ctx.configFile;
    }
    if (name === 'harbor-local.mjs') return args.some(a => a === ctx.jobDir || a === ctx.model.job_id || a === ctx.cfg.benchmark);
    if (name === 'agent-main.mjs') return resolve(script) === ctx.agentMain;
    // A sidecar/verifier can outlive its owner. Conservatively block same frozen benchmark.
    return resolve(script).startsWith(ctx.bench.dir + path.sep);
  });
}

export function assertNoOwner(ctx, inventory = processInventory(), ignored = []) {
  const active = activeOwners(ctx, inventory, ignored);
  ensure(!active.length, `Active duplicate owner: ${active.map(p => `${p.pid}@${p.birth}`).join(', ')}`);
}

export function selection(rec, state, agentStatus = null) {
  if (!rec) return 'skip_missing';
  // Even a damaged/missing reward must not cause a declared successful policy run to be retried.
  if (rec.status === 'done' || state === 'done' || rec.reward?.agent_completed === 1 || agentStatus?.state === 'done') return 'skip_done';
  const blocked = new Set(['format', 'format_errors', 'auth', 'max_turns', 'api_error', 'timeout', 'crash', 'early_exit']);
  if (blocked.has(rec.failure?.reason) || blocked.has(agentStatus?.reason)) return 'skip_policy_or_auth';
  if (rec.status === 'infra_failed') return 'infra';
  if (rec.status === 'agent_failed' && ['network', 'server', 'rate_limit', 'sim_transport'].includes(rec.failure?.reason)) return rec.failure.reason;
  if (rec.status === 'running' && !rec.finished && agentStatus?.state !== 'done') return 'stale_interrupted';
  return 'skip_ineligible';
}

export function checkArchive(trialDir, native) {
  const {rec, state} = native.trialStateOf(trialDir);
  ensure(rec && !['new', 'not_started', 'done'].includes(state) && rec.status !== 'done', 'Cannot archive this trial');
  const hist = rec.attempts ?? [];
  ensure(Number.isInteger(rec.attempt) && rec.attempt > 0, 'Invalid current attempt number');
  const nums = hist.map(a => a.attempt);
  ensure(nums.every(n => Number.isInteger(n) && n > 0) && new Set(nums).size === nums.length, 'Invalid attempt history');
  const archiveRoot = inside(trialDir, 'attempts');
  const onDisk = exists(archiveRoot) ? fs.readdirSync(archiveRoot) : [];
  equal(onDisk.sort(), nums.map(String).sort(), 'Untracked/missing attempt archives; manual reconciliation required');
  for (const a of hist) {
    ensure(a.dir === `attempts/${a.attempt}`, 'Invalid attempt archive path');
    const old = read(inside(trialDir, `${a.dir}/trial.json`));
    ensure(old.attempt === a.attempt && old.trial_id === rec.trial_id, 'Attempt archive identity mismatch');
  }
  const n = Math.max(rec.attempt, hist.length + 1, ...nums.map(n => n + 1));
  ensure(!exists(inside(trialDir, `attempts/${n}`)), 'Archive destination exists; refusing native overwrite');
  // Validate ALL top-level entries before the native function moves/removes anything.
  for (const rel of files(trialDir)) inside(trialDir, rel);
}

export function safeArchive(trialDir, native) {
  checkArchive(trialDir, native);
  return native.archiveAttempt(trialDir);
}

export async function inspectCampaign({runtime, modelIndex, expectedSource = SOURCE_SHA256, native: supplied}) {
  ensure(modelIndex === 0 || modelIndex === 1, '--model-index must select GPT 0 or GLM 1');
  runtime = fs.realpathSync(runtime);
  ensure(!/\s/.test(runtime), 'Whitespace in runtime paths cannot be verified with portable ps; refused');
  const source = verifyManifest(runtime, expectedSource);
  const handoff = read(inside(runtime, 'HANDOFF.json'));
  ensure(handoff.campaign === CAMPAIGN && handoff.source_sha256 === source.source_sha256, 'Handoff identity mismatch');
  const configFile = inside(runtime, `bench/campaigns/${CAMPAIGN}.json`), cfg = read(configFile);
  ensure(cfg.id === CAMPAIGN && cfg.worlds === 32 && cfg.models.length === 2 && cfg.parallel_per_model === 16 && cfg.agent_options.apiTries === 4, 'Campaign contract mismatch');
  equal(cfg.experiments, ['i2', 'i1', 'i0'], 'Experiment ordering mismatch');
  const benchDir = inside(runtime, cfg.benchmark);
  for (const [name, digest] of [['benchmark', cfg.expected_benchmark_sha256], ['construction', cfg.expected_construction_sha256]])
    ensure(digest && sha(fs.readFileSync(inside(benchDir, name + '.json'))) === digest && source[name + '_sha256'] === digest, `${name} digest mismatch`);
  const native = supplied ?? await frozenFunctions(runtime);
  const bench = native.loadBenchmark(benchDir), construction = read(inside(benchDir, 'construction.json'));
  ensure(construction.protocol === cfg.protocol && construction.rows.length === 32, 'World construction mismatch');
  const model = cfg.models[modelIndex], stateDir = inside(runtime, `${cfg.state_dir}/split-${modelIndex}`);
  const registration = read(inside(stateDir, 'registration.json'));
  equal(registration.campaign, cfg, 'Original registered campaign changed');
  ensure(registration.model_index === modelIndex, 'Wrong host/model registration');
  const modelPath = inside(runtime, model.config), rawModel = read(modelPath), resolved = native.loadModelConfig(modelPath);
  ensure(registration.model_config_sha256.find(m => m.config === model.config)?.sha256 === sha(fs.readFileSync(modelPath)), 'Registered model digest mismatch');
  equal(resolved, {name: path.basename(modelPath, '.json'), ...rawModel}, 'Environment model/provider/options override refused');
  ensure(rawModel.harness === 'legacy' && rawModel.wire_api === 'responses' && rawModel.reasoning_effort === 'low' && rawModel.skill_context?.type === 'pinned-markdown', 'Unexpected model protocol');
  const jobDir = inside(runtime, `${cfg.jobs_dir}/${model.job_id}`), jobConfig = read(inside(jobDir, 'config.json'));
  equal(jobConfig.agent_options, cfg.agent_options, 'Job agent options changed');
  equal(jobConfig.agents, [`llm:${model.config}`], 'Job agent/model changed');
  equal(jobConfig.experiments, cfg.experiments, 'Job experiments changed');
  ensure(jobConfig.job_id === model.job_id && jobConfig.benchmark_sha256 === cfg.expected_benchmark_sha256 && jobConfig.parallel === 16
    && jobConfig.failure_handling.max_concurrent_llm === 16 && jobConfig.repeats === 1 && jobConfig.model_draws === 1 && jobConfig.keep_sim_data === true, 'Original job contract changed');
  const agentMain = verifyAgent(runtime, jobDir, jobConfig, handoff);
  const {trials, refused} = native.planJob(bench, {agents: jobConfig.agents, experiments: cfg.experiments, repeats: 1, modelDraws: 1});
  ensure(!refused.length && trials.length === 96 && jobConfig.trials_planned === 96, 'Original trial matrix changed');
  equal(Object.fromEntries(trials.map(t => [t.trial_id, t.agent])), jobConfig.planned_trials, 'Original planned slots changed');
  const ctx = {runtime, configFile, cfg, model, modelIndex, stateDir, jobDir, jobConfig, agentMain, bench, native, rawModel, trials};
  ctx.plan = trials.map(t => {
    const dir = inside(jobDir, t.trial_id), {rec, state} = native.trialStateOf(dir);
    ensure(path.resolve(t.task_dir).startsWith(benchDir + path.sep), 'Task path escapes benchmark');
    const taskDir = inside(benchDir, path.relative(benchDir, t.task_dir));
    const instance = read(inside(taskDir, 'environment/sim/instance.json'));
    const spec = construction.rows.find(row => row.preset === bench.tasks[t.task_id].instance_id)?.variants?.[t.experiment.toUpperCase()];
    ensure(spec, `Missing constructed world: ${t.task_id}`);
    equal(instance.spec, spec, `Frozen world spec changed: ${t.task_id}`);
    equal(instance.config, JSON.parse(JSON.stringify(native.taskConfig(spec, {track: t.track, hours: bench.tasks[t.task_id].hours}))), `Frozen world config changed: ${t.task_id}`);
    const task = native.readTaskToml(inside(taskDir, 'task.toml'));
    ensure(task.metadata.task_id === t.task_id && task.metadata.experiment === t.experiment && !task.metadata.agent_options_json, `Task identity/options changed: ${t.task_id}`);
    ensure(task.metadata.sweet_sim_snapshot_sha256 === bench.sweet_sim_snapshot_sha256, `Task source identity changed: ${t.task_id}`);
    if (rec) {
      for (const [key, expected] of Object.entries({trial_id: t.trial_id, task_id: t.task_id, agent: t.agent, repeat: t.repeat, model_draw: t.model_draw, experiment: t.experiment}))
        equal(rec[key], expected, `Trial identity mismatch: ${t.trial_id}/${key}`);
      const saved = inside(dir, 'agent/model.json');
      if (exists(saved)) equal(read(saved), resolved, `Trial model options changed: ${t.trial_id}`);
    }
    const statusFile = inside(dir, 'agent/status.json');
    const why = selection(rec, state, exists(statusFile) ? read(statusFile) : null);
    if (!why.startsWith('skip_')) checkArchive(dir, native);
    return {...t, dir, why, eligible: !why.startsWith('skip_')};
  });
  return ctx;
}

export function planOutput(ctx) {
  const counts = {};
  for (const t of ctx.plan) counts[t.why] = (counts[t.why] ?? 0) + 1;
  return {state: 'ready', mode: 'check', campaign: CAMPAIGN, model_index: ctx.modelIndex, job_id: ctx.model.job_id,
    concurrency: 16, api_tries: 4, extra_attempts_per_eligible_slot: 1, counts,
    eligible: ctx.plan.filter(t => t.eligible).map(t => ({trial_id: t.trial_id, reason: t.why}))};
}

// A stale lock is deliberately not stolen. An operator must verify and preserve it first.
export function acquireLock(ctx, owner, pass = randomUUID()) {
  const dir = inside(ctx.stateDir, 'recovery.lock');
  fs.mkdirSync(dir, {mode: 0o700});
  writeJson(path.join(dir, 'owner.json'), {pass, owner});
  return {dir, pass};
}
export function transferLock(lock, owner) {
  const previous = read(path.join(lock.dir, 'owner.json'));
  ensure(previous.pass === lock.pass, 'Recovery lock ownership lost');
  writeJson(path.join(lock.dir, 'owner.json'), {pass: lock.pass, owner, launcher: previous.owner});
}
export function releaseLock(lock, owner) {
  const record = read(path.join(lock.dir, 'owner.json'));
  ensure(record.pass === lock.pass && sameIdentity(record.owner, owner), 'Refusing to release another owner lock');
  fs.unlinkSync(path.join(lock.dir, 'owner.json')); fs.rmdirSync(lock.dir);
}

export async function executePass(ctx, {lock, owner, inventory = processInventory, ignored = [], now = () => new Date().toISOString()} = {}) {
  const record = read(path.join(lock.dir, 'owner.json'));
  ensure(record.pass === lock.pass && sameIdentity(record.owner, owner), 'Worker does not own recovery lock');
  const launcher = inventory().find(p => sameIdentity(p, record.launcher));
  if (launcher) ignored = [...ignored, launcher.pid];
  assertNoOwner(ctx, inventory(), [owner.pid, ...ignored]);
  const passDir = inside(ctx.stateDir, `recovery-passes/${lock.pass}`);
  fs.mkdirSync(passDir, {recursive: true, mode: 0o700});
  for (const name of ['status.json', 'progress.json']) {
    const f = inside(ctx.stateDir, name);
    if (exists(f)) fs.copyFileSync(f, path.join(passDir, 'prior-' + name), fs.constants.COPYFILE_EXCL);
  }
  const started = now(), attempted = [], skipped = [];
  let timer;
  const publish = (state, extra = {}) => {
    const counts = {done: 0, running: 0, agent_failed: 0, infra_failed: 0, not_started: 0};
    for (const t of ctx.trials) {
      const {rec} = ctx.native.trialStateOf(inside(ctx.jobDir, t.trial_id));
      const s = rec?.status ?? 'not_started'; counts[s] = (counts[s] ?? 0) + 1;
    }
    const status = {state, campaign: CAMPAIGN, started, updated: now(), pid: owner.pid, recovery_pass: lock.pass,
      jobs: [{id: ctx.model.job_id, dir: ctx.jobDir, planned: 96, ...counts, incomplete: 96 - counts.done}],
      attempted, skipped, ...extra};
    writeJson(path.join(passDir, 'status.json'), status);
    writeJson(inside(ctx.stateDir, 'progress.json'), status);
    writeJson(inside(ctx.stateDir, 'status.json'), status);
    return status;
  };
  try {
    const eligible = ctx.plan.filter(t => t.eligible);
    if (!eligible.length) return publish(ctx.trials.every(t => ctx.native.trialDone(inside(ctx.jobDir, t.trial_id))) ? 'complete' : 'finished_with_failures',
      {reason: 'no_eligible_trials', no_api_calls: true});
    publish('preflight');
    // Exactly one native bounded probe; never changes endpoint/model or retries the pass.
    const probe = await ctx.native.probeModel({modelConfig: inside(ctx.runtime, ctx.model.config), outDir: path.join(passDir, 'probe'), maxTokens: 1024});
    if (!probe.ok || !probe.model_matches || probe.returned_effort !== ctx.rawModel.reasoning_effort)
      return publish('pending', {reason: 'preflight_failed_or_identity_unverified', retry_after_seconds: 300});
    assertNoOwner(ctx, inventory(), [owner.pid, ...ignored]);
    publish('running');
    // Native pool has no requeue: each initially eligible slot is visited only once.
    let fatal = null, stopForAuth = false;
    timer = setInterval(() => { try { publish('running'); } catch (e) { fatal ??= e; } }, 15000);
    await ctx.native.pool(eligible, 16, async t => {
      if (fatal || stopForAuth) return;
      try {
        // Exclude our own descendants, but never a newly appeared external controller/agent.
        const procs = inventory(), descendants = new Set([owner.pid, ...ignored]);
        for (let changed = true; changed;) {
          changed = false;
          for (const p of procs) if (descendants.has(p.ppid) && !descendants.has(p.pid)) { descendants.add(p.pid); changed = true; }
        }
        assertNoOwner(ctx, procs, [...descendants]);
        const {rec, state} = ctx.native.trialStateOf(t.dir), statusFile = inside(t.dir, 'agent/status.json');
        const why = selection(rec, state, exists(statusFile) ? read(statusFile) : null);
        if (why.startsWith('skip_')) { skipped.push(t.trial_id); return; }
        const attempts = safeArchive(t.dir, ctx.native);
        const attempt = Math.max(attempts.length, ...attempts.map(a => a.attempt)) + 1;
        attempted.push({trial_id: t.trial_id, attempt}); publish('running');
        const result = await ctx.native.runTrial({taskDir: t.task_dir, trialDir: t.dir, agent: t.agent,
          repeat: t.repeat, modelDraw: t.model_draw, experiment: t.experiment,
          agentOptions: ctx.jobConfig.agent_options, keepSimData: ctx.jobConfig.keep_sim_data,
          agentMain: ctx.agentMain, attempt, attempts});
        if (result.failure?.reason === 'auth') stopForAuth = true;
        ctx.native.summarizeJob(ctx.jobDir, {bench: ctx.bench, write: true, includeFailed: false});
        publish('running');
      } catch (e) { fatal ??= e; }
    });
    if (fatal) throw fatal;
    ctx.native.summarizeJob(ctx.jobDir, {bench: ctx.bench, write: true, includeFailed: false});
    const incomplete = ctx.trials.some(t => !ctx.native.trialDone(inside(ctx.jobDir, t.trial_id)));
    return publish(incomplete ? 'finished_with_failures' : 'complete', {finished: now(), ...(stopForAuth ? {reason: 'auth_fail_fast'} : {})});
  } catch {
    // Never serialize exception messages from execution: provider errors can contain credentials.
    return publish('pending', {reason: 'recovery_interrupted_or_safety_check_failed', retry_after_seconds: 300});
  } finally { if (timer) clearInterval(timer); }
}
