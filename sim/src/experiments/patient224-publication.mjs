import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {taskConfig} from '../benchmark/build.mjs';
import {selectPatientPriority} from './weekly-patient-selection.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const jsonHash=o=>hash(JSON.stringify(o));
const write=(dir,name,x)=>fs.writeFileSync(path.join(dir,name),typeof x==='string'?x:JSON.stringify(x,null,2)+'\n');

export function validatePatient224Audit(a) {
  assert.equal(a.completed_horizon,true);assert.equal(a.finite_grid,true);assert.equal(a.grid_points,2016);
  assert.equal(a.max_truth_difference_mgdl,0);assert.equal(a.wait_dynamic.n,2016);assert.equal(a.wait_dynamic.coverage,1);
  assert.ok(Number.isFinite(a.wait_score));
  assert.deepEqual(Object.keys(a.information_projection_sha256).sort(),['I0','I1','I2']);
  assert.ok([a.truth_sha256,...Object.values(a.information_projection_sha256)].every(s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s)));
  assert.equal(new Set(Object.values(a.information_projection_sha256)).size,3);
}

/** Accept generated native tasks and complete fixed-WAIT audits; never inspect scores for selection. */
export function verifyPatient224Benchmark(benchmarkDir,selectionDir) {
  const manifest=read(path.join(benchmarkDir,'benchmark.json')),plan=read(path.join(benchmarkDir,'construction.json'));
  const config=read(path.join(selectionDir,'pipeline-config.json')),selection=read(path.join(selectionDir,'selection.json'));
  const source='docs/weekly/scenarios/R2/source/construction.json',sourceBytes=fs.readFileSync(path.join(ROOT,source));
  assert.equal(hash(sourceBytes),selection.source_sha256,'Frozen R2 source mismatch');
  const scenes=new Map(JSON.parse(sourceBytes).config.scenarios.map(s=>[s.id,s]));
  assert.deepEqual(config,plan.config,'Generated benchmark must use the selected config');
  assert.equal(selection.method,'patient-priority/212-plus-12/v1');
  assert.equal(selection.worlds.length,224);assert.equal(plan.rows.length,224);assert.equal(plan.rejected.length,0);
  assert.deepEqual(plan.counts,{requested_worlds:224,worlds:224,rejected_worlds:0,tasks:672});
  assert.equal(plan.information.join(','),'I0,I1,I2');
  assert.equal(manifest.scoring.version,'METRICS-v0.3');assert.equal(Object.keys(manifest.tasks).length,672);
  assert.deepEqual(manifest.experiments.map(e=>[e.id,e.track,e.task_ids.length]),[['i0','full',224],['i1','full',224],['i2','full',224]]);
  const selected=new Map(selection.worlds.map(w=>[[w.scenario,w.patient,w.backend.replaceAll('_','-')].join('|'),w]));
  assert.equal(selected.size,224);
  const audits=new Map(plan.audits.map(a=>[a.preset,a]));assert.equal(audits.size,224);
  const rows=[],taskConfigs=[],seen=new Set();
  for(const row of plan.rows) {
    const key=[row.factors.scenario,row.factors.patient,row.factors.hardware].join('|'),w=selected.get(key);
    assert.ok(w,`Unexpected world ${row.preset}`);assert.ok(!seen.has(key));seen.add(key);
    assert.deepEqual(row.construction.events,scenes.get(row.factors.scenario).spec.overrides.scenario.extra_events);
    const a=audits.get(row.preset);assert.ok(a,`Missing audit: ${row.preset}`);
    validatePatient224Audit(a);
    let physical=null;
    for(const mode of ['I0','I1','I2']) {
      const taskId=`${row.preset}-${mode.toLowerCase()}`,entry=manifest.tasks[taskId];assert.ok(entry,`Missing task ${taskId}`);
      assert.equal(entry.hours,168);assert.equal(entry.factors.information,mode);
      const dir=path.join(benchmarkDir,entry.dir),instance=read(path.join(dir,'environment/sim/instance.json'));
      const expected=taskConfig(row.variants[mode],{track:'full',hours:168});
      assert.deepEqual(instance.config,expected,`Exported config mismatch: ${taskId}`);
      assert.equal(instance.provenance.sweet_sim_snapshot_sha256,manifest.sweet_sim_snapshot_sha256);
      assert.equal(instance.provenance.knowledge_sha256,manifest.knowledge_sha256);
      assert.equal(instance.provenance.kernel_sha256,manifest.kernel_sha256);
      assert.deepEqual(expected.patient,w.demographics);assert.deepEqual(expected.profile,w.profile);
      assert.deepEqual(expected.therapy,w.therapy);assert.equal(expected.physiology.sensitivity,w.sensitivity);
      assert.equal(expected.information.mode,mode);assert.equal(expected.information.own_records,true);
      assert.equal(expected.information.policy,'record-derived-v3');assert.equal(expected.self_care.mode,'none');
      const {information,...rest}=expected;
      if(physical)assert.deepEqual(rest,physical,`Information altered physics: ${row.preset}`);else physical=rest;
      const pub=read(path.join(dir,'environment/public.json')),scoring=read(path.join(dir,'tests/scoring.json'));
      assert.equal(pub.horizon_minutes,10080);assert.equal(pub.scoring_version,'METRICS-v0.3');
      assert.deepEqual(pub.prompt_context.patient,Object.fromEntries(['sex','age_years','height_cm','weight_kg'].map(k=>[k,expected.patient[k]])));
      assert.equal(scoring.scoring_version,'METRICS-v0.3');assert.deepEqual(scoring.weights,manifest.scoring.weights);
      assert.ok(!Object.hasOwn(pub,'spec')&&!Object.hasOwn(pub,'config'),'Private scenario must not be public');
      taskConfigs.push({id:taskId,config_sha256:jsonHash(expected),role:w.selection_role});
    }
    rows.push({world_id:row.preset,selection_id:w.id,role:w.selection_role,
      source_spec_sha256:jsonHash(row.spec),truth_sha256:a.truth_sha256,information_projection_sha256:a.information_projection_sha256,
      completed_horizon:a.completed_horizon,finite_grid:a.finite_grid,grid_points:a.grid_points,
      max_truth_difference_mgdl:a.max_truth_difference_mgdl,wait_score:a.wait_score,wait_safety_pass:a.wait_dynamic.safety_pass});
  }
  for(const [name,role,n] of [['main','patient-main',212],['hardware-probe','hardware-probe',12]]) {
    const subset=read(path.join(selectionDir,`${name}-pipeline-config.json`));
    const expectedIds=rows.filter(r=>r.role===role).map(r=>r.world_id).sort();
    assert.equal(expectedIds.length,n);assert.deepEqual([...subset.world_ids].sort(),expectedIds);
    assert.deepEqual({...subset,name:config.name,world_ids:config.world_ids},config,'Subset changed shared world parameters');
  }
  return {format:'sweet-sim.patient224-acceptance/v1',passed:true,date:'2026-10-22',
    physical_worlds:224,patient_main_worlds:212,hardware_probe_worlds:12,tasks:672,horizon_minutes:10080,
    wait_rollouts:672,samples_per_rollout:2016,total_grid_samples:672*2016,
    all_horizons_completed:true,all_true_grids_finite:true,max_information_truth_difference_mgdl:0,
    all_three_information_projections_distinct:true,all_exported_configs_match:true,own_records_all_modes:true,
    scoring_version:manifest.scoring.version,source_construction:{path:source,sha256:hash(sourceBytes)},
    runtime:{snapshot_sha256:manifest.sweet_sim_snapshot_sha256,knowledge_sha256:manifest.knowledge_sha256,
      kernel_sha256:manifest.kernel_sha256,build_commit:manifest.sweet_sim_commit,git_dirty:manifest.sweet_sim_git_dirty},
    construction_tooling:['src/experiments/scenario-generator.mjs','src/experiments/scenario-pipeline.mjs',
      'src/experiments/patient-profiles.mjs','src/experiments/weekly-selection.mjs','src/experiments/weekly-patient-selection.mjs',
      'src/experiments/patient224-publication.mjs','scripts/count-weekly-matrix.mjs','scripts/select-weekly-main.mjs']
      .map(file=>({path:file,sha256:hash(fs.readFileSync(path.join(ROOT,file)))})),
    wait_safety_fail_worlds:rows.filter(r=>!r.wait_safety_pass).length,
    selection_unchanged_by_scores:true,model_calls:0,
    limits:['Fixed WAIT validates numerical execution and information isolation, not controllability, clinical validity or LLM performance.',
      'No dose/meal resizing, score threshold selection or seed search. Unsafe/low-score WAIT outcomes stay in the set.',
      'Baseline WAIT validation uses the native 5-minute environment clock, not an agent decision schedule; hourly agent protocol is unchanged.'],
    rows,task_configs:taskConfigs};
}

/** Store portable build inputs and compact acceptance records, not duplicated task snapshots or admin tokens. */
export function publishPatient224({benchmarkDir,selectionDir,outDir}) {
  if(fs.existsSync(outDir))throw Error(`No overwrite: ${outDir}`);
  const qa=verifyPatient224Benchmark(benchmarkDir,selectionDir),selection=read(path.join(selectionDir,'selection.json'));
  const manifest=read(path.join(benchmarkDir,'benchmark.json'));
  const {inputs,initialization_check,...portable}=selection;
  const regenerated=selectPatientPriority({format:'sweet-sim.weekly-matrix-candidates/v1',remaining_worlds:928,
    axes:{body_sizes:['typical'],world_seed:selection.world_seed,information:selection.information},
    worlds:read(selection.inputs.candidates.path).worlds});
  assert.deepEqual(regenerated.selected_ids,portable.selected_ids,'Selection rules changed');
  portable.source_construction=qa.source_construction;
  portable.initialization_check={ok:true,physical_worlds:224,main:212,hardware_probe:12};
  fs.mkdirSync(path.dirname(outDir),{recursive:true});
  const staging=fs.mkdtempSync(path.join(path.dirname(outDir),'.patient224-publication-'));
  try {
    for(const file of ['pipeline-config.json','main-pipeline-config.json','hardware-probe-pipeline-config.json','SELECTED-SCENARIOS.zh-CN.md'])
      fs.copyFileSync(path.join(selectionDir,file),path.join(staging,file));
    write(staging,'selection.json',portable);write(staging,'VALIDATION.json',qa);
    write(staging,'task-index.json',{format:manifest.format,name:manifest.name,scoring:manifest.scoring,
      experiments:manifest.experiments,tasks:manifest.tasks});
    write(staging,'README.zh-CN.md',[
      '# Weekly R2 患者优先224题集','',
      '已用原生pipeline生成224个物理世界、I0/I1/I2共672个Harbor任务，并完成每个信息变体的七天固定WAIT审计。',
      '患者主集212个，额外硬件对照12个。未调用LLM，未改旧冻结题集或实际餐量、剂量、故障强度。',
      'WAIT仅检验执行和隔离：低分或安全否决全部保留，不以此证明临床合理或可控。','',
      `本批固定WAIT中有${qa.wait_safety_fail_worlds}个物理世界触发METRICS-v0.3安全否决，全部保留；三档信息是同世界重复审计，不重复计数。`,'',
      '本目录的未来事件、来源种子和验收真值属于评测方资料，不得加入Agent提示词或公开工具输入。','',
      '## 文件','',
      '- `pipeline-config.json`：全224个世界，原生world_ids白名单。',
      '- `main-pipeline-config.json`：仅212个患者主集；建议用于主结果。',
      '- `hardware-probe-pipeline-config.json`：仅12个额外硬件对照；与主集的4个锚点配对分析。',
      '- `selection.json` / `SELECTED-SCENARIOS.zh-CN.md`：完整入选身份、实际患者/治疗配置及逐模板列表。',
      '- `task-index.json`：已生成672任务的原生索引，不含任务管理员令牌。',
      '- `VALIDATION.json`：逐世界真值及信息投影SHA、完整性、WAIT结果、逐任务配置SHA和源码身份。',
      '- `CHECKSUMS.json`：以上发布文件及原始R2构造源SHA。','',
      '## 重新生成','',
      '在sweet-sim目录安装仓库依赖后，执行：','',
      '```bash',
      'node scripts/scenario-pipeline.mjs build \\',
      '  --config bench/pipelines/weekly-patient224-20261022/pipeline-config.json \\',
      '  --out .local/benchmarks/weekly-patient224-20261022',
      'node scripts/publish-patient224.mjs --check true \\',
      '  --benchmark .local/benchmarks/weekly-patient224-20261022 \\',
      '  --selection bench/pipelines/weekly-patient224-20261022',
      'node --test test/patient224-publication.test.mjs',
      '```','',
      '构建目录不能已存在。构建会重新执行224×3个七天WAIT审计，随后生成原生Harbor任务、私有sidecar及verifier。',
      'Git保存可移植输入、索引和完整审计摘要；生成任务树含每题源码快照和随机管理员令牌，仅留本地、不重复提交。',
      '物理配置与真值SHA可以重现；文件时间戳、管理员令牌不要求字节相同。若运行时源码不同，应重新审计，不能直接沿用本验收。','',
      '## 运行边界','',
      'Agent的提示词、memory、小时决策及每日额外6次额度沿用当前Weekly pipeline，需在正式campaign显式登记；此处没有启动campaign。',
      '固定WAIT审计使用原生5分钟环境网格，不表示把Agent改为5分钟决策。baseline仍保留自己的5分钟协议。',
      '单轨迹评分仍为METRICS-v0.3；主集与硬件对照应分开汇总，不能用硬件组全样本均分解释纯设备效应。',
      '设计依据及未实现机制的边界见 `docs/WEEKLY-PATIENT224-SELECTION.zh-CN.md`；旧R1/R2和261方案均独立保留。','',
    ].join('\n'));
    const files=fs.readdirSync(staging).sort().map(file=>({path:file,sha256:hash(fs.readFileSync(path.join(staging,file)))}));
    write(staging,'CHECKSUMS.json',{format:'sweet-sim.patient224-publication/v1',source:qa.source_construction,files});
    fs.renameSync(staging,outDir);
  } catch(e){fs.rmSync(staging,{recursive:true,force:true});throw e;}
  return qa;
}
