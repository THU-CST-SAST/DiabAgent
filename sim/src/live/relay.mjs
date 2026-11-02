// AAPS relay client (upstream src/relay.js): reports the virtual pump status, pulls pending
// commands, executes them exactly once through the live service and posts the receipts back.
// Only dedicated sweet-sim virtual devices (nsfollow_sweetsim_*) may be used.
export class RelayRequestError extends Error {
  constructor(message,{code='RELAY_REQUEST_FAILED',relayStatus=null,detail=null}={}){super(message);this.code=code;this.relayStatus=relayStatus;this.detail=detail;}
}

export class Relay {
  constructor(service,{baseUrl,deviceId,apiKey,aiKey,enabled=false,fetch:fetcher=globalThis.fetch}) {
    this.service=service;this.baseUrl=String(baseUrl??'').replace(/\/$/,'');this.deviceId=deviceId;
    this.apiKey=apiKey;this.aiKey=aiKey;this.enabled=enabled;this.busy=false;this.health={enabled};this.fetch=fetcher;
    if(enabled&&(!deviceId?.startsWith('nsfollow_sweetsim_')||!apiKey))throw new Error('Relay requires a dedicated sweet-sim virtual device');
  }
  async request(path,{method='GET',body,ai=false}={}) {
    const r=await this.fetch(this.baseUrl+path,{method,headers:{'Content-Type':'application/json',[ai?'X-AI-Key':'X-API-Key']:ai?this.aiKey:this.apiKey},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
    const value=await r.json();if(!r.ok||value.success===false||value.status==='error'){
      const detail=value.detail??value.message??'request failed';
      throw new RelayRequestError(`中转站${r.status>=500?'服务异常':'拒绝请求'}：${typeof detail==='object'?(detail.message??JSON.stringify(detail)):detail}`,
        {code:detail?.code??'RELAY_REQUEST_FAILED',relayStatus:r.status,detail});
    }
    return value;
  }
  /** Operator command: sent to the relay (which applies its safety limits), never applied locally. */
  async send(cmd,reason='Operator testing virtual patient') {
    if(!this.enabled||!this.aiKey)throw new Error('Relay AI credentials are not configured');
    try{return await this.request(`/api/v1/device/${this.deviceId}/commands`,{method:'POST',ai:true,body:{cmd,reason,confidence:1,skip_safety:false}});}
    catch(error){if(error instanceof RelayRequestError)throw error;throw new RelayRequestError('未能确认中转站是否已接受命令，请先查看回执，不要重复发送。',{code:'EXECUTION_UNKNOWN'});}
  }
  async poll() {
    if(!this.enabled||this.busy||this.service.fastForwardState)return;
    this.busy=true;
    try {
      const s=this.service.status();
      await this.request(`/api/v1/device/${this.deviceId}/status`,{method:'POST',body:{bg:s.bg,bg_trend:s.bg_trend,iob:s.iob,cob:s.cob,loop_mode:s.loop_mode,pump_connected:s.pump_connected,battery:s.battery,mqtt_connected:false}});
      const response=await this.request(`/api/v1/device/${this.deviceId}/commands/pending`);
      const data=response.data??response;const commands=Array.isArray(data)?data:data.commands??[];
      for(const c of commands){this.service.tick();this.service.command(c.command_id,c.cmd);}
      for(const c of this.service.store.unacked()) {
        await this.request(`/api/v1/commands/${c.id}/result`,{method:'POST',body:{status:c.outcome.status==='success'?'success':'error',result:JSON.stringify(c.outcome.result),executed_at:new Date().toISOString()}});
        this.service.store.ack(c.id);
      }
      this.health={enabled:true,connected:true,lastSuccess:new Date().toISOString()};
    } catch(error){this.health={...this.health,connected:false,error:error.message};}
    finally{this.busy=false;}
  }
}
