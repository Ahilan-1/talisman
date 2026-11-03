import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildReplyPrompt, buildToolPrompt, safeZone, localStamp } from './prompt.mjs';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const CALLBACK = 'http://127.0.0.1:1455/auth/callback';
const REQUIRED = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
const tokenEndpoint = `${ISSUER}/api/accounts/oauth/token`;
const random = () => crypto.randomBytes(32).toString('base64url');
const digest = value => crypto.createHash('sha256').update(value).digest('base64url');

function parseJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw Error('Invalid identity token');
  return { header: JSON.parse(Buffer.from(parts[0], 'base64url')), payload: JSON.parse(Buffer.from(parts[1], 'base64url')), signed: Buffer.from(`${parts[0]}.${parts[1]}`), signature: Buffer.from(parts[2], 'base64url') };
}

async function verifyIdentity(token, clientId, nonce, expectedSubject) {
  const jwt = parseJwt(token);
  if (jwt.header.alg !== 'RS256' || !jwt.header.kid) throw Error('Unsupported identity token signature');
  const response = await fetch(`${ISSUER}/.well-known/jwks.json`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw Error('Could not verify OpenAI identity');
  const jwk = (await response.json()).keys?.find(key => key.kid === jwt.header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig'));
  if (!jwk || !crypto.verify('RSA-SHA256', jwt.signed, crypto.createPublicKey({ key: jwk, format: 'jwk' }), jwt.signature)) throw Error('Invalid identity token signature');
  const p = jwt.payload, current = Date.now() / 1000;
  if (p.iss !== ISSUER || !(Array.isArray(p.aud) ? p.aud.includes(clientId) : p.aud === clientId) || p.nonce !== nonce || typeof p.sub !== 'string' || !p.sub || !Number.isFinite(p.exp) || p.exp <= current - 5 || (p.iat && p.iat > current + 5)) throw Error('Invalid OpenAI identity claims');
  if (expectedSubject && p.sub !== expectedSubject) throw Error('A different OpenAI account was selected');
  return { subject: p.sub, email: typeof p.email === 'string' ? p.email : null };
}

async function exchange(form) {
  const response = await fetch(tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw Error(`OpenAI authorization failed (${response.status})`);
  return response.json();
}

const TOOL_GUIDE = `You are using this person's private computer. Work in this order: search or open a page, wait for it to settle, read the text, act only on what you can see, screenshot when the layout matters, and verify the final state. If a page blocks automation, try one alternate source before reporting the block. Never fill payment, password, or identity fields without asking first. Do not call a tool to answer something you already know.`;

export function createOpenAIConnection(db, dataDir) {
  db.exec(`CREATE TABLE IF NOT EXISTS openai_connections(user_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, subject TEXT NOT NULL, email TEXT, credential TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS openai_auth_attempts(state_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,verifier TEXT NOT NULL,nonce TEXT NOT NULL,client_id TEXT,expires_at INTEGER NOT NULL);`);
  const keyPath = path.join(dataDir, 'openai-credential.key');
  if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
  const key = fs.readFileSync(keyPath);
  if (key.length !== 32) throw Error('Invalid credential encryption key');
  const hostIdRow = db.prepare("SELECT value FROM app_state WHERE key='openai_host_id'").get();
  const hostId = hostIdRow?.value || `urn:uuid:${crypto.randomUUID()}`;
  if (!hostIdRow) db.prepare("INSERT INTO app_state(key,value) VALUES('openai_host_id',?)").run(hostId);
  const cache = new Map();
  const seal = value => { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv), bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64url'); };
  const unseal = value => { const bytes = Buffer.from(value, 'base64url'), decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()); };
  const rowFor = userId => db.prepare('SELECT * FROM openai_connections WHERE user_id=?').get(userId);
  const status = userId => { const row = rowFor(userId); return { connected: !!row, email: row?.email || null, economyOnly: true }; };
  function start(userId) {
    const existing = rowFor(userId), state = random(), nonce = random(), verifier = random();
    db.prepare('DELETE FROM openai_auth_attempts WHERE user_id=? OR expires_at<?').run(userId, Date.now());
    db.prepare('INSERT INTO openai_auth_attempts VALUES(?,?,?,?,?,?)').run(digest(state), userId, verifier, nonce, existing?.client_id || null, Date.now() + 10 * 60_000);
    const params = new URLSearchParams({ client_id: existing?.client_id || 'dynamic_agent_client', ext_agent_host_id: hostId, response_type: 'code', redirect_uri: CALLBACK, scope: REQUIRED.join(' '), resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: digest(verifier) });
    if (!existing) params.set('agent_name_hint', 'Talisman');
    return `${ISSUER}/api/accounts/authorize?${params}`;
  }
  async function callback(url, userId) {
    const state = url.searchParams.get('state');
    const attempt = state && db.prepare('SELECT * FROM openai_auth_attempts WHERE state_hash=?').get(digest(state));
    if (!attempt || attempt.expires_at < Date.now() || attempt.user_id !== userId) throw Error('Sign-in session expired or does not match this account');
    db.prepare('DELETE FROM openai_auth_attempts WHERE state_hash=?').run(digest(state));
    if (url.searchParams.has('error')) throw Error('OpenAI sign-in was canceled');
    const code = url.searchParams.get('code');
    const returnedId = url.searchParams.get('client_id');
    const clientId = attempt.client_id || returnedId;
    if (!code || !clientId || (attempt.client_id && returnedId && attempt.client_id !== returnedId) || !/^oaiapp_[\w-]+$/.test(clientId)) throw Error('OpenAI registration was incomplete');
    const tokens = await exchange({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: CALLBACK, resource: RESOURCE });
    const prior = rowFor(userId);
    const identity = await verifyIdentity(tokens.id_token, clientId, attempt.nonce, prior?.subject);
    const scopes = String(tokens.scope || '').split(/\s+/);
    if (!REQUIRED.every(scope => scopes.includes(scope)) || !tokens.access_token || !tokens.refresh_token) throw Error('OpenAI plan permission was not granted');
    const credential = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, id_token: tokens.id_token, expires_at: Date.now() + Number(tokens.expires_in || 3600) * 1000, earliest_refresh_at: Number(tokens.earliest_refresh_at || 0) * 1000, scopes };
    db.prepare('INSERT INTO openai_connections VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET client_id=excluded.client_id,subject=excluded.subject,email=excluded.email,credential=excluded.credential,updated_at=excluded.updated_at').run(userId, clientId, identity.subject, identity.email, seal(credential), Date.now());
    cache.delete(userId);
  }
  async function access(userId) {
    const row = rowFor(userId);
    if (!row) throw Error('OpenAI account is not connected');
    const saved = unseal(row.credential);
    if (saved.expires_at > Date.now() + 90_000) return saved.access_token;
    if (saved.earliest_refresh_at && Date.now() < saved.earliest_refresh_at) throw Error('OpenAI token is not ready to refresh');
    const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: saved.refresh_token, client_id: row.client_id });
    if (!refreshed.access_token || !refreshed.refresh_token) throw Error('OpenAI refresh did not return credentials');
    const next = { ...saved, access_token: refreshed.access_token, refresh_token: refreshed.refresh_token, expires_at: Date.now() + Number(refreshed.expires_in || 3600) * 1000, earliest_refresh_at: Number(refreshed.earliest_refresh_at || 0) * 1000, scopes: String(refreshed.scope || saved.scopes.join(' ')).split(/\s+/) };
    db.prepare('UPDATE openai_connections SET credential=?,updated_at=? WHERE user_id=?').run(seal(next), Date.now(), userId);
    return next.access_token;
  }
  async function models(userId) {
    const cached = cache.get(userId);
    if (cached && cached.until > Date.now()) return cached.models;
    const response = await fetch(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${await access(userId)}` }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw Error(`OpenAI model discovery failed (${response.status})`);
    const result = await response.json();
    const available = (result.models || []).filter(model => model.visibility === 'list' && typeof model.slug === 'string');
    const economical = available.filter(model => /^gpt-(?:6(?:\.1)?|5\.6)-luna$/i.test(model.slug));
    const balanced = available.filter(model => /^gpt-(?:6(?:\.1)?|5\.6)-(?:terra|sol)$/i.test(model.slug));
    balanced.sort((a, b) => Number(/-sol$/i.test(a.slug)) - Number(/-sol$/i.test(b.slug)));
    const chosen = { economical: economical[0]?.slug || null, balanced: balanced[0]?.slug || null };
    cache.set(userId, { models: chosen, until: Date.now() + 30 * 60_000 });
    return chosen;
  }
  async function generate(userId, prompt, context = [], soul = '', signal, history = [], timeZone = 'UTC') {
    const available = await models(userId);
    const complex = prompt.length > 1500 || /\b(compare|analyse|analyze|plan|reason|research|design|debug|book|reserve)\b/i.test(prompt);
    const model = complex ? available.balanced || available.economical : available.economical || available.balanced;
    if (!model) throw Error('No economical OpenAI model is available for this account');
    const instructions = buildReplyPrompt({ timeZone: safeZone(timeZone), soul, memory: { entries: context }, history });
    const prior = Array.isArray(history) ? history.slice(-16).filter(item => ['user', 'assistant'].includes(item.role) && typeof item.text === 'string').map(item => ({ role: item.role, content: item.text.slice(0, 2000) })) : [];
    const response = await fetch(`${RESOURCE}/responses`, { method: 'POST', headers: { authorization: `Bearer ${await access(userId)}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, instructions, input: [...prior, { role: 'user', content: prompt }], store: false, stream: true }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) });
    if (!response.ok) {
      const raw = await response.text();
      let failure = {}; try { failure = JSON.parse(raw); } catch {}
      const code = String(failure.error?.code || failure.error?.type || 'unknown').slice(0, 80);
      console.error('OpenAI inference rejected:', response.status, code);
      throw Error(`OpenAI inference failed (${response.status})`);
    }
    let text = '', completed = false, buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
        if (!data || data === '[DONE]') continue;
        let item; try { item = JSON.parse(data); } catch { continue; }
        if (item.type === 'response.output_text.delta') text += item.delta || '';
        if (item.type === 'response.failed') throw Error('OpenAI inference failed');
        if (item.type === 'response.completed') completed = true;
      }
    }
    if (!completed) throw Error('OpenAI response did not complete');
    return text;
  }
  async function step(userId, prompt, context = [], soul = '', input = [], signal, timeZone = 'UTC') {
    const available = await models(userId);
    const model = available.balanced || available.economical;
    if (!model) throw Error('No economical OpenAI model is available for this account');
    const instructions = buildToolPrompt({ timeZone: safeZone(timeZone), soul, memory: { entries: context }, tools: TOOL_GUIDE });
    const text = (description, extra = {}) => ({ type: 'string', description, ...extra });
    const tool = (name, description, properties, required = Object.keys(properties)) => ({
      type: 'function', name, description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      strict: required.length === Object.keys(properties).length,
    });
    const tools = [{ type: 'namespace', name: 'talisman_browser', description: 'This person’s private browser. Page state persists between calls.', tools: [
      tool('search', 'Search the live web. Open results to verify claims.', { query: text('A focused search query') }),
      tool('open', 'Open a public HTTP or HTTPS page in the assigned browser.', { url: text('Page URL') }),
      tool('read', 'Open a URL and return its text, optionally limited to a CSS selector.', { url: text('Page URL'), selector: text('CSS selector, or empty for the whole page') }),
      tool('text', 'Read the current page without navigating.', { selector: text('CSS selector, or empty for the whole page') }),
      tool('find', 'Find text, links and table rows on the current page.', { query: text('Text to find') }),
      tool('inspect', 'Read the current page’s links, buttons and inputs.', {}),
      tool('wait', 'Wait for a selector or text to appear, or for the network to settle.', { selector: text('CSS selector, or empty'), text: text('Visible text to wait for, or empty'), timeoutMs: text('Maximum wait in milliseconds, for example 8000') }),
      tool('scroll', 'Scroll the page to reveal lazy content.', { direction: text('down, up, left or right'), amount: text('Pixels, for example 800') }),
      tool('click', 'Click a selector. Do not confirm a purchase, booking, or account creation without approval.', { selector: text('CSS selector') }),
      tool('fill', 'Fill a form field.', { selector: text('CSS selector'), value: text('Text to enter') }),
      tool('select', 'Choose an option in a dropdown.', { selector: text('CSS selector'), value: text('Option value or label') }),
      tool('hover', 'Hover an element to open menus or tooltips.', { selector: text('CSS selector') }),
      tool('press', 'Press a key in the page, for example Enter.', { key: text('Playwright key name') }),
      tool('back', 'Go back in browser history.', {}),
      tool('forward', 'Go forward in browser history.', {}),
      tool('newtab', 'Open a new tab, optionally on a URL.', { url: text('Page URL, or empty for a blank tab') }),
      tool('switch', 'Switch to another open tab by index.', { index: text('Zero-based tab index') }),
      tool('screenshot', 'Take a screenshot of the current page. Use it when layout matters.', {}),
    ] }];
    const response = await fetch(`${RESOURCE}/responses`, { method: 'POST', headers: { authorization: `Bearer ${await access(userId)}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, instructions, input, tools, store: false, stream: true }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) });
    if (!response.ok) {
      const raw = await response.text(); let failure = {}; try { failure = JSON.parse(raw); } catch {}
      console.error('OpenAI tool inference rejected:', response.status, String(failure.error?.code || failure.error?.type || 'unknown').slice(0, 80), String(failure.error?.param || '').slice(0, 100), String(failure.error?.message || '').slice(0, 250));
      throw Error(`OpenAI tool inference failed (${response.status})`);
    }
    let reply = '', completed, buffer = '';
    const outputItems = new Map(), decoder = new TextDecoder();
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('');
        if (!data || data === '[DONE]') continue;
        let item; try { item = JSON.parse(data); } catch { continue; }
        if (item.type === 'response.output_text.delta') reply += item.delta || '';
        if (item.type === 'response.output_item.done' && item.item) outputItems.set(item.output_index, item.item);
        if (item.type === 'response.failed') throw Error('OpenAI tool inference failed');
        if (item.type === 'response.completed') completed = item.response || {};
      }
    }
    if (!completed) throw Error('OpenAI tool response did not complete');
    const output = Array.isArray(completed.output) ? completed.output : [...outputItems].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
    return { text: reply, output, calls: output.filter(item => item.type === 'function_call').map(item => ({ name: item.name, arguments: item.arguments, callId: item.call_id })) };
  }
  const disconnect = userId => { db.prepare('DELETE FROM openai_connections WHERE user_id=?').run(userId); cache.delete(userId); };
  return { start, callback, status, models, generate, step, disconnect, stamp: localStamp };
}
