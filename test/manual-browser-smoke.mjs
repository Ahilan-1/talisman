// Run inside an assigned computer. Does not create a job or send Telegram messages.
const key = process.env.TALISMAN_WORKER_KEY;
if (!key) throw Error('This smoke test must run inside a paired computer');
const input = [
  { role: 'user', content: 'Go to rectransport.com and check what bus I will get tomorrow morning, from Avadi to college.' },
  { role: 'assistant', content: 'Which college do you mean?' },
  { role: 'user', content: 'Rectransport.com is my college website to check transport.' },
];
const task = input.at(-1).content;
let toolsUsed = 0;
for (let round = 0; round < 8; round++) {
  const response = await fetch('http://talisman:3000/api/worker/openai/step', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: task, input }),
    signal: AbortSignal.timeout(120_000),
  });
  const step = await response.json();
  if (!response.ok) throw Error(step.error || `Model step failed (${response.status})`);
  if (!step.calls?.length) {
    if (!toolsUsed) throw Error(`Agent answered without using its computer: ${step.text}`);
    if (/cannot open live websites|can't open live websites|can't browse/i.test(step.text)) throw Error(`Agent falsely denied browser access: ${step.text}`);
    console.log(JSON.stringify({ toolsUsed, answer: step.text }));
    process.exit(0);
  }
  input.push(...step.output);
  for (const call of step.calls) {
    const action = String(call.name).split('.').at(-1);
    const args = JSON.parse(call.arguments || '{}');
    const result = await fetch('http://127.0.0.1:4150/action', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...args }), signal: AbortSignal.timeout(45_000),
    });
    const output = await result.json();
    toolsUsed++;
    console.log(JSON.stringify({ tool: action, args, ok: result.ok, title: output.title, url: output.url }));
    input.push({ type: 'function_call_output', call_id: call.callId, output: JSON.stringify(output).slice(0, 10000) });
  }
}
throw Error('Agent exceeded tool step budget');
