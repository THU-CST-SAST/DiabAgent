# V4R3 精简设计：32个主情景

本轮只修订设计。A/B/G收敛为A、B共8题；D扩展至6题；H精简至4题。原legacy24及冻结结果不改，其中20题原样进入新核心，另外4题仍保留于legacy24。
原A05/A06不作为主情景：当关键餐食记录被隐藏时，计碳高估/低估的标签已不可见，退化成实际摄入问题；这不代表两个不同摄入世界的曲线会相同。
下表为作者设计卡，不是给模型的全知提示词。时间为北京时间；所有数值是合成仿真配置，不是临床剂量或饮食建议。τ为时间常数，不是吸收完毕时间。
八个A/B主情景不包含机制对照世界。合并题的历史时点、恢复顺序进入对照，不额外重复计数。每物理世界有WAIT，信息投影及自身动作记忆规则保持。
新目录未接入原注册表，新题未完成全轨迹/信息投影审计，未跑新模型。传感器/设备维护仍须Agent按原工具自行执行。

| 类别 | 设计意图 | 主情景数 |
|---|---|---:|
| A 摄入过程与药效时序错配 | 只在外源摄入的次数、吸收及实际兑现过程上组织四种主挑战。保留旧复合题难度，不再把全天多餐、慢餐、取消餐和报告误差分别膨胀为很多同类题。药物始终有作用，但分类依据是主要发生改变的外源输入，不是这题是否出现胰岛素。 | 4 |
| B 既有治疗、残余药效与未完成输注 | 四题分别是给药时点、叠加历史、剩余输注承诺和已发生的救援输入。它们的关键是身体/设备已经处于什么状态，而非猜发生了哪顿饭。原 G02 等放到严格定义的对照或诊断档案，不再重复计为独立主情景。A/B 共八题；不存在一个额外的 G 主族。 | 4 |
| C 活动与延迟风险 | 保留 V4R2 的四道原活动复合题，原物理事件和参数不变。运动顺序、多次活动与跨夜尾部是主挑战；饮酒、进餐等可作次标签，不重复计题。 | 4 |
| D 非疾病的需求变化与肝糖输出扰动 | 从两题扩展至六题：保留两道原复合压力题，增加黎明、缺觉退出、餐后短时应激及无运动的饮酒延迟扰动。分别标注敏感性项或肝糖项，不把两者写成同一生理机制。新增题有明确物理扰动，隐藏叙述后仍存在；不把仅有名称变化的稳定背景算新主题。 | 6 |
| E 输注异常与恢复 | 原四道故障复合题不变。过去的主动暂停可作为状态鉴别/诊断条件，但不再额外增加一个与 B 重复的主情景。 | 4 |
| F 观测异常与证据切换 | 保留 V4R2 六题，含四道原复合题和两个已配置的设备/证据切换题。测量异常仍与信息记录隐藏正交，不新增污染或采血生理。 | 6 |
| H 疾病相关需求与摄入恢复 | 八题收敛到四种代表性情境：正常进食的高需求、低摄入的高需求、需求与摄入恢复错位、病日并存送达异常。早恢复/晚恢复等相近病例进入同一题的对照，而不是按不同病名或多个恢复时点重复计题。仍只使用现有 illness 代理，不增加真实病种动力学。 | 4 |

## A 摄入过程与药效时序错配

只在外源摄入的次数、吸收及实际兑现过程上组织四种主挑战。保留旧复合题难度，不再把全天多餐、慢餐、取消餐和报告误差分别膨胀为很多同类题。药物始终有作用，但分类依据是主要发生改变的外源输入，不是这题是否出现胰岛素。

### V4R3-A01 分散多次摄入与慢吸收主餐交叠

来源：V4R2-B01；原冻结题B01，物理配置未变。
意图：用原 B01 的八次摄入完整覆盖不规则多餐与慢输入，不再另把原 A01 算入新主集。 连续小输入与主餐吸收尾部交错，不简化成单一慢餐。
机制对照：同总摄入和时间，关键慢餐使用普通时间常数。
I1规则草案：[{"category":"meal","ids":["meal-4","plan-meal-4"]}]。正式运行前须核对有效投影。
依据：R14、R20、R21，来源同类现象不等于选定参数或组合已临床验证。
回合：10-17 11:45—10-18 11:45；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 11:40 | 前史：已有CGM校准 |
| 10-17 11:55 | 当下meal记录：Current intention: meal around 12:30, estimated 38 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 12:30 | 摄入38 g，上报38 g，τ=60 min |
| 10-17 13:45 | 当下meal记录：Current intention: meal around 14:20, estimated 20 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 14:20 | 摄入20 g，上报20 g，τ=60 min |
| 10-17 15:40 | 当下meal记录：Current intention: meal around 16:15, estimated 26 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 16:15 | 摄入26 g，上报26 g，τ=60 min |
| 10-17 17:50 | 当下meal记录：Current intention: meal around 18:25, estimated 23 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 18:25 | 摄入23 g，上报23 g，τ=60 min |
| 10-17 19:50 | 当下meal记录：Current intention: meal around 20:25, estimated 56 g carbohydrate; mixed meal reported high in fat/protein. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 20:25 | 摄入56 g，上报56 g，τ=140 min |
| 10-17 22:40 | 当下meal记录：Current intention: meal around 23:15, estimated 20 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 23:15 | 摄入20 g，上报20 g，τ=60 min |
| 10-18 03:30 | 当下meal记录：Current intention: meal around 04:05, estimated 18 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 04:05 | 摄入18 g，上报18 g，τ=60 min |
| 10-18 07:00 | 当下meal记录：Current intention: meal around 07:35, estimated 38 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 07:35 | 摄入38 g，上报38 g，τ=60 min |
| 10-18 11:45 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-A02 两次慢餐尾部叠加后续进食

来源：V4R2-B02；原冻结题B02，物理配置未变。
意图：保留两次慢输入及其间/之后摄入的原复杂度。 考察前一输入尚未结束时继续摄入的时序判断。
机制对照：同摄入量和时点，只改变首个慢餐时间常数。
I1规则草案：[{"category":"meal","ids":["meal-0","plan-meal-0","meal-2","plan-meal-2"]}]。正式运行前须核对有效投影。
依据：R14、R18，来源同类现象不等于选定参数或组合已临床验证。
回合：10-17 12:10—10-18 12:10；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 12:05 | 前史：已有CGM校准 |
| 10-17 12:20 | 当下meal记录：Current intention: meal around 12:55, estimated 59 g carbohydrate; mixed meal reported high in fat/protein. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 12:55 | 摄入59 g，上报59 g，τ=150 min |
| 10-17 14:55 | 当下meal记录：Current intention: meal around 15:30, estimated 23 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 15:30 | 摄入23 g，上报23 g，τ=60 min |
| 10-17 17:45 | 当下meal记录：Current intention: meal around 18:20, estimated 62 g carbohydrate; mixed meal reported high in fat/protein. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 18:20 | 摄入62 g，上报62 g，τ=160 min |
| 10-17 21:15 | 当下meal记录：Current intention: meal around 21:50, estimated 26 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 21:50 | 摄入26 g，上报26 g，τ=60 min |
| 10-18 01:45 | 当下meal记录：Current intention: meal around 02:20, estimated 23 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 02:20 | 摄入23 g，上报23 g，τ=60 min |
| 10-18 07:25 | 当下meal记录：Current intention: meal around 08:00, estimated 46 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 08:00 | 摄入46 g，上报46 g，τ=60 min |
| 10-18 12:10 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-A03 预打后主餐取消并开始活动

来源：V4R2-A02；原冻结题A02，物理配置未变。
意图：保留预打、实际小餐和活动的错配，不能简化成无药效的取消意向。 已发生药效、少量摄入和活动叠加，需要应对时序改变。
机制对照：同给药史和活动，计划餐兑现；另设无预打版本，不能一次改两项。
I1规则草案：[{"category":"meal","ids":["cancelled-lunch","meal-0"]}]。正式运行前须核对有效投影。
依据：R01、R04，来源同类现象不等于选定参数或组合已临床验证。
回合：10-17 12:00—10-18 12:00；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 11:45 | 前史：给入4 U |
| 10-17 11:55 | 前史：已有CGM校准 |
| 10-17 12:00 | 当下meal记录：A planned 40 g meal was cancelled after a pre-meal dose. Only a small snack is currently available; do not assume the planned meal will arrive. |
| 10-17 12:10 | 当下exercise记录：Person intends aerobic activity around 12:50 for about 60 minutes; moderate effort. Timing may change. |
| 10-17 12:45 | 摄入15 g，上报15 g，τ=60 min |
| 10-17 12:50 | 活动60 min，AC=2095，附加肝糖项0 mg/dL/min |
| 10-17 13:50 | activity-0预设区间结束；不清空此前体内状态 |
| 10-17 15:45 | 当下meal记录：Current intention: meal around 16:20, estimated 65 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 16:20 | 摄入65 g，上报65 g，τ=60 min |
| 10-17 20:45 | 当下meal记录：Current intention: meal around 21:20, estimated 85 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 21:20 | 摄入85 g，上报85 g，τ=60 min |
| 10-18 06:55 | 当下meal记录：Current intention: meal around 07:30, estimated 70 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 07:30 | 摄入70 g，上报70 g，τ=60 min |
| 10-18 12:00 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-A04 夜间慢餐叠加缺觉与黎明

来源：V4R2-B03；原冻结题B03，物理配置未变。
意图：保留原跨夜复合题，主标签为慢输入，其他机制按次标签报告。 跨夜仍需追踪旧输入，不能在午夜重置判断。
机制对照：分别去掉慢输入、缺觉或黎明项，保持其他组合；不以一个全删版代替分项比较。
I1规则草案：[{"category":"life"}]。正式运行前须核对有效投影。
依据：R14、R03、R06，来源同类现象不等于选定参数或组合已临床验证。
回合：10-17 11:55—10-18 11:55；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 11:50 | 前史：已有CGM校准 |
| 10-17 11:55 | 已有缺觉代理开始，SI减幅0.2，持续1080 min |
| 10-17 11:55 | 整日按北京时间使用现有黎明函数，dawn_fraction=0.3；03:00进入，05:00—08:00较强，10:00退出 |
| 10-17 12:05 | 当下meal记录：Current intention: meal around 12:40, estimated 50 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 12:40 | 摄入50 g，上报50 g，τ=60 min |
| 10-17 17:50 | 当下meal记录：Current intention: meal around 18:25, estimated 47 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 18:25 | 摄入47 g，上报47 g，τ=60 min |
| 10-17 23:20 | 当下meal记录：Current intention: meal around 23:55, estimated 68 g carbohydrate; mixed meal reported high in fat/protein. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 23:55 | 摄入68 g，上报68 g，τ=180 min |
| 10-18 03:50 | 当下meal记录：Current intention: meal around 04:25, estimated 21 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 04:25 | 摄入21 g，上报21 g，τ=60 min |
| 10-18 05:55 | sleep预设区间结束；不清空此前体内状态 |
| 10-18 07:30 | 当下meal记录：Current intention: meal around 08:05, estimated 54 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 08:05 | 摄入54 g，上报54 g，τ=60 min |
| 10-18 11:55 | 回合结束，未消退尾部不被解释为风险已结束 |

## B 既有治疗、残余药效与未完成输注

四题分别是给药时点、叠加历史、剩余输注承诺和已发生的救援输入。它们的关键是身体/设备已经处于什么状态，而非猜发生了哪顿饭。原 G02 等放到严格定义的对照或诊断档案，不再重复计为独立主情景。A/B 共八题；不存在一个额外的 G 主族。

### V4R3-B01 既往给药时点与残余作用

来源：V4R2-G01。
意图：同总量不同历史时点作为同一题的主世界/配对世界，不分别占两个主题。 05:40 给过 1.5 U，06:00 回合开始，10:00 前无新摄入；考察能否考虑时间延迟。这是明确的外部给药史，不预设它当时是否合理，也不伪造一个高血糖起点。
机制对照：主世界为原 G01：起点前20分钟1.5 U；时点对照为原 G02：起点前160分钟1.5 U，摄入和其他物理配置相同。历史各自回放，初始血糖不强行相同。
I1规则草案：[{"category":"treatment"}]。正式运行前须核对有效投影。
依据：R01、N05，来源同类现象不等于选定参数或组合已临床验证。
回合：10-18 06:00—10-19 06:00；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-18 05:40 | 前史：给入1.5 U |
| 10-18 05:55 | 前史：已有CGM校准 |
| 10-18 09:25 | 当下meal记录：当前计划约在 10:00 进食，估计碳水 35 g；这是意向，不是未来实际摄入保证。 |
| 10-18 10:00 | 摄入35 g，上报35 g，τ=60 min |
| 10-18 13:25 | 当下meal记录：当前计划约在 14:00 进食，估计碳水 50 g；这是意向，不是未来实际摄入保证。 |
| 10-18 14:00 | 摄入50 g，上报50 g，τ=75 min |
| 10-18 17:25 | 当下meal记录：当前计划约在 18:00 进食，估计碳水 45 g；这是意向，不是未来实际摄入保证。 |
| 10-18 18:00 | 摄入45 g，上报45 g，τ=90 min |
| 10-19 06:00 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-B02 既往叠加给药后活动与小餐交错

来源：V4R2-A04；原冻结题A04，物理配置未变。
意图：保留原 A04 的两次给药、活动及餐量变化，而非另造多道单次/分次同质题。 保留已有两个剂量及活动，测试历史暴露和调整。
机制对照：同总量4 U、相同活动和进食，把1.7 U/2.3 U的分布改为起点前40分钟一次给入；预注册为给药时序分布对照，不能同时改变总量。原 G03 的3 U简化配置仅留诊断档案，不冒充严格匹配对照。
I1规则草案：[{"category":"treatment"},{"category":"exercise"}]。正式运行前须核对有效投影。
依据：R20、R01，来源同类现象不等于选定参数或组合已临床验证。
回合：10-17 11:40—10-18 11:40；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 10:30 | 前史：给入1.7 U |
| 10-17 11:20 | 前史：给入2.3 U |
| 10-17 11:35 | 前史：已有CGM校准 |
| 10-17 11:40 | 当下meal记录：Lunch will be much smaller than originally planned; prior correction insulin may still be active. |
| 10-17 11:45 | 当下exercise记录：Person intends aerobic activity around 12:25 for about 60 minutes; moderate effort. Timing may change. |
| 10-17 12:25 | 活动60 min，AC=2095，附加肝糖项0 mg/dL/min |
| 10-17 12:25 | 当下meal记录：Current intention: meal around 13:00, estimated 20 g carbohydrate; mixed meal reported high in fat/protein. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 13:00 | 摄入20 g，上报20 g，τ=150 min |
| 10-17 13:25 | activity-0预设区间结束；不清空此前体内状态 |
| 10-17 17:05 | 当下meal记录：Current intention: meal around 17:40, estimated 78 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 17:40 | 摄入78 g，上报78 g，τ=60 min |
| 10-17 22:05 | 当下meal记录：Current intention: meal around 22:40, estimated 73 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 22:40 | 摄入73 g，上报73 g，τ=60 min |
| 10-18 06:55 | 当下meal记录：Current intention: meal around 07:30, estimated 69 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 07:30 | 摄入69 g，上报69 g，τ=60 min |
| 10-18 11:40 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-B03 主餐取消但延长输注尚未完成

来源：V4R2-G05。
意图：保留一个真正需要区分未来承诺与已入体药效的设备/生理交互。 05:30 启动 3 U/180 分钟延长输注；06:00 主餐取消，06:30 实际只有 10 g 加餐。未取消时剩余输注持续到 08:30，取消则按现有动作改变未来输入，已入体部分不回收。
机制对照：同样的主餐取消和实际日程，但没有剩余延长输注承诺；历史分别回放。
I1规则草案：[{"category":"meal","ids":["cancelled-meal"]}]。正式运行前须核对有效投影。
依据：R01、R02，来源同类现象不等于选定参数或组合已临床验证。
回合：10-18 06:00—10-19 06:00；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-18 05:30 | 前史：启动3 U/180 min延长输注 |
| 10-18 05:55 | 前史：已有CGM校准 |
| 10-18 06:00 | 当下meal记录：原定主餐取消，只能在 06:30 吃少量加餐；先前已启动延长输注。 |
| 10-18 06:00 | 当下meal记录：当前计划约在 06:30 进食，估计碳水 10 g；这是意向，不是未来实际摄入保证。 |
| 10-18 06:30 | 摄入10 g，上报10 g，τ=60 min |
| 10-18 08:30 | 若未被Agent取消，原延长输注承诺至此完成；这不是强制治疗事件 |
| 10-18 11:55 | 当下meal记录：当前计划约在 12:30 进食，估计碳水 55 g；这是意向，不是未来实际摄入保证。 |
| 10-18 12:30 | 摄入55 g，上报55 g，τ=75 min |
| 10-18 17:25 | 当下meal记录：当前计划约在 18:00 进食，估计碳水 50 g；这是意向，不是未来实际摄入保证。 |
| 10-18 18:00 | 摄入50 g，上报50 g，τ=90 min |
| 10-19 06:00 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-B04 救援补碳未充分吸收且主餐推迟

来源：V4R2-A03；原冻结题A03，物理配置未变。
意图：使用原复杂题而不是另算原 G06 简化题，保留既有药效和全天后续输入。 刚发生的补碳仍在肠道仓库，不能每次重新当作未处理。
机制对照：同药效史、未补该笔碳水；完整日程不变。
I1规则草案：[{"category":"meal","ids":["recent-rescue","history:2"]}]。正式运行前须核对有效投影。
依据：R01、R18，来源同类现象不等于选定参数或组合已临床验证。
回合：10-17 12:25—10-18 12:25；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 11:40 | 前史：给入4 U |
| 10-17 12:20 | 前史：已有CGM校准 |
| 10-17 12:20 | 前史：已补15 g碳水 |
| 10-17 12:25 | 当下meal记录：Person reports a 15 g rescue drink five minutes ago; it may not yet have fully acted. Main meal is delayed. |
| 10-17 14:00 | 当下meal记录：Current intention: meal around 14:35, estimated 53 g carbohydrate; mixed meal reported high in fat/protein. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 14:35 | 摄入53 g，上报53 g，τ=150 min |
| 10-17 18:50 | 当下meal记录：Current intention: meal around 19:25, estimated 76 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 19:25 | 摄入76 g，上报76 g，τ=60 min |
| 10-18 00:30 | 当下meal记录：Current intention: meal around 01:05, estimated 49 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 01:05 | 摄入49 g，上报49 g，τ=60 min |
| 10-18 07:50 | 当下meal记录：Current intention: meal around 08:25, estimated 62 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 08:25 | 摄入62 g，上报62 g，τ=60 min |
| 10-18 12:25 | 回合结束，未消退尾部不被解释为风险已结束 |

## C 活动与延迟风险

保留 V4R2 的四道原活动复合题，原物理事件和参数不变。运动顺序、多次活动与跨夜尾部是主挑战；饮酒、进餐等可作次标签，不重复计题。

### V4R3-C01 两段活动穿插补给和多餐

来源：V4R2-C01；原冻结题C01，物理配置未变。
意图：原 V4R2 物理配置不变。 第一次活动的状态与第二次活动共享，不按两道独立题处理。
机制对照：同日程去掉第二次活动；另可改变间隔，但不同时换负荷。
I1规则草案：[{"category":"exercise","ids":["activity-1","plan-activity-1"]}]。正式运行前须核对有效投影。
依据：R04、R17，来源同类现象不等于选定参数或组合已临床验证。
回合：10-17 12:25—10-18 12:25；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 12:20 | 前史：已有CGM校准 |
| 10-17 12:35 | 当下meal记录：Current intention: meal around 13:10, estimated 49 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 13:10 | 摄入49 g，上报49 g，τ=60 min |
| 10-17 13:35 | 当下exercise记录：Person intends aerobic activity around 14:15 for about 60 minutes; moderate effort. Timing may change. |
| 10-17 14:15 | 活动60 min，AC=2095，附加肝糖项0 mg/dL/min |
| 10-17 15:15 | activity-0预设区间结束；不清空此前体内状态 |
| 10-17 15:30 | 当下meal记录：Current intention: meal around 16:05, estimated 46 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 16:05 | 摄入46 g，上报46 g，τ=60 min |
| 10-17 18:50 | 当下meal记录：Current intention: meal around 19:25, estimated 53 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 19:25 | 摄入53 g，上报53 g，τ=60 min |
| 10-17 19:25 | 当下exercise记录：Person intends aerobic activity around 20:05 for about 60 minutes; moderate effort. Timing may change. |
| 10-17 20:05 | 活动60 min，AC=2095，附加肝糖项0 mg/dL/min |
| 10-17 21:05 | activity-1预设区间结束；不清空此前体内状态 |
| 10-17 22:30 | 当下meal记录：Current intention: meal around 23:05, estimated 43 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 23:05 | 摄入43 g，上报43 g，τ=60 min |
| 10-18 07:40 | 当下meal记录：Current intention: meal around 08:15, estimated 49 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 08:15 | 摄入49 g，上报49 g，τ=60 min |
| 10-18 12:25 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-C02 暂时肝糖正扰动后接有氧

来源：V4R2-C02；原冻结题C02，物理配置未变。
意图：原 V4R2 物理配置不变。 原高强度标签仅是工程代理；关注先暂升、后有氧的交错，不规定曲线必然翻转。
机制对照：保留后段活动，仅去除第一段正肝糖代理。
I1规则草案：[{"category":"exercise","ids":["activity-1","plan-activity-1"]}]。正式运行前须核对有效投影。
依据：R16、R04，来源同类现象不等于选定参数或组合已临床验证。
回合：10-17 12:20—10-18 12:20；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 12:15 | 前史：已有CGM校准 |
| 10-17 12:30 | 当下meal记录：Current intention: meal around 13:05, estimated 59 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 13:05 | 摄入59 g，上报59 g，τ=60 min |
| 10-17 13:50 | 当下exercise记录：Person intends anaerobic activity around 14:30 for about 35 minutes; moderate effort. Timing may change. |
| 10-17 14:30 | 活动35 min，AC=0，附加肝糖项0.45 mg/dL/min |
| 10-17 14:45 | 当下exercise记录：Person intends aerobic activity around 15:25 for about 60 minutes; moderate effort. Timing may change. |
| 10-17 15:05 | activity-0预设区间结束；不清空此前体内状态 |
| 10-17 15:25 | 活动60 min，AC=2095，附加肝糖项0 mg/dL/min |
| 10-17 16:25 | activity-1预设区间结束；不清空此前体内状态 |
| 10-17 16:35 | 当下meal记录：Current intention: meal around 17:10, estimated 67 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 17:10 | 摄入67 g，上报67 g，τ=60 min |
| 10-17 21:55 | 当下meal记录：Current intention: meal around 22:30, estimated 55 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 22:30 | 摄入55 g，上报55 g，τ=60 min |
| 10-17 22:40 | 当下exercise记录：Person intends aerobic activity around 23:20 for about 60 minutes; moderate effort. Timing may change. |
| 10-17 23:20 | 活动60 min，AC=2095，附加肝糖项0 mg/dL/min |
| 10-18 00:20 | activity-2预设区间结束；不清空此前体内状态 |
| 10-18 07:35 | 当下meal记录：Current intention: meal around 08:10, estimated 59 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 08:10 | 摄入59 g，上报59 g，τ=60 min |
| 10-18 12:20 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-C03 晚间活动和饮酒后的延迟作用

来源：V4R2-C03；原冻结题C03，物理配置未变。
意图：原 V4R2 物理配置不变。 不能在活动停止或当前稳定后忘记后续外源扰动。
机制对照：同摄入和活动，无饮酒延迟肝糖代理。
I1规则草案：[{"category":"life","ids":["alcohol-540"]}]。正式运行前须核对有效投影。
依据：R05、R15，来源同类现象不等于选定参数或组合已临床验证。
回合：10-17 11:55—10-18 11:55；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 11:50 | 前史：已有CGM校准 |
| 10-17 12:05 | 当下meal记录：Current intention: meal around 12:40, estimated 70 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 12:40 | 摄入70 g，上报70 g，τ=60 min |
| 10-17 16:15 | 当下exercise记录：Person intends aerobic activity around 16:55 for about 60 minutes; moderate effort. Timing may change. |
| 10-17 16:55 | 活动60 min，AC=2095，附加肝糖项0 mg/dL/min |
| 10-17 17:40 | 当下meal记录：Current intention: meal around 18:15, estimated 85 g carbohydrate; mixed meal reported high in fat/protein. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 17:55 | activity-0预设区间结束；不清空此前体内状态 |
| 10-17 18:15 | 摄入85 g，上报85 g，τ=140 min |
| 10-17 20:55 | 饮酒记录，5 h后开始-0.25 mg/dL/min代理，持续9 h |
| 10-17 22:10 | 当下meal记录：Current intention: meal around 22:45, estimated 30 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 22:45 | 摄入30 g，上报30 g，τ=60 min |
| 10-18 01:55 | 延迟负向肝糖代理开始 |
| 10-18 07:10 | 当下meal记录：Current intention: meal around 07:45, estimated 55 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 07:45 | 摄入55 g，上报55 g，τ=60 min |
| 10-18 10:55 | 延迟负向肝糖代理结束；继续观察，不等于真实风险归零 |
| 10-18 11:55 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-C04 夜间慢餐后次晨连续两次活动

来源：V4R2-C04；原冻结题C04，物理配置未变。
意图：原 V4R2 物理配置不变。 前一天输入和活动状态进入次晨，保持原题尾部难度。
机制对照：同背景去掉后一次活动，不清空此前运动状态。
I1规则草案：[{"category":"exercise","ids":["activity-1","plan-activity-1"]}]。正式运行前须核对有效投影。
依据：R14、R17，来源同类现象不等于选定参数或组合已临床验证。
回合：10-17 11:45—10-18 11:45；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 11:40 | 前史：已有CGM校准 |
| 10-17 11:55 | 当下meal记录：Current intention: meal around 12:30, estimated 58 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 12:30 | 摄入58 g，上报58 g，τ=60 min |
| 10-17 17:10 | 当下exercise记录：Person intends aerobic activity around 17:50 for about 60 minutes; moderate effort. Timing may change. |
| 10-17 17:50 | 活动60 min，AC=2095，附加肝糖项0 mg/dL/min |
| 10-17 18:50 | activity-0预设区间结束；不清空此前体内状态 |
| 10-17 19:10 | 当下meal记录：Current intention: meal around 19:45, estimated 80 g carbohydrate; mixed meal reported high in fat/protein. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 19:45 | 摄入80 g，上报80 g，τ=140 min |
| 10-18 00:30 | 当下meal记录：Current intention: meal around 01:05, estimated 36 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 01:05 | 摄入36 g，上报36 g，τ=60 min |
| 10-18 05:15 | 当下exercise记录：Person intends aerobic activity around 05:55 for about 60 minutes; moderate effort. Timing may change. |
| 10-18 05:55 | 活动60 min，AC=2095，附加肝糖项0 mg/dL/min |
| 10-18 06:40 | 当下meal记录：Current intention: meal around 07:15, estimated 67 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 06:55 | activity-1预设区间结束；不清空此前体内状态 |
| 10-18 07:15 | 摄入67 g，上报67 g，τ=60 min |
| 10-18 07:45 | 当下exercise记录：Person intends aerobic activity around 08:25 for about 60 minutes; moderate effort. Timing may change. |
| 10-18 08:25 | 活动60 min，AC=2095，附加肝糖项0 mg/dL/min |
| 10-18 09:25 | activity-2预设区间结束；不清空此前体内状态 |
| 10-18 11:45 | 回合结束，未消退尾部不被解释为风险已结束 |

## D 非疾病的需求变化与肝糖输出扰动

从两题扩展至六题：保留两道原复合压力题，增加黎明、缺觉退出、餐后短时应激及无运动的饮酒延迟扰动。分别标注敏感性项或肝糖项，不把两者写成同一生理机制。新增题有明确物理扰动，隐藏叙述后仍存在；不把仅有名称变化的稳定背景算新主题。

### V4R3-D01 两次短时应激消退后分别接活动

来源：V4R2-D01；原冻结题D03，物理配置未变。
意图：保留原 D03 的两段肝糖代理、四餐与活动，不降低其难度。 关注暂时扰动消退以及当时仍在作用的输入。
机制对照：分别去掉一段应激，固定餐食和运动；保留另一段作为背景。
I1规则草案：[{"category":"life","ids":["stress-end-0","stress-end-600"]}]。正式运行前须核对有效投影。
依据：R07、R04，来源同类现象不等于选定参数或组合已临床验证。
回合：10-17 11:35—10-18 11:35；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 11:30 | 前史：已有CGM校准 |
| 10-17 11:35 | 已有正肝糖代理0.3 mg/dL/min，持续150 min |
| 10-17 11:45 | 当下meal记录：Current intention: meal around 12:20, estimated 71 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 12:20 | 摄入71 g，上报71 g，τ=60 min |
| 10-17 13:55 | 当下exercise记录：Person intends aerobic activity around 14:35 for about 60 minutes; moderate effort. Timing may change. |
| 10-17 14:05 | stress-0预设区间结束；不清空此前体内状态 |
| 10-17 14:05 | 当下life记录：The stressful activity has ended; person reports feeling calmer. Previously delivered insulin remains active. |
| 10-17 14:35 | 活动60 min，AC=2095，附加肝糖项0 mg/dL/min |
| 10-17 15:35 | activity-0预设区间结束；不清空此前体内状态 |
| 10-17 16:00 | 当下meal记录：Current intention: meal around 16:35, estimated 51 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 16:35 | 摄入51 g，上报51 g，τ=60 min |
| 10-17 21:35 | 已有正肝糖代理0.3 mg/dL/min，持续120 min |
| 10-17 21:50 | 当下meal记录：Current intention: meal around 22:25, estimated 63 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 22:25 | 摄入63 g，上报63 g，τ=60 min |
| 10-17 23:35 | stress-600预设区间结束；不清空此前体内状态 |
| 10-17 23:35 | 当下exercise记录：Person intends aerobic activity around 00:15 for about 60 minutes; moderate effort. Timing may change. |
| 10-17 23:35 | 当下life记录：The stressful activity has ended; person reports feeling calmer. Previously delivered insulin remains active. |
| 10-18 00:15 | 活动60 min，AC=2095，附加肝糖项0 mg/dL/min |
| 10-18 01:15 | activity-1预设区间结束；不清空此前体内状态 |
| 10-18 06:50 | 当下meal记录：Current intention: meal around 07:25, estimated 55 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 07:25 | 摄入55 g，上报55 g，τ=60 min |
| 10-18 11:35 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-D02 缺觉与黎明叠加后的需求恢复

来源：V4R2-D02；原冻结题D04，物理配置未变。
意图：保留原 D04 的缺觉、黎明、四餐与后续活动。 需要跨过需求变化的进入和退出，而非全天固定强化。
机制对照：同日程去掉缺觉或黎明中的一个，分开做机制对照。
I1规则草案：[{"category":"life"}]。正式运行前须核对有效投影。
依据：R06、R03，来源同类现象不等于选定参数或组合已临床验证。
回合：10-17 11:45—10-18 11:45；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 11:40 | 前史：已有CGM校准 |
| 10-17 11:45 | 已有缺觉代理开始，SI减幅0.2，持续1080 min |
| 10-17 11:45 | 整日按北京时间使用现有黎明函数，dawn_fraction=0.3；03:00进入，05:00—08:00较强，10:00退出 |
| 10-17 11:55 | 当下meal记录：Current intention: meal around 12:30, estimated 59 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 12:30 | 摄入59 g，上报59 g，τ=60 min |
| 10-17 17:50 | 当下meal记录：Current intention: meal around 18:25, estimated 63 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 18:25 | 摄入63 g，上报63 g，τ=60 min |
| 10-17 23:30 | 当下meal记录：Current intention: meal around 00:05, estimated 42 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 00:05 | 摄入42 g，上报42 g，τ=60 min |
| 10-18 05:45 | sleep预设区间结束；不清空此前体内状态 |
| 10-18 06:00 | 当下meal记录：Current intention: meal around 06:35, estimated 76 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 06:35 | 摄入76 g，上报76 g，τ=60 min |
| 10-18 07:25 | 当下exercise记录：Person intends aerobic activity around 08:05 for about 60 minutes; moderate effort. Timing may change. |
| 10-18 08:05 | 活动60 min，AC=2095，附加肝糖项0 mg/dL/min |
| 10-18 09:05 | activity-0预设区间结束；不清空此前体内状态 |
| 10-18 11:45 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-D03 未进食时的黎明需求进入与退出

来源：新增D配置。
意图：00:00起始；03:00进入现有黎明函数、05:00—08:00较强、10:00退出。第一餐11:00，使早期需求变化不被强制餐食覆盖。不是重设基础生理参考或改变患者目标。
机制对照：同患者、日程与种子，关闭 dawn_fraction；时钟函数参数沿现有实现，不按模型分数调幅。
I1规则草案：[{"category":"life","ids":["prior-dawn-report"]}]。正式运行前须核对有效投影。
依据：R03，来源同类现象不等于选定参数或组合已临床验证。
回合：10-18 00:00—10-19 00:00；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 23:55 | 前史：已有CGM校准 |
| 10-18 00:00 | 当下life记录：患者报告以往清晨有反复升糖现象，不提供今日未来曲线或真实参数。 |
| 10-18 00:00 | 整日按北京时间使用现有黎明函数，dawn_fraction=0.3；03:00进入，05:00—08:00较强，10:00退出 |
| 10-18 10:25 | 当下meal记录：患者当前计划约11:00摄入35 g；意向不保证兑现。 |
| 10-18 11:00 | 摄入35 g，上报35 g，τ=60 min |
| 10-18 14:55 | 当下meal记录：患者当前计划约15:30摄入55 g；意向不保证兑现。 |
| 10-18 15:30 | 摄入55 g，上报55 g，τ=75 min |
| 10-18 18:25 | 当下meal记录：患者当前计划约19:00摄入50 g；意向不保证兑现。 |
| 10-18 19:00 | 摄入50 g，上报50 g，τ=90 min |
| 10-19 00:00 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-D04 缺觉相关需求退出后仍继续进食

来源：新增D配置。
意图：06:00—18:00缺觉代理 sensitivity_decrease=0.2；07:30/12:30进食35/55 g，18:30再吃50 g。关注需求代理退出时已有治疗与随后进食，不预设 Agent 一定增加治疗。
机制对照：同样日程，缺觉代理持续到次晨；另设完全无该代理的背景。它们不是新增主题。
I1规则草案：[{"category":"life","ids":["rest-recovered"]}]。正式运行前须核对有效投影。
依据：R06，来源同类现象不等于选定参数或组合已临床验证。
回合：10-18 06:00—10-19 06:00；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-18 05:55 | 前史：已有CGM校准 |
| 10-18 06:00 | 已有缺觉代理开始，SI减幅0.2，持续720 min |
| 10-18 06:55 | 当下meal记录：患者当前计划约07:30摄入35 g；意向不保证兑现。 |
| 10-18 07:30 | 摄入35 g，上报35 g，τ=60 min |
| 10-18 11:55 | 当下meal记录：患者当前计划约12:30摄入55 g；意向不保证兑现。 |
| 10-18 12:30 | 摄入55 g，上报55 g，τ=75 min |
| 10-18 17:55 | 当下meal记录：患者当前计划约18:30摄入50 g；意向不保证兑现。 |
| 10-18 18:00 | sleep-loss预设区间结束；不清空此前体内状态 |
| 10-18 18:00 | 当下life记录：患者此时报告休息情况改善；后续需要结合实际走势判断，不提供敏感性数值。 |
| 10-18 18:30 | 摄入50 g，上报50 g，τ=90 min |
| 10-19 06:00 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-D05 慢餐后的短时应激及其消退

来源：新增D配置。
意图：07:30摄入40 g、τ=150 min；08:00—10:00加入0.3 mg/dL/min的已有应激肝糖代理；14:00/18:00再进食50/45 g。10:00只结束应激项，不清空肠道和药库。
机制对照：同样慢输入，无应激代理；空腹无明显效应可作额外叙述反例，但不再强造一个全信息档位重复主情景。
I1规则草案：[{"category":"life","ids":["stress-end"]}]。正式运行前须核对有效投影。
依据：R07、R18，来源同类现象不等于选定参数或组合已临床验证。
回合：10-18 06:00—10-19 06:00；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-18 05:55 | 前史：已有CGM校准 |
| 10-18 06:55 | 当下meal记录：患者当前计划约07:30摄入40 g；意向不保证兑现。 |
| 10-18 07:30 | 摄入40 g，上报40 g，τ=150 min |
| 10-18 08:00 | 已有正肝糖代理0.3 mg/dL/min，持续120 min |
| 10-18 08:00 | 当下life记录：患者报告当前处于紧张情境，不提供实际肝糖增量。 |
| 10-18 10:00 | stress预设区间结束；不清空此前体内状态 |
| 10-18 10:00 | 当下life记录：患者报告紧张情境此时结束，先前摄入和治疗不因此失效。 |
| 10-18 13:25 | 当下meal记录：患者当前计划约14:00摄入50 g；意向不保证兑现。 |
| 10-18 14:00 | 摄入50 g，上报50 g，τ=75 min |
| 10-18 17:25 | 当下meal记录：患者当前计划约18:00摄入45 g；意向不保证兑现。 |
| 10-18 18:00 | 摄入45 g，上报45 g，τ=90 min |
| 10-19 06:00 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-D06 无运动背景下的饮酒延迟肝糖扰动

来源：新增D配置。
意图：12:00至次日12:00；13:00/18:00/次日07:30摄入35/55/50 g。19:00饮酒记录，5小时后即午夜开始-0.25 mg/dL/min肝糖代理，持续8小时，之后仍观察4小时。当天不加运动以区别于 C03。
机制对照：同摄入和作息，无该延迟负向肝糖代理。不模拟乙醇浓度、糖原或胰高血糖素。
I1规则草案：[{"category":"life","ids":["alcohol"]}]。正式运行前须核对有效投影。
依据：R15，来源同类现象不等于选定参数或组合已临床验证。
回合：10-18 12:00—10-19 12:00；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-18 11:55 | 前史：已有CGM校准 |
| 10-18 12:25 | 当下meal记录：患者当前计划约13:00摄入35 g；意向不保证兑现。 |
| 10-18 13:00 | 摄入35 g，上报35 g，τ=60 min |
| 10-18 17:25 | 当下meal记录：患者当前计划约18:00摄入55 g；意向不保证兑现。 |
| 10-18 18:00 | 摄入55 g，上报55 g，τ=75 min |
| 10-18 19:00 | 饮酒记录，5 h后开始-0.25 mg/dL/min代理，持续8 h |
| 10-19 00:00 | 延迟负向肝糖代理开始 |
| 10-19 06:55 | 当下meal记录：患者当前计划约07:30摄入50 g；意向不保证兑现。 |
| 10-19 07:30 | 摄入50 g，上报50 g，τ=90 min |
| 10-19 08:00 | 延迟负向肝糖代理结束；继续观察，不等于真实风险归零 |
| 10-19 12:00 | 回合结束，未消退尾部不被解释为风险已结束 |

## E 输注异常与恢复

原四道故障复合题不变。过去的主动暂停可作为状态鉴别/诊断条件，但不再额外增加一个与 B 重复的主情景。

### V4R3-E01 静默送达不足叠加多餐

来源：V4R2-E01；原冻结题E01，物理配置未变。
意图：原 V4R2 物理配置不变。 保留原多餐压力，不把故障诊断简化为孤立无餐高糖。
机制对照：同命令和日程，正常送达。
I1规则草案：[{"category":"meal","ids":["meal-0","plan-meal-0"]}]。正式运行前须核对有效投影。
依据：R19、R09、R20，来源同类现象不等于选定参数或组合已临床验证。
回合：10-17 12:10—10-18 12:10；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 12:05 | 前史：已有CGM校准 |
| 10-17 12:20 | 当下meal记录：Current intention: meal around 12:55, estimated 54 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 12:35 | 实际送达比例0.1，持续900 min；Agent可主动修复 |
| 10-17 12:35 | 当下fault记录：Person notices wet adhesive or a loose infusion cannula. Pump display can still appear running; inspect the infusion site. Exact delivered fraction is unknown. |
| 10-17 12:55 | 摄入54 g，上报54 g，τ=60 min |
| 10-17 16:35 | 当下meal记录：Current intention: meal around 17:10, estimated 54 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 17:10 | 摄入54 g，上报54 g，τ=60 min |
| 10-17 21:15 | 当下meal记录：Current intention: meal around 21:50, estimated 47 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 21:50 | 摄入47 g，上报47 g，τ=60 min |
| 10-18 03:15 | 当下meal记录：Current intention: meal around 03:50, estimated 41 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 03:35 | leak-25预设区间结束；不清空此前体内状态 |
| 10-18 03:50 | 摄入41 g，上报41 g，τ=60 min |
| 10-18 07:45 | 当下meal记录：Current intention: meal around 08:20, estimated 44 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 08:20 | 摄入44 g，上报44 g，τ=60 min |
| 10-18 12:10 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-E02 三次间歇送达不足和不规则进食

来源：V4R2-E02；原冻结题E02，物理配置未变。
意图：原 V4R2 物理配置不变。 恢复一次不代表以后都正常，需持续更新。
机制对照：同输入日程、全程正常送达；如比较持续故障须另注册。
I1规则草案：[{"category":"fault","ids":["leak-report-400","leak-report-780"]}]。正式运行前须核对有效投影。
依据：R19、R09，来源同类现象不等于选定参数或组合已临床验证。
回合：10-17 12:30—10-18 12:30；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 12:25 | 前史：已有CGM校准 |
| 10-17 12:40 | 当下meal记录：Current intention: meal around 13:15, estimated 51 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 12:55 | 实际送达比例0.1，持续230 min；Agent可主动修复 |
| 10-17 12:55 | 当下fault记录：Person notices wet adhesive or a loose infusion cannula. Pump display can still appear running; inspect the infusion site. Exact delivered fraction is unknown. |
| 10-17 13:15 | 摄入51 g，上报51 g，τ=60 min |
| 10-17 16:35 | 当下meal记录：Current intention: meal around 17:10, estimated 44 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 16:45 | leak-25预设区间结束；不清空此前体内状态 |
| 10-17 17:10 | 摄入44 g，上报44 g，τ=60 min |
| 10-17 19:10 | 实际送达比例0.2，持续230 min；Agent可主动修复 |
| 10-17 19:10 | 当下fault记录：Person notices wet adhesive or a loose infusion cannula. Pump display can still appear running; inspect the infusion site. Exact delivered fraction is unknown. |
| 10-17 19:15 | 当下meal记录：Current intention: meal around 19:50, estimated 51 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 19:50 | 摄入51 g，上报51 g，τ=60 min |
| 10-17 23:00 | leak-400预设区间结束；不清空此前体内状态 |
| 10-18 01:30 | 实际送达比例0.1，持续240 min；Agent可主动修复 |
| 10-18 01:30 | 当下fault记录：Person notices wet adhesive or a loose infusion cannula. Pump display can still appear running; inspect the infusion site. Exact delivered fraction is unknown. |
| 10-18 01:35 | 当下meal记录：Current intention: meal around 02:10, estimated 51 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 02:10 | 摄入51 g，上报51 g，τ=60 min |
| 10-18 05:30 | leak-780预设区间结束；不清空此前体内状态 |
| 10-18 07:45 | 当下meal记录：Current intention: meal around 08:20, estimated 44 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 08:20 | 摄入44 g，上报44 g，τ=60 min |
| 10-18 12:30 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-E03 送达恢复后慢餐与活动交错

来源：V4R2-E03；原冻结题E03，物理配置未变。
意图：原 V4R2 物理配置不变。 修复前后药物、肠道和运动状态连续。
机制对照：同故障前史，在注册时点不修复；若 Agent 主动修复，仍按工具效果处理。
I1规则草案：[{"category":"fault","ids":["leak-report-25"]}]。正式运行前须核对有效投影。
依据：R19、R14、R04，来源同类现象不等于选定参数或组合已临床验证。
回合：10-17 11:55—10-18 11:55；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 11:50 | 前史：已有CGM校准 |
| 10-17 12:05 | 当下meal记录：Current intention: meal around 12:40, estimated 65 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 12:20 | 实际送达比例0.15，持续300 min；Agent可主动修复 |
| 10-17 12:20 | 当下fault记录：Person notices wet adhesive or a loose infusion cannula. Pump display can still appear running; inspect the infusion site. Exact delivered fraction is unknown. |
| 10-17 12:40 | 摄入65 g，上报65 g，τ=60 min |
| 10-17 15:30 | 当下meal记录：Current intention: meal around 16:05, estimated 65 g carbohydrate; mixed meal reported high in fat/protein. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 16:05 | 摄入65 g，上报65 g，τ=150 min |
| 10-17 17:20 | leak-25预设区间结束；不清空此前体内状态 |
| 10-17 17:20 | 预设外源修复；不重置生理状态，不补回丢失药物 |
| 10-17 17:20 | 当下fault记录：Infusion site problem was corrected. Review active insulin and food before further dosing. |
| 10-17 17:35 | 当下exercise记录：Person intends aerobic activity around 18:15 for about 60 minutes; moderate effort. Timing may change. |
| 10-17 18:15 | 活动60 min，AC=2095，附加肝糖项0 mg/dL/min |
| 10-17 19:15 | activity-0预设区间结束；不清空此前体内状态 |
| 10-17 21:20 | 当下meal记录：Current intention: meal around 21:55, estimated 53 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 21:55 | 摄入53 g，上报53 g，τ=60 min |
| 10-18 07:10 | 当下meal记录：Current intention: meal around 07:45, estimated 57 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 07:45 | 摄入57 g，上报57 g，τ=60 min |
| 10-18 11:55 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-E04 静默送达不足叠加渐进伪高

来源：V4R2-E04；原冻结题E04，物理配置未变。
意图：原 V4R2 物理配置不变。 同一读数同时受真实生理与测量影响。
机制对照：2×2 消融：无异常、仅送达不足、仅漂移、两者并存。
I1规则草案：[{"category":"fault","ids":["leak-report-25"]}]。正式运行前须核对有效投影。
依据：R19、R22，来源同类现象不等于选定参数或组合已临床验证。
回合：10-17 12:10—10-18 12:10；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 12:05 | 前史：已有CGM校准 |
| 10-17 12:20 | 当下meal记录：Current intention: meal around 12:55, estimated 67 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 12:35 | 实际送达比例0.15，持续700 min；Agent可主动修复 |
| 10-17 12:35 | 当下fault记录：Person notices wet adhesive or a loose infusion cannula. Pump display can still appear running; inspect the infusion site. Exact delivered fraction is unknown. |
| 10-17 12:55 | 摄入67 g，上报67 g，τ=60 min |
| 10-17 13:25 | 传感器漂移峰值65 mg/dL，总长480 min，起止斜坡90 min |
| 10-17 13:25 | 当下fault记录：Person reports a sensor-site problem or possible interference. Sensor values may not reflect blood glucose; an independent meter is available. Direction and magnitude are not supplied. |
| 10-17 16:35 | 当下meal记录：Current intention: meal around 17:10, estimated 63 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 17:10 | 摄入63 g，上报63 g，τ=60 min |
| 10-17 21:25 | drift-75预设区间结束；不清空此前体内状态 |
| 10-17 22:25 | 当下meal记录：Current intention: meal around 23:00, estimated 59 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 23:00 | 摄入59 g，上报59 g，τ=60 min |
| 10-18 00:15 | leak-25预设区间结束；不清空此前体内状态 |
| 10-18 07:25 | 当下meal记录：Current intention: meal around 08:00, estimated 51 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 08:00 | 摄入51 g，上报51 g，τ=60 min |
| 10-18 12:10 | 回合结束，未消退尾部不被解释为风险已结束 |

## F 观测异常与证据切换

保留 V4R2 六题，含四道原复合题和两个已配置的设备/证据切换题。测量异常仍与信息记录隐藏正交，不新增污染或采血生理。

### V4R3-F01 真实活动下降叠加伪高

来源：V4R2-F01；原冻结题F01，物理配置未变。
意图：原 V4R2 物理配置不变。 不能只按表面高值增加干预，也不能丢掉真实活动。
机制对照：相同摄入/运动，去掉漂移。
I1规则草案：[{"category":"fault"}]。正式运行前须核对有效投影。
依据：R04、R22，来源同类现象不等于选定参数或组合已临床验证。
回合：10-17 11:55—10-18 11:55；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 11:50 | 前史：已有CGM校准 |
| 10-17 12:05 | 当下meal记录：Current intention: meal around 12:40, estimated 54 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 12:25 | 传感器漂移峰值85 mg/dL，总长480 min，起止斜坡90 min |
| 10-17 12:25 | 当下fault记录：Person reports a sensor-site problem or possible interference. Sensor values may not reflect blood glucose; an independent meter is available. Direction and magnitude are not supplied. |
| 10-17 12:40 | 摄入54 g，上报54 g，τ=60 min |
| 10-17 13:15 | 当下exercise记录：Person intends aerobic activity around 13:55 for about 60 minutes; moderate effort. Timing may change. |
| 10-17 13:55 | 活动60 min，AC=2095，附加肝糖项0 mg/dL/min |
| 10-17 14:55 | activity-0预设区间结束；不清空此前体内状态 |
| 10-17 16:50 | 当下meal记录：Current intention: meal around 17:25, estimated 64 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 17:25 | 摄入64 g，上报64 g，τ=60 min |
| 10-17 20:25 | drift-30预设区间结束；不清空此前体内状态 |
| 10-17 23:00 | 当下meal记录：Current intention: meal around 23:35, estimated 59 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 23:35 | 摄入59 g，上报59 g，τ=60 min |
| 10-18 01:15 | 传感器漂移峰值65 mg/dL，总长360 min，起止斜坡60 min |
| 10-18 01:15 | 当下fault记录：Person reports a sensor-site problem or possible interference. Sensor values may not reflect blood glucose; an independent meter is available. Direction and magnitude are not supplied. |
| 10-18 01:45 | 当下exercise记录：Person intends aerobic activity around 02:25 for about 60 minutes; moderate effort. Timing may change. |
| 10-18 02:25 | 活动60 min，AC=2095，附加肝糖项0 mg/dL/min |
| 10-18 03:25 | activity-1预设区间结束；不清空此前体内状态 |
| 10-18 07:10 | 当下meal记录：Current intention: meal around 07:45, estimated 64 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 07:15 | drift-800预设区间结束；不清空此前体内状态 |
| 10-18 07:45 | 摄入64 g，上报64 g，τ=60 min |
| 10-18 11:55 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-F02 真实餐后输入叠加伪低

来源：V4R2-F02；原冻结题F02，物理配置未变。
意图：原 V4R2 物理配置不变。 考察低读数复核及识别表面读数与真实输入并存。
机制对照：同进食，无漂移/压迫；分别移除两种传感器项。
I1规则草案：[{"category":"fault"}]。正式运行前须核对有效投影。
依据：R20、R11，来源同类现象不等于选定参数或组合已临床验证。
回合：10-17 12:25—10-18 12:25；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 12:20 | 前史：已有CGM校准 |
| 10-17 12:35 | 当下meal记录：Current intention: meal around 13:10, estimated 60 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 12:55 | 传感器漂移峰值-80 mg/dL，总长480 min，起止斜坡60 min |
| 10-17 12:55 | 当下fault记录：Person reports a sensor-site problem or possible interference. Sensor values may not reflect blood glucose; an independent meter is available. Direction and magnitude are not supplied. |
| 10-17 13:10 | 摄入60 g，上报60 g，τ=60 min |
| 10-17 15:50 | 当下meal记录：Current intention: meal around 16:25, estimated 41 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 16:25 | 摄入41 g，上报41 g，τ=60 min |
| 10-17 19:50 | 当下meal记录：Current intention: meal around 20:25, estimated 51 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 20:25 | 摄入51 g，上报51 g，τ=60 min |
| 10-17 20:55 | drift-30预设区间结束；不清空此前体内状态 |
| 10-18 02:00 | 当下meal记录：Current intention: meal around 02:35, estimated 47 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 02:15 | CGM压迫伪低90 min，深度参数65 mg/dL |
| 10-18 02:35 | 摄入47 g，上报47 g，τ=60 min |
| 10-18 07:40 | 当下meal记录：Current intention: meal around 08:15, estimated 41 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 08:15 | 摄入41 g，上报41 g，τ=60 min |
| 10-18 12:25 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-F03 多次进食和活动发生在断流前后

来源：V4R2-F03；原冻结题F03，物理配置未变。
意图：原 V4R2 物理配置不变。 信息缺口期间身体继续演化，必须使用可用工具与恢复后的反馈。
机制对照：同真实日程，去除强制断流；I 条件不能代替物理缺口。
I1规则草案：[{"category":"meal","ids":["meal-0","plan-meal-0","meal-1","plan-meal-1"]}]。正式运行前须核对有效投影。
依据：R20、R12，来源同类现象不等于选定参数或组合已临床验证。
回合：10-17 12:10—10-18 12:10；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 12:05 | 前史：已有CGM校准 |
| 10-17 12:20 | 当下meal记录：Current intention: meal around 12:55, estimated 49 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 12:30 | CGM断流240 min |
| 10-17 12:55 | 摄入49 g，上报49 g，τ=60 min |
| 10-17 14:35 | 当下meal记录：Current intention: meal around 15:10, estimated 40 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 15:10 | 摄入40 g，上报40 g，τ=60 min |
| 10-17 16:30 | 当下exercise记录：Person intends aerobic activity around 17:10 for about 60 minutes; moderate effort. Timing may change. |
| 10-17 17:10 | 活动60 min，AC=2095，附加肝糖项0 mg/dL/min |
| 10-17 18:10 | activity-0预设区间结束；不清空此前体内状态 |
| 10-17 19:25 | 当下meal记录：Current intention: meal around 20:00, estimated 46 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 19:30 | CGM断流210 min |
| 10-17 20:00 | 摄入46 g，上报46 g，τ=60 min |
| 10-17 21:35 | 当下meal记录：Current intention: meal around 22:10, estimated 37 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 22:10 | 摄入37 g，上报37 g，τ=60 min |
| 10-18 05:40 | CGM断流180 min |
| 10-18 05:55 | 当下meal记录：Current intention: meal around 06:30, estimated 40 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 06:30 | 摄入40 g，上报40 g，τ=60 min |
| 10-18 08:15 | 当下meal记录：Current intention: meal around 08:50, estimated 29 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 08:50 | 摄入29 g，上报29 g，τ=60 min |
| 10-18 12:10 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-F04 疾病恢复期伴错误校准及漂移

来源：V4R2-F04；原冻结题F04，物理配置未变。
意图：原 V4R2 物理配置不变。 完整保留原观测复合题，H 为次标签，不重复计算一条物理题。
机制对照：2×2：疾病恢复过程与观测异常分别有无，观察交互。
I1规则草案：[{"category":"life","ids":["ill-recovery-0"]}]。正式运行前须核对有效投影。
依据：R08、R13、R22，来源同类现象不等于选定参数或组合已临床验证。
回合：10-17 11:50—10-18 11:50；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 11:45 | 前史：已有CGM校准 |
| 10-17 11:50 | 已有需求代理开始，r=0.6，SI倍率=1/(1+r)，持续5 h |
| 10-17 12:00 | 当下meal记录：Current intention: meal around 12:35, estimated 55 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 12:35 | 摄入55 g，上报55 g，τ=60 min |
| 10-17 16:20 | 错误校准的参考值偏差45 mg/dL；不等于永久固定读数偏差 |
| 10-17 16:45 | 当下meal记录：Current intention: meal around 17:20, estimated 37 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 16:50 | ill-0预设区间结束；不清空此前体内状态 |
| 10-17 16:50 | 传感器漂移峰值55 mg/dL，总长420 min，起止斜坡90 min |
| 10-17 16:50 | 当下life记录：Person reports fever/nausea have improved and appetite is changing; review recent insulin before repeating corrections. Exact insulin sensitivity is unknown. |
| 10-17 16:50 | 当下fault记录：Person reports a sensor-site problem or possible interference. Sensor values may not reflect blood glucose; an independent meter is available. Direction and magnitude are not supplied. |
| 10-17 17:20 | 摄入37 g，上报37 g，τ=60 min |
| 10-17 22:45 | 当下meal记录：Current intention: meal around 23:20, estimated 83 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-17 23:20 | 摄入83 g，上报83 g，τ=60 min |
| 10-17 23:50 | drift-300预设区间结束；不清空此前体内状态 |
| 10-18 07:05 | 当下meal记录：Current intention: meal around 07:40, estimated 65 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction. |
| 10-18 07:40 | 摄入65 g，上报65 g，τ=60 min |
| 10-18 11:50 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-F05 校准到期停更而进食继续

来源：V4R2-F05。
意图：原 V4R2 物理配置不变。 06:00 尚有读数，06:10 到期后无法继续更新，后续三餐仍发生；考察数据时效和现有校准工具，不新增传感器生理。
机制对照：同 Guardian 3 和日程，最近一次校准改为起点前 5 分钟；到期时刻按当前设备模型验证。
I1规则草案：[{"category":"fault","ids":["calibration-narrative"]}]。正式运行前须核对有效投影。
依据：R12、R13，来源同类现象不等于选定参数或组合已临床验证。
回合：10-18 06:00—10-19 06:00；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-17 18:10 | 前史：已有CGM校准 |
| 10-18 06:00 | 当下fault记录：患者提到很久没有校准；具体到期时间以设备状态为准。 |
| 10-18 06:10 | 现有校准到期；无主动校准则不能继续得到新值 |
| 10-18 06:55 | 当下meal记录：当前计划约在 07:30 进食，估计碳水 35 g；这是意向，不是未来实际摄入保证。 |
| 10-18 07:30 | 摄入35 g，上报35 g，τ=60 min |
| 10-18 11:55 | 当下meal记录：当前计划约在 12:30 进食，估计碳水 55 g；这是意向，不是未来实际摄入保证。 |
| 10-18 12:30 | 摄入55 g，上报55 g，τ=75 min |
| 10-18 17:25 | 当下meal记录：当前计划约在 18:00 进食，估计碳水 50 g；这是意向，不是未来实际摄入保证。 |
| 10-18 18:00 | 摄入50 g，上报50 g，τ=90 min |
| 10-19 06:00 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-F06 伪高结束后真实摄入开始主导

来源：V4R2-F06。
意图：原 V4R2 物理配置不变。 08:00–12:00 仅传感器正向漂移，12:30 午餐后不再有该漂移；考察能否撤销旧的传感器解释并跟踪新证据，不预设真实血糖的形状。
机制对照：同真实摄入，无早段漂移；另设午餐不发生的版本，分清观测异常结束与新摄入。
I1规则草案：[{"category":"fault","ids":["early-sensor-report"]}]。正式运行前须核对有效投影。
依据：R12、R22，来源同类现象不等于选定参数或组合已临床验证。
回合：10-18 06:00—10-19 06:00；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-18 05:55 | 前史：已有CGM校准 |
| 10-18 06:55 | 当下meal记录：当前计划约在 07:30 进食，估计碳水 35 g；这是意向，不是未来实际摄入保证。 |
| 10-18 07:30 | 摄入35 g，上报35 g，τ=60 min |
| 10-18 08:00 | 传感器漂移峰值60 mg/dL，总长240 min，起止斜坡45 min |
| 10-18 08:00 | 当下fault记录：患者报告传感器部位可能受影响；无法说明偏差方向和幅度。 |
| 10-18 11:55 | 当下meal记录：当前计划约在 12:30 进食，估计碳水 55 g；这是意向，不是未来实际摄入保证。 |
| 10-18 12:00 | early-drift预设区间结束；不清空此前体内状态 |
| 10-18 12:30 | 摄入55 g，上报55 g，τ=75 min |
| 10-18 17:25 | 当下meal记录：当前计划约在 18:00 进食，估计碳水 50 g；这是意向，不是未来实际摄入保证。 |
| 10-18 18:00 | 摄入50 g，上报50 g，τ=90 min |
| 10-19 06:00 | 回合结束，未消退尾部不被解释为风险已结束 |

## H 疾病相关需求与摄入恢复

八题收敛到四种代表性情境：正常进食的高需求、低摄入的高需求、需求与摄入恢复错位、病日并存送达异常。早恢复/晚恢复等相近病例进入同一题的对照，而不是按不同病名或多个恢复时点重复计题。仍只使用现有 illness 代理，不增加真实病种动力学。

### V4R3-H01 正常进食下的持续疾病高需求

来源：V4R2-H03。
意图：正常摄入与持续需求上升的代表，不另按病种或需求时长拆题。 08:00–20:00 illness 参数 0.4，三餐不减量，没有额外运动或故障。把持续需求问题与漏餐补偿分开；20:00 后继续观察至次晨。
机制对照：完全相同三餐，没有 illness 代理。
I1规则草案：[{"category":"life","ids":["ill"]}]。正式运行前须核对有效投影。
依据：R08、SICK25，来源同类现象不等于选定参数或组合已临床验证。
回合：10-18 06:00—10-19 06:00；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-18 05:55 | 前史：已有CGM校准 |
| 10-18 06:55 | 当下meal记录：当前计划约在 07:30 进食，估计碳水 35 g；这是意向，不是未来实际摄入保证。 |
| 10-18 07:30 | 摄入35 g，上报35 g，τ=60 min |
| 10-18 08:00 | 已有需求代理开始，r=0.4，SI倍率=1/(1+r)，持续12 h |
| 10-18 11:55 | 当下meal记录：当前计划约在 12:30 进食，估计碳水 55 g；这是意向，不是未来实际摄入保证。 |
| 10-18 12:30 | 摄入55 g，上报55 g，τ=75 min |
| 10-18 17:25 | 当下meal记录：当前计划约在 18:00 进食，估计碳水 50 g；这是意向，不是未来实际摄入保证。 |
| 10-18 18:00 | 摄入50 g，上报50 g，τ=90 min |
| 10-18 20:00 | ill预设区间结束；不清空此前体内状态 |
| 10-18 20:00 | 当下life记录：患者此时报告身体不适有所缓解；不提供实际敏感性或保证下一次血糖变化。 |
| 10-19 06:00 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-H02 持续疾病高需求伴摄入明显减少

来源：V4R2-H05。
意图：与 H01 分开，因为需要同时考虑较低外源输入和较高需求。 08:00–20:00 illness 参数 0.4；07:30 35 g、12:30 15 g、18:00 10 g，没有用晚间大餐自动抵消。只减少实际摄入，不模拟呕吐、脱水或胃排空疾病。
机制对照：H03：相同需求变化、三餐正常；另设同低摄入但无需求变化，分开核对。
I1规则草案：[{"category":"life","ids":["ill"]}]。正式运行前须核对有效投影。
依据：R08，来源同类现象不等于选定参数或组合已临床验证。
回合：10-18 06:00—10-19 06:00；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-18 05:55 | 前史：已有CGM校准 |
| 10-18 06:55 | 当下meal记录：当前计划约在 07:30 进食，估计碳水 35 g；这是意向，不是未来实际摄入保证。 |
| 10-18 07:30 | 摄入35 g，上报35 g，τ=60 min |
| 10-18 08:00 | 已有需求代理开始，r=0.4，SI倍率=1/(1+r)，持续12 h |
| 10-18 11:55 | 当下meal记录：当前计划约在 12:30 进食，估计碳水 15 g；这是意向，不是未来实际摄入保证。 |
| 10-18 12:30 | 摄入15 g，上报15 g，τ=75 min |
| 10-18 17:25 | 当下meal记录：当前计划约在 18:00 进食，估计碳水 10 g；这是意向，不是未来实际摄入保证。 |
| 10-18 18:00 | 摄入10 g，上报10 g，τ=90 min |
| 10-18 20:00 | ill预设区间结束；不清空此前体内状态 |
| 10-18 20:00 | 当下life记录：患者此时报告身体不适有所缓解；不提供实际敏感性或保证下一次血糖变化。 |
| 10-19 06:00 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-H03 疾病需求与食欲恢复先后错位

来源：V4R2-H06。
意图：一个主情景覆盖恢复顺序，不再把多种早晚恢复各算一题。 06:00–14:00 illness 参数 0.4；07:30 15 g、12:30 20 g，14:00 需求代理消退，到 18:00 才恢复 50 g 摄入。14:00–18:00 是两者不同步的关键窗口。
机制对照：主世界需求06:00—14:00、18:00恢复摄入；相同三餐15/20/50 g不变，仅把需求结束移至22:00，就得到食欲先恢复的配对世界。旧 H07 的餐量/起点/加餐也不同，不能直接作为该严格对照。
I1规则草案：[{"category":"life","ids":["ill-recovery"]}]。正式运行前须核对有效投影。
依据：R08、SICK25，来源同类现象不等于选定参数或组合已临床验证。
回合：10-18 06:00—10-19 06:00；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-18 05:55 | 前史：已有CGM校准 |
| 10-18 06:00 | 已有需求代理开始，r=0.4，SI倍率=1/(1+r)，持续8 h |
| 10-18 06:55 | 当下meal记录：当前计划约在 07:30 进食，估计碳水 15 g；这是意向，不是未来实际摄入保证。 |
| 10-18 07:30 | 摄入15 g，上报15 g，τ=60 min |
| 10-18 11:55 | 当下meal记录：当前计划约在 12:30 进食，估计碳水 20 g；这是意向，不是未来实际摄入保证。 |
| 10-18 12:30 | 摄入20 g，上报20 g，τ=75 min |
| 10-18 14:00 | ill预设区间结束；不清空此前体内状态 |
| 10-18 14:00 | 当下life记录：患者此时报告身体不适有所缓解；不提供实际敏感性或保证下一次血糖变化。 |
| 10-18 17:25 | 当下meal记录：当前计划约在 18:00 进食，估计碳水 50 g；这是意向，不是未来实际摄入保证。 |
| 10-18 18:00 | 当下life记录：患者此时食欲恢复并进餐；不代表提供任何真实生理参数。 |
| 10-18 18:00 | 摄入50 g，上报50 g，τ=90 min |
| 10-19 06:00 | 回合结束，未消退尾部不被解释为风险已结束 |

### V4R3-H04 疾病高需求叠加送达不足及修复

来源：V4R2-H08。
意图：保留一种跨机制病日复杂题。与 E 的差别是需求扰动始终存在，不能把高糖全部解释为漏餐或全部解释为设备问题。 08:00–20:00 illness 参数 0.4；10:00–14:00 泵实际送达比例 0.5，并在 10:00 有部位异常报告。14:00 外源修复；Agent 可更早主动更换；三餐为 35/35/40 g。
机制对照：2×2：正常、仅 illness、仅送达不足、两者并存；每个世界有各自 WAIT。
I1规则草案：[{"category":"fault","ids":["site-problem"]}]。正式运行前须核对有效投影。
依据：R08、R09、R19，来源同类现象不等于选定参数或组合已临床验证。
回合：10-18 06:00—10-19 06:00；起点由历史回放获得，不覆盖成手工高值。

| 北京时间 | 实际预设事件 |
|---|---|
| 10-18 05:55 | 前史：已有CGM校准 |
| 10-18 06:55 | 当下meal记录：当前计划约在 07:30 进食，估计碳水 35 g；这是意向，不是未来实际摄入保证。 |
| 10-18 07:30 | 摄入35 g，上报35 g，τ=60 min |
| 10-18 08:00 | 已有需求代理开始，r=0.4，SI倍率=1/(1+r)，持续12 h |
| 10-18 10:00 | 实际送达比例0.5，持续240 min；Agent可主动修复 |
| 10-18 10:00 | 当下fault记录：患者报告贴布潮湿或管路松动，设备画面可能仍显示运行。 |
| 10-18 11:55 | 当下meal记录：当前计划约在 12:30 进食，估计碳水 35 g；这是意向，不是未来实际摄入保证。 |
| 10-18 12:30 | 摄入35 g，上报35 g，τ=75 min |
| 10-18 14:00 | delivery-loss预设区间结束；不清空此前体内状态 |
| 10-18 14:00 | 当下fault记录：此时输注部位已处理；不补回之前未送达药物。 |
| 10-18 14:00 | 预设外源修复；不重置生理状态，不补回丢失药物 |
| 10-18 17:25 | 当下meal记录：当前计划约在 18:00 进食，估计碳水 40 g；这是意向，不是未来实际摄入保证。 |
| 10-18 18:00 | 摄入40 g，上报40 g，τ=90 min |
| 10-18 20:00 | ill预设区间结束；不清空此前体内状态 |
| 10-18 20:00 | 当下life记录：患者此时报告身体不适有所缓解；不提供实际敏感性或保证下一次血糖变化。 |
| 10-19 06:00 | 回合结束，未消退尾部不被解释为风险已结束 |

## 精简与留档原则

原A05/A06移出；旧G01/G02合成B01主世界/时点对照；旧G03不单列，与B02不同剂量的诊断配置不能冒充匹配对照；旧G04仅作E类状态鉴别参考；旧G05进入B03；旧G06不单列，B04用原A03复合题。
H04早恢复变体不单列；H06/H07的恢复顺序收敛为新H03，严格对照固定摄入、只改需求恢复时点，不能直接拿原H07不同餐量/加餐/起始时点作单因素对照。
legacy24中未进入精简核心的原A01/B04/D01/D02仍保存其全部配置和实验。它们与新情景共享部分机制，但不再增加核心主情景数量。不宣称它们变简单、无效或应删除。
核心32与legacy24共享20世界，不能当成56个独立世界汇总；在未增加机制对照/种子前，其并集是36。历史结果只在提示词/代码/世界等条件一致时可复用，不授权重新跑任何实验。

## 证据及检查

D03/R03、D04/R06、D05/R07及R18、D06/R15均使用已有原语或明确代理，不新增机制。来源见[基础研究](scenario-family-evidence-v1-20261016.zh-CN.md)及[扩展研究](../sweet-sim/knowledge/scenario-hard-evidence-v3.json)。
应激空腹反例只能作为额外辅助对照；不能给出一个无物理变化、只删掉文字后与普通背景相同的新全档位主题来凑数。
检查：32唯一ID，A/B各4，D6，H4；28份物理配置与V4R2深比较一致，其中20份来自legacy24；4份新增D通过当前schema和初始化。不是临床验证或难度验证。
