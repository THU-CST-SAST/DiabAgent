import fs from 'node:fs';
import readline from 'node:readline';

// A shared fold for main's event log and historical one-record-per-call traces.
function accumulator({strict=false}={}) {
  const pending=new Map();
  let next=1;
  return {
    line(line) {
      if(!line.trim())return [];
      let e;try{e=JSON.parse(line);}catch(error){if(strict)throw Error('Invalid invocation JSON; reconcile the interrupted source',{cause:error});return [];}
      if(!e.event) {
        if(!e.request){if(strict)throw Error('Invocation is missing its request');return [];}
        const sequence=e.sequence??e.call??next++;
        next=Math.max(next,sequence+1);
        return [{...e,call:e.call??sequence,sequence}];
      }
      const k=e.sequence;
      if(!Number.isInteger(k)||!['request','response','error'].includes(e.event)) {
        if(strict)throw Error('Invalid invocation event');return [];
      }
      const c=pending.get(k)??{call:k,sequence:k};
      if(e.event==='request') {
        if(c.request&&strict)throw Error('Duplicate invocation request');
        Object.assign(c,{started:e.started,request:{model:e.model,reasoning_effort:e.reasoning_effort,
          wire_api:e.wire_api??null,base_url:e.base_url??null,...e.request}});
        pending.set(k,c);return [];
      }
      if(!c.request&&strict)throw Error('Invocation terminal event is missing its request');
      c.finished=e.finished;
      if(e.event==='error') {
        c.error=e.error;
        if(e.replay)c.replay=e.replay;
      }
      if(e.event==='response'||e.response) {
        const raw=e.response??null;
        c.response={id:raw?.id??null,model:raw?.model??null,status:raw?.status??e.stop_reason??null,
          reasoning_effort:raw?.reasoning?.effort??null,usage:e.usage??raw?.usage??null,raw,
          ...(e.replay?{replay:e.replay}:{}),...(e.contract_validation?{contract_validation:e.contract_validation}:{})};
      }
      pending.delete(k);return [c];
    },
    remaining(){return [...pending.values()];},
  };
}

export function parseInvocations(text,options={}) {
  const fold=accumulator(options),calls=[];
  for(const line of text.split('\n'))calls.push(...fold.line(line));
  return [...calls,...fold.remaining()].sort((a,b)=>a.sequence-b.sequence);
}

export function readInvocations(file,options={}) {
  return fs.existsSync(file)?parseInvocations(fs.readFileSync(file,'utf8'),options):[];
}

/** Streaming audits retain only open calls, not a second copy of a multi-GB transcript. */
export async function* iterateInvocations(file,options={}) {
  if(!fs.existsSync(file))return;
  const input=fs.createReadStream(file),lines=readline.createInterface({input,crlfDelay:Infinity}),fold=accumulator(options);
  try {
    for await(const line of lines)yield* fold.line(line);
    yield* fold.remaining();
  } finally {lines.close();input.destroy();}
}
