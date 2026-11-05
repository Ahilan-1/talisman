// Talisman calendar — our own month/week/list views, styled with the dashboard.
// No external calendar bundle: it only needs the account API and the shared classes.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const dayStart = date => { const copy = new Date(date); copy.setHours(0, 0, 0, 0); return copy; };
const addDays = (date, days) => { const copy = new Date(date); copy.setDate(copy.getDate() + days); return copy; };
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const startOfWeek = date => addDays(dayStart(date), -dayStart(date).getDay());
const ymd = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const hhmm = date => date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const tone = title => [...String(title || '')].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 4;
const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const short = (value, limit = 120) => oneLine(value).slice(0, limit);

function monthGrid(cursor) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

export async function renderCalendar({ frame, api, state }) {
  frame('Calendar', `<header class="page-header compact-page-header"><div><span class="eyebrow">TIME YOU SHARE</span><h1>Calendar</h1><p>Plans you and Talisman can both use. Click a day to add one.</p></div><button id="add-event" class="round-add" aria-label="Add calendar event" title="Add event">+</button></header>
    <div id="talisman-calendar" class="calendar-shell"><div class="calendar-empty">Loading your calendar…</div></div>
    <div id="event-dialog" class="modal-backdrop" hidden><div class="setup-panel" role="dialog" aria-modal="true" aria-labelledby="event-dialog-title"><button id="close-event" class="dialog-close" aria-label="Close">×</button><h2 id="event-dialog-title">New event</h2><p>Put a plan on your Talisman calendar.</p><form id="event-form" class="stack-form"><label>Title<input name="title" required maxlength="200" placeholder="Dinner with Priya"></label><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><label>Starts<input name="start" type="datetime-local" required></label><label>Ends<input name="end" type="datetime-local" required></label></div><label>Details<textarea name="description" maxlength="2000" placeholder="Anything Talisman should know"></textarea></label><button class="solid-button" type="submit">Add event</button><p id="calendar-message" class="quiet" role="status"></p></form></div></div>`);

  const root = document.querySelector('#talisman-calendar');
  const dialog = document.querySelector('#event-dialog');
  const form = document.querySelector('#event-form');
  const message = document.querySelector('#calendar-message');

  const today = dayStart(new Date());
  const view = { mode: 'month', cursor: new Date(today.getFullYear(), today.getMonth(), 1), events: [], loaded: false };

  function range() {
    if (view.mode === 'month') {
      const cells = monthGrid(view.cursor);
      return { from: dayStart(cells[0]), to: addDays(dayStart(cells[41]), 1) };
    }
    if (view.mode === 'week') {
      const start = startOfWeek(view.cursor);
      return { from: start, to: addDays(start, 7) };
    }
    const start = new Date(view.cursor.getFullYear(), view.cursor.getMonth(), 1);
    return { from: start, to: new Date(view.cursor.getFullYear(), view.cursor.getMonth() + 1, 1) };
  }

  async function load() {
    try {
      const { from, to } = range();
      const data = await api(`/calendar/events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
      view.events = (data.events || []).map(item => ({ ...item, startDate: new Date(item.start_at), endDate: new Date(item.end_at) })).sort((a, b) => a.startDate - b.startDate);
      view.loaded = true;
    } catch (error) {
      view.events = [];
      view.error = error.message;
    }
    paint();
  }

  function eventsOn(date) {
    return view.events.filter(event => sameDay(event.startDate, date));
  }

  function titleFor() {
    if (view.mode === 'month') return `${MONTHS[view.cursor.getMonth()]} ${view.cursor.getFullYear()}`;
    if (view.mode === 'week') {
      const start = startOfWeek(view.cursor), end = addDays(start, 6);
      const sameMonth = start.getMonth() === end.getMonth();
      return `${MONTHS[start.getMonth()].slice(0, 3)} ${start.getDate()} – ${sameMonth ? '' : `${MONTHS[end.getMonth()].slice(0, 3)} `}${end.getDate()}, ${end.getFullYear()}`;
    }
    return `${MONTHS[view.cursor.getMonth()]} ${view.cursor.getFullYear()}`;
  }

  function eventChip(event) {
    return `<button class="calendar-event tone-${tone(event.title)}" data-event="${esc(event.id)}" title="${esc(oneLine(event.title))}">${esc(short(event.title, 26))}</button>`;
  }

  function monthView() {
    const cells = monthGrid(view.cursor);
    const head = WEEKDAYS.map(day => `<div class="calendar-weekday">${day}</div>`).join('');
    const body = cells.map(date => {
      const dayEvents = eventsOn(date);
      const other = date.getMonth() !== view.cursor.getMonth();
      const shown = dayEvents.slice(0, 3).map(eventChip).join('');
      const more = dayEvents.length > 3 ? `<button class="calendar-more" data-day="${ymd(date)}">+${dayEvents.length - 3} more</button>` : '';
      return `<div class="calendar-day ${other ? 'other' : ''} ${sameDay(date, today) ? 'today' : ''}" data-day="${ymd(date)}" role="button" tabindex="0">
        <span class="day-number">${date.getDate()}</span><div class="calendar-events">${shown}${more}</div></div>`;
    }).join('');
    return `<div class="calendar-grid">${head}${body}</div>`;
  }

  function weekView() {
    const start = startOfWeek(view.cursor);
    return `<div class="calendar-week">${Array.from({ length: 7 }, (_, index) => {
      const date = addDays(start, index);
      const dayEvents = eventsOn(date);
      return `<div class="week-col ${sameDay(date, today) ? 'today' : ''}">
        <div class="week-head">${WEEKDAYS[date.getDay()]}<strong>${date.getDate()}</strong></div>
        ${dayEvents.length ? dayEvents.map(event => `<button class="week-event tone-${tone(event.title)}" data-event="${esc(event.id)}"><time>${esc(hhmm(event.startDate))}</time>${esc(short(event.title, 40))}</button>`).join('') : '<span class="quiet" style="font-size:11px">—</span>'}
      </div>`;
    }).join('')}</div>`;
  }

  function listView() {
    const { from, to } = range();
    const inRange = view.events.filter(event => event.startDate >= from && event.startDate < to);
    if (!inRange.length) return '<div class="calendar-empty">Nothing planned this month. Click “+” to add the first plan.</div>';
    const groups = [];
    for (const event of inRange) {
      const key = ymd(event.startDate);
      const group = groups.find(item => item.key === key);
      if (group) group.events.push(event); else groups.push({ key, date: event.startDate, events: [event] });
    }
    return `<div class="calendar-list">${groups.map(group => `<div class="list-day"><span>${esc(group.date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }))}</span>${group.events.map(event => `<button class="list-event" data-event="${esc(event.id)}"><strong>${esc(event.title)}</strong><time>${esc(hhmm(event.startDate))} – ${esc(hhmm(event.endDate))}</time></button>`).join('')}</div>`).join('')}</div>`;
  }

  function paint() {
    if (!root.isConnected) return;
    const body = view.mode === 'month' ? monthView() : view.mode === 'week' ? weekView() : listView();
    root.innerHTML = `<div class="calendar-bar">
        <div class="calendar-nav"><button data-step="-1" aria-label="Previous">‹</button><button data-step="1" aria-label="Next">›</button><span class="calendar-title">${esc(titleFor())}</span></div>
        <div style="display:flex;align-items:center;gap:8px">
          <button class="calendar-today" data-today>Today</button>
          <div class="calendar-switch" role="tablist">${['month', 'week', 'list'].map(mode => `<button data-mode="${mode}" class="${view.mode === mode ? 'active' : ''}">${mode[0].toUpperCase()}${mode.slice(1)}</button>`).join('')}</div>
        </div>
      </div>${view.error ? `<div class="calendar-empty">${esc(view.error)}</div>` : body}`;
    wire();
  }

  function wire() {
    root.querySelectorAll('[data-step]').forEach(button => button.onclick = () => {
      const step = Number(button.dataset.step);
      if (view.mode === 'month') view.cursor = new Date(view.cursor.getFullYear(), view.cursor.getMonth() + step, 1);
      else if (view.mode === 'week') view.cursor = addDays(view.cursor, step * 7);
      else view.cursor = new Date(view.cursor.getFullYear(), view.cursor.getMonth() + step, 1);
      load();
    });
    root.querySelectorAll('[data-mode]').forEach(button => button.onclick = () => { view.mode = button.dataset.mode; load(); });
    const todayButton = root.querySelector('[data-today]');
    if (todayButton) todayButton.onclick = () => { view.cursor = dayStart(new Date()); if (view.mode === 'month') view.cursor = new Date(today.getFullYear(), today.getMonth(), 1); load(); };
    root.querySelectorAll('.calendar-day').forEach(cell => {
      cell.onclick = event => { if (event.target.closest('[data-event]')) return; show(parseYmd(cell.dataset.day)); };
      cell.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show(parseYmd(cell.dataset.day)); } };
    });
    root.querySelectorAll('[data-event]').forEach(button => button.onclick = event => { event.stopPropagation(); openEvent(button.dataset.event); });
  }

  function parseYmd(value) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  function localInput(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  function show(day) {
    message.textContent = '';
    form.reset();
    const start = day ? new Date(day) : new Date();
    if (!day) { start.setMinutes(0, 0, 0); start.setHours(start.getHours() + 1); }
    else start.setHours(9, 0, 0, 0);
    form.elements.start.value = localInput(start);
    form.elements.end.value = localInput(new Date(start.getTime() + 60 * 60_000));
    dialog.hidden = false;
    form.elements.title.focus();
  }

  function openEvent(id) {
    const event = view.events.find(item => item.id === id);
    if (!event) return;
    const overlay = document.createElement('div');
    overlay.className = 'event-popover';
    overlay.innerHTML = `<div class="event-card" role="dialog" aria-modal="true">
      <h3>${esc(event.title)}</h3>
      <p class="event-when">${esc(event.startDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))} · ${esc(hhmm(event.startDate))} – ${esc(hhmm(event.endDate))}</p>
      ${event.description ? `<p>${esc(event.description)}</p>` : ''}
      <div class="event-card-actions"><button class="ghost-button" data-close>Close</button><button class="outline-button" data-delete>Remove event</button></div>
    </div>`;
    overlay.onclick = event => { if (event.target === overlay) overlay.remove(); };
    overlay.querySelector('[data-close]').onclick = () => overlay.remove();
    overlay.querySelector('[data-delete]').onclick = async () => {
      if (!confirm(`Remove “${event.title}” from your calendar?`)) return;
      await api(`/calendar/events/${encodeURIComponent(event.id)}`, { method: 'DELETE' });
      overlay.remove();
      load();
    };
    document.body.append(overlay);
    overlay.querySelector('[data-close]').focus();
  }

  document.querySelector('#add-event').onclick = () => show(null);
  document.querySelector('#close-event').onclick = () => { dialog.hidden = true; };
  dialog.onclick = event => { if (event.target === dialog) dialog.hidden = true; };
  form.onsubmit = async event => {
    event.preventDefault();
    try {
      await api('/calendar/events', { method: 'POST', body: JSON.stringify({ title: form.elements.title.value, description: form.elements.description.value, start: new Date(form.elements.start.value).toISOString(), end: new Date(form.elements.end.value).toISOString() }) });
      dialog.hidden = true;
      await load();
    } catch (error) { message.textContent = error.message; }
  };
  document.addEventListener('keydown', function onKey(event) {
    if (!root.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (event.key === 'Escape' && !dialog.hidden) dialog.hidden = true;
  });

  paint();
  await load();
}
