import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {maskedScenario} from '../src/experiments/scenario-masks.mjs';
import {buildInstanceConfig} from '../src/sim/instance.mjs';
import {SimEnv} from '../src/env/pomdp.mjs';
import {Pump} from '../src/core/delivery.mjs';
import {iobAt,cobAt} from '../src/core/estimators.mjs';
import {optionsPromptText} from '../src/bench/prompt.mjs';
import {KNOWLEDGE} from '../src/knowledge.mjs';
import {planScenarioPipeline} from '../src/experiments/scenario-pipeline.mjs';
import {runEpisode} from '../src/bench/harness.mjs';
import {MEMORY_PROMPT_REVISION} from '../src/bench/prompt-revisions.mjs';

function make({own=true,mode='I2',preset='A03'}={}) {
  const cfg=buildInstanceConfig(maskedScenario({preset}).variants[mode]);
  cfg.information.own_records=own;
  cfg.safety.bolus_min_interval_minutes=0;cfg.safety.block_bolus_below_mg_dl=0;
  return new SimEnv(cfg);
}
const apply=(env,action,id='test',source='agent')=>env.world.apply(action,id,source);

test('I2 includes own accepted bolus/carbs before estimation, keeps hidden prior inputs hidden',()=>{
  const env=make(),w=env.world;
  assert.equal(env.observe().iob.total_u,0);assert.equal(env.observe().cob.estimate_g,0);
  assert.equal(apply(env,{type:'INGEST_CARBS',grams:10},'own-carbs').status,'applied');
  assert.equal(apply(env,{type:'BOLUS',units:1},'own-dose').status,'applied');
  w.advanceTo(w.now+5*60000);
  const obs=env.observe();
  assert.ok(obs.iob.total_u>0&&obs.iob.total_u<1);
  assert.ok(obs.cob.estimate_g>0&&obs.cob.estimate_g<10);
  assert.deepEqual(obs.reported_carbs.map(c=>c.source),['agent_rescue_carbs']);
  assert.ok(obs.device.insulin_ledger.length>0);
  assert.ok(w.visibleLedger().every(r=>r.source==='agent'));
  assert.ok(w.device.ledger.length>w.visibleLedger().length);
  assert.equal(obs.iob.total_u,iobAt(w.visibleLedger(),w.now,obs.profile.dia_hours,obs.insulin.rapid_iob_curve).iob);
  assert.equal(obs.cob.estimate_g,cobAt(w.visibleCarbs(),w.now,w.config.estimates.cob_absorption_minutes).cob);
  assert.equal(obs.information.own_records,true);assert.equal(obs.iob.history_complete,false);
  assert.equal(obs.device.last_bolus.units,1);assert.equal(obs.device.reservoir_u,null);
});

test('online external treatment/carbs stay hidden, own rejection does not enter estimates',()=>{
  const env=make(),w=env.world;
  assert.equal(apply(env,{type:'BOLUS',units:2},'external','patient_routine').status,'applied');
  assert.equal(apply(env,{type:'INGEST_CARBS',grams:20},'external-carbs','patient').status,'applied');
  w.advanceTo(w.now+5*60000);
  assert.equal(env.observe().iob.total_u,0);assert.equal(env.observe().cob.estimate_g,0);
  assert.equal(apply(env,{type:'BOLUS',units:1},'own').status,'applied');
  assert.equal(env.observe().iob.bolus_u,1);
  assert.equal(apply(env,{type:'BOLUS',units:999},'rejected').status,'rejected');
  assert.equal(env.observe().iob.bolus_u,1);
  assert.equal(w.visibleLedger().length,1);
});

test('same five-minute basal bucket never merges own and external origins',()=>{
  const p=new Pump({model:'dana_i',scheduledBasalUph:1,reservoirU:100,recordSources:true});
  p.setTemp(2,60,0);p.temp.source='patient';p.deliver(0,1);
  p.setTemp(1.5,60,60000);p.temp.source='agent';p.deliver(60000,1);
  assert.equal(p.ledger.length,2);assert.equal(p.ledger[0].source,'patient');assert.equal(p.ledger[1].source,'agent');
  assert.ok(Math.abs(p.ledger[0].units-1/60)<1e-12);assert.ok(Math.abs(p.ledger[1].units-.5/60)<1e-12);
});

test('own temporary basal, suspension and extended delivery retain source and snapshot continuity',()=>{
  const env=make(),w=env.world;
  assert.equal(apply(env,{type:'TEMP_BASAL',percent:150,duration_minutes:60},'temp').status,'applied');
  w.advanceTo(w.now+10*60000);assert.ok(env.observe().iob.basal_u>0);
  assert.equal(apply(env,{type:'EXTENDED_BOLUS',units:1,duration_minutes:60},'extended').status,'applied');
  w.advanceTo(w.now+10*60000);
  assert.ok(w.visibleLedger().some(d=>d.kind==='extended'));
  const before=w.visibleLedger().filter(d=>d.kind==='extended').reduce((s,d)=>s+d.units,0);
  assert.equal(apply(env,{type:'CANCEL_EXTENDED_BOLUS'},'cancel').status,'applied');
  assert.equal(apply(env,{type:'SUSPEND_PUMP',minutes:30},'suspend').status,'applied');
  const saved=env.snapshot(),restored=SimEnv.restore(saved);
  w.advanceTo(w.now+10*60000);restored.world.advanceTo(restored.world.now+10*60000);
  assert.deepEqual(env.observe(),restored.observe());
  assert.equal(w.visibleLedger().filter(d=>d.kind==='extended').reduce((s,d)=>s+d.units,0),before);
  assert.ok(w.visibleLedger().some(d=>d.kind==='basal'&&d.units<0));
});

test('cancelled own bolus retains only device-recorded delivered amount',()=>{
  const env=make(),w=env.world;
  const dose=apply(env,{type:'BOLUS',units:2},'slow');assert.equal(dose.status,'applied');
  assert.ok(dose.applied.delivery_minutes>0);
  w.advanceTo(w.now+1000);
  const cancel=apply(env,{type:'CANCEL_BOLUS'},'cancel');assert.equal(cancel.status,'applied');
  const doseEntry=w.visibleLedger().find(d=>d.kind==='bolus');
  assert.ok(doseEntry.units>0&&doseEntry.units<2);assert.equal(doseEntry.units,cancel.applied.delivered_u);
});

test('known IOB does not reveal hidden tissue delivery fraction',()=>{
  const a=make(),b=make();
  b.world.active.push({type:'infusion_deficit',delivered_fraction:.1,until:b.now+3600000});
  for(const env of [a,b]){apply(env,{type:'BOLUS',units:1},'own');env.world.advanceTo(env.now+10*60000);}
  assert.equal(a.observe().iob.total_u,b.observe().iob.total_u);
  assert.ok(a.metrics.rapid_delivered_u>b.metrics.rapid_delivered_u);
  assert.notDeepEqual(a.world.physiology.snapshot(),b.world.physiology.snapshot());
});

test('only observation bookkeeping changes: fixed-action physiology and rewards match legacy exactly',()=>{
  for(const mode of ['I0','I1','I2']) {
    const a=make({own:false,mode}),b=make({own:true,mode});
    for(const [i,action]of [{type:'BOLUS',units:1},{type:'INGEST_CARBS',grams:10},
      {type:'TEMP_BASAL',percent:150,duration_minutes:60},{type:'EXTENDED_BOLUS',units:1,duration_minutes:60},
      {type:'CANCEL_EXTENDED_BOLUS'},{type:'SUSPEND_PUMP',minutes:30},{type:'RESUME_PUMP'},
      ...Array.from({length:30},()=>({type:'WAIT'}))].entries()) {
      const x=a.step({action_id:'same-'+i,expected_step:i,action}),y=b.step({action_id:'same-'+i,expected_step:i,action});
      assert.deepEqual(x.info.action_result,y.info.action_result);
      assert.deepEqual(a.physiology.snapshot(),b.physiology.snapshot());assert.deepEqual(a.metrics,b.metrics);
    }
  }
});

test('own-record prompt is explicit without changing the legacy default wording',()=>{
  const opts={decision_schedule:'hourly',max_extra_decisions_per_day:6,memory:'notes'};
  assert.match(optionsPromptText(opts),/does not restore missing external NS records or change record-derived IOB/);
  assert.match(optionsPromptText(opts,{ownRecords:true}),/accepted treatment and carbohydrate records are included/);
  assert.doesNotMatch(optionsPromptText(opts,{ownRecords:true}),/or change record-derived IOB/);
});

test('MDI keeps own rapid injections and long-acting receipt status, hides external injections',()=>{
  const cfg=buildInstanceConfig({...KNOWLEDGE.instances.older_mdi_smbg.spec,seed:1});
  cfg.information={mode:'I2',policy:'record-derived-v3',rules:[],own_records:true};
  cfg.safety.bolus_min_interval_minutes=0;cfg.safety.block_bolus_below_mg_dl=0;
  const env=new SimEnv(cfg);
  assert.equal(apply(env,{type:'BOLUS',units:1},'own').status,'applied');
  assert.equal(env.observe().iob.bolus_u,1);
  assert.equal(apply(env,{type:'BOLUS',units:2},'external','patient_routine').status,'applied');
  assert.equal(env.observe().iob.bolus_u,1);assert.equal(env.observe().device.last_bolus,null);
  assert.equal(apply(env,{type:'BASAL_INJECTION',units:1},'basal').status,'applied');
  assert.equal(env.observe().device.last_basal_injection.units,1);
  assert.equal(env.observe().iob.bolus_u,1,'long-acting is not incorrectly counted as rapid IOB');
});

test('I0 never double-counts an own receipt already present in the device ledger',()=>{
  const env=make({mode:'I0'}),w=env.world;
  assert.equal(apply(env,{type:'BOLUS',units:1},'own').status,'applied');
  const obs=env.observe(),expected=iobAt(w.device.ledger,w.now,obs.profile.dia_hours,obs.insulin.rapid_iob_curve);
  assert.equal(obs.iob.total_u,expected.iob);assert.equal(w.visibleLedger().length,w.device.ledger.length);
});

test('pipeline enables own records uniformly without changing event seeds, patient, hardware or external masks',()=>{
  const config={name:'own-records-test',scenarios:['A03'],information:['I0','I1','I2']};
  const old=planScenarioPipeline(config),next=planScenarioPipeline({...config,include_own_records:true});
  assert.deepEqual(old.counts,next.counts);assert.deepEqual(old.rows[0].rules,next.rows[0].rules);
  for(const mode of ['I0','I1','I2']) {
    const a=buildInstanceConfig(old.rows[0].variants[mode]),b=buildInstanceConfig(next.rows[0].variants[mode]);
    assert.equal(b.information.own_records,true);assert.equal(a.information.own_records,false);
    delete a.information;delete b.information;assert.deepEqual(a,b);
  }
  assert.throws(()=>planScenarioPipeline({...config,include_own_records:'true'}),/must be boolean/);
});

test('seven-day controller sees own IOB/COB after daily memory resets without restoring external records',async t=>{
  const spec=structuredClone(maskedScenario({preset:'A03'}).variants.I2);
  spec.overrides.information.own_records=true;
  spec.overrides.safety={...spec.overrides.safety,bolus_min_interval_minutes:0,block_bolus_below_mg_dl:0};
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'own-records-week-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let calls=0,afterMidnight=0,afterCarbs=0;
  const model={name:'own-records-fixture',config:{},async complete({system,obs}) {
    assert.match(system,/accepted treatment and carbohydrate records are included/);
    const hour=Math.round(obs.elapsed_minutes/60),within=hour%24;
    if(hour===0){assert.equal(obs.iob.total_u,0);assert.equal(obs.cob.estimate_g,0);}
    if(hour>0&&within===0){assert.ok(obs.iob.bolus_u>0);afterMidnight++;}
    if(hour>1&&within===1){assert.ok(obs.cob.estimate_g>0);afterCarbs++;}
    return {tool_call:{id:'own-'+calls++,name:'act',input:{action:within===23?{type:'BOLUS',units:1}
      :within===0&&hour>0?{type:'INGEST_CARBS',grams:10}:{type:'WAIT'},wait_minutes:60,wake_on:[],note:'fixture',note_to_self:'ordinary persistent note'}},
      text:'',usage:{input_tokens:0,output_tokens:0}};
  }};
  const result=await runEpisode({instance:{id:'own-records-week',spec},model,outDir:dir,hours:168,maxTurns:180,
    agentOptions:{decision_schedule:'hourly',max_extra_decisions_per_day:0,memory:'notes',keep_turns:1,prompt_revision:MEMORY_PROMPT_REVISION}});
  assert.equal(result.state,'done');assert.equal(calls,168);assert.equal(afterMidnight,6);assert.equal(afterCarbs,6);
});
