// HTTP application of the live service (upstream src/server.js createApp): Nightscout reads,
// public view, live streams, bearer-authenticated admin API and static pages.
import express from 'express';
import {fileURLToPath} from 'node:url';
import {timingSafeEqual} from 'node:crypto';
import {mountNightscout} from './nightscout.mjs';
import {mountLive,viewSnapshot} from './streams.mjs';

export const PUBLIC_DIR=fileURLToPath(new URL('../../public',import.meta.url));

export function createApp(service,relay,token,adminDir) {
  const app=express();app.disable('x-powered-by');app.set('query parser','extended');app.use(express.json({limit:'32kb'}));
  app.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
  const auth=(req,res,next)=>{
    const input=Buffer.from((req.headers.authorization??'').replace(/^Bearer /,'')),expected=Buffer.from(token);
    if(input.length!==expected.length||!timingSafeEqual(input,expected))return res.status(401).json({error:'Authentication required'});next();
  };
  mountNightscout(app,service,relay);
  app.get('/api/view',(_,res)=>res.json({...viewSnapshot(service),sentAt:Date.now()}));
  mountLive(app,service,relay,auth,token);
  app.use('/api/admin',auth);
  app.patch('/api/admin/config',(req,res)=>res.json(service.transaction(s=>s.changeConfig(req.body))));
  app.post('/api/admin/fast-forward',(req,res)=>res.status(202).json(req.body.targetTime!==undefined
    ?service.fastForwardTo(typeof req.body.targetTime==='string'?Date.parse(req.body.targetTime):NaN)
    :service.fastForward(Number(req.body.minutes))));
  app.post('/api/admin/pump-maintenance',(req,res)=>res.json(service.transaction(s=>s.pumpMaintenance(req.body))));
  app.post('/api/admin/commands',async(req,res,next)=>{try {res.status(202).json(await relay.send(req.body.cmd,req.body.reason));}catch(e){next(e);}});
  if(adminDir)app.use('/console',express.static(adminDir));
  app.use(express.static(PUBLIC_DIR));
  app.use((err,req,res,next)=>res.status(400).json({error:err.message,code:err.code??'REQUEST_FAILED',relayStatus:err.relayStatus??null,detail:err.detail??null}));
  return app;
}
