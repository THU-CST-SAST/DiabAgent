import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const sha=x=>createHash('sha256').update(x).digest('hex');
const read=f=>JSON.parse(fs.readFileSync(f));

function recoveryEntry(file,manifestFile){
 const manifest=read(manifestFile);assert.equal(manifest.version,'exact-transport-redaction-recovery/v2');assert.equal(manifest.new_model_calls,0);assert.equal(manifest.original_logs_unmodified,true);
 const resolved=fs.realpathSync(file),root=fs.realpathSync(manifest.source);assert(resolved.startsWith(root+'/trial/Codex/'));
 const entries=manifest.entries.filter(e=>fs.realpathSync(e.original_file)===resolved);assert.equal(entries.length,1);const entry=entries[0];
 const original=fs.readFileSync(resolved,'utf8');assert.equal(sha(original),entry.original_sha256);
 const name=path.basename(resolved),session=path.dirname(path.dirname(resolved)),n=name.match(/^\d+/)?.[0];assert(n);
 const response=name===n+'-RESPONSE.txt';
 const fields={[n+'-NATIVE-REQUEST.json']:'native_sha256',[n+'-NATIVE-BYTES.txt']:'native_sha256',[n+'-UPSTREAM-REQUEST.json']:'upstream_sha256'};
 const field=response?'response_sha256':fields[name];assert(field,'Unregistered evidence filename');
 const witnessFile=session+'/transport/'+n+(response?'-RESPONSE.json':'-BODY-DELTA.json');
 assert.equal(fs.realpathSync(entry.witness_file),fs.realpathSync(witnessFile));assert.equal(sha(fs.readFileSync(witnessFile)),entry.witness_sha256);
 const witness=read(witnessFile);assert.equal(entry.checksum_type,response?'raw-bytes':'canonical-json');assert.equal(entry.expected_sha256,witness[field]);
 assert(Array.isArray(entry.restorations)&&entry.restorations.length>0);
 let restored=original;const replacements=new Map();
 for(const item of entry.restorations){
  const replyFile=fs.realpathSync(item.reply_file);assert(replyFile.startsWith(root+'/trial/Codex/'));assert(/^NATIVE-REPLY-\d+\.json$/.test(path.basename(replyFile)));
  assert.equal(sha(fs.readFileSync(replyFile)),item.reply_sha256);
  const block=read(replyFile).output[item.reply_reasoning_index];assert.equal(block.type,'reasoning');const cipher=block.encrypted_content;
  assert(typeof cipher==='string'&&cipher.startsWith('gAAAA')&&/^[A-Za-z0-9_=-]+$/.test(cipher));assert(!/\bsk-[a-f0-9]{64}\b/.test(cipher));
  const masked=cipher.replace(/sk-[A-Za-z0-9_-]{16,}/g,'[REDACTED]');assert.notEqual(masked,cipher);assert(!replacements.has(masked),'Ambiguous or duplicate opaque restoration');replacements.set(masked,cipher);
  assert.equal(original.split(masked).length-1,item.restored_occurrences);assert(item.restored_occurrences>0);
  restored=restored.split(masked).join(cipher);
 }
 if(!response){
  // A request repair may change only complete encrypted_content values, never other input.
  const walk=value=>{
   if(Array.isArray(value))return value.map(walk);
   if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,key==='encrypted_content'&&replacements.has(v)?replacements.get(v):walk(v)]));
   return value;
  };
  assert.deepEqual(JSON.parse(restored),walk(JSON.parse(original)));
 }
 assert.equal(sha(response?restored:JSON.stringify(JSON.parse(restored))),witness[field],'Recovered evidence must match its original pre-redaction commitment');
 assert.equal(sha(restored),entry.derived_sha256);assert.equal(fs.readFileSync(entry.derived_file,'utf8'),restored);
 return {text:restored,recovery:{manifest:fs.realpathSync(manifestFile),manifest_sha256:sha(fs.readFileSync(manifestFile)),original_file:resolved,original_redacted_sha256:entry.original_sha256,checksum_type:entry.checksum_type,original_evidence_sha256:witness[field],restored_occurrences:entry.restorations.reduce((n,r)=>n+r.restored_occurrences,0),original_logs_unmodified:true,new_model_calls:0}};
}

export function readCodexRequestEvidence(file,witness,{recoveryManifest=null}={}){
 const field=path.basename(file).includes('-UPSTREAM-')?'upstream_sha256':'native_sha256',original=fs.readFileSync(file,'utf8');
 if(sha(JSON.stringify(JSON.parse(original)))===witness[field])return {value:JSON.parse(original),recovery:null};
 assert(recoveryManifest,'Original request commitment mismatch; explicit exact recovery is required');
 const evidence=recoveryEntry(file,recoveryManifest);
 assert.deepEqual(read(file.replace(/\d+-(?:NATIVE-REQUEST\.json|NATIVE-BYTES\.txt|UPSTREAM-REQUEST\.json)$/,path.basename(file).match(/^\d+/)[0]+'-BODY-DELTA.json')),witness);
 return {value:JSON.parse(evidence.text),recovery:evidence.recovery};
}

/** Only an exact pre-redaction hash match can repair historical, over-redacted ciphertext logs. */
export function readCodexHttpEvidence(file,witness,{recoveryManifest=null}={}){
 const original=fs.readFileSync(file,'utf8');
 if(sha(original)===witness.response_sha256)return {text:original,recovery:null};
 assert(recoveryManifest,'Original HTTP evidence hash mismatch; explicit exact recovery is required');
 if(read(recoveryManifest).version==='exact-transport-redaction-recovery/v2'){
  assert.deepEqual(read(file.replace(/\.txt$/,'.json')),witness);return recoveryEntry(file,recoveryManifest);
 }
 const manifest=read(recoveryManifest);assert.equal(manifest.version,'exact-http-redaction-recovery/v1');assert.equal(manifest.new_model_calls,0);assert.equal(manifest.original_logs_unmodified,true);
 const resolved=fs.realpathSync(file),root=fs.realpathSync(manifest.source);assert(resolved.startsWith(root+'/trial/Codex/'));
 const entries=manifest.entries.filter(e=>fs.realpathSync(e.original_file)===resolved);assert.equal(entries.length,1);const entry=entries[0];
 assert.equal(sha(original),entry.original_sha256);assert.equal(fs.realpathSync(entry.witness_file),fs.realpathSync(file.replace(/\.txt$/,'.json')));
 assert.equal(sha(fs.readFileSync(entry.witness_file)),entry.witness_sha256);assert.deepEqual(read(entry.witness_file),witness);
 const session=path.dirname(path.dirname(resolved));assert.equal(path.dirname(fs.realpathSync(entry.reply_file)),session);assert(/^NATIVE-REPLY-\d+\.json$/.test(path.basename(entry.reply_file)));
 assert.equal(sha(fs.readFileSync(entry.reply_file)),entry.reply_sha256);
 const block=read(entry.reply_file).output[entry.reply_reasoning_index];assert.equal(block.type,'reasoning');const cipher=block.encrypted_content;
 assert(typeof cipher==='string'&&cipher.startsWith('gAAAA')&&/^[A-Za-z0-9_=-]+$/.test(cipher));assert(!/\bsk-[a-f0-9]{64}\b/.test(cipher));
 const oldMask=cipher.replace(/sk-[A-Za-z0-9_-]{16,}/g,'[REDACTED]');assert.notEqual(oldMask,cipher);
 assert.equal(original.split(oldMask).length-1,entry.restored_occurrences);assert(entry.restored_occurrences>0);
 const restored=original.split(oldMask).join(cipher);assert.equal(sha(restored),witness.response_sha256,'Recovered bytes must equal the original checksum, not a guessed response');
 assert.equal(entry.derived_sha256,witness.response_sha256);assert.equal(fs.readFileSync(entry.derived_file,'utf8'),restored);
 return {text:restored,recovery:{manifest:fs.realpathSync(recoveryManifest),manifest_sha256:sha(fs.readFileSync(recoveryManifest)),original_file:resolved,original_redacted_sha256:entry.original_sha256,original_response_sha256:witness.response_sha256,restored_occurrences:entry.restored_occurrences,original_logs_unmodified:true,new_model_calls:0}};
}
