# 环境、Harness 与运行

## 环境

推荐原实验平台 Linux x86_64、Node.js 24.21.0。macOS 可以运行离线仿真；其他平台的 native CLI 必须另行提供同版本二进制和明确 SHA256，不能伪称使用 Linux 原二进制。`sim/package-lock.json` 锁定 JS 依赖，`npm run setup` 完成安装和 Skill 构建。Dockerfile 仅提供相同 Node 版本的 verify/baseline 环境，不分发商业工具或凭据；模型运行请按本页在 checkout 环境安装 CLI 和构建 Skill。

## 原生 CLI

| 模型 profile | native harness | CLI |
|---|---|---|
| `opus55` / Claude Opus 5.5 | `native-skill-decision-loop/v1` | Claude Code 2.1.296 |
| `gpt61` / GPT 6.1 Sol | `official-codex-decision-loop/v1` | Codex 0.163.0 |
| `deepseek41` / DeepSeek 4.1 Flash | `native-skill-decision-loop/v1` | Claude Code 2.1.296 |
| `kimi31` / Kimi K3.1 Pro | `native-skill-decision-loop/v1` | Claude Code 2.1.296 |
| `glm53flash` / GLM 5.3 Flash | `native-skill-decision-loop/v1` | Claude Code 2.1.296 |

在独立目录安装所需版本，不覆盖日常 coding 安装：

```bash
npm install --prefix "$HOME/diabagent-tools/code296" @anthropic-ai/claude-code@2.1.296
npm install --prefix "$HOME/diabagent-tools/codex163" @openai/codex@0.163.0
```

给 `--binary` 的是官方 **native 可执行文件**，不是 npm shell/JS wrapper。安装后的具体 vendor 目录随平台而变；可在上述独立安装目录内查找。验证 `--version`：Code 必须为 2.1.296，Codex 必须为 `codex-cli 0.163.0`。Linux Code 原二进制 SHA256：`24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de`。其他平台需导出自己核验过的 `CLAUDE_BINARY_SHA256`；这是明确的平台差异，不跳过版本检查。

## 执行

README 中的命令默认跑一个模型。去掉 `--limit 1` 后跑全部 212 题；`--parallel N` 为该进程的并发，默认 1，最大 64。多个进程不会全局协调并发或队列所有权，因此不要对同一个模型/输出目录重复启动。每次运行必须指定全新 `--out`。

`--endpoint` 明确指定 HTTPS 服务。Code 需要 Anthropic Messages/原生签名兼容接口（通常不带 `/v1`）；Codex 需要 Responses 兼容 base URL（通常带 `/v1`）。模型别名必须与 profile 相符，工具/签名不兼容会失败关闭，不静默切到另一个模型或 direct API harness。自有凭据通过 `--key-env ENV_NAME`（默认 `DIABAGENT_API_KEY`）进入内存和 native 子进程环境，配置中只记录变量名，不保存值。日志仍应在公开分享前检查。

本次发布仅做离线工程测试，没有用用户凭据进行付费预检，也不宣称所有外部网关今天都可用。

## 故障与报告

原有 gateway loop 在原请求/回复/预算证据完整时按 60/120/240/480/600s 退避；鉴权、余额、权限错误失败退出。可选 `--decision-redraw true` 使用已有运行器 wrapper，支持的 deadline/runner 故障最多 4 次新 native 请求，完整记录 `DECISION-REDRAW.jsonl`。进程整体崩溃后的 WAL 自动恢复**尚未验收**，不要删除失败输出后直接从零重跑并称为无损续接。

模型控制器的动作必须通过 schema 检查后才交付世界。未完成轨迹、审计失败不能计入平均分，`RESULT.json` 的 `score` 为 null；审计原件保留。`STATUS.json` 每 5s 更新；该文件不是模型还在推进的充分证据。完整题生成框架原生 HTML 播放器，报告含 evaluator 结果，不能反过来交给 agent。
