# Evaluation Harnesses

| Public CLI choice | Implementation | Provider protocol |
|---|---|---|
| `--harness claude-code` | `claude-code-decision-loop/` | Messages |
| `--harness codex` | `codex-decision-loop/` | Responses |

Both harnesses accept a user-supplied model identifier and enforce the benchmark tool surface, Skill edition, public observation boundary, and decision budgets. The native CLI generates requests and handles its tool loop. Request/response records and action receipts support the trajectory audit.

Use `scripts/benchmark.mjs run` from the repository root. Configuration examples and result inspection are documented in the root README and `docs/RUNNING.md`. `sim/harnesses` is a relative compatibility link for simulator imports.
