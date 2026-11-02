// Relay (AAPS-style) text commands -> structured World actions.
// The grammar and validation messages are unchanged from upstream sweet-sim src/commands.js
// (frozen copy: test/reference/upstream/commands.js); planCommand() is the new part that maps a
// parsed command onto the same action table the evaluation environment uses.

const number=(s,label,{zero=false}={})=>{
  if(!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(s??''))throw new Error(`Invalid ${label}`);
  const n=Number(s);if(!Number.isFinite(n)||(zero?n<0:n<=0))throw new Error(`Invalid ${label}`);return n;
};
const minutes=s=>{const n=number(s,'duration');if(!Number.isInteger(n)||n>1440)throw new Error('Duration must be integer minutes within 1..1440');return n;};

export const SUPPORTED_COMMANDS=['BG','BOLUS','CARBS','BASAL','EXTENDED','LOOP','TEMPTARGET'];

/** Relay protocol: bare integer = percent, decimal = U/h; explicit markers preferred. */
export function parseCommand(text) {
  if(typeof text!=='string'||text.length>200)throw new Error('Invalid command string');
  const p=text.trim().toUpperCase().split(/\s+/),[name,a,b]=p;
  if(name==='BG'&&p.length===1)return {type:'bg'};
  if(name==='BOLUS'&&p.length===2)return {type:'bolus',units:number(a,'insulin')};
  if(name==='CARBS'&&p.length===2)return {type:'carbs',grams:number(a,'carbs')};
  if(name==='BASAL'&&p.length===2&&['STOP','CANCEL'].includes(a))return {type:'cancel_basal'};
  if(name==='BASAL'&&p.length===3) {
    if(a.endsWith('%'))return {type:'temp_basal',basis:'percent',value:number(a.slice(0,-1),'percent',{zero:true}),minutes:minutes(b)};
    if(a.endsWith('U/H'))return {type:'temp_basal',basis:'absolute',value:number(a.slice(0,-3),'rate',{zero:true}),minutes:minutes(b)};
    if(a.includes('.'))return {type:'temp_basal',basis:'absolute',value:number(a,'rate',{zero:true}),minutes:minutes(b)};
    return {type:'temp_basal',basis:'percent',value:number(a,'percent',{zero:true}),minutes:minutes(b)};
  }
  if(name==='EXTENDED'&&p.length===2&&['CANCEL','STOP'].includes(a))return {type:'cancel_extended'};
  if(name==='EXTENDED'&&p.length===3)return {type:'extended',units:number(a,'insulin'),minutes:minutes(b)};
  if(name==='LOOP') {
    if(p.length===2&&['ENABLE','OPEN','CLOSED','LGS','DISABLE','STOP'].includes(a))return {type:'loop',mode:a.toLowerCase()};
    if(p.length===3&&a==='SUSPEND')return {type:'loop',mode:'suspend',minutes:minutes(b)};
  }
  if(name==='TEMPTARGET'&&p.length===2&&['MEAL','ACTIVITY','HYPO','CANCEL'].includes(a))return {type:'temp_target',preset:a.toLowerCase()};
  throw new Error('Unsupported command or wrong argument count');
}

/**
 * Structured World actions for a parsed command.
 *   ctx: {scheduledBasalUph, maxBasalUph, carbAbsorptionMinutes}
 * Returns {actions, rateUph?, cancelUserTemp?}. The upstream-only profile max-basal check keeps
 * its upstream message; everything else is validated by the World action table.
 */
export function planCommand(c,ctx) {
  switch(c.type) {
    case 'bg':return {actions:[]};   // status query; upstream applied nothing
    case 'bolus':return {actions:[{type:'BOLUS',units:c.units}]};
    case 'carbs':return {actions:[{type:'INGEST_CARBS',grams:c.grams,absorption_minutes:ctx.carbAbsorptionMinutes}]};
    case 'temp_basal': {
      const rate=c.basis==='percent'?ctx.scheduledBasalUph*c.value/100:c.value;
      if(rate>ctx.maxBasalUph)throw new Error('Virtual profile max basal exceeded');
      return {actions:[{type:'TEMP_BASAL',rate_u_h:rate,duration_minutes:c.minutes}],rateUph:rate};
    }
    case 'cancel_basal':return {actions:[{type:'CANCEL_TEMP_BASAL'}]};
    case 'extended':return {actions:[{type:'EXTENDED_BOLUS',units:c.units,duration_minutes:c.minutes}]};
    case 'cancel_extended':return {actions:[{type:'CANCEL_EXTENDED_BOLUS'}]};
    case 'loop':
      // Upstream LOOP SUSPEND also cancelled the user's temp basal; STOP is an alias of DISABLE.
      if(c.mode==='suspend')return {actions:[{type:'SUSPEND_LOOP',minutes:c.minutes}],cancelUserTemp:true};
      return {actions:[{type:'SET_LOOP_MODE',mode:c.mode==='stop'?'disable':c.mode}]};
    case 'temp_target':return {actions:[{type:'SET_TEMP_TARGET',preset:c.preset}]};
    default:throw new Error('Unsupported command or wrong argument count');
  }
}
