import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { extractDocument } from './document-tools.mjs';
import { buildTaskPrompt } from './prompt.mjs';

const control=(process.env.TALISMAN_URL||'http://127.0.0.1:3000').replace(/\/$/,'');
const opencode=(process.env.OPENCODE_URL||'http://127.0.0.1:4096').replace(/\/$/,'');
const file=process.env.TALISMAN_WORKER_STATE||path.join(os.homedir(),'.talisman-worker.json');
const SKILL_NOTES={computer:'browsing, searching, clicking, forms, screenshots',assistant:'reminders, calendar events, follow-ups, website watches and cancellation',booking:'tickets, reservations and purchases with approval gates',research:'comparing options and verifying live facts',documents:'reading forwarded files',planning:'breaking down complex multi-step work'};
// The free OpenCode provider drops the HTTP stream when its quota runs out, which reaches us as a
// transport error ('fetch failed'). Read its own log so the person gets the real reason.
function recentOpencodeFailure(){
 try{
  const file=process.env.OPENCODE_LOG||'/config/.local/share/opencode/log/opencode.log';
  const stat=fs.statSync(file),size=Math.min(stat.size,60000),fd=fs.openSync(file,'r'),buf=Buffer.alloc(size);
  fs.readSync(fd,buf,0,size,stat.size-size);
  fs.closeSync(fd);
  const errors=buf.toString('utf8').split('\n').filter(line=>line.includes('level=ERROR'));
  const last=errors.at(-1)||'';
  const stamp=/timestamp=([^ ]+)/.exec(last)?.[1];
  if(stamp&&Date.now()-Date.parse(stamp)>4*60_000)return '';
  return last;
 }catch{return ''}
}
function friendlyModelError(error){
 const message=String(error?.message||'')||'The task could not finish.';
 const blob=`${message}\n${recentOpencodeFailure()}`;
 if(/free usage limit|usage limit|quota|free_tier_limit/i.test(blob))return 'The free model reached its usage limit. Switch to OpenAI in Models, or try again later.';
 if(/model is unavailable|upstream request failed/i.test(blob))return 'The free model is unavailable right now. Try again in a few minutes, or switch to OpenAI in Models.';
 if(/fetch failed|ECONNRESET|socket hang up|terminated|aborted/i.test(message))return 'The model connection dropped mid-task, so nothing was submitted. Try again, or switch to OpenAI in Models for longer tasks.';
 return message;
}
const skills=(()=>{try{return fs.readdirSync(new URL('./skills/',import.meta.url),{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>({name:entry.name,path:`/config/.opencode/skills/${entry.name}/SKILL.md`,description:SKILL_NOTES[entry.name]||'task recipe'}))}catch{return []}})();
let state=process.env.TALISMAN_WORKER_KEY?{key:process.env.TALISMAN_WORKER_KEY,computerId:process.env.TALISMAN_COMPUTER_ID}:fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
async function request(url,options={}){const timeout=options.timeoutMs||120000;const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout);const r=await fetch(url,{...options,signal});const value=await r.json().catch(()=>({}));if(!r.ok){const error=Error(value.error||`HTTP ${r.status}`);error.body=value;throw error}return value}
// The model reads tool output as text. Keep the observation (tabs, refs, candidates, text) intact and
// drop the least useful bulk instead of cutting the JSON string mid-object.
function toolResult(result){
 const clean={...(result||{})};
 if(typeof clean.text==='string')clean.text=clean.text.slice(0,4000);
 for(const key of ['elements','candidates'])if(Array.isArray(clean[key]))clean[key]=clean[key].slice(0,60);
 if(Array.isArray(clean.links))clean.links=clean.links.slice(0,12);
 let output=JSON.stringify(clean);
 if(output.length>14000){delete clean.text;output=JSON.stringify(clean)}
 return output.slice(0,16000);
}
if(!state){const code=process.env.TALISMAN_PAIR_CODE||process.argv[2];if(!code)throw Error('Set TALISMAN_PAIR_CODE or pass the pairing code as an argument');state=await request(`${control}/api/worker/pair`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code})});fs.writeFileSync(file,JSON.stringify(state),{mode:0o600});console.log('Computer paired');}
const auth={'authorization':`Bearer ${state.key}`};
const assistantActions=new Set(['create_reminder','create_followup','create_watch','list_commitments','cancel_commitment','create_calendar_event','list_calendar_events']);
const allowed=new Set(['search','extract','screen','open','read','text','find','inspect','wait','scroll','click','fill','select','hover','press','back','forward','tabs','newtab','switch','close','screenshot','reset','dismiss','ask',...assistantActions]);
async function oc(route,options={}){return request(`${opencode}${route}`,options);}
async function imageInput(screenshotPath){
 try{
  const bytes=fs.readFileSync(screenshotPath);
  if(bytes.length>2_500_000)return null;
  return {type:'input_image',image_url:`data:image/png;base64,${bytes.toString('base64')}`,detail:'low'};
 }catch{return null}
}
async function computerAction(action,args,signal,job,ordinal){
 // Asking the person is a first-class action: the task pauses, the question goes to Telegram,
 // and the worker waits for the reply before continuing.
 if(action==='ask'){
  const prompt=String(args.prompt||args.question||'').replace(/\s+/g,' ').trim().slice(0,500);
  if(!prompt)throw Error('Ask needs a prompt');
  const kind=['text','otp','password','phone','choice','confirm'].includes(String(args.kind||''))?String(args.kind):'text';
  const timeoutMs=Math.max(60_000,Math.min(30*60_000,(Number(args.timeoutSeconds)||600)*1000));
  const created=await request(`${control}/api/worker/task/question`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({jobId:job.id,prompt,kind,options:Array.isArray(args.options)?args.options:null,timeoutMs}),signal});
  for(let i=0;i<Math.ceil(timeoutMs/1000)+5;i++){
   await sleep(1000,null,{signal});
   const state=await request(`${control}/api/worker/task/question/${created.id}`,{headers:auth,signal});
   if(state.status==='answered')return {result:{answered:true,kind,answer:state.answer}};
   if(state.status!=='pending')throw Error(`The question was ${state.status}; nothing was answered.`);
  }
  throw Error('No answer arrived in time. Ask again, or continue without it and say what you still need.');
 }
 if(assistantActions.has(action)){
  const result=await request(`${control}/api/worker/assistant/action`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({action,args}),signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)])});
  return {result};
 }
 let result=await request('http://127.0.0.1:4150/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...args}),signal:AbortSignal.any([signal,AbortSignal.timeout(180_000)])});
 if(result?.approvalRequired){
  const requestDetails=result.approvalRequired;
  const approval=await request(`${control}/api/worker/task/approval`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({jobId:job.id,action,summary:`${requestDetails.label} on ${requestDetails.url}`,details:requestDetails}),signal});
  for(let i=0;i<180;i++){
   await sleep(1000,null,{signal});
   const status=await request(`${control}/api/worker/task/approval/${approval.id}`,{headers:auth,signal});
   if(status.status==='approved')break;
   if(status.status!=='pending')throw Error(`The action was ${status.status}; nothing was submitted.`);
   if(i===179)throw Error('Approval timed out; nothing was submitted.');
  }
  result=await request('http://127.0.0.1:4150/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...args,approvalId:approval.id}),signal:AbortSignal.any([signal,AbortSignal.timeout(180_000)])});
 }
 if(action==='screenshot'&&result?.screenshot){const {screenshot,...rest}=result;const image=await imageInput(screenshot);return {result:rest,image};}
 return {result};
}
async function openAIComputer(job,p){
 const controller=new AbortController(),stopWatching=watchCancellation(job.id,controller);
 const input=[...(Array.isArray(p.history)?p.history.slice(-16).filter(x=>['user','assistant'].includes(x.role)).map(x=>({role:x.role,content:String(x.text||'').slice(0,2000)})):[]),{role:'user',content:String(p.text||'')}];
 if(Array.isArray(p.resumeSteps)&&p.resumeSteps.length)input.push({role:'user',content:`The computer task was interrupted. These read-only actions completed before restart: ${JSON.stringify(p.resumeSteps).slice(0,8000)}. Continue the original request from verified state; check the current page before relying on it.`});
 const started=Date.now();
 try{
  // A previous task can leave focus on a dead or unrelated tab. Start every task on a live tab
  // and tell the model what is already open, so it switches instead of opening a second copy.
  try{
   const opening=await request('http://127.0.0.1:4150/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'reset'}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120_000)])});
   if(Array.isArray(opening?.tabs)&&opening.tabs.length){
    const active=opening.tabs.find(tab=>tab.active)||opening.tabs[0];
    input.push({role:'user',content:`Browser tabs open right now: ${JSON.stringify(opening.tabs).slice(0,2000)}. The active tab is "${String(active.title||active.url).slice(0,120)}". If the page you need is already open, switch to it by part of its URL or title instead of opening it again.`});
    await request(`${control}/api/worker/task/step`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({jobId:job.id,ordinal:0,kind:'tabs',summary:`${opening.tabs.length} tab${opening.tabs.length===1?'':'s'} open · active: ${String(active.title||active.url).slice(0,120)}`,status:'done',output:{tabs:opening.tabs}}),signal:controller.signal}).catch(()=>{});
   }
  }catch{}
  // No step cap: the task runs until it finishes, the person cancels it, or the wall-clock guard
  // trips. The old fixed round limit is what cut long booking tasks short.
  const maxMinutes=Math.max(1,Math.min(240,Number(process.env.TALISMAN_MAX_TASK_MINUTES)||240));
  for(let round=0;;round++){
   if(Date.now()-started>maxMinutes*60_000)throw Error('The computer task took too long. Please send a narrower request, or ask me to continue.');
   // Screenshots and page dumps add up. Keep the newest image and short outputs so a long task does
   // not blow past the request body limit; the earlier evidence is still in the task work log.
   for(const item of input){
    if(item?.role==='user'&&Array.isArray(item.content)&&item.content.some(part=>part?.type==='input_image'))item.content=[{type:'input_text',text:'Earlier screenshot omitted to keep the request small.'}];
   }
   compactInput(input);
   const response=await request(`${control}/api/worker/openai/step`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({text:p.text,context:p.context||[],soul:p.soul||'',input,timeZone:p.timeZone||'UTC'}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(180000)])});
   const calls=Array.isArray(response.calls)?response.calls:[];
   if(!calls.length){
    if(!String(response.text||'').trim())throw Error('The model returned no answer or browser action');
    return {text:response.text};
   }
   if(!Array.isArray(response.output)||!response.output.length)throw Error('Model tool call was incomplete');
   input.push(...response.output);
   const stepBase=1+(Array.isArray(p.resumeSteps)?p.resumeSteps.length*20:0)+round*20;
   const thoughts=String(response.thoughts||'').replace(/\s+/g,' ').trim();
   if(thoughts)await request(`${control}/api/worker/task/step`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({jobId:job.id,ordinal:stepBase,kind:'think',summary:thoughts.slice(0,280),status:'done',output:{thoughts:String(response.thoughts).slice(0,4000)}}),signal:controller.signal}).catch(()=>{});
   for(const call of calls){
    const action=String(call.name||'').split('.').at(-1);
    if(!allowed.has(action)||!call.callId)throw Error('Unsupported computer action');
    let args;try{args=JSON.parse(call.arguments||'{}')}catch{args={}}
    let outcome;
    const ordinal=stepBase+1+calls.indexOf(call);
    await request(`${control}/api/worker/task/step`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({jobId:job.id,ordinal,kind:action,summary:runningSummary(action,args),status:'running'}),signal:controller.signal});
    try{outcome=await computerAction(action,args,controller.signal,job,ordinal);await request(`${control}/api/worker/task/step`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({jobId:job.id,ordinal,kind:action,summary:stepSummary(action,args,outcome.result),status:'done',output:outcome.result}),signal:controller.signal})}
    catch(error){
     if(controller.signal.aborted)throw error;
     // Keep the observation the computer returned with the failure (refs, candidates, overlays, tabs).
     outcome={result:{...(error.body&&typeof error.body==='object'?error.body:{}),error:error.message}};
     // Browser-use style recovery: when an action fails, return a fresh visual observation with
     // the failure. The next model turn can see an obscuring popup, stale page or changed layout.
     if(['click','fill','select','hover','press','wait'].includes(action)){
      try{
       const visual=await request('http://127.0.0.1:4150/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'screenshot'}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30_000)])});
       const image=visual?.screenshot?await imageInput(visual.screenshot):null;
       if(image){outcome.image=image;outcome.result={...outcome.result,url:visual.url,title:visual.title,note:'The action failed. Use the attached current screenshot as ground truth, inspect the page, and recover with a different concrete action.'};}
      }catch{}
     }
     await request(`${control}/api/worker/task/step`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({jobId:job.id,ordinal,kind:action,summary:stepSummary(action,args,outcome.result)||`${action} failed`,status:'failed',output:outcome.result}),signal:controller.signal}).catch(()=>{});
    }
    input.push({type:'function_call_output',call_id:call.callId,output:toolResult(outcome.result)});
    if(outcome.image)input.push({role:'user',content:[{type:'input_text',text:outcome.result?.error?'The last browser action failed. This fresh screenshot is the current ground truth. Judge why it failed, inspect or dismiss blockers, and try a different recovery action before giving up.':'Screenshot of the current page.'},outcome.image]});
   }
  }
  throw Error('The computer task stopped before it finished.');
 }finally{stopWatching()}
}
// Keep the tail of a very long tool conversation and drop the middle at a call boundary, so the
// model still sees recent page state without the request growing without limit.
function compactInput(input,limit=320){
 if(input.length<=limit)return input;
 let start=2,end=input.length-limit+2;
 while(start<input.length&&!['function_call','message'].includes(input[start]?.type))start+=1;
 while(end<input.length&&input[end]?.type!=='function_call')end+=1;
 if(end>start)input.splice(start,end-start,{role:'user',content:'Earlier steps were trimmed to keep this task running. The work log in the task record has the full history.'});
 return input;
}
// Human-readable activity lines for the inbox: what the agent actually clicked, typed or opened.
const STEP_VERB={click:'Clicking',fill:'Typing',open:'Opening',read:'Reading',text:'Reading page text',find:'Searching the page',inspect:'Inspecting',screenshot:'Taking a screenshot',scroll:'Scrolling',press:'Pressing',switch:'Switching tab',close:'Closing tab',newtab:'Opening a tab',tabs:'Listing tabs',dismiss:'Closing popups',search:'Searching',wait:'Waiting',back:'Going back',forward:'Going forward',reset:'Resetting the browser',ask:'Asking you',extract:'Reading the page',hover:'Hovering',select:'Selecting'};
const clipText=(value,limit)=>String(value??'').replace(/\s+/g,' ').trim().slice(0,limit);
function hostOf(url){try{return new URL(String(url||'')).hostname.replace(/^www\./,'')}catch{return ''}}
function stepSummary(action,args={},result=null){
 const did=result&&result.did?result.did:null;
 const site=hostOf(did?.url||result?.url||args.url);
 const tail=site?` ${action==='click'||action==='fill'||action==='press'?'on':'·'} ${site}`:'';
 if(did?.kind==='click')return `Clicked ${did.label?`“${clipText(did.label,70)}”`:'an element'}${tail}`;
 if(did?.kind==='fill')return `Typed ${did.hidden?did.value:`“${clipText(did.value,60)}”`} into ${clipText(did.field,50)||'the field'}${tail}`;
 if(did?.kind==='press')return `Pressed ${clipText(did.value,30)}${tail}`;
 if(action==='open')return `Opened ${site||clipText(args.url,90)||'a page'}`;
 if(action==='read')return `Read ${site||'the page'}`;
 if(action==='search')return `Searched for “${clipText(args.query,70)}”`;
 if(action==='find')return `Searched the page for “${clipText(args.query,60)}”`;
 if(action==='screenshot')return 'Captured a screenshot';
 if(action==='dismiss'){const count=Array.isArray(result?.closed)?result.closed.length:0;return count?`Closed ${count} popup${count===1?'':'s'}`:'Looked for popups to close'}
 if(action==='switch')return `Switched to ${clipText(result?.title,60)||site||'another tab'}`;
 if(action==='close')return 'Closed a browser tab';
 if(action==='tabs')return `Checked ${Array.isArray(result?.tabs)?result.tabs.length:''} open tabs`.replace(/\s+/g,' ');
 if(action==='scroll')return `Scrolled ${clipText(args.direction||'down',20)}`;
 if(action==='back')return 'Went back a page';
 if(action==='forward')return 'Went forward a page';
 if(action==='wait')return `Waited for ${clipText(args.text||args.selector||'the page to settle',60)}`;
 if(action==='ask')return `Asked you: ${clipText(args.prompt,90)}`;
 return `${STEP_VERB[action]||action}${site?` · ${site}`:''}`;
}
function runningSummary(action,args={}){
 const target=clipText(args.label||args.text||args.url||args.query||args.selector||'',70);
 return `${STEP_VERB[action]||action}${target?` ${target}`:''}…`;
}
async function recordStepSafe(jobId,kind,summary,status,output){
 try{await request(`${control}/api/worker/task/step`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({jobId,ordinal:99999,kind,summary:String(summary).slice(0,280),status,output}),timeoutMs:6000})}catch{}
}
async function jobStatus(jobId){return request(`${control}/api/worker/jobs/${jobId}`,{headers:auth,timeoutMs:5000});}
function watchCancellation(jobId,controller,extra){
 let checking=false;
 const timer=setInterval(async()=>{
  if(checking||controller.signal.aborted)return;
  checking=true;
  try{
   const {status}=await jobStatus(jobId);
   if(status==='canceled')controller.abort(new Error('Task canceled'));
   else if(extra)await extra();
  }catch{}finally{checking=false}
 },1000);
 return ()=>clearInterval(timer);
}
function flattenProviders(data){const connected=new Set(data.connected||[]);return (data.all||[]).filter(p=>connected.has(p.id)&&['opencode','opencode-go'].includes(p.id)).flatMap(p=>Object.values(p.models||{}).filter(m=>m.status!=='deprecated'&&m.status!=='unavailable'&&m.cost?.input===0&&m.cost?.output===0).map(m=>({provider:p.id,id:m.id,name:m.name||m.id,capabilities:m.capabilities||{},context:m.limit?.context||0,isDefault:data.default?.[p.id]===m.id})));}
const modelStats=new Map();
function chooseModel(models){
 const preferred=process.env.TALISMAN_INTERNAL_MODEL;
 const override=models.find(m=>`${m.provider}/${m.id}`===preferred);
 if(override)return override;
 return models.filter(m=>m.capabilities.toolcall!==false).sort((a,b)=>score(b)-score(a))[0]||models[0];
}
function score(model){const s=modelStats.get(`${model.provider}/${model.id}`)||{success:0,fail:0,latency:0};return (model.isDefault?5:0)+(model.capabilities.toolcall?4:0)+(model.capabilities.reasoning?2:0)+Math.min(2,model.context/100000)+s.success*8-s.fail*12-(s.latency?Math.log1p(s.latency/1000):0);}
function recordModel(model,success,latency){const key=`${model.provider}/${model.id}`,s=modelStats.get(key)||{success:0,fail:0,latency:0};s[success?'success':'fail']++;s.latency=s.latency?s.latency*.7+latency*.3:latency;modelStats.set(key,s);}
async function classifyThread(job,task,connection){
 const {candidates}=await request(`${control}/api/worker/task/threads?jobId=${encodeURIComponent(job.id)}`,{headers:auth,timeoutMs:5000});
 if(!candidates?.length)return;
 const prompt=`You organize one person's assistant tasks into an inbox. Decide whether the NEW message continues one existing task, or starts a genuinely new task. A follow-up answer, correction, or request about the same goal continues it. Do not group unrelated work just because it mentions the same city, service, or person. Return ONLY an existing ID from the list, or NEW.\nNEW: ${task.slice(0,1200)}\nEXISTING: ${JSON.stringify(candidates.map(c=>({id:c.id,title:c.title,lastAnswer:String(c.last_answer||'').slice(0,280)}))).slice(0,5000)}`;
 let answer='';
 try{
  if(connection.connected&&connection.preference!=='free'){
   const response=await request(`${control}/api/worker/openai`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({text:prompt}),timeoutMs:45000});answer=response.text||'';
  }else{
   const available=flattenProviders(await oc('/provider',{timeoutMs:6000}));if(!available.length)return;
   const selected=chooseModel(available);
   const session=await oc('/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Task inbox classification'}),timeoutMs:6000});
   const output=await oc(`/session/${encodeURIComponent(session.id)}/message`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:{providerID:selected.provider,modelID:selected.id},system:'You are a strict task classifier. Output only NEW or one provided task ID. Never answer the user task.',parts:[{type:'text',text:prompt}]}),timeoutMs:45000});
   answer=(output.parts||[]).filter(part=>part.type==='text').map(part=>part.text).join('');
  }
  const match=candidates.find(candidate=>answer.trim()===candidate.id);
  if(match)await request(`${control}/api/worker/task/threads`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({jobId:job.id,threadId:match.id}),timeoutMs:5000});
 }catch(error){console.warn('Task inbox classification skipped:',error.message)}
}
async function run(job){const p=job.payload||{};
 if(job.kind==='document'){
  const extracted=extractDocument(p.filename,Buffer.from(String(p.base64||''),'base64'));
  return {filename:extracted.name,extracted:extracted.text,text:`I read ${extracted.name}. Here is the extracted text:\n\n${extracted.text.slice(0,3000)}${extracted.text.length>3000?'\n\nMore is saved in your Talisman documents.':''}`};
 }
 if(job.kind==='watch'){
  const result=await request('http://127.0.0.1:4150/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'read',url:p.url,selector:p.selector||''}),timeoutMs:90_000});
  if(result.blocked||/sorry, you have been blocked|attention required! \| cloudflare|access denied/i.test(`${result.title} ${result.text}`))throw Error('The website blocked browser access');
  return {watchId:p.watchId,url:result.url,title:result.title,extracted:result.text};
 }
 if(job.kind==='models')return {models:flattenProviders(await oc('/provider'))};
 if(job.kind==='sessions')return {sessions:await oc('/session')};
 if(job.kind==='message'){
  const task=String(p.text||'');
  const connection=await request(`${control}/api/worker/openai/status`,{headers:auth,timeoutMs:10000});
  await classifyThread(job,task,connection);
  if(connection.preference==='openai'&&!connection.connected)throw Error('OpenAI is disconnected. Choose another model setting in your dashboard.');
  if(connection.connected&&connection.preference!=='free')return openAIComputer(job,p);
  const available=flattenProviders(await oc('/provider'));
  if(!available.length)throw Error('No free model is available in this computer. Switch to OpenAI in Models.');
  const selected=chooseModel(available);
  const provider=selected.provider,model=selected.id;
  const session=p.sessionId?{id:String(p.sessionId)}:await oc('/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:String(p.text).slice(0,60)})});
  let browserState='';
  try{
   const opening=await request('http://127.0.0.1:4150/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'reset'}),timeoutMs:45_000});
   if(Array.isArray(opening?.tabs)&&opening.tabs.length)browserState=`Browser tabs open right now: ${JSON.stringify(opening.tabs).slice(0,1500)}. If the page you need is already open, switch to it by part of its title or URL instead of opening it again; close tabs that failed to load.`;
  }catch{}
  const systemPrompt=buildTaskPrompt({timeZone:p.timeZone||'UTC',soul:String(p.soul||''),memory:{entries:Array.isArray(p.context)?p.context:[],index:Array.isArray(p.memoryIndex)?p.memoryIndex:[]},history:Array.isArray(p.history)?p.history:[],skills,extra:`${browserState} Current task ID: ${job.id}. For a consequential browser click, use the consequential intent and wait for the person's Telegram approval.`});
  const controller=new AbortController(),started=Date.now();
  const stopWatching=watchCancellation(job.id,controller,async()=>{const status=(await oc('/session/status',{timeoutMs:5000}))[session.id];if(status?.type==='retry'&&status.action?.reason==='free_tier_limit')controller.abort(new Error('OpenCode access has reached its usage limit.'));});
  try{
   const output=await oc(`/session/${encodeURIComponent(session.id)}/message`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:{providerID:provider,modelID:model},system:systemPrompt,parts:[{type:'text',text:task}]}),signal:controller.signal,timeoutMs:30*60_000});
   recordModel(selected,true,Date.now()-started);
   return {sessionId:session.id,text:(output.parts||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n')};
  }catch(error){recordModel(selected,false,Date.now()-started);try{await oc(`/session/${encodeURIComponent(session.id)}/abort`,{method:'POST',timeoutMs:5000})}catch{}const reason=friendlyModelError(error);await recordStepSafe(job.id,'error',reason,'failed',{error:reason});throw Error(reason)}
  finally{stopWatching()}
 }
 throw Error('Unsupported job');
}
console.log(`Connected to Talisman; OpenCode at ${opencode}`);
for(;;){try{const {job}=await request(`${control}/api/worker/jobs`,{headers:auth});if(!job){await sleep(2000);continue}let result,error;try{result=await run(job)}catch(e){error=e.message}if((await jobStatus(job.id)).status==='canceled')continue;await request(`${control}/api/worker/jobs/${job.id}`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({result,error})});}catch(e){console.error(e.message);await sleep(5000)}}
