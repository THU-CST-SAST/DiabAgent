const number=(s,label,{zero=false}={})=>{
  if(!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(s??'')) throw new Error(`Invalid ${label}`);
  const n=Number(s);if(!Number.isFinite(n)||(zero?n<0:n<=0)) throw new Error(`Invalid ${label}`);return n;
};
const minutes=s=>{const n=number(s,'duration');if(!Number.isInteger(n)||n>1440) throw new Error('Duration must be integer minutes within 1..1440');return n;};
export const SUPPORTED_COMMANDS=['BG','BOLUS','CARBS','BASAL','EXTENDED','LOOP','TEMPTARGET'];
/** Relay protocol: bare integer = percent, decimal = U/h; explicit markers preferred. */
export function parseCommand(text) {
  if(typeof text!=='string'||text.length>200) throw new Error('Invalid command string');
  const p=text.trim().toUpperCase().split(/\s+/),[name,a,b]=p;
  if(name==='BG'&&p.length===1) return {type:'bg'};
  if(name==='BOLUS'&&p.length===2) return {type:'bolus',units:number(a,'insulin')};
  if(name==='CARBS'&&p.length===2) return {type:'carbs',grams:number(a,'carbs')};
  if(name==='BASAL'&&p.length===2&&['STOP','CANCEL'].includes(a)) return {type:'cancel_basal'};
  if(name==='BASAL'&&p.length===3) {
    if(a.endsWith('%')) return {type:'temp_basal',basis:'percent',value:number(a.slice(0,-1),'percent',{zero:true}),minutes:minutes(b)};
    if(a.endsWith('U/H')) return {type:'temp_basal',basis:'absolute',value:number(a.slice(0,-3),'rate',{zero:true}),minutes:minutes(b)};
    if(a.includes('.')) return {type:'temp_basal',basis:'absolute',value:number(a,'rate',{zero:true}),minutes:minutes(b)};
    return {type:'temp_basal',basis:'percent',value:number(a,'percent',{zero:true}),minutes:minutes(b)};
  }
  if(name==='EXTENDED'&&p.length===2&&['CANCEL','STOP'].includes(a)) return {type:'cancel_extended'};
  if(name==='EXTENDED'&&p.length===3) return {type:'extended',units:number(a,'insulin'),minutes:minutes(b)};
  if(name==='LOOP') {
    if(p.length===2&&['ENABLE','OPEN','CLOSED','LGS','DISABLE','STOP'].includes(a)) return {type:'loop',mode:a.toLowerCase()};
    if(p.length===3&&a==='SUSPEND') return {type:'loop',mode:'suspend',minutes:minutes(b)};
  }
  if(name==='TEMPTARGET'&&p.length===2&&['MEAL','ACTIVITY','HYPO','CANCEL'].includes(a)) return {type:'temp_target',preset:a.toLowerCase()};
  throw new Error('Unsupported command or wrong argument count');
}
