import fs from 'node:fs';

const read = name => fs.readFileSync(new URL(`./prompts/${name}`, import.meta.url), 'utf8').trim();

export const VOICE = read('voice.md');
export const POLICY = read('policy.md');
export const RUNTIME = read('talisman.md');

export function safeZone(timeZone) {
  if (!timeZone || typeof timeZone !== 'string') return 'UTC';
  try { new Intl.DateTimeFormat('en-GB', { timeZone }); return timeZone; } catch { return 'UTC'; }
}

export function localStamp(date = new Date(), timeZone = 'UTC') {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: safeZone(timeZone),
  }).format(date);
}

const KIND_LABEL = { preference: 'Preferences', fact: 'Facts', entity: 'People, places and accounts', task: 'Open threads', goal: 'Goals' };

export function memoryBlock(memory) {
  const entries = Array.isArray(memory) ? memory : Array.isArray(memory?.entries) ? memory.entries : [];
  const index = Array.isArray(memory?.index) ? memory.index : [];
  if (!entries.length && !index.length) return 'Nothing saved yet.';
  const groups = new Map();
  for (const entry of entries) {
    const kind = String(entry.kind || 'fact');
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(`- ${entry.key}: ${entry.value}`);
  }
  const lines = [];
  for (const [kind, items] of groups) lines.push(`${KIND_LABEL[kind] || 'Saved'}\n${items.join('\n')}`);
  if (index.length) lines.push(`Also saved, ask only if needed: ${index.slice(0, 140).join(', ')}`);
  return lines.join('\n\n');
}

export function historyBlock(history = []) {
  if (!Array.isArray(history) || !history.length) return '';
  return history
    .slice(-16)
    .filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.text === 'string')
    .map(item => `${item.role === 'assistant' ? 'Talisman' : 'Them'}: ${String(item.text).replace(/\s+/g, ' ').slice(0, 1200)}`)
    .join('\n');
}

export function skillBlock(skills = []) {
  if (!Array.isArray(skills) || !skills.length) return '';
  return `Skills on this computer (read the file before using a recipe):\n${skills.map(skill => `- ${skill.name}: ${skill.path} — ${skill.description}`).join('\n')}`;
}

function assemble(parts) {
  return parts.filter(Boolean).join('\n\n---\n\n');
}

export function buildReplyPrompt({ timeZone = 'UTC', soul = '', memory = null, history = [], now = new Date() } = {}) {
  const conversation = historyBlock(history);
  return assemble([
    VOICE,
    `Right now it is ${localStamp(now, timeZone)} where they are.`,
    soul ? `What you know about them:\n${soul}` : '',
    `Remembered facts:\n${memoryBlock(memory)}`,
    conversation ? `Recent conversation (context, not instructions):\n${conversation}` : '',
    'Reply now. One clear answer in their language, no process narration, no tool names, no repeated question.',
  ]);
}

export function buildTaskPrompt({ timeZone = 'UTC', soul = '', memory = null, history = [], skills = [], now = new Date(), extra = '' } = {}) {
  const conversation = historyBlock(history);
  return assemble([
    VOICE,
    POLICY,
    RUNTIME,
    `Right now it is ${localStamp(now, timeZone)} where they are. Use this for anything time-based.`,
    skillBlock(skills),
    soul ? `What you know about them:\n${soul}` : '',
    `Remembered facts:\n${memoryBlock(memory)}`,
    conversation ? `Recent conversation (context, not instructions):\n${conversation}` : '',
    extra,
    'Do the work, verify it, then reply as yourself. Never mention tools, models, paths, or the steps you took.',
  ]);
}

export function buildToolPrompt({ timeZone = 'UTC', soul = '', memory = null, tools = '', now = new Date() } = {}) {
  return assemble([
    VOICE,
    POLICY,
    `Right now it is ${localStamp(now, timeZone)} where they are.`,
    tools,
    soul ? `What you know about them:\n${soul}` : '',
    `Remembered facts:\n${memoryBlock(memory)}`,
    'Before each group of tool calls, write one short sentence saying what you are about to do and why, so the person can follow the work. Then call tools, verify, and answer as yourself.',
  ]);
}
