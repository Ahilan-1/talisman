// Talisman inbox — thread cards plus a full-screen task inspector.
// 'think' steps are the agent's own plan; questions are what it asked the person.

const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const short = (value, limit = 130) => oneLine(value).slice(0, limit);
const date = value => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const clock = value => new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const statusLabel = status => ({ working: 'Working', waiting: 'Waiting for you', queued: 'Queued', paused: 'Paused', finished: 'Finished', failed: 'Needs attention' }[status] || status || 'New');
const statusOf = thread => thread.status === 'waiting' ? 'waiting' : thread.status === 'working' || thread.status === 'queued' ? 'working' : thread.status === 'paused' ? 'paused' : thread.status === 'failed' ? 'failed' : 'finished';
const statusClass = status => status === 'working' || status === 'queued' ? 'working' : status === 'waiting' ? 'waiting' : status === 'paused' || status === 'failed' ? 'failed' : 'finished';

function formatted(text) {
  const input = String(text ?? '').slice(0, 20000);
  const links = [];
  const protectedText = input.replace(/\[([^\]\n]{1,120})\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    const key = `__TALISMAN_LINK_${links.length}__`;
    links.push(`<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(label)}</a>`);
    return key;
  });
  const inline = value => escape(value)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/__TALISMAN_LINK_(\d+)__/g, (_, index) => links[Number(index)] || '');
  const lines = protectedText.split(/\r?\n/);
  let html = '', items = [];
  const flush = () => { if (items.length) { html += `<ul>${items.map(item => `<li>${inline(item)}</li>`).join('')}</ul>`; items = []; } };
  for (const line of lines) {
    const value = line.trim();
    if (!value) { flush(); continue; }
    if (value.startsWith('- ') || value.startsWith('• ')) { items.push(value.slice(2)); continue; }
    flush();
    if (value.startsWith('### ')) html += `<h4>${inline(value.slice(4))}</h4>`;
    else if (value.startsWith('## ')) html += `<h4>${inline(value.slice(3))}</h4>`;
    else html += `<p>${inline(value)}</p>`;
  }
  flush();
  return html || '<p>No answer recorded yet.</p>';
}

function initials(title) {
  const words = oneLine(title).split(' ').filter(Boolean).slice(0, 2);
  return (words.map(word => word[0]).join('') || 'T').toUpperCase();
}

function thoughtBlock(steps) {
  const thoughts = (steps || []).filter(step => step.kind === 'think');
  if (!thoughts.length) return '';
  const latest = thoughts.at(-1);
  const text = String(latest.output?.thoughts || latest.summary || '').trim();
  const earlier = thoughts.slice(0, -1);
  return `<div class="timeline-thoughts"><span>THINKING</span><p>${escape(text)}</p>${earlier.length ? `<details><summary>Earlier thinking · ${earlier.length}</summary><ol>${earlier.map(item => `<li>${escape(String(item.output?.thoughts || item.summary || '').trim())}</li>`).join('')}</ol></details>` : ''}</div>`;
}

// ---- Activity feed -------------------------------------------------------

const ICON_PATHS = {
  click: '<path d="M5 3.5l5.4 16 2.5-6.1 6.1-2.5z"/>',
  fill: '<rect x="2.5" y="7" width="19" height="10" rx="2.2"/><path d="M6 11h1.4M10 11h1.4M14 11h1.4M18 11h.5"/>',
  open: '<path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M19 14v4.5A1.5 1.5 0 0 1 17.5 20h-12A1.5 1.5 0 0 1 4 18.5v-12A1.5 1.5 0 0 1 5.5 5H10"/>',
  read: '<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v18H7.5A2.5 2.5 0 0 1 5 18.5z"/><path d="M9 7.5h6.5M9 11h6.5M9 14.5h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/>',
  screenshot: '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.6l1.4-2h7l1.4 2h1.6A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.4"/>',
  switch: '<rect x="3" y="5" width="13" height="9" rx="2"/><path d="M3 19h18"/><path d="M19 8.5l2.5 2.5L19 13.5"/>',
  tabs: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M9 3.5h12"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  dismiss: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/>',
  ask: '<path d="M20.5 11.6a8 8 0 0 1-11.8 7.1L4 20l1.4-4.5A8 8 0 1 1 20.5 11.6z"/><path d="M9.5 11.5h.01M12.5 11.5h.01M15.5 11.5h.01"/>',
  press: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7.5 14h9"/>',
  scroll: '<path d="M12 3.5v17"/><path d="M8.5 7.5L12 4l3.5 3.5"/><path d="M8.5 16.5L12 20l3.5-3.5"/>',
  back: '<path d="M10 6l-6 6 6 6"/><path d="M4.5 12H20"/>',
  forward: '<path d="M14 6l6 6-6 6"/><path d="M19.5 12H4"/>',
  wait: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>',
  hover: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21"/>',
  select: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M8.5 10.5l3.5 3.5 3.5-3.5"/>',
  think: '<path d="M12 3.5l1.9 4.7 4.6 1.8-4.6 1.8L12 16.5l-1.9-4.7-4.6-1.8 4.6-1.8z"/><path d="M18.5 15.5l.8 2 1.9.8-1.9.8-.8 2-.8-2-1.9-.8 1.9-.8z"/>',
  error: '<path d="M12 4l8.5 15h-17z"/><path d="M12 9.5v4M12 16.6h.01"/>',
  check: '<path d="M4.5 12.5l4.5 4.5 10-10"/>',
  default: '<path d="M8 6.5L3.5 12 8 17.5M16 6.5L20.5 12 16 17.5"/>',
};
const ICON_FOR = { click: 'click', fill: 'fill', select: 'select', press: 'press', open: 'open', newtab: 'open', read: 'read', text: 'read', extract: 'read', find: 'search', search: 'search', screenshot: 'screenshot', switch: 'switch', tabs: 'tabs', close: 'close', dismiss: 'dismiss', ask: 'ask', scroll: 'scroll', back: 'back', forward: 'forward', wait: 'wait', hover: 'hover', finish: 'check', error: 'error' };
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ICON_PATHS.default}</svg>`;
const hostFrom = value => { try { return new URL(String(value || '')).hostname.replace(/^www\./, ''); } catch { return ''; } };

function relativeTime(value) {
  const stamp = Number(value) || 0;
  if (!stamp) return '';
  const diff = Date.now() - stamp;
  if (diff < 0) return 'now';
  if (diff < 15_000) return 'just now';
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(stamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function activityRow(step) {
  const output = step.output || {};
  const site = hostFrom(output.did?.url || output.url);
  const showSite = site && !String(step.summary || '').includes(site);
  const state = step.status === 'failed' ? 'failed' : step.status === 'running' ? 'running' : 'done';
  const key = ICON_FOR[step.kind] || 'default';
  return `<li class="activity-item ${state}">
    <span class="activity-icon" data-icon="${key}">${icon(key)}</span>
    <span class="activity-text">
      <span class="activity-line">${escape(step.summary || step.kind)}</span>
      <span class="activity-meta">${showSite ? `<span class="activity-site">${escape(site)}</span>` : ''}<time>${escape(relativeTime(step.updated_at))}</time>${state === 'running' ? '<span class="activity-badge live">live</span>' : state === 'failed' ? '<span class="activity-badge fail">failed</span>' : ''}</span>
    </span>
  </li>`;
}

function actionList(steps, { compact = false, live = false } = {}) {
  const actions = (steps || []).filter(step => step.kind !== 'think');
  if (!actions.length) return live ? '<div class="activity-empty"><span class="activity-spinner"></span>Working out the first move…</div>' : '';
  const ordered = compact ? actions.slice(-3).reverse() : [...actions].reverse();
  const failures = actions.filter(step => step.status === 'failed').length;
  return `${compact ? '' : `<div class="activity-head"><span>${actions.length} action${actions.length === 1 ? '' : 's'}${failures ? ` · ${failures} failed` : ''}</span><span>newest first</span></div>`}<ol class="activity${compact ? ' compact' : ''}${live ? ' live' : ''}">${ordered.map(activityRow).join('')}</ol>`;
}

export async function renderInbox({ frame, api, state }) {
  const computer = state.computers?.[0];
  frame('Inbox', `<header class="page-header inbox-page-header">
      <div><span class="eyebrow">YOUR AGENT AT WORK</span><h1>Inbox</h1><p>Every request, decision and result. Open a task to see exactly what Talisman was thinking and doing.</p></div>
      <div style="display:flex;align-items:center;gap:10px"><span class="inbox-live ${computer?.online ? '' : 'offline'}"><i></i>${computer?.online ? 'Computer online' : 'Computer offline'}</span><button class="outline-button" id="inbox-refresh">Refresh</button></div>
    </header>
    <div class="inbox-stats" id="inbox-stats"></div>
    <div class="inbox-toolbar"><div class="inbox-filters" role="tablist" aria-label="Task status"><button data-filter="all" class="active">All <b>0</b></button><button data-filter="working">Working <b>0</b></button><button data-filter="waiting">Waiting <b>0</b></button><button data-filter="finished">Finished <b>0</b></button><button data-filter="recurring">Repeating <b>0</b></button></div>
      <label class="inbox-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg><input id="inbox-search" type="search" placeholder="Search tasks" aria-label="Search tasks"></label></div>
    <div id="task-list" class="thread-list"><div class="empty-inbox">Loading tasks…</div></div>`);

  const list = document.querySelector('#task-list');
  const statsRow = document.querySelector('#inbox-stats');
  let data;
  try { data = await api('/inbox'); }
  catch (error) { list.innerHTML = `<div class="empty-inbox">${escape(error.message)}</div>`; return; }

  let filter = 'all', query = '', viewer = null;

  function counts() {
    const threads = data.threads || [];
    return {
      all: threads.length,
      working: threads.filter(thread => statusOf(thread) === 'working').length,
      waiting: threads.filter(thread => statusOf(thread) === 'waiting').length,
      finished: threads.filter(thread => statusOf(thread) === 'finished').length,
      recurring: (data.recurring || []).length,
    };
  }

  function paintStats() {
    const c = counts();
    statsRow.innerHTML = `
      <div class="inbox-stat working"><span>Working now</span><strong>${c.working}</strong><small>${c.working ? 'Talisman is on it' : 'Nothing running'}</small></div>
      <div class="inbox-stat waiting"><span>Waiting on you</span><strong>${c.waiting}</strong><small>${c.waiting ? 'A reply or decision' : 'Nothing to decide'}</small></div>
      <div class="inbox-stat finished"><span>Finished</span><strong>${c.finished}</strong><small>${c.finished ? 'Results ready' : 'None yet'}</small></div>
      <div class="inbox-stat"><span>Repeating</span><strong>${c.recurring}</strong><small>Scheduled runs</small></div>`;
    document.querySelectorAll('[data-filter]').forEach(button => {
      const badge = button.querySelector('b');
      if (badge) badge.textContent = c[button.dataset.filter] ?? 0;
      button.classList.toggle('active', button.dataset.filter === filter);
    });
  }

  function visibleThreads() {
    const needle = query.toLowerCase();
    return (data.threads || []).filter(thread => {
      const status = statusOf(thread);
      const statusMatch = filter === 'all' || filter === 'recurring' ? filter !== 'recurring' : status === filter;
      const textMatch = !needle || `${thread.title} ${thread.preview || ''}`.toLowerCase().includes(needle);
      return statusMatch && textMatch;
    });
  }

  function visibleRecurring() {
    if (filter !== 'all' && filter !== 'recurring') return [];
    const needle = query.toLowerCase();
    return (data.recurring || []).filter(item => !needle || item.instruction.toLowerCase().includes(needle));
  }

  function threadCard(thread) {
    const status = statusOf(thread);
    const preview = thread.preview || (status === 'working' ? thread.last_step_summary : '') || `${thread.job_count} ${thread.job_count === 1 ? 'request' : 'requests'}`;
    return `<button class="thread-card ${escape(statusClass(status))} ${viewer?.threadId === thread.id ? 'selected' : ''}" data-thread="${escape(thread.id)}">
      <span class="thread-avatar">${escape(initials(thread.title))}</span>
      <span class="thread-main"><strong>${escape(short(thread.title, 120))}</strong><p>${escape(short(preview, 150))}</p></span>
      <span class="thread-side"><span class="task-status ${escape(statusClass(status))}">${escape(statusLabel(status))}</span><time>${escape(clock(thread.updated_at))}</time></span>
    </button>`;
  }

  function paintList() {
    if (!list.isConnected) return;
    const threads = visibleThreads();
    const repeating = visibleRecurring();
    list.innerHTML = (threads.length
      ? threads.map(threadCard).join('')
      : `<div class="empty-inbox">${data.threads?.length ? 'No tasks match this view.' : 'No tasks yet. Message Talisman in Telegram to start one.'}</div>`)
      + (repeating.length ? `<div class="thread-group-label"><span>Repeating</span><span>${repeating.length}</span></div>` + repeating.map(item => `<button class="thread-card" data-repeat="${escape(item.id)}">
          <span class="thread-avatar">↻</span>
          <span class="thread-main"><strong>${escape(short(item.instruction, 120))}</strong><p>Every ${Math.round(item.interval_ms / 60000)} minutes · next ${escape(date(item.next_run_at))}</p></span>
          <span class="thread-side"><span class="task-status recurring">Repeating</span><span class="thread-chevron">›</span></span>
        </button>`).join('') : '');
    list.querySelectorAll('[data-thread]').forEach(button => button.onclick = () => openThread(button.dataset.thread));
    list.querySelectorAll('[data-repeat]').forEach(button => button.onclick = () => openRepeat(button.dataset.repeat));
  }

  // ---- Task inspector ----------------------------------------------------

  function closeViewer() {
    if (!viewer) return;
    clearInterval(viewer.timer);
    viewer.overlay.remove();
    viewer = null;
    document.body.style.overflow = '';
    paintList();
  }

  function openThread(id) {
    closeViewer();
    const overlay = document.createElement('div');
    overlay.className = 'task-viewer';
    overlay.innerHTML = `<div class="task-viewer-panel"><div class="task-viewer-head"><div><span class="task-status">Loading</span><h2>Opening task…</h2></div></div><div class="task-viewer-body"><div class="task-panel">Loading the full record…</div></div></div>`;
    document.body.append(overlay);
    document.body.style.overflow = 'hidden';
    viewer = { threadId: id, overlay, timer: null, signature: '' };
    overlay.onclick = event => { if (event.target === overlay) closeViewer(); };
    paintList();
    loadViewer();
    viewer.timer = setInterval(() => { if (!overlay.isConnected) { clearInterval(viewer.timer); return; } refreshViewer(); }, 3000);
  }

  async function refreshViewer() {
    if (!viewer) return;
    try {
      data = await api('/inbox');
      paintStats();
      paintList();
      const current = (data.threads || []).find(thread => thread.id === viewer.threadId);
      const signature = JSON.stringify(current && [current.status, current.updated_at, current.last_step_at]);
      if (signature !== viewer.signature) loadViewer();
    } catch { /* keep what is on screen */ }
  }

  async function loadViewer() {
    if (!viewer) return;
    let receipt;
    try { receipt = await api(`/inbox/${encodeURIComponent(viewer.threadId)}`); }
    catch (error) { viewer.overlay.querySelector('.task-viewer-body').innerHTML = `<div class="task-panel">${escape(error.message)}</div>`; return; }
    if (!viewer) return;
    const thread = receipt.thread || {};
    const jobs = receipt.jobs || [];
    const approvals = receipt.approvals || [];
    const questions = receipt.questions || [];
    const current = (data.threads || []).find(item => item.id === viewer.threadId) || {};
    const status = statusOf(current);
    viewer.signature = JSON.stringify([current.status, current.updated_at, current.last_step_at]);

    const last = jobs.at(-1);
    const answer = [...jobs].reverse().find(job => job.result?.text)?.result?.text;
    const latestThought = [...jobs].reverse().flatMap(job => (job.steps || []).filter(step => step.kind === 'think')).map(step => step.output?.thoughts || step.summary).find(Boolean);
    const running = jobs.some(job => job.status === 'running');
    const liveJob = [...jobs].reverse().find(job => job.status === 'running');
    const pending = questions.filter(item => item.status === 'pending');
    const finishedCount = jobs.filter(job => job.status === 'done').length;

    viewer.overlay.querySelector('.task-viewer-head').innerHTML = `
      <div>
        <span class="task-status ${escape(statusClass(status))}">${escape(statusLabel(status))}</span>
        <h2>${escape(thread.title || current.title || 'Task')}</h2>
        <p>${jobs.length} ${jobs.length === 1 ? 'request' : 'requests'} · started ${escape(date(thread.created_at || current.created_at))} · updated ${escape(date(thread.updated_at || current.updated_at))}</p>
      </div>
      <div class="task-viewer-actions"><button class="outline-button" data-refresh>Refresh</button><button class="icon-button" data-close aria-label="Close task">×</button></div>`;
    viewer.overlay.querySelector('[data-close]').onclick = closeViewer;
    viewer.overlay.querySelector('[data-refresh]').onclick = loadViewer;

    const body = viewer.overlay.querySelector('.task-viewer-body');
    const scroll = body.scrollTop;
    body.innerHTML = `
      <div class="task-col">
        <section class="task-panel">
          <h3>${status === 'working' ? 'Current progress' : 'Answer'}${status === 'working' ? '<span>live</span>' : ''}</h3>
          ${status === 'working' && latestThought ? `<div class="now-strip"><i></i><span>${escape(latestThought)}</span></div>` : ''}
          ${status === 'working' ? `<div class="now-activity"><div class="now-activity-head"><span class="activity-spinner"></span>Talisman is doing</div>${actionList(liveJob?.steps, { compact: true, live: true }) || '<div class="activity-empty"><span class="activity-spinner"></span>Getting started…</div>'}</div>` : ''}
          <div class="task-answer">${formatted(answer || last?.result?.error || (status === 'working' ? 'Talisman is working on this request. Its thinking appears below as it goes.' : 'No answer recorded yet.'))}</div>
        </section>
        ${pending.length ? `<section class="task-panel"><h3>Waiting for your reply <span>${pending.length}</span></h3>${pending.map(item => `<div class="approval" style="background:var(--accent-soft);border-color:#d8e2ff;color:#2c3f66">${escape(item.prompt)}<small style="color:#5a6f97">Answer in Telegram · expires ${escape(clock(item.expires_at))}</small></div>`).join('')}</section>` : ''}
        <section class="task-panel">
          <h3>Request history <span>${jobs.length}</span></h3>
          ${jobs.length ? jobs.map(job => `<div class="timeline-entry">
            <div class="timeline-meta"><span>${job.kind === 'message' ? 'You · Telegram' : escape(job.kind)}</span><time>${escape(date(job.created_at))}</time></div>
            <div class="timeline-request">${escape(job.request)}</div>
            ${thoughtBlock(job.steps)}
            ${actionList(job.steps)}
            ${job.result?.text ? `<div class="timeline-answer"><span>TALISMAN</span><div class="task-answer">${formatted(job.result.text)}</div></div>` : ''}
            ${job.result?.error ? `<p class="task-error">${escape(job.result.error)}</p>` : ''}
            ${(job.events || []).length ? `<details class="timeline-steps"><summary>Activity log · ${job.events.length} events</summary><ul class="task-steps-list">${job.events.map(event => `<li><strong>${escape(clock(event.created_at))}</strong> · ${escape(event.detail)}</li>`).join('')}</ul></details>` : ''}
          </div>`).join('') : '<p class="quiet">No requests in this task yet.</p>'}
        </section>
      </div>
      <div class="task-col">
        <section class="task-panel">
          <h3>Details</h3>
          <dl class="meta-list">
            <div><dt>Status</dt><dd>${escape(statusLabel(status))}</dd></div>
            <div><dt>Requests</dt><dd>${jobs.length}</dd></div>
            <div><dt>Finished</dt><dd>${finishedCount}</dd></div>
            <div><dt>Last activity</dt><dd>${escape(clock(thread.updated_at || current.updated_at || Date.now()))}</dd></div>
          </dl>
        </section>
        ${approvals.length ? `<section class="task-panel"><h3>Decisions</h3>${approvals.map(item => `<div class="approval">${escape(item.summary)}<small>${escape(item.status)} · expires ${escape(clock(item.expires_at))}</small></div>`).join('')}</section>` : ''}
        <section class="task-panel">
          <h3>Live computer ${running ? '<span>working now</span>' : ''}</h3>
          <div class="viewer"><div class="viewer-placeholder" id="viewer-message">Connecting to the computer…</div><img id="computer-view" alt="Live view of the computer" hidden></div>
          <p class="quiet" style="margin:10px 0 0">View only. Talisman controls this computer.</p>
        </section>
      </div>`;
    body.scrollTop = scroll;
    attachViewer(viewer.overlay);
  }

  function openRepeat(id) {
    closeViewer();
    const item = (data.recurring || []).find(row => row.id === id);
    if (!item) return;
    const overlay = document.createElement('div');
    overlay.className = 'task-viewer';
    document.body.append(overlay);
    document.body.style.overflow = 'hidden';
    viewer = { threadId: id, overlay, timer: null, signature: '' };
    overlay.onclick = event => { if (event.target === overlay) closeViewer(); };
    const runs = (data.threads || []).filter(thread => thread.title === item.instruction || thread.title === `Scheduled task: ${item.instruction}`);
    overlay.innerHTML = `<div class="task-viewer-panel">
      <div class="task-viewer-head"><div><span class="task-status recurring">Repeating</span><h2>${escape(item.instruction)}</h2><p>Every ${Math.round(item.interval_ms / 60000)} minutes · next run ${escape(date(item.next_run_at))}</p></div><div class="task-viewer-actions"><button class="icon-button" data-close aria-label="Close">×</button></div></div>
      <div class="task-viewer-body"><div class="task-col"><section class="task-panel"><h3>Recent runs <span>${runs.length}</span></h3>${runs.length ? runs.map(run => `<button class="list-event" data-run="${escape(run.id)}" style="width:100%"><strong>${escape(short(run.title, 70))}</strong><time>${escape(date(run.updated_at))}</time></button>`).join('') : '<p class="quiet">Runs will appear here after the first one finishes.</p>'}</section></div></div>
    </div>`;
    overlay.querySelector('[data-close]').onclick = closeViewer;
    overlay.querySelectorAll('[data-run]').forEach(button => button.onclick = () => openThread(button.dataset.run));
    paintList();
  }

  // ---- Wiring ------------------------------------------------------------

  paintStats();
  paintList();

  document.querySelectorAll('[data-filter]').forEach(button => button.onclick = () => {
    filter = button.dataset.filter;
    paintStats();
    paintList();
  });
  document.querySelector('#inbox-search').oninput = event => { query = event.target.value.trim(); paintList(); };
  document.querySelector('#inbox-refresh').onclick = async () => {
    try { data = await api('/inbox'); paintStats(); paintList(); if (viewer) loadViewer(); } catch { /* ignore */ }
  };
  document.addEventListener('keydown', function onKey(event) {
    const search = document.querySelector('#inbox-search');
    if (!search?.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (event.key === 'Escape') closeViewer();
  });

  const poll = setInterval(async () => {
    if (!list.isConnected) { clearInterval(poll); return; }
    try {
      const fresh = await api('/inbox');
      const before = JSON.stringify((data.threads || []).map(item => [item.id, item.status, item.last_step_at, item.preview]));
      const after = JSON.stringify((fresh.threads || []).map(item => [item.id, item.status, item.last_step_at, item.preview]));
      if (before !== after) { data = fresh; paintStats(); paintList(); }
    } catch { /* ignore */ }
  }, 5000);
}

function attachViewer(detail) {
  const image = detail.querySelector('#computer-view');
  const message = detail.querySelector('#viewer-message');
  if (!image) return;
  image.onload = () => { image.hidden = false; message.hidden = true; };
  image.onerror = () => { image.hidden = true; message.hidden = false; message.textContent = 'Computer view is unavailable. Retrying…'; };
  const update = () => { if (!image.isConnected) return false; image.src = `/api/computers/view?t=${Date.now()}`; return true; };
  update();
  const timer = setInterval(() => { if (!update()) clearInterval(timer); }, 4000);
}
