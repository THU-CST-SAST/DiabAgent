// Reader for the TOML subset that src/export/harbor.mjs writes in task.toml: [a.b] tables,
// `key = <JSON-compatible scalar or array>` and comments. Not a general TOML parser.
import fs from 'node:fs';

export function parseTaskToml(text) {
  const root={};let table=root;
  for(const raw of text.split('\n')) {
    const line=raw.trim();if(!line||line.startsWith('#'))continue;
    const t=line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if(t){table=t[1].split('.').reduce((o,k)=>(o[k]??={}),root);continue;}
    const kv=line.match(/^("[^"]+"|[A-Za-z0-9_-]+) = (.+)$/);
    if(!kv)throw new Error(`unsupported TOML line: ${line}`);
    const key=kv[1].startsWith('"')?JSON.parse(kv[1]):kv[1];
    if(key in table)throw new Error(`duplicate TOML key ${key}`);
    table[key]=JSON.parse(kv[2]);
  }
  return root;
}

export const readTaskToml=file=>parseTaskToml(fs.readFileSync(file,'utf8'));
