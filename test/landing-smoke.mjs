import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';

const dataDir=mkdtempSync(path.join(os.tmpdir(),'talisman-landing-'));
const port=40000+Math.floor(Math.random()*1000),base=`http://127.0.0.1:${port}`;
const app=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',TALISMAN_DATA_DIR:dataDir,TELEGRAM_ENABLED:'0',OPENAI_LOCAL_SIGNIN:'0',TELEGRAM_BOT_USERNAME:'TalismanTestBot'}});
let browser;
try{
  for(let i=0;i<60;i++){try{if((await fetch(`${base}/api/health`)).ok)break}catch{}await new Promise(resolve=>setTimeout(resolve,100))}
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const output=process.env.TALISMAN_SCREENSHOT_DIR;
  if(output)mkdirSync(output,{recursive:true});
  for(const [name,viewport] of [['desktop',{width:1440,height:900}],['mobile',{width:390,height:844}]]){
    const page=await browser.newPage({viewport});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base);await page.getByRole('heading',{name:/Give your day/i}).waitFor();
    await page.getByText('Discord and WhatsApp are planned next.').waitFor();
    if(output)await page.screenshot({path:path.join(output,`landing-${name}.png`),fullPage:true});
    if(errors.length)throw Error(errors.join('\n'));
    if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1))throw Error(`${name} layout overflows horizontally`);
    await page.close();
  }
  console.log('Landing browser smoke passed');
}finally{await browser?.close();app.kill();await new Promise(resolve=>app.once('exit',resolve));rmSync(dataDir,{recursive:true,force:true})}
