import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ensureOrchestrationSchema, createCalendarEvent, calendarEvents, saveVaultLogin, readVaultSecret, createApproval, decideApproval, consumeApproval, recordStep, taskReceipt, recoverStaleJobs } from '../orchestration.mjs';

function setup(){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE jobs(id TEXT PRIMARY KEY,user_id TEXT,status TEXT,kind TEXT,result TEXT,created_at INTEGER,updated_at INTEGER);');ensureOrchestrationSchema(db);return db}

test('calendar events are account scoped and conflicts deduplicate',()=>{
 const db=setup();
 createCalendarEvent(db,'a',{title:'Class',start:'2026-11-05T09:00:00+05:30',end:'2026-11-05T10:00:00+05:30'});
 createCalendarEvent(db,'a',{title:'Train',start:'2026-11-05T09:30:00+05:30',end:'2026-11-05T10:30:00+05:30'});
 assert.equal(calendarEvents(db,'a',Date.parse('2026-11-05'),Date.parse('2026-11-06')).length,2);
 assert.equal(calendarEvents(db,'b',Date.parse('2026-11-05'),Date.parse('2026-11-06')).length,0);
 assert.equal(db.prepare('SELECT count(*) AS n FROM proactive_events').get().n,1);
});

test('vault encryption binds secrets to the owner and website',()=>{
 const db=setup(),key=crypto.randomBytes(32);
 const item=saveVaultLogin(db,key,'a',{label:'Mail',origin:'https://example.com/login',username:'alice',password:'correct horse'});
 assert.equal(readVaultSecret(db,key,'a',item.id,'https://example.com').password,'correct horse');
 assert.throws(()=>readVaultSecret(db,key,'b',item.id,'https://example.com'));
 assert.throws(()=>readVaultSecret(db,key,'a',item.id,'https://other.example'));
 assert.ok(!db.prepare('SELECT secret FROM vault_logins').get().secret.includes('correct horse'));
});

test('approval decision is single use and receipt includes durable steps',()=>{
 const db=setup();db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run('j','a','running','message',null,Date.now(),Date.now());
 const details={url:'https://example.com',selector:'#buy',label:'Submit',context:'Ticket 100'};
 const approval=createApproval(db,'a','j','click','Buy one ticket',details);
 assert.equal(decideApproval(db,'a',approval.id,'approved').status,'approved');
 assert.equal(decideApproval(db,'a',approval.id,'rejected').changed,false);
 assert.throws(()=>consumeApproval(db,'a',approval.id,{...details,context:'Ticket 200'}),/does not match/);
 assert.equal(consumeApproval(db,'a',approval.id,details).ok,true);
 assert.throws(()=>consumeApproval(db,'a',approval.id,details),/unavailable/);
 recordStep(db,'j','a',0,'open','Open ticket page','done',{url:'https://example.com'});
 assert.equal(taskReceipt(db,'j','a').steps[0].status,'done');
 assert.equal(taskReceipt(db,'j','b'),null);
});

test('interrupted read-only work retries; uncertain side effects stop',()=>{
 const db=setup(),stamp=Date.now();
 db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run('read','a','running','message',null,stamp-600000,stamp-600000);
 db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run('write','a','running','message',null,stamp-600000,stamp-600000);
 recordStep(db,'read','a',0,'open','Open website','done',{url:'https://example.com'});
 recordStep(db,'write','a',0,'click','Click checkout','running');
 db.prepare('UPDATE jobs SET updated_at=?').run(stamp-600000);
 recoverStaleJobs(db,stamp);
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id='read'").get().status,'queued');
 assert.equal(db.prepare("SELECT status FROM jobs WHERE id='write'").get().status,'failed');
});
