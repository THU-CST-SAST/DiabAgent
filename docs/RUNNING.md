# Running Models Under a Harness

## Select a Harness

DiabAgent supports native CLI harnesses, API adapters and custom modules. Native runs supply `--harness`, `--model`, `--binary`, and `--endpoint` explicitly. See [Custom Experiments](EXPERIMENTS.md) for configuration files and additional interfaces.

| Harness | CLI version | Endpoint contract |
|---|---|---|
| `claude-code` | Claude Code 2.1.296 | Messages API, streaming, native tool calls, high effort, and the configured thinking interface |
| `codex` | Codex 0.163.0 | Responses API, streaming, function tools, high effort, and preserved response identities |

The runner accepts provider model identifiers such as `organization/model-name`. Responses must identify the requested model. The existing explicitly documented Claude spelling alias remains supported. Provider compatibility is determined by the request/response contract; model selection is independent of the paper experiment configurations.

Runtime defaults are in `configs/harnesses/`. The shared task protocol is in `benchmark/main212/protocol.json`: 72h, hourly decisions plus six extras per local day, native7/Read3/simulate2, high effort, and 16,384 output tokens. The simulator, scoring, and tools are common to both harnesses.

## Install the CLI

Use Node.js 24.21.0 and an independent CLI installation:

```bash
npm install --prefix "$HOME/diabagent-tools/code296" @anthropic-ai/claude-code@2.1.296
npm install --prefix "$HOME/diabagent-tools/codex163" @openai/codex@0.163.0
```

Locate the installed native executable and pass its absolute path as `--binary`. Version checks require Claude Code 2.1.296 or `codex-cli 0.163.0`. The reference Linux Code binary SHA256 is `24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de`. A same-version build for another platform can be pinned with `CLAUDE_BINARY_SHA256`.

Linux x86_64 is the reference model-execution platform. Offline simulation and tests also run on macOS. The Dockerfile provides a Node-pinned verification/baseline environment.

## Configure Your Provider

Provide the exact model identifier in `--model`. A Code endpoint generally uses a Messages-compatible base URL; a Codex endpoint generally ends in `/v1` and exposes `/responses`. Use HTTPS with credentials supplied separately through an environment variable.

```bash
read -s DIABAGENT_API_KEY
export DIABAGENT_API_KEY
node scripts/benchmark.mjs run \
  --harness claude-code --model YOUR_MODEL_ID \
  --binary /absolute/path/to/claude.exe \
  --endpoint https://your-provider.example \
  --limit 1 --parallel 1 --out artifacts/model-check
unset DIABAGENT_API_KEY
```

Use `--key-env OTHER_ENV_NAME` to select a different credential variable. The saved plan records the variable name, model, endpoint, harness, CLI identity, and task hashes. Keep credentials out of URLs and configuration files.

### Codex Model Catalog

The Codex harness creates an isolated model catalog for the selected identifier. For custom identifiers its default capability template uses a 128,000-token context window, high reasoning effort, and the benchmark dynamic tool interface. The benchmark system instructions are supplied explicitly by the controller.

For provider-specific context limits or native model metadata, supply a Codex-format JSON file with a `models` array containing exactly one matching `slug`:

```bash
node scripts/benchmark.mjs run \
  --harness codex --model YOUR_MODEL_ID \
  --model-catalog /absolute/path/to/model-catalog.json \
  --binary /absolute/path/to/codex \
  --endpoint https://your-provider.example/v1 \
  --limit 1 --out artifacts/model-codex-check
```

The native catalog schema is illustrated by `harnesses/codex-decision-loop/model-catalog.json`. Configure capabilities supported by your endpoint. The actual selected catalog is saved inside each native session; the run plan records the hash of a user-supplied catalog. Native request guards enforce the selected model and benchmark tool surface.

## Run the Task Set

Remove `--limit 1` to run all 212 reference tasks. `--tasks TASK_ID,...` selects an exact subset; `--scenarios A01,F02` selects scenario templates. `--parallel N` accepts a positive integer and controls process concurrency; choose a value within your host and provider limits. Start each evaluation in a fresh output directory, and assign task ownership to one runner process.

`--experiment FILE.json` configures hardware, world parameters, scheduling, agent options, model settings and harness budgets. `--dataset DIRECTORY` uses constructed or prepared tasks. `--interval 15` changes the agent schedule without changing the physiological simulation grid. Audits use the resolved protocol stored in `PLAN.json`. See [EXPERIMENTS.md](EXPERIMENTS.md) for runnable examples and option precedence.

Gateway retries retain request evidence and use 60/120/240/480/600s backoff. Authentication, quota, and permission failures terminate the request. `--decision-redraw true` enables the runtime's recorded fresh-request recovery for supported deadline/runner failures, up to four attempts. Whole-process crash recovery remains outside the validated recovery scope.

## Inspect Results

```bash
# Progress, valid-task means, JSON summary, and CSV exports.
node scripts/benchmark.mjs results --run artifacts/model-check

# Add an interactive report for completed valid trajectories.
node scripts/benchmark.mjs results --run artifacts/model-check --report
```

| Output | Use |
|---|---|
| `STATUS.json` | Worker task states, updated every five seconds |
| `summary.json` | Completion counts, per-task status, aggregate scores, and observation time |
| `summary.csv` | Mean COGI and its three component scores |
| `tasks.csv` | Per-task states and scores |
| `report/index.html` | Browser-based task selector and trajectory replay |
| `trials/TASK_ID/RESULT.json` | Task completion and audit result |
| `trials/TASK_ID/*AUDIT.json` | Native evidence and world checks |
| `trials/TASK_ID/bundle.json` | Full simulator/evaluator record |
| `trials/TASK_ID/Code/` or `Codex/` | Native requests, responses, tool calls, and results |

The results command checks completion, native audit validity, and agreement between the saved reward and bundle score before aggregation. Incomplete or invalid rows retain an empty score. Each valid completed task has equal weight in the mean. Run the command again to refresh a snapshot while the worker progresses.

Open `report/index.html` directly in a browser. The existing framework player provides task selection, a timeline, glucose/CGM curves, treatments, events, and decision rationales. Baseline directories use the same results command and report renderer. A single saved bundle can also be rendered with `benchmark.mjs report --bundle PATH --out DIRECTORY`.

Trajectory reports contain evaluator data and are intended for post-run analysis. Review raw logs before sharing them publicly.
