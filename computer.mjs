const [action, ...args] = process.argv.slice(2);
const data = { action };
if (action === 'search') data.query = args.join(' ');
else if (action === 'find') data.query = args.join(' ');
else if (action === 'open') data.url = args[0];
else if (action === 'extract') data.url = args[0];
else if (action === 'screen') { if (/^https?:\/\//i.test(args[0] || '')) data.url = args[0]; else data.text = args.join(' '); }
else if (action === 'click') { data.selector=args[0];data.intent=args[1]==='consequential'?'consequential':'navigation';data.jobId=args[2]||''; }
else if (action === 'fill') { data.selector = args[0]; data.value = args.slice(1).join(' '); }
else if (action === 'read') { data.url = args[0]; data.selector = args.slice(1).join(' '); }
else if (action === 'press') data.key = args[0];
else if (action === 'scroll') { data.direction = args[0] || 'down'; data.amount = Number(args[1]) || 700; }
else if (action === 'wait') { data.selector = args[0] || ''; data.text = args.slice(1).join(' '); }
else if (action === 'select') { data.selector = args[0]; data.value = args.slice(1).join(' '); }
else if (action === 'hover') data.selector = args[0];
else if (action === 'newtab') data.url = args[0] || '';
else if (action === 'switch') { if (/^\d+$/.test(args[0] || '')) data.index = Number(args[0]); else data.match = args.join(' '); }
else if (action === 'close') { if (/^\d+$/.test(args[0] || '')) data.index = Number(args[0]); else data.match = args.join(' '); }
else if (action === 'desktop-click') { data.x = Number(args[0]); data.y = Number(args[1]); }
else if (action === 'desktop-type') data.value = args.join(' ');
async function browserCall(){const response=await fetch('http://127.0.0.1:4150/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(180_000)});const result=await response.json();if(!response.ok){const error=Error(result.error||`Computer failed (${response.status})`);error.body=result;throw error}return result}
async function controlCall(route,options={}){const base=(process.env.TALISMAN_URL||'http://talisman:3000').replace(/\/$/,'');const response=await fetch(`${base}${route}`,{...options,headers:{authorization:`Bearer ${process.env.TALISMAN_WORKER_KEY||''}`,'content-type':'application/json',...options.headers},signal:AbortSignal.timeout(15000)});const result=await response.json();if(!response.ok)throw Error(result.error||`Talisman failed (${response.status})`);return result}
try{
 let result=await browserCall();
 if(result.approvalRequired){
  if(!data.jobId)throw Error('The task ID is required for a consequential action');
  const approval=await controlCall('/api/worker/task/approval',{method:'POST',body:JSON.stringify({jobId:data.jobId,action:'click',summary:`${result.approvalRequired.label} on ${result.approvalRequired.url}`,details:result.approvalRequired})});
  let status='pending';
  for(let i=0;i<900;i++){await new Promise(resolve=>setTimeout(resolve,1000));status=(await controlCall(`/api/worker/task/approval/${approval.id}`)).status;if(status!=='pending')break}
  if(status!=='approved')throw Error(`The action was ${status}; nothing was submitted.`);
  data.approvalId=approval.id;
  result=await browserCall();
 }
 console.log(JSON.stringify(result,null,2));
}catch(error){
 // A failure still carries the current page map (tabs, refs, candidates, overlays, text). Print it:
 // the model can only recover from what it can see.
 if(error.body&&typeof error.body==='object')console.log(JSON.stringify({...error.body,error:error.message},null,2));
 else console.error(error.message);
 process.exitCode=1
}
