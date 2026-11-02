import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {installCodexKnowledge} from './knowledge.mjs';
import {benchmarkCatalog} from './catalog.mjs';

export const CODEX_VERSION='codex-cli 0.163.0';
export function inspectCodexBinary(binary){
  const bytes=fs.readFileSync(fs.realpathSync(binary));
  assert.notEqual(bytes.subarray(0,2).toString(),'#!','Supply the official native vendor executable, not an npm wrapper');
  const version=cp.execFileSync(binary,['--version'],{encoding:'utf8',timeout:10000}).trim();
  assert.equal(version,CODEX_VERSION,'Only the explicitly requested Codex version is allowed');
  return {version,sha256:createHash('sha256').update(bytes).digest('hex')};
}

/** Native app-server only: never sends model HTTP or loads the user's coding settings. */
export class CodexRpc {
  constructor({binary,root,key,endpoint='https://api.openai.com/v1',onMessage=()=>{},timeoutMs=240000,skillAssetsRoot=null,logSecrets=[],model='gpt-6.1-sol',catalogFile=null,maxReferenceReads=3}){
    assert(path.isAbsolute(root)&&!fs.existsSync(root));assert(typeof key==='string'&&key.length>0);
    const url=new URL(endpoint);assert(url.protocol==='https:'||['127.0.0.1','localhost'].includes(url.hostname));
    if(url.protocol==='http:')assert.equal(key,'offline-dummy-not-a-credential');
    this.identity=inspectCodexBinary(binary);this.root=root;this.timeoutMs=timeoutMs;this.sequence=0;this.pending=new Map();this.onMessage=onMessage;this.closed=false;
    fs.mkdirSync(root,{recursive:true});fs.mkdirSync(root+'/home');fs.mkdirSync(root+'/workspace');
    this.knowledge=skillAssetsRoot?installCodexKnowledge(root,skillAssetsRoot,{maxReads:maxReferenceReads}):null;
    const provider={name:'Registered benchmark provider',base_url:endpoint,env_key:'OPENAI_API_KEY',wire_api:'responses',request_max_retries:0,stream_max_retries:0,stream_idle_timeout_ms:86400000,requires_openai_auth:false,supports_websockets:false};
    const args=['app-server','--stdio','--config','model_provider="benchmark"','--config','model_providers.benchmark='+JSON.stringify(provider)];
    // CLI config expects TOML; a JSON object is not an inline TOML table.
    args[args.length-1]='model_providers.benchmark={'+Object.entries(provider).map(([k,v])=>k+'='+JSON.stringify(v)).join(',')+'}';
    const catalog=root+'/model-catalog.json';
    fs.writeFileSync(catalog,JSON.stringify(benchmarkCatalog(model,catalogFile),null,2));
    args.push('--config','model_catalog_json='+JSON.stringify(catalog),'--config','agents.enabled=false',
      '--config','tools.experimental_request_user_input.enabled=false',
      '--config','include_environment_context=false','--config','include_environment_context_time=false');
    for(const feature of ['code_mode','code_mode_host','code_mode_only','multi_agent','multi_agent_v2','multi_agent_v2_dynamic_tools','collab','goals','sleep_tool','default_mode_request_user_input','shell_tool','unified_exec','apps','web_search'])args.push('--disable',feature);
    this.logSecrets=[key,...logSecrets];
    this.redact=s=>this.logSecrets.reduce((text,secret)=>secret?text.split(secret).join('[REDACTED]'):text,String(s));
    fs.writeFileSync(root+'/LAUNCH.json',JSON.stringify({binary,identity:this.identity,args,endpoint,credential_transport:'env-only',isolated_HOME:true,model_HTTP_owned_by:'official-codex-app-server'},null,2));
    this.child=cp.spawn(binary,args,{cwd:root+'/workspace',detached:true,stdio:['pipe','pipe','pipe'],env:{PATH:path.dirname(process.execPath)+':'+path.dirname(binary)+':/usr/bin:/bin',HOME:root+'/home',CODEX_HOME:root+'/home',TMPDIR:root+'/home',OPENAI_API_KEY:key}});
    key='';let buffer='';
    this.child.stdout.on('data',b=>{buffer+=b;while(buffer.includes('\n')){const i=buffer.indexOf('\n'),line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;try{const message=JSON.parse(line);this.log('stdout.jsonl',message);if(message.id!==undefined&&!message.method){const p=this.pending.get(message.id);if(p){this.pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(Object.assign(new Error(message.error.message),{rpcError:message.error})):p.resolve(message.result);}}else Promise.resolve(this.onMessage(message,this)).catch(e=>this.fail(e));}catch(e){this.fail(e);}}});
    this.child.stderr.on('data',b=>fs.appendFileSync(root+'/stderr.txt',this.redact(b.toString())));
    this.child.on('error',e=>this.fail(e));this.exit=new Promise(resolve=>this.child.on('close',(code,signal)=>{this.fail(new Error('Codex app-server closed'));resolve({code,signal});}));
  }
  log(file,value){fs.appendFileSync(this.root+'/'+file,this.redact(JSON.stringify(value))+'\n');}
  send(message){assert(!this.closed);this.log('client.jsonl',message);this.child.stdin.write(JSON.stringify(message)+'\n');}
  request(method,params={}){const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Object.assign(new Error('Codex RPC deadline: '+method),{code:'CODEX_RPC_DEADLINE'}));},this.timeoutMs);this.pending.set(id,{resolve,reject,timer});this.send({id,method,params});});}
  notify(method,params={}){this.send({method,params});}
  respond(id,result){this.send({id,result});}
  fail(error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();}
  async close(){if(this.closed)return;this.closed=true;this.fail(new Error('Codex session closed'));try{process.kill(-this.child.pid,'SIGTERM');}catch{}const result=await Promise.race([this.exit,new Promise(r=>setTimeout(()=>r(null),2000))]);if(!result){try{process.kill(-this.child.pid,'SIGKILL');}catch{}}fs.writeFileSync(this.root+'/EXIT.json',JSON.stringify(result??await this.exit));this.logSecrets.fill('');this.redact=()=>{throw Error('Closed credential redactor');};}
}
