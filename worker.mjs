import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { extractDocument } from './document-tools.mjs';
import { buildTaskPrompt } from './prompt.mjs';

const control=(process.env.TALISMAN_URL||'http://127.0.0.1:3000').replace(/\/$/,'');
const opencode=(process.env.OPENCODE_URL||'http://127.0.0.1:4096').replace(/\/$/,'');
const file=process.env.TALISMAN_WORKER_STATE||path.join(os.homedir(),'.talisman-worker.json');
const SKILL_NOTES={computer:'browsing, searching, clicking, forms, screenshots',booking:'tickets, reservations and purchases with approval gates',research:'comparing options and verifying live facts',documents:'reading forwarded files',planning:'breaking down complex multi-step work'};
const skills=(()=>{try{return fs.readdirSync(new URL('./skills/',import.meta.url),{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>({name:entry.name,path:`/config/.opencode/skills/${entry.name}/SKILL.md`,description:SKILL_NOTES[entry.name]||'task recipe'}))}catch{return []}})();
let state=process.env.TALISMAN_WORKER_KEY?{key:process.env.TALISMAN_WORKER_KEY,computerId:process.env.TALISMAN_COMPUTER_ID}:fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
async function request(url,options={}){const r=await fetch(url,{...options,signal:options.signal||AbortSignal.timeout(options.timeoutMs||120000)});const value=await r.json().catch(()=>({}));if(!r.ok)throw Error(value.error||`HTTP ${r.status}`);return value;}
if(!state){const code=process.env.TALISMAN_PAIR_CODE||process.argv[2];if(!code)throw Error('Set TALISMAN_PAIR_CODE or pass the pairing code as an argument');state=await request(`${control}/api/worker/pair`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code})});fs.writeFileSync(file,JSON.stringify(state),{mode:0o600});console.log('Computer paired');}
const auth={'authorization':`Bearer ${state.key}`};
const allowed=new Set(['search','open','read','text','find','inspect','wait','scroll','click','fill','select','hover','press','back','forward','newtab','switch','screenshot']);
async function oc(route,options={}){return request(`${opencode}${route}`,options);}
async function imageInput(screenshotPath){
 try{
  const bytes=fs.readFileSync(screenshotPath);
  if(bytes.length>2_500_000)return null;
  return {type:'input_image',image_url:`data:image/png;base64,${bytes.toString('base64')}`,detail:'low'};
 }catch{return null}
}
async function computerAction(action,args,signal){
 const result=await request('http://127.0.0.1:4150/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...args}),signal:AbortSignal.any([signal,AbortSignal.timeout(45_000)])});
 if(action==='screenshot'&&result?.screenshot){const {screenshot,...rest}=result;const image=await imageInput(screenshot);return {result:rest,image};}
 return {result};
}
async function openAIComputer(job,p){
 const controller=new AbortController(),stopWatching=watchCancellation(job.id,controller);
 const input=[...(Array.isArray(p.history)?p.history.slice(-16).filter(x=>['user','assistant'].includes(x.role)).map(x=>({role:x.role,content:String(x.text||'').slice(0,2000)})):[]),{role:'user',content:String(p.text||'')}];
 const started=Date.now();
 try{
  for(let round=0;round<18;round++){
   if(Date.now()-started>4*60_000)throw Error('The computer task took too long. Please try a narrower request.');
   const response=await request(`${control}/api/worker/openai/step`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({text:p.text,context:p.context||[],soul:p.soul||'',input,timeZone:p.timeZone||'UTC'}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(140000)])});
   const calls=Array.isArray(response.calls)?response.calls:[];
   if(!calls.length)return {text:response.text||'I checked, but I could not verify a result yet.'};
   if(!Array.isArray(response.output)||!response.output.length)throw Error('Model tool call was incomplete');
   input.push(...response.output);
   for(const call of calls){
    const action=String(call.name||'').split('.').at(-1);
    if(!allowed.has(action)||!call.callId)throw Error('Unsupported computer action');
    let args;try{args=JSON.parse(call.arguments||'{}')}catch{args={}}
    let outcome;
    try{outcome=await computerAction(action,args,controller.signal)}
    catch(error){if(controller.signal.aborted)throw error;outcome={result:{error:error.message}}}
    input.push({type:'function_call_output',call_id:call.callId,output:JSON.stringify(outcome.result).slice(0,10000)});
    if(outcome.image)input.push({role:'user',content:[{type:'input_text',text:'Screenshot of the current page.'},outcome.image]});
   }
  }
  throw Error('I reached the computer task step limit. Please send a narrower request.');
 }finally{stopWatching()}
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
async function run(job){const p=job.payload||{};
 if(job.kind==='document'){
  const extracted=extractDocument(p.filename,Buffer.from(String(p.base64||''),'base64'));
  return {filename:extracted.name,extracted:extracted.text,text:`I read ${extracted.name}. Here is the extracted text:\n\n${extracted.text.slice(0,3000)}${extracted.text.length>3000?'\n\nMore is saved in your Talisman documents.':''}`};
 }
 if(job.kind==='watch'){
  const result=await request('http://127.0.0.1:4150/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'read',url:p.url,selector:p.selector||''}),timeoutMs:45_000});
  if(result.blocked||/sorry, you have been blocked|attention required! \| cloudflare|access denied/i.test(`${result.title} ${result.text}`))throw Error('The website blocked browser access');
  return {watchId:p.watchId,url:result.url,title:result.title,extracted:result.text};
 }
 if(job.kind==='models')return {models:flattenProviders(await oc('/provider'))};
 if(job.kind==='sessions')return {sessions:await oc('/session')};
 if(job.kind==='message'){
  const task=String(p.text||'');
  const connection=await request(`${control}/api/worker/openai/status`,{headers:auth,timeoutMs:10000});
  if(connection.preference==='openai'&&!connection.connected)throw Error('OpenAI is disconnected. Choose another model setting in your dashboard.');
  if(connection.connected&&connection.preference!=='free')return openAIComputer(job,p);
  const available=flattenProviders(await oc('/provider'));
  if(!available.length)throw Error('No free model is available in this computer. Switch to OpenAI in Models.');
  const selected=chooseModel(available);
  const provider=selected.provider,model=selected.id;
  const session=p.sessionId?{id:String(p.sessionId)}:await oc('/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:String(p.text).slice(0,60)})});
  const systemPrompt=buildTaskPrompt({timeZone:p.timeZone||'UTC',soul:String(p.soul||''),memory:{entries:Array.isArray(p.context)?p.context:[],index:Array.isArray(p.memoryIndex)?p.memoryIndex:[]},history:Array.isArray(p.history)?p.history:[],skills});
  const controller=new AbortController(),started=Date.now();
  const stopWatching=watchCancellation(job.id,controller,async()=>{const status=(await oc('/session/status',{timeoutMs:5000}))[session.id];if(status?.type==='retry'&&status.action?.reason==='free_tier_limit')controller.abort(new Error('OpenCode access has reached its usage limit.'));});
  try{
   const output=await oc(`/session/${encodeURIComponent(session.id)}/message`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:{providerID:provider,modelID:model},system:systemPrompt,parts:[{type:'text',text:task}]}),signal:controller.signal,timeoutMs:180000});
   recordModel(selected,true,Date.now()-started);
   return {sessionId:session.id,text:(output.parts||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n')};
  }catch(error){recordModel(selected,false,Date.now()-started);try{await oc(`/session/${encodeURIComponent(session.id)}/abort`,{method:'POST',timeoutMs:5000})}catch{}throw error}
  finally{stopWatching()}
 }
 throw Error('Unsupported job');
}
console.log(`Connected to Talisman; OpenCode at ${opencode}`);
for(;;){try{const {job}=await request(`${control}/api/worker/jobs`,{headers:auth});if(!job){await sleep(2000);continue}let result,error;try{result=await run(job)}catch(e){error=e.message}if((await jobStatus(job.id)).status==='canceled')continue;await request(`${control}/api/worker/jobs/${job.id}`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({result,error})});}catch(e){console.error(e.message);await sleep(5000)}}
