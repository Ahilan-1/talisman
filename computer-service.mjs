import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { chromium } from 'playwright-core';

const run = promisify(execFile);
const root = '/config/talisman-computer';
const shots = path.join(root, 'screenshots');
const profile = path.join(root, 'profile');
fs.mkdirSync(shots, { recursive: true, mode: 0o700 });
let context, page, busy = false;
const control = (process.env.TALISMAN_URL || 'http://talisman:3000').replace(/\/$/, '');
async function arlong(route, data) {
  if (!process.env.TALISMAN_WORKER_KEY) throw Error('Arlong worker access is unavailable');
  const response = await fetch(`${control}/api/worker/arlong/${route}`, { method: 'POST', headers: { authorization: `Bearer ${process.env.TALISMAN_WORKER_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(route === 'search' ? 25_000 : 35_000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(result.error || `Arlong ${route} failed (${response.status})`);
  return result;
}

async function clearStaleProfileLock() {
  const { stdout } = await run('ps', ['-eo', 'comm=,args='], { timeout: 5000 });
  const inUse = stdout.split('\n').some(line => /^chromium\s/.test(line.trim()) && line.includes(`--user-data-dir=${profile}`));
  if (inUse) throw Error('The assigned browser profile is already in use');
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    fs.rmSync(path.join(profile, name), { force: true });
  }
}

async function browser() {
  if (!context) {
    await clearStaleProfileLock();
    context = await chromium.launchPersistentContext(profile, {
      executablePath: '/usr/bin/chromium', headless: false, viewport: { width: 1365, height: 900 },
      args: ['--no-sandbox', '--disable-dev-shm-usage'], timeout: 30_000,
    });
    page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(25_000);
  }
  return page;
}

function publicUrl(input) {
  const url = new URL(String(input));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Use a public HTTP or HTTPS URL');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|::1$)/.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) throw Error('Private network addresses are unavailable');
  return url.href;
}

async function summary(tab) {
  return tab.evaluate(() => ({
    title: document.title,
    url: location.href,
    text: (document.body?.innerText || '').slice(0, 14000),
    links: [...document.querySelectorAll('a[href]')].filter(a => a.innerText.trim()).slice(0, 35).map(a => ({ text: a.innerText.trim().slice(0, 100), url: a.href })),
    inputs: [...document.querySelectorAll('input,textarea,select')].slice(0, 20).map(e => ({ tag: e.tagName.toLowerCase(), type: e.type || '', name: e.name || '', placeholder: e.placeholder || '', ariaLabel: e.getAttribute('aria-label') || '' })),
    buttons: [...document.querySelectorAll('button,[role="button"]')].slice(0, 25).map(e => (e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 100)).filter(Boolean),
  }));
}

async function settle(tab) {
  await tab.waitForLoadState('networkidle', { timeout: 7000 }).catch(() => {});
}

// SPAs paint long after domcontentloaded. Wait until the visible text stops growing.
async function settleContent(tab, budget = 5_000) {
  let previous = -1, stable = 0;
  const started = Date.now();
  while (Date.now() - started < budget) {
    const length = await tab.evaluate(() => (document.body?.innerText || '').length).catch(() => 0);
    if (length > 0 && length === previous) stable += 1; else { stable = 0; previous = length; }
    if (stable >= 2) return;
    await tab.waitForTimeout(400).catch(() => {});
  }
}

async function loadPage(tab, url, timeout = 45_000) {
  await tab.goto(publicUrl(url), { waitUntil: 'domcontentloaded', timeout });
  await settleContent(tab);
}

const looksUnfinished = value => value.text.length < 60 || /^(loading|please wait|just a moment|please enable javascript)/i.test(value.text.trim());

// If a listing page comes back thin, nudge it: scroll for lazy content, then reload once.
async function ensureContent(tab, selector) {
  let result = await pageText(tab, selector);
  if (String(selector || '').trim() || result.blocked || !looksUnfinished(result)) return result;
  await tab.mouse.wheel(0, 900).catch(() => {});
  await settleContent(tab, 6_000);
  result = await pageText(tab, selector);
  if (result.blocked || !looksUnfinished(result)) return result;
  await tab.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await settleContent(tab, 6_000);
  return pageText(tab, selector);
}

async function pageText(tab, selector) {
  const trimmed = String(selector || '').trim();
  let text = '';
  if (trimmed) { try { text = await tab.locator(trimmed).first().innerText({ timeout: 8000 }); } catch { text = ''; } }
  if (!text) text = await tab.locator('body').innerText();
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 20000);
  const blocked = /sorry, you have been blocked|attention required! \| cloudflare|access denied|verify you are human|captcha/i.test(clean);
  return { title: await tab.title(), url: tab.url(), text: clean, blocked };
}

async function search(tab, query) {
  if (!query || query.length > 300) throw Error('Search query must be 1–300 characters');
  for (const engine of ['https://www.google.com/search?q=', 'https://www.bing.com/search?q=', 'https://duckduckgo.com/?q=']) {
    await tab.goto(engine + encodeURIComponent(query), { waitUntil: 'domcontentloaded', timeout: 25_000 });
    const result = await tab.evaluate(() => [...document.querySelectorAll('a:has(h3),li.b_algo h2 a,a[data-testid="result-title-a"],.result__a')].map(a => ({ title: (a.querySelector('h3')?.innerText || a.innerText || '').trim(), url: a.href, snippet: a.closest('div.MjjYud,li.b_algo')?.innerText?.slice(0, 260) || '' })).filter(x => x.title && /^https?:/.test(x.url)).slice(0, 15));
    if (result.length) {
      const seen = new Set();
      const results = result.map(item => {
        try { const url = new URL(item.url); const encoded = url.hostname.endsWith('bing.com') ? url.searchParams.get('u') : null; if (encoded?.startsWith('a1')) item.url = publicUrl(Buffer.from(encoded.slice(2), 'base64url').toString('utf8')); } catch {}
        return item;
      }).filter(item => { if (seen.has(item.url)) return false; seen.add(item.url); return true; }).slice(0, 10);
      return { query, engine: new URL(tab.url()).hostname, results };
    }
  }
  return { query, results: [], note: 'Search results were unavailable; do not invent findings.' };
}

async function action(data) {
  const kind = String(data.action || '');
  if (kind === 'extract') return arlong('extract', { url: publicUrl(data.url) });
  if (kind === 'screen') return arlong('screen', { url: data.url ? publicUrl(data.url) : '', text: String(data.text || '') });
  if (kind === 'search') {
    const query = String(data.query || '');
    try { const result = await arlong('search', { query }); if (result.results?.length) return result; } catch {}
  }
  if (kind === 'desktop-screenshot') {
    const file = path.join(shots, `desktop-${Date.now()}.png`);
    await run('xfce4-screenshooter', ['--fullscreen', '--save', file], { timeout: 15_000, env: { ...process.env, DISPLAY: ':1' } });
    fs.chmodSync(file, 0o600);
    return { screenshot: file };
  }
  if (kind === 'desktop-click') {
    const x = Number(data.x), y = Number(data.y);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 10000 || y > 10000) throw Error('Invalid desktop coordinates');
    await run('xdotool', ['mousemove', String(x), String(y), 'click', '1'], { timeout: 5000, env: { ...process.env, DISPLAY: ':1' } });
    return { clicked: [x, y] };
  }
  if (kind === 'desktop-type') {
    const value = String(data.value || '').slice(0, 2000);
    await run('xdotool', ['type', '--clearmodifiers', '--delay', '4', '--', value], { timeout: 15_000, env: { ...process.env, DISPLAY: ':1' } });
    return { typed: value.length };
  }
  const tab = await browser();
  if (kind === 'search') return search(tab, String(data.query || ''));
  if (kind === 'find') {
    const query = String(data.query || '').trim();
    if (query.length < 2 || query.length > 100) throw Error('Find query must be 2–100 characters');
    return tab.evaluate(needle => {
      const rows = [...document.querySelectorAll('tr,li')].filter(element => element.innerText?.toLowerCase().includes(needle)).slice(0, 15).map(element => ({ text: element.innerText.trim().slice(0, 500), links: [...element.querySelectorAll('a[href]')].slice(0, 5).map(a => ({ text: a.innerText.trim().slice(0, 100), url: a.href })) }));
      const links = [...document.querySelectorAll('a[href]')].filter(a => a.innerText.toLowerCase().includes(needle)).slice(0, 15).map(a => ({ text: a.innerText.trim().slice(0, 100), url: a.href }));
      const lines = (document.body?.innerText || '').split('\n').map(line => line.trim()).filter(Boolean);
      const snippets = lines.flatMap((line, index) => line.toLowerCase().includes(needle) ? [lines.slice(Math.max(0, index - 1), index + 3).join(' | ').slice(0, 500)] : []).slice(0, 15);
      return { url: location.href, query: needle, rows, links, snippets };
    }, query.toLowerCase());
  }
  if (kind === 'read') {
    const url = publicUrl(data.url);
    try {
      await loadPage(tab, url);
      const result = await ensureContent(tab, data.selector);
      if (!result.blocked) return result;
      try { return await arlong('extract', { url }); } catch { return result; }
    } catch (error) {
      try { return await arlong('extract', { url }); } catch { throw error; }
    }
  }
  if (kind === 'text') return ensureContent(tab, data.selector);
  if (kind === 'wait') {
    const selector = String(data.selector || '').trim();
    const text = String(data.text || '').trim();
    const budget = Math.max(1000, Math.min(20_000, Number(data.timeoutMs) || 10_000));
    if (selector) await tab.waitForSelector(selector, { timeout: budget, state: 'visible' });
    else if (text) await tab.getByText(text, { exact: false }).first().waitFor({ timeout: budget });
    else await tab.waitForLoadState('networkidle', { timeout: budget }).catch(() => {});
    return summary(tab);
  }
  if (kind === 'scroll') {
    const direction = String(data.direction || 'down').toLowerCase();
    const amount = Math.max(120, Math.min(4000, Number(data.amount) || 700));
    await tab.mouse.wheel(direction === 'left' ? -amount : direction === 'right' ? amount : 0, direction === 'up' ? -amount : direction === 'down' || !direction ? amount : 0);
    await tab.waitForTimeout(700);
    return summary(tab);
  }
  if (kind === 'select') {
    await tab.locator(String(data.selector || '')).first().selectOption(String(data.value || ''));
    return summary(tab);
  }
  if (kind === 'hover') {
    await tab.locator(String(data.selector || '')).first().hover();
    return summary(tab);
  }
  if (kind === 'back') { await tab.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 }); await settle(tab); return summary(tab); }
  if (kind === 'forward') { await tab.goForward({ waitUntil: 'domcontentloaded', timeout: 20_000 }); await settle(tab); return summary(tab); }
  if (kind === 'newtab') {
    const fresh = await context.newPage();
    fresh.setDefaultTimeout(20_000);
    if (data.url) await loadPage(fresh, data.url);
    page = fresh;
    return summary(page);
  }
  if (kind === 'switch') {
    const index = Number(data.index ?? -1);
    const list = context.pages();
    if (!Number.isInteger(index) || index < 0 || index >= list.length) throw Error(`Tab index out of range (0–${list.length - 1})`);
    page = list[index];
    return summary(page);
  }
  if (kind === 'open') { await loadPage(tab, data.url); }
  else if (kind === 'click') {
    const target = tab.locator(String(data.selector || '')).first();
    const label = ((await target.innerText().catch(() => '')) + ' ' + (await target.getAttribute('aria-label').catch(() => '') || '')).trim();
    if (/\b(pay|place order|confirm booking|buy now|purchase|send message|create account)\b/i.test(label)) throw Error('This action needs explicit user approval before it can be clicked');
    await target.click();
  }
  else if (kind === 'fill') await tab.locator(String(data.selector || '')).first().fill(String(data.value || '').slice(0, 5000));
  else if (kind === 'press') await tab.keyboard.press(String(data.key || 'Enter'));
  else if (kind === 'screenshot') {
    const file = path.join(shots, `browser-${Date.now()}.png`);
    await tab.screenshot({ path: file, fullPage: false });
    fs.chmodSync(file, 0o600);
    return { screenshot: file, url: tab.url(), title: await tab.title() };
  } else if (kind !== 'inspect') throw Error('Unknown computer action');
  const result = await summary(tab);
  if (kind === 'open' && /sorry, you have been blocked|attention required! \| cloudflare|access denied|verify you are human|captcha/i.test(result.text)) {
    result.blocked = true;
    result.note = 'This browser reached an access challenge. Try extract for public page evidence, or another source.';
  }
  return result;
}

http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (req.method !== 'POST' || req.url !== '/action') { res.statusCode = 404; return res.end('{}'); }
  if (busy) {
    for (let waited = 0; waited < 40 && busy; waited += 1) await new Promise(resolve => setTimeout(resolve, 500));
    if (busy) { res.statusCode = 429; return res.end(JSON.stringify({ error: 'Computer is busy' })); }
  }
  busy = true;
  try {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 12_000) throw Error('Computer request too large'); }
    const result = await action(JSON.parse(raw));
    res.end(JSON.stringify(result));
  } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: String(error.message || error).slice(0, 300) })); }
  finally { busy = false; }
}).listen(4150, '127.0.0.1', () => console.log('Private computer controls ready'));
