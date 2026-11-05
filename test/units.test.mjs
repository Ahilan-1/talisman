import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureMemorySchema, extractFromMessage, rememberFromMessage, searchMemories, selectMemoryContext, upsertMemory } from '../memory.mjs';
import { localDateKey, nextDailyAt, parseWhenPrefix, validTimeZone, zonedParts } from '../schedule.mjs';
import { selectResponseOutput } from '../openai-connection.mjs';

const fresh = () => { const db = new DatabaseSync(':memory:'); ensureMemorySchema(db); return db; };

test('streamed browser actions survive an empty final output array', () => {
  const action = { type: 'function_call', name: 'search', call_id: 'call_1', arguments: '{"query":"bus timetable"}' };
  const items = new Map([[1, action], [0, { type: 'reasoning', id: 'reason_1' }]]);
  assert.deepEqual(selectResponseOutput({ output: [] }, items), [{ type: 'reasoning', id: 'reason_1' }, action]);
  assert.deepEqual(selectResponseOutput({ output: [action] }, items), [action]);
});

test('memory keeps at least 90% of saved facts reachable in context', () => {
  const db = fresh();
  for (let index = 0; index < 80; index += 1) {
    upsertMemory(db, 'user-1', { key: `fact ${index}`, value: `detail ${index} about their week`, importance: (index % 5) + 1 }, Date.now() - index * 60_000);
  }
  const context = selectMemoryContext(db, 'user-1', 'detail 42', { budget: 1200 });
  assert.ok(context.retention >= 0.9, `retention was ${context.retention}`);
  assert.equal(context.entries.length + context.index.length, 80);
  assert.equal(context.total, 80);
  assert.ok(context.index.length > 0, 'over-budget facts must still be listed by key');
});

test('memory deduplicates by value and extracts facts the user should not repeat', () => {
  const db = fresh();
  const first = upsertMemory(db, 'user-1', { key: 'mode', value: 'dark mode' }, 1);
  const second = upsertMemory(db, 'user-1', { key: 'theme', value: 'Dark mode' }, 2);
  assert.equal(first, second);
  assert.equal(db.prepare('SELECT count(*) AS n FROM memories WHERE user_id=?').get('user-1').n, 1);

  const facts = extractFromMessage('My name is Avi. I prefer short answers. I live in Chennai.');
  const keys = facts.map(fact => fact.key);
  assert.ok(keys.includes('name'), `missing name in ${keys.join(', ')}`);
  assert.ok(keys.includes('location'), `missing location in ${keys.join(', ')}`);
  assert.ok(keys.some(key => key.startsWith('preference:')), `missing preference in ${keys.join(', ')}`);

  rememberFromMessage(db, 'user-1', 'My name is Avi');
  assert.match(searchMemories(db, 'user-1', 'avi')[0].value, /Avi/);
  assert.equal(extractFromMessage('/remember name: Avi').length, 0);
});

test('schedule parses clocks, dates, relative times and weekdays', () => {
  const zone = 'Asia/Kolkata';
  const from = Date.UTC(2026, 10, 3, 1, 0); // 06:30 on Tuesday 3 November 2026 in IST

  const clock = parseWhenPrefix('09:30 call mom', zone, from);
  assert.equal(clock.rest, 'call mom');
  assert.deepEqual({ hour: zonedParts(clock.at, zone).hour, minute: zonedParts(clock.at, zone).minute }, { hour: 9, minute: 30 });

  const tomorrow = parseWhenPrefix('tomorrow 18:00 dinner', zone, from);
  assert.equal(tomorrow.rest, 'dinner');
  assert.equal(localDateKey(tomorrow.at, zone), '2026-11-04');

  const iso = parseWhenPrefix('2026-12-01 18:00 dinner', 'Europe/London', from);
  assert.equal(zonedParts(iso.at, 'Europe/London').hour, 18);
  assert.equal(zonedParts(iso.at, 'Europe/London').day, 1);

  const relative = parseWhenPrefix('in 2h tea', zone, from);
  assert.equal(relative.at - from, 2 * 3_600_000);
  assert.equal(relative.rest, 'tea');

  const weekday = parseWhenPrefix('mon 10:00 standup', zone, from);
  assert.equal(weekday.rest, 'standup');
  const weekdayParts = zonedParts(weekday.at, zone);
  assert.equal(new Date(Date.UTC(weekdayParts.year, weekdayParts.month - 1, weekdayParts.day)).getUTCDay(), 1);

  assert.equal(validTimeZone('Mars/Base'), false);
  assert.equal(validTimeZone('Asia/Kolkata'), true);
  assert.equal(parseWhenPrefix('sometime later', zone, from), null);

  const next = nextDailyAt(8, 15, zone, from);
  assert.ok(next > from && next - from < 86_400_000 + 3_600_000);
  assert.deepEqual({ hour: zonedParts(next, zone).hour, minute: zonedParts(next, zone).minute }, { hour: 8, minute: 15 });
});
