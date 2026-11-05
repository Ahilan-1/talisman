import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureAccountSchema, setAccountCredentials, verifyAccountCredentials, accountProfile } from '../accounts.mjs';

test('website credentials require Telegram pairing and remain account scoped',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE telegram_accounts(user_id TEXT PRIMARY KEY);');ensureAccountSchema(db);
 assert.throws(()=>setAccountCredentials(db,'a',{username:'alice',email:'a@example.com',password:'long secret password'}),/Telegram/);
 db.prepare('INSERT INTO telegram_accounts VALUES(?)').run('a');
 setAccountCredentials(db,'a',{username:'alice',email:'a@example.com',password:'long secret password'});
 assert.equal(accountProfile(db,'a').complete,true);
 assert.equal(verifyAccountCredentials(db,'ALICE','long secret password').userId,'a');
 assert.equal(verifyAccountCredentials(db,'alice','wrong'),null);
 assert.equal(accountProfile(db,'b').complete,false);
 assert.throws(()=>setAccountCredentials(db,'a',{username:'other',email:'b@example.com',password:'long secret password'}),/already exist/);
});
