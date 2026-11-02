# v4.1 完整逐场景设计与日程

本补充包含全部 32 个冻结主世界，直接从 [完整目录](scenario-v4r3-day-cards-20261018.json) 的 instance_spec 排表。
目录 SHA256：`185719a639dd6e8499b70c82e84374753d66edd788c78ed0e8c7bd1afbcb0e42`。不读取旧 construction、结果、轨迹或模型输出，不选择或修改世界。
时间为北京时间 UTC+08:00，并保留相对分钟；负数为回合前历史，超出 horizon 的行标为回合外。参数保留原 JSON 字段和单位。
这是评测方设计说明，不注入 Agent。数值是合成配置，不是临床处方。吸收时间是模型时间常数，不代表吸收完成时间。
[版本入口与元数据限制](GUIDE.zh-CN.md)。有效信息契约：`selective-records/v1`。
comparator / partial_rules 下文逐字留档，不当作已构造的对照世界或自动修复的规则。历史 I1 可能投影重合；v4.2 不执行继承的 partial_rules。

| 场景 | 标题 |
|---|---|
| [V4R3-A01](#v4r3-a01) | 分散多次摄入与慢吸收主餐交叠 |
| [V4R3-A02](#v4r3-a02) | 两次慢餐尾部叠加后续进食 |
| [V4R3-A03](#v4r3-a03) | 预打后主餐取消并开始活动 |
| [V4R3-A04](#v4r3-a04) | 夜间慢餐叠加缺觉与黎明 |
| [V4R3-B01](#v4r3-b01) | 既往给药时点与残余作用 |
| [V4R3-B02](#v4r3-b02) | 既往叠加给药后活动与小餐交错 |
| [V4R3-B03](#v4r3-b03) | 主餐取消但延长输注尚未完成 |
| [V4R3-B04](#v4r3-b04) | 救援补碳未充分吸收且主餐推迟 |
| [V4R3-C01](#v4r3-c01) | 两段活动穿插补给和多餐 |
| [V4R3-C02](#v4r3-c02) | 暂时肝糖正扰动后接有氧 |
| [V4R3-C03](#v4r3-c03) | 晚间活动和饮酒后的延迟作用 |
| [V4R3-C04](#v4r3-c04) | 夜间慢餐后次晨连续两次活动 |
| [V4R3-D01](#v4r3-d01) | 两次短时应激消退后分别接活动 |
| [V4R3-D02](#v4r3-d02) | 缺觉与黎明叠加后的需求恢复 |
| [V4R3-D03](#v4r3-d03) | 未进食时的黎明需求进入与退出 |
| [V4R3-D04](#v4r3-d04) | 缺觉相关需求退出后仍继续进食 |
| [V4R3-D05](#v4r3-d05) | 慢餐后的短时应激及其消退 |
| [V4R3-D06](#v4r3-d06) | 无运动背景下的饮酒延迟肝糖扰动 |
| [V4R3-E01](#v4r3-e01) | 静默送达不足叠加多餐 |
| [V4R3-E02](#v4r3-e02) | 三次间歇送达不足和不规则进食 |
| [V4R3-E03](#v4r3-e03) | 送达恢复后慢餐与活动交错 |
| [V4R3-E04](#v4r3-e04) | 静默送达不足叠加渐进伪高 |
| [V4R3-F01](#v4r3-f01) | 真实活动下降叠加伪高 |
| [V4R3-F02](#v4r3-f02) | 真实餐后输入叠加伪低 |
| [V4R3-F03](#v4r3-f03) | 多次进食和活动发生在断流前后 |
| [V4R3-F04](#v4r3-f04) | 疾病恢复期伴错误校准及漂移 |
| [V4R3-F05](#v4r3-f05) | 校准到期停更而进食继续 |
| [V4R3-F06](#v4r3-f06) | 伪高结束后真实摄入开始主导 |
| [V4R3-H01](#v4r3-h01) | 正常进食下的持续疾病高需求 |
| [V4R3-H02](#v4r3-h02) | 持续疾病高需求伴摄入明显减少 |
| [V4R3-H03](#v4r3-h03) | 疾病需求与食欲恢复先后错位 |
| [V4R3-H04](#v4r3-h04) | 疾病高需求叠加送达不足及修复 |

<a id="v4r3-a01"></a>
## V4R3-A01 分散多次摄入与慢吸收主餐交叠

主族：A。来源：V4R2-B01；legacy24：B01。
设计意图（冻结原文）：用原 B01 的八次摄入完整覆盖不规则多餐与慢输入，不再另把原 A01 算入新主集。 连续小输入与主餐吸收尾部交错，不简化成单一慢餐。
依据编号：R14, R20, R21。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`a3078c7400deae7545391868c8943667472c1ff75c7c28d98f9b94e2d6571df8`。
历史 comparator（非执行配置，可能过时）：同总摄入和时间，关键慢餐使用普通时间常数。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"meal","ids":["meal-4","plan-meal-4"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T03:45:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "complete",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-17 11:40 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-17 11:45 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 10 | 2026-10-17 11:55 | event / plan-meal-0 | {"id":"plan-meal-0","type":"record","at_minute":10,"category":"meal","text":"Current intention: meal around 12:30, estimated 38 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 45 | 2026-10-17 12:30 | event / meal-0 | {"id":"meal-0","type":"meal","at_minute":45,"grams":38,"announced_grams":38,"absorption_minutes":60} |
| 120 | 2026-10-17 13:45 | event / plan-meal-1 | {"id":"plan-meal-1","type":"record","at_minute":120,"category":"meal","text":"Current intention: meal around 14:20, estimated 20 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 155 | 2026-10-17 14:20 | event / meal-1 | {"id":"meal-1","type":"meal","at_minute":155,"grams":20,"announced_grams":20,"absorption_minutes":60} |
| 235 | 2026-10-17 15:40 | event / plan-meal-2 | {"id":"plan-meal-2","type":"record","at_minute":235,"category":"meal","text":"Current intention: meal around 16:15, estimated 26 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 270 | 2026-10-17 16:15 | event / meal-2 | {"id":"meal-2","type":"meal","at_minute":270,"grams":26,"announced_grams":26,"absorption_minutes":60} |
| 365 | 2026-10-17 17:50 | event / plan-meal-3 | {"id":"plan-meal-3","type":"record","at_minute":365,"category":"meal","text":"Current intention: meal around 18:25, estimated 23 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 400 | 2026-10-17 18:25 | event / meal-3 | {"id":"meal-3","type":"meal","at_minute":400,"grams":23,"announced_grams":23,"absorption_minutes":60} |
| 485 | 2026-10-17 19:50 | event / plan-meal-4 | {"id":"plan-meal-4","type":"record","at_minute":485,"category":"meal","text":"Current intention: meal around 20:25, estimated 56 g carbohydrate; mixed meal reported high in fat/protein. Timing and actual intake may change; this is not a future glucose prediction."} |
| 520 | 2026-10-17 20:25 | event / meal-4 | {"id":"meal-4","type":"meal","at_minute":520,"grams":56,"announced_grams":56,"absorption_minutes":140} |
| 655 | 2026-10-17 22:40 | event / plan-meal-5 | {"id":"plan-meal-5","type":"record","at_minute":655,"category":"meal","text":"Current intention: meal around 23:15, estimated 20 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 690 | 2026-10-17 23:15 | event / meal-5 | {"id":"meal-5","type":"meal","at_minute":690,"grams":20,"announced_grams":20,"absorption_minutes":60} |
| 945 | 2026-10-18 03:30 | event / plan-meal-6 | {"id":"plan-meal-6","type":"record","at_minute":945,"category":"meal","text":"Current intention: meal around 04:05, estimated 18 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 980 | 2026-10-18 04:05 | event / meal-6 | {"id":"meal-6","type":"meal","at_minute":980,"grams":18,"announced_grams":18,"absorption_minutes":60} |
| 1155 | 2026-10-18 07:00 | event / plan-meal-7 | {"id":"plan-meal-7","type":"record","at_minute":1155,"category":"meal","text":"Current intention: meal around 07:35, estimated 38 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1190 | 2026-10-18 07:35 | event / meal-7 | {"id":"meal-7","type":"meal","at_minute":1190,"grams":38,"announced_grams":38,"absorption_minutes":60} |
| 1440 | 2026-10-18 11:45 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-a02"></a>
## V4R3-A02 两次慢餐尾部叠加后续进食

主族：A。来源：V4R2-B02；legacy24：B02。
设计意图（冻结原文）：保留两次慢输入及其间/之后摄入的原复杂度。 考察前一输入尚未结束时继续摄入的时序判断。
依据编号：R14, R18。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`48f3c31d949af24a1aae507c2bfa5414dd39ce036ce7a2fec767db217fad4cb3`。
历史 comparator（非执行配置，可能过时）：同摄入量和时点，只改变首个慢餐时间常数。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"meal","ids":["meal-0","plan-meal-0","meal-2","plan-meal-2"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T04:10:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "complete",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-17 12:05 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-17 12:10 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 10 | 2026-10-17 12:20 | event / plan-meal-0 | {"id":"plan-meal-0","type":"record","at_minute":10,"category":"meal","text":"Current intention: meal around 12:55, estimated 59 g carbohydrate; mixed meal reported high in fat/protein. Timing and actual intake may change; this is not a future glucose prediction."} |
| 45 | 2026-10-17 12:55 | event / meal-0 | {"id":"meal-0","type":"meal","at_minute":45,"grams":59,"announced_grams":59,"absorption_minutes":150} |
| 165 | 2026-10-17 14:55 | event / plan-meal-1 | {"id":"plan-meal-1","type":"record","at_minute":165,"category":"meal","text":"Current intention: meal around 15:30, estimated 23 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 200 | 2026-10-17 15:30 | event / meal-1 | {"id":"meal-1","type":"meal","at_minute":200,"grams":23,"announced_grams":23,"absorption_minutes":60} |
| 335 | 2026-10-17 17:45 | event / plan-meal-2 | {"id":"plan-meal-2","type":"record","at_minute":335,"category":"meal","text":"Current intention: meal around 18:20, estimated 62 g carbohydrate; mixed meal reported high in fat/protein. Timing and actual intake may change; this is not a future glucose prediction."} |
| 370 | 2026-10-17 18:20 | event / meal-2 | {"id":"meal-2","type":"meal","at_minute":370,"grams":62,"announced_grams":62,"absorption_minutes":160} |
| 545 | 2026-10-17 21:15 | event / plan-meal-3 | {"id":"plan-meal-3","type":"record","at_minute":545,"category":"meal","text":"Current intention: meal around 21:50, estimated 26 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 580 | 2026-10-17 21:50 | event / meal-3 | {"id":"meal-3","type":"meal","at_minute":580,"grams":26,"announced_grams":26,"absorption_minutes":60} |
| 815 | 2026-10-18 01:45 | event / plan-meal-4 | {"id":"plan-meal-4","type":"record","at_minute":815,"category":"meal","text":"Current intention: meal around 02:20, estimated 23 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 850 | 2026-10-18 02:20 | event / meal-4 | {"id":"meal-4","type":"meal","at_minute":850,"grams":23,"announced_grams":23,"absorption_minutes":60} |
| 1155 | 2026-10-18 07:25 | event / plan-meal-5 | {"id":"plan-meal-5","type":"record","at_minute":1155,"category":"meal","text":"Current intention: meal around 08:00, estimated 46 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1190 | 2026-10-18 08:00 | event / meal-5 | {"id":"meal-5","type":"meal","at_minute":1190,"grams":46,"announced_grams":46,"absorption_minutes":60} |
| 1440 | 2026-10-18 12:10 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-a03"></a>
## V4R3-A03 预打后主餐取消并开始活动

主族：A。来源：V4R2-A02；legacy24：A02。
设计意图（冻结原文）：保留预打、实际小餐和活动的错配，不能简化成无药效的取消意向。 已发生药效、少量摄入和活动叠加，需要应对时序改变。
依据编号：R01, R04。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`87bfe17fa2e0b2a6f3d6d66e926089b4a9dfc1ed3a077578bd7ac523a464d796`。
历史 comparator（非执行配置，可能过时）：同给药史和活动，计划餐兑现；另设无预打版本，不能一次改两项。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"meal","ids":["cancelled-lunch","meal-0"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T04:00:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "complete",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -15 | 2026-10-17 11:45 | history / history:1 | {"type":"bolus","minutes_before":15,"units":4} |
| -5 | 2026-10-17 11:55 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-17 12:00 | event / cancelled-lunch | {"id":"cancelled-lunch","type":"record","at_minute":0,"category":"meal","text":"A planned 40 g meal was cancelled after a pre-meal dose. Only a small snack is currently available; do not assume the planned meal will arrive."} |
| 0 | 2026-10-17 12:00 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 10 | 2026-10-17 12:10 | event / plan-activity-0 | {"id":"plan-activity-0","type":"record","at_minute":10,"category":"exercise","text":"Person intends aerobic activity around 12:50 for about 60 minutes; moderate effort. Timing may change."} |
| 45 | 2026-10-17 12:45 | event / meal-0 | {"id":"meal-0","type":"meal","at_minute":45,"grams":15,"announced_grams":15,"absorption_minutes":60} |
| 50 | 2026-10-17 12:50 | event / activity-0 | {"id":"activity-0","type":"exercise","at_minute":50,"duration_minutes":60,"accelerometer_counts":2095,"announced":true,"kind":"aerobic","hepatic_delta_mg_dl_per_min":0} |
| 110 | 2026-10-17 13:50 | boundary / activity-0:end | Configured interval ends; residual food/drug/state can remain. |
| 225 | 2026-10-17 15:45 | event / plan-meal-1 | {"id":"plan-meal-1","type":"record","at_minute":225,"category":"meal","text":"Current intention: meal around 16:20, estimated 65 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 260 | 2026-10-17 16:20 | event / meal-1 | {"id":"meal-1","type":"meal","at_minute":260,"grams":65,"announced_grams":65,"absorption_minutes":60} |
| 525 | 2026-10-17 20:45 | event / plan-meal-2 | {"id":"plan-meal-2","type":"record","at_minute":525,"category":"meal","text":"Current intention: meal around 21:20, estimated 85 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 560 | 2026-10-17 21:20 | event / meal-2 | {"id":"meal-2","type":"meal","at_minute":560,"grams":85,"announced_grams":85,"absorption_minutes":60} |
| 1135 | 2026-10-18 06:55 | event / plan-meal-3 | {"id":"plan-meal-3","type":"record","at_minute":1135,"category":"meal","text":"Current intention: meal around 07:30, estimated 70 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1170 | 2026-10-18 07:30 | event / meal-3 | {"id":"meal-3","type":"meal","at_minute":1170,"grams":70,"announced_grams":70,"absorption_minutes":60} |
| 1440 | 2026-10-18 12:00 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-a04"></a>
## V4R3-A04 夜间慢餐叠加缺觉与黎明

主族：A。来源：V4R2-B03；legacy24：B03。
设计意图（冻结原文）：保留原跨夜复合题，主标签为慢输入，其他机制按次标签报告。 跨夜仍需追踪旧输入，不能在午夜重置判断。
依据编号：R14, R03, R06。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`6403e53b4fd008d6bbef97184636875e332261fe75f4ddd17940e0dcf741a1d2`。
历史 comparator（非执行配置，可能过时）：分别去掉慢输入、缺觉或黎明项，保持其他组合；不以一个全删版代替分项比较。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"life"}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T03:55:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0.3
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "complete",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-17 11:50 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-17 11:55 | event / sleep | {"id":"sleep","type":"sleep_loss","at_minute":0,"duration_minutes":1080,"sensitivity_decrease":0.2,"announced":true} |
| 0 | 2026-10-17 11:55 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 10 | 2026-10-17 12:05 | event / plan-meal-0 | {"id":"plan-meal-0","type":"record","at_minute":10,"category":"meal","text":"Current intention: meal around 12:40, estimated 50 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 45 | 2026-10-17 12:40 | event / meal-0 | {"id":"meal-0","type":"meal","at_minute":45,"grams":50,"announced_grams":50,"absorption_minutes":60} |
| 355 | 2026-10-17 17:50 | event / plan-meal-1 | {"id":"plan-meal-1","type":"record","at_minute":355,"category":"meal","text":"Current intention: meal around 18:25, estimated 47 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 390 | 2026-10-17 18:25 | event / meal-1 | {"id":"meal-1","type":"meal","at_minute":390,"grams":47,"announced_grams":47,"absorption_minutes":60} |
| 685 | 2026-10-17 23:20 | event / plan-meal-2 | {"id":"plan-meal-2","type":"record","at_minute":685,"category":"meal","text":"Current intention: meal around 23:55, estimated 68 g carbohydrate; mixed meal reported high in fat/protein. Timing and actual intake may change; this is not a future glucose prediction."} |
| 720 | 2026-10-17 23:55 | event / meal-2 | {"id":"meal-2","type":"meal","at_minute":720,"grams":68,"announced_grams":68,"absorption_minutes":180} |
| 955 | 2026-10-18 03:50 | event / plan-meal-3 | {"id":"plan-meal-3","type":"record","at_minute":955,"category":"meal","text":"Current intention: meal around 04:25, estimated 21 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 990 | 2026-10-18 04:25 | event / meal-3 | {"id":"meal-3","type":"meal","at_minute":990,"grams":21,"announced_grams":21,"absorption_minutes":60} |
| 1080 | 2026-10-18 05:55 | boundary / sleep:end | Configured interval ends; residual food/drug/state can remain. |
| 1175 | 2026-10-18 07:30 | event / plan-meal-4 | {"id":"plan-meal-4","type":"record","at_minute":1175,"category":"meal","text":"Current intention: meal around 08:05, estimated 54 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1210 | 2026-10-18 08:05 | event / meal-4 | {"id":"meal-4","type":"meal","at_minute":1210,"grams":54,"announced_grams":54,"absorption_minutes":60} |
| 1440 | 2026-10-18 11:55 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-b01"></a>
## V4R3-B01 既往给药时点与残余作用

主族：B。来源：V4R2-G01；legacy24：无。
设计意图（冻结原文）：同总量不同历史时点作为同一题的主世界/配对世界，不分别占两个主题。 05:40 给过 1.5 U，06:00 回合开始，10:00 前无新摄入；考察能否考虑时间延迟。这是明确的外部给药史，不预设它当时是否合理，也不伪造一个高血糖起点。
依据编号：R01, N05。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`faf10aa98497cce2bee98b8e9cfb80f9257116f1ffc8b50582cc08595bed5ea9`。
历史 comparator（非执行配置，可能过时）：主世界为原 G01：起点前20分钟1.5 U；时点对照为原 G02：起点前160分钟1.5 U，摄入和其他物理配置相同。历史各自回放，初始血糖不强行相同。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"treatment"}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T22:00:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "native",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -20 | 2026-10-18 05:40 | history / history:1 | {"type":"bolus","minutes_before":20,"units":1.5} |
| -5 | 2026-10-18 05:55 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-18 06:00 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 205 | 2026-10-18 09:25 | event / plan-meal-240 | {"id":"plan-meal-240","type":"record","at_minute":205,"category":"meal","text":"当前计划约在 10:00 进食，估计碳水 35 g；这是意向，不是未来实际摄入保证。"} |
| 240 | 2026-10-18 10:00 | event / meal-240 | {"id":"meal-240","type":"meal","at_minute":240,"grams":35,"announced_grams":35,"absorption_minutes":60} |
| 445 | 2026-10-18 13:25 | event / plan-meal-480 | {"id":"plan-meal-480","type":"record","at_minute":445,"category":"meal","text":"当前计划约在 14:00 进食，估计碳水 50 g；这是意向，不是未来实际摄入保证。"} |
| 480 | 2026-10-18 14:00 | event / meal-480 | {"id":"meal-480","type":"meal","at_minute":480,"grams":50,"announced_grams":50,"absorption_minutes":75} |
| 685 | 2026-10-18 17:25 | event / plan-meal-720 | {"id":"plan-meal-720","type":"record","at_minute":685,"category":"meal","text":"当前计划约在 18:00 进食，估计碳水 45 g；这是意向，不是未来实际摄入保证。"} |
| 720 | 2026-10-18 18:00 | event / meal-720 | {"id":"meal-720","type":"meal","at_minute":720,"grams":45,"announced_grams":45,"absorption_minutes":90} |
| 1440 | 2026-10-19 06:00 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-b02"></a>
## V4R3-B02 既往叠加给药后活动与小餐交错

主族：B。来源：V4R2-A04；legacy24：A04。
设计意图（冻结原文）：保留原 A04 的两次给药、活动及餐量变化，而非另造多道单次/分次同质题。 保留已有两个剂量及活动，测试历史暴露和调整。
依据编号：R20, R01。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`6e458ef5d1a5eabc028d1739e66a76009db9e26961b1e667a9ced7a67aa250c6`。
历史 comparator（非执行配置，可能过时）：同总量4 U、相同活动和进食，把1.7 U/2.3 U的分布改为起点前40分钟一次给入；预注册为给药时序分布对照，不能同时改变总量。原 G03 的3 U简化配置仅留诊断档案，不冒充严格匹配对照。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"treatment"},{"category":"exercise"}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T03:40:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66,
      "initial_glucose_mg_dl": 210
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "complete",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -70 | 2026-10-17 10:30 | history / history:1 | {"type":"bolus","minutes_before":70,"units":1.7} |
| -20 | 2026-10-17 11:20 | history / history:2 | {"type":"bolus","minutes_before":20,"units":2.3} |
| -5 | 2026-10-17 11:35 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-17 11:40 | event / meal-change | {"id":"meal-change","type":"record","at_minute":0,"category":"meal","text":"Lunch will be much smaller than originally planned; prior correction insulin may still be active."} |
| 0 | 2026-10-17 11:40 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 5 | 2026-10-17 11:45 | event / plan-activity-0 | {"id":"plan-activity-0","type":"record","at_minute":5,"category":"exercise","text":"Person intends aerobic activity around 12:25 for about 60 minutes; moderate effort. Timing may change."} |
| 45 | 2026-10-17 12:25 | event / activity-0 | {"id":"activity-0","type":"exercise","at_minute":45,"duration_minutes":60,"accelerometer_counts":2095,"announced":true,"kind":"aerobic","hepatic_delta_mg_dl_per_min":0} |
| 45 | 2026-10-17 12:25 | event / plan-meal-0 | {"id":"plan-meal-0","type":"record","at_minute":45,"category":"meal","text":"Current intention: meal around 13:00, estimated 20 g carbohydrate; mixed meal reported high in fat/protein. Timing and actual intake may change; this is not a future glucose prediction."} |
| 80 | 2026-10-17 13:00 | event / meal-0 | {"id":"meal-0","type":"meal","at_minute":80,"grams":20,"announced_grams":20,"absorption_minutes":150} |
| 105 | 2026-10-17 13:25 | boundary / activity-0:end | Configured interval ends; residual food/drug/state can remain. |
| 325 | 2026-10-17 17:05 | event / plan-meal-1 | {"id":"plan-meal-1","type":"record","at_minute":325,"category":"meal","text":"Current intention: meal around 17:40, estimated 78 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 360 | 2026-10-17 17:40 | event / meal-1 | {"id":"meal-1","type":"meal","at_minute":360,"grams":78,"announced_grams":78,"absorption_minutes":60} |
| 625 | 2026-10-17 22:05 | event / plan-meal-2 | {"id":"plan-meal-2","type":"record","at_minute":625,"category":"meal","text":"Current intention: meal around 22:40, estimated 73 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 660 | 2026-10-17 22:40 | event / meal-2 | {"id":"meal-2","type":"meal","at_minute":660,"grams":73,"announced_grams":73,"absorption_minutes":60} |
| 1155 | 2026-10-18 06:55 | event / plan-meal-3 | {"id":"plan-meal-3","type":"record","at_minute":1155,"category":"meal","text":"Current intention: meal around 07:30, estimated 69 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1190 | 2026-10-18 07:30 | event / meal-3 | {"id":"meal-3","type":"meal","at_minute":1190,"grams":69,"announced_grams":69,"absorption_minutes":60} |
| 1440 | 2026-10-18 11:40 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-b03"></a>
## V4R3-B03 主餐取消但延长输注尚未完成

主族：B。来源：V4R2-G05；legacy24：无。
设计意图（冻结原文）：保留一个真正需要区分未来承诺与已入体药效的设备/生理交互。 05:30 启动 3 U/180 分钟延长输注；06:00 主餐取消，06:30 实际只有 10 g 加餐。未取消时剩余输注持续到 08:30，取消则按现有动作改变未来输入，已入体部分不回收。
依据编号：R01, R02。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`4d5d98237cf70af3e261227e91b60e0310a7b9cc6299a837470b89b5737ff2b1`。
历史 comparator（非执行配置，可能过时）：同样的主餐取消和实际日程，但没有剩余延长输注承诺；历史分别回放。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"meal","ids":["cancelled-meal"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T22:00:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "native",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -30 | 2026-10-18 05:30 | history / history:1 | {"type":"extended_bolus","minutes_before":30,"units":3,"duration_minutes":180} |
| -5 | 2026-10-18 05:55 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-18 06:00 | event / cancelled-meal | {"id":"cancelled-meal","type":"record","at_minute":0,"category":"meal","text":"原定主餐取消，只能在 06:30 吃少量加餐；先前已启动延长输注。"} |
| 0 | 2026-10-18 06:00 | event / plan-meal-30 | {"id":"plan-meal-30","type":"record","at_minute":0,"category":"meal","text":"当前计划约在 06:30 进食，估计碳水 10 g；这是意向，不是未来实际摄入保证。"} |
| 0 | 2026-10-18 06:00 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 30 | 2026-10-18 06:30 | event / meal-30 | {"id":"meal-30","type":"meal","at_minute":30,"grams":10,"announced_grams":10,"absorption_minutes":60} |
| 150 | 2026-10-18 08:30 | boundary / history:1:end | Prior extended delivery is scheduled to finish if not cancelled; this is not a new dose. |
| 355 | 2026-10-18 11:55 | event / plan-meal-390 | {"id":"plan-meal-390","type":"record","at_minute":355,"category":"meal","text":"当前计划约在 12:30 进食，估计碳水 55 g；这是意向，不是未来实际摄入保证。"} |
| 390 | 2026-10-18 12:30 | event / meal-390 | {"id":"meal-390","type":"meal","at_minute":390,"grams":55,"announced_grams":55,"absorption_minutes":75} |
| 685 | 2026-10-18 17:25 | event / plan-meal-720 | {"id":"plan-meal-720","type":"record","at_minute":685,"category":"meal","text":"当前计划约在 18:00 进食，估计碳水 50 g；这是意向，不是未来实际摄入保证。"} |
| 720 | 2026-10-18 18:00 | event / meal-720 | {"id":"meal-720","type":"meal","at_minute":720,"grams":50,"announced_grams":50,"absorption_minutes":90} |
| 1440 | 2026-10-19 06:00 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-b04"></a>
## V4R3-B04 救援补碳未充分吸收且主餐推迟

主族：B。来源：V4R2-A03；legacy24：A03。
设计意图（冻结原文）：使用原复杂题而不是另算原 G06 简化题，保留既有药效和全天后续输入。 刚发生的补碳仍在肠道仓库，不能每次重新当作未处理。
依据编号：R01, R18。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`ac0dd523152383bac02d56ee051eb99952694f01176e0a411be215c061319b08`。
历史 comparator（非执行配置，可能过时）：同药效史、未补该笔碳水；完整日程不变。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"meal","ids":["recent-rescue","history:2"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T04:25:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "complete",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -45 | 2026-10-17 11:40 | history / history:1 | {"type":"bolus","minutes_before":45,"units":4} |
| -5 | 2026-10-17 12:20 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| -5 | 2026-10-17 12:20 | history / history:2 | {"type":"carbs","minutes_before":5,"grams":15} |
| 0 | 2026-10-17 12:25 | event / recent-rescue | {"id":"recent-rescue","type":"record","at_minute":0,"category":"meal","text":"Person reports a 15 g rescue drink five minutes ago; it may not yet have fully acted. Main meal is delayed."} |
| 0 | 2026-10-17 12:25 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 95 | 2026-10-17 14:00 | event / plan-meal-0 | {"id":"plan-meal-0","type":"record","at_minute":95,"category":"meal","text":"Current intention: meal around 14:35, estimated 53 g carbohydrate; mixed meal reported high in fat/protein. Timing and actual intake may change; this is not a future glucose prediction."} |
| 130 | 2026-10-17 14:35 | event / meal-0 | {"id":"meal-0","type":"meal","at_minute":130,"grams":53,"announced_grams":53,"absorption_minutes":150} |
| 385 | 2026-10-17 18:50 | event / plan-meal-1 | {"id":"plan-meal-1","type":"record","at_minute":385,"category":"meal","text":"Current intention: meal around 19:25, estimated 76 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 420 | 2026-10-17 19:25 | event / meal-1 | {"id":"meal-1","type":"meal","at_minute":420,"grams":76,"announced_grams":76,"absorption_minutes":60} |
| 725 | 2026-10-18 00:30 | event / plan-meal-2 | {"id":"plan-meal-2","type":"record","at_minute":725,"category":"meal","text":"Current intention: meal around 01:05, estimated 49 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 760 | 2026-10-18 01:05 | event / meal-2 | {"id":"meal-2","type":"meal","at_minute":760,"grams":49,"announced_grams":49,"absorption_minutes":60} |
| 1165 | 2026-10-18 07:50 | event / plan-meal-3 | {"id":"plan-meal-3","type":"record","at_minute":1165,"category":"meal","text":"Current intention: meal around 08:25, estimated 62 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1200 | 2026-10-18 08:25 | event / meal-3 | {"id":"meal-3","type":"meal","at_minute":1200,"grams":62,"announced_grams":62,"absorption_minutes":60} |
| 1440 | 2026-10-18 12:25 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-c01"></a>
## V4R3-C01 两段活动穿插补给和多餐

主族：C。来源：V4R2-C01；legacy24：C01。
设计意图（冻结原文）：原 V4R2 物理配置不变。 第一次活动的状态与第二次活动共享，不按两道独立题处理。
依据编号：R04, R17。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`54964a2c7c8cb60e06afa736665a7347c6ac1fb9c8378c29a66ce6ec79f7a0e0`。
历史 comparator（非执行配置，可能过时）：同日程去掉第二次活动；另可改变间隔，但不同时换负荷。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"exercise","ids":["activity-1","plan-activity-1"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T04:25:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "complete",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-17 12:20 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-17 12:25 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 10 | 2026-10-17 12:35 | event / plan-meal-0 | {"id":"plan-meal-0","type":"record","at_minute":10,"category":"meal","text":"Current intention: meal around 13:10, estimated 49 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 45 | 2026-10-17 13:10 | event / meal-0 | {"id":"meal-0","type":"meal","at_minute":45,"grams":49,"announced_grams":49,"absorption_minutes":60} |
| 70 | 2026-10-17 13:35 | event / plan-activity-0 | {"id":"plan-activity-0","type":"record","at_minute":70,"category":"exercise","text":"Person intends aerobic activity around 14:15 for about 60 minutes; moderate effort. Timing may change."} |
| 110 | 2026-10-17 14:15 | event / activity-0 | {"id":"activity-0","type":"exercise","at_minute":110,"duration_minutes":60,"accelerometer_counts":2095,"announced":true,"kind":"aerobic","hepatic_delta_mg_dl_per_min":0} |
| 170 | 2026-10-17 15:15 | boundary / activity-0:end | Configured interval ends; residual food/drug/state can remain. |
| 185 | 2026-10-17 15:30 | event / plan-meal-1 | {"id":"plan-meal-1","type":"record","at_minute":185,"category":"meal","text":"Current intention: meal around 16:05, estimated 46 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 220 | 2026-10-17 16:05 | event / meal-1 | {"id":"meal-1","type":"meal","at_minute":220,"grams":46,"announced_grams":46,"absorption_minutes":60} |
| 385 | 2026-10-17 18:50 | event / plan-meal-2 | {"id":"plan-meal-2","type":"record","at_minute":385,"category":"meal","text":"Current intention: meal around 19:25, estimated 53 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 420 | 2026-10-17 19:25 | event / meal-2 | {"id":"meal-2","type":"meal","at_minute":420,"grams":53,"announced_grams":53,"absorption_minutes":60} |
| 420 | 2026-10-17 19:25 | event / plan-activity-1 | {"id":"plan-activity-1","type":"record","at_minute":420,"category":"exercise","text":"Person intends aerobic activity around 20:05 for about 60 minutes; moderate effort. Timing may change."} |
| 460 | 2026-10-17 20:05 | event / activity-1 | {"id":"activity-1","type":"exercise","at_minute":460,"duration_minutes":60,"accelerometer_counts":2095,"announced":true,"kind":"aerobic","hepatic_delta_mg_dl_per_min":0} |
| 520 | 2026-10-17 21:05 | boundary / activity-1:end | Configured interval ends; residual food/drug/state can remain. |
| 605 | 2026-10-17 22:30 | event / plan-meal-3 | {"id":"plan-meal-3","type":"record","at_minute":605,"category":"meal","text":"Current intention: meal around 23:05, estimated 43 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 640 | 2026-10-17 23:05 | event / meal-3 | {"id":"meal-3","type":"meal","at_minute":640,"grams":43,"announced_grams":43,"absorption_minutes":60} |
| 1155 | 2026-10-18 07:40 | event / plan-meal-4 | {"id":"plan-meal-4","type":"record","at_minute":1155,"category":"meal","text":"Current intention: meal around 08:15, estimated 49 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1190 | 2026-10-18 08:15 | event / meal-4 | {"id":"meal-4","type":"meal","at_minute":1190,"grams":49,"announced_grams":49,"absorption_minutes":60} |
| 1440 | 2026-10-18 12:25 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-c02"></a>
## V4R3-C02 暂时肝糖正扰动后接有氧

主族：C。来源：V4R2-C02；legacy24：C02。
设计意图（冻结原文）：原 V4R2 物理配置不变。 原高强度标签仅是工程代理；关注先暂升、后有氧的交错，不规定曲线必然翻转。
依据编号：R16, R04。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`5d746fcf9ff6e0e189748498b3128b0edc446fe8a048d36ad069ef920e9032ce`。
历史 comparator（非执行配置，可能过时）：保留后段活动，仅去除第一段正肝糖代理。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"exercise","ids":["activity-1","plan-activity-1"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T04:20:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "complete",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-17 12:15 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-17 12:20 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 10 | 2026-10-17 12:30 | event / plan-meal-0 | {"id":"plan-meal-0","type":"record","at_minute":10,"category":"meal","text":"Current intention: meal around 13:05, estimated 59 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 45 | 2026-10-17 13:05 | event / meal-0 | {"id":"meal-0","type":"meal","at_minute":45,"grams":59,"announced_grams":59,"absorption_minutes":60} |
| 90 | 2026-10-17 13:50 | event / plan-activity-0 | {"id":"plan-activity-0","type":"record","at_minute":90,"category":"exercise","text":"Person intends anaerobic activity around 14:30 for about 35 minutes; moderate effort. Timing may change."} |
| 130 | 2026-10-17 14:30 | event / activity-0 | {"id":"activity-0","type":"exercise","at_minute":130,"duration_minutes":35,"accelerometer_counts":0,"announced":true,"kind":"anaerobic","hepatic_delta_mg_dl_per_min":0.45} |
| 145 | 2026-10-17 14:45 | event / plan-activity-1 | {"id":"plan-activity-1","type":"record","at_minute":145,"category":"exercise","text":"Person intends aerobic activity around 15:25 for about 60 minutes; moderate effort. Timing may change."} |
| 165 | 2026-10-17 15:05 | boundary / activity-0:end | Configured interval ends; residual food/drug/state can remain. |
| 185 | 2026-10-17 15:25 | event / activity-1 | {"id":"activity-1","type":"exercise","at_minute":185,"duration_minutes":60,"accelerometer_counts":2095,"announced":true,"kind":"aerobic","hepatic_delta_mg_dl_per_min":0} |
| 245 | 2026-10-17 16:25 | boundary / activity-1:end | Configured interval ends; residual food/drug/state can remain. |
| 255 | 2026-10-17 16:35 | event / plan-meal-1 | {"id":"plan-meal-1","type":"record","at_minute":255,"category":"meal","text":"Current intention: meal around 17:10, estimated 67 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 290 | 2026-10-17 17:10 | event / meal-1 | {"id":"meal-1","type":"meal","at_minute":290,"grams":67,"announced_grams":67,"absorption_minutes":60} |
| 575 | 2026-10-17 21:55 | event / plan-meal-2 | {"id":"plan-meal-2","type":"record","at_minute":575,"category":"meal","text":"Current intention: meal around 22:30, estimated 55 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 610 | 2026-10-17 22:30 | event / meal-2 | {"id":"meal-2","type":"meal","at_minute":610,"grams":55,"announced_grams":55,"absorption_minutes":60} |
| 620 | 2026-10-17 22:40 | event / plan-activity-2 | {"id":"plan-activity-2","type":"record","at_minute":620,"category":"exercise","text":"Person intends aerobic activity around 23:20 for about 60 minutes; moderate effort. Timing may change."} |
| 660 | 2026-10-17 23:20 | event / activity-2 | {"id":"activity-2","type":"exercise","at_minute":660,"duration_minutes":60,"accelerometer_counts":2095,"announced":true,"kind":"aerobic","hepatic_delta_mg_dl_per_min":0} |
| 720 | 2026-10-18 00:20 | boundary / activity-2:end | Configured interval ends; residual food/drug/state can remain. |
| 1155 | 2026-10-18 07:35 | event / plan-meal-3 | {"id":"plan-meal-3","type":"record","at_minute":1155,"category":"meal","text":"Current intention: meal around 08:10, estimated 59 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1190 | 2026-10-18 08:10 | event / meal-3 | {"id":"meal-3","type":"meal","at_minute":1190,"grams":59,"announced_grams":59,"absorption_minutes":60} |
| 1440 | 2026-10-18 12:20 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-c03"></a>
## V4R3-C03 晚间活动和饮酒后的延迟作用

主族：C。来源：V4R2-C03；legacy24：C03。
设计意图（冻结原文）：原 V4R2 物理配置不变。 不能在活动停止或当前稳定后忘记后续外源扰动。
依据编号：R05, R15。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`ac1d5c11ea3e3cc8ddc9edf8e67bd8a95863779ad2978b00148b5663a058cdb5`。
历史 comparator（非执行配置，可能过时）：同摄入和活动，无饮酒延迟肝糖代理。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"life","ids":["alcohol-540"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T03:55:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "complete",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-17 11:50 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-17 11:55 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 10 | 2026-10-17 12:05 | event / plan-meal-0 | {"id":"plan-meal-0","type":"record","at_minute":10,"category":"meal","text":"Current intention: meal around 12:40, estimated 70 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 45 | 2026-10-17 12:40 | event / meal-0 | {"id":"meal-0","type":"meal","at_minute":45,"grams":70,"announced_grams":70,"absorption_minutes":60} |
| 260 | 2026-10-17 16:15 | event / plan-activity-0 | {"id":"plan-activity-0","type":"record","at_minute":260,"category":"exercise","text":"Person intends aerobic activity around 16:55 for about 60 minutes; moderate effort. Timing may change."} |
| 300 | 2026-10-17 16:55 | event / activity-0 | {"id":"activity-0","type":"exercise","at_minute":300,"duration_minutes":60,"accelerometer_counts":2095,"announced":true,"kind":"aerobic","hepatic_delta_mg_dl_per_min":0} |
| 345 | 2026-10-17 17:40 | event / plan-meal-1 | {"id":"plan-meal-1","type":"record","at_minute":345,"category":"meal","text":"Current intention: meal around 18:15, estimated 85 g carbohydrate; mixed meal reported high in fat/protein. Timing and actual intake may change; this is not a future glucose prediction."} |
| 360 | 2026-10-17 17:55 | boundary / activity-0:end | Configured interval ends; residual food/drug/state can remain. |
| 380 | 2026-10-17 18:15 | event / meal-1 | {"id":"meal-1","type":"meal","at_minute":380,"grams":85,"announced_grams":85,"absorption_minutes":140} |
| 540 | 2026-10-17 20:55 | event / alcohol-540 | {"id":"alcohol-540","type":"alcohol","at_minute":540,"onset_hours":5,"duration_hours":9,"hepatic_delta_mg_dl_per_min":-0.25,"announced":true} |
| 615 | 2026-10-17 22:10 | event / plan-meal-2 | {"id":"plan-meal-2","type":"record","at_minute":615,"category":"meal","text":"Current intention: meal around 22:45, estimated 30 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 650 | 2026-10-17 22:45 | event / meal-2 | {"id":"meal-2","type":"meal","at_minute":650,"grams":30,"announced_grams":30,"absorption_minutes":60} |
| 840 | 2026-10-18 01:55 | boundary / alcohol-540:onset | Configured delayed hepatic proxy begins; not a measurement. |
| 1155 | 2026-10-18 07:10 | event / plan-meal-3 | {"id":"plan-meal-3","type":"record","at_minute":1155,"category":"meal","text":"Current intention: meal around 07:45, estimated 55 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1190 | 2026-10-18 07:45 | event / meal-3 | {"id":"meal-3","type":"meal","at_minute":1190,"grams":55,"announced_grams":55,"absorption_minutes":60} |
| 1380 | 2026-10-18 10:55 | boundary / alcohol-540:end | Configured delayed proxy ends; prior state is not reset. |
| 1440 | 2026-10-18 11:55 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-c04"></a>
## V4R3-C04 夜间慢餐后次晨连续两次活动

主族：C。来源：V4R2-C04；legacy24：C04。
设计意图（冻结原文）：原 V4R2 物理配置不变。 前一天输入和活动状态进入次晨，保持原题尾部难度。
依据编号：R14, R17。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`364518c5471777a57d65da72cd185c1bb80924d6e94a6317ebf4fb0faf9954ca`。
历史 comparator（非执行配置，可能过时）：同背景去掉后一次活动，不清空此前运动状态。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"exercise","ids":["activity-1","plan-activity-1"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T03:45:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "complete",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-17 11:40 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-17 11:45 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 10 | 2026-10-17 11:55 | event / plan-meal-0 | {"id":"plan-meal-0","type":"record","at_minute":10,"category":"meal","text":"Current intention: meal around 12:30, estimated 58 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 45 | 2026-10-17 12:30 | event / meal-0 | {"id":"meal-0","type":"meal","at_minute":45,"grams":58,"announced_grams":58,"absorption_minutes":60} |
| 325 | 2026-10-17 17:10 | event / plan-activity-0 | {"id":"plan-activity-0","type":"record","at_minute":325,"category":"exercise","text":"Person intends aerobic activity around 17:50 for about 60 minutes; moderate effort. Timing may change."} |
| 365 | 2026-10-17 17:50 | event / activity-0 | {"id":"activity-0","type":"exercise","at_minute":365,"duration_minutes":60,"accelerometer_counts":2095,"announced":true,"kind":"aerobic","hepatic_delta_mg_dl_per_min":0} |
| 425 | 2026-10-17 18:50 | boundary / activity-0:end | Configured interval ends; residual food/drug/state can remain. |
| 445 | 2026-10-17 19:10 | event / plan-meal-1 | {"id":"plan-meal-1","type":"record","at_minute":445,"category":"meal","text":"Current intention: meal around 19:45, estimated 80 g carbohydrate; mixed meal reported high in fat/protein. Timing and actual intake may change; this is not a future glucose prediction."} |
| 480 | 2026-10-17 19:45 | event / meal-1 | {"id":"meal-1","type":"meal","at_minute":480,"grams":80,"announced_grams":80,"absorption_minutes":140} |
| 765 | 2026-10-18 00:30 | event / plan-meal-2 | {"id":"plan-meal-2","type":"record","at_minute":765,"category":"meal","text":"Current intention: meal around 01:05, estimated 36 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 800 | 2026-10-18 01:05 | event / meal-2 | {"id":"meal-2","type":"meal","at_minute":800,"grams":36,"announced_grams":36,"absorption_minutes":60} |
| 1050 | 2026-10-18 05:15 | event / plan-activity-1 | {"id":"plan-activity-1","type":"record","at_minute":1050,"category":"exercise","text":"Person intends aerobic activity around 05:55 for about 60 minutes; moderate effort. Timing may change."} |
| 1090 | 2026-10-18 05:55 | event / activity-1 | {"id":"activity-1","type":"exercise","at_minute":1090,"duration_minutes":60,"accelerometer_counts":2095,"announced":true,"kind":"aerobic","hepatic_delta_mg_dl_per_min":0} |
| 1135 | 2026-10-18 06:40 | event / plan-meal-3 | {"id":"plan-meal-3","type":"record","at_minute":1135,"category":"meal","text":"Current intention: meal around 07:15, estimated 67 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1150 | 2026-10-18 06:55 | boundary / activity-1:end | Configured interval ends; residual food/drug/state can remain. |
| 1170 | 2026-10-18 07:15 | event / meal-3 | {"id":"meal-3","type":"meal","at_minute":1170,"grams":67,"announced_grams":67,"absorption_minutes":60} |
| 1200 | 2026-10-18 07:45 | event / plan-activity-2 | {"id":"plan-activity-2","type":"record","at_minute":1200,"category":"exercise","text":"Person intends aerobic activity around 08:25 for about 60 minutes; moderate effort. Timing may change."} |
| 1240 | 2026-10-18 08:25 | event / activity-2 | {"id":"activity-2","type":"exercise","at_minute":1240,"duration_minutes":60,"accelerometer_counts":2095,"announced":true,"kind":"aerobic","hepatic_delta_mg_dl_per_min":0} |
| 1300 | 2026-10-18 09:25 | boundary / activity-2:end | Configured interval ends; residual food/drug/state can remain. |
| 1440 | 2026-10-18 11:45 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-d01"></a>
## V4R3-D01 两次短时应激消退后分别接活动

主族：D。来源：V4R2-D01；legacy24：D03。
设计意图（冻结原文）：保留原 D03 的两段肝糖代理、四餐与活动，不降低其难度。 关注暂时扰动消退以及当时仍在作用的输入。
依据编号：R07, R04。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`34d243819f857882c8d1cb1c2ce8bc0c76ef8724d0b20b8f01e224346e22c67a`。
历史 comparator（非执行配置，可能过时）：分别去掉一段应激，固定餐食和运动；保留另一段作为背景。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"life","ids":["stress-end-0","stress-end-600"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T03:35:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "complete",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-17 11:30 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-17 11:35 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 0 | 2026-10-17 11:35 | event / stress-0 | {"id":"stress-0","type":"stress","at_minute":0,"duration_minutes":150,"hepatic_delta_mg_dl_per_min":0.3} |
| 10 | 2026-10-17 11:45 | event / plan-meal-0 | {"id":"plan-meal-0","type":"record","at_minute":10,"category":"meal","text":"Current intention: meal around 12:20, estimated 71 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 45 | 2026-10-17 12:20 | event / meal-0 | {"id":"meal-0","type":"meal","at_minute":45,"grams":71,"announced_grams":71,"absorption_minutes":60} |
| 140 | 2026-10-17 13:55 | event / plan-activity-0 | {"id":"plan-activity-0","type":"record","at_minute":140,"category":"exercise","text":"Person intends aerobic activity around 14:35 for about 60 minutes; moderate effort. Timing may change."} |
| 150 | 2026-10-17 14:05 | boundary / stress-0:end | Configured interval ends; residual food/drug/state can remain. |
| 150 | 2026-10-17 14:05 | event / stress-end-0 | {"id":"stress-end-0","type":"record","at_minute":150,"category":"life","text":"The stressful activity has ended; person reports feeling calmer. Previously delivered insulin remains active."} |
| 180 | 2026-10-17 14:35 | event / activity-0 | {"id":"activity-0","type":"exercise","at_minute":180,"duration_minutes":60,"accelerometer_counts":2095,"announced":true,"kind":"aerobic","hepatic_delta_mg_dl_per_min":0} |
| 240 | 2026-10-17 15:35 | boundary / activity-0:end | Configured interval ends; residual food/drug/state can remain. |
| 265 | 2026-10-17 16:00 | event / plan-meal-1 | {"id":"plan-meal-1","type":"record","at_minute":265,"category":"meal","text":"Current intention: meal around 16:35, estimated 51 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 300 | 2026-10-17 16:35 | event / meal-1 | {"id":"meal-1","type":"meal","at_minute":300,"grams":51,"announced_grams":51,"absorption_minutes":60} |
| 600 | 2026-10-17 21:35 | event / stress-600 | {"id":"stress-600","type":"stress","at_minute":600,"duration_minutes":120,"hepatic_delta_mg_dl_per_min":0.3} |
| 615 | 2026-10-17 21:50 | event / plan-meal-2 | {"id":"plan-meal-2","type":"record","at_minute":615,"category":"meal","text":"Current intention: meal around 22:25, estimated 63 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 650 | 2026-10-17 22:25 | event / meal-2 | {"id":"meal-2","type":"meal","at_minute":650,"grams":63,"announced_grams":63,"absorption_minutes":60} |
| 720 | 2026-10-17 23:35 | event / plan-activity-1 | {"id":"plan-activity-1","type":"record","at_minute":720,"category":"exercise","text":"Person intends aerobic activity around 00:15 for about 60 minutes; moderate effort. Timing may change."} |
| 720 | 2026-10-17 23:35 | boundary / stress-600:end | Configured interval ends; residual food/drug/state can remain. |
| 720 | 2026-10-17 23:35 | event / stress-end-600 | {"id":"stress-end-600","type":"record","at_minute":720,"category":"life","text":"The stressful activity has ended; person reports feeling calmer. Previously delivered insulin remains active."} |
| 760 | 2026-10-18 00:15 | event / activity-1 | {"id":"activity-1","type":"exercise","at_minute":760,"duration_minutes":60,"accelerometer_counts":2095,"announced":true,"kind":"aerobic","hepatic_delta_mg_dl_per_min":0} |
| 820 | 2026-10-18 01:15 | boundary / activity-1:end | Configured interval ends; residual food/drug/state can remain. |
| 1155 | 2026-10-18 06:50 | event / plan-meal-3 | {"id":"plan-meal-3","type":"record","at_minute":1155,"category":"meal","text":"Current intention: meal around 07:25, estimated 55 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1190 | 2026-10-18 07:25 | event / meal-3 | {"id":"meal-3","type":"meal","at_minute":1190,"grams":55,"announced_grams":55,"absorption_minutes":60} |
| 1440 | 2026-10-18 11:35 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-d02"></a>
## V4R3-D02 缺觉与黎明叠加后的需求恢复

主族：D。来源：V4R2-D02；legacy24：D04。
设计意图（冻结原文）：保留原 D04 的缺觉、黎明、四餐与后续活动。 需要跨过需求变化的进入和退出，而非全天固定强化。
依据编号：R06, R03。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`720f996df6f1c58a0c99504754c917635f3aca130ab7e9e402348e595bd3ad74`。
历史 comparator（非执行配置，可能过时）：同日程去掉缺觉或黎明中的一个，分开做机制对照。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"life"}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T03:45:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0.3
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "complete",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-17 11:40 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-17 11:45 | event / sleep | {"id":"sleep","type":"sleep_loss","at_minute":0,"duration_minutes":1080,"sensitivity_decrease":0.2,"announced":true} |
| 0 | 2026-10-17 11:45 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 10 | 2026-10-17 11:55 | event / plan-meal-0 | {"id":"plan-meal-0","type":"record","at_minute":10,"category":"meal","text":"Current intention: meal around 12:30, estimated 59 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 45 | 2026-10-17 12:30 | event / meal-0 | {"id":"meal-0","type":"meal","at_minute":45,"grams":59,"announced_grams":59,"absorption_minutes":60} |
| 365 | 2026-10-17 17:50 | event / plan-meal-1 | {"id":"plan-meal-1","type":"record","at_minute":365,"category":"meal","text":"Current intention: meal around 18:25, estimated 63 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 400 | 2026-10-17 18:25 | event / meal-1 | {"id":"meal-1","type":"meal","at_minute":400,"grams":63,"announced_grams":63,"absorption_minutes":60} |
| 705 | 2026-10-17 23:30 | event / plan-meal-2 | {"id":"plan-meal-2","type":"record","at_minute":705,"category":"meal","text":"Current intention: meal around 00:05, estimated 42 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 740 | 2026-10-18 00:05 | event / meal-2 | {"id":"meal-2","type":"meal","at_minute":740,"grams":42,"announced_grams":42,"absorption_minutes":60} |
| 1080 | 2026-10-18 05:45 | boundary / sleep:end | Configured interval ends; residual food/drug/state can remain. |
| 1095 | 2026-10-18 06:00 | event / plan-meal-3 | {"id":"plan-meal-3","type":"record","at_minute":1095,"category":"meal","text":"Current intention: meal around 06:35, estimated 76 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1130 | 2026-10-18 06:35 | event / meal-3 | {"id":"meal-3","type":"meal","at_minute":1130,"grams":76,"announced_grams":76,"absorption_minutes":60} |
| 1180 | 2026-10-18 07:25 | event / plan-activity-0 | {"id":"plan-activity-0","type":"record","at_minute":1180,"category":"exercise","text":"Person intends aerobic activity around 08:05 for about 60 minutes; moderate effort. Timing may change."} |
| 1220 | 2026-10-18 08:05 | event / activity-0 | {"id":"activity-0","type":"exercise","at_minute":1220,"duration_minutes":60,"accelerometer_counts":2095,"announced":true,"kind":"aerobic","hepatic_delta_mg_dl_per_min":0} |
| 1280 | 2026-10-18 09:05 | boundary / activity-0:end | Configured interval ends; residual food/drug/state can remain. |
| 1440 | 2026-10-18 11:45 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-d03"></a>
## V4R3-D03 未进食时的黎明需求进入与退出

主族：D。来源：无上一版 ID；legacy24：无。
设计意图（冻结原文）：00:00起始；03:00进入现有黎明函数、05:00—08:00较强、10:00退出。第一餐11:00，使早期需求变化不被强制餐食覆盖。不是重设基础生理参考或改变患者目标。
依据编号：R03。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`e60ec681b76d5adad6426f8147f7972c6c9155d37497215570c22aaccde71d27`。
历史 comparator（非执行配置，可能过时）：同患者、日程与种子，关闭 dawn_fraction；时钟函数参数沿现有实现，不按模型分数调幅。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"life","ids":["prior-dawn-report"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T16:00:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0.3
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "native",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-17 23:55 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-18 00:00 | event / prior-dawn-report | {"id":"prior-dawn-report","type":"record","at_minute":0,"category":"life","text":"患者报告以往清晨有反复升糖现象，不提供今日未来曲线或真实参数。"} |
| 0 | 2026-10-18 00:00 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 625 | 2026-10-18 10:25 | event / plan-meal-660 | {"id":"plan-meal-660","type":"record","at_minute":625,"category":"meal","text":"患者当前计划约11:00摄入35 g；意向不保证兑现。"} |
| 660 | 2026-10-18 11:00 | event / meal-660 | {"id":"meal-660","type":"meal","at_minute":660,"grams":35,"announced_grams":35,"absorption_minutes":60} |
| 895 | 2026-10-18 14:55 | event / plan-meal-930 | {"id":"plan-meal-930","type":"record","at_minute":895,"category":"meal","text":"患者当前计划约15:30摄入55 g；意向不保证兑现。"} |
| 930 | 2026-10-18 15:30 | event / meal-930 | {"id":"meal-930","type":"meal","at_minute":930,"grams":55,"announced_grams":55,"absorption_minutes":75} |
| 1105 | 2026-10-18 18:25 | event / plan-meal-1140 | {"id":"plan-meal-1140","type":"record","at_minute":1105,"category":"meal","text":"患者当前计划约19:00摄入50 g；意向不保证兑现。"} |
| 1140 | 2026-10-18 19:00 | event / meal-1140 | {"id":"meal-1140","type":"meal","at_minute":1140,"grams":50,"announced_grams":50,"absorption_minutes":90} |
| 1440 | 2026-10-19 00:00 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-d04"></a>
## V4R3-D04 缺觉相关需求退出后仍继续进食

主族：D。来源：无上一版 ID；legacy24：无。
设计意图（冻结原文）：06:00—18:00缺觉代理 sensitivity_decrease=0.2；07:30/12:30进食35/55 g，18:30再吃50 g。关注需求代理退出时已有治疗与随后进食，不预设 Agent 一定增加治疗。
依据编号：R06。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`b80dc3642d04eb4f95a1e7720f432860758b4758312925707037b2baeabc7c1c`。
历史 comparator（非执行配置，可能过时）：同样日程，缺觉代理持续到次晨；另设完全无该代理的背景。它们不是新增主题。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"life","ids":["rest-recovered"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T22:00:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "native",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-18 05:55 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-18 06:00 | event / sleep-loss | {"id":"sleep-loss","type":"sleep_loss","at_minute":0,"duration_minutes":720,"sensitivity_decrease":0.2,"announced":true} |
| 0 | 2026-10-18 06:00 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 55 | 2026-10-18 06:55 | event / plan-meal-90 | {"id":"plan-meal-90","type":"record","at_minute":55,"category":"meal","text":"患者当前计划约07:30摄入35 g；意向不保证兑现。"} |
| 90 | 2026-10-18 07:30 | event / meal-90 | {"id":"meal-90","type":"meal","at_minute":90,"grams":35,"announced_grams":35,"absorption_minutes":60} |
| 355 | 2026-10-18 11:55 | event / plan-meal-390 | {"id":"plan-meal-390","type":"record","at_minute":355,"category":"meal","text":"患者当前计划约12:30摄入55 g；意向不保证兑现。"} |
| 390 | 2026-10-18 12:30 | event / meal-390 | {"id":"meal-390","type":"meal","at_minute":390,"grams":55,"announced_grams":55,"absorption_minutes":75} |
| 715 | 2026-10-18 17:55 | event / plan-meal-750 | {"id":"plan-meal-750","type":"record","at_minute":715,"category":"meal","text":"患者当前计划约18:30摄入50 g；意向不保证兑现。"} |
| 720 | 2026-10-18 18:00 | event / rest-recovered | {"id":"rest-recovered","type":"record","at_minute":720,"category":"life","text":"患者此时报告休息情况改善；后续需要结合实际走势判断，不提供敏感性数值。"} |
| 720 | 2026-10-18 18:00 | boundary / sleep-loss:end | Configured interval ends; residual food/drug/state can remain. |
| 750 | 2026-10-18 18:30 | event / meal-750 | {"id":"meal-750","type":"meal","at_minute":750,"grams":50,"announced_grams":50,"absorption_minutes":90} |
| 1440 | 2026-10-19 06:00 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-d05"></a>
## V4R3-D05 慢餐后的短时应激及其消退

主族：D。来源：无上一版 ID；legacy24：无。
设计意图（冻结原文）：07:30摄入40 g、τ=150 min；08:00—10:00加入0.3 mg/dL/min的已有应激肝糖代理；14:00/18:00再进食50/45 g。10:00只结束应激项，不清空肠道和药库。
依据编号：R07, R18。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`bb5db2b993018d986ca40134b91feb9975e49b23727a3db2fc4815eabd5c6e50`。
历史 comparator（非执行配置，可能过时）：同样慢输入，无应激代理；空腹无明显效应可作额外叙述反例，但不再强造一个全信息档位重复主情景。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"life","ids":["stress-end"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T22:00:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "native",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-18 05:55 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-18 06:00 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 55 | 2026-10-18 06:55 | event / plan-meal-90 | {"id":"plan-meal-90","type":"record","at_minute":55,"category":"meal","text":"患者当前计划约07:30摄入40 g；意向不保证兑现。"} |
| 90 | 2026-10-18 07:30 | event / meal-90 | {"id":"meal-90","type":"meal","at_minute":90,"grams":40,"announced_grams":40,"absorption_minutes":150} |
| 120 | 2026-10-18 08:00 | event / stress | {"id":"stress","type":"stress","at_minute":120,"duration_minutes":120,"hepatic_delta_mg_dl_per_min":0.3} |
| 120 | 2026-10-18 08:00 | event / stress-start | {"id":"stress-start","type":"record","at_minute":120,"category":"life","text":"患者报告当前处于紧张情境，不提供实际肝糖增量。"} |
| 240 | 2026-10-18 10:00 | event / stress-end | {"id":"stress-end","type":"record","at_minute":240,"category":"life","text":"患者报告紧张情境此时结束，先前摄入和治疗不因此失效。"} |
| 240 | 2026-10-18 10:00 | boundary / stress:end | Configured interval ends; residual food/drug/state can remain. |
| 445 | 2026-10-18 13:25 | event / plan-meal-480 | {"id":"plan-meal-480","type":"record","at_minute":445,"category":"meal","text":"患者当前计划约14:00摄入50 g；意向不保证兑现。"} |
| 480 | 2026-10-18 14:00 | event / meal-480 | {"id":"meal-480","type":"meal","at_minute":480,"grams":50,"announced_grams":50,"absorption_minutes":75} |
| 685 | 2026-10-18 17:25 | event / plan-meal-720 | {"id":"plan-meal-720","type":"record","at_minute":685,"category":"meal","text":"患者当前计划约18:00摄入45 g；意向不保证兑现。"} |
| 720 | 2026-10-18 18:00 | event / meal-720 | {"id":"meal-720","type":"meal","at_minute":720,"grams":45,"announced_grams":45,"absorption_minutes":90} |
| 1440 | 2026-10-19 06:00 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-d06"></a>
## V4R3-D06 无运动背景下的饮酒延迟肝糖扰动

主族：D。来源：无上一版 ID；legacy24：无。
设计意图（冻结原文）：12:00至次日12:00；13:00/18:00/次日07:30摄入35/55/50 g。19:00饮酒记录，5小时后即午夜开始-0.25 mg/dL/min肝糖代理，持续8小时，之后仍观察4小时。当天不加运动以区别于 C03。
依据编号：R15。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`dcd5919903495aeac9a33b855334dddfad4bf8e7a51d65273b0d6e1476a35969`。
历史 comparator（非执行配置，可能过时）：同摄入和作息，无该延迟负向肝糖代理。不模拟乙醇浓度、糖原或胰高血糖素。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"life","ids":["alcohol"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-18T04:00:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "native",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-18 11:55 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-18 12:00 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 25 | 2026-10-18 12:25 | event / plan-meal-60 | {"id":"plan-meal-60","type":"record","at_minute":25,"category":"meal","text":"患者当前计划约13:00摄入35 g；意向不保证兑现。"} |
| 60 | 2026-10-18 13:00 | event / meal-60 | {"id":"meal-60","type":"meal","at_minute":60,"grams":35,"announced_grams":35,"absorption_minutes":60} |
| 325 | 2026-10-18 17:25 | event / plan-meal-360 | {"id":"plan-meal-360","type":"record","at_minute":325,"category":"meal","text":"患者当前计划约18:00摄入55 g；意向不保证兑现。"} |
| 360 | 2026-10-18 18:00 | event / meal-360 | {"id":"meal-360","type":"meal","at_minute":360,"grams":55,"announced_grams":55,"absorption_minutes":75} |
| 420 | 2026-10-18 19:00 | event / alcohol | {"id":"alcohol","type":"alcohol","at_minute":420,"onset_hours":5,"duration_hours":8,"hepatic_delta_mg_dl_per_min":-0.25,"announced":true} |
| 720 | 2026-10-19 00:00 | boundary / alcohol:onset | Configured delayed hepatic proxy begins; not a measurement. |
| 1135 | 2026-10-19 06:55 | event / plan-meal-1170 | {"id":"plan-meal-1170","type":"record","at_minute":1135,"category":"meal","text":"患者当前计划约07:30摄入50 g；意向不保证兑现。"} |
| 1170 | 2026-10-19 07:30 | event / meal-1170 | {"id":"meal-1170","type":"meal","at_minute":1170,"grams":50,"announced_grams":50,"absorption_minutes":90} |
| 1200 | 2026-10-19 08:00 | boundary / alcohol:end | Configured delayed proxy ends; prior state is not reset. |
| 1440 | 2026-10-19 12:00 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-e01"></a>
## V4R3-E01 静默送达不足叠加多餐

主族：E。来源：V4R2-E01；legacy24：E01。
设计意图（冻结原文）：原 V4R2 物理配置不变。 保留原多餐压力，不把故障诊断简化为孤立无餐高糖。
依据编号：R19, R09, R20。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`20edfe4d1c283eba91ab97d8e3f208ec1cd14becde6b68686269fe6f571c122c`。
历史 comparator（非执行配置，可能过时）：同命令和日程，正常送达。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"meal","ids":["meal-0","plan-meal-0"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T04:10:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "complete",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-17 12:05 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-17 12:10 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 10 | 2026-10-17 12:20 | event / plan-meal-0 | {"id":"plan-meal-0","type":"record","at_minute":10,"category":"meal","text":"Current intention: meal around 12:55, estimated 54 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 25 | 2026-10-17 12:35 | event / leak-25 | {"id":"leak-25","type":"infusion_deficit","at_minute":25,"duration_minutes":900,"delivered_fraction":0.1} |
| 25 | 2026-10-17 12:35 | event / leak-report-25 | {"id":"leak-report-25","type":"record","at_minute":25,"category":"fault","text":"Person notices wet adhesive or a loose infusion cannula. Pump display can still appear running; inspect the infusion site. Exact delivered fraction is unknown."} |
| 45 | 2026-10-17 12:55 | event / meal-0 | {"id":"meal-0","type":"meal","at_minute":45,"grams":54,"announced_grams":54,"absorption_minutes":60} |
| 265 | 2026-10-17 16:35 | event / plan-meal-1 | {"id":"plan-meal-1","type":"record","at_minute":265,"category":"meal","text":"Current intention: meal around 17:10, estimated 54 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 300 | 2026-10-17 17:10 | event / meal-1 | {"id":"meal-1","type":"meal","at_minute":300,"grams":54,"announced_grams":54,"absorption_minutes":60} |
| 545 | 2026-10-17 21:15 | event / plan-meal-2 | {"id":"plan-meal-2","type":"record","at_minute":545,"category":"meal","text":"Current intention: meal around 21:50, estimated 47 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 580 | 2026-10-17 21:50 | event / meal-2 | {"id":"meal-2","type":"meal","at_minute":580,"grams":47,"announced_grams":47,"absorption_minutes":60} |
| 905 | 2026-10-18 03:15 | event / plan-meal-3 | {"id":"plan-meal-3","type":"record","at_minute":905,"category":"meal","text":"Current intention: meal around 03:50, estimated 41 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 925 | 2026-10-18 03:35 | boundary / leak-25:end | Configured interval ends; residual food/drug/state can remain. |
| 940 | 2026-10-18 03:50 | event / meal-3 | {"id":"meal-3","type":"meal","at_minute":940,"grams":41,"announced_grams":41,"absorption_minutes":60} |
| 1175 | 2026-10-18 07:45 | event / plan-meal-4 | {"id":"plan-meal-4","type":"record","at_minute":1175,"category":"meal","text":"Current intention: meal around 08:20, estimated 44 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1210 | 2026-10-18 08:20 | event / meal-4 | {"id":"meal-4","type":"meal","at_minute":1210,"grams":44,"announced_grams":44,"absorption_minutes":60} |
| 1440 | 2026-10-18 12:10 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-e02"></a>
## V4R3-E02 三次间歇送达不足和不规则进食

主族：E。来源：V4R2-E02；legacy24：E02。
设计意图（冻结原文）：原 V4R2 物理配置不变。 恢复一次不代表以后都正常，需持续更新。
依据编号：R19, R09。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`ee84e3f9b043d8dc82187376e67fb5996e1c8cbb5c7b59e6a5479514d69ae22e`。
历史 comparator（非执行配置，可能过时）：同输入日程、全程正常送达；如比较持续故障须另注册。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"fault","ids":["leak-report-400","leak-report-780"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T04:30:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "complete",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-17 12:25 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-17 12:30 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 10 | 2026-10-17 12:40 | event / plan-meal-0 | {"id":"plan-meal-0","type":"record","at_minute":10,"category":"meal","text":"Current intention: meal around 13:15, estimated 51 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 25 | 2026-10-17 12:55 | event / leak-25 | {"id":"leak-25","type":"infusion_deficit","at_minute":25,"duration_minutes":230,"delivered_fraction":0.1} |
| 25 | 2026-10-17 12:55 | event / leak-report-25 | {"id":"leak-report-25","type":"record","at_minute":25,"category":"fault","text":"Person notices wet adhesive or a loose infusion cannula. Pump display can still appear running; inspect the infusion site. Exact delivered fraction is unknown."} |
| 45 | 2026-10-17 13:15 | event / meal-0 | {"id":"meal-0","type":"meal","at_minute":45,"grams":51,"announced_grams":51,"absorption_minutes":60} |
| 245 | 2026-10-17 16:35 | event / plan-meal-1 | {"id":"plan-meal-1","type":"record","at_minute":245,"category":"meal","text":"Current intention: meal around 17:10, estimated 44 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 255 | 2026-10-17 16:45 | boundary / leak-25:end | Configured interval ends; residual food/drug/state can remain. |
| 280 | 2026-10-17 17:10 | event / meal-1 | {"id":"meal-1","type":"meal","at_minute":280,"grams":44,"announced_grams":44,"absorption_minutes":60} |
| 400 | 2026-10-17 19:10 | event / leak-400 | {"id":"leak-400","type":"infusion_deficit","at_minute":400,"duration_minutes":230,"delivered_fraction":0.2} |
| 400 | 2026-10-17 19:10 | event / leak-report-400 | {"id":"leak-report-400","type":"record","at_minute":400,"category":"fault","text":"Person notices wet adhesive or a loose infusion cannula. Pump display can still appear running; inspect the infusion site. Exact delivered fraction is unknown."} |
| 405 | 2026-10-17 19:15 | event / plan-meal-2 | {"id":"plan-meal-2","type":"record","at_minute":405,"category":"meal","text":"Current intention: meal around 19:50, estimated 51 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 440 | 2026-10-17 19:50 | event / meal-2 | {"id":"meal-2","type":"meal","at_minute":440,"grams":51,"announced_grams":51,"absorption_minutes":60} |
| 630 | 2026-10-17 23:00 | boundary / leak-400:end | Configured interval ends; residual food/drug/state can remain. |
| 780 | 2026-10-18 01:30 | event / leak-780 | {"id":"leak-780","type":"infusion_deficit","at_minute":780,"duration_minutes":240,"delivered_fraction":0.1} |
| 780 | 2026-10-18 01:30 | event / leak-report-780 | {"id":"leak-report-780","type":"record","at_minute":780,"category":"fault","text":"Person notices wet adhesive or a loose infusion cannula. Pump display can still appear running; inspect the infusion site. Exact delivered fraction is unknown."} |
| 785 | 2026-10-18 01:35 | event / plan-meal-3 | {"id":"plan-meal-3","type":"record","at_minute":785,"category":"meal","text":"Current intention: meal around 02:10, estimated 51 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 820 | 2026-10-18 02:10 | event / meal-3 | {"id":"meal-3","type":"meal","at_minute":820,"grams":51,"announced_grams":51,"absorption_minutes":60} |
| 1020 | 2026-10-18 05:30 | boundary / leak-780:end | Configured interval ends; residual food/drug/state can remain. |
| 1155 | 2026-10-18 07:45 | event / plan-meal-4 | {"id":"plan-meal-4","type":"record","at_minute":1155,"category":"meal","text":"Current intention: meal around 08:20, estimated 44 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1190 | 2026-10-18 08:20 | event / meal-4 | {"id":"meal-4","type":"meal","at_minute":1190,"grams":44,"announced_grams":44,"absorption_minutes":60} |
| 1440 | 2026-10-18 12:30 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-e03"></a>
## V4R3-E03 送达恢复后慢餐与活动交错

主族：E。来源：V4R2-E03；legacy24：E03。
设计意图（冻结原文）：原 V4R2 物理配置不变。 修复前后药物、肠道和运动状态连续。
依据编号：R19, R14, R04。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`e6206066e6417348885474521e9a112dffd6961e8609e3756ac8ddf331cd06db`。
历史 comparator（非执行配置，可能过时）：同故障前史，在注册时点不修复；若 Agent 主动修复，仍按工具效果处理。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"fault","ids":["leak-report-25"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T03:55:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "complete",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-17 11:50 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-17 11:55 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 10 | 2026-10-17 12:05 | event / plan-meal-0 | {"id":"plan-meal-0","type":"record","at_minute":10,"category":"meal","text":"Current intention: meal around 12:40, estimated 65 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 25 | 2026-10-17 12:20 | event / leak-25 | {"id":"leak-25","type":"infusion_deficit","at_minute":25,"duration_minutes":300,"delivered_fraction":0.15} |
| 25 | 2026-10-17 12:20 | event / leak-report-25 | {"id":"leak-report-25","type":"record","at_minute":25,"category":"fault","text":"Person notices wet adhesive or a loose infusion cannula. Pump display can still appear running; inspect the infusion site. Exact delivered fraction is unknown."} |
| 45 | 2026-10-17 12:40 | event / meal-0 | {"id":"meal-0","type":"meal","at_minute":45,"grams":65,"announced_grams":65,"absorption_minutes":60} |
| 215 | 2026-10-17 15:30 | event / plan-meal-1 | {"id":"plan-meal-1","type":"record","at_minute":215,"category":"meal","text":"Current intention: meal around 16:05, estimated 65 g carbohydrate; mixed meal reported high in fat/protein. Timing and actual intake may change; this is not a future glucose prediction."} |
| 250 | 2026-10-17 16:05 | event / meal-1 | {"id":"meal-1","type":"meal","at_minute":250,"grams":65,"announced_grams":65,"absorption_minutes":150} |
| 325 | 2026-10-17 17:20 | boundary / leak-25:end | Configured interval ends; residual food/drug/state can remain. |
| 325 | 2026-10-17 17:20 | event / repair | {"id":"repair","type":"infusion_recovery","at_minute":325} |
| 325 | 2026-10-17 17:20 | event / repair-report | {"id":"repair-report","type":"record","at_minute":325,"category":"fault","text":"Infusion site problem was corrected. Review active insulin and food before further dosing."} |
| 340 | 2026-10-17 17:35 | event / plan-activity-0 | {"id":"plan-activity-0","type":"record","at_minute":340,"category":"exercise","text":"Person intends aerobic activity around 18:15 for about 60 minutes; moderate effort. Timing may change."} |
| 380 | 2026-10-17 18:15 | event / activity-0 | {"id":"activity-0","type":"exercise","at_minute":380,"duration_minutes":60,"accelerometer_counts":2095,"announced":true,"kind":"aerobic","hepatic_delta_mg_dl_per_min":0} |
| 440 | 2026-10-17 19:15 | boundary / activity-0:end | Configured interval ends; residual food/drug/state can remain. |
| 565 | 2026-10-17 21:20 | event / plan-meal-2 | {"id":"plan-meal-2","type":"record","at_minute":565,"category":"meal","text":"Current intention: meal around 21:55, estimated 53 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 600 | 2026-10-17 21:55 | event / meal-2 | {"id":"meal-2","type":"meal","at_minute":600,"grams":53,"announced_grams":53,"absorption_minutes":60} |
| 1155 | 2026-10-18 07:10 | event / plan-meal-3 | {"id":"plan-meal-3","type":"record","at_minute":1155,"category":"meal","text":"Current intention: meal around 07:45, estimated 57 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1190 | 2026-10-18 07:45 | event / meal-3 | {"id":"meal-3","type":"meal","at_minute":1190,"grams":57,"announced_grams":57,"absorption_minutes":60} |
| 1440 | 2026-10-18 11:55 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-e04"></a>
## V4R3-E04 静默送达不足叠加渐进伪高

主族：E。来源：V4R2-E04；legacy24：E04。
设计意图（冻结原文）：原 V4R2 物理配置不变。 同一读数同时受真实生理与测量影响。
依据编号：R19, R22。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`37727f5ab5dc2afdbdcf9646550ee9086dcb54357c48d1c3e2f60fb8202adc85`。
历史 comparator（非执行配置，可能过时）：2×2 消融：无异常、仅送达不足、仅漂移、两者并存。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"fault","ids":["leak-report-25"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T04:10:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "complete",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-17 12:05 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-17 12:10 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 10 | 2026-10-17 12:20 | event / plan-meal-0 | {"id":"plan-meal-0","type":"record","at_minute":10,"category":"meal","text":"Current intention: meal around 12:55, estimated 67 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 25 | 2026-10-17 12:35 | event / leak-25 | {"id":"leak-25","type":"infusion_deficit","at_minute":25,"duration_minutes":700,"delivered_fraction":0.15} |
| 25 | 2026-10-17 12:35 | event / leak-report-25 | {"id":"leak-report-25","type":"record","at_minute":25,"category":"fault","text":"Person notices wet adhesive or a loose infusion cannula. Pump display can still appear running; inspect the infusion site. Exact delivered fraction is unknown."} |
| 45 | 2026-10-17 12:55 | event / meal-0 | {"id":"meal-0","type":"meal","at_minute":45,"grams":67,"announced_grams":67,"absorption_minutes":60} |
| 75 | 2026-10-17 13:25 | event / drift-75 | {"id":"drift-75","type":"sensor_drift","at_minute":75,"duration_minutes":480,"bias_mg_dl":65,"ramp_minutes":90} |
| 75 | 2026-10-17 13:25 | event / sensor-report-75 | {"id":"sensor-report-75","type":"record","at_minute":75,"category":"fault","text":"Person reports a sensor-site problem or possible interference. Sensor values may not reflect blood glucose; an independent meter is available. Direction and magnitude are not supplied."} |
| 265 | 2026-10-17 16:35 | event / plan-meal-1 | {"id":"plan-meal-1","type":"record","at_minute":265,"category":"meal","text":"Current intention: meal around 17:10, estimated 63 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 300 | 2026-10-17 17:10 | event / meal-1 | {"id":"meal-1","type":"meal","at_minute":300,"grams":63,"announced_grams":63,"absorption_minutes":60} |
| 555 | 2026-10-17 21:25 | boundary / drift-75:end | Configured interval ends; residual food/drug/state can remain. |
| 615 | 2026-10-17 22:25 | event / plan-meal-2 | {"id":"plan-meal-2","type":"record","at_minute":615,"category":"meal","text":"Current intention: meal around 23:00, estimated 59 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 650 | 2026-10-17 23:00 | event / meal-2 | {"id":"meal-2","type":"meal","at_minute":650,"grams":59,"announced_grams":59,"absorption_minutes":60} |
| 725 | 2026-10-18 00:15 | boundary / leak-25:end | Configured interval ends; residual food/drug/state can remain. |
| 1155 | 2026-10-18 07:25 | event / plan-meal-3 | {"id":"plan-meal-3","type":"record","at_minute":1155,"category":"meal","text":"Current intention: meal around 08:00, estimated 51 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1190 | 2026-10-18 08:00 | event / meal-3 | {"id":"meal-3","type":"meal","at_minute":1190,"grams":51,"announced_grams":51,"absorption_minutes":60} |
| 1440 | 2026-10-18 12:10 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-f01"></a>
## V4R3-F01 真实活动下降叠加伪高

主族：F。来源：V4R2-F01；legacy24：F01。
设计意图（冻结原文）：原 V4R2 物理配置不变。 不能只按表面高值增加干预，也不能丢掉真实活动。
依据编号：R04, R22。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`5faf408a8d34c29478adef87a2ee092737c775f6eeba18162e98e114ed3d36fb`。
历史 comparator（非执行配置，可能过时）：相同摄入/运动，去掉漂移。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"fault"}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T03:55:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "complete",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-17 11:50 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-17 11:55 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 10 | 2026-10-17 12:05 | event / plan-meal-0 | {"id":"plan-meal-0","type":"record","at_minute":10,"category":"meal","text":"Current intention: meal around 12:40, estimated 54 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 30 | 2026-10-17 12:25 | event / drift-30 | {"id":"drift-30","type":"sensor_drift","at_minute":30,"duration_minutes":480,"bias_mg_dl":85,"ramp_minutes":90} |
| 30 | 2026-10-17 12:25 | event / sensor-report-30 | {"id":"sensor-report-30","type":"record","at_minute":30,"category":"fault","text":"Person reports a sensor-site problem or possible interference. Sensor values may not reflect blood glucose; an independent meter is available. Direction and magnitude are not supplied."} |
| 45 | 2026-10-17 12:40 | event / meal-0 | {"id":"meal-0","type":"meal","at_minute":45,"grams":54,"announced_grams":54,"absorption_minutes":60} |
| 80 | 2026-10-17 13:15 | event / plan-activity-0 | {"id":"plan-activity-0","type":"record","at_minute":80,"category":"exercise","text":"Person intends aerobic activity around 13:55 for about 60 minutes; moderate effort. Timing may change."} |
| 120 | 2026-10-17 13:55 | event / activity-0 | {"id":"activity-0","type":"exercise","at_minute":120,"duration_minutes":60,"accelerometer_counts":2095,"announced":true,"kind":"aerobic","hepatic_delta_mg_dl_per_min":0} |
| 180 | 2026-10-17 14:55 | boundary / activity-0:end | Configured interval ends; residual food/drug/state can remain. |
| 295 | 2026-10-17 16:50 | event / plan-meal-1 | {"id":"plan-meal-1","type":"record","at_minute":295,"category":"meal","text":"Current intention: meal around 17:25, estimated 64 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 330 | 2026-10-17 17:25 | event / meal-1 | {"id":"meal-1","type":"meal","at_minute":330,"grams":64,"announced_grams":64,"absorption_minutes":60} |
| 510 | 2026-10-17 20:25 | boundary / drift-30:end | Configured interval ends; residual food/drug/state can remain. |
| 665 | 2026-10-17 23:00 | event / plan-meal-2 | {"id":"plan-meal-2","type":"record","at_minute":665,"category":"meal","text":"Current intention: meal around 23:35, estimated 59 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 700 | 2026-10-17 23:35 | event / meal-2 | {"id":"meal-2","type":"meal","at_minute":700,"grams":59,"announced_grams":59,"absorption_minutes":60} |
| 800 | 2026-10-18 01:15 | event / drift-800 | {"id":"drift-800","type":"sensor_drift","at_minute":800,"duration_minutes":360,"bias_mg_dl":65,"ramp_minutes":60} |
| 800 | 2026-10-18 01:15 | event / sensor-report-800 | {"id":"sensor-report-800","type":"record","at_minute":800,"category":"fault","text":"Person reports a sensor-site problem or possible interference. Sensor values may not reflect blood glucose; an independent meter is available. Direction and magnitude are not supplied."} |
| 830 | 2026-10-18 01:45 | event / plan-activity-1 | {"id":"plan-activity-1","type":"record","at_minute":830,"category":"exercise","text":"Person intends aerobic activity around 02:25 for about 60 minutes; moderate effort. Timing may change."} |
| 870 | 2026-10-18 02:25 | event / activity-1 | {"id":"activity-1","type":"exercise","at_minute":870,"duration_minutes":60,"accelerometer_counts":2095,"announced":true,"kind":"aerobic","hepatic_delta_mg_dl_per_min":0} |
| 930 | 2026-10-18 03:25 | boundary / activity-1:end | Configured interval ends; residual food/drug/state can remain. |
| 1155 | 2026-10-18 07:10 | event / plan-meal-3 | {"id":"plan-meal-3","type":"record","at_minute":1155,"category":"meal","text":"Current intention: meal around 07:45, estimated 64 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1160 | 2026-10-18 07:15 | boundary / drift-800:end | Configured interval ends; residual food/drug/state can remain. |
| 1190 | 2026-10-18 07:45 | event / meal-3 | {"id":"meal-3","type":"meal","at_minute":1190,"grams":64,"announced_grams":64,"absorption_minutes":60} |
| 1440 | 2026-10-18 11:55 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-f02"></a>
## V4R3-F02 真实餐后输入叠加伪低

主族：F。来源：V4R2-F02；legacy24：F02。
设计意图（冻结原文）：原 V4R2 物理配置不变。 考察低读数复核及识别表面读数与真实输入并存。
依据编号：R20, R11。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`371c8f6e5cedb1c951dfd1abf178ca67b4bda331cc967a7ac259db9f6d8ba302`。
历史 comparator（非执行配置，可能过时）：同进食，无漂移/压迫；分别移除两种传感器项。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"fault"}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T04:25:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      },
      "compression_lows": [
        {
          "at_minute": 830,
          "duration_minutes": 90,
          "depth_mg_dl": 65
        }
      ]
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "complete",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-17 12:20 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-17 12:25 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 10 | 2026-10-17 12:35 | event / plan-meal-0 | {"id":"plan-meal-0","type":"record","at_minute":10,"category":"meal","text":"Current intention: meal around 13:10, estimated 60 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 30 | 2026-10-17 12:55 | event / drift-30 | {"id":"drift-30","type":"sensor_drift","at_minute":30,"duration_minutes":480,"bias_mg_dl":-80,"ramp_minutes":60} |
| 30 | 2026-10-17 12:55 | event / sensor-report-30 | {"id":"sensor-report-30","type":"record","at_minute":30,"category":"fault","text":"Person reports a sensor-site problem or possible interference. Sensor values may not reflect blood glucose; an independent meter is available. Direction and magnitude are not supplied."} |
| 45 | 2026-10-17 13:10 | event / meal-0 | {"id":"meal-0","type":"meal","at_minute":45,"grams":60,"announced_grams":60,"absorption_minutes":60} |
| 205 | 2026-10-17 15:50 | event / plan-meal-1 | {"id":"plan-meal-1","type":"record","at_minute":205,"category":"meal","text":"Current intention: meal around 16:25, estimated 41 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 240 | 2026-10-17 16:25 | event / meal-1 | {"id":"meal-1","type":"meal","at_minute":240,"grams":41,"announced_grams":41,"absorption_minutes":60} |
| 445 | 2026-10-17 19:50 | event / plan-meal-2 | {"id":"plan-meal-2","type":"record","at_minute":445,"category":"meal","text":"Current intention: meal around 20:25, estimated 51 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 480 | 2026-10-17 20:25 | event / meal-2 | {"id":"meal-2","type":"meal","at_minute":480,"grams":51,"announced_grams":51,"absorption_minutes":60} |
| 510 | 2026-10-17 20:55 | boundary / drift-30:end | Configured interval ends; residual food/drug/state can remain. |
| 815 | 2026-10-18 02:00 | event / plan-meal-3 | {"id":"plan-meal-3","type":"record","at_minute":815,"category":"meal","text":"Current intention: meal around 02:35, estimated 47 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 830 | 2026-10-18 02:15 | sensor / compression_lows:0 | {"at_minute":830,"duration_minutes":90,"depth_mg_dl":65} |
| 850 | 2026-10-18 02:35 | event / meal-3 | {"id":"meal-3","type":"meal","at_minute":850,"grams":47,"announced_grams":47,"absorption_minutes":60} |
| 920 | 2026-10-18 03:45 | boundary / compression_lows:0:end | Configured sensor interval ends. |
| 1155 | 2026-10-18 07:40 | event / plan-meal-4 | {"id":"plan-meal-4","type":"record","at_minute":1155,"category":"meal","text":"Current intention: meal around 08:15, estimated 41 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1190 | 2026-10-18 08:15 | event / meal-4 | {"id":"meal-4","type":"meal","at_minute":1190,"grams":41,"announced_grams":41,"absorption_minutes":60} |
| 1440 | 2026-10-18 12:25 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-f03"></a>
## V4R3-F03 多次进食和活动发生在断流前后

主族：F。来源：V4R2-F03；legacy24：F03。
设计意图（冻结原文）：原 V4R2 物理配置不变。 信息缺口期间身体继续演化，必须使用可用工具与恢复后的反馈。
依据编号：R20, R12。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`ea0397af6dc61a40cf5b2303627e5bb0d0b0ed84bba916f67aa30b6eddea4b31`。
历史 comparator（非执行配置，可能过时）：同真实日程，去除强制断流；I 条件不能代替物理缺口。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"meal","ids":["meal-0","plan-meal-0","meal-1","plan-meal-1"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T04:10:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      },
      "forced_gaps": [
        {
          "at_minute": 20,
          "duration_minutes": 240
        },
        {
          "at_minute": 440,
          "duration_minutes": 210
        },
        {
          "at_minute": 1050,
          "duration_minutes": 180
        }
      ]
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "complete",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-17 12:05 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-17 12:10 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 10 | 2026-10-17 12:20 | event / plan-meal-0 | {"id":"plan-meal-0","type":"record","at_minute":10,"category":"meal","text":"Current intention: meal around 12:55, estimated 49 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 20 | 2026-10-17 12:30 | sensor / forced_gaps:0 | {"at_minute":20,"duration_minutes":240} |
| 45 | 2026-10-17 12:55 | event / meal-0 | {"id":"meal-0","type":"meal","at_minute":45,"grams":49,"announced_grams":49,"absorption_minutes":60} |
| 145 | 2026-10-17 14:35 | event / plan-meal-1 | {"id":"plan-meal-1","type":"record","at_minute":145,"category":"meal","text":"Current intention: meal around 15:10, estimated 40 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 180 | 2026-10-17 15:10 | event / meal-1 | {"id":"meal-1","type":"meal","at_minute":180,"grams":40,"announced_grams":40,"absorption_minutes":60} |
| 260 | 2026-10-17 16:30 | boundary / forced_gaps:0:end | Configured sensor interval ends. |
| 260 | 2026-10-17 16:30 | event / plan-activity-0 | {"id":"plan-activity-0","type":"record","at_minute":260,"category":"exercise","text":"Person intends aerobic activity around 17:10 for about 60 minutes; moderate effort. Timing may change."} |
| 300 | 2026-10-17 17:10 | event / activity-0 | {"id":"activity-0","type":"exercise","at_minute":300,"duration_minutes":60,"accelerometer_counts":2095,"announced":true,"kind":"aerobic","hepatic_delta_mg_dl_per_min":0} |
| 360 | 2026-10-17 18:10 | boundary / activity-0:end | Configured interval ends; residual food/drug/state can remain. |
| 435 | 2026-10-17 19:25 | event / plan-meal-2 | {"id":"plan-meal-2","type":"record","at_minute":435,"category":"meal","text":"Current intention: meal around 20:00, estimated 46 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 440 | 2026-10-17 19:30 | sensor / forced_gaps:1 | {"at_minute":440,"duration_minutes":210} |
| 470 | 2026-10-17 20:00 | event / meal-2 | {"id":"meal-2","type":"meal","at_minute":470,"grams":46,"announced_grams":46,"absorption_minutes":60} |
| 565 | 2026-10-17 21:35 | event / plan-meal-3 | {"id":"plan-meal-3","type":"record","at_minute":565,"category":"meal","text":"Current intention: meal around 22:10, estimated 37 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 600 | 2026-10-17 22:10 | event / meal-3 | {"id":"meal-3","type":"meal","at_minute":600,"grams":37,"announced_grams":37,"absorption_minutes":60} |
| 650 | 2026-10-17 23:00 | boundary / forced_gaps:1:end | Configured sensor interval ends. |
| 1050 | 2026-10-18 05:40 | sensor / forced_gaps:2 | {"at_minute":1050,"duration_minutes":180} |
| 1065 | 2026-10-18 05:55 | event / plan-meal-4 | {"id":"plan-meal-4","type":"record","at_minute":1065,"category":"meal","text":"Current intention: meal around 06:30, estimated 40 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1100 | 2026-10-18 06:30 | event / meal-4 | {"id":"meal-4","type":"meal","at_minute":1100,"grams":40,"announced_grams":40,"absorption_minutes":60} |
| 1205 | 2026-10-18 08:15 | event / plan-meal-5 | {"id":"plan-meal-5","type":"record","at_minute":1205,"category":"meal","text":"Current intention: meal around 08:50, estimated 29 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1230 | 2026-10-18 08:40 | boundary / forced_gaps:2:end | Configured sensor interval ends. |
| 1240 | 2026-10-18 08:50 | event / meal-5 | {"id":"meal-5","type":"meal","at_minute":1240,"grams":29,"announced_grams":29,"absorption_minutes":60} |
| 1440 | 2026-10-18 12:10 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-f04"></a>
## V4R3-F04 疾病恢复期伴错误校准及漂移

主族：F。来源：V4R2-F04；legacy24：F04。
设计意图（冻结原文）：原 V4R2 物理配置不变。 完整保留原观测复合题，H 为次标签，不重复计算一条物理题。
依据编号：R08, R13, R22。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`17394faf79379c8d2502355a55456540d0e581fb5edd9d8b66759bbd1f253845`。
历史 comparator（非执行配置，可能过时）：2×2：疾病恢复过程与观测异常分别有无，观察交互。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"life","ids":["ill-recovery-0"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T03:50:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0,
      "dawn_fraction": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "complete",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-17 11:45 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-17 11:50 | event / ill-0 | {"id":"ill-0","type":"illness","at_minute":0,"duration_hours":5,"insulin_need_increase":0.6,"announced":true} |
| 0 | 2026-10-17 11:50 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 10 | 2026-10-17 12:00 | event / plan-meal-0 | {"id":"plan-meal-0","type":"record","at_minute":10,"category":"meal","text":"Current intention: meal around 12:35, estimated 55 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 45 | 2026-10-17 12:35 | event / meal-0 | {"id":"meal-0","type":"meal","at_minute":45,"grams":55,"announced_grams":55,"absorption_minutes":60} |
| 270 | 2026-10-17 16:20 | event / wrong-calibration | {"id":"wrong-calibration","type":"sensor_calibration_error","at_minute":270,"bias_mg_dl":45} |
| 295 | 2026-10-17 16:45 | event / plan-meal-1 | {"id":"plan-meal-1","type":"record","at_minute":295,"category":"meal","text":"Current intention: meal around 17:20, estimated 37 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 300 | 2026-10-17 16:50 | event / drift-300 | {"id":"drift-300","type":"sensor_drift","at_minute":300,"duration_minutes":420,"bias_mg_dl":55,"ramp_minutes":90} |
| 300 | 2026-10-17 16:50 | boundary / ill-0:end | Configured interval ends; residual food/drug/state can remain. |
| 300 | 2026-10-17 16:50 | event / ill-recovery-0 | {"id":"ill-recovery-0","type":"record","at_minute":300,"category":"life","text":"Person reports fever/nausea have improved and appetite is changing; review recent insulin before repeating corrections. Exact insulin sensitivity is unknown."} |
| 300 | 2026-10-17 16:50 | event / sensor-report-300 | {"id":"sensor-report-300","type":"record","at_minute":300,"category":"fault","text":"Person reports a sensor-site problem or possible interference. Sensor values may not reflect blood glucose; an independent meter is available. Direction and magnitude are not supplied."} |
| 330 | 2026-10-17 17:20 | event / meal-1 | {"id":"meal-1","type":"meal","at_minute":330,"grams":37,"announced_grams":37,"absorption_minutes":60} |
| 655 | 2026-10-17 22:45 | event / plan-meal-2 | {"id":"plan-meal-2","type":"record","at_minute":655,"category":"meal","text":"Current intention: meal around 23:20, estimated 83 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 690 | 2026-10-17 23:20 | event / meal-2 | {"id":"meal-2","type":"meal","at_minute":690,"grams":83,"announced_grams":83,"absorption_minutes":60} |
| 720 | 2026-10-17 23:50 | boundary / drift-300:end | Configured interval ends; residual food/drug/state can remain. |
| 1155 | 2026-10-18 07:05 | event / plan-meal-3 | {"id":"plan-meal-3","type":"record","at_minute":1155,"category":"meal","text":"Current intention: meal around 07:40, estimated 65 g carbohydrate; ordinary meal. Timing and actual intake may change; this is not a future glucose prediction."} |
| 1190 | 2026-10-18 07:40 | event / meal-3 | {"id":"meal-3","type":"meal","at_minute":1190,"grams":65,"announced_grams":65,"absorption_minutes":60} |
| 1440 | 2026-10-18 11:50 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-f05"></a>
## V4R3-F05 校准到期停更而进食继续

主族：F。来源：V4R2-F05；legacy24：无。
设计意图（冻结原文）：原 V4R2 物理配置不变。 06:00 尚有读数，06:10 到期后无法继续更新，后续三餐仍发生；考察数据时效和现有校准工具，不新增传感器生理。
依据编号：R12, R13。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`91f40fd3ab5a99bd2eb2560ee9fd514a923e43a8bf896b4487466639059bbdaa`。
历史 comparator（非执行配置，可能过时）：同 Guardian 3 和日程，最近一次校准改为起点前 5 分钟；到期时刻按当前设备模型验证。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"fault","ids":["calibration-narrative"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T22:00:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "native",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 720,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -710 | 2026-10-17 18:10 | history / history:0 | {"type":"calibrate_cgm","minutes_before":710} |
| 0 | 2026-10-18 06:00 | event / calibration-narrative | {"id":"calibration-narrative","type":"record","at_minute":0,"category":"fault","text":"患者提到很久没有校准；具体到期时间以设备状态为准。"} |
| 0 | 2026-10-18 06:00 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 55 | 2026-10-18 06:55 | event / plan-meal-90 | {"id":"plan-meal-90","type":"record","at_minute":55,"category":"meal","text":"当前计划约在 07:30 进食，估计碳水 35 g；这是意向，不是未来实际摄入保证。"} |
| 90 | 2026-10-18 07:30 | event / meal-90 | {"id":"meal-90","type":"meal","at_minute":90,"grams":35,"announced_grams":35,"absorption_minutes":60} |
| 355 | 2026-10-18 11:55 | event / plan-meal-390 | {"id":"plan-meal-390","type":"record","at_minute":355,"category":"meal","text":"当前计划约在 12:30 进食，估计碳水 55 g；这是意向，不是未来实际摄入保证。"} |
| 390 | 2026-10-18 12:30 | event / meal-390 | {"id":"meal-390","type":"meal","at_minute":390,"grams":55,"announced_grams":55,"absorption_minutes":75} |
| 685 | 2026-10-18 17:25 | event / plan-meal-720 | {"id":"plan-meal-720","type":"record","at_minute":685,"category":"meal","text":"当前计划约在 18:00 进食，估计碳水 50 g；这是意向，不是未来实际摄入保证。"} |
| 720 | 2026-10-18 18:00 | event / meal-720 | {"id":"meal-720","type":"meal","at_minute":720,"grams":50,"announced_grams":50,"absorption_minutes":90} |
| 1440 | 2026-10-19 06:00 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-f06"></a>
## V4R3-F06 伪高结束后真实摄入开始主导

主族：F。来源：V4R2-F06；legacy24：无。
设计意图（冻结原文）：原 V4R2 物理配置不变。 08:00–12:00 仅传感器正向漂移，12:30 午餐后不再有该漂移；考察能否撤销旧的传感器解释并跟踪新证据，不预设真实血糖的形状。
依据编号：R12, R22。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`c27bf20ab12f1225014f5bb25b52804fcac5d7e790e5e7a95ca44983de416078`。
历史 comparator（非执行配置，可能过时）：同真实摄入，无早段漂移；另设午餐不发生的版本，分清观测异常结束与新摄入。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"fault","ids":["early-sensor-report"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T22:00:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "native",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-18 05:55 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-18 06:00 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 55 | 2026-10-18 06:55 | event / plan-meal-90 | {"id":"plan-meal-90","type":"record","at_minute":55,"category":"meal","text":"当前计划约在 07:30 进食，估计碳水 35 g；这是意向，不是未来实际摄入保证。"} |
| 90 | 2026-10-18 07:30 | event / meal-90 | {"id":"meal-90","type":"meal","at_minute":90,"grams":35,"announced_grams":35,"absorption_minutes":60} |
| 120 | 2026-10-18 08:00 | event / early-drift | {"id":"early-drift","type":"sensor_drift","at_minute":120,"duration_minutes":240,"bias_mg_dl":60,"ramp_minutes":45} |
| 120 | 2026-10-18 08:00 | event / early-sensor-report | {"id":"early-sensor-report","type":"record","at_minute":120,"category":"fault","text":"患者报告传感器部位可能受影响；无法说明偏差方向和幅度。"} |
| 355 | 2026-10-18 11:55 | event / plan-meal-390 | {"id":"plan-meal-390","type":"record","at_minute":355,"category":"meal","text":"当前计划约在 12:30 进食，估计碳水 55 g；这是意向，不是未来实际摄入保证。"} |
| 360 | 2026-10-18 12:00 | boundary / early-drift:end | Configured interval ends; residual food/drug/state can remain. |
| 390 | 2026-10-18 12:30 | event / meal-390 | {"id":"meal-390","type":"meal","at_minute":390,"grams":55,"announced_grams":55,"absorption_minutes":75} |
| 685 | 2026-10-18 17:25 | event / plan-meal-720 | {"id":"plan-meal-720","type":"record","at_minute":685,"category":"meal","text":"当前计划约在 18:00 进食，估计碳水 50 g；这是意向，不是未来实际摄入保证。"} |
| 720 | 2026-10-18 18:00 | event / meal-720 | {"id":"meal-720","type":"meal","at_minute":720,"grams":50,"announced_grams":50,"absorption_minutes":90} |
| 1440 | 2026-10-19 06:00 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-h01"></a>
## V4R3-H01 正常进食下的持续疾病高需求

主族：H。来源：V4R2-H03；legacy24：无。
设计意图（冻结原文）：正常摄入与持续需求上升的代表，不另按病种或需求时长拆题。 08:00–20:00 illness 参数 0.4，三餐不减量，没有额外运动或故障。把持续需求问题与漏餐补偿分开；20:00 后继续观察至次晨。
依据编号：R08, SICK25。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`a9d4be7c879702a7a9c180f2d4af1e1e4a2bd4f56642d35a8157986642a9fa3b`。
历史 comparator（非执行配置，可能过时）：完全相同三餐，没有 illness 代理。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"life","ids":["ill"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T22:00:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "native",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-18 05:55 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-18 06:00 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 55 | 2026-10-18 06:55 | event / plan-meal-90 | {"id":"plan-meal-90","type":"record","at_minute":55,"category":"meal","text":"当前计划约在 07:30 进食，估计碳水 35 g；这是意向，不是未来实际摄入保证。"} |
| 90 | 2026-10-18 07:30 | event / meal-90 | {"id":"meal-90","type":"meal","at_minute":90,"grams":35,"announced_grams":35,"absorption_minutes":60} |
| 120 | 2026-10-18 08:00 | event / ill | {"id":"ill","type":"illness","at_minute":120,"duration_hours":12,"insulin_need_increase":0.4,"announced":true} |
| 355 | 2026-10-18 11:55 | event / plan-meal-390 | {"id":"plan-meal-390","type":"record","at_minute":355,"category":"meal","text":"当前计划约在 12:30 进食，估计碳水 55 g；这是意向，不是未来实际摄入保证。"} |
| 390 | 2026-10-18 12:30 | event / meal-390 | {"id":"meal-390","type":"meal","at_minute":390,"grams":55,"announced_grams":55,"absorption_minutes":75} |
| 685 | 2026-10-18 17:25 | event / plan-meal-720 | {"id":"plan-meal-720","type":"record","at_minute":685,"category":"meal","text":"当前计划约在 18:00 进食，估计碳水 50 g；这是意向，不是未来实际摄入保证。"} |
| 720 | 2026-10-18 18:00 | event / meal-720 | {"id":"meal-720","type":"meal","at_minute":720,"grams":50,"announced_grams":50,"absorption_minutes":90} |
| 840 | 2026-10-18 20:00 | event / ill-recovery | {"id":"ill-recovery","type":"record","at_minute":840,"category":"life","text":"患者此时报告身体不适有所缓解；不提供实际敏感性或保证下一次血糖变化。"} |
| 840 | 2026-10-18 20:00 | boundary / ill:end | Configured interval ends; residual food/drug/state can remain. |
| 1440 | 2026-10-19 06:00 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-h02"></a>
## V4R3-H02 持续疾病高需求伴摄入明显减少

主族：H。来源：V4R2-H05；legacy24：无。
设计意图（冻结原文）：与 H01 分开，因为需要同时考虑较低外源输入和较高需求。 08:00–20:00 illness 参数 0.4；07:30 35 g、12:30 15 g、18:00 10 g，没有用晚间大餐自动抵消。只减少实际摄入，不模拟呕吐、脱水或胃排空疾病。
依据编号：R08。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`2e028f31396ddec74a26c0209b30ec8ebde0badc300755d654f871604a4442ab`。
历史 comparator（非执行配置，可能过时）：H03：相同需求变化、三餐正常；另设同低摄入但无需求变化，分开核对。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"life","ids":["ill"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T22:00:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "native",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-18 05:55 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-18 06:00 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 55 | 2026-10-18 06:55 | event / plan-meal-90 | {"id":"plan-meal-90","type":"record","at_minute":55,"category":"meal","text":"当前计划约在 07:30 进食，估计碳水 35 g；这是意向，不是未来实际摄入保证。"} |
| 90 | 2026-10-18 07:30 | event / meal-90 | {"id":"meal-90","type":"meal","at_minute":90,"grams":35,"announced_grams":35,"absorption_minutes":60} |
| 120 | 2026-10-18 08:00 | event / ill | {"id":"ill","type":"illness","at_minute":120,"duration_hours":12,"insulin_need_increase":0.4,"announced":true} |
| 355 | 2026-10-18 11:55 | event / plan-meal-390 | {"id":"plan-meal-390","type":"record","at_minute":355,"category":"meal","text":"当前计划约在 12:30 进食，估计碳水 15 g；这是意向，不是未来实际摄入保证。"} |
| 390 | 2026-10-18 12:30 | event / meal-390 | {"id":"meal-390","type":"meal","at_minute":390,"grams":15,"announced_grams":15,"absorption_minutes":75} |
| 685 | 2026-10-18 17:25 | event / plan-meal-720 | {"id":"plan-meal-720","type":"record","at_minute":685,"category":"meal","text":"当前计划约在 18:00 进食，估计碳水 10 g；这是意向，不是未来实际摄入保证。"} |
| 720 | 2026-10-18 18:00 | event / meal-720 | {"id":"meal-720","type":"meal","at_minute":720,"grams":10,"announced_grams":10,"absorption_minutes":90} |
| 840 | 2026-10-18 20:00 | event / ill-recovery | {"id":"ill-recovery","type":"record","at_minute":840,"category":"life","text":"患者此时报告身体不适有所缓解；不提供实际敏感性或保证下一次血糖变化。"} |
| 840 | 2026-10-18 20:00 | boundary / ill:end | Configured interval ends; residual food/drug/state can remain. |
| 1440 | 2026-10-19 06:00 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-h03"></a>
## V4R3-H03 疾病需求与食欲恢复先后错位

主族：H。来源：V4R2-H06；legacy24：无。
设计意图（冻结原文）：一个主情景覆盖恢复顺序，不再把多种早晚恢复各算一题。 06:00–14:00 illness 参数 0.4；07:30 15 g、12:30 20 g，14:00 需求代理消退，到 18:00 才恢复 50 g 摄入。14:00–18:00 是两者不同步的关键窗口。
依据编号：R08, SICK25。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`ca08cc8c6428e70c16ffdd3439e07d9e1f92b8af08c73a84a3195ce96743542e`。
历史 comparator（非执行配置，可能过时）：主世界需求06:00—14:00、18:00恢复摄入；相同三餐15/20/50 g不变，仅把需求结束移至22:00，就得到食欲先恢复的配对世界。旧 H07 的餐量/起点/加餐也不同，不能直接作为该严格对照。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"life","ids":["ill-recovery"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T22:00:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "native",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-18 05:55 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-18 06:00 | event / ill | {"id":"ill","type":"illness","at_minute":0,"duration_hours":8,"insulin_need_increase":0.4,"announced":true} |
| 0 | 2026-10-18 06:00 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 55 | 2026-10-18 06:55 | event / plan-meal-90 | {"id":"plan-meal-90","type":"record","at_minute":55,"category":"meal","text":"当前计划约在 07:30 进食，估计碳水 15 g；这是意向，不是未来实际摄入保证。"} |
| 90 | 2026-10-18 07:30 | event / meal-90 | {"id":"meal-90","type":"meal","at_minute":90,"grams":15,"announced_grams":15,"absorption_minutes":60} |
| 355 | 2026-10-18 11:55 | event / plan-meal-390 | {"id":"plan-meal-390","type":"record","at_minute":355,"category":"meal","text":"当前计划约在 12:30 进食，估计碳水 20 g；这是意向，不是未来实际摄入保证。"} |
| 390 | 2026-10-18 12:30 | event / meal-390 | {"id":"meal-390","type":"meal","at_minute":390,"grams":20,"announced_grams":20,"absorption_minutes":75} |
| 480 | 2026-10-18 14:00 | event / ill-recovery | {"id":"ill-recovery","type":"record","at_minute":480,"category":"life","text":"患者此时报告身体不适有所缓解；不提供实际敏感性或保证下一次血糖变化。"} |
| 480 | 2026-10-18 14:00 | boundary / ill:end | Configured interval ends; residual food/drug/state can remain. |
| 685 | 2026-10-18 17:25 | event / plan-meal-720 | {"id":"plan-meal-720","type":"record","at_minute":685,"category":"meal","text":"当前计划约在 18:00 进食，估计碳水 50 g；这是意向，不是未来实际摄入保证。"} |
| 720 | 2026-10-18 18:00 | event / appetite-return | {"id":"appetite-return","type":"record","at_minute":720,"category":"life","text":"患者此时食欲恢复并进餐；不代表提供任何真实生理参数。"} |
| 720 | 2026-10-18 18:00 | event / meal-720 | {"id":"meal-720","type":"meal","at_minute":720,"grams":50,"announced_grams":50,"absorption_minutes":90} |
| 1440 | 2026-10-19 06:00 | episode / end | Scored episode ends; remaining physiological effects are not reset. |

<a id="v4r3-h04"></a>
## V4R3-H04 疾病高需求叠加送达不足及修复

主族：H。来源：V4R2-H08；legacy24：无。
设计意图（冻结原文）：保留一种跨机制病日复杂题。与 E 的差别是需求扰动始终存在，不能把高糖全部解释为漏餐或全部解释为设备问题。 08:00–20:00 illness 参数 0.4；10:00–14:00 泵实际送达比例 0.5，并在 10:00 有部位异常报告。14:00 外源修复；Agent 可更早主动更换；三餐为 35/35/40 g。
依据编号：R08, R09, R19。证据只支持同类因素，不验证本日参数、组合或模型难度。
instance_spec SHA256（本补充重新计算）：`a1ffe82ffc83ffb08c7961a773789841c2534ccde833366e5b5f8dd43c668a55`。
历史 comparator（非执行配置，可能过时）：2×2：正常、仅 illness、仅送达不足、两者并存；每个世界有各自 WAIT。
历史 I1 partial_rules（非当前契约的承诺）：`[{"category":"fault","ids":["site-problem"]}]`。
有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。
评测方关键窗口（不新增评分或提示）：`[]`。

### 静态背景与初始配置

生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。

```json
{
  "seed": 20261017,
  "start_time": "2026-10-17T22:00:00.000Z",
  "horizon_minutes": 1440,
  "therapy": {
    "mode": "pump",
    "pump": {
      "model": "dana_i",
      "insulin": "aspart"
    }
  },
  "sensors": {
    "cgm": "medtronic_guardian_3",
    "meter": "contour_next_one"
  },
  "events": [
    "baseline"
  ],
  "self_care": "none",
  "overrides": {
    "patient": {
      "sex": "male",
      "age_years": 39,
      "height_cm": 170,
      "weight_kg": 66
    },
    "physiology": {
      "daily_sensitivity_cv": 0
    },
    "controller": {
      "enabled": false
    },
    "cgm": {
      "error_draw": "median",
      "sensor_age_days_at_start": 2,
      "gaps": {
        "start_probability_per_sample": 0
      }
    },
    "meter": {
      "routine_times": []
    },
    "scenario": {
      "meals": {},
      "activity": {
        "enabled": false
      },
      "stress": {
        "enabled": false
      },
      "announcement": {
        "information_mode": "native",
        "carb_error_fraction": 0
      },
      "extra_events": "See event rows below."
    },
    "initial_state": {
      "history_minutes": 360,
      "history": "See history rows below."
    }
  }
}
```

### 完整日程

| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |
|---|---|---|---|
| -5 | 2026-10-18 05:55 | history / history:0 | {"type":"calibrate_cgm","minutes_before":5} |
| 0 | 2026-10-18 06:00 | episode / start | Episode begins after real history replay, not a manually overwritten state. |
| 55 | 2026-10-18 06:55 | event / plan-meal-90 | {"id":"plan-meal-90","type":"record","at_minute":55,"category":"meal","text":"当前计划约在 07:30 进食，估计碳水 35 g；这是意向，不是未来实际摄入保证。"} |
| 90 | 2026-10-18 07:30 | event / meal-90 | {"id":"meal-90","type":"meal","at_minute":90,"grams":35,"announced_grams":35,"absorption_minutes":60} |
| 120 | 2026-10-18 08:00 | event / ill | {"id":"ill","type":"illness","at_minute":120,"duration_hours":12,"insulin_need_increase":0.4,"announced":true} |
| 240 | 2026-10-18 10:00 | event / delivery-loss | {"id":"delivery-loss","type":"infusion_deficit","at_minute":240,"duration_minutes":240,"delivered_fraction":0.5} |
| 240 | 2026-10-18 10:00 | event / site-problem | {"id":"site-problem","type":"record","at_minute":240,"category":"fault","text":"患者报告贴布潮湿或管路松动，设备画面可能仍显示运行。"} |
| 355 | 2026-10-18 11:55 | event / plan-meal-390 | {"id":"plan-meal-390","type":"record","at_minute":355,"category":"meal","text":"当前计划约在 12:30 进食，估计碳水 35 g；这是意向，不是未来实际摄入保证。"} |
| 390 | 2026-10-18 12:30 | event / meal-390 | {"id":"meal-390","type":"meal","at_minute":390,"grams":35,"announced_grams":35,"absorption_minutes":75} |
| 480 | 2026-10-18 14:00 | boundary / delivery-loss:end | Configured interval ends; residual food/drug/state can remain. |
| 480 | 2026-10-18 14:00 | event / repair-report | {"id":"repair-report","type":"record","at_minute":480,"category":"fault","text":"此时输注部位已处理；不补回之前未送达药物。"} |
| 480 | 2026-10-18 14:00 | event / scheduled-repair | {"id":"scheduled-repair","type":"infusion_recovery","at_minute":480} |
| 685 | 2026-10-18 17:25 | event / plan-meal-720 | {"id":"plan-meal-720","type":"record","at_minute":685,"category":"meal","text":"当前计划约在 18:00 进食，估计碳水 40 g；这是意向，不是未来实际摄入保证。"} |
| 720 | 2026-10-18 18:00 | event / meal-720 | {"id":"meal-720","type":"meal","at_minute":720,"grams":40,"announced_grams":40,"absorption_minutes":90} |
| 840 | 2026-10-18 20:00 | event / ill-recovery | {"id":"ill-recovery","type":"record","at_minute":840,"category":"life","text":"患者此时报告身体不适有所缓解；不提供实际敏感性或保证下一次血糖变化。"} |
| 840 | 2026-10-18 20:00 | boundary / ill:end | Configured interval ends; residual food/drug/state can remain. |
| 1440 | 2026-10-19 06:00 | episode / end | Scored episode ends; remaining physiological effects are not reset. |
