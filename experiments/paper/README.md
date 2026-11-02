# Paper Experiment Configurations

This directory records the model configurations used in the paper:

- `models.json`: the five evaluated models and their original runtime settings.
- `protocol.json`: the original model-specific preparation record for the task protocol.

To evaluate another model, choose `--harness claude-code` or `--harness codex` and pass your provider's identifier with `--model`. Runtime defaults are in `configs/harnesses/`; the public runner reads these defaults independently of this directory.

The original metadata in `benchmark/main212/MAIN-SET.json` records how the task set was selected. The current task list is `benchmark/main212/TASKS.json`.
