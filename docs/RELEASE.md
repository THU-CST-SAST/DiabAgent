# 发布范围与版本差异

此仓库从 SweetBench `main` 的 `a154355dd0fbbb23377a19da7137590cef77128b` 整理为独立初始发布，不导入旧 Git 历史。

包含仿真核心、患者/设备/传感器模型、任务构造器、212 原始冻结 fixture、五模型原生 harness、Skill 固定上游与本地派生规则、baseline 和框架播放器。未加入 Dana-i oref 后台泵的新分支实现。

未包含旧 scientific worker 的集群提交脚本、服务器绝对路径和凭据、实验大缓存/历史结果、内部交接、志愿者重建记录或旧版 SweetBench 全文 QA 数据库。为构造器版本兼容测试保留的小型历史场景目录有独立名称，不参与主实验选题。

## 与原主实验对齐

- `benchmark/main212/fixtures` 来自最终归档的原始 212 个题目，逐字节 SHA256 校验，不重新造题代替。
- `original-runtime-hashes.json` 保留原主实验可分发运行核心的相对路径哈希。`npm run verify` 核对仿真/生理/知识配置/评分核心与原运行版本，唯一已有核心差异为 `src/bench/models/tool-contract.mjs` 的工具协议修复；没有修改任务物理或 COGI 公式。
- 公开 harness 复用当前 main 的健壮性修复，并只移除服务器专属的默认二进制位置/网关：生产 endpoint 显式配置，版本与模型检查仍保留。
- npm lockfile 的 `body-parser` 与 `qs` 更新为通过发布时 npm audit 的修复版本，只涉及 HTTP 解析依赖。原模型 CLI 不随 npm 依赖一起自动升级。
- Skill 从固定上游提交重新构建，最终文件列表 hash 必须等于主实验 `10f1e522...`；不会悄悄替换为简化 Skill。
- 公开默认配置和历史扩预算/恢复阶段不是“一切完全相同”的声明，详见 PROTOCOL.md。模型服务的可用性、随机性和价格不由本仓库锁定。

## 验收边界

发布验证使用离线单元/集成测试、全部 fixture 的原哈希检查、72h baseline 小样本、造题和原生框架报告 smoke。模型测试使用本机模拟服务；需要真实 native CLI 的 opt-in 测试在未配置该 CLI 时跳过。没有付费模型调用，也未重复原科学主实验。

CI 从 clean checkout、固定 Node、git submodule 和 lockfile 安装后重新运行相同入口。Dockerfile 作为部署配方提供；未安装 Docker 的发布环境不能声称做过镜像运行验收。
