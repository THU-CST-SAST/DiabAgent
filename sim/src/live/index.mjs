// Live service entry points. src/server.js (used by scripts/deploy.js and `npm start`) calls
// startFromEnv(); tests use startLiveServer() with an in-memory store and an accelerated clock.
import path from 'node:path';
import {Store} from './store.mjs';
import {LiveService} from './service.mjs';
import {Relay} from './relay.mjs';
import {createApp} from './app.mjs';

export {Store,LiveService,Relay,createApp};
export {LiveService as PatientService} from './service.mjs';
export {RelayRequestError} from './relay.mjs';
export {viewSnapshot} from './streams.mjs';

/**
 * Serves an existing service: HTTP + WebSocket, the simulation tick and relay polling.
 * A failing tick pauses the simulation and persists the error, as upstream did.
 * Returns {app, server, close()}.
 */
export async function startLiveServer({service,relay,token,adminDir,port=4328,host='127.0.0.1',tickMs=1000,pollMs=5000,log=console}) {
  const app=createApp(service,relay,token,adminDir);
  const server=await new Promise((resolve,reject)=>{const s=app.listen(port,host,error=>error?reject(error):resolve(s));});
  app.locals.attachLiveSocket(server);
  const tick=()=>{
    try{service.tick();}
    catch(e){
      log.error('Simulation stopped:',e.message);
      try{service.markFailed(e.message);}catch(persistError){log.error('Cannot persist pause:',persistError.message);throw persistError;}
    }
  };
  const timer=setInterval(tick,tickMs);
  const poll=relay.enabled?setInterval(()=>relay.poll(),pollMs):null;
  if(relay.enabled)relay.poll();
  const close=()=>new Promise(resolve=>{clearInterval(timer);if(poll)clearInterval(poll);app.locals.closeLiveStreams();server.close(()=>resolve());});
  return {app,server,close};
}

/** Production start from environment variables (see .env.example). */
export async function startFromEnv(env=process.env) {
  const token=env.SIM_ADMIN_TOKEN;
  if(!token||token.length<24||token.startsWith('replace-'))throw new Error('Configure a random SIM_ADMIN_TOKEN of at least 24 characters');
  const store=new Store(path.resolve(env.DATA_DIR??'data','patient.sqlite'));
  const service=new LiveService(store);
  const relay=new Relay(service,{baseUrl:env.RELAY_BASE_URL??'https://ai-server.phpjxc.com',deviceId:env.RELAY_DEVICE_ID,apiKey:env.RELAY_API_KEY,
    aiKey:env.RELAY_AI_KEY,enabled:env.RELAY_ENABLED==='true'});
  const fatal=error=>{console.error(error.message);process.exit(1);};
  const live=await startLiveServer({service,relay,token,adminDir:env.ADMIN_UI_DIR,port:Number(env.PORT??4328),host:env.HOST??'127.0.0.1',
    log:{error:(...a)=>console.error(...a)}}).catch(fatal);
  console.log('sweet-sim listening');
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>live.close().then(()=>{store.close();process.exit(0);}));
  return {...live,service,relay,store};
}
