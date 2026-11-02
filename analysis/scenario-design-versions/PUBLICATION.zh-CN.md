# 场景版本发布入口

本页是新增的发布导航，不替换历史 README、index.json、current.json 或任何冻结清单。当前设计仍由 [current.json](current.json) 指向 v4.2；[历史索引](index.json) 记录的是 2026-10-18 当时的 v4.1。

| 正式版本 | 内部 ID 前缀 | 主世界 / 三档题目 | 可用入口 | 完整设计与日程 |
|---|---|---|---|---|
| v4.0 | V4R2- | 40 / 120 | [版本说明](v4.0/GUIDE.zh-CN.md)、[build.mjs](v4.0/build.mjs) | [全部40题](v4.0/DAY-SCHEDULES.zh-CN.md) |
| v4.1 | V4R3- | 32 / 96 | [版本说明](v4.1/GUIDE.zh-CN.md)、[build.mjs](v4.1/build.mjs) | [全部32题](v4.1/DAY-SCHEDULES.zh-CN.md) |
| v4.2 | V4R4- | 32 / 96 | [版本说明](v4.2/GUIDE.zh-CN.md)、[build.mjs](v4.2/build.mjs) | [全部32题](v4.2/DAY-SCHEDULES.zh-CN.md) |

## 版本与契约

v4.0 包含全部 legacy24 并扩展16题。v4.1 从 v4.0 原样保留28个世界，新增4个 D 世界，其中20个来自 legacy24。v4.2 原样保留这20个锚点，仅修订 B01、B03、D03-D06、F05-F06、H01-H04 共12个世界。V4R1 是探索草稿，不是 v4.0。相同短 ID 不意味着相同世界；提示词 v3/v4 也不是场景版本。

本入口对 v4.0/v4.1 使用冻结卡片的 `selective-records/v1`，原样保留 `partial_rules`。这是历史设计投影，不声称新增投影已完成效果审计。历史 v4.1 实验另用 `carbs-treatment-only/v1`，并不由此改变冻结草案；需要复现实验时以相应冻结 construction 为准，不把本次发布当作历史实验复现。

v4.2 明确使用目录声明的 `carbs-treatment-only/v1`：I0 保留已有记录；I1 保留实际碳水和治疗，隐藏运动/生活/故障叙述及餐食计划；I2 使用原 `record-derived-v3`。IOB/COB 由可见外部记录计算，自身动作回执规则不变。继承的 `partial_rules` 只作历史元数据，不用于 v4.2 发布。

## 只检查或构建

从仓库根目录执行，Node 24+，使用 sweet-sim 已有依赖：

```bash
node analysis/scenario-design-versions/v4.0/build.mjs --check
node analysis/scenario-design-versions/v4.1/build.mjs --plan-only --scenarios B01,C01
node sweet-sim/scripts/build-scenario-version.mjs --version v4.2 --check
node analysis/scenario-design-versions/v4.2/build.mjs --out /tmp/sweet-sim-v42-publication-new
```

`--check`、`--plan` / `--plan-only` 均不写文件、不运行完整 WAIT 轨迹、不调用模型。它们校验冻结文件、新支持文件、完整日程内容、场景选择和解析后的物理配置。无版本的共享入口报错，不自动跟随 current 指针；版本本地入口禁止切到其他版本。选择只接受该版本短 ID 或完整 ID，拒绝其他版本前缀、未知和重复 ID。

只有显式 `--out` 才调用既有 `buildScenarioPipeline`，在新目录生成 Harbor 题目与固定 WAIT 信息/真值审计，不运行 Agent、模型批次或历史实验。已存在目录一律拒绝，不续写也不覆盖。构建会对所选全部世界做确定性检查，不按分数筛题。输出任务使用 `v40-a01-i0`、`v41-a01-i0`、`v42-a01-i0` 等版本命名空间，因此不冒充历史 benchmark 的同名任务或内容哈希。

新入口直接读取本版本完整 `instance_spec`，使用既有 plan/buildScenarioPipeline；不运行历史 build-scenario-* 生成器，不访问被忽略的 legacy construction，也不读取其他版本或可变顶层设计副本。共享内核仍是当前仓库实现；本次没有冻结一套新的生理内核，也不声称跨内核版本复算必然一致。

## 冻结边界和证据

各版本原 `manifest.json` 及其覆盖文件保持逐字不变。新增 `publication-manifest.json` 单独记录本版本 build.mjs、GUIDE、DAY-SCHEDULES 的 SHA256/字节数，绑定原 manifest 哈希及共享发布脚本哈希。根目录 `publication-manifest.json` 另外覆盖本页与当前指南。它们不回填旧 manifest，不修改历史 index。哈希用于完整性校验，不替代签名或源码提交。

原归档 builder 的相对导入和部分 Markdown 链接保留历史原形；请使用上表新增入口与日程，不在冻结文件里修补路径。基础依据见 [原研究登记](../scenario-family-evidence-v1-20261016.zh-CN.md)、[扩展研究](../../sweet-sim/knowledge/scenario-hard-evidence-v3.json)、[v4.1保留的机制说明](v4.1/scenario-v4-evidence-and-mechanisms-20261018.zh-CN.md)。旧说明里的相对链接和“当前”字样必须按其日期理解。日程只引用研究编号，不把文献支持误当成参数或组合已临床验证。

comparator 是研究意向，不是执行代码或额外主世界。v4.2 的继承文字及 I1 ID 已有过时之处，详见版本 GUIDE；真实日程只取 instance_spec。新文档不新增对照世界、治疗策略或生理机制，不把设计状态当作实验完成状态。
