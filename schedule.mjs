// Timezone-aware scheduling helpers. Everything is computed from the user's own
// clock so "tomorrow 9am" means the same thing to them and to the scheduler.

const DAY = 86_400_000;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function validTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== 'string' || timeZone.length > 60) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone }); return true; } catch { return false; }
}

export function zonedParts(timestamp, timeZone) {
  const zone = validTimeZone(timeZone) ? timeZone : 'UTC';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute, second: +parts.second };
}

export function wallToEpoch({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let timestamp = target;
  for (let index = 0; index < 3; index += 1) {
    const parts = zonedParts(timestamp, timeZone);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    timestamp = target - (asUtc - timestamp);
  }
  return timestamp;
}

export const localHour = (timestamp, timeZone) => zonedParts(timestamp, timeZone).hour;

export function localDateKey(timestamp, timeZone) {
  const parts = zonedParts(timestamp, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function nextDailyAt(hour, minute, timeZone, from = Date.now()) {
  for (let offset = 0; offset <= 2; offset += 1) {
    const parts = zonedParts(from + offset * DAY, timeZone);
    const candidate = wallToEpoch({ year: parts.year, month: parts.month, day: parts.day, hour, minute }, timeZone);
    if (candidate > from + 30_000) return candidate;
  }
  return from + DAY;
}

export function formatWhen(timestamp, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: validTimeZone(timeZone) ? timeZone : 'UTC',
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(new Date(timestamp));
}

const clock = value => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const hour = +match[1], minute = +match[2];
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
};

export function parseWhenPrefix(input, timeZone = 'UTC', from = Date.now()) {
  const text = String(input || '').trim();
  const zone = validTimeZone(timeZone) ? timeZone : 'UTC';
  let match;

  if ((match = /^in\s+(\d{1,3})\s*([mhd])\b\s*/i.exec(text))) {
    const amount = +match[1];
    const unit = { m: 60_000, h: 3_600_000, d: DAY }[match[2].toLowerCase()];
    return { at: from + amount * unit, rest: text.slice(match[0].length).trim() };
  }

  if ((match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?\s*/i.exec(text))) {
    const at = wallToEpoch({ year: +match[1], month: +match[2], day: +match[3], hour: match[4] ? +match[4] : 9, minute: match[5] ? +match[5] : 0 }, zone);
    return { at, rest: text.slice(match[0].length).trim() };
  }

  if ((match = /^(today|tomorrow)(?:\s+(?:at\s+)?(\d{1,2}:\d{2}))?\s*/i.exec(text))) {
    const time = clock(match[2]) || { hour: 9, minute: 0 };
    const parts = zonedParts(from, zone);
    let at = wallToEpoch({ ...parts, day: parts.day + (match[1].toLowerCase() === 'tomorrow' ? 1 : 0), hour: time.hour, minute: time.minute }, zone);
    if (at <= from) at += DAY;
    return { at, rest: text.slice(match[0].length).trim() };
  }

  if ((match = /^(mon|tue|wed|thu|fri|sat|sun)(?:day)?(?:\s+(?:at\s+)?(\d{1,2}:\d{2}))?\s*/i.exec(text))) {
    const target = WEEKDAYS.indexOf(match[1].toLowerCase().slice(0, 3));
    const time = clock(match[2]) || { hour: 9, minute: 0 };
    const parts = zonedParts(from, zone);
    for (let offset = 0; offset <= 7; offset += 1) {
      const candidate = wallToEpoch({ year: parts.year, month: parts.month, day: parts.day + offset, hour: time.hour, minute: time.minute }, zone);
      const weekday = new Date(Date.UTC(zonedParts(candidate, zone).year, zonedParts(candidate, zone).month - 1, zonedParts(candidate, zone).day)).getUTCDay();
      if (weekday === target && candidate > from) return { at: candidate, rest: text.slice(match[0].length).trim() };
    }
  }

  if ((match = /^(?:at\s+)?(\d{1,2}:\d{2})\s*/i.exec(text))) {
    const time = clock(match[1]);
    if (time) {
      const parts = zonedParts(from, zone);
      let at = wallToEpoch({ ...parts, hour: time.hour, minute: time.minute }, zone);
      if (at <= from) at += DAY;
      return { at, rest: text.slice(match[0].length).trim() };
    }
  }

  return null;
}

export function ensureRecurringSchedule(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(recurring_tasks)').all().map(column => column.name));
  if (!columns.has('daily_time')) db.exec('ALTER TABLE recurring_tasks ADD COLUMN daily_time TEXT');
}
