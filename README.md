# DiabAgent

面向合成 1 型糖尿病患者的长时序决策 benchmark。包含仿真构造器、主实验的 **212 个冻结 task**、五模型原生 CLI harness、实验 Skill 的固定版本构建流程，以及 classical baselines。

**仅用于研究仿真，不是临床建议，也不连接真实患者或设备。** 不包含 API 密钥、商业 CLI 二进制、旧实验操作目录或书籍全文副本。原生 CLI 和模型访问需要自行安装、授权；不能把旧模型别名替换成别的模型后仍称为同配置复现。

## 快速开始

Linux/macOS，Git、npm、Node.js **24.21.0**（`.nvmrc`）；Linux 是原实验平台。

```bash
git clone --recurse-submodules git@github.com:THU-CST-SAST/DiabAgent.git
cd DiabAgent
nvm install
nvm use
npm run setup
npm run verify
npm test
```

`setup` 安装 lockfile 中的依赖，核对外部 Skill 的固定提交，再在本地生成主实验 Skill；不会请求模型。普通 clone 后可先执行 `git submodule update --init --recursive`。Skill 的来源与许可边界见 [第三方组件](THIRD_PARTY_NOTICES.md)。

## 三个入口

### 1. 构造新题

```bash
node scripts/benchmark.mjs create --spec examples/task.json --out artifacts/my-task
node scripts/benchmark.mjs pipeline --config sim/bench/pipelines/custom.example.json
node scripts/benchmark.mjs pipeline --config sim/bench/pipelines/custom.example.json --out artifacts/my-suite
```

单题输出 evaluator 私有的 `fixture.json` 和可给 agent 的 `public.json`；批量构造器支持场景、患者、硬件、种子、信息条件的组合和兼容性检查。见 [造题说明](docs/TASKS.md)。新造题不等于冻结主实验题，不要覆盖 `benchmark/main212/fixtures/`。

### 2. 运行主实验

```bash
node scripts/benchmark.mjs list
# 先用一个 task 检查自己的模型服务，再去掉 --limit 1 跑全量。
read -s DIABAGENT_API_KEY
export DIABAGENT_API_KEY
node scripts/benchmark.mjs run --model opus55 --limit 1 \
  --binary /absolute/path/to/claude.exe \
  --endpoint https://YOUR-COMPATIBLE-PROVIDER \
  --parallel 1 --out artifacts/opus55-check
unset DIABAGENT_API_KEY
```

上面的 `run` **会产生付费模型调用**。`--model` 可用 `opus55 / gpt61 / deepseek41 / kimi31 / glm53flash`；GPT 使用 Codex 原生二进制，其他模型使用 Claude Code。端点必须明确提供，不能使用示例地址。各 CLI 的安装、精确版本、输出及可选重试见 [运行环境](docs/RUNNING.md)。

### 3. 运行 baseline

```bash
# CPU-only，小样本快速验证。
node scripts/benchmark.mjs baselines --limit 1 --interval 15 \
  --policies standard,guideline,oref1 --out artifacts/baseline-check
# 全部 212 题，论文主表的三种 15min baseline。
node scripts/benchmark.mjs baselines --interval 15 \
  --policies standard,guideline,oref1 --out artifacts/baseline-main212-15min
```

另支持 `hcl`，以及 `5/10/15/20/30/45/60/90/120` 分钟。它们在相同的扰动 CGM、输注故障和信息约束下运行，不读取真值做决策。评分才使用 evaluator 真值。见 [Baseline](docs/BASELINES.md)。

## 协议与输出

主实验：Dana-i + Aspart、无后台 HCL、I2、72 小时、864 个 5min 步长；agent 每 60min 固定决策，每个本地日最多 6 次额外决策。COGI-4-8/v1 总分为 `0.50 S_TIR + 0.35 S_Hypo + 0.15 S_GV`。完整配置、提示词入口与版本见 [复现协议](docs/PROTOCOL.md)。

模型输出包含 `STATUS.json`、每题 `bundle.json`、原始 native 会话、`invocations.jsonl`、`transcript.jsonl`、严格审计和 `RESULT.json`。未完成或审计不通过的分数为 `null`，不会补 WAIT 冒充完成。完整轨迹和 baseline 的 `index.html` 使用现有框架交互播放器生成，可直接打开。

```bash
node scripts/benchmark.mjs report --bundle PATH/TO/bundle.json --out artifacts/replay
```

## 目录

| 路径 | 内容 |
|---|---|
| `benchmark/main212/` | 212 原始冻结题目、SHA256、主实验协议 |
| `benchmark/models.json` | 五模型配置及 harness 路由 |
| `sim/src/`, `sim/model/`, `sim/knowledge/` | 仿真、构造器、观察/动作、评分、baseline |
| `sim/harnesses/` | Claude Code / Codex 原生决策循环、工具边界、审计与重试 |
| `sim/skills/` | 固定上游 gitlink、派生规则；`main212/` 由 setup 构建 |
| `sim/scripts/video/` | 框架原有的交互报告播放器 |
| `scripts/` | 可移植的公开运行入口，不依赖内部服务器目录 |
| `analysis/scenario-design-versions/` | 构造器兼容测试所需的历史场景目录，不是主实验集 |
| `test/`, `sim/test/` | 离线发布与仿真/工具协议测试 |

代码许可见 [LICENSE](LICENSE)；第三方许可各自保留。版本差异及验收范围见 [发布说明](docs/RELEASE.md)。本仓库不包含新分支的 Dana-i oref 后台泵实现。
