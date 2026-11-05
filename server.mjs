import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { startTelegramBot } from './telegram.mjs';
import { createOpenAIConnection } from './openai-connection.mjs';
import { syncUserFiles } from './user-profile.mjs';
import { ensureMemorySchema } from './memory.mjs';
import { ensureProactiveSchema } from './proactive.mjs';
import { ensureRecurringSchedule } from './schedule.mjs';
import { createArlongClient } from './arlong.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
if (fs.existsSync(path.join(root, '.env'))) {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}
const dataDir = path.resolve(process.env.TALISMAN_DATA_DIR || path.join(root, 'data'));
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'talisman.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS computers(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,pair_code_hash TEXT,pair_expires INTEGER,worker_key_hash TEXT,last_seen INTEGER,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,computer_id TEXT NOT NULL,user_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,result TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chat_sessions(id TEXT NOT NULL,computer_id TEXT NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(id,computer_id));
CREATE TABLE IF NOT EXISTS telegram_accounts(telegram_id TEXT PRIMARY KEY,user_id TEXT UNIQUE NOT NULL,chat_id TEXT NOT NULL,username TEXT,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS dashboard_pairs(code_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS computer_provisioning(computer_id TEXT PRIMARY KEY,status TEXT NOT NULL,container_name TEXT,error TEXT,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS telegram_sessions(user_id TEXT PRIMARY KEY,session_id TEXT,provider TEXT,model TEXT);
CREATE TABLE IF NOT EXISTS telegram_requests(job_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,chat_id TEXT NOT NULL,created_at INTEGER NOT NULL,delivered_at INTEGER);
CREATE TABLE IF NOT EXISTS conversation_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,job_id TEXT,role TEXT NOT NULL CHECK(role IN ('user','assistant')),text TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,chat_id TEXT NOT NULL,text TEXT NOT NULL,due_at INTEGER NOT NULL,sent_at INTEGER);
CREATE TABLE IF NOT EXISTS recurring_tasks(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,chat_id TEXT NOT NULL,instruction TEXT NOT NULL,interval_ms INTEGER NOT NULL,next_run_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS web_watches(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,chat_id TEXT NOT NULL,url TEXT NOT NULL,selector TEXT,interval_ms INTEGER NOT NULL,next_run_at INTEGER NOT NULL,last_hash TEXT,last_text TEXT,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,text TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memories(user_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,key));
CREATE TABLE IF NOT EXISTS model_preferences(user_id TEXT PRIMARY KEY,mode TEXT NOT NULL CHECK(mode IN ('automatic','free','openai')));
CREATE TABLE IF NOT EXISTS user_profiles(user_id TEXT PRIMARY KEY,step TEXT NOT NULL,preferred_name TEXT,goals TEXT,preferences TEXT,complete_at INTEGER);
CREATE TABLE IF NOT EXISTS app_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(computer_id,status,created_at);`);
db.exec('CREATE INDEX IF NOT EXISTS conversation_by_user ON conversation_messages(user_id,id);');
ensureMemorySchema(db);
ensureProactiveSchema(db);
ensureRecurringSchedule(db);
const random = () => crypto.randomBytes(24).toString('base64url');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const now = () => Date.now();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const SECURE = process.env.COOKIE_SECURE === '1';
const pairAttempts = new Map();
const apiLimits = new Map();
function rateLimit(bucket,limit,windowMs){const timestamp=now(),current=apiLimits.get(bucket);if(!current||current.reset<=timestamp){apiLimits.set(bucket,{count:1,reset:timestamp+windowMs});return true}if(current.count>=limit)return false;current.count+=1;return true}
function sameOrigin(req){if(req.headers['sec-fetch-site']==='cross-site')return false;const origin=req.headers.origin;if(!origin)return true;try{return new URL(origin).host===req.headers.host}catch{return false}}
function securityHeaders(res){res.setHeader('content-security-policy',"default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'");res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','no-referrer');res.setHeader('cross-origin-opener-policy','same-origin');res.setHeader('cross-origin-resource-policy','same-origin');res.setHeader('permissions-policy','geolocation=(), microphone=(), camera=(), payment=()');res.setHeader('x-permitted-cross-domain-policies','none');if(SECURE)res.setHeader('strict-transport-security','max-age=31536000; includeSubDomains')}
const openai = createOpenAIConnection(db, dataDir);
const arlong = createArlongClient();
for(const account of db.prepare('SELECT id FROM users').all()){db.prepare('INSERT OR IGNORE INTO proactive_settings(user_id) VALUES(?)').run(account.id);try{syncUserFiles(db,dataDir,account.id)}catch(error){console.error('Profile file sync failed:',error.message)}}
const modelPreference = userId => db.prepare('SELECT mode FROM model_preferences WHERE user_id=?').get(userId)?.mode || 'automatic';

function json(res,status,body,headers={}) { res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(JSON.stringify(body)); }
function fail(res,status,message) { json(res,status,{error:message}); }
async function body(req) { let chunks=[],size=0;for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw Error('Request too large');chunks.push(chunk)}return JSON.parse(Buffer.concat(chunks).toString()||'{}'); }
function cookie(req) { return /(?:^|; )talisman=([^;]+)/.exec(req.headers.cookie||'')?.[1]; }
function user(req) { const token=cookie(req);if(!token)return null;return db.prepare('SELECT users.id,users.email FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?').get(hash(token),now())||null; }
function computerFor(userId,id) { return db.prepare('SELECT * FROM computers WHERE id=? AND user_id=?').get(id,userId); }
function worker(req) { const token=req.headers.authorization?.replace(/^Bearer /,'');if(!token||token.length<20||token.length>512)return null;return db.prepare('SELECT * FROM computers WHERE worker_key_hash=?').get(hash(token))||null; }
function publicComputer(c) { const provision=db.prepare('SELECT status,error FROM computer_provisioning WHERE computer_id=?').get(c.id);return {name:c.name,online:!!c.last_seen&&now()-c.last_seen<45000,provisioning:provision?.status||null,provisionError:provision?.error||null}; }
function linkLegacyAccount(existingId,telegramId) {
  const linked=db.prepare('SELECT 1 FROM telegram_accounts WHERE user_id=?').get(existingId);
  if(linked) throw Error('This dashboard is already linked to a different Telegram account. Log out first.');
  const old=db.prepare('SELECT * FROM computers WHERE user_id=?').all(existingId);
  const assigned=db.prepare('SELECT * FROM computers WHERE user_id=?').all(telegramId);
  if(old.length>1||assigned.length!==1||old.some(c=>c.last_seen&&now()-c.last_seen<45_000)||db.prepare("SELECT 1 FROM jobs WHERE user_id=? AND status='running' LIMIT 1").get(existingId)||db.prepare('SELECT 1 FROM chat_sessions WHERE user_id=? LIMIT 1').get(existingId)) throw Error('This account has an active computer. Log out to use your Telegram account directly.');
  const computerId=assigned[0].id;
  db.exec('BEGIN IMMEDIATE');
  try {
    for(const computer of old){
      db.prepare('UPDATE jobs SET computer_id=?,user_id=? WHERE computer_id=? AND user_id=?').run(computerId,existingId,computer.id,existingId);
      db.prepare('DELETE FROM computer_provisioning WHERE computer_id=?').run(computer.id);
      db.prepare('DELETE FROM computers WHERE id=?').run(computer.id);
    }
    db.prepare('UPDATE computers SET user_id=? WHERE id=?').run(existingId,computerId);
    db.prepare('UPDATE jobs SET user_id=? WHERE user_id=?').run(existingId,telegramId);
    db.prepare('UPDATE reminders SET user_id=? WHERE user_id=?').run(existingId,telegramId);
    db.prepare('UPDATE recurring_tasks SET user_id=? WHERE user_id=?').run(existingId,telegramId);
    db.prepare('UPDATE web_watches SET user_id=? WHERE user_id=?').run(existingId,telegramId);
    db.prepare('UPDATE telegram_requests SET user_id=? WHERE user_id=?').run(existingId,telegramId);
    db.prepare('UPDATE conversation_messages SET user_id=? WHERE user_id=?').run(existingId,telegramId);
    db.prepare('UPDATE documents SET user_id=? WHERE user_id=?').run(existingId,telegramId);
    db.prepare('INSERT OR IGNORE INTO memories(user_id,key,value,updated_at) SELECT ?,key,value,updated_at FROM memories WHERE user_id=?').run(existingId,telegramId);
    db.prepare('DELETE FROM memories WHERE user_id=?').run(telegramId);
    db.prepare('UPDATE telegram_sessions SET user_id=? WHERE user_id=?').run(existingId,telegramId);
    db.prepare('UPDATE telegram_accounts SET user_id=? WHERE user_id=?').run(existingId,telegramId);
    db.prepare('UPDATE user_profiles SET user_id=? WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM user_profiles WHERE user_id=?)').run(existingId,telegramId,existingId);
    db.prepare('UPDATE model_preferences SET user_id=? WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM model_preferences WHERE user_id=?)').run(existingId,telegramId,existingId);
    db.prepare('UPDATE openai_connections SET user_id=? WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM openai_connections WHERE user_id=?)').run(existingId,telegramId,existingId);
    db.prepare('DELETE FROM user_profiles WHERE user_id=?').run(telegramId);
    db.prepare('DELETE FROM model_preferences WHERE user_id=?').run(telegramId);
    db.prepare('DELETE FROM openai_connections WHERE user_id=?').run(telegramId);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(telegramId);
    db.prepare('DELETE FROM dashboard_pairs WHERE user_id=?').run(telegramId);
    db.prepare('DELETE FROM users WHERE id=?').run(telegramId);
    db.exec('COMMIT');
  } catch(error){db.exec('ROLLBACK');throw error;}
  try{syncUserFiles(db,dataDir,existingId);const usersRoot=path.resolve(dataDir,'users'),oldDirectory=path.resolve(usersRoot,telegramId);if(oldDirectory.startsWith(usersRoot+path.sep))fs.rmSync(oldDirectory,{recursive:true,force:true})}catch(error){console.error('Profile file sync failed:',error.message)}
}
function staticFile(req,res) { const pathname=new URL(req.url,`http://${req.headers.host||'localhost'}`).pathname;const name=pathname==='/'?'index.html':pathname.slice(1);if(!['index.html','app.js','style.css'].includes(name))return fail(res,404,'Not found');const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};res.writeHead(200,{'content-type':types[path.extname(name)],'cache-control':'no-cache'});fs.createReadStream(path.join(root,'public',name)).pipe(res); }
async function handler(req,res) {
 const url=new URL(req.url,`http://${req.headers.host||'localhost'}`),p=url.pathname,m=req.method;
 securityHeaders(res);
 if(!rateLimit(`ip:${req.socket.remoteAddress||'unknown'}`,300,60_000))return fail(res,429,'Too many requests. Try again shortly.');
 const mutating=m==='POST'||m==='PUT'||m==='PATCH'||m==='DELETE';
 if(mutating&&!sameOrigin(req))return fail(res,403,'Request blocked: unexpected origin.');
 const hasBody=Number(req.headers['content-length']||0)>0||!!req.headers['transfer-encoding'];
 if(mutating&&hasBody&&!/^application\/json\b/i.test(req.headers['content-type']||''))return fail(res,415,'Send JSON with content-type application/json.');
 if(p==='/auth/callback'&&m==='GET'&&req.socket.localPort===1455){
  try {const u=user(req);if(!u)throw Error('Talisman session expired. Pair this browser again.');await openai.callback(url,u.id);res.writeHead(303,{'location':'http://127.0.0.1:3000/?openai=connected','cache-control':'no-store'});return res.end();}
  catch(error){res.writeHead(303,{'location':`http://127.0.0.1:3000/?openai=error&detail=${encodeURIComponent(error.message)}`,'cache-control':'no-store'});return res.end();}
 }
 if(!p.startsWith('/api/'))return staticFile(req,res);
 try {
  if(p==='/api/health'&&m==='GET')return json(res,200,{ok:true});
  if(p==='/api/config'&&m==='GET')return json(res,200,{telegramBotUsername:db.prepare("SELECT value FROM app_state WHERE key='telegram_bot_username'").get()?.value||process.env.TELEGRAM_BOT_USERNAME||null});
  if(p==='/api/pair'&&m==='POST') {const key=req.socket.remoteAddress||'unknown',attempt=pairAttempts.get(key)||{count:0,until:now()+600_000};if(attempt.until<now()){attempt.count=0;attempt.until=now()+600_000}if(attempt.count>=8)return fail(res,429,'Too many attempts. Try again later.');const b=await body(req),code=String(b.code||'').replace(/\s/g,'').toUpperCase();if(!/^[A-F0-9]{12}$/.test(code))return fail(res,400,'Enter the 12-character code from Telegram');const pair=db.prepare('SELECT * FROM dashboard_pairs WHERE code_hash=? AND expires_at>?').get(hash(code),now());if(!pair){attempt.count++;pairAttempts.set(key,attempt);return fail(res,401,'Code invalid or expired. Send /start to the bot for a new one.')}const existing=user(req);if(existing&&existing.id!==pair.user_id){try{linkLegacyAccount(existing.id,pair.user_id)}catch(error){return fail(res,409,error.message)}}pairAttempts.delete(key);const accountId=existing?.id||pair.user_id;db.prepare('DELETE FROM dashboard_pairs WHERE user_id=?').run(accountId);const account=db.prepare('SELECT username FROM telegram_accounts WHERE user_id=?').get(accountId);return login(res,accountId,account?.username?`@${account.username}`:'Telegram account');}
  if(p==='/api/logout'&&m==='POST') {const token=cookie(req);if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));return json(res,200,{ok:true},{'set-cookie':`talisman=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE?'; Secure':''}`});}
  if(p.startsWith('/api/worker/')) {const c=worker(req);if(!c)return fail(res,401,'Worker unauthorized');db.prepare('UPDATE computers SET last_seen=? WHERE id=?').run(now(),c.id);
   if(p==='/api/worker/arlong/search'&&m==='POST'){const b=await body(req);return json(res,200,await arlong.search(b.query));}
   if(p==='/api/worker/arlong/extract'&&m==='POST'){const b=await body(req);return json(res,200,await arlong.extract(b.url));}
   if(p==='/api/worker/arlong/screen'&&m==='POST'){const b=await body(req);return json(res,200,await arlong.screen(b));}
   if(p==='/api/worker/openai/status'&&m==='GET')return json(res,200,{connected:openai.status(c.user_id).connected,preference:modelPreference(c.user_id)});
   if(p==='/api/worker/openai'&&m==='POST'){const b=await body(req);if(!openai.status(c.user_id).connected)return fail(res,409,'OpenAI account is not connected');if(typeof b.text!=='string'||b.text.length>50000)return fail(res,400,'Invalid task');const controller=new AbortController();res.on('close',()=>controller.abort());const text=await openai.generate(c.user_id,b.text,Array.isArray(b.context)?b.context.slice(0,20):[],String(b.soul||'').slice(0,5000),controller.signal,Array.isArray(b.history)?b.history:[],String(b.timeZone||'UTC').slice(0,60));if(!res.destroyed)return json(res,200,{text});return;}
   if(p==='/api/worker/openai/step'&&m==='POST'){const b=await body(req);if(!openai.status(c.user_id).connected)return fail(res,409,'OpenAI account is not connected');if(typeof b.text!=='string'||b.text.length>50000||!Array.isArray(b.input)||b.input.length>60)return fail(res,400,'Invalid task');const controller=new AbortController();res.on('close',()=>controller.abort());const result=await openai.step(c.user_id,b.text,Array.isArray(b.context)?b.context.slice(0,20):[],String(b.soul||'').slice(0,5000),b.input,controller.signal,String(b.timeZone||'UTC').slice(0,60));if(!res.destroyed)return json(res,200,result);return;}
   if(p==='/api/worker/jobs'&&m==='GET') {const job=db.prepare("SELECT * FROM jobs WHERE computer_id=? AND status='queued' ORDER BY created_at LIMIT 1").get(c.id);if(job){db.prepare("UPDATE jobs SET status='running',updated_at=? WHERE id=?").run(now(),job.id);const payload=JSON.parse(job.payload);if(job.kind==='message'){const current=db.prepare("SELECT id FROM conversation_messages WHERE job_id=? AND role='user' ORDER BY id DESC LIMIT 1").get(job.id);payload.history=db.prepare('SELECT role,text FROM conversation_messages WHERE user_id=? AND id<? ORDER BY id DESC LIMIT 16').all(job.user_id,current?.id??Number.MAX_SAFE_INTEGER).reverse();payload.sessionId=db.prepare('SELECT session_id FROM telegram_sessions WHERE user_id=?').get(job.user_id)?.session_id||undefined;}return json(res,200,{job:{id:job.id,kind:job.kind,payload}})}return json(res,200,{job:null});}
   const match=/^\/api\/worker\/jobs\/([a-f0-9-]+)$/.exec(p);if(match&&m==='GET'){const j=db.prepare('SELECT status FROM jobs WHERE id=? AND computer_id=?').get(match[1],c.id);if(!j)return fail(res,404,'Job not found');if(j.status==='running')db.prepare('UPDATE jobs SET updated_at=? WHERE id=?').run(now(),match[1]);return json(res,200,j);}if(match&&m==='POST'){const b=await body(req),j=db.prepare('SELECT * FROM jobs WHERE id=? AND computer_id=?').get(match[1],c.id);if(!j)return fail(res,404,'Job not found');if(j.status==='canceled')return json(res,200,{ok:true,canceled:true});if(j.status!=='running')return fail(res,409,'Job is not running');db.exec('BEGIN IMMEDIATE');try{if(!b.error&&j.kind==='watch'){const target=db.prepare('SELECT * FROM web_watches WHERE id=? AND user_id=?').get(String(b.result?.watchId||''),j.user_id);const extracted=String(b.result?.extracted||'').slice(0,20000);if(!target||!extracted)b.result={silent:true};else{const digest=hash(extracted),changed=target.last_hash&&target.last_hash!==digest;db.prepare('UPDATE web_watches SET last_hash=?,last_text=? WHERE id=?').run(digest,extracted,target.id);const before=String(target.last_text||'');const index=changed?[...extracted].findIndex((ch,i)=>ch!==before[i]):-1;const snippet=index<0?extracted.slice(0,350):extracted.slice(Math.max(0,index-100),Math.min(extracted.length,index+450));b.result=changed?{text:`I noticed a change on ${String(b.result.title||'this page').slice(0,100)}:\n${snippet}\n${target.url}`}:{silent:true};}}db.prepare("UPDATE jobs SET status=?,result=?,updated_at=? WHERE id=? AND status='running'").run(b.error?'failed':'done',JSON.stringify(b.error?{error:String(b.error)}:b.result),now(),j.id);if(!b.error&&j.kind==='message'){if(b.result?.sessionId){db.prepare('INSERT OR IGNORE INTO chat_sessions VALUES(?,?,?)').run(String(b.result.sessionId),c.id,j.user_id);db.prepare('INSERT INTO telegram_sessions(user_id,session_id) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET session_id=excluded.session_id').run(j.user_id,String(b.result.sessionId));}if(typeof b.result?.text==='string'&&b.result.text.trim())db.prepare("INSERT INTO conversation_messages(user_id,job_id,role,text,created_at) VALUES(?,?,'assistant',?,?)").run(j.user_id,j.id,b.result.text.slice(0,20000),now());}db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error}return json(res,200,{ok:true});}return fail(res,404,'Not found');
  }
  const u=user(req);if(!u)return fail(res,401,'Sign in required');
  if(p==='/api/me'&&m==='GET'){const account=db.prepare('SELECT username FROM telegram_accounts WHERE user_id=?').get(u.id);return json(res,200,{id:u.id,displayName:account?.username?`@${account.username}`:u.email,telegramConnected:!!account});}
  if(p==='/api/computers'&&m==='GET')return json(res,200,db.prepare('SELECT * FROM computers WHERE user_id=? ORDER BY created_at DESC').all(u.id).map(publicComputer));
  if(p==='/api/memories'&&m==='GET')return json(res,200,db.prepare('SELECT key,value,updated_at FROM memories WHERE user_id=? ORDER BY key').all(u.id));
  if(p==='/api/openai/status'&&m==='GET')return json(res,200,openai.status(u.id));
  if(p==='/api/models/preference'&&m==='GET')return json(res,200,{mode:modelPreference(u.id)});
  if(p==='/api/models/preference'&&m==='POST'){const b=await body(req),mode=String(b.mode||'');if(!['automatic','free','openai'].includes(mode))return fail(res,400,'Invalid model choice');if(mode==='openai'&&!openai.status(u.id).connected)return fail(res,409,'Connect OpenAI first');db.prepare('INSERT INTO model_preferences(user_id,mode) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET mode=excluded.mode').run(u.id,mode);return json(res,200,{mode});}
  if(p==='/api/openai/tiers'&&m==='GET'){const available=await openai.models(u.id);return json(res,200,{economical:!!available.economical,balanced:!!available.balanced});}
  if(p==='/api/openai/start'&&m==='GET'){res.writeHead(303,{'location':openai.start(u.id),'cache-control':'no-store'});return res.end();}
  if(p==='/api/openai/disconnect'&&m==='POST'){openai.disconnect(u.id);db.prepare("UPDATE model_preferences SET mode='automatic' WHERE user_id=? AND mode='openai'").run(u.id);return json(res,200,{ok:true});}
  return fail(res,404,'Not found');
 }catch(error){const message=String(error?.message||'Request failed');if(p.startsWith('/api/worker/'))return fail(res,400,message.slice(0,300));console.error('API request failed:',p,message.slice(0,200));return fail(res,400,'The request could not be completed.');}
}
function login(res,id,email){db.prepare('DELETE FROM sessions WHERE user_id=? AND expires_at<?').run(id,now());const token=random();db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token),id,now()+30*24*60*60_000);return json(res,200,{id,email},{'set-cookie':`talisman=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${SECURE?'; Secure':''}`});}
const server=http.createServer(handler);
server.headersTimeout=20_000;server.requestTimeout=60_000;server.keepAliveTimeout=5_000;
const callbackServer=http.createServer(handler);
callbackServer.headersTimeout=20_000;callbackServer.requestTimeout=60_000;callbackServer.keepAliveTimeout=5_000;
setInterval(()=>{try{db.prepare("UPDATE jobs SET status='failed',result=?,updated_at=? WHERE status='running' AND updated_at<?").run(JSON.stringify({error:'The computer task was interrupted. Please retry.'}),now(),now()-5*60_000);db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now());db.prepare('DELETE FROM dashboard_pairs WHERE expires_at<?').run(now());for(const [key,value] of apiLimits)if(value.reset<=now())apiLimits.delete(key);}catch(error){console.error('Stale job recovery:',error.message)}},30_000);
server.listen(PORT,HOST,()=>console.log(`Talisman listening on http://${HOST}:${PORT}`));
if(process.env.OPENAI_LOCAL_SIGNIN!=='0')callbackServer.listen(1455,HOST,()=>console.log('OpenAI callback listener ready'));
if(process.env.TELEGRAM_BOT_TOKEN&&process.env.TELEGRAM_ENABLED!=='0')startTelegramBot({db,hash,random,now,port:PORT,dataDir}).catch(e=>console.error('Telegram bot stopped:',e.message));
