# Baseline

公开入口与 agent 使用同一份冻结配置、同一 SimEnv、同一动作校验和 COGI-4-8/v1 评分。决策函数只接收公开 observation：CGM 的噪声、偏差、中断、延迟等仍存在；输注动作也经过同一个故障模型，不保证发出的剂量全部实际送达。

| ID | 实现 |
|---|---|
| `standard` | `sim/src/policies/care.mjs`：标准护理启发式 |
| `guideline` | 同文件：指南启发式 |
| `oref1` | `sim/src/policies/oref1.mjs`：SMB/UAM-inspired 策略，使用保留许可的 oref0 组件 |
| `hcl` | `sim/src/policies/hcl.mjs`：简化预测性 HCL，不是厂商固件 |

论文主实验对照是 **15min 的 standard/guideline/oref1**。`hcl` 留作额外比较，不加入这个默认三策略列表。不要把 oref1 与简化 HCL 当成同一算法。

5min 模式每个仿真步咨询策略；其他频率由原有 `hourlyPolicy` / `HourlySchedule` 调度器按指定间隔咨询，并保留每个本地日最多 6 次公开紧急告警额外决策。非咨询步为 WAIT，已下发临时基础率等按设备语义持续/到期，**不是后台每 5min 偷跑闭环**。所有模式的生理积分和记录步长相同。

每条输出 `bundle.json`、`RESULT.json`、`run.json`、框架播放器 `index.html`，全组输出 `RESULTS.json` 和 `SUMMARY.json`。每个输出目录只允许新建，避免不同频率或版本覆盖。完整模型结果只应与同 task、同设备、同评分版本的 baseline 配对。

该公开入口是重新计算用的代码，不把新算出的结果伪装成历史论文结果，也不包含历史实验的巨大缓存。可用 `--tasks TASK_ID,...` 或 `--limit 1` 做 CPU-only 小规模检查。
## Configurable Baseline Runs

`baselines` accepts the same `--experiment`, `--dataset`, `--hardware`, `--scenarios`, `--tasks` and `--limit` selection as agent runs. `--interval` accepts any positive multiple of five minutes. Custom horizons and scoring windows use the configured evaluator. Pump-only policies on pen hardware return `not_applicable` with a null score. See [EXPERIMENTS.md](EXPERIMENTS.md) for background oref/HCL versus baseline consultation cadence and matched comparisons.
