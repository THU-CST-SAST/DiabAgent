// Current standard: B sim2, integrated Skill, pooled seven-turn native loop and up to32 worlds.
// The earlier four-world/no-Skill profile remains explicit for historical reproduction only.
export const CODE_RUNTIME = Object.freeze({
  version: '2.1.296',
  binary: process.env.CLAUDE_BINARY ?? null,
  sha256: '24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de',
  authority: 'Human 2026-10-28: switch experimental Claude Code to 2.1.296; use the same version for future experiments.',
});
export const LEGACY_HARNESS = Object.freeze({
  id: 'claude-code-decision-loop/b-sim2-v1',
  harness: 'native-decision-loop/v1',
  simulate_calls_per_decision: 2,   // hard cap: the user ruled out more than 2 (slower)
  max_native_turns_per_decision: 7, // 3 history reads + 2 simulate + act + 1 native correction
  history_reads_per_decision: 3,    // original controller limit, unchanged
  parallel_worlds: 4,               // the fixed four worlds run fully parallel
  adopted: '2026-10-27',
  authority: 'Human 2026-10-27: 我们目前使用 B sim2 作为标准的 harness',
});

// Adopted after the 32-world integrated-Skill cohort completed with independent native audits.
export const STANDARD_HARNESS = Object.freeze({
  ...LEGACY_HARNESS,
  id: 'claude-code-decision-loop/b-sim2-integrated-skill-v1',
  parallel_worlds: 32,
  skill_reads_per_decision: 3,
  skill_revision: 'sweet-sim.skill-closed-loop-integrated/v1',
  authority: 'Human 2026-10-27: adopt the completed integrated-Skill version as the final operating method',
});

/** Resolves the per-run budget: the standard unless explicitly overridden; any override is recorded as a deviation. */
export function resolveBudget(env = process.env) {
  return resolveFor(STANDARD_HARNESS, env);
}

export function resolveLegacyBudget(env = process.env) {
  return resolveFor(LEGACY_HARNESS, env);
}

function resolveFor(profile, env) {
  const simulate = Number(env.SIMULATE_CALLS ?? profile.simulate_calls_per_decision);
  const turns = Number(env.MAX_NATIVE_TURNS ?? profile.max_native_turns_per_decision);
  const parallel = Number(env.PARALLEL ?? profile.parallel_worlds);
  if (!Number.isInteger(simulate) || simulate < 1 || simulate > 2) throw new Error('simulate budget must be 1 or 2');
  if (!Number.isInteger(turns) || turns < 1 || turns > 8) throw new Error('max native turns must be 1..8');
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > profile.parallel_worlds) throw new Error('parallel worlds must be 1..' + profile.parallel_worlds);
  const deviations = Object.entries({ simulate_calls_per_decision: simulate, max_native_turns_per_decision: turns, parallel_worlds: parallel })
    .filter(([key, value]) => value !== profile[key]).map(([key, value]) => ({ key, standard: profile[key], value }));
  return { simulate, turns, parallel, standard: deviations.length === 0, deviations };
}
