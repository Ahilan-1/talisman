import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const uuid = () => crypto.randomUUID();
const now = () => Date.now();
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

export function ensureOrchestrationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_steps(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,user_id TEXT NOT NULL,ordinal INTEGER NOT NULL,kind TEXT NOT NULL,summary TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,output TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(job_id,ordinal));
    CREATE TABLE IF NOT EXISTS task_events(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,user_id TEXT NOT NULL,type TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS task_approvals(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,user_id TEXT NOT NULL,action TEXT NOT NULL,summary TEXT NOT NULL,details TEXT NOT NULL,status TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,decided_at INTEGER);
    CREATE TABLE IF NOT EXISTS calendar_events(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',start_at INTEGER NOT NULL,end_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'planned',source TEXT NOT NULL DEFAULT 'user',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS calendar_user_time ON calendar_events(user_id,start_at);
    CREATE TABLE IF NOT EXISTS vault_logins(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,label TEXT NOT NULL,origin TEXT NOT NULL,username TEXT NOT NULL,secret TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS vault_user_origin_label ON vault_logins(user_id,origin,label);
    CREATE TABLE IF NOT EXISTS proactive_events(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,event_key TEXT NOT NULL,kind TEXT NOT NULL,summary TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,delivered_at INTEGER,responded_at INTEGER,UNIQUE(user_id,event_key));
    CREATE TABLE IF NOT EXISTS task_recovery(job_id TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0);
  `);
}

export function logTaskEvent(db, jobId, userId, type, detail) {
  db.prepare('INSERT INTO task_events VALUES(?,?,?,?,?,?)').run(uuid(),jobId,userId,type,String(detail).slice(0,2000),now());
}

export function recordStep(db, jobId, userId, ordinal, kind, summary, status, output = null) {
  const stamp = now();
  db.prepare(`INSERT INTO task_steps(id,job_id,user_id,ordinal,kind,summary,status,attempts,output,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,1,?,?,?) ON CONFLICT(job_id,ordinal) DO UPDATE SET status=excluded.status,attempts=task_steps.attempts+CASE WHEN excluded.status='running' THEN 1 ELSE 0 END,output=excluded.output,updated_at=excluded.updated_at`)
    .run(uuid(),jobId,userId,ordinal,String(kind).slice(0,60),String(summary).slice(0,300),status,output===null?null:JSON.stringify(output).slice(0,12000),stamp,stamp);
  logTaskEvent(db,jobId,userId,`step_${status}`,`${ordinal}: ${summary}`);
}

export function taskReceipt(db, jobId, userId) {
  const job = db.prepare('SELECT id,kind,status,result,created_at,updated_at FROM jobs WHERE id=? AND user_id=?').get(jobId,userId);
  if (!job) return null;
  return { ...job, result:job.result?JSON.parse(job.result):null,
    steps:db.prepare('SELECT ordinal,kind,summary,status,attempts,output,updated_at FROM task_steps WHERE job_id=? AND user_id=? ORDER BY ordinal').all(jobId,userId).map(row=>({...row,output:row.output?JSON.parse(row.output):null})),
    events:db.prepare('SELECT type,detail,created_at FROM task_events WHERE job_id=? AND user_id=? ORDER BY created_at').all(jobId,userId) };
}

export function createApproval(db, userId, jobId, action, summary, details = {}) {
  const job=db.prepare('SELECT status FROM jobs WHERE id=? AND user_id=?').get(jobId,userId);
  if(!job||!['running','queued'].includes(job.status))throw Error('Task is no longer active');
  const encoded=JSON.stringify(details).slice(0,3000);
  const prior=db.prepare("SELECT * FROM task_approvals WHERE job_id=? AND action=? AND details=? AND status IN ('pending','approved') ORDER BY created_at DESC LIMIT 1").get(jobId,action,encoded);
  if(prior)return prior;
  const approval={id:uuid(),job_id:jobId,user_id:userId,action:String(action).slice(0,80),summary:String(summary).slice(0,500),details:encoded,status:'pending',expires_at:now()+15*60_000,created_at:now()};
  db.prepare('INSERT INTO task_approvals(id,job_id,user_id,action,summary,details,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(approval.id,approval.job_id,userId,approval.action,approval.summary,approval.details,approval.status,approval.expires_at,approval.created_at);
  logTaskEvent(db,jobId,userId,'approval_requested',approval.summary);
  return approval;
}

export function decideApproval(db, userId, id, decision) {
  if(!['approved','rejected'].includes(decision))throw Error('Invalid approval decision');
  const row=db.prepare('SELECT * FROM task_approvals WHERE id=? AND user_id=?').get(id,userId);
  if(!row)throw Error('Approval not found');
  if(row.status!=='pending')return {changed:false,status:row.status};
  const status=row.expires_at<=now()?'expired':decision;
  const changed=db.prepare("UPDATE task_approvals SET status=?,decided_at=? WHERE id=? AND user_id=? AND status='pending'").run(status,now(),id,userId).changes;
  if(changed)logTaskEvent(db,row.job_id,userId,`approval_${status}`,row.summary);
  return {changed:!!changed,status};
}

export function consumeApproval(db,userId,id,actual){
  const row=db.prepare("SELECT * FROM task_approvals WHERE id=? AND user_id=? AND status='approved'").get(id,userId);
  if(!row||row.expires_at<=now())throw Error('Approval unavailable');
  if(db.prepare('SELECT status FROM jobs WHERE id=? AND user_id=?').get(row.job_id,userId)?.status!=='running')throw Error('Task is no longer running');
  const expected=JSON.parse(row.details);
  if(row.action!=='click'||expected.url!==actual.url||expected.selector!==actual.selector||expected.label!==actual.label||expected.context!==actual.context)throw Error('Approval does not match this action');
  if(!db.prepare("UPDATE task_approvals SET status='consumed' WHERE id=? AND status='approved'").run(id).changes)throw Error('Approval already used');
  logTaskEvent(db,row.job_id,userId,'approval_consumed',row.summary);
  return {ok:true};
}

export function createCalendarEvent(db,userId,{title,description='',start,end,source='user'}) {
  const startAt=Date.parse(start),endAt=Date.parse(end);
  if(!Number.isFinite(startAt)||!Number.isFinite(endAt)||endAt<=startAt||endAt-startAt>30*86400000)throw Error('Invalid event time range');
  const name=String(title||'').trim().slice(0,200);
  if(!name)throw Error('Event title is required');
  const event={id:uuid(),title:name,description:String(description||'').slice(0,2000),start_at:startAt,end_at:endAt,status:'planned',source};
  db.prepare('INSERT INTO calendar_events(id,user_id,title,description,start_at,end_at,status,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(event.id,userId,event.title,event.description,startAt,endAt,event.status,source,now(),now());
  const overlaps=db.prepare("SELECT id,title FROM calendar_events WHERE user_id=? AND id<>? AND status='planned' AND start_at<? AND end_at>? LIMIT 3").all(userId,event.id,endAt,startAt);
  for(const other of overlaps)proposeEvent(db,userId,`conflict:${[event.id,other.id].sort().join(':')}`,'calendar_conflict',`Calendar conflict: ${event.title} overlaps ${other.title}. Open Calendar to review.`);
  return event;
}

export function calendarEvents(db,userId,from,to) {
  return db.prepare('SELECT id,title,description,start_at,end_at,status,source FROM calendar_events WHERE user_id=? AND end_at>? AND start_at<? ORDER BY start_at LIMIT 500').all(userId,from,to);
}

export function vaultKey(dataDir) {
  const file=path.join(dataDir,'vault.key');
  if(!fs.existsSync(file))fs.writeFileSync(file,crypto.randomBytes(32),{flag:'wx',mode:0o600});
  const key=fs.readFileSync(file);
  if(key.length!==32)throw Error('Invalid vault key');
  return key;
}

export function normalizeOrigin(value) {
  const url=new URL(String(value));
  if(url.protocol!=='https:'||url.username||url.password||url.port)throw Error('Use an HTTPS website origin');
  return url.origin;
}

export function saveVaultLogin(db,key,userId,{label,origin,username,password}) {
  const site=normalizeOrigin(origin),name=String(label||'').trim().slice(0,100),login=String(username||'').trim().slice(0,300),secret=String(password||'');
  if(!name||!login||!secret||secret.length>1000)throw Error('Label, username and password are required');
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(`${userId}:${site}`));
  const encrypted=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
  const packed=Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
  const id=uuid();
  db.prepare('INSERT INTO vault_logins VALUES(?,?,?,?,?,?,?,?)').run(id,userId,name,site,login,packed,now(),now());
  return {id,label:name,origin:site,username:login};
}

export function readVaultSecret(db,key,userId,id,actualOrigin) {
  const row=db.prepare('SELECT * FROM vault_logins WHERE id=? AND user_id=?').get(id,userId);
  if(!row||row.origin!==normalizeOrigin(actualOrigin))throw Error('Login is not available for this website');
  const data=Buffer.from(row.secret,'base64'),decipher=crypto.createDecipheriv('aes-256-gcm',key,data.subarray(0,12));
  decipher.setAAD(Buffer.from(`${userId}:${row.origin}`));
  decipher.setAuthTag(data.subarray(12,28));
  return {username:row.username,password:Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8')};
}

export function proposeEvent(db,userId,key,kind,summary) {
  const id=uuid();
  const result=db.prepare("INSERT OR IGNORE INTO proactive_events(id,user_id,event_key,kind,summary,status,created_at) VALUES(?,?,?,?,?,'pending',?)").run(id,userId,digest(String(key)),String(kind).slice(0,60),String(summary).slice(0,500),now());
  return result.changes?db.prepare('SELECT * FROM proactive_events WHERE id=?').get(id):null;
}

export function recoverStaleJobs(db, timestamp = now(), staleMs = 5*60_000) {
  const stale=db.prepare("SELECT id,user_id FROM jobs WHERE status='running' AND updated_at<?").all(timestamp-staleMs);
  for(const job of stale){
    const steps=db.prepare('SELECT kind,status FROM task_steps WHERE job_id=?').all(job.id);
    const unsafe=steps.some(step=>!['search','extract','screen','open','read','text','find','inspect','wait','scroll','hover','back','forward','newtab','switch','screenshot'].includes(step.kind));
    const attempts=db.prepare('SELECT attempts FROM task_recovery WHERE job_id=?').get(job.id)?.attempts||0;
    if(steps.length&&!unsafe&&attempts<2){
      db.prepare('INSERT INTO task_recovery(job_id,attempts) VALUES(?,1) ON CONFLICT(job_id) DO UPDATE SET attempts=attempts+1').run(job.id);
      db.prepare("UPDATE jobs SET status='queued',updated_at=? WHERE id=? AND status='running'").run(timestamp,job.id);
      logTaskEvent(db,job.id,job.user_id,'resumed','Read-only computer task queued after interruption');
    }else{
      const reason=unsafe?'The computer stopped during an action whose outcome is uncertain. Check the site before retrying.':'The computer task was interrupted before a safe checkpoint.';
      db.prepare("UPDATE jobs SET status='failed',result=?,updated_at=? WHERE id=? AND status='running'").run(JSON.stringify({error:reason}),timestamp,job.id);
      logTaskEvent(db,job.id,job.user_id,'interrupted',reason);
    }
  }
  return stale.length;
}
