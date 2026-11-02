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

The scenarios cover meals and digestion, exercise, changing insulin requirements, infusion failures, and sensor disturbances. Task definitions and model profiles are available in [`benchmark/main212/`](benchmark/main212/) and [`benchmark/models.json`](benchmark/models.json).

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

The five model profiles use the following harnesses:

| Model | Profile | Native CLI |
|---|---|---|
| Claude Opus 5.5 | `opus55` | Claude Code 2.1.296 |
| GPT 6.1 Sol | `gpt61` | Codex 0.163.0 |
| DeepSeek 4.1 Flash | `deepseek41` | Claude Code 2.1.296 |
| Kimi K3.1 Pro | `kimi31` | Claude Code 2.1.296 |
| GLM 5.3 Flash | `glm53flash` | Claude Code 2.1.296 |

Provide a credential and a compatible HTTPS endpoint for the selected model. Claude Code profiles use a Messages-compatible endpoint; the Codex profile uses a Responses-compatible endpoint. Model inference is billed by your provider.

```bash
node scripts/benchmark.mjs list

read -s DIABAGENT_API_KEY
export DIABAGENT_API_KEY

node scripts/benchmark.mjs run --model opus55 --limit 1 \
  --binary /absolute/path/to/claude.exe \
  --endpoint https://your-provider.example \
  --parallel 1 --out artifacts/opus55-check

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
benchmark/          Main212 tasks, protocol, and model profiles
sim/src/            Simulator, task constructors, policies, and scoring
sim/model/          Physiological model
sim/knowledge/      Patient, device, insulin, and sensor specifications
sim/harnesses/      Native Claude Code and Codex integrations
sim/skills/         Skill source pin and benchmark edition builders
sim/scripts/video/  Interactive trajectory player
scripts/            Benchmark, baseline, and task-construction commands
examples/           Example task specifications
test/, sim/test/    Release, simulator, and protocol tests
docs/               Detailed guides and release information
```

## Documentation

Additional guides are currently available in Chinese:

- [Task construction](docs/TASKS.md)
- [Runtime and harness configuration](docs/RUNNING.md)
- [Experiment protocol](docs/PROTOCOL.md)
- [Baseline policies and schedules](docs/BASELINES.md)
- [Release information](docs/RELEASE.md)

## License and Research Use

DiabAgent is released under the [MIT License](LICENSE). Third-party components and the external Skill retain their respective terms; see [Third-Party Notices](THIRD_PARTY_NOTICES.md).

This benchmark is designed for research with synthetic patients. See [Safety and Security](SECURITY.md) for responsible use.
