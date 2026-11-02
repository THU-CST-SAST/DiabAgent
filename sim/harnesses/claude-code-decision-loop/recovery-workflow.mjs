import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export const CERTIFICATE_VERSION='claude-code-recovery-engine/v1';
export const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
export const fileSha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const valueSha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const resolved=(root,rel)=>{const file=path.resolve(root,rel);assert(file.startsWith(fs.realpathSync(root)+path.sep),'Path escaped registered root');assert.equal(fs.realpathSync(file),file,'Symlinked recovery input refused');return file;};

export function recoveryRoute({state,status,authFailure=false,checkpointSupported=false,unfinished=false,unfinishedAuthorized=false}){
  if(state==='complete'||state==='done')return 'skip_complete';
  if(authFailure||status===401||status===403)return 'stop_auth';
  if(state==='running')return 'leave_live_task';
  if(unfinished&&!unfinishedAuthorized)return 'needs_authorization';
  if(checkpointSupported)return 'resume_cached_engine';
  return 'needs_engineering';
}

// Certify an engine release once from existing receipts. This never runs a test or an API probe.
export function certifyRecoveryEngine(qualificationRoot){
  const root=fs.realpathSync(qualificationRoot),control=root+'/control',plan=readJson(root+'/QUALIFICATION-PLAN.json'),core=readJson(root+'/CORE/RESULT.json');
  assert(core.qualification_passed&&core.failed===0&&core.passed>=38&&core.actual_upstream_API_calls===0);
  const source=new Map();
  for(const f of [...core.source,...plan.source]){
    assert.equal(path.basename(f.file),f.file);assert.equal(fileSha(resolved(control,f.file)),f.sha256);
    if(source.has(f.file))assert.equal(source.get(f.file),f.sha256);source.set(f.file,f.sha256);
  }
  for(const name of ['model.mjs','native-session.mjs','worker-live.mjs','audit.mjs','native-registered-prefix.mjs'])assert(source.has(name),'Incomplete engine source pin');
  const receipts=plan.tasks.map((task,i)=>{
    const file=root+'/FULL-'+i+'/RESULT.json',r=readJson(file);
    assert(r.all_passed&&r.audit.valid&&r.actual_upstream_API_calls===0&&r.stats.env_steps===864);
    return {file,sha256:fileSha(file),lineage_version:task.registered_prefix?.lineage_version??null};
  });
  assert(receipts.length>0);
  const runtime=readJson(control+'/runtime/SOURCE-MANIFEST.json');
  for(const f of runtime.files)assert.equal(fileSha(resolved(control+'/runtime',f.path)),f.sha256);
  assert.equal(fileSha(plan.binary),core.binary_sha256);assert.equal(core.claude_code_version,'2.1.296');
  const payload={version:CERTIFICATE_VERSION,control,qualification_root:root,model:plan.model,
    source:[...source].map(([file,sha256])=>({file,sha256})),runtime_manifest_sha256:fileSha(control+'/runtime/SOURCE-MANIFEST.json'),
    binary_sha256:core.binary_sha256,claude_code_version:core.claude_code_version,
    core:{file:root+'/CORE/RESULT.json',sha256:fileSha(root+'/CORE/RESULT.json')},full72h:receipts,
    supported_prefix_versions:[...new Set(receipts.map(r=>r.lineage_version).filter(Boolean))],
    limits:{native_turns:7,Read:3,simulate:2,history:3,logical_timeout_ms:240000},qualification_upstream_API_calls:0};
  return {...payload,certificate_sha256:valueSha(payload)};
}

export function verifyRecoveryCertificate(certificate){
  const {certificate_sha256,...payload}=certificate;
  assert.equal(certificate.version,CERTIFICATE_VERSION);assert.equal(valueSha(payload),certificate_sha256,'Recovery certificate changed');
  const core=readJson(certificate.core.file);assert.equal(fileSha(certificate.core.file),certificate.core.sha256);
  assert(core.qualification_passed&&core.failed===0&&core.actual_upstream_API_calls===0);
  for(const r of certificate.full72h){assert.equal(fileSha(r.file),r.sha256);const result=readJson(r.file);assert(result.all_passed&&result.audit.valid&&result.actual_upstream_API_calls===0);}
  for(const f of certificate.source)assert.equal(fileSha(resolved(certificate.control,f.file)),f.sha256,'Engine source changed; new qualification required');
  assert.equal(fileSha(certificate.control+'/runtime/SOURCE-MANIFEST.json'),certificate.runtime_manifest_sha256);
  return certificate;
}

export function targetProcesses(targets,{procRoot='/proc'}={}){
  const found=[];
  for(const pid of fs.readdirSync(procRoot).filter(n=>/^\d+$/.test(n))){
    if(Number(pid)===process.pid)continue;
    try{
      const exe=fs.readlinkSync(procRoot+'/'+pid+'/exe');if(!/(node|claude\.exe)$/.test(exe))continue;
      const cwd=fs.readlinkSync(procRoot+'/'+pid+'/cwd'),argv=fs.readFileSync(procRoot+'/'+pid+'/cmdline','utf8');
      if(targets.some(root=>cwd===root||cwd.startsWith(root+path.sep)||argv.includes(root)))found.push(Number(pid));
    }catch(e){if(!['ENOENT','ESRCH','EACCES','EPERM'].includes(e.code))throw e;}
  }
  return found;
}

// Per-resumption checks only: source/state/budget/ownership, never full72h or core test execution.
export async function inspectRegisteredLaunch(root,{certificateFile,inventory=targetProcesses}={}){
  root=fs.realpathSync(root);
  const plan=readJson(root+'/PLAN.json'),ready=readJson(root+'/READY.json');assert(ready.ready);
  for(const name of ['OWNER.json','STATUS.json','LAUNCH.json','SUBMISSION.json','trials'])assert(!fs.existsSync(root+'/'+name),'Source already submitted or trials precreated; reconcile, never relaunch in place');
  for(const f of plan.source)assert.equal(fileSha(resolved(root+'/control',f.file)),f.sha256);
  assert.equal(fileSha(root+'/control/runtime/SOURCE-MANIFEST.json'),plan.runtime_manifest_sha256);
  const runtime=readJson(root+'/control/runtime/SOURCE-MANIFEST.json');for(const f of runtime.files)assert.equal(fileSha(resolved(root+'/control/runtime',f.path)),f.sha256);
  assert.equal(fileSha(plan.binary),plan.binary_sha256);
  const recovering=plan.tasks.filter(t=>t.registered_prefix);
  let certificate=null;
  if(recovering.length){
    const file=certificateFile??root+'/RECOVERY-CERTIFICATE.json';assert(fs.existsSync(file),'Recovery certificate missing; no automatic full-test fallback');
    certificate=verifyRecoveryCertificate(readJson(file));assert.deepEqual(plan.model,certificate.model);
    const qualified=readJson(certificate.full72h[0].file);assert.equal(plan.native_skill.assets_sha256,qualified.skill_assets_sha256,'Skill edition does not match certified engine');
    assert.equal(plan.native_skill.entry_mode,qualified.native_skill_entry);assert.equal(plan.native_skill.guidance_revision,qualified.native_knowledge_guidance);
    assert.equal(plan.binary_sha256,certificate.binary_sha256);assert.equal(plan.runtime_manifest_sha256,certificate.runtime_manifest_sha256);
    for(const f of certificate.source)assert.equal(fileSha(resolved(root+'/control',f.file)),f.sha256,'Prepared root does not use the qualified engine');
    const {inspectNativeRegisteredPrefix}=await import(pathToFileURL(root+'/control/native-registered-prefix.mjs').href);
    for(const t of recovering){
      assert(certificate.supported_prefix_versions.includes(t.registered_prefix.lineage_version),'Unknown checkpoint contract; quarantine for engineering');
      const proof=inspectNativeRegisteredPrefix(t.registered_prefix);
      assert(proof.remaining_native_turns>0&&proof.remaining_native_turns<=certificate.limits.native_turns);
      assert.equal(fileSha(resolved(root+'/control','fixtures/'+t.task_id+'.json')),t.fixture_sha256);
      const source=t.registered_prefix.source,sourceRoot=path.resolve(source,'../..'),sourcePlan=readJson(sourceRoot+'/PLAN.json');
      assert(!['done','complete'].includes(readJson(source+'/stats.json').state),'Completed trajectory must not be resumed');
      assert.deepEqual(readJson(root+'/control/fixtures/'+t.task_id+'.json'),readJson(sourceRoot+'/control/fixtures/'+t.task_id+'.json'),'Recovery fixture changed');
      for(const key of ['model','agent_options','options','max_native_turns_per_decision','logical_timeout_ms','native_skill'])assert.deepEqual(plan[key],sourcePlan[key],'Recovery configuration changed: '+key);
    }
    const active=inventory(recovering.map(t=>t.registered_prefix.source));assert.deepEqual(active,[],'Original target Code/MCP processes still alive');
  }
  assert(Number.isInteger(plan.parallel)&&plan.parallel>0&&plan.parallel<=plan.tasks.length);
  return {ready:true,root,tasks:plan.tasks.length,recoveries:recovering.length,mode:recovering.length?'cached_engine_quick_check':'fresh_registered_launch',
    certificate_sha256:certificate?.certificate_sha256??null,full_tests_run:0,upstream_API_calls:0};
}
