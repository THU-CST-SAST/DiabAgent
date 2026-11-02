#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {parseArgs,list} from '../src/benchmark/cli.mjs';
import {loadTrials} from '../src/benchmark/summarize.mjs';

const opt=parseArgs(process.argv.slice(2)),sha=b=>createHash('sha256').update(b).digest('hex');
const archive=path.resolve(opt.archive??'');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
function files(dir) {
  return fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(d=>{
    const p=path.join(dir,d.name);if(d.isSymbolicLink())throw new Error(`Symlinks not permitted in archive: ${p}`);
    return d.isDirectory()?files(p):[p];
  });
}
if(!opt.archive)throw new Error('--archive DIR required; --verify or --benchmark DIR --jobs DIRS --report DIR');
if(opt.verify) {
  const index=read(path.join(archive,'MANIFEST.json'));
  if(sha(fs.readFileSync(path.join(archive,'MANIFEST.json')))!==fs.readFileSync(path.join(archive,'MANIFEST.sha256'),'utf8').trim())throw new Error('Manifest digest mismatch');
  for(const e of index.files){const b=fs.readFileSync(path.join(archive,e.path));if(b.length!==e.bytes||sha(b)!==e.sha256)throw new Error(`Integrity mismatch: ${e.path}`);}
  const expected=new Set(index.files.map(e=>e.path));
  for(const p of files(archive)){const f=path.relative(archive,p);if(!['MANIFEST.json','MANIFEST.sha256'].includes(f)&&!expected.has(f))throw new Error(`Unexpected file: ${f}`);}
  console.log(JSON.stringify({verified:true,files:index.files.length,manifest_sha256:sha(fs.readFileSync(path.join(archive,'MANIFEST.json')))}));
  process.exit(0);
}
if(!opt.benchmark||!opt.jobs||!opt.report)throw new Error('--benchmark DIR --jobs DIRS --report DIR required');
if(fs.existsSync(archive))throw new Error(`Archive already exists; never overwrite: ${archive}`);
const trials=list(opt.jobs).flatMap(j=>loadTrials(j));
for(const job of list(opt.jobs)) {
 const ts=loadTrials(job),cfg=read(path.join(job,'config.json'));
 if(ts.length!==Object.keys(cfg.planned_trials??{}).length)throw new Error(`Missing planned trial records: ${job}`);
 if(ts.some(t=>!['done','agent_failed','infra_failed'].includes(t.state)))throw new Error(`Refusing to seal unfinished trials: ${job}`);
 if(!fs.existsSync(path.join(job,'result.json')))throw new Error(`Job has no terminal summary: ${job}`);
}
const repo=path.resolve('..'),git=args=>{const r=spawnSync('git',args,{cwd:repo,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return r.stdout;};
fs.mkdirSync(path.dirname(archive),{recursive:true});fs.mkdirSync(archive);
fs.cpSync(fs.realpathSync(opt.report),path.join(archive,'report'),{recursive:true});
fs.cpSync(fs.realpathSync(opt.benchmark),path.join(archive,'benchmark'),{recursive:true});
for(const j of list(opt.jobs))fs.cpSync(j,path.join(archive,'jobs',path.basename(j)),{recursive:true});
const source=path.join(archive,'source','sweet-sim');fs.mkdirSync(source,{recursive:true});
for(const p of ['src','model','knowledge','vendor','scripts','test','docs','bench','package.json','package-lock.json','README.md','HANDOFF.zh-CN.md'])
  if(fs.existsSync(p))fs.cpSync(p,path.join(source,p),{recursive:true});
if(fs.existsSync(path.join(repo,'analysis')))fs.cpSync(path.join(repo,'analysis'),path.join(archive,'source','analysis'),{recursive:true});
const extra=list(opt.extra??'');
if(new Set(extra.map(p=>path.basename(p))).size!==extra.length)throw new Error('--extra source basenames must be unique');
for(const p of extra)fs.cpSync(fs.realpathSync(p),path.join(archive,'diagnostics',path.basename(p)),{recursive:true});
fs.writeFileSync(path.join(archive,'source','working-tree.patch'),git(['diff','--binary']));
fs.writeFileSync(path.join(archive,'source','ORIGIN.json'),JSON.stringify({commit:git(['rev-parse','HEAD']).trim(),branch:git(['branch','--show-current']).trim(),status:git(['status','--short']),
  note:'Source as archived; each original trial also retains its own frozen runtime snapshot. No secret env files or node_modules copied.'},null,2)+'\n');
const quantile=(x,q)=>{if(!x.length)return null;const a=[...x].sort((a,b)=>a-b),i=(a.length-1)*q,lo=Math.floor(i);return a[lo]+(a[Math.ceil(i)]-a[lo])*(i-lo);};
const llm=trials.filter(t=>t.agent.startsWith('llm:'));
const stats=ts=>{const totals=ts.map(t=>t.usage.input_tokens+t.usage.output_tokens),sum=k=>ts.reduce((a,t)=>a+t.usage[k],0);return {n:ts.length,
  input_tokens:sum('input_tokens'),output_tokens:sum('output_tokens'),total_tokens:sum('input_tokens')+sum('output_tokens'),
  mean:totals.length?totals.reduce((a,b)=>a+b,0)/totals.length:null,median:quantile(totals,.5),p10:quantile(totals,.1),p90:quantile(totals,.9),min:totals.length?Math.min(...totals):null,max:totals.length?Math.max(...totals):null,
  mean_model_calls:ts.length?ts.reduce((a,t)=>a+(t.agent_stats?.model_calls??0),0)/ts.length:null};};
const tokens={unit:'one full 24-hour agent trajectory, including every model call and recorded attempt, not a single HTTP request',all:stats(llm),
  by_mode:Object.fromEntries([...new Set(llm.map(t=>t.experiment))].map(m=>[m,stats(llm.filter(t=>t.experiment===m))])),
  per_world_all_included_conditions_total:llm.length?stats(llm).total_tokens/new Set(llm.map(t=>t.instance_id)).size:0,
  notes:['WAIT uses no external LLM tokens.','These are reported input+output tokens, not USD; caching discounts and provider billing are not inferred.','Connectivity checks and pilot runs are excluded.']};
fs.writeFileSync(path.join(archive,'token-usage.json'),JSON.stringify(tokens,null,2)+'\n');
const states=trials.reduce((a,t)=>(a[t.state]=(a[t.state]??0)+1,a),{});
fs.writeFileSync(path.join(archive,'README.md'),`# 冻结实验归档\n\n入口：[逐题报告](report/index.html)。\n\n保留题集、全部正式job及其原始对话/bundle/代码快照、报告、视频、生成代码、工作树patch和token统计。\n\n共${trials.length}条终态记录，其中${llm.length}条LLM；状态：${JSON.stringify(states)}。失败记录保留，不计成成功。\n\n本目录只读，脚本拒绝同名覆盖；MANIFEST.json逐文件SHA-256可检测改动。原工作目录后续被改写不影响此独立副本。\n只读和校验防止误覆盖，不替代异地备份。密钥文件与node_modules不归档。\n\n校验命令：\n\n\`\`\`bash\nnode scripts/freeze-experiment.mjs --archive "${archive}" --verify\n\`\`\`\n`);
const entries=files(archive).map(p=>{const b=fs.readFileSync(p);return {path:path.relative(archive,p),bytes:b.length,sha256:sha(b)};});
const manifest=JSON.stringify({format:'sweet-sim.sealed-experiment/v1',created:new Date().toISOString(),trials:trials.length,files:entries},null,2)+'\n';
fs.writeFileSync(path.join(archive,'MANIFEST.json'),manifest);fs.writeFileSync(path.join(archive,'MANIFEST.sha256'),sha(manifest)+'\n');
function seal(dir){for(const d of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,d.name);if(d.isDirectory())seal(p);else fs.chmodSync(p,0o444);}fs.chmodSync(dir,0o555);}
seal(archive);
console.log(JSON.stringify({archive,trials:trials.length,files:entries.length,manifest_sha256:sha(manifest),tokens},null,2));
