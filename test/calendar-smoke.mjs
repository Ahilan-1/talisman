import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';

const dataDir=mkdtempSync(path.join(os.tmpdir(),'talisman-calendar-'));
const port=40000+Math.floor(Math.random()*1000);
const app=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',TALISMAN_DATA_DIR:dataDir,TELEGRAM_ENABLED:'0',OPENAI_LOCAL_SIGNIN:'0'}});
let browser;
try{
  for(let i=0;i<50;i++){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok)break}catch{}await new Promise(resolve=>setTimeout(resolve,100))}
  const token=crypto.randomBytes(24).toString('base64url'),db=new DatabaseSync(path.join(dataDir,'talisman.sqlite'));
  db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run('smoke','smoke@example.test','disabled',Date.now());
  db.prepare('INSERT INTO telegram_accounts(telegram_id,user_id,chat_id,username,created_at) VALUES(?,?,?,?,?)').run('smoke-telegram','smoke','smoke-chat','smoke',Date.now());
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(crypto.createHash('sha256').update(token).digest('hex'),'smoke',Date.now()+60000);
  db.close();
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const page=await browser.newPage();
  await page.context().addCookies([{name:'talisman',value:token,url:`http://127.0.0.1:${port}`}]);
  page.on('console',message=>console.log('browser:',message.text()));
  page.on('pageerror',error=>console.log('browser error:',error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('#setup-form input[name="username"]').fill('smokeuser');
  await page.locator('#setup-form input[name="email"]').fill('smoke@example.test');
  await page.locator('#setup-form input[name="password"]').fill('long password for smoke');
  await page.getByRole('button',{name:'Create account'}).click();
  await page.getByRole('button',{name:'Calendar'}).click();
  await page.locator('#talisman-calendar button').first().waitFor();
  await page.getByRole('textbox',{name:'Title'}).fill('Smoke event');
  await page.locator('input[name="start"]').fill('2026-11-06T09:00');
  await page.locator('input[name="end"]').fill('2026-11-06T10:00');
  await page.getByRole('button',{name:'Add event'}).click();
  await page.getByText('Event added.').waitFor();
  console.log('Calendar browser smoke passed');
}finally{await browser?.close();app.kill();await new Promise(resolve=>app.once('exit',resolve));rmSync(dataDir,{recursive:true,force:true})}
