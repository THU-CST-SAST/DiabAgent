# v4.2 发布说明

[全部版本](../PUBLICATION.zh-CN.md) · [完整32题设计与日程](DAY-SCHEDULES.zh-CN.md) · [原12题修订摘要](DESIGN.zh-CN.md) · [冻结清单](manifest.json) · [新增支持清单](publication-manifest.json) · [版本入口](build.mjs)

正式版本 v4.2，内部前缀 V4R4-，32个主世界：A4/B4/C4/D6/E4/F6/H4。20个 legacy24 锚点与 v4.1 完全一致；只修订 B01、B03、D03-D06、F05-F06、H01-H04 共12题，不新增事件族。

唯一世界来源是本目录 [完整目录](scenario-v42-day-cards-20261019.json) 的全部 instance_spec。新 build.mjs 可从任何工作目录用绝对路径执行，不运行 analysis/build-v42-design.mjs，也不读取 v4.1 或旧 construction。共享实现位于仓库 sweet-sim/scripts/build-scenario-version.mjs，并由新增支持清单绑定哈希。

从本目录执行：

```bash
node build.mjs --check
node build.mjs --plan-only --scenarios B01,D05
node build.mjs --out /tmp/sweet-sim-v42-publication-new
```

检查/规划只读且无完整轨迹、模型或实验；显式构建才调用既有固定 WAIT 审计和 Harbor 导出。已存在输出目录拒绝覆盖。全部32个世界均有设计卡、完整历史和日程，不只列修订12题；三档题目96个。任务 ID 带 v42- 前缀，不复用历史 benchmark 标识/内容哈希。

## 明确的信息契约

有效契约固定为目录声明的 `carbs-treatment-only/v1`。I0 保留全部已有记录；I1 保留实际碳水与治疗，隐藏运动、生活、故障叙述及所有 meal 类计划/叙述 record；I2 为原 `record-derived-v3`，仍显示由可见记录派生的 IOB/COB，自身动作及回执逻辑不变。隐藏记录不代表事件未发生，也不改实际生理世界。

所有继承的 partial_rules 只作历史元数据，明确不用于本版本发布。D05 中旧 stress-end 已拆成 stress-end-1/stress-end-2；F05 的 calibration-narrative 已不在新日程。不得将这些旧 ID 自动修补后当成冻结的 I1。新入口使用既有 pipeline 明确生成上述契约。

## 继承 comparator 的限制

原 comparator 未随12题世界修订而同步更新，本次不改它们或旧 manifest。新日程逐字标注为“历史 comparator”，不是执行配置，不会额外生成对照：

- B01 仍写原 G01/G02 的1.5 U 时点对照；新主世界实际为起点前20分钟2.5 U，并有前90分钟40 g慢餐，不能照旧文认定严格匹配。
- H01 仍写“相同三餐”，新日程有5次实际摄入；只能把无 illness 理解为未来对照意向，不能声称已生成匹配世界。
- H02 对 H03 的引用来自旧族映射，不是当前 H03；摄入、历史和恢复时点必须按各自冻结 spec 分开读。
- H03 仍写旧15/20/50 g三餐；新日程有15/10/25/65/20 g共5次摄入。不能用旧文解释新世界或宣称仅改恢复时点。
- 其他保留 comparator 也不是已构造、已审计的反事实；需要对照时须另行冻结配置，本次不创建。

完整日程从 instance_spec 重新排表，不继承旧表的时间/剂量；challenge_windows 仅为评测方说明，不注入 Agent，不新增评分。其余20个锚点也完整列出，不把“未修订”误写成“无需设计文档”。

原 manifest 及其覆盖文件不修改；新增文件由 publication-manifest.json 单独覆盖。证据入口与共享内核边界见 [发布总览](../PUBLICATION.zh-CN.md#冻结边界和证据)。没有运行模型实验，也不从已有结果筛题。
