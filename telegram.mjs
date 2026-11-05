import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { answerOnboarding, startOnboarding, syncUserFiles, userSoul } from './user-profile.mjs';
import { rememberFromMessage, searchMemories, selectMemoryContext, upsertMemory } from './memory.mjs';
import { formatWhen, nextDailyAt, parseWhenPrefix, validTimeZone } from './schedule.mjs';
import { proactiveSettings, quietNow, runProactiveTick } from './proactive.mjs';
import { formatChunks } from './telegram-format.mjs';
import { decideApproval, taskReceipt, logTaskEvent } from './orchestration.mjs';

const upsertState = (db, key, value) => db.prepare('INSERT INTO app_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));

export function ensureTelegramAccount(db, message, { hash, random, now, dataDir }) {
  if (message.chat?.type !== 'private' || !message.from?.id) return null;
  const telegramId = String(message.from.id);
  const chatId = String(message.chat.id);
  let account = db.prepare('SELECT * FROM telegram_accounts WHERE telegram_id=?').get(telegramId);
  if (account) {
    db.prepare('UPDATE telegram_accounts SET chat_id=?,username=? WHERE telegram_id=?').run(chatId, message.from.username || null, telegramId);
    return { userId: account.user_id, computer: db.prepare('SELECT * FROM computers WHERE user_id=? ORDER BY created_at LIMIT 1').get(account.user_id), created: false };
  }
  const userId = crypto.randomUUID();
  const computerId = crypto.randomUUID();
  const salt = random();
  const disabledPassword = crypto.scryptSync(random(), salt, 64).toString('hex');
  const timestamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run(userId, `telegram-${telegramId}@talisman.invalid`, `${salt}:${disabledPassword}`, timestamp);
    db.prepare('INSERT INTO telegram_accounts(telegram_id,user_id,chat_id,username,created_at) VALUES(?,?,?,?,?)').run(telegramId, userId, chatId, message.from.username || null, timestamp);
    db.prepare('INSERT INTO computers(id,user_id,name,created_at) VALUES(?,?,?,?)').run(computerId, userId, 'My cloud computer', timestamp);
    db.prepare('INSERT INTO computer_provisioning(computer_id,status,updated_at) VALUES(?,?,?)').run(computerId, 'pending', timestamp);
    startOnboarding(db, userId);
    db.prepare('INSERT OR IGNORE INTO proactive_settings(user_id) VALUES(?)').run(userId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  try { syncUserFiles(db, dataDir, userId); } catch (error) { console.error('Profile file sync failed:', error.message); }
  return { userId, computer: db.prepare('SELECT * FROM computers WHERE id=?').get(computerId), created: true };
}

export function issueDashboardCode(db, userId, { hash, now }) {
  const code = crypto.randomBytes(6).toString('hex').toUpperCase();
  db.prepare('DELETE FROM dashboard_pairs WHERE user_id=?').run(userId);
  db.prepare('INSERT INTO dashboard_pairs(code_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(hash(code), userId, now() + 10 * 60_000, now());
  return code;
}

function enqueue(db, userId, computerId, kind, payload) {
  if (kind === 'message') {
    rememberFromMessage(db, userId, String(payload.text || ''));
    const settings = proactiveSettings(db, userId);
    const memory = selectMemoryContext(db, userId, String(payload.text || ''));
    payload = { ...payload, context: memory.entries, memoryIndex: memory.index, timeZone: settings.timezone, soul: userSoul(db, userId) };
  }
  const id = crypto.randomUUID();
  const timestamp = Date.now();
  db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)').run(id, computerId, userId, kind, JSON.stringify(payload), 'queued', null, timestamp, timestamp);
  if (kind === 'message') db.prepare("INSERT INTO conversation_messages(user_id,job_id,role,text,created_at) VALUES(?,?,'user',?,?)").run(userId,id,String(payload.text||'').slice(0,20000),timestamp);
  return id;
}

export async function deliverTelegramResults(db, send) {
  const completed = db.prepare(`SELECT r.job_id,r.user_id,r.chat_id,j.kind,j.status,j.result FROM telegram_requests r
    JOIN jobs j ON j.id=r.job_id WHERE r.delivered_at IS NULL AND j.status IN ('done','failed') ORDER BY r.created_at LIMIT 20`).all();
  for (const row of completed) {
    const result = row.result ? JSON.parse(row.result) : {};
    if (row.status === 'done' && result.sessionId) db.prepare('INSERT INTO telegram_sessions(user_id,session_id) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET session_id=excluded.session_id').run(row.user_id, result.sessionId);
    if (row.status === 'done' && result.silent) { db.prepare('UPDATE telegram_requests SET delivered_at=? WHERE job_id=? AND delivered_at IS NULL').run(Date.now(),row.job_id); continue; }
    if (row.status === 'done' && row.kind === 'document' && result.extracted) db.prepare('INSERT OR IGNORE INTO documents(id,user_id,name,text,created_at) VALUES(?,?,?,?,?)').run(row.job_id,row.user_id,String(result.filename||'document'),String(result.extracted).slice(0,100_000),Date.now());
    const error = String(result.error || '');
    const reply = row.status === 'done' ? (result.text || 'I finished, but there was no written result to send back.') : error.includes('usage limit') ? 'I hit the free model limit. You can switch to OpenAI in Models, or try again later.' : error.includes('No free model') ? 'No free model is available right now. Try OpenAI in Models.' : error.includes('website blocked browser') ? 'That site blocked my browser, so I could not verify the page. I can try another source if you send me the site or item.' : error.includes('computer task step limit') ? 'I hit my step limit while checking that. Send me a narrower version and I’ll keep going.' : 'Something went wrong on my side. Could you try that once more?';
    await send(row.chat_id, reply);
    db.prepare('UPDATE telegram_requests SET delivered_at=? WHERE job_id=? AND delivered_at IS NULL').run(Date.now(), row.job_id);
  }
}

export async function handleTelegramMessage(db, message, dependencies) {
  const account = ensureTelegramAccount(db, message, dependencies);
  if (!account) return;
  const { userId, computer } = account;
  const chatId = String(message.chat.id);
  const text = String(message.text || '').trim();
  const send = text => dependencies.send(chatId, text);
  if(message.document){
    const online=computer.last_seen&&Date.now()-computer.last_seen<45_000;
    if(!online)return send('Your computer is still starting. Please forward the file again after /status says it is online.');
    if(!dependencies.downloadDocument)return send('File download is temporarily unavailable.');
    if(message.document.file_size>10*1024*1024)return send('Please send a file under 10 MB.');
    if(db.prepare('SELECT 1 FROM telegram_requests WHERE user_id=? AND delivered_at IS NULL LIMIT 1').get(userId))return send('I am still working on your previous request. Please send the file again after I reply.');
    try{
      const bytes=await dependencies.downloadDocument(message.document.file_id);
      const jobId=enqueue(db,userId,computer.id,'document',{filename:message.document.file_name||'document',base64:bytes.toString('base64')});
      db.prepare('INSERT INTO telegram_requests(job_id,user_id,chat_id,created_at) VALUES(?,?,?,?)').run(jobId,userId,chatId,Date.now());
      return send(`Got ${String(message.document.file_name || 'the file').slice(0, 80)}. I'll read it and send you what I find.`);
    }catch{return send('I could not download that file. Please try again.')}
  }
  if (!text) return send('Send me a text message to start a task.');
  if (/^\/help(?:@\w+)?$/i.test(text)) return send('Just tell me what you need, or forward a PDF or spreadsheet.\n\nMemory: /remember, /memories, /memory <search>, /forget\nSchedule: /remind, /at 09:00 …, /daily 08:30 …, /every 2h …, /scheduled, /cancel ID\nSettings: /status, /receipt, /mode, /timezone, /brief, /proactive on|off, /documents, /watch, /setup\nControl: /kill stops the current work and keeps your memory.');
  if (/^\/receipt(?:@\w+)?$/i.test(text)) {
    const latest=db.prepare('SELECT id FROM jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(userId);
    if(!latest)return send('No task receipt yet.');
    const receipt=taskReceipt(db,latest.id,userId);
    return send(`Latest task: ${receipt.status}\n${receipt.steps.slice(-12).map(step=>`• ${step.kind}: ${step.status}`).join('\n')||'No computer actions recorded yet.'}`);
  }
  if (/^\/kill(?:@\w+)?$/i.test(text)) {
    const timestamp = Date.now();
    const canceled = db.prepare("SELECT id FROM jobs WHERE user_id=? AND status IN ('queued','running')").all(userId);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE jobs SET status='canceled',result=?,updated_at=? WHERE user_id=? AND status IN ('queued','running')").run(JSON.stringify({error:'Canceled by user'}),timestamp,userId);
      const drop = db.prepare('DELETE FROM conversation_messages WHERE user_id=? AND job_id=?');
      for (const job of canceled) drop.run(userId, job.id);
      db.prepare('UPDATE telegram_requests SET delivered_at=? WHERE user_id=? AND delivered_at IS NULL').run(timestamp,userId);
      db.prepare("UPDATE task_approvals SET status='rejected',decided_at=? WHERE user_id=? AND status='pending'").run(timestamp,userId);
      for(const job of canceled)logTaskEvent(db,job.id,userId,'canceled','Canceled by user');
      db.prepare('DELETE FROM telegram_sessions WHERE user_id=?').run(userId);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return send(canceled.length ? 'Stopped that task. Your memory, notes and schedule are untouched.' : 'Nothing running right now — memory and schedule are intact. What next?');
  }
  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text) || /^\/pair(?:@\w+)?$/i.test(text)) {
    const code = issueDashboardCode(db, userId, dependencies);
    const url = dependencies.publicUrl ? `${dependencies.publicUrl.replace(/\/$/, '')}/` : 'your Talisman dashboard';
    if (account.created) return send(`Hey, I'm Talisman. I'm setting up your computer now.\n\nTo link the dashboard, open ${url} and enter this code:\n\n${code}\n\nIt lasts 10 minutes. Before we get started, what should I call you? You can send /skip if you'd rather jump in.`);
    return send(`Here's a fresh dashboard code for you:\n\n${code}\n\nOpen ${url} and enter it within 10 minutes.`);
  }
  if (/^\/setup(?:@\w+)?$/i.test(text)) { startOnboarding(db, userId); try { syncUserFiles(db, dependencies.dataDir, userId); } catch (error) { console.error('Profile file sync failed:', error.message); } return send('Let’s get to know each other a little. What should I call you? You can send /skip at any point.'); }
  const reminder = /^\/remind(?:@\w+)?\s+(\d+)([mhd])\s+([\s\S]+)$/i.exec(text);
  if (reminder) {
    const count = Number(reminder[1]);
    const duration = { m: 60_000, h: 3_600_000, d: 86_400_000 }[reminder[2].toLowerCase()] * count;
    if (!Number.isSafeInteger(duration) || duration < 60_000 || duration > 365 * 86_400_000 || reminder[3].length > 1000) return send('Use /remind 10m, 2h, or 1d followed by a short reminder.');
    db.prepare('INSERT INTO reminders(id,user_id,chat_id,text,due_at) VALUES(?,?,?,?,?)').run(crypto.randomUUID(), userId, chatId, reminder[3].trim(), Date.now() + duration);
    return send(`I will remind you in ${count}${reminder[2].toLowerCase()}.`);
  }
  if (/^\/reminders(?:@\w+)?$/i.test(text)) {
    const rows = db.prepare('SELECT text,due_at FROM reminders WHERE user_id=? AND sent_at IS NULL ORDER BY due_at LIMIT 20').all(userId);
    return send(rows.length ? `Upcoming reminders:\n${rows.map(row => `• In ${Math.max(1, Math.ceil((row.due_at - Date.now()) / 60_000))} min: ${row.text}`).join('\n')}` : 'You have no upcoming reminders.');
  }
  if (/^\/documents(?:@\w+)?$/i.test(text)){
    const rows=db.prepare('SELECT id,name,created_at FROM documents WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(userId);
    return send(rows.length?rows.map(row=>`${row.id.slice(0,8)} · ${row.name}`).join('\n'):'No saved documents yet. Forward a PDF, spreadsheet, CSV, or text file.');
  }
  const documentRequest=/^\/document(?:@\w+)?\s+([a-fA-F0-9]{8})$/i.exec(text);
  if(documentRequest){
    const rows=db.prepare('SELECT name,text FROM documents WHERE user_id=? AND id LIKE ? LIMIT 2').all(userId,`${documentRequest[1].toLowerCase()}%`);
    return send(rows.length===1?`${rows[0].name}\n\n${rows[0].text.slice(0,3500)}`:'Document not found or ID is ambiguous.');
  }
  const recurring = /^\/every(?:@\w+)?\s+(\d+)([mhd])\s+([\s\S]+)$/i.exec(text);
  if (recurring) {
    const interval = Number(recurring[1]) * {m:60_000,h:3_600_000,d:86_400_000}[recurring[2].toLowerCase()];
    const instruction = recurring[3].trim();
    if (!Number.isSafeInteger(interval) || interval < 5*60_000 || interval > 30*86_400_000 || !instruction || instruction.length > 1000) return send('Use /every 30m, 2h, or 1d followed by a task of up to 1000 characters. Minimum interval: 5 minutes.');
    if (db.prepare('SELECT count(*) AS n FROM recurring_tasks WHERE user_id=?').get(userId).n >= 20) return send('You have reached the limit of 20 recurring tasks. Stop one before adding another.');
    const id=crypto.randomBytes(4).toString('hex').toUpperCase();
    db.prepare('INSERT INTO recurring_tasks(id,user_id,chat_id,instruction,interval_ms,next_run_at,created_at) VALUES(?,?,?,?,?,?,?)').run(id,userId,chatId,instruction,interval,Date.now()+interval,Date.now());
    return send(`Scheduled ${id}. I will run it every ${recurring[1]}${recurring[2].toLowerCase()}. Use /stop ${id} to cancel.`);
  }
  if (/^\/schedule(?:@\w+)?$/i.test(text)) {
    const rows=db.prepare('SELECT id,instruction,next_run_at FROM recurring_tasks WHERE user_id=? ORDER BY next_run_at LIMIT 20').all(userId);
    return send(rows.length?rows.map(row=>`${row.id} · ${row.instruction} · next in ${Math.max(1,Math.ceil((row.next_run_at-Date.now())/60_000))} min`).join('\n'):'No recurring tasks. Use /every 1h followed by a task.');
  }
  const stop=/^\/stop(?:@\w+)?\s+([A-Fa-f0-9]{8})$/i.exec(text);
  if(stop) return send(db.prepare('DELETE FROM recurring_tasks WHERE id=? AND user_id=?').run(stop[1].toUpperCase(),userId).changes?'Recurring task stopped.':'I could not find that task.');
  const watch=/^\/watch(?:@\w+)?\s+(\d+)([mhd])\s+(\S+)(?:\s+([\s\S]+))?$/i.exec(text);
  if(watch){
    const interval=Number(watch[1])*{m:60_000,h:3_600_000,d:86_400_000}[watch[2].toLowerCase()];
    if(!Number.isSafeInteger(interval)||interval<5*60_000||interval>30*86_400_000)return send('Use /watch 30m https://example.com. The minimum interval is 5 minutes.');
    let url;try{url=new URL(watch[3]);const host=url.hostname.toLowerCase();if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.href.length>2000||host==='localhost'||host.endsWith('.local')||host.endsWith('.internal')||/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|::1$)/.test(host)||/^172\.(?:1[6-9]|2\d|3[01])\./.test(host))throw Error('Invalid URL');}catch{return send('Send a public http or https page URL, like /watch 30m https://example.com.');}
    const selector=String(watch[4]||'').trim();
    if(selector.length>200)return send('Keep the CSS selector under 200 characters.');
    if(db.prepare('SELECT count(*) AS n FROM web_watches WHERE user_id=?').get(userId).n>=20)return send('You can watch up to 20 pages. Stop one with /unwatch ID first.');
    const id=crypto.randomBytes(4).toString('hex').toUpperCase();
    db.prepare('INSERT INTO web_watches VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,userId,chatId,url.href,selector||null,interval,Date.now(),null,null,Date.now());
    return send(`I’ll check that page every ${watch[1]}${watch[2].toLowerCase()} and message you if it changes. Watch ID: ${id}. Use /unwatch ${id} to stop.`);
  }
  if(/^\/watch(?:@\w+)?(?:\s|$)/i.test(text))return send('Use /watch 30m https://example.com. You can add a CSS selector after the URL to watch just one part of the page.');
  if(/^\/watches(?:@\w+)?$/i.test(text)){
    const rows=db.prepare('SELECT id,url,interval_ms FROM web_watches WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(userId);
    return send(rows.length?rows.map(row=>`${row.id} · every ${Math.round(row.interval_ms/60_000)} min · ${row.url}`).join('\n'):'No pages watched yet. Use /watch 30m followed by a URL.');
  }
  const unwatch=/^\/unwatch(?:@\w+)?\s+([A-Fa-f0-9]{8})$/i.exec(text);
  if(unwatch)return send(db.prepare('DELETE FROM web_watches WHERE id=? AND user_id=?').run(unwatch[1].toUpperCase(),userId).changes?'Stopped watching that page.':'I could not find that watch.');
  const remember = /^\/remember(?:@\w+)?\s+([^:]{1,80}):\s*([\s\S]{1,2000})$/i.exec(text);
  if (remember) {
    const key = remember[1].trim().toLowerCase();
    db.prepare('INSERT INTO memories(user_id,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(userId, key, remember[2].trim(), Date.now());
    try { syncUserFiles(db, dependencies.dataDir, userId); } catch (error) { console.error('Memory file sync failed:', error.message); }
    return send(`Saved “${key}”.`);
  }
  const naturalRemember=/^(?:please\s+)?remember that\s+(.{1,1000})$/i.exec(text);
  if(naturalRemember){
    const value=naturalRemember[1].trim().replace(/[.!]+$/,'');
    const key=`note ${crypto.createHash('sha256').update(value.toLowerCase()).digest('hex').slice(0,8)}`;
    db.prepare('INSERT INTO memories(user_id,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(userId,key,value,Date.now());
    try { syncUserFiles(db, dependencies.dataDir, userId); } catch (error) { console.error('Memory file sync failed:', error.message); }
    return send('I’ll remember that.');
  }
  if (/^\/memories(?:@\w+)?$/i.test(text)) {
    const rows = db.prepare('SELECT key,value,kind FROM memories WHERE user_id=? ORDER BY importance DESC,updated_at DESC LIMIT 25').all(userId);
    return send(rows.length ? `I keep ${db.prepare('SELECT count(*) AS n FROM memories WHERE user_id=?').get(userId).n} things for you. Newest and most useful:\n${rows.map(row => `${row.key}: ${row.value}`).join('\n')}` : 'No saved memories yet. Use /remember name: value.');
  }
  const memoryLookup = /^\/memory(?:@\w+)?\s+([\s\S]+)$/i.exec(text);
  if (memoryLookup) {
    const rows = searchMemories(db, userId, memoryLookup[1]);
    return send(rows.length ? rows.map(row => `${row.key}: ${row.value}`).join('\n') : 'Nothing saved on that yet.');
  }
  const forget = /^\/forget(?:@\w+)?\s+(.+)$/i.exec(text);
  if (forget) {
    const removed = db.prepare('DELETE FROM memories WHERE user_id=? AND key=?').run(userId, forget[1].trim().toLowerCase()).changes;
    if (removed) try { syncUserFiles(db, dependencies.dataDir, userId); } catch (error) { console.error('Memory file sync failed:', error.message); }
    return send(removed ? 'Forgotten.' : 'I could not find that memory.');
  }
  const naturalForget=/^(?:please\s+)?forget that\s+(.{1,1000})$/i.exec(text);
  if(naturalForget){
    const value=naturalForget[1].trim().replace(/[.!]+$/,'');
    const removed=db.prepare('DELETE FROM memories WHERE user_id=? AND lower(value)=lower(?)').run(userId,value).changes;
    if(removed)try{syncUserFiles(db,dependencies.dataDir,userId)}catch(error){console.error('Memory file sync failed:',error.message)}
    return send(removed?'Okay, I’ve forgotten that.':'I couldn’t find that in what I remember.');
  }
  if (/^\/timezone(?:@\w+)?(?:\s.*)?$/i.test(text)) {
    const value = text.replace(/^\/timezone(?:@\w+)?\s*/i, '').trim();
    const settings = proactiveSettings(db, userId);
    if (!value) return send(`I have you in ${settings.timezone}. Send /timezone Asia/Kolkata to change it.`);
    if (!validTimeZone(value)) return send('That timezone name did not look right. Try something like Asia/Kolkata or Europe/London.');
    db.prepare('UPDATE proactive_settings SET timezone=? WHERE user_id=?').run(value, userId);
    upsertMemory(db, userId, { key: 'timezone', value, kind: 'fact', importance: 5 }, Date.now());
    try { syncUserFiles(db, dependencies.dataDir, userId); } catch (error) { console.error('Profile file sync failed:', error.message); }
    return send(`Set — I will use ${value} from now on.`);
  }
  if (/^\/proactive(?:@\w+)?(?:\s+(?:on|off))?$/i.test(text)) {
    const settings = proactiveSettings(db, userId);
    const choice = /^\/proactive(?:@\w+)?\s+(on|off)/i.exec(text)?.[1]?.toLowerCase();
    if (!choice) return send(settings.enabled ? `I check in on my own: a short morning brief at ${String(settings.brief_hour).padStart(2, '0')}:${String(settings.brief_minute).padStart(2, '0')} ${settings.timezone}, plus a nudge if I asked you something and you did not answer. /proactive off stops it.` : 'Proactive check-ins are off. /proactive on turns them back on.');
    db.prepare('UPDATE proactive_settings SET enabled=? WHERE user_id=?').run(choice === 'on' ? 1 : 0, userId);
    return send(choice === 'on' ? 'On. I will speak first when there is something worth saying.' : 'Off. I will only reply when you message me.');
  }
  if (/^\/brief(?:@\w+)?(?:\s.*)?$/i.test(text)) {
    const value = /^\/brief(?:@\w+)?\s+(\d{1,2}):(\d{2})$/i.exec(text);
    if (value && +value[1] <= 23 && +value[2] <= 59) {
      db.prepare('UPDATE proactive_settings SET brief_hour=?,brief_minute=? WHERE user_id=?').run(+value[1], +value[2], userId);
      return send(`Morning brief set for ${String(value[1]).padStart(2, '0')}:${value[2]}.`);
    }
    const settings = proactiveSettings(db, userId);
    return send(`Morning brief at ${String(settings.brief_hour).padStart(2, '0')}:${String(settings.brief_minute).padStart(2, '0')} ${settings.timezone}. Send /brief 08:30 to change it, /proactive off to stop check-ins.`);
  }
  const atCommand = /^\/at(?:@\w+)?\s+([\s\S]+)$/i.exec(text);
  if (atCommand) {
    const settings = proactiveSettings(db, userId);
    const parsed = parseWhenPrefix(atCommand[1], settings.timezone);
    if (!parsed || !parsed.rest) return send('Use /at 09:00 call the dentist, /at tomorrow 9am book the cab, or /at 2026-11-05 09:00 send the invoice.');
    if (parsed.at < Date.now() + 30_000) return send('That time has already passed. Send a future time.');
    const id = crypto.randomBytes(4).toString('hex').toUpperCase();
    db.prepare('INSERT INTO scheduled_tasks(id,user_id,chat_id,instruction,run_at,status,created_at) VALUES(?,?,?,?,?,?,?)').run(id, userId, chatId, parsed.rest.slice(0, 500), parsed.at, 'pending', Date.now());
    return send(`Scheduled ${id} for ${formatWhen(parsed.at, settings.timezone)}: ${parsed.rest.slice(0, 120)}\nSend /cancel ${id} to stop it.`);
  }
  const dailyCommand = /^\/daily(?:@\w+)?\s+(\d{1,2}):(\d{2})\s+([\s\S]+)$/i.exec(text);
  if (dailyCommand) {
    const hour = +dailyCommand[1], minute = +dailyCommand[2];
    if (hour > 23 || minute > 59) return send('Use /daily 08:30 followed by the task.');
    const settings = proactiveSettings(db, userId);
    const id = crypto.randomBytes(4).toString('hex').toUpperCase();
    const label = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    db.prepare('INSERT INTO recurring_tasks(id,user_id,chat_id,instruction,interval_ms,next_run_at,created_at,daily_time) VALUES(?,?,?,?,?,?,?,?)').run(id, userId, chatId, `Daily ${label} — ${dailyCommand[3].trim().slice(0, 400)}`, 86_400_000, nextDailyAt(hour, minute, settings.timezone), Date.now(), label);
    return send(`Every day at ${label}, I will run: ${dailyCommand[3].trim().slice(0, 120)}\nID ${id}. /cancel ${id} stops it.`);
  }
  if (/^\/scheduled(?:@\w+)?$/i.test(text)) {
    const settings = proactiveSettings(db, userId);
    const rows = db.prepare("SELECT id,instruction,run_at FROM scheduled_tasks WHERE user_id=? AND status='pending' ORDER BY run_at LIMIT 20").all(userId);
    const recurring = db.prepare('SELECT id,instruction,next_run_at FROM recurring_tasks WHERE user_id=? ORDER BY next_run_at LIMIT 20').all(userId);
    if (!rows.length && !recurring.length) return send('Nothing scheduled yet. Use /at 09:00 …, /daily 08:30 …, or /every 2h …');
    return send([...rows.map(row => `${row.id} · ${formatWhen(row.run_at, settings.timezone)} · ${row.instruction}`), ...recurring.map(row => `${row.id} · ${formatWhen(row.next_run_at, settings.timezone)} · ${row.instruction}`)].join('\n'));
  }
  const cancelCommand = /^\/cancel(?:@\w+)?\s+([A-Fa-f0-9]{8})$/i.exec(text);
  if (cancelCommand) {
    const id = cancelCommand[1].toUpperCase();
    const removed = db.prepare('DELETE FROM scheduled_tasks WHERE id=? AND user_id=?').run(id, userId).changes + db.prepare('DELETE FROM recurring_tasks WHERE id=? AND user_id=?').run(id, userId).changes;
    return send(removed ? 'Canceled that one.' : 'I could not find that job.');
  }
  const provision = db.prepare('SELECT status,error FROM computer_provisioning WHERE computer_id=?').get(computer.id);
  const online = computer.last_seen && Date.now() - computer.last_seen < 45_000;
  if (/^\/status(?:@\w+)?$/i.test(text)) return send(online ? 'Your cloud computer is online.' : provision?.status === 'failed' ? `Computer setup failed: ${provision.error || 'unknown error'}` : `Your cloud computer is ${provision?.status || 'starting'}. I will be ready when it comes online.`);
  if (/^\/(?:models|model)(?:@\w+)?(?:\s|$)/i.test(text)) return send('You can choose Automatic, Free models, or OpenAI in your dashboard’s Models tab. I keep the specific model private.');
  const modeCommand=/^\/mode(?:@\w+)?(?:\s+(automatic|auto|free|openai))?$/i.exec(text);
  if(modeCommand){
    const current=db.prepare('SELECT mode FROM model_preferences WHERE user_id=?').get(userId)?.mode||'automatic';
    if(!modeCommand[1])return send(`I’m using ${current === 'free' ? 'free models' : current === 'openai' ? 'OpenAI' : 'automatic selection'} right now. Send /mode free, /mode openai, or /mode auto to change it.`);
    const mode=modeCommand[1].toLowerCase()==='auto'?'automatic':modeCommand[1].toLowerCase();
    if(mode==='openai'&&!db.prepare('SELECT 1 FROM openai_connections WHERE user_id=?').get(userId))return send('Connect your OpenAI account in the dashboard’s Models tab first.');
    db.prepare('INSERT INTO model_preferences(user_id,mode) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET mode=excluded.mode').run(userId,mode);
    return send(mode==='free'?'Okay, I’ll use free models. They still have usage limits.':mode==='openai'?'Okay, I’ll use your connected OpenAI account and my assigned computer when a task needs it.':'Okay, I’ll choose automatically based on the task.');
  }
  if (/^\/mode(?:@\w+)?(?:\s|$)/i.test(text)) return send('Use /mode free, /mode openai, or /mode auto.');
  const profileReply = answerOnboarding(db, userId, text);
  if (profileReply) { try { syncUserFiles(db, dependencies.dataDir, userId); } catch (error) { console.error('Profile file sync failed:', error.message); } return send(profileReply); }
  if (/^\/skip(?:@\w+)?$/i.test(text)) return send('There’s nothing to skip right now. Send /setup if you want to revisit your introduction.');
  if (!online) return send('Your cloud computer is still starting. Send /status to check again.');
  if (db.prepare("SELECT count(*) AS n FROM jobs WHERE user_id=? AND status='queued'").get(userId).n >= 10) return send('I have ten messages lined up. Send /kill to clear them, or give me a moment to catch up.');
  const previous = db.prepare('SELECT session_id FROM telegram_sessions WHERE user_id=?').get(userId);
  const jobId = enqueue(db, userId, computer.id, 'message', { text, sessionId: previous?.session_id || undefined });
  db.prepare('INSERT INTO telegram_requests(job_id,user_id,chat_id,created_at) VALUES(?,?,?,?)').run(jobId,userId,chatId,Date.now());
  if (dependencies.typing) await dependencies.typing(chatId).catch(() => {});
  if (/\bcompare\b/i.test(text)) return send('I’ll compare the options and bring back the useful differences.');
  if (/\b(book|buy|reserve|purchase)\b/i.test(text)) return send('I’ll check the options first and ask before confirming anything.');
  if (/\b(search|look up|browse|visit|check (?:the )?(?:site|page|website))\b/i.test(text)) return send('I’ll check that and send back what I find.');
  if (/\b(download|upload|open)\b/i.test(text)) return send('I’ll take care of that and let you know how it goes.');
  return;
}

export async function startTelegramBot({ db, hash, random, now, dataDir }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const base = `https://api.telegram.org/bot${token}`;
  async function call(method, payload) {
    const response = await fetch(`${base}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(35_000) });
    const data = await response.json();
    if (!data.ok) throw new Error(`Telegram ${method} failed (${data.error_code || response.status})`);
    return data.result;
  }
  async function sendChunks(chatId,value){
    const chunks=formatChunks(String(value));
    if(!chunks.length)return call('sendMessage',{chat_id:chatId,text:' '});
    for(const chunk of chunks){
      try{await call('sendMessage',{chat_id:chatId,text:chunk.html,parse_mode:'HTML',link_preview_options:{is_disabled:true}})}
      catch(error){
        if(!/parse|entity|message is too long/i.test(error.message))throw error;
        await call('sendMessage',{chat_id:chatId,text:chunk.plain,link_preview_options:{is_disabled:true}});
      }
    }
  }
  const me = await call('getMe', {});
  upsertState(db, 'telegram_bot_username', me.username);
  const webhook = await call('getWebhookInfo', {});
  if (webhook.url) throw new Error('A Telegram webhook is active; polling cannot start until it is removed.');
  setInterval(async()=>{
    const pending=db.prepare("SELECT a.id,a.summary,a.details,a.expires_at,t.chat_id FROM task_approvals a JOIN telegram_accounts t ON t.user_id=a.user_id WHERE a.status='pending' AND a.created_at>0 AND a.id NOT IN (SELECT value FROM app_state WHERE key LIKE 'approval_sent:%') ORDER BY a.created_at LIMIT 10").all();
    for(const item of pending){
      if(item.expires_at<=Date.now())continue;
      try{const details=JSON.parse(item.details||'{}');const context=details.context?`\nPage details:\n${String(details.context).slice(0,700)}`:'';await call('sendMessage',{chat_id:item.chat_id,text:`Approve this action?\n${item.summary}${context}\n\nCheck the total and recipient before approving. If they are missing or wrong, reject it. Expires in 15 minutes.`,reply_markup:{inline_keyboard:[[{text:'Approve',callback_data:`a:${item.id}`},{text:'Reject',callback_data:`r:${item.id}`}]]}});upsertState(db,`approval_sent:${item.id}`,item.id)}catch(error){console.error('Approval delivery retry:',error.message)}
    }
  },2000);
  setInterval(async()=>{
    const events=db.prepare("SELECT e.id,e.user_id,e.summary,t.chat_id FROM proactive_events e JOIN telegram_accounts t ON t.user_id=e.user_id WHERE e.status='pending' ORDER BY e.created_at LIMIT 10").all();
    for(const event of events){try{const settings=proactiveSettings(db,event.user_id);if(!settings.enabled)continue;const hour=Number(new Intl.DateTimeFormat('en-GB',{hour:'2-digit',hourCycle:'h23',timeZone:settings.timezone}).format(Date.now()));if(quietNow(hour,settings.quiet_start,settings.quiet_end))continue;await call('sendMessage',{chat_id:event.chat_id,text:event.summary,reply_markup:{inline_keyboard:[[{text:'Got it',callback_data:`e:${event.id}`}]]}});db.prepare("UPDATE proactive_events SET status='delivered',delivered_at=? WHERE id=? AND status='pending'").run(Date.now(),event.id)}catch(error){console.error('Proactive delivery retry:',error.message)}}
  },5000);
  let sendingReminders = false;
  setInterval(async () => {
    if (sendingReminders) return;
    sendingReminders = true;
    try {
      const due = db.prepare('SELECT id,chat_id,text FROM reminders WHERE sent_at IS NULL AND due_at<=? ORDER BY due_at LIMIT 20').all(Date.now());
      for (const reminder of due) {
        await call('sendMessage', { chat_id: reminder.chat_id, text: `Reminder: ${reminder.text}` });
        db.prepare('UPDATE reminders SET sent_at=? WHERE id=? AND sent_at IS NULL').run(Date.now(), reminder.id);
      }
    } catch (error) { console.error('Reminder delivery retry:', error.message); }
    finally { sendingReminders = false; }
  }, 10_000);
  let scheduling = false;
  setInterval(() => {
    if (scheduling) return;
    scheduling = true;
    try {
      const due=db.prepare('SELECT * FROM recurring_tasks WHERE next_run_at<=? ORDER BY next_run_at LIMIT 20').all(Date.now());
      for(const task of due){
        const computer=db.prepare('SELECT * FROM computers WHERE user_id=? ORDER BY created_at LIMIT 1').get(task.user_id);
        if(!computer?.last_seen||Date.now()-computer.last_seen>45_000) continue;
        if(db.prepare('SELECT 1 FROM telegram_requests WHERE user_id=? AND delivered_at IS NULL LIMIT 1').get(task.user_id)) continue;
        db.exec('BEGIN IMMEDIATE');
        try {
          const jobId=enqueue(db,task.user_id,computer.id,'message',{text:`Scheduled task: ${task.instruction}`});
          db.prepare('INSERT INTO telegram_requests(job_id,user_id,chat_id,created_at) VALUES(?,?,?,?)').run(jobId,task.user_id,task.chat_id,Date.now());
          const nextRun = task.daily_time ? nextDailyAt(+String(task.daily_time).split(':')[0], +String(task.daily_time).split(':')[1], proactiveSettings(db,task.user_id).timezone) : Date.now()+task.interval_ms;
          db.prepare('UPDATE recurring_tasks SET next_run_at=? WHERE id=?').run(nextRun,task.id);
          db.exec('COMMIT');
        } catch(error){db.exec('ROLLBACK');throw error;}
      }
    } catch(error){console.error('Recurring task retry:',error.message)}
    finally{scheduling=false}
  }, 15_000);
  setInterval(() => {
    try{
      const due=db.prepare('SELECT * FROM web_watches WHERE next_run_at<=? ORDER BY next_run_at LIMIT 20').all(Date.now());
      for(const target of due){
        const computer=db.prepare('SELECT * FROM computers WHERE user_id=? ORDER BY created_at LIMIT 1').get(target.user_id);
        if(!computer?.last_seen||Date.now()-computer.last_seen>45_000)continue;
        if(db.prepare('SELECT 1 FROM telegram_requests WHERE user_id=? AND delivered_at IS NULL LIMIT 1').get(target.user_id))continue;
        db.exec('BEGIN IMMEDIATE');
        try{
          const jobId=enqueue(db,target.user_id,computer.id,'watch',{watchId:target.id,url:target.url,selector:target.selector||''});
          db.prepare('INSERT INTO telegram_requests(job_id,user_id,chat_id,created_at) VALUES(?,?,?,?)').run(jobId,target.user_id,target.chat_id,Date.now());
          db.prepare('UPDATE web_watches SET next_run_at=? WHERE id=?').run(Date.now()+target.interval_ms,target.id);
          db.exec('COMMIT');
        }catch(error){db.exec('ROLLBACK');throw error}
      }
    }catch(error){console.error('Page watch retry:',error.message)}
  },30_000);
  setInterval(() => {
    try {
      const due = db.prepare("SELECT * FROM scheduled_tasks WHERE status='pending' AND run_at<=? ORDER BY run_at LIMIT 20").all(Date.now());
      for (const task of due) {
        const computer = db.prepare('SELECT * FROM computers WHERE user_id=? ORDER BY created_at LIMIT 1').get(task.user_id);
        if (!computer) continue;
        const jobId = enqueue(db, task.user_id, computer.id, 'message', { text: task.instruction });
        db.prepare('INSERT INTO telegram_requests(job_id,user_id,chat_id,created_at) VALUES(?,?,?,?)').run(jobId, task.user_id, task.chat_id, Date.now());
        db.prepare("UPDATE scheduled_tasks SET status='done' WHERE id=?").run(task.id);
      }
    } catch (error) { console.error('Scheduled task retry:', error.message); }
  }, 20_000);
  setInterval(() => runProactiveTick(db, sendChunks).catch(error => console.error('Proactive retry:', error.message)), 60_000);
  let deliveringResults = false;
  setInterval(async () => {
    if (deliveringResults) return;
    deliveringResults = true;
    try { await deliverTelegramResults(db, sendChunks); }
    catch(error) { console.error('Telegram result delivery retry:', error.message); }
    finally { deliveringResults = false; }
  }, 2_000);
  let offset = Number(db.prepare("SELECT value FROM app_state WHERE key='telegram_offset'").get()?.value || 0);
  const active = new Map();
  for (;;) {
    try {
      const updates = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message','callback_query'] });
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        upsertState(db, 'telegram_offset', offset);
        if(update.callback_query){const query=update.callback_query;const match=/^([are]):([a-f0-9-]{36})$/.exec(String(query.data||''));if(match){const account=db.prepare('SELECT user_id FROM telegram_accounts WHERE telegram_id=? AND chat_id=?').get(String(query.from?.id||''),String(query.message?.chat?.id||''));try{if(!account)throw Error('This action is not yours');let status,changed;if(match[1]==='e'){changed=!!db.prepare("UPDATE proactive_events SET status='acknowledged',responded_at=? WHERE id=? AND user_id=? AND status='delivered'").run(Date.now(),match[2],account.user_id).changes;status='Noted'}else{const decision=decideApproval(db,account.user_id,match[2],match[1]==='a'?'approved':'rejected');status=decision.status;changed=decision.changed}await call('answerCallbackQuery',{callback_query_id:query.id,text:status});if(changed)await call('editMessageReplyMarkup',{chat_id:query.message.chat.id,message_id:query.message.message_id,reply_markup:{inline_keyboard:[]}})}catch(error){await call('answerCallbackQuery',{callback_query_id:query.id,text:error.message.slice(0,150),show_alert:true}).catch(()=>{})}}continue}
        const message = update.message;
        if (!message) continue;
        const key = String(message.chat.id);
        const previous = active.get(key) || Promise.resolve();
        const work = previous.catch(() => {}).then(() => handleTelegramMessage(db, message, {
          hash, random, now, dataDir,
          publicUrl: process.env.PUBLIC_URL,
          downloadDocument: async fileId => {
            const metadata=await call('getFile',{file_id:fileId});
            if(metadata.file_size>10*1024*1024||!metadata.file_path)throw Error('File unavailable');
            const safePath=metadata.file_path.split('/').map(encodeURIComponent).join('/');
            const response=await fetch(`https://api.telegram.org/file/bot${token}/${safePath}`,{signal:AbortSignal.timeout(30_000)});
            if(!response.ok)throw Error('File download failed');
            const bytes=Buffer.from(await response.arrayBuffer());
            if(bytes.length>10*1024*1024)throw Error('File exceeds limit');
            return bytes;
          },
          send: sendChunks,
          typing: id => call('sendChatAction', { chat_id: id, action: 'typing' }),
        })).catch(error => console.error('Telegram message failed:', error.message));
        const tracked = work.finally(() => { if (active.get(key) === tracked) active.delete(key); });
        active.set(key, tracked);
      }
    } catch (error) {
      console.error('Telegram polling retry:', error.message);
      await sleep(5000);
    }
  }
}
