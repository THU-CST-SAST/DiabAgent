export const LEGACY_PROMPT_REVISION='availability-consistency/v3-neutral-missingness';
export const CURRENT_PROMPT_REVISION='availability-consistency/v4-ongoing-control-goal';
export const MEMORY_PROMPT_REVISION='availability-consistency/v5-memory-alerts';
// v6-shared-observation = v5 plus an exact JSON copy of the public observation in each decision message
// (reconstructed byte-for-byte from the captured requests in harnesses/claude-code-decision-loop/CAPTURE-FIXTURES.json).
export const SHARED_OBSERVATION_PROMPT_REVISION='availability-consistency/v6-shared-observation';
export const SCORE_PRIORITY_PROMPT_REVISION='availability-consistency/v7-score-priority';
export const CENTER_TARGET_PROMPT_REVISION='availability-consistency/v8-center-target';
export const PROMPT_REVISIONS=Object.freeze([LEGACY_PROMPT_REVISION,CURRENT_PROMPT_REVISION,MEMORY_PROMPT_REVISION,SHARED_OBSERVATION_PROMPT_REVISION,SCORE_PRIORITY_PROMPT_REVISION,CENTER_TARGET_PROMPT_REVISION]);
/** v5 and v6 share the memory/alert prompt; v6 only adds the shared observation block. */
export const sharedObservationRevision=r=>r===SHARED_OBSERVATION_PROMPT_REVISION||r===SCORE_PRIORITY_PROMPT_REVISION||r===CENTER_TARGET_PROMPT_REVISION;
export const memoryRevision=r=>r===MEMORY_PROMPT_REVISION||sharedObservationRevision(r);

export function resolvePromptRevision(revision=CURRENT_PROMPT_REVISION) {
  if(!PROMPT_REVISIONS.includes(revision))throw new Error(`Unknown prompt_revision ${revision}; expected ${PROMPT_REVISIONS.join(' or ')}`);
  return revision;
}
