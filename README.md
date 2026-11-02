# DiabAgent

## Overview

DiabAgent is a benchmark for long-horizon glucose management with AI agents. Agents manage synthetic patients with type 1 diabetes by interpreting continuous glucose monitoring (CGM) readings, consulting clinical knowledge, maintaining memory, and choosing treatment actions over multi-day episodes. Performance is evaluated from the resulting glucose trajectories.

This repository provides the main experiment's **212 tasks**, a physiological simulator, task constructors, native Claude Code and Codex harnesses, a versioned glucose-management Skill, classical baselines, and interactive trajectory reports.

| Component | Main Experiment |
|---|---|
| Task set | 212 tasks across 32 scenario templates |
| Episode length | 72 hours, with 864 five-minute simulation steps |
| Hardware | Dana-i pump with Aspart insulin, under agent control |
| Information setting | I2, with sensor perturbations and task-specific events |
| Agent schedule | Hourly decisions and up to six additional decisions per local day |
| Evaluation | COGI-4-8/v1: `0.50 S_TIR + 0.35 S_Hypo + 0.15 S_GV` |

The scenarios cover meals and digestion, exercise, changing insulin requirements, infusion failures, and sensor disturbances. The task set is in [`benchmark/main212/`](benchmark/main212/); harness defaults are in [`configs/harnesses/`](configs/harnesses/).

## Installation

Use **Node.js 24.21.0**, npm, and Git. Linux x86_64 is the reference platform for model experiments; offline simulation and tests also run on macOS. The Node.js version is recorded in [`.nvmrc`](.nvmrc).

```bash
git clone --recurse-submodules https://github.com/THU-CST-SAST/DiabAgent.git
cd DiabAgent
npm run setup
npm run verify
npm test
```

The setup command installs dependencies from the lockfile and builds the benchmark Skill from its pinned upstream revision. Verification checks the task hashes and runtime manifests. For an existing checkout, initialize the Skill dependency with `git submodule update --init --recursive`.

Model experiments additionally require the official native CLI for the selected harness:

```bash
npm install --prefix "$HOME/diabagent-tools/code296" @anthropic-ai/claude-code@2.1.296
npm install --prefix "$HOME/diabagent-tools/codex163" @openai/codex@0.163.0
```

Supply the installed native executable through `--binary`. Platform-specific binary locations and identity checks are described in [`docs/RUNNING.md`](docs/RUNNING.md).

## Running the Benchmark

Choose a harness and supply the model identifier exposed by your provider. The harness controls the native tool loop, Skill access, memory, and evidence collection; the benchmark supplies the tasks and evaluation protocol.

| Harness | CLI | Provider Interface | Defaults |
|---|---|---|---|
| `claude-code` | Claude Code 2.1.296 | Messages-compatible streaming and tools | [Configuration](configs/harnesses/claude-code.json) |
| `codex` | Codex 0.163.0 | Responses-compatible streaming and tools | [Configuration](configs/harnesses/codex.json) |

`--model` is passed to your provider and checked against its responses. Model inference is billed by your provider. Configure a credential and inspect the task list:

```bash
node scripts/benchmark.mjs list

read -s DIABAGENT_API_KEY
export DIABAGENT_API_KEY
```

### Claude Code Harness

```bash
node scripts/benchmark.mjs run \
  --harness claude-code --model YOUR_MODEL_ID --limit 1 \
  --binary /absolute/path/to/claude.exe \
  --endpoint https://your-messages-provider.example \
  --parallel 1 --out artifacts/my-model-code
```

### Codex Harness

```bash
node scripts/benchmark.mjs run \
  --harness codex --model YOUR_MODEL_ID --limit 1 \
  --binary /absolute/path/to/codex \
  --endpoint https://your-responses-provider.example/v1 \
  --parallel 1 --out artifacts/my-model-codex
```

Codex accepts an optional `--model-catalog PATH.json` for provider-specific model capabilities. See the [harness guide](docs/RUNNING.md) for endpoint requirements, CLI setup, and catalog configuration. After running your chosen harness, clear the credential from the shell:

```bash
unset DIABAGENT_API_KEY
```

Start with a single task to check the service configuration. Remove `--limit 1` to evaluate all 212 tasks, and set `--parallel` to select concurrency. Use a fresh `--out` directory for each run. Individual tasks can be selected with `--tasks TASK_ID,...`.

The harness provides simulation and history tools, native Skill access, rolling memory, request logging, and trajectory audits. The main configuration requests high reasoning effort and 16,384 output tokens, with seven native model turns, three reference reads, and two simulation calls per decision. The complete settings are in [`benchmark/main212/protocol.json`](benchmark/main212/protocol.json).

## Baselines

All baselines use the same task configurations, observations, device dynamics, and scoring implementation as the agent experiments.

| Policy | Description |
|---|---|
| `standard` | Standard-care heuristic |
| `guideline` | Guideline-based heuristic |
| `oref1` | oref1-inspired controller with SMB/UAM mechanisms |
| `hcl` | Simplified predictive hybrid closed-loop controller |

The main experiment compares agents with `standard`, `guideline`, and `oref1` at a **15-minute decision interval**. Run a small CPU-only evaluation with:

```bash
node scripts/benchmark.mjs baselines --limit 1 --interval 15 \
  --policies standard,guideline,oref1 --out artifacts/baseline-check
```

For the full task set:

```bash
node scripts/benchmark.mjs baselines --interval 15 \
  --policies standard,guideline,oref1 --out artifacts/baseline-main212-15min
```

Supported decision intervals are `5/10/15/20/30/45/60/90/120` minutes. Five-minute policies are consulted at each simulation step; other intervals retain up to six urgent consultations per local day. Outputs include per-task trajectories, total scores, component scores, and an aggregate summary.

## Creating Tasks

Task constructors expose patient characteristics, devices, sensors, events, seeds, and information settings. Create a task from the supplied example:

```bash
node scripts/benchmark.mjs create \
  --spec examples/task.json --out artifacts/my-task
```

The output contains an evaluator-side `fixture.json` and an agent-facing `public.json`. For batch construction, the scenario pipeline combines patient, hardware, and event settings with compatibility checks:

```bash
# Inspect the task-generation plan.
node scripts/benchmark.mjs pipeline \
  --config sim/bench/pipelines/custom.example.json

# Build the task suite.
node scripts/benchmark.mjs pipeline \
  --config sim/bench/pipelines/custom.example.json --out artifacts/my-suite
```

The constructor API is implemented in [`sim/src/sim/instance.mjs`](sim/src/sim/instance.mjs), with batch generation in [`sim/src/experiments/scenario-pipeline.mjs`](sim/src/experiments/scenario-pipeline.mjs).

## Trajectories and Reports

### Check Progress and Scores

Run the following command during or after an evaluation:

```bash
node scripts/benchmark.mjs results --run artifacts/my-model-code
```

It prints completion counts, mean COGI, and mean `S_TIR`, `S_Hypo`, and `S_GV`. The command also writes `summary.json`, `summary.csv`, and per-task `tasks.csv` into the run directory. Mean scores use completed, audit-valid trajectories; progress counts cover the full planned task set.

### Open the Interactive Report

```bash
node scripts/benchmark.mjs results --run artifacts/my-model-code --report
```

Open **`artifacts/my-model-code/report/index.html`** in a browser. Use the task selector and timeline to inspect glucose, sensor readings, treatments, events, and decision rationales. This report uses the benchmark's existing trajectory player. Run the command again to include newly completed tasks. The same command works on baseline output directories.

### Inspect Individual Trajectories

Each model run writes a `STATUS.json` and per-task records:

| File | Contents |
|---|---|
| `bundle.json` | Full simulation trajectory and evaluator data |
| `transcript.jsonl` | Controller decisions and action receipts |
| `invocations.jsonl` | Model requests and responses |
| `Code/` or `Codex/` | Native harness session records |
| `RESULT.json` | Completion status, audit validity, and score |
| `run.json`, `index.html` | Interactive trajectory replay |

Aggregate model scores use completed, audit-valid trajectories. Interactive reports show glucose readings, treatments, events, and decision rationales through the simulator's trajectory player. Generate a replay from a saved bundle with:

```bash
node scripts/benchmark.mjs report \
  --bundle PATH/TO/bundle.json --out artifacts/replay
```

Open the generated `index.html` in a browser.

## Repository Structure

```text
benchmark/          Main212 tasks and model-independent evaluation protocol
configs/harnesses/  Claude Code and Codex runtime defaults
harnesses/          Native tool loops, model transport, and audits
sim/src/            Simulator, task constructors, policies, and scoring
sim/model/          Physiological model
sim/knowledge/      Patient, device, insulin, and sensor specifications
sim/skills/         Skill source pin and benchmark edition builders
sim/scripts/video/  Interactive trajectory player
scripts/            Benchmark, baseline, and task-construction commands
experiments/paper/  Model configurations used in the paper
examples/           Example task specifications
test/, sim/test/    Release, simulator, and protocol tests
docs/               Detailed guides and release information
```

## Documentation

Guides and protocol references:

- [Task construction](docs/TASKS.md)
- [Runtime and harness configuration](docs/RUNNING.md) (English)
- [Experiment protocol](docs/PROTOCOL.md)
- [Baseline policies and schedules](docs/BASELINES.md)
- [Release information](docs/RELEASE.md)
- [Paper experiment configurations](experiments/paper/README.md) (English)

## License and Research Use

DiabAgent is released under the [MIT License](LICENSE). Third-party components and the external Skill retain their respective terms; see [Third-Party Notices](THIRD_PARTY_NOTICES.md).

This benchmark is designed for research with synthetic patients. See [Safety and Security](SECURITY.md) for responsible use.
