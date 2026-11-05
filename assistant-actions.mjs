import crypto from 'node:crypto';
import { publicWebUrl } from './arlong.mjs';
import { formatWhen } from './schedule.mjs';
import { proactiveSettings } from './proactive.mjs';
import { createCalendarEvent, calendarEvents } from './orchestration.mjs';

const DAY = 86_400_000;
const id = () => crypto.randomBytes(4).toString('hex').toUpperCase();
const clean = (value, max = 500) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

function futureTime(value, now) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(String(value || ''))) throw Error('Use an ISO date and time with a timezone offset');
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at < now + 60_000 || at > now + 365 * DAY) throw Error('Choose a time from one minute to one year in the future');
  return at;
}

export function runAssistantAction(db, userId, action, args = {}, now = Date.now()) {
  const account = db.prepare('SELECT chat_id FROM telegram_accounts WHERE user_id=?').get(userId);
  if (!account) throw Error('Link Telegram before scheduling anything');
  const zone = proactiveSettings(db, userId).timezone;
  if (action === 'create_reminder') {
    const text = clean(args.text);
    if (!text) throw Error('A reminder needs a message');
    if (db.prepare('SELECT count(*) AS n FROM reminders WHERE user_id=? AND sent_at IS NULL').get(userId).n >= 50) throw Error('Reminder limit reached');
    const at = futureTime(args.at, now), key = id();
    db.prepare('INSERT INTO reminders(id,user_id,chat_id,text,due_at) VALUES(?,?,?,?,?)').run(key, userId, account.chat_id, text, at);
    return { id: key, kind: 'reminder', text, at: formatWhen(at, zone) };
  }
  if (action === 'create_calendar_event') {
    return createCalendarEvent(db,userId,{title:args.title,description:args.description,start:args.start,end:args.end,source:'agent'});
  }
  if (action === 'list_calendar_events') {
    const from=Date.parse(args.from),to=Date.parse(args.to);
    if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from||to-from>93*DAY)throw Error('Choose a calendar range of up to 93 days');
    return {events:calendarEvents(db,userId,from,to)};
  }
  if (action === 'create_followup') {
    const instruction = clean(args.instruction);
    if (!instruction) throw Error('A follow-up needs an instruction');
    if (db.prepare("SELECT count(*) AS n FROM scheduled_tasks WHERE user_id=? AND status='pending'").get(userId).n >= 20) throw Error('Follow-up limit reached');
    const at = futureTime(args.at, now), key = id();
    db.prepare('INSERT INTO scheduled_tasks(id,user_id,chat_id,instruction,run_at,status,created_at) VALUES(?,?,?,?,?,?,?)').run(key, userId, account.chat_id, instruction, at, 'pending', now);
    return { id: key, kind: 'followup', instruction, at: formatWhen(at, zone) };
  }
  if (action === 'create_watch') {
    const url = publicWebUrl(args.url);
    const interval = Number(args.intervalMinutes);
    if (!Number.isInteger(interval) || interval < 5 || interval > 24 * 60) throw Error('Watch interval must be 5–1440 minutes');
    if (db.prepare('SELECT count(*) AS n FROM web_watches WHERE user_id=?').get(userId).n >= 20) throw Error('Watch limit reached');
    const selector = clean(args.selector, 200), key = id();
    db.prepare('INSERT INTO web_watches(id,user_id,chat_id,url,selector,interval_ms,next_run_at,created_at) VALUES(?,?,?,?,?,?,?,?)').run(key, userId, account.chat_id, url, selector, interval * 60_000, now + interval * 60_000, now);
    return { id: key, kind: 'watch', url, selector, intervalMinutes: interval, note: 'The first successful check sets the baseline; later changes trigger an alert.' };
  }
  if (action === 'list_commitments') {
    return {
      reminders: db.prepare('SELECT id,text,due_at FROM reminders WHERE user_id=? AND sent_at IS NULL ORDER BY due_at LIMIT 20').all(userId).map(row => ({ id: row.id, text: row.text, at: formatWhen(row.due_at, zone) })),
      followups: db.prepare("SELECT id,instruction,run_at FROM scheduled_tasks WHERE user_id=? AND status='pending' ORDER BY run_at LIMIT 20").all(userId).map(row => ({ id: row.id, instruction: row.instruction, at: formatWhen(row.run_at, zone) })),
      watches: db.prepare('SELECT id,url,interval_ms FROM web_watches WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(userId).map(row => ({ id: row.id, url: row.url, intervalMinutes: row.interval_ms / 60_000 })),
    };
  }
  if (action === 'cancel_commitment') {
    const key = String(args.id || '').trim().toUpperCase();
    if (!/^[A-F0-9]{8}$/.test(key)) throw Error('Use the eight-character commitment ID');
    const removed = db.prepare('DELETE FROM reminders WHERE id=? AND user_id=? AND sent_at IS NULL').run(key, userId).changes +
      db.prepare("DELETE FROM scheduled_tasks WHERE id=? AND user_id=? AND status='pending'").run(key, userId).changes +
      db.prepare('DELETE FROM web_watches WHERE id=? AND user_id=?').run(key, userId).changes;
    return { id: key, canceled: removed > 0 };
  }
  throw Error('Unknown assistant action');
}
