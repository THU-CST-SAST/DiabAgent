import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {SimEnv,VERSION} from './pomdp.mjs';

/**
 * adminToken (optional): when set, creating episodes and reading evaluator data
 * (export, summary) require `Authorization: Bearer <token>`; observe/step stay open.
 * Used by sandboxed deployments (e.g. the Harbor export) where the agent shares the network.
 */
export function createServer({dataDir='artifacts/episodes',maxEpisodes=100,adminToken=null}={}) {
  const isAdmin=req=>{
    if(!adminToken)return true;
    const a=Buffer.from(req.headers.authorization??''),b=Buffer.from(`Bearer ${adminToken}`);
    return a.length===b.length&&timingSafeEqual(a,b);
  };
  fs.mkdirSync(dataDir,{recursive:true});const episodes=new Map();
  // An interrupted append is not silently discarded: recovery fails loudly.
  for(const name of fs.readdirSync(dataDir).filter(n=>n.endsWith('.journal.jsonl'))){
    const rows=fs.readFileSync(path.join(dataDir,name),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const env=new SimEnv(rows[0].config);
    for(const row of rows.slice(1))env.step(row.request);
    episodes.set(rows[0].episode_id,env);
  }
  function append(id,row){
    const fd=fs.openSync(path.join(dataDir,`${id}.journal.jsonl`),'a');
    try{fs.writeSync(fd,JSON.stringify(row)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }
  const server=http.createServer(async(req,res)=>{
    const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    try{
      const u=new URL(req.url,'http://localhost');
      if(req.method==='GET'&&u.pathname==='/health')return send(200,{status:'ok',version:VERSION,simulation_only:true,episodes:episodes.size});
      let body={};
      if(req.method==='POST'){
        let text='';for await(const chunk of req){text+=chunk;if(text.length>100000)throw new Error('Request too large');}
        body=JSON.parse(text||'{}');
      }
      if(req.method==='GET'&&u.pathname==='/episodes')return send(200,{episodes:[...episodes.keys()]});
      if(req.method==='POST'&&u.pathname==='/episodes'){
        if(!isAdmin(req))return send(403,{error:'Episode creation is restricted on this server'});
        if(episodes.size>=maxEpisodes)return send(429,{error:'Episode capacity reached; use a fresh worker/data directory'});
        const env=new SimEnv(body),id=randomUUID();
        append(id,{episode_id:id,config:env.config});episodes.set(id,env);
        return send(201,{episode_id:id,observation:env.initialObservation,step:0,simulation:true});
      }
      const match=u.pathname.match(/^\/episodes\/([a-f0-9-]+)(?:\/(step|export|summary))?$/);
      if(!match||!episodes.has(match[1]))return send(404,{error:'Unknown route or episode'});
      const [,id,op]=match,env=episodes.get(id);
      if(req.method==='GET'&&!op)return send(200,{observation:env.observe(),step:env.transitions.length,done:env.done()});
      if(req.method==='POST'&&op==='step'){
        const duplicate=Object.hasOwn(env.cache,body.action_id??''),result=env.step(body);
        if(!duplicate) {
          try{append(id,{request:body});}
          catch(e){episodes.delete(id);throw new Error('Journal write failed; episode removed from memory, restart to recover: '+e.message);}
        }
        return send(200,result);
      }
      if((op==='summary'||op==='export')&&!isAdmin(req))return send(403,{error:'Evaluator data is restricted on this server'});
      if(req.method==='GET'&&op==='summary')return send(200,env.summary());
      if(req.method==='GET'&&op==='export')return send(200,env.exportBundle());
      send(405,{error:'Method not allowed'});
    }catch(e){send(400,{error:e.message});}
  });
  return server;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const port=Number(process.env.PORT||8765);
  const host=process.env.HOST||'127.0.0.1';
  createServer({dataDir:process.env.DATA_DIR||'artifacts/episodes',adminToken:process.env.SWEET_SIM_ADMIN_TOKEN||null})
    .listen(port,host,()=>console.log(`Simulation backend http://${host}:${port}`));
}
