import crypto from 'node:crypto';

export function ensureTaskInboxSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_threads(
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,title TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS task_threads_user ON task_threads(user_id,updated_at DESC);`);
  if (!db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'thread_id')) db.exec('ALTER TABLE jobs ADD COLUMN thread_id TEXT');
  db.exec(`INSERT OR IGNORE INTO task_threads(id,user_id,title,created_at,updated_at)
    SELECT id,user_id,COALESCE(json_extract(payload,'$.text'),kind),created_at,updated_at FROM jobs WHERE thread_id IS NULL`);
  db.exec('UPDATE jobs SET thread_id=id WHERE thread_id IS NULL');
}

export function createTaskThread(db, userId, text, stamp=Date.now()) {
  const id=crypto.randomUUID();
  const title=String(text||'Task').replace(/\s+/g,' ').trim().slice(0,140)||'Task';
  db.prepare('INSERT INTO task_threads(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,userId,title,stamp,stamp);
  return id;
}

export function threadCandidates(db,userId,jobId) {
  return db.prepare(`SELECT t.id,t.title,t.updated_at,
    (SELECT text FROM conversation_messages m JOIN jobs j ON j.id=m.job_id WHERE j.thread_id=t.id AND m.role='assistant' AND m.user_id=? ORDER BY m.id DESC LIMIT 1) AS last_answer
    FROM task_threads t WHERE t.user_id=? AND t.id!=(SELECT thread_id FROM jobs WHERE id=? AND user_id=?)
    ORDER BY t.updated_at DESC LIMIT 12`).all(userId,userId,jobId,userId);
}

export function assignTaskThread(db,userId,jobId,threadId) {
  const job=db.prepare('SELECT thread_id FROM jobs WHERE id=? AND user_id=?').get(jobId,userId);
  const thread=db.prepare('SELECT id FROM task_threads WHERE id=? AND user_id=?').get(threadId,userId);
  if(!job||!thread)throw Error('Task thread unavailable');
  if(job.thread_id===threadId)return;
  db.prepare('UPDATE jobs SET thread_id=? WHERE id=? AND user_id=?').run(threadId,jobId,userId);
  db.prepare('UPDATE task_threads SET updated_at=? WHERE id=? AND user_id=?').run(Date.now(),threadId,userId);
  db.prepare('DELETE FROM task_threads WHERE id=? AND user_id=? AND NOT EXISTS(SELECT 1 FROM jobs WHERE thread_id=? AND user_id=?)').run(job.thread_id,userId,job.thread_id,userId);
}

export function inboxThreads(db,userId) {
  const rows=db.prepare(`SELECT t.id,t.title,t.created_at,t.updated_at,
    (SELECT status FROM jobs j WHERE j.thread_id=t.id AND j.user_id=t.user_id ORDER BY j.created_at DESC LIMIT 1) AS latest_status,
    (SELECT id FROM jobs j WHERE j.thread_id=t.id AND j.user_id=t.user_id ORDER BY j.created_at DESC LIMIT 1) AS latest_job_id,
    (SELECT text FROM conversation_messages m JOIN jobs j ON j.id=m.job_id WHERE j.thread_id=t.id AND m.role='assistant' AND m.user_id=t.user_id ORDER BY m.id DESC LIMIT 1) AS preview,
    (SELECT COUNT(*) FROM jobs j WHERE j.thread_id=t.id AND j.user_id=t.user_id) AS job_count,
    (SELECT MAX(s.updated_at) FROM task_steps s JOIN jobs j ON j.id=s.job_id WHERE j.thread_id=t.id AND s.user_id=t.user_id) AS last_step_at,
    (SELECT s.summary FROM task_steps s JOIN jobs j ON j.id=s.job_id WHERE j.thread_id=t.id AND s.user_id=t.user_id ORDER BY s.updated_at DESC LIMIT 1) AS last_step_summary,
    (SELECT COUNT(*) FROM jobs j WHERE j.thread_id=t.id AND j.user_id=t.user_id AND j.status='running') AS running_count,
    (SELECT COUNT(*) FROM jobs j WHERE j.thread_id=t.id AND j.user_id=t.user_id AND j.status='queued') AS queued_count,
    (SELECT COUNT(*) FROM task_approvals a JOIN jobs j ON j.id=a.job_id WHERE j.thread_id=t.id AND a.user_id=t.user_id AND a.status='pending' AND a.expires_at>?) AS pending_approvals,
    (SELECT COUNT(*) FROM task_questions q JOIN jobs j ON j.id=q.job_id WHERE j.thread_id=t.id AND q.user_id=t.user_id AND q.status='pending' AND q.expires_at>?) AS pending_questions
    FROM task_threads t WHERE t.user_id=? ORDER BY t.updated_at DESC LIMIT 100`).all(Date.now(),Date.now(),userId);
  return rows.map(row=>({...row,status:row.pending_approvals||row.pending_questions?'waiting':row.running_count?'working':row.queued_count?'queued':row.latest_status==='done'?'finished':row.latest_status==='canceled'?'paused':row.latest_status||'unknown'}));
}
