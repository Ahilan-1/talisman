import crypto from 'node:crypto';

// Memory v2: typed facts, ranked context selection, and automatic extraction.
// The product promise is "never ask the user to repeat themselves", so every saved
// fact stays readable: when the character budget runs out, the remaining keys are
// still listed so the agent can ask for the value instead of forgetting it exists.

export function ensureMemorySchema(db) {
  db.exec("CREATE TABLE IF NOT EXISTS memories(user_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,key));");
  const columns = new Set(db.prepare('PRAGMA table_info(memories)').all().map(column => column.name));
  const additions = [
    ['kind', "TEXT NOT NULL DEFAULT 'fact'"],
    ['importance', 'INTEGER NOT NULL DEFAULT 3'],
    ['hits', 'INTEGER NOT NULL DEFAULT 0'],
    ['source', "TEXT NOT NULL DEFAULT 'explicit'"],
    ['last_used_at', 'INTEGER'],
  ];
  for (const [name, sql] of additions) if (!columns.has(name)) db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${sql}`);
  db.exec('CREATE INDEX IF NOT EXISTS memories_ranked ON memories(user_id,importance DESC,updated_at DESC);');
}

const slug = (value, length = 80) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9\s:._-]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, length);

export function upsertMemory(db, userId, entry, timestamp = Date.now()) {
  const value = String(entry?.value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!value) return null;
  const existing = db.prepare('SELECT key FROM memories WHERE user_id=? AND lower(value)=lower(?) ORDER BY updated_at DESC LIMIT 1').get(userId, value);
  const key = existing?.key || slug(entry?.key || value.slice(0, 60)) || `note ${crypto.createHash('sha256').update(value.toLowerCase()).digest('hex').slice(0, 8)}`;
  const kind = ['fact', 'preference', 'entity', 'task', 'goal'].includes(entry?.kind) ? entry.kind : 'fact';
  const importance = Math.max(1, Math.min(5, Number(entry?.importance) || 3));
  const source = entry?.source === 'auto' ? 'auto' : 'explicit';
  db.prepare(`INSERT INTO memories(user_id,key,value,updated_at,kind,importance,source) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,kind=excluded.kind,importance=MAX(memories.importance,excluded.importance)`).run(userId, key, value, timestamp, kind, importance, source);
  return key;
}

// Conservative rules: only facts the user would be annoyed to repeat.
const RULES = [
  { re: /\b(?:[Mm]y name is|[Cc]all me|[Yy]ou can call me)\s+([A-Z][\w'’-]{1,29})/, key: () => 'name', value: match => match[1], kind: 'fact', importance: 5 },
  { re: /\b(?:my\s+)?time\s?zone\s+(?:is|:)\s*([A-Za-z]+\/[A-Za-z_]+)/i, key: () => 'timezone', value: match => match[1], kind: 'fact', importance: 5 },
  { re: /\bi\s+(?:live|stay|am based|work)\s+in\s+([A-Za-z][^.!?\n]{1,60})/i, key: () => 'location', value: match => match[1].trim(), kind: 'fact', importance: 4 },
  { re: /\bi\s+(?:prefer|like|love|enjoy|hate|dislike|avoid|can't stand)\s+([^.!?\n]{2,160})/i, key: match => `preference: ${slug(match[1], 40)}`, value: match => match[1].trim(), kind: 'preference', importance: 4 },
  { re: /\bmy\s+(email|phone|number|address|birthday|anniversary|order id|seat|flight)\s+(?:is|:)\s*([^\s,.;]{2,120})/i, key: match => match[1].toLowerCase(), value: match => match[2].trim(), kind: 'fact', importance: 4 },
  { re: /\bmy\s+([a-z][a-z\s]{1,30})\s+(?:is|are)\s+([^.!?\n]{1,140})/i, key: match => slug(match[1], 60), value: match => match[2].trim(), kind: 'fact', importance: 3 },
  { re: /\b(?:remember|note|keep in mind|don't forget)\b(?: that|:)?\s+([^.!?\n]{3,280})/i, key: match => `note ${slug(match[1], 30)}`, value: match => match[1].trim(), kind: 'task', importance: 4 },
];

export function extractFromMessage(text) {
  const source = String(text || '').trim();
  if (!source || source.startsWith('/')) return [];
  const found = [];
  for (const rule of RULES) {
    const match = rule.re.exec(source);
    if (!match) continue;
    const entry = { key: rule.key(match), value: rule.value(match), kind: rule.kind, importance: rule.importance };
    if (!entry.key || !entry.value || entry.value.length < 2) continue;
    if (found.some(item => item.key === entry.key)) continue;
    found.push(entry);
    if (found.length >= 4) break;
  }
  return found;
}

export function rememberFromMessage(db, userId, text, timestamp = Date.now()) {
  return extractFromMessage(text)
    .map(entry => upsertMemory(db, userId, { ...entry, source: 'auto' }, timestamp))
    .filter(Boolean);
}

export function selectMemoryContext(db, userId, query = '', { budget = 4200, markUsed = true } = {}) {
  const rows = db.prepare('SELECT key,value,kind,importance,hits,updated_at,source FROM memories WHERE user_id=?').all(userId);
  if (!rows.length) return { entries: [], index: [], retention: 1, total: 0 };
  const timestamp = Date.now();
  const tokens = new Set(String(query).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  const ranked = rows.map(row => {
    let score = row.importance * 12;
    if (row.source === 'explicit') score += 6;
    score += Math.max(0, 30 - (timestamp - row.updated_at) / 86_400_000) * 0.8;
    score += Math.min(12, (row.hits || 0) * 2);
    const haystack = `${row.key} ${row.value}`.toLowerCase();
    for (const token of tokens) if (haystack.includes(token)) score += 14;
    return { ...row, score };
  }).sort((a, b) => b.score - a.score);
  const entries = [];
  const index = [];
  let used = 0;
  for (const row of ranked) {
    const cost = row.key.length + row.value.length + 4;
    if (used + cost <= budget) {
      entries.push({ key: row.key, value: row.value, kind: row.kind });
      used += cost;
    } else {
      index.push(row.key);
    }
  }
  if (markUsed && entries.length) {
    const touch = db.prepare('UPDATE memories SET hits=hits+1,last_used_at=? WHERE user_id=? AND key=?');
    for (const entry of entries) touch.run(timestamp, userId, entry.key);
  }
  return { entries, index, retention: (entries.length + index.length) / rows.length, total: rows.length };
}

export function searchMemories(db, userId, query, limit = 10) {
  const needle = `%${String(query || '').toLowerCase().slice(0, 80)}%`;
  return db.prepare('SELECT key,value,kind FROM memories WHERE user_id=? AND (lower(key) LIKE ? OR lower(value) LIKE ?) ORDER BY importance DESC,updated_at DESC LIMIT ?').all(userId, needle, needle, limit);
}
