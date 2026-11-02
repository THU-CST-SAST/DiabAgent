# Configuring Experiments

The public runner has two entry points to the same simulation and evaluation pipeline:

- **Default evaluation:** omit custom settings to run the frozen Main212 tasks with the reference protocol.
- **Custom evaluation:** select scenarios, override supported settings, or supply a new dataset. Validation checks the resolved configuration and trajectory, rather than requiring Main212's original constants.

Use fresh output directories. All examples below run from the repository root after `npm run setup`.

## Configuration File

```json
{
  "name": "my-pump-study",
  "dataset": "main212",
  "selection": {"scenarios": ["A01", "F02"], "limit": 2},
  "hardware": "dana-i-oref",
  "world": {"horizon_minutes": 180},
  "harness": "claude-code",
  "agent_options": {
    "decision_schedule": "hourly",
    "fixed_interval_minutes": 15,
    "max_extra_decisions_per_day": 0,
    "history_hours": 6,
    "memory": "notes",
    "memory_mode": "rolling",
    "keep_turns": 20,
    "simulate": true,
    "simulate_calls": 4
  },
  "runtime": {
    "max_native_turns": 12,
    "max_reference_reads": 5,
    "logical_timeout_ms": 360000,
    "max_turns": 1000,
    "max_format_errors": 10,
    "outer_api_tries": 1
  },
  "model": {"max_tokens": 8192, "reasoning_effort": "medium"},
  "scoring_version": "COGI-4-8/v1",
  "baseline": {"policies": ["standard", "guideline", "oref1"], "interval_minutes": 15}
}
```

Working files: [existing scenarios with oref](../examples/experiments/existing-scenes-oref.json), [HCL with five-minute decisions](../examples/experiments/hcl-five-minute.json), [custom scenario](../examples/experiments/custom-scene.json), and [reference defaults](../configs/experiments/main212.json).

Resolve or export before running; both commands make zero model calls:

```bash
node scripts/benchmark.mjs run --experiment examples/experiments/existing-scenes-oref.json --dry-run
node scripts/benchmark.mjs prepare --experiment examples/experiments/existing-scenes-oref.json --out artifacts/prepared
```

Run the prepared dataset:

```bash
node scripts/benchmark.mjs run --dataset artifacts/prepared \
  --harness claude-code --model YOUR_MODEL_ID \
  --binary /absolute/path/to/claude.exe \
  --endpoint https://your-messages-provider.example \
  --parallel 4 --out artifacts/custom-model
```

### Precedence and Records

Agent/runtime settings resolve from reference defaults, then a prepared dataset's saved protocol, then the experiment file, then CLI agent flags. `--interval` sets the fixed-slot schedule and its interval. Hardware presets patch each input world; `world` patches are applied afterward. CLI selection and `--hardware` override file selections and hardware. Model settings resolve from harness defaults, experiment `model`, then `--harness-config`; `--model` selects the provider identity. Explicit model reasoning effort also sets the agent's requested effort.

Paths inside an experiment file are relative to that file. CLI paths are relative to the current directory. `prepare` writes `TASKS.json`, `fixtures/` and `EXPERIMENT.json`; model runs retain the effective protocol in `PLAN.json` and actual inputs in `dataset/fixtures/`. Source fixtures remain unchanged.

## Hardware and Background Automation

```bash
node scripts/benchmark.mjs catalog
```

The catalog lists all implemented pump, pen, insulin and sensor identifiers, hardware presets, and agent option defaults. Presets include:

| Preset | Delivery | Background Controller |
|---|---|---|
| `dana-i`, `dash`, `combo` | Dana-i/Aspart, DASH/Fiasp, Combo/lispro | Off |
| `pens` | NovoPen 6/Aspart + Tresiba/degludec | Off |
| `dana-i-oref`, `dash-oref`, `combo-oref` | Corresponding pump | oref1-inspired SMB/UAM |
| `dana-i-hcl`, `dash-hcl`, `combo-hcl` | Corresponding pump | Predictive HCL |

An object can replace a named hardware preset, for example:

```json
{
  "hardware": {
    "therapy": {"mode": "pump", "pump": {"model": "medtrum_nano", "insulin": "fiasp"}},
    "cgm": {"model": "dexcom_g6"},
    "controller": {"enabled": true, "mode": "closed", "algorithm": "hcl", "expose_actions": true}
  }
}
```

`controller.algorithm` supports `oref0`, `oref1`, and `hcl`; omitted algorithm retains the original oref0 behavior when the loop is enabled. Closed mode applies device actions. Open mode can expose recommendations when `compute_suggestions` is enabled. Controllers consume the world's public sensor observations and run on fresh CGM samples, normally every five minutes. The agent has its own independently configured decision schedule. Manual temporary basal takes priority; agent and controller boluses share the actual device ledger and minimum interval. Sensor disturbances, delivery faults and patient dynamics remain active.

These are simulator controllers: oref1 is the repository's oref1-inspired policy, and HCL is its predictive hybrid loop, rather than certified commercial algorithms. Pump automation requires compatible pump and real-time CGM hardware. Multiple daily injections remain available with loop automation off. Device catalogs, action schemas and physical constraints still apply.

## Agent, Harness and Evaluation Options

All keys exported by `AGENT_OPTION_DEFAULTS` are accepted in `agent_options` and as dashed CLI flags. Inspect [the parser](../sim/src/bench/agent-options.mjs) for types, supported ranges and dependencies:

| Group | Options |
|---|---|
| Scheduling | `decision_schedule`, `fixed_interval_minutes`, `min_decision_minutes`, `max_decisions_per_day`, `max_extra_decisions_per_day`, `score_range_alerts` |
| Context | `history_hours`, `warmup_days`, `memory`, `memory_mode`, `keep_turns`, `cross_day_memory`, `day_reflection` |
| Reasoning/tools | `reasoning_effort`, `samples`, `simulate`, `simulate_calls`, `simulate_max_hours`, `prompt_revision` |

Fixed-slot intervals are multiples of five minutes, from five minutes upward. The daily extra-decision cap is configurable from 0 to 288 (default 6). `decision_schedule: "event-driven"` selects the existing event-driven scheduler; leave `fixed_interval_minutes` at 60 in that mode because it is unused. Keep the world's five-minute simulation/evaluation grid when changing agent frequency. `warmup_days` must leave a positive scored horizon; warmup history is retained while scores exclude it. Longer episodes need a sufficiently large `runtime.max_turns`. Shortening a world omits explicit events beyond its new horizon; extending a world does not invent additional custom events.

`world` accepts the existing normalized configuration groups: patient parameters, therapy, CGM/meter, scenario events, information disclosure, controller, clock and horizon. See [configuration defaults and validation](../sim/src/core/config.mjs). `scoring_version` selects a supported version from [score.mjs](../sim/src/bench/score.mjs), and `units` selects the existing display units. Main212 defaults and its COGI formula are preserved.

The `runtime` fields in the example control the native-turn, Read, logical-time, outer-controller and format-error budgets. `model` accepts adapter-supported output, reasoning and transport settings. Native harnesses still enforce their pinned CLI version and preserve provider identity, original output and tool evidence; they validate against the selected run settings. Advanced recovery paths can reject unsupported evidence shapes rather than silently reset budgets. Process-crash recovery is not promised.

### Additional Model Interfaces

Use the API adapter when a native CLI is unnecessary:

```bash
node scripts/benchmark.mjs run --experiment examples/experiments/custom-scene.json \
  --harness adapter --model YOUR_MODEL_ID \
  --endpoint https://your-responses-provider.example/v1 \
  --out artifacts/api-adapter
```

Override adapter settings using `--harness-config FILE.json`; existing adapters are implemented in [models/](../sim/src/bench/models/). Supply credentials only through the selected environment variable. Adapter runs record invocation evidence and deterministic world replay; their audit is identified as an adapter audit, distinct from native CLI provenance.

For a new integration, export `createHarness({config, root, endpoint, keyEnv, runtime})` from a trusted local ES module. Return a model implementing `complete(request)` in the existing [model interface](../sim/src/bench/models/scripted.mjs); optional `close()` releases resources. Start with [custom.mjs](../examples/harnesses/custom.mjs):

```bash
node scripts/benchmark.mjs run --experiment examples/experiments/custom-scene.json \
  --harness custom --harness-module examples/harnesses/custom.mjs \
  --model my-policy --out artifacts/custom-harness
```

The example is an offline WAIT policy for integration testing, requiring no endpoint or credential. Custom modules execute trusted local code. Extend the model interface or configuration parser in your fork for new capabilities; no five-model whitelist is required.

## Building Scenarios

Start from [custom-day.json](../examples/scenarios/custom-day.json) or [task.json](../examples/task.json). Configure a patient, seed, devices, information setting, recurring routines and explicit events. `overrides` exposes the underlying world configuration, including meal timing/absorption, exercise, faults and sensor effects supported by the simulator.

```bash
node scripts/benchmark.mjs create --spec examples/scenarios/custom-day.json --out artifacts/new-task
node scripts/benchmark.mjs run --dataset artifacts/new-task --dry-run
```

To generate combinations of scenarios, patients, devices and information modes:

```bash
node scripts/benchmark.mjs pipeline --config sim/bench/pipelines/custom.example.json
node scripts/benchmark.mjs pipeline --config sim/bench/pipelines/custom.example.json --out artifacts/new-suite
node scripts/benchmark.mjs prepare --dataset artifacts/new-suite --out artifacts/runnable-suite
```

An experiment's `dataset` also accepts `{"spec":"../scenarios/custom-day.json"}`, `{"pipeline":"path/to/pipeline.json"}`, or `{"fixture":"path/to/fixture.json"}`. Spec/pipeline values may be inline objects. Reusable dataset directories require `TASKS.json` plus `fixtures/`; constructor outputs with `fixture.json` and pipeline outputs with `construction.json` are accepted directly. Evaluator truth stays separate from the public information supplied to agents.

## Baselines and Results

Use the same prepared dataset to evaluate policies and agents:

```bash
node scripts/benchmark.mjs baselines --dataset artifacts/prepared --interval 15 \
  --policies standard,guideline,oref1,hcl --out artifacts/custom-baselines
node scripts/benchmark.mjs results --run artifacts/custom-model --report
node scripts/benchmark.mjs results --run artifacts/custom-baselines --report
```

The baseline `--interval` controls the policy consultation schedule; a world's enabled background controller still runs on its sensor cadence. For a standalone algorithm comparison, disable background automation in the dataset. Closed-loop baselines on incompatible hardware are reported as `not_applicable`, with no invented score.

`summary.json`, `summary.csv` and `tasks.csv` report valid completion counts, the configured score, and COGI components where applicable. Open `report/index.html` for the existing interactive trajectory player; rerun `results --report` to include new completions. Compare runs with matched tasks, hardware, observations, horizon and scoring settings. The default result path remains identical for the reference Main212 configuration.
