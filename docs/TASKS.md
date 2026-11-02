# 构造仿真任务

## 冻结主实验

`benchmark/main212/TASKS.json` 是 212 个 task 的唯一清单，`fixture_sha256` 校验原始文件字节。32 个场景模板覆盖进食/吸收、运动、需求变化、输注故障与传感器问题；与患者组合后得到 212 题。`MAIN-SET.json` 保留原始选题记录，其中模型/并发字段是历史元数据；公开五模型路由以 `benchmark/models.json` 为准。

`fixture.instance.config` 含隐藏事件和 evaluator 配置，**不能作为 agent prompt**。运行入口只把 `fixture.pub` 与 `SimEnv.observe()` 的公开信息交给控制器。

## 单题构造器

`sim/src/sim/instance.mjs` 的 `buildInstanceConfig(spec)` 解析并检查患者类型、传感器、胰岛素和设备兼容性。`examples/task.json` 展示输入格式。修改种子、患者、硬件、事件或 overrides 后，使用 README 的 `create` 命令生成独立输出。

```js
import {buildInstanceConfig} from '../sim/src/sim/instance.mjs';
import {SimEnv} from '../sim/src/env/pomdp.mjs';

const config = buildInstanceConfig(spec);
const env = new SimEnv(config);
const observation = env.observe(); // 可见 CGM/记录/设备状态，不是真值。
const receipt = env.step({
  action_id: 'example-0', expected_step: 0,
  action: {type: 'WAIT'}, rationale: 'offline constructor check'
});
```

`expected_step` 和 `action_id` 防止重复应用；真实可用操作看 `observation.action_specs`。创建自定义题时不要向输入混入 evaluator 未来信息。

## 场景与批量构造

- `src/experiments/scenario-generator.mjs`：基础机制、事件模板与信息投影。
- `src/experiments/scenario-masks.mjs`：已有场景变体和信息条件。
- `src/experiments/scenario-pipeline.mjs`：患者 x 硬件 x 因素 x 种子组合、兼容性检查与 benchmark 导出。
- `src/experiments/hypoglycemia-revision.mjs`：主实验低血糖场景修订的构造逻辑。
- `bench/pipelines/patient224-three-day-hypoglycemia-v2-20261029/pipeline-config.json`：主实验选题的上游构造配置；正式比较仍读取冻结 212 fixture，不重新生成来替换它们。

`pipeline` 不带 `--out` 只列计划；带 `--out` 执行离线构造和检查，不调用模型。批量格式参考 `sim/bench/pipelines/custom.example.json`。可用 I0/I1/I2；新实验应明确记录所用条件、设备、评分版本和种子。
