const app = document.querySelector('#app');
const state = { me: null, config: null, computers: [], openai: null, preference: 'automatic', preferenceError: null, tiers: null, tierError: null, oauthError: null, view: 'workspace' };

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

async function api(route, options = {}) {
  const response = await fetch(`/api${route}`, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...options.headers },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function botUrl() {
  return state.config?.telegramBotUsername ? `https://t.me/${encodeURIComponent(state.config.telegramBotUsername)}` : null;
}

async function refresh() {
  state.config = await api('/config');
  try {
    state.me = await api('/me');
    state.computers = await api('/computers');
    state.openai = await api('/openai/status');
    state.preference = (await api('/models/preference')).mode;
    if (state.openai.connected) { try { state.tiers = await api('/openai/tiers'); state.tierError = null; } catch (error) { state.tiers = null; state.tierError = error.message; } }
    const oauthReturn = new URLSearchParams(location.search);
    if (oauthReturn.has('openai')) { state.view = 'models'; state.oauthError = oauthReturn.get('openai') === 'error' ? oauthReturn.get('detail') || 'Sign-in failed' : null; history.replaceState(null, '', '/'); }
    render();
  } catch {
    state.me = null;
    renderWelcome();
  }
}

function renderWelcome() {
  const url = botUrl();
  app.innerHTML = `<main class="welcome">
    <div class="welcome-mark" aria-hidden="true">✳ <span>Talisman.</span></div>
    <div class="welcome-copy">
      <div class="eyebrow">ONE PERSON · ONE AGENT · ONE COMPUTER</div>
      <h1>Just message.<br><em>It gets done.</em></h1>
      <p>Talisman lives in Telegram and works from a computer of its own. Ask for help with the details, then carry on with your day.</p>
      <p>Send <code>/start</code> to connect your dashboard with a unique code.</p>
      <div class="welcome-actions">
        ${url ? `<a class="solid-button" href="${url}" target="_blank" rel="noopener">Start in Telegram <span>↗</span></a>` : '<span class="quiet">Telegram bot is not connected yet.</span>'}
        <button class="text-action" id="show-pair">I have a pairing code <span>→</span></button>
      </div>
    </div>
  </main>`;
  document.querySelector('#show-pair').onclick = renderPair;
}

function renderPair() {
  app.innerHTML = `<main class="pair-page"><div class="pair-panel">
    <button class="back-link" id="back">← Back</button><div class="wordmark">Talisman</div>
    <h1>Your agent knows it’s you.</h1>
    <p>Send <code>/start</code> to Talisman in Telegram. Enter the unique code it displays to link this browser to your account.</p>
    ${botUrl() ? `<p><a href="${botUrl()}" target="_blank" rel="noopener">Open Telegram ↗</a></p>` : ''}
    <form id="pair-form"><label for="code">Pairing code</label><input id="code" name="code" maxlength="12" pattern="[A-Fa-f0-9]{12}" autocomplete="one-time-code" placeholder="12-character code" required><div class="form-error" id="pair-error" role="status" aria-live="polite"></div><button class="solid-button" type="submit">Open workspace →</button></form>
  </div></main>`;
  document.querySelector('#back').onclick = () => state.me ? render() : renderWelcome();
  document.querySelector('#pair-form').onsubmit = async event => {
    event.preventDefault();
    const code = event.target.elements.code.value.trim();
    try { await api('/pair', { method: 'POST', body: JSON.stringify({ code }) }); await refresh(); }
    catch (error) { document.querySelector('#pair-error').textContent = error.message; }
  };
}

function frame(title, content) {
  app.innerHTML = `<div class="dashboard"><aside class="sidebar">
    <div class="wordmark">Talisman</div>
    <nav aria-label="Main navigation">
      <button data-view="workspace" class="nav-link ${state.view === 'workspace' ? 'current' : ''}">Workspace</button>
      <button data-view="computers" class="nav-link ${state.view === 'computers' ? 'current' : ''}">Agent workspace</button>
      <button data-view="models" class="nav-link ${state.view === 'models' ? 'current' : ''}">Models</button>
      <button data-view="preferences" class="nav-link ${state.view === 'preferences' ? 'current' : ''}">Preferences</button>
    </nav>
    <div class="sidebar-foot"><button id="logout" class="nav-link">Log out</button><div class="identity">${escapeHtml(state.me.displayName)}</div><div class="identity-sub">Telegram connected</div></div>
  </aside><main class="dashboard-main"><div class="page-content">${content}</div></main></div>`;
  document.querySelectorAll('[data-view]').forEach(button => { if (state.view === button.dataset.view) button.setAttribute('aria-current', 'page'); button.onclick = () => { state.view = button.dataset.view; render(); }; });
  document.querySelector('#logout').onclick = async () => { await api('/logout', { method: 'POST' }); state.me = null; renderWelcome(); };
}

function section(title, subtitle, inner) {
  return `<section class="section"><div class="section-title"><h2>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}</div><div class="section-body">${inner}</div></section>`;
}

function computerStatus(computer) {
  if (!state.me?.telegramConnected) return 'Link Telegram to start your computer';
  if (!computer) return 'Waiting for your first Telegram message';
  if (computer.online) return 'Online';
  if (computer.provisioning === 'failed') return 'Setup needs attention';
  if (computer.provisioning === 'pending' || computer.provisioning === 'starting') return 'Preparing';
  return 'Offline';
}

function renderWorkspace() {
  const computer = state.computers[0];
  const url = botUrl();
  frame('Workspace', `<header class="page-header"><h1>Workspace</h1><p>Your agent, computer, and ways to reach it</p></header>
    ${section('Your agent', 'One conversation, in Telegram.', `<div class="intro-block"><p>${state.me.telegramConnected ? 'A little less to carry. Talisman works from a computer dedicated to your account, while your conversation stays in Telegram.' : 'This workspace was created before Telegram onboarding. Send /start to the bot, then connect its code here to bring your account and computer together.'}</p><div class="inline-actions">${url ? `<a class="solid-button" href="${url}" target="_blank" rel="noopener">${state.me.telegramConnected ? 'Continue in Telegram ↗' : 'Open Telegram ↗'}</a>` : ''}${!state.me.telegramConnected ? '<button class="outline-button" id="link-telegram">Enter pairing code →</button>' : ''}</div></div>`)}
    ${section('Agent workspace', 'A private runtime for Talisman.', `<div class="detail-row"><span class="row-icon">▣</span><div class="row-copy"><strong>${escapeHtml(computer?.name || 'Agent computer')}</strong><span>${escapeHtml(computerStatus(computer))}</span></div><span class="status-dot ${computer?.online ? 'live' : ''}"></span></div>${computer?.provisioning === 'failed' ? `<p class="warning">${escapeHtml(computer.provisionError || 'Provisioning failed')}</p>` : ''}`)}
    ${section('Contact', 'Ways to reach Talisman directly.', `<div class="detail-row"><span class="row-icon telegram-icon">✈</span><div class="row-copy"><strong>Telegram</strong><span>${escapeHtml(state.me.displayName)}</span></div>${url ? `<a class="row-action" href="${url}" target="_blank" rel="noopener">Open ↗</a>` : '<span class="quiet">Unavailable</span>'}</div>`)}
    ${section('What Talisman can do', 'Message the bot to start.', `<div class="detail-row"><span class="row-icon">↗</span><div class="row-copy"><strong>Tasks and follow-ups</strong><span>Ask in Telegram, set reminders, and schedule recurring check-ins.</span></div></div>`)}
    <footer class="page-footer">One account · One agent · One computer</footer>`);
  const link = document.querySelector('#link-telegram');
  if (link) link.onclick = renderPair;
}

function renderComputers() {
  const computer = state.computers[0];
  frame('Agent workspace', `<header class="page-header"><h1>Agent workspace</h1><p>The computer is for Talisman to operate on your behalf.</p></header>
    ${section('Assigned runtime', 'Created automatically from your first private Telegram message.', `<div class="detail-row"><span class="row-icon">▣</span><div class="row-copy"><strong>${escapeHtml(computer?.name || 'No computer yet')}</strong><span>${escapeHtml(computerStatus(computer))}</span></div><span class="status-dot ${computer?.online ? 'live' : ''}"></span></div>${computer?.provisioning === 'failed' ? `<p class="warning">${escapeHtml(computer.provisionError || 'Provisioning failed')}</p>` : ''}`)}
    ${section('How it works', '', '<p class="body-copy">Talisman operates this computer privately. Your Telegram account owns the agent; the dashboard shows its status and connection only.</p>')}`);
}

function renderPreferences() {
  frame('Preferences', `<header class="page-header"><h1>Preferences</h1><p>Your account and connection</p></header>
    ${section('Account', '', `<div class="detail-row"><span class="row-icon telegram-icon">✈</span><div class="row-copy"><strong>${escapeHtml(state.me.displayName)}</strong><span>Connected through Telegram</span></div></div>`)}
    ${section('Pair another browser', 'You control which browser can open your workspace.', `<p class="body-copy">Send <code>/start</code> to Talisman in Telegram, then enter its single-use code on the other browser.</p>`)}`);
}

function renderModels() {
  const error = state.oauthError;
  frame('Models', `<header class="page-header"><h1>Models</h1><p>Connect your account and let Talisman choose the right capacity for each task.</p></header>
    ${section('OpenAI account', 'Local sign-in for eligible ChatGPT plans.', `<div class="model-connection"><div class="row-copy"><strong>${state.openai?.connected ? 'Connected' : 'Not connected'}</strong><span>${escapeHtml(state.openai?.email || 'Continue with ChatGPT to authorize this account.')}</span></div>${state.openai?.connected ? '<button class="outline-button" id="disconnect-openai">Disconnect</button>' : '<a class="solid-button" id="connect-openai" data-oai-siwc-button href="/api/openai/start">Continue with ChatGPT ↗</a>'}</div>${error ? `<p class="warning">${escapeHtml(error)}</p>` : ''}`)}
    ${section('Choose how Talisman replies', 'This choice belongs to your account and applies to Telegram.', `<div class="model-options">
      <button class="model-option ${state.preference === 'automatic' ? 'selected' : ''}" data-mode="automatic"><strong>Automatic</strong><span>OpenAI for quick replies; free models for computer tasks.</span></button>
      <button class="model-option ${state.preference === 'free' ? 'selected' : ''}" data-mode="free"><strong>Free models</strong><span>Use only zero-cost models in your private OpenCode computer. Provider limits still apply.</span></button>
      <button class="model-option ${state.preference === 'openai' ? 'selected' : ''}" data-mode="openai" ${state.openai?.connected ? '' : 'disabled'}><strong>OpenAI</strong><span>Use your connected account for replies and tasks in your assigned computer.</span></button>
    </div>${state.preferenceError ? `<p class="warning">${escapeHtml(state.preferenceError)}</p>` : ''}`)}
    ${section('Automatic selection', 'Your conversation stays in Telegram.', `<div class="detail-row"><span class="row-icon">↗</span><div class="row-copy"><strong>Economical by default</strong><span>Everyday answers use the lightest eligible account model. Longer reasoning tasks can move to a balanced tier. Premium tiers are excluded.</span></div><span class="row-action">${state.tiers ? state.tiers.economical ? 'Available' : 'Unavailable' : '—'}</span></div><div class="detail-row"><span class="row-icon">◇</span><div class="row-copy"><strong>Balanced capacity</strong><span>Used for longer or more involved reasoning.</span></div><span class="row-action">${state.tiers ? state.tiers.balanced ? 'Available' : 'Unavailable' : '—'}</span></div><div class="detail-row"><span class="row-icon">▣</span><div class="row-copy"><strong>Computer tasks</strong><span>Talisman keeps its separate computer runtime for browser and app actions.</span></div></div>${state.tierError ? `<p class="warning">Model access check: ${escapeHtml(state.tierError)}</p>` : ''}`)}`);
  document.querySelectorAll('[data-mode]').forEach(button => button.onclick = async () => { try { const result = await api('/models/preference', { method: 'POST', body: JSON.stringify({ mode: button.dataset.mode }) }); state.preference = result.mode; state.preferenceError = null; renderModels(); } catch (error) { state.preferenceError = error.message; renderModels(); } });
  const disconnect = document.querySelector('#disconnect-openai');
  if (disconnect) disconnect.onclick = async () => { if (!confirm('Disconnect OpenAI from this Talisman account?')) return; await api('/openai/disconnect', { method: 'POST' }); state.openai = await api('/openai/status'); state.preference = (await api('/models/preference')).mode; state.tiers = null; state.tierError = null; renderModels(); };
}

function render() {
  if (!state.me) return renderWelcome();
  if (state.view === 'computers') return renderComputers();
  if (state.view === 'preferences') return renderPreferences();
  if (state.view === 'models') return renderModels();
  renderWorkspace();
}

refresh();
setInterval(async () => { if (state.me) { try { const before = JSON.stringify(state.computers); state.computers = await api('/computers'); if (JSON.stringify(state.computers) !== before) render(); } catch {} } }, 10_000);
