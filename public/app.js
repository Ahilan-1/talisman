const app = document.querySelector('#app');
const state = { me: null, profile: null, config: null, computers: [], openai: null, preference: 'automatic', preferenceError: null, tiers: null, tierError: null, oauthError: null, view: 'workspace' };

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
    state.profile = await api('/account/profile');
    state.computers = await api('/computers');
    state.openai = await api('/openai/status');
    state.preference = (await api('/models/preference')).mode;
    if (state.openai.connected) { try { state.tiers = await api('/openai/tiers'); state.tierError = null; } catch (error) { state.tiers = null; state.tierError = error.message; } }
    const oauthReturn = new URLSearchParams(location.search);
    if (oauthReturn.has('openai')) { state.view = 'models'; state.oauthError = oauthReturn.get('openai') === 'error' ? oauthReturn.get('detail') || 'Sign-in failed' : null; history.replaceState(null, '', '/'); }
    render();
    if(!state.profile.complete)showCredentialSetup();
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
        <button class="text-action" id="show-login">Already linked? Sign in <span>→</span></button>
      </div>
    </div>
  </main>`;
  document.querySelector('#show-pair').onclick = renderPair;
  document.querySelector('#show-login').onclick = renderLogin;
}

function renderLogin(){
  app.innerHTML=`<main class="pair-page"><div class="pair-panel"><button class="back-link" id="back">← Back</button><div class="wordmark">Talisman</div><h1>Welcome back.</h1><p>Sign in to the account you created after connecting Telegram.</p><form id="login-form" class="stack-form"><label>Username or email<input name="identity" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><p id="login-error" role="status"></p><button class="solid-button">Sign in →</button></form></div></main>`;
  document.querySelector('#back').onclick=renderWelcome;
  document.querySelector('#login-form').onsubmit=async event=>{event.preventDefault();try{await api('/login',{method:'POST',body:JSON.stringify({identity:event.target.elements.identity.value,password:event.target.elements.password.value})});await refresh()}catch(error){document.querySelector('#login-error').textContent=error.message}};
}

function showCredentialSetup(){
  if(document.querySelector('#account-setup'))return;
  const modal=document.createElement('div');modal.id='account-setup';modal.className='modal-backdrop';modal.innerHTML=`<div class="setup-panel" role="dialog" aria-modal="true" aria-labelledby="setup-title"><div class="wordmark">Talisman</div><h2 id="setup-title">Finish your account</h2><p>Telegram is connected. Create website sign-in details for this account.</p><form id="setup-form" class="stack-form"><label>Username<input name="username" autocomplete="username" minlength="3" maxlength="32" required></label><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="new-password" minlength="12" required></label><p id="setup-error" role="status"></p><button class="solid-button">Create account</button></form></div>`;app.append(modal);
  modal.querySelector('#setup-form').onsubmit=async event=>{event.preventDefault();try{const form=event.target;await api('/account/setup',{method:'POST',body:JSON.stringify({username:form.elements.username.value,email:form.elements.email.value,password:form.elements.password.value})});state.profile=await api('/account/profile');modal.remove()}catch(error){modal.querySelector('#setup-error').textContent=error.message}};
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
      <button data-view="calendar" class="nav-link ${state.view === 'calendar' ? 'current' : ''}">Calendar</button>
      <button data-view="tasks" class="nav-link ${state.view === 'tasks' ? 'current' : ''}">Activity</button>
      <button data-view="vault" class="nav-link ${state.view === 'vault' ? 'current' : ''}">Vault</button>
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
    ${section('Live computer', 'View only. Talisman controls this desktop.', computer?.online ? '<div class="viewer"><img id="computer-view" src="/api/computers/view" alt="Live view of your assigned computer"></div><p class="quiet">Refreshes every few seconds. Controls stay with Talisman.</p>' : '<p class="body-copy">The live view appears when your computer is online.</p>')}`);
  const image=document.querySelector('#computer-view');
  if(image){const timer=setInterval(()=>{if(!image.isConnected){clearInterval(timer);return}image.src=`/api/computers/view?t=${Date.now()}`},3000);image.onerror=()=>{image.alt='Computer image temporarily unavailable'}}
}

function renderCalendar() {
  frame('Calendar', `<header class="page-header"><h1>Calendar</h1><p>Plans you and Talisman can both use.</p></header><div id="talisman-calendar"></div>
  ${section('Add an event','Keep your plans in one place.',`<form id="event-form" class="stack-form"><label>Title<input name="title" required maxlength="200"></label><label>Starts<input name="start" type="datetime-local" required></label><label>Ends<input name="end" type="datetime-local" required></label><label>Details<textarea name="description" maxlength="2000"></textarea></label><button class="solid-button">Add event</button><p id="calendar-message" role="status"></p></form>`)}`);
  if(!window.FullCalendar?.Calendar){document.querySelector('#talisman-calendar').textContent='Calendar library could not load.';return;}
  const calendar=new window.FullCalendar.Calendar(document.querySelector('#talisman-calendar'),{initialView:'dayGridMonth',height:'auto',headerToolbar:{left:'prev,next today',center:'title',right:'dayGridMonth,timeGridWeek,listWeek'},events:async(info,success,failure)=>{try{const data=await api(`/calendar/events?from=${encodeURIComponent(info.start.toISOString())}&to=${encodeURIComponent(info.end.toISOString())}`);success(data.events.map(item=>({id:item.id,title:item.title,start:new Date(item.start_at).toISOString(),end:new Date(item.end_at).toISOString(),extendedProps:{description:item.description}})))}catch(error){failure(error)}},eventClick:async(info)=>{if(confirm(`Remove “${info.event.title}” from your calendar?`)){await api(`/calendar/events/${info.event.id}`,{method:'DELETE'});calendar.refetchEvents()}}});
  calendar.render();
  document.querySelector('#event-form').onsubmit=async event=>{event.preventDefault();const form=event.target;try{await api('/calendar/events',{method:'POST',body:JSON.stringify({title:form.elements.title.value,description:form.elements.description.value,start:new Date(form.elements.start.value).toISOString(),end:new Date(form.elements.end.value).toISOString()})});form.reset();calendar.refetchEvents();document.querySelector('#calendar-message').textContent='Event added.'}catch(error){document.querySelector('#calendar-message').textContent=error.message}};
}

async function renderTasks() {
  frame('Activity',`<header class="page-header"><h1>Activity</h1><p>What Talisman has done and what is still running.</p></header><div id="task-list">Loading…</div>`);
  try{const tasks=await api('/tasks');document.querySelector('#task-list').innerHTML=tasks.length?tasks.map(t=>`<button class="activity-row" data-task="${escapeHtml(t.id)}"><strong>${escapeHtml(t.kind)}</strong><span>${escapeHtml(t.status)} · ${new Date(t.created_at).toLocaleString()}</span></button>`).join(''):'No tasks yet.';document.querySelectorAll('[data-task]').forEach(button=>button.onclick=async()=>{const receipt=await api(`/tasks/${button.dataset.task}`);const details=receipt.steps.map(s=>`${s.ordinal+1}. ${s.summary} — ${s.status}`).join('\n');alert(`${receipt.status}\n${details||'No recorded computer steps.'}`)})}catch(error){document.querySelector('#task-list').textContent=error.message}
}

async function renderVault() {
  frame('Vault',`<header class="page-header"><h1>Vault</h1><p>Private website logins. Passwords are encrypted at rest and never shown in the list.</p></header><div id="vault-list">Loading…</div>
  ${section('Save a login','Use the exact HTTPS site address.',`<form id="vault-form" class="stack-form" autocomplete="off"><label>Name<input name="label" required maxlength="100"></label><label>Website<input name="origin" type="url" placeholder="https://example.com" required></label><label>Username<input name="username" required maxlength="300"></label><label>Password<input name="password" type="password" required></label><button class="solid-button">Save login</button><p id="vault-message" role="status"></p></form>`)}`);
  const reload=async()=>{const data=await api('/vault/logins');document.querySelector('#vault-list').innerHTML=data.logins.length?data.logins.map(item=>`<div class="detail-row"><div class="row-copy"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.username)} · ${escapeHtml(item.origin)}</span></div><button class="outline-button" data-delete-login="${escapeHtml(item.id)}">Remove</button></div>`).join(''):'No logins saved.';document.querySelectorAll('[data-delete-login]').forEach(button=>button.onclick=async()=>{if(!confirm('Remove this saved login?'))return;await api(`/vault/logins/${button.dataset.deleteLogin}`,{method:'DELETE'});reload()})};
  try{await reload()}catch(error){document.querySelector('#vault-list').textContent=error.message}
  document.querySelector('#vault-form').onsubmit=async event=>{event.preventDefault();const form=event.target;try{await api('/vault/logins',{method:'POST',body:JSON.stringify({label:form.elements.label.value,origin:form.elements.origin.value,username:form.elements.username.value,password:form.elements.password.value})});form.reset();document.querySelector('#vault-message').textContent='Login saved.';await reload()}catch(error){document.querySelector('#vault-message').textContent=error.message}};
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
  if(state.profile&&!state.profile.complete){renderWorkspace();showCredentialSetup();return}
  if (state.view === 'computers') return renderComputers();
  if (state.view === 'calendar') return renderCalendar();
  if (state.view === 'tasks') return renderTasks();
  if (state.view === 'vault') return renderVault();
  if (state.view === 'preferences') return renderPreferences();
  if (state.view === 'models') return renderModels();
  renderWorkspace();
}

refresh();
setInterval(async () => { if (state.me) { try { const before = JSON.stringify(state.computers); state.computers = await api('/computers'); if (JSON.stringify(state.computers) !== before) render(); } catch {} } }, 10_000);
