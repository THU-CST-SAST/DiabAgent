# v4.0 发布说明

[全部版本](../PUBLICATION.zh-CN.md) · [完整40题设计与日程](DAY-SCHEDULES.zh-CN.md) · [冻结清单](manifest.json) · [新增支持清单](publication-manifest.json) · [版本入口](build.mjs)

正式版本 v4.0，内部前缀 V4R2-，40个主世界：A6/B4/C4/D2/E4/F6/G6/H8。全部 legacy24 原样保留，新增16题；原疾病题改归 H 不表示修改物理世界。V4R1 不属于本版本。

唯一世界来源是本目录 [完整目录](scenario-v4r2-day-cards-20261018.json) 的全部 instance_spec。新 build.mjs 可从任何工作目录用绝对路径执行，不运行同目录历史 build-scenario-v4r2-design.mjs，不需要旧 construction、顶层设计副本或其他版本。共享实现位于仓库 sweet-sim/scripts/build-scenario-version.mjs，并由新增支持清单绑定哈希；不是脱离仓库的独立软件包。

从本目录执行：

```bash
node build.mjs --check
node build.mjs --plan-only --scenarios A01,G01
node build.mjs --out /tmp/sweet-sim-v40-publication-new
```

检查/规划只读且无完整轨迹、模型或实验；显式构建才调用既有固定 WAIT 审计和 Harbor 导出。已存在输出目录拒绝覆盖。主世界40个，三档题目120个；子集只包含显式选择的本版本世界。任务 ID 带 v40- 前缀，不覆盖历史任务。

## 信息和历史元数据

有效契约 `selective-records/v1`：I0/I2 为既有 record-derived-v3，I1 原样使用冻结 partial_rules，不把 v4.2 的规则套回本版本。草案规则不保证三种投影都不同；构建保留实际 distinct_information_projections 检查结果，不改世界或规则来凑差异。

comparator 只表示候选机制对照，不代表已经生成/执行对照。G01/G02 等引用按本版本命名空间理解，不能按后续版本同名短 ID 配对。每张新日程完整列出冻结 comparator、partial_rules、依据、静态背景、全部历史与事件，并重新计算 instance_spec 哈希。意向记录不是未来保证；区间结束不清空体内残余。数值是合成设定，不是临床建议。

原 manifest 及其覆盖文件不修改；新增文件由 publication-manifest.json 单独覆盖。原归档 builder 和旧链接保持原形，使用本页导航。证据入口及共享内核边界见 [发布总览](../PUBLICATION.zh-CN.md#冻结边界和证据)。没有运行模型实验，也不承诺复刻旧 benchmark 的内容哈希。
