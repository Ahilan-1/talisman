import { renderInbox } from './inbox.js';
import { renderCalendar as renderCalendarPage } from './calendar.js';
const app = document.querySelector('#app');
const state = { me: null, profile: null, config: null, computers: [], openai: null, preference: 'automatic', preferenceError: null, tiers: null, tierError: null, oauthError: null, view: 'workspace', selectedTaskId: null };

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
      <button data-view="calendar" class="nav-link ${state.view === 'calendar' ? 'current' : ''}">Calendar</button>
      <button data-view="tasks" class="nav-link ${state.view === 'tasks' ? 'current' : ''}">Inbox</button>
      <button data-view="vault" class="nav-link ${state.view === 'vault' ? 'current' : ''}">Vault</button>
      <button data-view="models" class="nav-link ${state.view === 'models' ? 'current' : ''}">Integrations</button>
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
  state.view='tasks';renderTasks();
}

function renderCalendar(){ return renderCalendarPage({ frame, api, state }); }

function renderCalendarLegacy() {
  frame('Calendar', `<header class="page-header compact-page-header"><div><h1>Calendar</h1><p>Plans you and Talisman can both use.</p></div><button id="add-event" class="round-add" aria-label="Add calendar event" title="Add event">+</button></header><div id="talisman-calendar"></div>
  <div id="event-dialog" class="modal-backdrop" hidden><div class="setup-panel" role="dialog" aria-modal="true" aria-labelledby="event-dialog-title"><button id="close-event" class="dialog-close" aria-label="Close">×</button><h2 id="event-dialog-title">New event</h2><p>Put a plan on your Talisman calendar.</p><form id="event-form" class="stack-form"><label>Title<input name="title" required maxlength="200"></label><label>Starts<input name="start" type="datetime-local" required></label><label>Ends<input name="end" type="datetime-local" required></label><label>Details<textarea name="description" maxlength="2000"></textarea></label><button class="solid-button">Add event</button><p id="calendar-message" role="status"></p></form></div></div>`);
  if(!window.FullCalendar?.Calendar){document.querySelector('#talisman-calendar').textContent='Calendar library could not load.';return;}
  const dialog=document.querySelector('#event-dialog');const show=day=>{dialog.hidden=false;const input=dialog.querySelector('[name="start"]');if(day){const start=new Date(day);start.setHours(9,0,0,0);input.value=`${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}-${String(start.getDate()).padStart(2,'0')}T09:00`;const end=new Date(start.getTime()+60*60_000);dialog.querySelector('[name="end"]').value=`${end.getFullYear()}-${String(end.getMonth()+1).padStart(2,'0')}-${String(end.getDate()).padStart(2,'0')}T10:00`}dialog.querySelector('[name="title"]').focus()};
  document.querySelector('#add-event').onclick=()=>show();document.querySelector('#close-event').onclick=()=>dialog.hidden=true;dialog.onclick=event=>{if(event.target===dialog)dialog.hidden=true};
  const calendar=new window.FullCalendar.Calendar(document.querySelector('#talisman-calendar'),{initialView:'dayGridMonth',height:'auto',dayMaxEvents:true,nowIndicator:true,headerToolbar:{left:'prev,next today',center:'title',right:'dayGridMonth,timeGridWeek,listWeek'},dateClick:info=>show(info.date),events:async(info,success,failure)=>{try{const data=await api(`/calendar/events?from=${encodeURIComponent(info.start.toISOString())}&to=${encodeURIComponent(info.end.toISOString())}`);success(data.events.map(item=>({id:item.id,title:item.title,start:new Date(item.start_at).toISOString(),end:new Date(item.end_at).toISOString(),extendedProps:{description:item.description}})))}catch(error){failure(error)}},eventClick:async(info)=>{if(confirm(`Remove “${info.event.title}” from your calendar?`)){await api(`/calendar/events/${info.event.id}`,{method:'DELETE'});calendar.refetchEvents()}}});
  calendar.render();
  document.querySelector('#event-form').onsubmit=async event=>{event.preventDefault();const form=event.target;try{await api('/calendar/events',{method:'POST',body:JSON.stringify({title:form.elements.title.value,description:form.elements.description.value,start:new Date(form.elements.start.value).toISOString(),end:new Date(form.elements.end.value).toISOString()})});form.reset();dialog.hidden=true;calendar.refetchEvents()}catch(error){document.querySelector('#calendar-message').textContent=error.message}};
}

const shortText = (value, limit=130) => String(value ?? '').replace(/\s+/g,' ').trim().slice(0,limit);
const when = value => new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});

async function renderTasks(selectedId=null) {
  frame('Activity',`<header class="page-header"><h1>Activity</h1><p>Every request has its own record. Talk to Talisman in Telegram.</p></header><div class="activity-shell"><div id="task-list" class="activity-list">Loading…</div><article id="task-detail" class="activity-detail" aria-live="polite"></article></div>`);
  let data;
  try{data=await api('/tasks')}catch(error){document.querySelector('#task-list').textContent=error.message;return}
  const list=document.querySelector('#task-list');
  const jobs=data.jobs||[];
  const recurring=data.recurring||[];
  const selected=selectedId||state.selectedTaskId||jobs[0]?.id||null;
  list.innerHTML=`<div class="inbox-heading"><strong>Tasks</strong><span>${jobs.length}</span></div>`+(jobs.length?jobs.map(task=>`<button class="inbox-item ${task.id===selected?'selected':''}" data-task="${escapeHtml(task.id)}"><span class="inbox-item-top"><strong>${escapeHtml(shortText(task.title,85))}</strong><time>${escapeHtml(when(task.created_at))}</time></span><span class="inbox-item-bottom"><span class="task-status ${escapeHtml(task.status)}">${escapeHtml(task.status)}</span><span class="inbox-preview">${escapeHtml(shortText(task.summary||'Open for progress and details'))}</span></span></button>`).join(''):'<p class="empty-inbox">No tasks yet. Send Talisman a message in Telegram.</p>')+`<div class="inbox-heading recurring-heading"><strong>Repeating tasks</strong><span>${recurring.length}</span></div>`+(recurring.length?recurring.map(task=>`<button class="inbox-item" data-recurring="${escapeHtml(task.id)}"><span class="inbox-item-top"><strong>${escapeHtml(shortText(task.instruction,85))}</strong><time>Next ${escapeHtml(when(task.next_run_at))}</time></span><span class="inbox-item-bottom"><span class="task-status">Recurring</span><span class="inbox-preview">${jobs.filter(job=>job.scheduleId===task.id).length} recent runs</span></span></button>`).join(''):'<p class="empty-inbox">No repeating tasks yet.</p>');
  const detail=document.querySelector('#task-detail');
  async function openJob(id){const task=jobs.find(job=>job.id===id);if(!task)return;state.selectedTaskId=id;list.querySelectorAll('.inbox-item').forEach(el=>el.classList.toggle('selected',el.dataset.task===id));detail.innerHTML='<p class="quiet">Loading task…</p>';try{const receipt=await api(`/tasks/${encodeURIComponent(id)}`);const steps=receipt.steps||[];const events=receipt.events||[];const result=receipt.result||{};detail.innerHTML=`<div class="task-detail-head"><span class="task-status ${escapeHtml(task.status)}">${escapeHtml(task.status)}</span><time>${escapeHtml(when(task.created_at))}</time></div><h2>${escapeHtml(task.title)}</h2><p class="task-meta">${escapeHtml(task.kind==='message'?'Telegram request':task.kind)} · Updated ${escapeHtml(when(task.updated_at))}</p><section class="task-detail-section"><h3>Summary</h3><p>${escapeHtml(task.summary||result.text||result.error||(task.status==='running'?'Talisman is working on this task.':'No summary was recorded.'))}</p></section>${steps.length?`<section class="task-detail-section"><h3>Work log</h3><ol class="task-steps">${steps.map(step=>`<li><span>${escapeHtml(step.summary)}</span><small>${escapeHtml(step.status)}</small></li>`).join('')}</ol></section>`:''}${events.length?`<details class="task-detail-section"><summary>Activity log · ${events.length} updates</summary><ol class="task-events">${events.map(event=>`<li><time>${escapeHtml(when(event.created_at))}</time><span>${escapeHtml(event.detail)}</span></li>`).join('')}</ol></details>`:''}${task.status==='running'?`<section class="task-detail-section"><h3>Live computer</h3>${state.computers[0]?.online?'<div class="viewer"><img id="computer-view" src="/api/computers/view" alt="Live view of the computer working on this task"></div><p class="quiet">View only. Talisman controls this computer.</p>':'<p class="quiet">The computer view is unavailable right now.</p>'}</section>`:''}`;const image=detail.querySelector('#computer-view');if(image){const timer=setInterval(()=>{if(!image.isConnected){clearInterval(timer);return}image.src=`/api/computers/view?t=${Date.now()}`},3000)}}catch(error){detail.textContent=error.message}}
  function openRecurring(id){const task=recurring.find(item=>item.id===id);if(!task)return;state.selectedTaskId=null;list.querySelectorAll('.inbox-item').forEach(el=>el.classList.toggle('selected',el.dataset.recurring===id));const runs=jobs.filter(job=>job.scheduleId===id);detail.innerHTML=`<div class="task-detail-head"><span class="task-status">Recurring</span><time>Next ${escapeHtml(when(task.next_run_at))}</time></div><h2>${escapeHtml(task.instruction)}</h2><p class="task-meta">Repeats every ${escapeHtml(Math.round(task.interval_ms/60000))} minutes · Created ${escapeHtml(when(task.created_at))}</p><section class="task-detail-section"><h3>Recent runs</h3>${runs.length?runs.map(run=>`<button class="run-link" data-run="${escapeHtml(run.id)}">${escapeHtml(when(run.created_at))}<span>${escapeHtml(run.status)} · ${escapeHtml(shortText(run.summary||run.title,100))}</span></button>`).join(''):'<p>No runs recorded yet.</p>'}</section>`;detail.querySelectorAll('[data-run]').forEach(button=>button.onclick=()=>openJob(button.dataset.run))}
  list.querySelectorAll('[data-task]').forEach(button=>button.onclick=()=>openJob(button.dataset.task));list.querySelectorAll('[data-recurring]').forEach(button=>button.onclick=()=>openRecurring(button.dataset.recurring));
  if(selected)await openJob(selected);else detail.innerHTML='<div class="empty-detail">Your task details will appear here.</div>';
  const timer=setInterval(async()=>{if(!list.isConnected){clearInterval(timer);return}try{const fresh=await api('/tasks');if(JSON.stringify(fresh.jobs?.map(job=>[job.id,job.status,job.updated_at]))!==JSON.stringify(jobs.map(job=>[job.id,job.status,job.updated_at]))){clearInterval(timer);renderTasks(state.selectedTaskId)}}catch{}},5000);
}

async function renderVault() {
  frame('Vault',`<header class="page-header compact-page-header"><div><h1>Vault</h1><p>Private logins, available to Talisman when you delegate them.</p></div><button id="add-login" class="round-add" aria-label="Add login" title="Add login">+</button></header><div id="vault-list">Loading…</div>
  <div id="vault-dialog" class="modal-backdrop" hidden><div class="setup-panel" role="dialog" aria-modal="true" aria-labelledby="vault-dialog-title"><button id="close-login" class="dialog-close" aria-label="Close">×</button><h2 id="vault-dialog-title">Save a login</h2><p>Use the exact HTTPS website address.</p><form id="vault-form" class="stack-form" autocomplete="off"><label>Name<input name="label" required maxlength="100"></label><label>Website<input name="origin" type="url" placeholder="https://example.com" required></label><label>Username<input name="username" required maxlength="300"></label><label>Password<input name="password" type="password" required></label><button class="solid-button">Save login</button><p id="vault-message" role="status"></p></form></div></div>`);
  const dialog=document.querySelector('#vault-dialog');document.querySelector('#add-login').onclick=()=>{dialog.hidden=false;dialog.querySelector('[name="label"]').focus()};document.querySelector('#close-login').onclick=()=>dialog.hidden=true;dialog.onclick=event=>{if(event.target===dialog)dialog.hidden=true};
  const reload=async()=>{const data=await api('/vault/logins');document.querySelector('#vault-list').innerHTML=data.logins.length?data.logins.map(item=>`<div class="detail-row"><div class="row-copy"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.username)} · ${escapeHtml(item.origin)}</span></div><button class="outline-button" data-delete-login="${escapeHtml(item.id)}">Remove</button></div>`).join(''):'No logins saved.';document.querySelectorAll('[data-delete-login]').forEach(button=>button.onclick=async()=>{if(!confirm('Remove this saved login?'))return;await api(`/vault/logins/${button.dataset.deleteLogin}`,{method:'DELETE'});reload()})};
  try{await reload()}catch(error){document.querySelector('#vault-list').textContent=error.message}
  document.querySelector('#vault-form').onsubmit=async event=>{event.preventDefault();const form=event.target;try{await api('/vault/logins',{method:'POST',body:JSON.stringify({label:form.elements.label.value,origin:form.elements.origin.value,username:form.elements.username.value,password:form.elements.password.value})});form.reset();dialog.hidden=true;document.querySelector('#vault-message').textContent='';await reload()}catch(error){document.querySelector('#vault-message').textContent=error.message}};
}

function renderPreferences() {
  frame('Preferences', `<header class="page-header"><h1>Preferences</h1><p>Your account and connection</p></header>
    ${section('Account', '', `<div class="detail-row"><span class="row-icon telegram-icon">✈</span><div class="row-copy"><strong>${escapeHtml(state.me.displayName)}</strong><span>Connected through Telegram</span></div></div>`)}
    ${section('Pair another browser', 'You control which browser can open your workspace.', `<p class="body-copy">Send <code>/start</code> to Talisman in Telegram, then enter its single-use code on the other browser.</p>`)}`);
}

function renderModels() {
  const error = state.oauthError;
  frame('Integrations', `<header class="page-header"><h1>Integrations</h1><p>Choose how Talisman thinks. Your conversation stays in Telegram.</p></header>
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
  if (state.view === 'tasks') return renderInbox({frame,api,state});
  if (state.view === 'vault') return renderVault();
  if (state.view === 'preferences') return renderPreferences();
  if (state.view === 'models') return renderModels();
  renderWorkspace();
}

refresh();
setInterval(async () => { if (state.me) { try { const before = JSON.stringify(state.computers); state.computers = await api('/computers'); if (JSON.stringify(state.computers) !== before) render(); } catch {} } }, 10_000);
