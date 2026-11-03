const [action, ...args] = process.argv.slice(2);
const data = { action };
if (action === 'search') data.query = args.join(' ');
else if (action === 'find') data.query = args.join(' ');
else if (action === 'open') data.url = args[0];
else if (action === 'click' || action === 'fill') { data.selector = args[0]; data.value = args.slice(1).join(' '); }
else if (action === 'read') { data.url = args[0]; data.selector = args.slice(1).join(' '); }
else if (action === 'press') data.key = args[0];
else if (action === 'scroll') { data.direction = args[0] || 'down'; data.amount = Number(args[1]) || 700; }
else if (action === 'wait') { data.selector = args[0] || ''; data.text = args.slice(1).join(' '); }
else if (action === 'select') { data.selector = args[0]; data.value = args.slice(1).join(' '); }
else if (action === 'hover') data.selector = args[0];
else if (action === 'newtab') data.url = args[0] || '';
else if (action === 'switch') data.index = Number(args[0]);
else if (action === 'desktop-click') { data.x = Number(args[0]); data.y = Number(args[1]); }
else if (action === 'desktop-type') data.value = args.join(' ');
const response = await fetch('http://127.0.0.1:4150/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(45_000) });
const result = await response.json();
if (!response.ok) { console.error(result.error || `Computer failed (${response.status})`); process.exitCode = 1; }
else console.log(JSON.stringify(result, null, 2));
