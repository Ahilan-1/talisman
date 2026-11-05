import crypto from 'node:crypto';

export function ensureAccountSchema(db){db.exec(`CREATE TABLE IF NOT EXISTS account_credentials(user_id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,email TEXT NOT NULL UNIQUE COLLATE NOCASE,password_hash TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);`)}

function validProfile({username,email,password}){
  const name=String(username||'').trim(),mail=String(email||'').trim().toLowerCase(),secret=String(password||'');
  if(!/^[a-zA-Z0-9_]{3,32}$/.test(name))throw Error('Username must be 3–32 letters, numbers or underscores');
  if(mail.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail))throw Error('Enter a valid email address');
  if(secret.length<12||secret.length>200)throw Error('Use a password with at least 12 characters');
  return {name,mail,secret};
}

export function setAccountCredentials(db,userId,input){
  if(!db.prepare('SELECT 1 FROM telegram_accounts WHERE user_id=?').get(userId))throw Error('Connect Telegram first');
  if(db.prepare('SELECT 1 FROM account_credentials WHERE user_id=?').get(userId))throw Error('Account credentials already exist');
  const {name,mail,secret}=validProfile(input),salt=crypto.randomBytes(16).toString('hex');
  const encoded=crypto.scryptSync(secret,salt,64).toString('hex');
  db.prepare('INSERT INTO account_credentials(user_id,username,email,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(userId,name,mail,`scrypt:${salt}:${encoded}`,Date.now(),Date.now());
  return {username:name,email:mail};
}

export function verifyAccountCredentials(db,identity,password){
  const value=String(identity||'').trim();
  const row=db.prepare('SELECT * FROM account_credentials WHERE username=? COLLATE NOCASE OR email=? COLLATE NOCASE').get(value,value);
  if(!row)return null;
  const [algorithm,salt,expected]=row.password_hash.split(':');
  if(algorithm!=='scrypt'||!salt||!expected)return null;
  const actual=crypto.scryptSync(String(password||''),salt,64);
  if(!crypto.timingSafeEqual(actual,Buffer.from(expected,'hex')))return null;
  return {userId:row.user_id,username:row.username,email:row.email};
}

export function accountProfile(db,userId){const row=db.prepare('SELECT username,email FROM account_credentials WHERE user_id=?').get(userId);return row?{complete:true,...row}:{complete:false}}
