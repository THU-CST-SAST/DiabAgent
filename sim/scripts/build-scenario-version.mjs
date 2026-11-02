#!/usr/bin/env node
// Publish frozen catalogues through the existing pipeline; never regenerate their worlds.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {planScenarioPipeline,buildScenarioPipeline} from '../src/experiments/scenario-pipeline.mjs';
import {buildInstanceConfig} from '../src/sim/instance.mjs';

export const VERSIONS_DIR=fileURLToPath(new URL('../../analysis/scenario-design-versions/',import.meta.url));
export const VERSION_DEFINITIONS=Object.freeze({
  'v4.0':{catalog:'scenario-v4r2-day-cards-20261018.json',prefix:'V4R2-',namespace:'v40',count:40,contract:'selective-records/v1'},
  'v4.1':{catalog:'scenario-v4r3-day-cards-20261018.json',prefix:'V4R3-',namespace:'v41',count:32,contract:'selective-records/v1'},
  'v4.2':{catalog:'scenario-v42-day-cards-20261019.json',prefix:'V4R4-',namespace:'v42',count:32,contract:'carbs-treatment-only/v1'},
});
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const withoutInformation=config=>{const {information,...physical}=config;return physical;};

export function loadScenarioVersion(version,{versionsDir=VERSIONS_DIR}={}) {
  if(!Object.hasOwn(VERSION_DEFINITIONS,version))throw Error(`Explicit --version required: ${Object.keys(VERSION_DEFINITIONS).join(', ')}`);
  const definition=VERSION_DEFINITIONS[version],dir=path.join(versionsDir,version);
  const manifestBytes=fs.readFileSync(path.join(dir,'manifest.json')),manifest=JSON.parse(manifestBytes);
  assert.equal(manifest.version,version,'Frozen manifest version mismatch');
  const checked=new Set();
  for(const entry of manifest.files) {
    assert.equal(path.basename(entry.file),entry.file,'Frozen manifest must name local files');
    assert.ok(!checked.has(entry.file),'Duplicate frozen manifest entry');checked.add(entry.file);
    const bytes=fs.readFileSync(path.join(dir,entry.file));
    assert.equal(sha256(bytes),entry.sha256,`Frozen hash mismatch: ${version}/${entry.file}`);
    if(entry.bytes!==undefined)assert.equal(bytes.length,entry.bytes);
  }
  assert.ok(checked.has(definition.catalog),'Catalogue is not covered by frozen manifest');
  const catalogBytes=fs.readFileSync(path.join(dir,definition.catalog)),catalog=JSON.parse(catalogBytes);
  assert.equal(catalog.cards.length,definition.count);
  const ids=new Set();
  for(const card of catalog.cards) {
    assert.match(card.id,new RegExp(`^${definition.prefix}[A-Z][0-9]{2}$`));
    assert.ok(!ids.has(card.id),'Duplicate frozen scenario ID');ids.add(card.id);
    assert.ok(card.instance_spec&&Array.isArray(card.partial_rules)&&card.partial_rules.length,'Incomplete frozen card');
  }
  if(version==='v4.2')assert.equal(catalog.protocol.information_contract,definition.contract);
  return {version,definition,dir,catalog,manifest,catalog_sha256:sha256(catalogBytes),manifest_sha256:sha256(manifestBytes)};
}

export function planScenarioVersion(version,{scenarios=null,versionsDir=VERSIONS_DIR}={}) {
  const loaded=loadScenarioVersion(version,{versionsDir}),{definition,catalog}=loaded;
  let cards=catalog.cards;
  if(scenarios!==null) {
    if(!Array.isArray(scenarios)||!scenarios.length)throw Error('scenarios must be a nonempty list');
    const ids=scenarios.map(value=>{
      if(typeof value!=='string')throw Error('Invalid scenario ID');
      const id=/^[A-Z][0-9]{2}$/.test(value)?definition.prefix+value:value;
      if(!catalog.cards.some(c=>c.id===id))throw Error(`Scenario ${value} is not in ${version}`);
      return id;
    });
    if(new Set(ids).size!==ids.length)throw Error('Duplicate scenario selection');
    cards=catalog.cards.filter(c=>ids.includes(c.id));
  }
  const seeds=new Set(cards.map(c=>c.instance_spec.seed));
  assert.equal(seeds.size,1,'Frozen catalogue requires one explicit common seed');
  const config={format:'sweet-sim.scenario-pipeline/v1',name:`scenario-${definition.namespace}-publication`,
    title:`${version}: frozen catalogue publication`,
    family_names:Object.fromEntries(Object.entries(catalog.families).map(([id,family])=>[id,family.name])),
    information_contract:definition.contract,information:['I0','I1','I2'],
    patients:[{id:'frozen'}],hardware:[{id:'frozen'}],factors:[{id:'frozen'}],
    world_seeds:[...seeds],background_seeds:[null],
    scenarios:cards.map(card=>({id:card.id.slice(definition.prefix.length).toLowerCase(),
      case_id:`${definition.namespace}-${card.id.slice(definition.prefix.length).toLowerCase()}`,
      family:card.family,title:card.title,exact_spec:true,spec:structuredClone(card.instance_spec),
      partial_rules:structuredClone(card.partial_rules),evidence:card.evidence,
      requires_calibration:card.family==='F'&&['F04','F05'].includes(card.id.slice(definition.prefix.length)),
    }))};
  const plan=planScenarioPipeline(config);
  assert.equal(plan.rows.length,cards.length);
  for(const [i,row] of plan.rows.entries()) {
    assert.deepEqual(row.spec,cards[i].instance_spec,'Pipeline changed a frozen instance_spec');
    const physical=withoutInformation(buildInstanceConfig(cards[i].instance_spec));
    for(const spec of Object.values(row.variants))
      assert.deepEqual(withoutInformation(buildInstanceConfig(spec)),physical,'Information arm changed the frozen physical world');
  }
  return {...loaded,cards,config,plan};
}

const cell=value=>String(value).replaceAll('|','&#124;').replaceAll('\n','<br>');
const stamp=(spec,minute)=>new Date(Date.parse(spec.start_time)+(minute+480)*60000).toISOString().slice(0,16).replace('T',' ');
export function scheduleRows(card) {
  const spec=card.instance_spec,overrides=spec.overrides,rows=[];
  const add=(minute,kind,id,details)=>rows.push({minute,kind,id,details});
  for(const [i,event] of overrides.initial_state.history.entries())
    add(-event.minutes_before,'history',`history:${i}`,event);
  for(const event of overrides.scenario.extra_events) {
    add(event.at_minute,'event',event.id,event);
    if(event.type==='alcohol') {
      add(event.at_minute+60*event.onset_hours,'boundary',`${event.id}:onset`,'Configured delayed hepatic proxy begins; not a measurement.');
      add(event.at_minute+60*(event.onset_hours+event.duration_hours),'boundary',`${event.id}:end`,'Configured delayed proxy ends; prior state is not reset.');
    } else {
      const duration=event.duration_minutes??(event.type==='illness'?60*event.duration_hours:null);
      if(Number.isFinite(duration))add(event.at_minute+duration,'boundary',`${event.id}:end`,'Configured interval ends; residual food/drug/state can remain.');
    }
  }
  for(const key of ['forced_gaps','compression_lows'])for(const [i,event] of (overrides.cgm?.[key]??[]).entries()) {
    add(event.at_minute,'sensor',`${key}:${i}`,event);
    add(event.at_minute+event.duration_minutes,'boundary',`${key}:${i}:end`,'Configured sensor interval ends.');
  }
  for(const [i,event] of overrides.initial_state.history.entries()) {
    if(event.type==='extended_bolus')add(event.duration_minutes-event.minutes_before,'boundary',`history:${i}:end`,
      'Prior extended delivery is scheduled to finish if not cancelled; this is not a new dose.');
    if(event.type==='suspend_pump')add(event.minutes-event.minutes_before,'boundary',`history:${i}:end`,
      'Prior suspension interval ends if not changed by the agent.');
  }
  add(0,'episode','start','Episode begins after real history replay, not a manually overwritten state.');
  add(spec.horizon_minutes,'episode','end','Scored episode ends; remaining physiological effects are not reset.');
  return rows.sort((a,b)=>a.minute-b.minute||a.id.localeCompare(b.id,'en'));
}

export function renderDaySchedules(loaded) {
  const {version,definition,catalog,catalog_sha256}=loaded;
  const lines=[`# ${version} 完整逐场景设计与日程`,'',
    `本补充包含全部 ${catalog.cards.length} 个冻结主世界，直接从 [完整目录](${definition.catalog}) 的 instance_spec 排表。`,
    `目录 SHA256：\`${catalog_sha256}\`。不读取旧 construction、结果、轨迹或模型输出，不选择或修改世界。`,
    '时间为北京时间 UTC+08:00，并保留相对分钟；负数为回合前历史，超出 horizon 的行标为回合外。参数保留原 JSON 字段和单位。',
    '这是评测方设计说明，不注入 Agent。数值是合成配置，不是临床处方。吸收时间是模型时间常数，不代表吸收完成时间。',
    `[版本入口与元数据限制](GUIDE.zh-CN.md)。有效信息契约：\`${definition.contract}\`。`,
    'comparator / partial_rules 下文逐字留档，不当作已构造的对照世界或自动修复的规则。历史 I1 可能投影重合；v4.2 不执行继承的 partial_rules。','',
    '| 场景 | 标题 |','|---|---|',
    ...catalog.cards.map(c=>`| [${c.id}](#${c.id.toLowerCase()}) | ${cell(c.title)} |`),''];
  for(const card of catalog.cards) {
    const spec=card.instance_spec,overrides=spec.overrides;
    const context={...spec,overrides:{...overrides,
      initial_state:{...overrides.initial_state,history:'See history rows below.'},
      scenario:{...overrides.scenario,extra_events:'See event rows below.'}}};
    lines.push(`<a id="${card.id.toLowerCase()}"></a>`,`## ${card.id} ${card.title}`,'',
      `主族：${card.family}。来源：${card.previous_id??'无上一版 ID'}；legacy24：${card.legacy_id??'无'}。`,
      `设计意图（冻结原文）：${card.intent}`,
      `依据编号：${card.evidence.join(', ')}。证据只支持同类因素，不验证本日参数、组合或模型难度。`,
      `instance_spec SHA256（本补充重新计算）：\`${sha256(JSON.stringify(spec))}\`。`,
      `历史 comparator（非执行配置，可能过时）：${card.comparator}`,
      `历史 I1 partial_rules（非当前契约的承诺）：\`${JSON.stringify(card.partial_rules)}\`。`,
      version==='v4.2'
        ?'有效 I1：仅保留已有实际碳水与治疗记录；隐藏运动、生活、故障叙述及餐食计划。I0 保留已有记录；I2 为 record-derived-v3，自身回执不由此恢复外部账本。'
        :'有效 I1：原样使用本卡 partial_rules；I0 为已有记录，I2 为 record-derived-v3。规则沿用设计草案，不声称三档投影必然各不相同。',
      `评测方关键窗口（不新增评分或提示）：\`${JSON.stringify(card.challenge_windows??[])}\`。`,'',
      '### 静态背景与初始配置','', '生理代理、初始设置、硬件与公告配置均按原目录保留；日程表展示全部显式历史、事件及传感器区间。','',
      '```json',JSON.stringify(context,null,2),'```','',
      '### 完整日程','', '| 相对分钟 | 北京时间 | 类型 / ID | 原配置或区间说明 |','|---|---|---|---|',
      ...scheduleRows(card).map(row=>`| ${row.minute} | ${stamp(spec,row.minute)}${row.minute>spec.horizon_minutes?'（回合外）':''} | ${cell(row.kind+' / '+row.id)} | ${cell(typeof row.details==='string'?row.details:JSON.stringify(row.details))} |`),'');
  }
  return lines.join('\n');
}

export function verifyPublication(loaded) {
  const manifest=read(path.join(loaded.dir,'publication-manifest.json'));
  assert.equal(manifest.version,loaded.version);
  assert.equal(manifest.frozen_manifest_sha256,loaded.manifest_sha256,'Frozen manifest identity changed');
  const expected=['build.mjs','GUIDE.zh-CN.md','DAY-SCHEDULES.zh-CN.md'];
  assert.deepEqual(manifest.files.map(f=>f.file).sort(),expected.sort());
  for(const entry of manifest.files) {
    const bytes=fs.readFileSync(path.join(loaded.dir,entry.file));
    assert.equal(sha256(bytes),entry.sha256,`Supporting hash mismatch: ${entry.file}`);
    assert.equal(bytes.length,entry.bytes);
  }
  assert.equal(manifest.builder.file,'../../../sweet-sim/scripts/build-scenario-version.mjs');
  assert.equal(sha256(fs.readFileSync(path.resolve(loaded.dir,manifest.builder.file))),manifest.builder.sha256,'Shared builder hash mismatch');
  assert.equal(fs.readFileSync(path.join(loaded.dir,'DAY-SCHEDULES.zh-CN.md'),'utf8'),renderDaySchedules(loaded),'Day schedules differ from frozen catalogue');
  return manifest;
}

export function publishScenarioVersion(version,{outDir,scenarios=null,versionsDir=VERSIONS_DIR}={}) {
  if(typeof outDir!=='string'||!outDir)throw Error('A new --out directory is required');
  const out=path.resolve(outDir);
  if(fs.existsSync(out))throw Error(`No overwrite: ${out}`);
  const loaded=planScenarioVersion(version,{scenarios,versionsDir});
  verifyPublication(loaded);
  const result=buildScenarioPipeline(out,loaded.config);
  const file=path.join(out,'construction.json'),construction=read(file);
  Object.assign(construction,{design_version:version,design_catalog_sha256:loaded.catalog_sha256,
    source_catalog_manifest:loaded.manifest,record_contract:loaded.definition.contract,
    publication:{frozen_manifest_sha256:loaded.manifest_sha256,
      scenario_ids:loaded.cards.map(c=>c.id),task_namespace:loaded.definition.namespace,
      historical_comparators_executed:false,model_calls:false}});
  fs.writeFileSync(file,JSON.stringify(construction,null,2)+'\n');
  return {loaded,result,out};
}

export function runCli(args=process.argv.slice(2),{version:fixedVersion=null}={}) {
  try {
    const options={};
    for(let i=0;i<args.length;i++) {
      const name=args[i];
      if(['--check','--plan','--plan-only','--help'].includes(name))options[name]=true;
      else if(['--version','--out','--scenarios'].includes(name)) {
        if(options[name]!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw Error(`Invalid ${name}`);
        options[name]=args[++i];
      } else throw Error(`Unknown argument: ${name}`);
    }
    if(options['--help']) {
      console.log('build-scenario-version.mjs --version v4.0|v4.1|v4.2 (--check | --plan-only | --out NEW_DIR) [--scenarios B01,C01]');
      return;
    }
    if(fixedVersion&&options['--version']&&fixedVersion!==options['--version'])throw Error('Version-local entrypoint cannot select another version');
    const version=fixedVersion??options['--version'];
    const mode=options['--out']?'build':options['--check']?'check':options['--plan']||options['--plan-only']?'plan':null;
    if(!mode||options['--out']&&(options['--check']||options['--plan']||options['--plan-only']))
      throw Error('Choose --check, --plan-only or --out NEW_DIR; read-only modes cannot build');
    const selection=options['--scenarios']?.split(',')??null;
    if(mode==='build') {
      const {loaded,out}=publishScenarioVersion(version,{outDir:options['--out'],scenarios:selection});
      console.log(JSON.stringify({mode,version,out,counts:loaded.plan.counts,model_calls:false}));
    } else {
      const loaded=planScenarioVersion(version,{scenarios:selection});
      verifyPublication(loaded);
      console.log(JSON.stringify({mode,version,information_contract:loaded.definition.contract,
        catalog_sha256:loaded.catalog_sha256,counts:loaded.plan.counts,
        scenario_ids:loaded.cards.map(c=>c.id),world_ids:loaded.plan.rows.map(r=>r.preset),model_calls:false,writes:false},null,2));
    }
  } catch(error) {console.error(error.message);process.exitCode=1;}
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)runCli();
