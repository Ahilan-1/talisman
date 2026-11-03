import crypto from 'node:crypto';
import { localDateKey, localHour, formatWhen, validTimeZone } from './schedule.mjs';

// Proactive layer: Talisman starts conversations instead of only answering them.
// Everything here is deterministic and cheap — no model call is spent to say
// "your bill is due tomorrow" or to pick up a question the user left hanging.

const HOUR = 3_600_000;
const DAY = 86_400_000;

export function ensureProactiveSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS proactive_settings(user_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 1,timezone TEXT NOT NULL DEFAULT 'UTC',quiet_start INTEGER NOT NULL DEFAULT 22,quiet_end INTEGER NOT NULL DEFAULT 8,brief_hour INTEGER NOT NULL DEFAULT 9,brief_minute INTEGER NOT NULL DEFAULT 0,last_brief_at INTEGER,last_nudge_at INTEGER);
    CREATE TABLE IF NOT EXISTS proactive_log(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduled_tasks(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,chat_id TEXT NOT NULL,instruction TEXT NOT NULL,run_at INTEGER NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS scheduled_due ON scheduled_tasks(status,run_at);
    CREATE INDEX IF NOT EXISTS proactive_by_user ON proactive_log(user_id,created_at);`);
}

export function proactiveSettings(db, userId) {
  let row = db.prepare('SELECT * FROM proactive_settings WHERE user_id=?').get(userId);
  if (!row) {
    db.prepare('INSERT OR IGNORE INTO proactive_settings(user_id) VALUES(?)').run(userId);
    row = db.prepare('SELECT * FROM proactive_settings WHERE user_id=?').get(userId);
  }
  return row;
}

export function quietNow(hour, start, end) {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

const oneLine = (value, limit) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);

export function composeBrief(db, userId, settings, timestamp = Date.now()) {
  const until = timestamp + DAY;
  const zone = validTimeZone(settings.timezone) ? settings.timezone : 'UTC';
  const reminders = db.prepare('SELECT text,due_at FROM reminders WHERE user_id=? AND sent_at IS NULL AND due_at<=? ORDER BY due_at LIMIT 5').all(userId, until);
  const scheduled = db.prepare("SELECT instruction,run_at FROM scheduled_tasks WHERE user_id=? AND status='pending' AND run_at<=? ORDER BY run_at LIMIT 5").all(userId, until);
  const recurring = db.prepare('SELECT instruction,next_run_at FROM recurring_tasks WHERE user_id=? AND next_run_at<=? ORDER BY next_run_at LIMIT 5').all(userId, until);
  if (!reminders.length && !scheduled.length && !recurring.length) return null;
  const lines = ['Morning. Here is the day.'];
  if (reminders.length) lines.push('', 'Reminders', ...reminders.map(row => `• ${formatWhen(row.due_at, zone)} — ${oneLine(row.text, 120)}`));
  if (scheduled.length) lines.push('', 'Scheduled', ...scheduled.map(row => `• ${formatWhen(row.run_at, zone)} — ${oneLine(row.instruction, 120)}`));
  if (recurring.length) lines.push('', 'Recurring', ...recurring.map(row => `• ${formatWhen(row.next_run_at, zone)} — ${oneLine(row.instruction, 120)}`));
  return lines.join('\n');
}

function logProactive(db, userId, kind, text, timestamp) {
  db.prepare('INSERT INTO proactive_log(id,user_id,kind,text,created_at) VALUES(?,?,?,?,?)').run(crypto.randomUUID(), userId, kind, oneLine(text, 400), timestamp);
}

export async function runProactiveTick(db, send, timestamp = Date.now()) {
  const users = db.prepare('SELECT user_id FROM proactive_settings WHERE enabled=1 LIMIT 500').all();
  let sent = 0;
  for (const { user_id: userId } of users) {
    try {
      const settings = proactiveSettings(db, userId);
      const zone = validTimeZone(settings.timezone) ? settings.timezone : 'UTC';
      const account = db.prepare('SELECT chat_id FROM telegram_accounts WHERE user_id=?').get(userId);
      if (!account) continue;
      const computer = db.prepare('SELECT last_seen FROM computers WHERE user_id=? ORDER BY created_at LIMIT 1').get(userId);
      if (!computer?.last_seen || timestamp - computer.last_seen > 45_000) continue;
      if (db.prepare('SELECT 1 FROM telegram_requests WHERE user_id=? AND delivered_at IS NULL LIMIT 1').get(userId)) continue;
      const hour = localHour(timestamp, zone);
      if (quietNow(hour, settings.quiet_start, settings.quiet_end)) continue;
      const lastSend = db.prepare('SELECT created_at FROM proactive_log WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(userId);
      if (lastSend && timestamp - lastSend.created_at < 6 * HOUR) continue;

      const today = localDateKey(timestamp, zone);
      const briefDay = settings.last_brief_at ? localDateKey(settings.last_brief_at, zone) : null;
      if (briefDay !== today && hour >= settings.brief_hour) {
        db.prepare('UPDATE proactive_settings SET last_brief_at=? WHERE user_id=?').run(timestamp, userId);
        const brief = composeBrief(db, userId, settings, timestamp);
        if (brief) {
          await send(account.chat_id, brief);
          logProactive(db, userId, 'brief', brief, timestamp);
          sent += 1;
        }
        continue;
      }

      const last = db.prepare('SELECT role,text,created_at FROM conversation_messages WHERE user_id=? ORDER BY id DESC LIMIT 1').get(userId);
      if (last?.role === 'assistant' && /\?\s*$/.test(last.text) && timestamp - last.created_at > 3 * HOUR && (!settings.last_nudge_at || timestamp - settings.last_nudge_at > 20 * HOUR)) {
        const question = oneLine(last.text, 200).replace(/^\W+/, '');
        const nudge = `Picking this back up — ${question}`;
        await send(account.chat_id, nudge);
        db.prepare('UPDATE proactive_settings SET last_nudge_at=? WHERE user_id=?').run(timestamp, userId);
        logProactive(db, userId, 'nudge', nudge, timestamp);
        sent += 1;
        continue;
      }

      const failed = db.prepare("SELECT id,payload,updated_at FROM jobs WHERE user_id=? AND status='failed' AND updated_at>? ORDER BY updated_at DESC LIMIT 1").get(userId, timestamp - DAY);
      if (failed && !db.prepare('SELECT 1 FROM proactive_log WHERE user_id=? AND kind=? LIMIT 1').get(userId, `retry:${failed.id}`)) {
        let task = '';
        try { task = oneLine(JSON.parse(failed.payload).text, 90); } catch {}
        const retry = `That one did not finish earlier${task ? ` (${task})` : ''}. Want me to try again?`;
        await send(account.chat_id, retry);
        logProactive(db, userId, `retry:${failed.id}`, retry, timestamp);
        sent += 1;
      }
    } catch (error) {
      console.error('Proactive tick failed:', error.message);
    }
  }
  return sent;
}
