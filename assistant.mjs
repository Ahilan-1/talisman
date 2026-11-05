const [command, ...values] = process.argv.slice(2);
const commands = {
  remind: () => ({ action: 'create_reminder', args: { at: values[0], text: values.slice(1).join(' ') } }),
  followup: () => ({ action: 'create_followup', args: { at: values[0], instruction: values.slice(1).join(' ') } }),
  watch: () => ({ action: 'create_watch', args: { url: values[0], intervalMinutes: values[1], selector: values.slice(2).join(' ') } }),
  list: () => ({ action: 'list_commitments', args: {} }),
  cancel: () => ({ action: 'cancel_commitment', args: { id: values[0] } }),
  calendar: () => ({ action: 'list_calendar_events', args: { from: values[0], to: values[1] } }),
  event: () => ({ action: 'create_calendar_event', args: { start: values[0], end: values[1], title: values.slice(2).join(' ') } }),
};
if (!commands[command]) throw Error('Use remind, followup, watch, list, or cancel');
const control = (process.env.TALISMAN_URL || 'http://talisman:3000').replace(/\/$/, '');
if (!process.env.TALISMAN_WORKER_KEY) throw Error('This computer is not paired to Talisman');
const response = await fetch(`${control}/api/worker/assistant/action`, { method: 'POST', headers: { authorization: `Bearer ${process.env.TALISMAN_WORKER_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(commands[command]()), signal: AbortSignal.timeout(20_000) });
const result = await response.json();
if (!response.ok) { console.error(result.error || `Assistant action failed (${response.status})`); process.exitCode = 1; }
else console.log(JSON.stringify(result, null, 2));
