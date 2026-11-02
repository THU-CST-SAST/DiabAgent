#!/usr/bin/env node
import {parseArgs} from '../src/benchmark/cli.mjs';
import {probeModel} from '../src/benchmark/preflight.mjs';
const opt=parseArgs(process.argv.slice(2));
if(!opt.model||!opt.out)throw new Error('--model CONFIG --out NEW_DIRECTORY [--budget-usd USD] [--max-tokens 32..1024] [--require-effort-echo] required');
if(opt['require-effort-echo']!=null&&!['true','false'].includes(opt['require-effort-echo']))throw new Error('--require-effort-echo must be true or false');
const r=await probeModel({modelConfig:opt.model,outDir:opt.out,budgetUsd:opt['budget-usd']==null?null:Number(opt['budget-usd']),maxTokens:Number(opt['max-tokens']??512),requireEffortEcho:opt['require-effort-echo']==='true'});
console.log(JSON.stringify(r,null,2));
if(!r.ok)process.exitCode=1;
