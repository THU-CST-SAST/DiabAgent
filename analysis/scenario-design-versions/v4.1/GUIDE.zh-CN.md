# v4.1 发布说明

[全部版本](../PUBLICATION.zh-CN.md) · [完整32题设计与日程](DAY-SCHEDULES.zh-CN.md) · [冻结清单](manifest.json) · [新增支持清单](publication-manifest.json) · [版本入口](build.mjs)

正式版本 v4.1，内部前缀 V4R3-，32个主世界：A4/B4/C4/D6/E4/F6/H4。从 v4.0 原样保留28个主世界，新增 D03-D06；其中20个世界来自 legacy24。本页发布不读取 v4.0，也不重建它来获得这些保留世界。

唯一世界来源是本目录 [完整目录](scenario-v4r3-day-cards-20261018.json) 的全部 instance_spec。新 build.mjs 可从任何工作目录用绝对路径执行，不运行同目录历史 build-scenario-v4r3-design.mjs，不需要旧 construction、顶层设计副本或其他版本。共享实现位于仓库 sweet-sim/scripts/build-scenario-version.mjs，并由新增支持清单绑定哈希。

从本目录执行：

```bash
node build.mjs --check
node build.mjs --plan-only --scenarios A01,H04
node build.mjs --out /tmp/sweet-sim-v41-publication-new
```

检查/规划只读且无完整轨迹、模型或实验；显式构建才调用既有固定 WAIT 审计和 Harbor 导出。已存在输出目录拒绝覆盖。主世界32个，三档题目96个；子集只包含显式选择的本版本世界。任务 ID 带 v41- 前缀。

## 信息和历史元数据

本入口发布冻结设计，使用 `selective-records/v1`：I1 原样读取卡片 partial_rules，I0/I2 沿用 record-derived-v3。历史 v4.1 注册实验另用 `carbs-treatment-only/v1`；该执行修订不是冻结设计卡的一部分。本入口不声称重建历史实验；不能把两种 I1 的结果当成同一条件。

comparator 仅为历史研究意向，引用的 v4.0 G/H 短 ID 不是本目录同名题，也不是已执行对照。尤其 H03 的“旧 H07”来自上一版，不能直接当作同参数单因素世界。旧 partial_rules 仍是草案，构建允许并记录实际投影重合，不按投影数或得分改题。

完整日程逐题给出依据、意图、原 comparator/rules、静态背景和所有显式历史、事件、传感器区间；世界权威始终是冻结 instance_spec。日程不是提供给模型的全知上下文，不新增治疗策略、评分或生理机制。

原 manifest 及其覆盖文件不修改；新增文件由 publication-manifest.json 单独覆盖。原归档 builder 和旧链接保持原形，使用本页导航。证据与共享内核边界见 [发布总览](../PUBLICATION.zh-CN.md#冻结边界和证据)。没有运行模型实验。
