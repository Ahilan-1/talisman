// Local administrator diagnostic. Prints indices and timing only; never model identifiers.
const base=process.env.OPENCODE_URL||'http://127.0.0.1:4096';
const provider=await (await fetch(`${base}/provider`)).json();
const models=provider.all.filter(p=>provider.connected.includes(p.id)).flatMap(p=>Object.values(p.models||{}).filter(m=>m.status==='active'&&m.capabilities?.toolcall).map(m=>({provider:p.id,id:m.id})));
const limit=Number(process.env.PROBE_LIMIT||Math.min(models.length,9));
let cursor=0;
async function probe(){
  while(cursor<limit){
    const index=cursor++,model=models[index],start=Date.now();
    try{
      const session=await (await fetch(`${base}/session`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Talisman connectivity check'})})).json();
      const response=await fetch(`${base}/session/${session.id}/message`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:{providerID:model.provider,modelID:model.id},system:'Reply OK only. Do not use tools.',parts:[{type:'text',text:'Reply OK'}]}),signal:AbortSignal.timeout(15000)});
      const data=await response.json();
      console.log(`candidate ${index+1}: ${response.ok&&data.parts?.some(x=>x.type==='text'&&x.text)?'ready':'unavailable'} in ${Date.now()-start} ms`);
    }catch{console.log(`candidate ${index+1}: timed out or unavailable in ${Date.now()-start} ms`)}
  }
}
await Promise.all([probe(),probe(),probe()]);
