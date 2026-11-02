import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import {createHash} from 'node:crypto';
import {readCodexHttpEvidence,readCodexRequestEvidence} from '../harnesses/codex-decision-loop/http-evidence.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
test('historical over-redacted ciphertext can only be restored to the exact original pre-redaction checksum',()=>{
 const root=fs.mkdtempSync(os.tmpdir()+'/codex-http-recovery-'),session=root+'/trial/Codex/session-1';fs.mkdirSync(session+'/transport',{recursive:true});
 const cipher='gAAAA_original_safe_sk-opaque_long_encrypted_content=',original=JSON.stringify({encrypted_content:cipher})+'\n'+JSON.stringify({encrypted_content:cipher});
 const masked=original.replace(/sk-[A-Za-z0-9_-]{16,}/g,'[REDACTED]'),file=session+'/transport/1-RESPONSE.txt',witnessFile=session+'/transport/1-RESPONSE.json',replyFile=session+'/NATIVE-REPLY-1.json';
 const witness={response_sha256:sha(original),status:200};fs.writeFileSync(file,masked);fs.writeFileSync(witnessFile,JSON.stringify(witness));fs.writeFileSync(replyFile,JSON.stringify({output:[{type:'reasoning',encrypted_content:cipher}]}));
 const derived=root+'/restored.txt';fs.writeFileSync(derived,original);
 const entry={original_file:file,original_sha256:sha(masked),witness_file:witnessFile,witness_sha256:sha(fs.readFileSync(witnessFile)),reply_file:replyFile,reply_sha256:sha(fs.readFileSync(replyFile)),reply_reasoning_index:0,derived_file:derived,derived_sha256:sha(original),restored_occurrences:2};
 const registration={version:'exact-http-redaction-recovery/v1',source:root,entries:[entry],new_model_calls:0,original_logs_unmodified:true},manifest=root+'/MANIFEST.json';fs.writeFileSync(manifest,JSON.stringify(registration));
 assert.throws(()=>readCodexHttpEvidence(file,witness));
 const result=readCodexHttpEvidence(file,witness,{recoveryManifest:manifest});assert.equal(result.text,original);assert.equal(result.recovery.restored_occurrences,2);assert.equal(fs.readFileSync(file,'utf8'),masked);
 const v2={version:'exact-transport-redaction-recovery/v2',source:root,new_model_calls:0,original_logs_unmodified:true,entries:[{original_file:file,original_sha256:sha(masked),witness_file:witnessFile,witness_sha256:sha(fs.readFileSync(witnessFile)),checksum_type:'raw-bytes',expected_sha256:sha(original),derived_file:derived,derived_sha256:sha(original),restorations:[{reply_file:replyFile,reply_sha256:sha(fs.readFileSync(replyFile)),reply_reasoning_index:0,restored_occurrences:2}]}]};
 fs.writeFileSync(manifest,JSON.stringify(v2));assert.equal(readCodexHttpEvidence(file,witness,{recoveryManifest:manifest}).text,original);
 const wrong=structuredClone(v2);wrong.entries[0].expected_sha256='0'.repeat(64);fs.writeFileSync(manifest,JSON.stringify(wrong));assert.throws(()=>readCodexHttpEvidence(file,witness,{recoveryManifest:manifest}));
 for(const mutate of [r=>r.entries[0].derived_sha256='0'.repeat(64),r=>r.entries[0].original_sha256='0'.repeat(64),r=>r.entries[0].restored_occurrences=3,r=>r.new_model_calls=1]){
  const bad=structuredClone(registration);mutate(bad);fs.writeFileSync(manifest,JSON.stringify(bad));assert.throws(()=>readCodexHttpEvidence(file,witness,{recoveryManifest:manifest}));
 }
 fs.writeFileSync(manifest,JSON.stringify(registration));fs.writeFileSync(derived,original+' changed');assert.throws(()=>readCodexHttpEvidence(file,witness,{recoveryManifest:manifest}));
});

test('request recovery proves original canonical JSON and changes only opaque reasoning fields',()=>{
 const root=fs.mkdtempSync(os.tmpdir()+'/codex-request-recovery-'),session=root+'/trial/Codex/session-2',earlier=root+'/trial/Codex/session-1';fs.mkdirSync(session+'/transport',{recursive:true});fs.mkdirSync(earlier,{recursive:true});
 const cipher='gAAAA_prior_native_sk-opaque_long_encrypted_content=',masked=cipher.replace(/sk-[A-Za-z0-9_-]{16,}/g,'[REDACTED]');
 const before={input:[{type:'reasoning',encrypted_content:cipher},{type:'message',content:[{text:'unchanged'}]}]},replyFile=earlier+'/NATIVE-REPLY-1.json';fs.writeFileSync(replyFile,JSON.stringify({output:[{type:'reasoning',encrypted_content:cipher}]}));
 const witnessFile=session+'/transport/2-BODY-DELTA.json',witness={native_sha256:sha(JSON.stringify(before)),upstream_sha256:sha(JSON.stringify(before))};fs.writeFileSync(witnessFile,JSON.stringify(witness));
 const manifestFile=root+'/MANIFEST.json',entries=[];
 for(const name of ['2-NATIVE-REQUEST.json','2-NATIVE-BYTES.txt','2-UPSTREAM-REQUEST.json']){
  const original=JSON.stringify(before,null,name.endsWith('.json')?2:0),redacted=original.replaceAll(cipher,masked),file=session+'/transport/'+name,derived=root+'/'+name;fs.writeFileSync(file,redacted);fs.writeFileSync(derived,original);
  entries.push({original_file:file,original_sha256:sha(redacted),witness_file:witnessFile,witness_sha256:sha(fs.readFileSync(witnessFile)),checksum_type:'canonical-json',expected_sha256:witness.native_sha256,derived_file:derived,derived_sha256:sha(original),restorations:[{reply_file:replyFile,reply_sha256:sha(fs.readFileSync(replyFile)),reply_reasoning_index:0,restored_occurrences:1}]});
 }
 const manifest={version:'exact-transport-redaction-recovery/v2',source:root,entries,new_model_calls:0,original_logs_unmodified:true};fs.writeFileSync(manifestFile,JSON.stringify(manifest));
 for(const entry of entries){assert.throws(()=>readCodexRequestEvidence(entry.original_file,witness));assert.deepEqual(readCodexRequestEvidence(entry.original_file,witness,{recoveryManifest:manifestFile}).value,before);}
 const file=entries[0].original_file;
 for(const mutate of [m=>m.entries[0].expected_sha256='0'.repeat(64),m=>m.entries[0].checksum_type='raw-bytes',m=>m.entries[0].restorations[0].reply_sha256='0'.repeat(64),m=>m.entries[0].restorations[0].restored_occurrences=2,m=>m.entries[0].restorations.push(m.entries[0].restorations[0]),m=>m.original_logs_unmodified=false,m=>m.new_model_calls=1]){
  const bad=structuredClone(manifest);mutate(bad);fs.writeFileSync(manifestFile,JSON.stringify(bad));assert.throws(()=>readCodexRequestEvidence(file,witness,{recoveryManifest:manifestFile}));
 }
 fs.writeFileSync(manifestFile,JSON.stringify(manifest));assert.throws(()=>readCodexRequestEvidence(file,{...witness,native_sha256:'0'.repeat(64)},{recoveryManifest:manifestFile}));
 fs.writeFileSync(entries[0].derived_file,JSON.stringify({...before,invented:true}));assert.throws(()=>readCodexRequestEvidence(file,witness,{recoveryManifest:manifestFile}));
});

test('matching hashes do not permit redaction recovery of ordinary factual message text',()=>{
 const root=fs.mkdtempSync(os.tmpdir()+'/codex-recovery-facts-'),session=root+'/trial/Codex/session-1';fs.mkdirSync(session+'/transport',{recursive:true});
 const cipher='gAAAA_native_sk-opaque_long_encrypted_content=',original=JSON.stringify({input:[{type:'message',text:cipher}]}),masked=original.replace(/sk-[A-Za-z0-9_-]{16,}/g,'[REDACTED]');
 const file=session+'/transport/1-NATIVE-REQUEST.json',witnessFile=session+'/transport/1-BODY-DELTA.json',reply=session+'/NATIVE-REPLY-1.json',derived=root+'/derived.json',manifestFile=root+'/MANIFEST.json',witness={native_sha256:sha(original)};
 fs.writeFileSync(file,masked);fs.writeFileSync(witnessFile,JSON.stringify(witness));fs.writeFileSync(reply,JSON.stringify({output:[{type:'reasoning',encrypted_content:cipher}]}));fs.writeFileSync(derived,original);
 fs.writeFileSync(manifestFile,JSON.stringify({version:'exact-transport-redaction-recovery/v2',source:root,new_model_calls:0,original_logs_unmodified:true,entries:[{original_file:file,original_sha256:sha(masked),witness_file:witnessFile,witness_sha256:sha(fs.readFileSync(witnessFile)),checksum_type:'canonical-json',expected_sha256:sha(original),derived_file:derived,derived_sha256:sha(original),restorations:[{reply_file:reply,reply_sha256:sha(fs.readFileSync(reply)),reply_reasoning_index:0,restored_occurrences:1}]}]}));
 assert.throws(()=>readCodexRequestEvidence(file,witness,{recoveryManifest:manifestFile}));
});
