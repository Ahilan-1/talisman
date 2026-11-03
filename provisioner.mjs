import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const dataDir=path.resolve(process.env.TALISMAN_DATA_DIR||path.join(root,'data'));
const db=new DatabaseSync(path.join(dataDir,'talisman.sqlite'));
db.exec('PRAGMA journal_mode=WAL');
const socketPath=process.env.DOCKER_SOCKET||'/var/run/docker.sock';
const image=process.env.TALISMAN_DESKTOP_IMAGE||'talisman-desktop:local';
const network=process.env.TALISMAN_DOCKER_NETWORK||'talisman_default';
const serverUrl=process.env.TALISMAN_INTERNAL_URL||'http://talisman:3000';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');

function docker(method,route,payload){return new Promise((resolve,reject)=>{const request=http.request({socketPath,path:`/v1.43${route}`,method,headers:{'content-type':'application/json'}},response=>{let data='';response.on('data',chunk=>data+=chunk);response.on('end',()=>{let parsed;try{parsed=JSON.parse(data||'{}')}catch{parsed={message:data}}if(response.statusCode>=400)reject(new Error(parsed.message||`Docker HTTP ${response.statusCode}`));else resolve(parsed)})});request.on('error',reject);request.end(payload?JSON.stringify(payload):undefined)})}

export function containerSpec(computerId,workerKey,options={}){
  const name=`talisman-${computerId}`;
  const networkName=options.network||network;
  return {name,body:{Image:options.image||image,Env:[
    'PUID=1000','PGID=1000','TZ=Etc/UTC',
    `TALISMAN_URL=${options.serverUrl||serverUrl}`,
    `TALISMAN_COMPUTER_ID=${computerId}`,
    `TALISMAN_WORKER_KEY=${workerKey}`,
    'OPENCODE_URL=http://127.0.0.1:4096',
    ...(process.env.OPENCODE_API_KEY?[`OPENCODE_API_KEY=${process.env.OPENCODE_API_KEY}`]:[]),
    `SUBFOLDER=/desktop/${computerId}/`,
    'TITLE=Talisman computer',
  ],HostConfig:{NetworkMode:networkName,Binds:[`talisman-home-${computerId}:/config`],ShmSize:1073741824,Memory:2147483648,NanoCpus:2000000000,PidsLimit:512,RestartPolicy:{Name:'unless-stopped'},SecurityOpt:['no-new-privileges:true']},NetworkingConfig:{EndpointsConfig:{[networkName]:{}}}}};
}

async function provision(row){
  const key=crypto.randomBytes(32).toString('base64url');
  const spec=containerSpec(row.computer_id,key);
  db.prepare("UPDATE computer_provisioning SET status='starting',error=NULL,container_name=?,updated_at=? WHERE computer_id=?").run(spec.name,Date.now(),row.computer_id);
  try{
    await docker('POST',`/containers/create?name=${encodeURIComponent(spec.name)}`,spec.body);
    db.prepare('UPDATE computers SET worker_key_hash=? WHERE id=?').run(hash(key),row.computer_id);
    await docker('POST',`/containers/${encodeURIComponent(spec.name)}/start`);
    db.prepare("UPDATE computer_provisioning SET status='running',updated_at=? WHERE computer_id=?").run(Date.now(),row.computer_id);
    console.log(`Provisioned computer ${row.computer_id}`);
  }catch(error){
    db.prepare("UPDATE computer_provisioning SET status='failed',error=?,updated_at=? WHERE computer_id=?").run(error.message.slice(0,500),Date.now(),row.computer_id);
    console.error(`Provisioning failed for ${row.computer_id}: ${error.message}`);
  }
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  console.log('Talisman provisioner started');
  for(;;){
    try{const row=db.prepare("SELECT computer_id FROM computer_provisioning WHERE status='pending' ORDER BY updated_at LIMIT 1").get();if(row)await provision(row);else await sleep(2000)}
    catch(error){console.error('Provisioner retry:',error.message);await sleep(5000)}
  }
}
