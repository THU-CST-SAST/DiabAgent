# 主实验复现协议

| 项目 | 固定值 |
|---|---|
| 题目 | 212 个冻结 fixture，32 场景模板，明确的患者/种子 |
| 设备 | 普通 Dana-i 泵 + Aspart；无后台 HCL |
| 观察 | I2；扰动 CGM、自己的决策/回执和公开设备信息；不暴露隐藏事件/真值 |
| 时间 | 72h，864 个 5min 步，865 个含初始点的状态 |
| 决策 | 固定 60min + 每个本地日最多 6 次额外决策 |
| 工具 | 每次决策 native7、Read3、simulate2；历史窗口 3h |
| 记忆 | notes、rolling12、跨日记忆开、day reflection 关 |
| 输出 | 请求 high、16384 token；logical timeout 240s；实际 effort 以服务回执为准 |
| Prompt | `availability-consistency/v8-center-target`；偏好 5-6 mmol/L、中心 5.5 |
| Skill | `10f1e522b4ba24fbaa0a6d85ece7c047715f87099cd769ad13d9a2f6c8a24eb7` |
| 评分 | `COGI-4-8/v1`，0-100；`0.50 S_TIR + 0.35 S_Hypo + 0.15 S_GV` |

评分入口 `sim/src/bench/score.mjs` 调用 `cogi48.mjs`，仅使用 864 个评分采样，不把终点重复计入。原始公式、裁剪、单位换算以这些版本化实现及其测试为准。

Prompt 不是独立手写的另一个版本：`src/bench/prompt.mjs`、`prompt-revisions.mjs`、`controller.mjs` 和 `benchmark/llm-agent.mjs` 根据同一公开信息和协议生成。公开入口不把私有 fixture 注入模型，也不允许模型调用任意 shell/网络/真实设备。

五模型名称和路由在 `benchmark/models.json`。其中 GPT 使用官方 Codex，其他四个使用官方 Claude Code 的原生模型循环和 MCP；国内模型需要能提供该协议/签名语义的兼容服务。模型名称是实验记录里的精确别名，是否可用取决于你自己的服务权限。

历史主结果包含故障恢复和用户批准的格式纠错预算扩展，并非声称所有题都在初始预算一次完成。这里默认保留格式连续 3 次止损；可选 `--decision-redraw true` 明确开启运行器内的重请求并记录事件。它不是改分、不是按分数挑轨迹，也不是原 response 的精确续写。不承诺服务随机性下逐 token 或逐分一致。公开源与历史协议的区别见 RELEASE.md。
