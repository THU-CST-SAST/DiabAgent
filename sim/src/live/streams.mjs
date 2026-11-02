// Snapshot + incremental push of the live view (upstream src/live.js): public and
// admin-authenticated streams over WebSocket (/api/socket, /api/admin/socket) and SSE
// (/api/live, /api/admin/live). Payload shapes are unchanged.
import {timingSafeEqual} from 'node:crypto';
import {WebSocketServer} from 'ws';

export function viewSnapshot(service,since) {
  const now=service.now;
  const start=since===undefined?now-48*3600000:since;
  // Select newest records first; truncating ascending data can drop the current CGM.
  const samples=service.store.list('samples',{limit:3000,order:'DESC',start}).reverse();
  const treatments=service.store.list('treatments',{limit:200,start:now-48*3600000});
  return {state:service.status(),samples,treatments};
}

export function mountLive(app,service,relay,auth,token) {
  const clients=new Set();
  app.locals.closeLiveStreams=()=>{for(const close of clients)close();};
  const adminSnapshot=()=>({state:service.status(),config:service.config,
    relay:{deviceId:relay.deviceId,...relay.health},commands:service.store.commands(),
    fastForward:service.fastForwardState??null,events:service.upcomingEvents()});
  const full=(admin,since)=>{const view=viewSnapshot(service,since);return {sentAt:Date.now(),...(admin?adminSnapshot():{}),view};};
  /** Per-client cursor: first call yields a snapshot, then only new samples and changed parts. */
  const cursor=(admin,{checkMonotonic=false}={})=>{
    let lastAt,lastConfig,lastCommands,lastTreatments;
    return ()=>{
      const initial=lastAt===undefined,payload=full(admin,lastAt);
      const samples=initial?payload.view.samples:payload.view.samples.filter(p=>p.at>lastAt);
      if(checkMonotonic&&!initial&&payload.view.state.virtualTime<new Date(lastAt).toISOString())throw new Error('Simulation time moved backwards');
      const treatmentKey=payload.view.treatments.map(t=>t.id).join('|');
      if(!initial&&lastTreatments===treatmentKey)delete payload.view.treatments;lastTreatments=treatmentKey;
      payload.view.samples=samples;
      if(admin){const configKey=JSON.stringify(payload.config),commandKey=payload.commands.map(c=>`${c.id}:${c.acked}`).join('|');
        if(!initial&&lastConfig===configKey)delete payload.config;if(!initial&&lastCommands===commandKey)delete payload.commands;
        lastConfig=configKey;lastCommands=commandKey;delete payload.events;}
      if(samples.length)lastAt=samples.at(-1).at;else if(initial)lastAt=0;
      return {event:initial?'snapshot':'update',payload};
    };
  };
  app.locals.attachLiveSocket=server=>{
    const wss=new WebSocketServer({noServer:true,maxPayload:4096});
    server.on('upgrade',(req,socket,head)=>{
      const path=req.url?.split('?')[0];
      if(!['/api/socket','/api/admin/socket'].includes(path)||req.url.includes('?')){socket.end('HTTP/1.1 404 Not Found\r\n\r\n');return;}
      try{if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}}
      catch{socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
      wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
    });
    wss.on('connection',(ws,req)=>{
      const admin=req.url==='/api/admin/socket';let timer,authTimer,closed=false,alive=true;
      const next=cursor(admin);
      const close=()=>{if(closed)return;closed=true;clearInterval(timer);clearTimeout(authTimer);clients.delete(close);if(ws.readyState===1)ws.close(1001,'Server restarting');};
      clients.add(close);ws.on('close',close);ws.on('error',close);ws.on('pong',()=>{alive=true;});
      const send=()=>{if(ws.readyState!==1||ws.bufferedAmount>262144)return;try{ws.send(JSON.stringify(next()));}catch{ws.terminate();close();}};
      const begin=()=>{clearTimeout(authTimer);send();let ticks=0;timer=setInterval(()=>{send();if(++ticks%20===0){if(!alive){ws.terminate();close();return;}alive=false;ws.ping();}},1000);};
      if(!admin){begin();return;}
      authTimer=setTimeout(()=>ws.close(4401,'Authentication required'),5000);
      ws.once('message',raw=>{
        try{const message=JSON.parse(raw.toString()),input=Buffer.from(typeof message.token==='string'?message.token:''),expected=Buffer.from(token);
          if(message.type!=='auth'||input.length!==expected.length||!timingSafeEqual(input,expected)){ws.close(4401,'Authentication required');return;}begin();
        }catch{ws.close(4401,'Authentication required');}
      });
    });
    server.on('close',()=>wss.close());
  };
  app.get('/api/admin/state',auth,(req,res)=>res.json(req.query.includeView==='1'?full(true):adminSnapshot()));
  const stream=admin=>(req,res)=>{
    res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    let timer,closed=false,blocked=false;
    const next=cursor(admin,{checkMonotonic:true});
    const close=()=>{if(closed)return;closed=true;clearInterval(timer);clients.delete(close);res.end();};
    clients.add(close);res.on('close',close);res.on('drain',()=>{blocked=false;});
    const emit=(event,payload)=>{blocked=!res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);};
    const update=()=>{
      if(closed||blocked)return;
      try {const {event,payload}=next();emit(event,payload);}
      catch(error){emit('failure',{error:error.message});close();}
    };
    update();if(!closed)timer=setInterval(update,1000);
  };
  app.get('/api/live',stream(false));app.get('/api/admin/live',auth,stream(true));
}
