# Claude Code 最终标准：B sim2 + 整合闭环知识 Skill

2026-10-30当前硬件研究配置见[已确认COGI-4-8发布说明](../../docs/HARDWARE-COGI48-RELEASE-20261030.zh-CN.md)及`bench/campaigns/hardware-cogi48-confirmed-20261030.json`。当前为原生Skill任务入口、详细章节建议、COGI-4-8/v1及显式并发4；下文METRICS-v0.3/32并发等为旧批次标准及历史结果，不能覆盖新登记。原生history恢复和暂时网关无限等待须有完整来源/余预算证据，不可用于重抽已保存回复。

新实验从 [2.1.296 运行交接](../../docs/EXPERIMENT-RUN-HANDOFF-CODE296.zh-CN.md) 开始：包含资产前置条件、离线验收、登记、启动、监控与安全续接边界。

2026-10-28 用户更新：后续实验固定官方 Claude Code **2.1.296**，独立安装位置和 Linux SHA 见 `standard.mjs` 的 `CODE_RUNTIME`。不得继承旧 PLAN 中的2.1.310、自动更新或修改用户本地 coding 安装。旧结果保留实际版本，跨版本续接明确记录每段来源，不称全程同版本。

**用户在32题完整验收后确认采用本版**，标识 `claude-code-decision-loop/b-sim2-integrated-skill-v1`，定义见 `standard.mjs`。每个控制器决策由真实官方 Claude Code 完成原生工具循环，不是每次模型调用新建进程，也不接入另一个planner。

旧四题无Skill的 `b-sim2-v1` 保留为 `LEGACY_HARNESS` 与 `register-fixed4-legacy.mjs`；更早C仅作历史参照。新批次不得误用旧入口或把历史结果当作本版模型结果。

| 项 | 标准值 |
|---|---|
| 进程边界 | 每次控制器决策一个真实的 Claude Code 进程 |
| `simulate` | 每个决策最多 2 次。这是上限，不再放宽，放宽会变慢 |
| `read_glucose_history` | 每个决策最多 3 次，沿用原控制器限制 |
| Claude Code 轮数上限 | 7（3 次读历史 + 2 次 simulate + 1 次 act + 1 轮纠错） |
| Skill | 将HCL与oref1/SMB/UAM知识直接整合到原Skill已有3个文件，原安全契约不变 |
| `read_glucose_skill` | 每决策最多3次，和其他工具共同消耗原生7轮，不额外加轮数 |
| 并发 | 默认上限32；本次仍只有32个预选世界，完成题不补跑 |
| 控制器、世界、评分 | 不变：v6、notes / rolling12 / history3h、METRICS-v0.3 |

标准登记固定simulate2、7轮、整合版Skill。并发可以在新登记的spec里显式设为1–32；偏离32的值记录到 `deviations_from_standard`，`standard_harness` 为null，不能冒称完全相同配置。历史四题profile的并发范围仍为1–4。

四种经典baseline也已统一为每小时一次加紧急唤醒，版本 `classical-baselines/hourly-urgent-v1`。实际咨询次数可能不同：Claude还可使用预算内随访；不要把共同上限说成实际次数相同。

## 机制

- 每个决策开始时，原控制器照常构建上下文。
- `read_glucose_history`、`simulate`、`read_glucose_skill`：MCP挂起调用，由原控制器按原预算返回精确结果，Claude Code在同一进程里继续。MCP不自行读任意文件、不执行治疗动作。
- `act`：MCP 只登记提议，不应答。随后进程立即被 SIGKILL，再由原控制器唯一执行动作、推进环境并评分。必须先 SIGKILL：如果先发 SIGTERM，MCP 子进程会先退出，Claude Code 会再发起一次多余的模型请求。
- 并行调用：Claude Code 发不出 `disable_parallel_tool_use` 参数。一次回复里出现多个工具调用时，每个调用都返回错误（不执行、不扣预算），模型改为逐个重发。这一步计入 `native_corrections`。
- 工具 JSON 损坏、工具名未声明时，由 Claude Code 在决策内原生纠错，受轮数上限约束。所有中间回复都会保留。轮数用尽后回到原控制器的格式纠正路径。
- 续接的决策会在该决策剩余部分保留 Claude Code 原生的 `Continue from where you left off.` 控制文本。
- Code原生纠错后若上游以明确502终止，必须报告真实传输故障，不能拿之前被拒的工具回复冒充本次回复。502按原外层预算重试并至少退避60秒；鉴权/额度失败不循环重试。
- `registered-prefix.mjs`用于显式登记的无损续接：校验每条原请求、回复SHA及原CPU状态；历史回复保留replay标志，审计单列历史/新调用。未采纳完整回复必须先核对，不丢弃重抽；首个恢复进程仅用原剩余轮数。普通新批次不启用该功能。

## 流程

```sh
# 1. 本机创建新的隔离payload；只准备，不发模型请求：
node scripts/stage-decision-loop-skill-study.mjs <new-local-output>
# 按集群SOP传到一个从未登记的新目录，不覆盖旧source。
# 2. 在新服务器目录内离线就绪检查（全部0上游API）：
CODE_TEST_BINARY=<claude.exe 2.1.296> node control/run-tests.mjs <root>/OFFLINE-CORE
CODE_TEST_BINARY=<claude.exe 2.1.296> node control/controller-smoke.mjs <root>/OFFLINE-72H
CODE_TEST_BINARY=<claude.exe 2.1.296> node control/offline-skill.mjs <root>/OFFLINE-SKILL
# 3. 登记只写PLAN/READY，不启动；输入同题baseline身份已在stage核对：
node control/register-live.mjs OFFLINE-CORE OFFLINE-SKILL OFFLINE-72H
# 4. 只有用户授权后启动，key只从stdin读取，不写进文件或argv：
printf '{"key":"%s"}' "$KEY" | node control/launch-live.mjs
```

`runtime`为冻结三天运行时与整合版Skill资产，不入库，stage不使用dirty科学源码替换它。此campaign staging依赖已交付三天世界、原Skill修订资产及既有选题记录，路径在脚本中明确；不是无需资产的通用一键重跑。当前实验固定2.1.296，Linux SHA256 `24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de`。下面32题历史验收使用2.1.310，不随文档更新改写历史。

## 最终验收依据

32种场景各1个预选三天I2世界，12原样携带、20精确前缀续接；32全部独立原生审计有效、0无效，进程及收集器已退出。CLI回环25测试、20题407历史调用CPU重建及脚本三天谱系验收均通过，验证没有上游模型调用。

| 同世界小时baseline | 配对数 | Claude | baseline | 差值 |
|---|---:|---:|---:|---:|
| standard |32|0.491966|0.231772|+0.260194|
| guideline |32|0.491966|0.261697|+0.230269|
| hcl |31|0.489504|0.397621|+0.091883|
| oref1 |31|0.489504|0.305889|+0.183616|

126条baseline重新解压核原生reward及世界配置通过，另2项笔式闭环N/A。实际决策均值Claude89.53、baseline约72.1，无原Skill同harness对照臂，不声称知识单因素因果提升或临床疗效。完整来源和验收在 `output/claude-code-b-sim2-integrated-skill-20261027/` 的 `FINAL-CANONICAL-AUDIT.json`、`FINAL-COMPARISON.json`、`FINAL-CLOSEOUT.json`，交接见 `docs/HOURLY-BASELINE-CLOSED-LOOP-SKILL-20261027.zh-CN.md`。

## 历史四题接线比较（不是当前Skill对照）

| | C（每次调用一个进程，sim1） | B sim1 | **B sim2（标准）** |
|---|---:|---:|---:|
| 均分 | 0.542 | 0.525 | **0.546** |
| 平均耗时 | 14.0 分钟 | 11.6 分钟 | 11.8 分钟 |
| 格式错误 | 0 | 0 | 0 |

这仅是早期固定四题的历史观察，不估计重复采样方差，不证明统计等效或速度差的单因素归因。B的机制是在每个决策内由Code自己跑工具循环；本次采用的是上述整合Skill的32题最终验收版本。

结果和对比文件：`output/claude-code-decision-loop-sim2-fixed4-final-20261027/`（`COMPARISON-vs-C.json`、`COMPARISON-vs-B-sim1.json`）。
# Public Release Entry

For this repository use `scripts/benchmark.mjs` from the repository root and
`docs/RUNNING.md`. The historical notes below describe engine development;
internal registration/cluster launch commands are not public entrypoints.

