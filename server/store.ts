import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';import {dirname} from 'node:path';import {validMemory} from './core';
const path=process.env.DATABASE_PATH||'./data/memory.sqlite';mkdirSync(dirname(path),{recursive:true});
const db=new DatabaseSync(path);db.exec('CREATE TABLE IF NOT EXISTS memory (id INTEGER PRIMARY KEY CHECK(id=1), content TEXT NOT NULL, version INTEGER NOT NULL, updatedAt INTEGER, session TEXT); INSERT OR IGNORE INTO memory VALUES(1,\'\',0,0,\'\');');
export function readMemory(){return db.prepare('SELECT * FROM memory WHERE id=1').get() as {content:string;version:number;updatedAt:number;session:string}}
export function writeMemory(content:string,id:string){db.prepare('UPDATE memory SET content=?,version=version+1,updatedAt=?,session=? WHERE id=1').run(validMemory(content),Date.now(),id)}
