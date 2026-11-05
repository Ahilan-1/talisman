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
      executablePath: '/usr/bin/chromium', headless: false, viewport: null,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-notifications'], timeout: 30_000,
    });
    page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(25_000);
  }
  return page;
}

function publicUrl(input) {
  // Links copied out of redirect wrappers often carry raw pipes or spaces that Chromium rejects with
  // ERR_HTTP2_PROTOCOL_ERROR. Encode them instead of failing the whole navigation.
  const cleaned = String(input ?? '').trim().replace(/[\s|]+/g, match => encodeURIComponent(match.trim()));
  const url = new URL(cleaned);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Use a public HTTP or HTTPS URL');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|::1$)/.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) throw Error('Private network addresses are unavailable');
  return url.href;
}

const REF_ATTR = 'data-talisman-ref';

// A numbered map of everything a person could click or type into, so the model never has to guess a
// CSS selector. Refs are re-assigned on every observation and quoted back as `ref=12`.
async function elementMap(tab) {
  return tab.evaluate(attr => {
    const nameOf = el => (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title') || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const roleOf = el => el.getAttribute('role') || (el.type ? `${el.tagName.toLowerCase()}[${el.type}]` : el.tagName.toLowerCase());
    const visible = el => {
      const box = el.getBoundingClientRect();
      if (box.width < 4 || box.height < 4) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0.1;
    };
    const query = 'a[href],button,[role="button"],[role="link"],[role="tab"],[role="option"],[role="menuitem"],[role="radio"],[role="checkbox"],input:not([type="hidden"]),select,textarea,summary,[onclick],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
    const nodes = [...document.querySelectorAll(query)].filter(el => visible(el) && nameOf(el));
    const height = innerHeight;
    nodes.sort((a, b) => {
      const boxA = a.getBoundingClientRect(), boxB = b.getBoundingClientRect();
      const inA = boxA.top < height && boxA.bottom > 0 ? 0 : 1, inB = boxB.top < height && boxB.bottom > 0 ? 0 : 1;
      return inA - inB || boxA.top - boxB.top;
    });
    document.querySelectorAll(`[${attr}]`).forEach(el => el.removeAttribute(attr));
    const elements = nodes.slice(0, 80).map((el, index) => {
      const ref = index + 1;
      el.setAttribute(attr, String(ref));
      const box = el.getBoundingClientRect();
      return {
        ref, role: roleOf(el), name: nameOf(el),
        value: el.type === 'password' ? '••••' : String(el.value ?? '').slice(0, 60),
        checked: el.checked === true || el.getAttribute('aria-checked') === 'true',
        onScreen: box.top < height && box.bottom > 0 && box.left < innerWidth && box.right > 0,
      };
    });
    const overlayNodes = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="modal" i],[class*="popup" i],[class*="overlay" i],[class*="consent" i],[class*="cookie" i],[id*="consent" i],[id*="cookie" i]')]
      .filter(el => { const box = el.getBoundingClientRect(); return box.width > 80 && box.height > 60 && visible(el); });
    return {
      elements,
      overlayList: overlayNodes.slice(0, 6).map(el => ({ tag: el.tagName.toLowerCase(), name: nameOf(el).slice(0, 60) })),
    };
  }, REF_ATTR).catch(() => ({ elements: [], overlayList: [] }));
}

async function summary(tab) {
  const base = await tab.evaluate(() => ({
    title: document.title,
    url: location.href,
    text: (document.body?.innerText || '').slice(0, 12000),
    links: [...document.querySelectorAll('a[href]')].filter(a => a.innerText.trim()).slice(0, 25).map(a => ({ text: a.innerText.trim().slice(0, 100), url: a.href })),
  }));
  const map = await elementMap(tab);
  return { ...base, elements: map.elements, overlays: map.overlayList.length, overlayList: map.overlayList };
}

const SELECTORISH = /[\[\]()>#.:*,=]|^(?:css=|xpath=)/i;
const normalize = value => String(value || '').toLowerCase().replace(/[’‘“”"']/g, '').replace(/\s+/g, ' ').trim();

async function pickVisible(locator, limit = 12) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < Math.min(count, limit); index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return count ? locator.first() : null;
}

// Accepts a CSS selector, a visible label (“DEC 2026”), or a ref from the last observation (ref=12).
// Never spends 25 seconds on a miss: a bad guess fails in a second and returns what can be clicked.
async function resolveTarget(tab, raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw Error('A selector, a visible label, or a ref from the last page observation is required');
  const ref = value.match(/^(?:ref\s*=\s*|@|nth=)(\d+)$/i);
  if (ref) {
    const locator = tab.locator(`[${REF_ATTR}="${ref[1]}"]`);
    if (!(await locator.count().catch(() => 0))) throw Error(`Ref ${ref[1]} is no longer on the page. Run inspect or text and use a current ref.`);
    return { locator: locator.first(), how: `ref=${ref[1]}` };
  }
  const bare = value.replace(/^css=/i, '');
  if (/^(?:text=|xpath=)/i.test(value) || SELECTORISH.test(bare)) {
    try {
      const target = await pickVisible(tab.locator(bare), 8);
      if (target) return { locator: target, how: 'selector' };
    } catch { /* fall through to label matching */ }
  }
  const label = value.replace(/^(?:text=|css=)/i, '').replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '');
  if (label) {
    for (const role of ['button', 'link', 'tab', 'option', 'menuitem', 'radio', 'checkbox']) {
      const target = await pickVisible(tab.getByRole(role, { name: label, exact: false }), 6).catch(() => null);
      if (target) return { locator: target, how: `${role} “${label}”` };
    }
    const byText = await pickVisible(tab.getByText(label, { exact: false }), 8).catch(() => null);
    if (byText) return { locator: byText, how: 'visible text' };
    const { elements } = await elementMap(tab);
    const needle = normalize(label);
    let best = null, bestScore = 0;
    for (const element of elements) {
      const name = normalize(element.name);
      let score = 0;
      if (name === needle) score = 100;
      else if (name.includes(needle)) score = 80 - Math.min(20, name.length - needle.length);
      else if (needle.includes(name) && name.length > 3) score = 60;
      else {
        const words = needle.split(' ').filter(word => word.length > 2);
        const hits = words.filter(word => name.includes(word)).length;
        if (words.length && hits) score = Math.round(40 * hits / words.length);
      }
      if (score > bestScore) { bestScore = score; best = element; }
    }
    if (best && bestScore >= 40) return { locator: tab.locator(`[${REF_ATTR}="${best.ref}"]`).first(), how: `label match “${best.name}”` };
    const error = Error(`Nothing on this page matches ${JSON.stringify(label.slice(0, 60))}. The clickable elements are listed in candidates with refs; use ref= or a shorter label.`);
    error.candidates = elements.slice(0, 15);
    throw error;
  }
  throw Error(`Could not interpret ${JSON.stringify(value.slice(0, 60))} as a selector, label or ref`);
}

// A blocked click is not a successful click. Close a visible blocker, then let Playwright check
// actionability again; never force a coordinate click through a consent layer.
async function clickTarget(tab, target) {
  const attempt = async timeout => {
    await target.scrollIntoViewIfNeeded({ timeout: 3000 });
    await target.click({ timeout });
  };
  try { await attempt(4000); return []; }
  catch (first) {
    const recovered = [];
    const closed = await dismissOverlays(tab);
    if (closed.length) recovered.push(`closed ${closed.join(', ')}`);
    try { await attempt(4000); return recovered.length ? recovered : ['clicked after the page settled']; }
    catch (second) {
      const position=await target.evaluate(element=>{const r=element.getBoundingClientRect();return {top:Math.round(r.top),bottom:Math.round(r.bottom),viewportHeight:innerHeight}}).catch(()=>null);
      throw Error(`Click did not reach the control: ${String(second.message || second).split('\n')[0]}. First attempt: ${String(first.message || first).split('\n')[0]}. ${position?`Target position ${JSON.stringify(position)}. `:''}Inspect again; if the fare panel scrolls separately, scroll inside it or choose its visible booking button.`);
    }
  }
}

const isDead = item => !item || item.isClosed?.() || /^chrome-error:\/\//.test(item.url());

async function tabList(context, active) {
  return Promise.all(context.pages().map(async (item, index) => {
    const url = item.url();
    return {
      index,
      title: url === 'about:blank' ? 'New tab' : url.startsWith('chrome-error://') ? 'Page failed to load' : await item.title().catch(() => url) || url,
      url,
      active: item === active,
      failed: isDead(item),
    };
  }));
}

let lastRecovery = '';

// A finished task can leave the browser focused on a dead tab while the current task works in
// another one. Every call therefore targets a live tab, and says so when it had to move.
async function resolveActive(data, { mutating = false } = {}) {
  const active = await browser();
  const wanted = data.tab ?? data.tabMatch ?? data.match;
  let tab = active, explicit = false;
  if (wanted !== undefined && wanted !== null && String(wanted).trim() !== '') {
    explicit = true;
    const chosen = await matchTab(context, wanted, active);
    if (!chosen) throw Error(`No open tab matches ${JSON.stringify(String(wanted).slice(0, 60))}. Open tabs: ${(await tabList(context, active)).map(item => `${item.index}: ${item.title}`).join(' | ')}`);
    tab = chosen;
  }
  if (!explicit && isDead(tab)) {
    if (mutating) throw Error(`The focused tab (index ${context.pages().indexOf(tab)}) failed to load, so nothing was clicked or typed. Run tabs, then switch to a working tab before acting.`);
    const fallback = context.pages().filter(item => item !== tab && !isDead(item)).at(-1);
    if (fallback) {
      tab = fallback;
      lastRecovery = 'The previously focused tab had failed to load. Focus moved to a working tab; run tabs to see every open tab.';
    } else {
      lastRecovery = 'Every open tab is showing a browser error. Open a verified URL or switch to a working tab before clicking.';
    }
  } else lastRecovery = '';
  page = tab;
  await tab.bringToFront().catch(() => {});
  return tab;
}

// Switching by index alone is guesswork for a model that cannot see the tab strip.
// Accept a number, a URL fragment, or a title fragment.
async function matchTab(context, value) {
  const pages = context.pages();
  const raw = String(value ?? '').trim();
  if (/^\d+$/.test(raw)) return pages[Number(raw)] || null;
  const needle = raw.toLowerCase();
  if (!needle) return null;
  for (const item of pages) {
    const url = item.url();
    const title = url === 'about:blank' ? 'New tab' : url.startsWith('chrome-error://') ? 'Page failed to load' : await item.title().catch(() => '');
    if (`${url} ${title}`.toLowerCase().includes(needle)) return item;
  }
  return null;
}

const DISMISS_LABEL = /^(×|✕|✖|╳|close|dismiss|no thanks|no,? thanks|not now|maybe later|later|skip|skip ad|continue without[\w \-]*|got it|ok(ay)?|accept( all)?( cookies)?|allow all|agree|i agree|i understand|reject( all)?( cookies)?|decline|save (my )?(choice|preferences)|no thanks!?)$/i;

// Ads, cookie bars and offer interstitials block real clicks. This behaves like a person would:
// press Escape, then look inside anything overlay-shaped for a close, skip or “no thanks” control.
async function dismissOverlays(tab) {
  const closed = [];
  await tab.keyboard.press('Escape').catch(() => {});
  await tab.waitForTimeout(250);
  const containers = '[role="dialog"],[aria-modal="true"],[class*="modal" i],[class*="popup" i],[class*="overlay" i],[class*="lightbox" i],[class*="interstitial" i],[class*="drawer" i],[class*="consent" i],[class*="cookie" i],[id*="consent" i],[id*="cookie" i]';
  for (let pass = 0; pass < 4; pass += 1) {
    let clicked = false;
    // Consent managers frequently live in an iframe. Search the top page and every attached frame.
    for (const frame of tab.frames()) {
      const candidates = [
        frame.locator(`${containers} button, ${containers} [role="button"], ${containers} a`),
        frame.locator('button,[role="button"],a').filter({ hasText: /accept|agree|reject|decline|close|dismiss|skip|not now|no thanks|save preferences/i }),
      ];
      for (const group of candidates) {
        const nodes = await group.all().catch(() => []);
        for (const node of nodes.slice(0, 80)) {
          if (!(await node.isVisible().catch(() => false))) continue;
          const label = `${await node.innerText().catch(() => '')} ${await node.getAttribute('aria-label').catch(() => '') || ''}`.replace(/\s+/g, ' ').trim();
          if (!label || label.length > 60 || !DISMISS_LABEL.test(label)) continue;
          try { await node.click({ timeout: 3000 }); } catch { continue; }
          closed.push(label.slice(0, 40));
          clicked = true;
          await tab.waitForTimeout(500);
          break;
        }
        if (clicked) break;
      }
      if (clicked) break;
    }
    if (!clicked) break;
  }
  return closed;
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
  const tab = await resolveActive(data, { mutating: ['click', 'fill', 'select', 'press', 'hover'].includes(kind) });
  if (kind === 'dismiss') {
    const closed = await dismissOverlays(tab);
    const result = await summary(tab);
    return {
      ...result,
      closed,
      note: closed.length
        ? `Closed: ${closed.join(', ')}. Read the page again before clicking.`
        : 'No dismissible popup was found. The overlays and elements lists show what is covering the page; click its close control with its ref.',
    };
  }
  if (kind === 'reset') return {
    ...(await summary(page)),
    tabs: await tabList(context, page),
    note: 'Focus is on a working tab. Use switch with part of a tab URL or title to move to another one.',
  };
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
    const resolved = await resolveTarget(tab, data.selector);
    await resolved.locator.selectOption(String(data.value || ''));
    return summary(tab);
  }
  if (kind === 'hover') {
    const resolved = await resolveTarget(tab, data.selector);
    await resolved.locator.hover();
    return summary(tab);
  }
  if (kind === 'back') { await tab.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 }); await settle(tab); return summary(tab); }
  if (kind === 'forward') { await tab.goForward({ waitUntil: 'domcontentloaded', timeout: 20_000 }); await settle(tab); return summary(tab); }
  if (kind === 'tabs') return { tabs: await tabList(context, page) };
  if (kind === 'newtab') {
    const fresh = await context.newPage();
    fresh.setDefaultTimeout(20_000);
    if (data.url) await loadPage(fresh, data.url);
    page = fresh;
    return { ...(await summary(page)), tabs: await tabList(context, page) };
  }
  if (kind === 'switch') {
    await page.bringToFront().catch(() => {});
    const tabs = await tabList(context, page);
    const activeTab = tabs.find(item => item.active);
    return {
      ...(await summary(page)),
      tabs,
      ...(activeTab?.failed ? { failedTab: true, note: 'This tab failed to load, so clicks here will not work. Switch to a working tab, or close this one.' } : {}),
    };
  }
  if (kind === 'close') {
    const target = await matchTab(context, data.index ?? data.match ?? data.url, page);
    if (target && context.pages().length > 1) {
      await target.close();
      if (page === target) page = context.pages().at(-1);
    } else if (!target) {
      return { ...(await summary(page)), tabs: await tabList(context, page), note: 'No open tab matched that description, so nothing was closed. Run tabs to see the open tabs.' };
    }
    return { ...(await summary(page)), tabs: await tabList(context, page) };
  }
  if (kind === 'inspect') {
    const result = await summary(tab);
    return {
      ...result,
      note: 'elements lists everything clickable or typeable, with a ref. Act with ref=… instead of guessing CSS. Overlays listed here are covering the page; close them first.',
    };
  }
  let did;
  if (kind === 'open') {
    did = { kind: 'open' };
    try { await loadPage(tab, data.url); }
    catch (error) {
      const message = String(error.message || error);
      if (/ERR_INVALID_URL|ERR_INVALID_ARGUMENT|ERR_NAME_NOT_RESOLVED/.test(message))
        throw Error(`${message.split('\n')[0].slice(0, 160)}. Do not build this URL from link text or a redirect parameter. Go back to the page you were on and click the airline or result link instead.`);
      // Travel sites drop the first connection often. One clean retry, then read the page instead of dying.
      await tab.waitForTimeout(600).catch(() => {});
      try { await loadPage(tab, data.url, 30_000); did.retried = true; }
      catch {
        try {
          const fallback = await arlong('extract', { url: publicUrl(data.url) });
          return {
            ...fallback,
            did: { kind: 'open', url: publicUrl(data.url) },
            note: 'This site refused the browser twice. Its public content was read with extract, so quote only that. For anything that needs clicking (dates, fares, seat maps), switch to another source for the same information.',
          };
        } catch {
          throw Error(`${message.split('\n')[0].slice(0, 160)}. This site refused the browser twice. Switch to another source for the same information instead of retrying this URL.`);
        }
      }
    }
  }
  else if (kind === 'click') {
    const resolved = await resolveTarget(tab, data.selector);
    const label = ((await resolved.locator.innerText().catch(() => '')) + ' ' + (await resolved.locator.getAttribute('aria-label').catch(() => '') || '')).replace(/\s+/g, ' ').trim();
    did = { kind: 'click', label: (label || resolved.how).slice(0, 120), matched: resolved.how };
    if (data.intent==='consequential') {
      const context=await resolved.locator.evaluate(element=>(element.closest('form')||element.parentElement)?.innerText?.slice(0,700)||'').catch(()=>'');
      const details={label:label.slice(0,160),url:tab.url(),selector:String(data.selector||'').slice(0,300),title:await tab.title(),context};
      if(!data.approvalId)return {approvalRequired:details};
      const base=(process.env.TALISMAN_URL||'http://talisman:3000').replace(/\/$/,'');
      const response=await fetch(`${base}/api/worker/task/approval/consume`,{method:'POST',headers:{authorization:`Bearer ${process.env.TALISMAN_WORKER_KEY||''}`,'content-type':'application/json'},body:JSON.stringify({id:data.approvalId,...details}),signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw Error('That exact action was not approved');
    }
    const recovered = await clickTarget(tab, resolved.locator);
    if (recovered.length) did.recovered = recovered;
  }
  else if (kind === 'fill') {
    const resolved = await resolveTarget(tab, data.selector);
    const field = resolved.locator;
    const value = String(data.value || '');
    const name = [await field.getAttribute('placeholder').catch(() => ''), await field.getAttribute('aria-label').catch(() => ''), await field.getAttribute('name').catch(() => '')].filter(Boolean).find(Boolean) || '';
    const type = await field.getAttribute('type').catch(() => '') || '';
    const hidden = type === 'password' || /pass|otp|one.?time|verif|pin\b|cvv|card|secret|token/i.test(`${name} ${data.selector || ''}`);
    try { await field.fill(value.slice(0, 5000), { timeout: 8000 }); }
    catch {
      await clickTarget(tab, field);
      await tab.keyboard.type(value.slice(0, 5000), { delay: 8 });
    }
    did = { kind: 'fill', field: String(name).replace(/\s+/g, ' ').trim().slice(0, 50) || 'the field', value: hidden ? `${Math.min(value.length, 5000)} characters` : value.slice(0, 90), hidden };
  }
  else if (kind === 'press') { await tab.keyboard.press(String(data.key || 'Enter')); did = { kind: 'press', value: String(data.key || 'Enter').slice(0, 30) }; }
  else  if (kind === 'screenshot') {
    const file = path.join(shots, `browser-${Date.now()}.png`);
    await tab.screenshot({ path: file, fullPage: false });
    fs.chmodSync(file, 0o600);
    return { screenshot: file, url: tab.url(), title: await tab.title(), tabs: await tabList(context, page) };
  } else if (kind !== 'inspect') throw Error('Unknown computer action');
  const result = await summary(tab);
  if (did) result.did = { ...did, url: tab.url(), title: await tab.title().catch(() => '') };
  if (kind === 'open' && /sorry, you have been blocked|attention required! \| cloudflare|access denied|verify you are human|captcha/i.test(result.text)) {
    result.blocked = true;
    result.note = 'This browser reached an access challenge. Try extract for public page evidence, or another source.';
  }
  return result;
}

const serveView=async(req,res)=>{
  if(req.method==='GET'&&req.url==='/view'){
    if(!process.env.TALISMAN_VIEW_TOKEN||req.headers['x-talisman-view-token']!==process.env.TALISMAN_VIEW_TOKEN){res.writeHead(403);return res.end()}
    const shot=path.join(shots,'viewer.png');
    try{await run('python3',['-c','from PIL import ImageGrab; import sys; ImageGrab.grab(xdisplay=":1").save(sys.argv[1])',shot],{timeout:5000,env:{...process.env,DISPLAY:':1'}});const png=fs.readFileSync(shot);res.writeHead(200,{'content-type':'image/png','cache-control':'no-store','content-length':png.length});return res.end(png)}catch{res.writeHead(503);return res.end()}
  }
  else {res.writeHead(404);res.end()}
};
http.createServer(serveView).listen(4151,'0.0.0.0',()=>console.log('Private computer view ready'));
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
    const payload = JSON.parse(raw);
    const result = await action(payload);
    const browserKinds = new Set(['open','read','text','find','inspect','wait','scroll','click','fill','select','hover','press','back','forward','tabs','newtab','switch','close','screenshot','reset','search','dismiss']);
    if (context && result && typeof result === 'object' && browserKinds.has(String(payload.action || ''))) {
      if (!result.tabs) result.tabs = await tabList(context, page);
      if (lastRecovery && !result.note) result.note = lastRecovery;
      if (isDead(page)) {
        result.failedTab = true;
        result.note = [result.note, 'The focused tab has failed to load. Run tabs, then switch to a live tab before clicking.'].filter(Boolean).join(' ');
      }
    }
    res.end(JSON.stringify(result));
  } catch (error) {
    const body = { error: String(error.message || error).slice(0, 800) };
    if (Array.isArray(error.candidates) && error.candidates.length) body.candidates = error.candidates;
    // An error is exactly when the model most needs to see the page: tabs, refs, overlays and text.
    if (context) {
      try { body.tabs = await tabList(context, page); } catch {}
      try {
        const map = await elementMap(page);
        if (map.elements.length) body.elements = map.elements;
        if (map.overlayList.length) body.overlays = map.overlayList;
        if (!body.candidates) body.candidates = map.elements.slice(0, 15);
        const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 1500)).catch(() => '');
        if (text) body.text = text;
      } catch {}
    }
    body.hint = 'That action failed. The current page is included above. Choose a ref from elements, or dismiss an overlay and retry; do not repeat the same selector unchanged.';
    res.statusCode = 400;
    res.end(JSON.stringify(body));
  }
  finally { busy = false; }
}).listen(4150, '127.0.0.1', () => console.log('Private computer controls ready'));
