// SQLite persistence for the live service. Tables and payload columns are unchanged from
// upstream sweet-sim (src/store.js), so existing databases keep their CGM, treatment, event and
// command history. Only the checkpoint JSON changed: {format:'sweet-sim-live/2', live, world}.
// An upstream checkpoint is migrated by the service; the original is kept in checkpoint_legacy.
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(file) {
    if(file!==':memory:')fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(file);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoint(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoint_legacy(id INTEGER PRIMARY KEY, saved_at_ms REAL NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS samples(id INTEGER PRIMARY KEY, sim_ms REAL NOT NULL, glucose REAL NOT NULL, observed REAL NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS samples_time ON samples(sim_ms);
      CREATE TABLE IF NOT EXISTS treatments(id TEXT PRIMARY KEY, sim_ms REAL NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS treatments_time ON treatments(sim_ms);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, sim_ms REAL NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, cmd TEXT NOT NULL, sim_ms REAL NOT NULL, outcome TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS changes(id INTEGER PRIMARY KEY, at_ms REAL NOT NULL, payload TEXT NOT NULL);
    `);
  }
  load() {const r=this.db.prepare('SELECT json FROM checkpoint WHERE id=1').get();return r?JSON.parse(r.json):null;}
  /** Keeps a pre-migration checkpoint for inspection or rollback to the upstream service. */
  backupLegacy(checkpoint,atMs=Date.now()) {
    this.db.prepare('INSERT INTO checkpoint_legacy(saved_at_ms,json) VALUES(?,?)').run(atMs,JSON.stringify(checkpoint));
  }
  /**
   * Atomically writes the checkpoint, the records produced since the last commit and, for relay
   * commands, the receipt {id, cmd, outcome, simMs}.
   */
  commit(checkpoint,pending={},command=null) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO checkpoint(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(checkpoint));
      const sample=this.db.prepare('INSERT INTO samples(sim_ms,glucose,observed,payload) VALUES(?,?,?,?)');
      for(const p of pending.samples??[])sample.run(p.at,p.glucose,p.observed,JSON.stringify(p));
      for(const table of ['treatments','events']) {
        const stmt=this.db.prepare(`INSERT OR IGNORE INTO ${table}(id,sim_ms,payload) VALUES(?,?,?)`);
        for(const e of pending[table]??[])stmt.run(e.id,e.at,JSON.stringify(e));
      }
      const change=this.db.prepare('INSERT INTO changes(at_ms,payload) VALUES(?,?)');
      for(const e of pending.changes??[])change.run(Date.now(),JSON.stringify(e));
      if(command)this.db.prepare('INSERT INTO commands(id,cmd,sim_ms,outcome) VALUES(?,?,?,?)').run(command.id,command.cmd,command.simMs,JSON.stringify(command.outcome));
      this.db.exec('COMMIT');
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  list(table,{start=-Infinity,end=Infinity,limit=1000,order='DESC'}={}) {
    if(!['samples','treatments','events'].includes(table))throw new Error('Invalid collection');
    const rows=this.db.prepare(`SELECT payload FROM ${table} WHERE sim_ms>=? AND sim_ms<=? ORDER BY sim_ms ${order==='ASC'?'ASC':'DESC'} LIMIT ?`)
      .all(Number.isFinite(start)?start:-1e16,Number.isFinite(end)?end:1e16,Math.min(20000,Math.max(1,Math.trunc(limit))));
    return rows.map(r=>JSON.parse(r.payload));
  }
  changes(limit=100){return this.db.prepare('SELECT * FROM changes ORDER BY id DESC LIMIT ?').all(limit).map(r=>({...r,payload:JSON.parse(r.payload)}));}
  command(id){const r=this.db.prepare('SELECT * FROM commands WHERE id=?').get(id);return r?{...r,outcome:JSON.parse(r.outcome)}:null;}
  unacked(){return this.db.prepare('SELECT * FROM commands WHERE acked=0 ORDER BY rowid').all().map(r=>({...r,outcome:JSON.parse(r.outcome)}));}
  ack(id){this.db.prepare('UPDATE commands SET acked=1 WHERE id=?').run(id);}
  commands(limit=100){return this.db.prepare('SELECT * FROM commands ORDER BY rowid DESC LIMIT ?').all(limit).map(r=>({...r,outcome:JSON.parse(r.outcome)}));}
  close(){this.db.close();}
}
