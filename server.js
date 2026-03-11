/**
 * Molecord – Real-time chat + WebRTC voice/screenshare
 * Run: npm install && node server.js
 */
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── DB init ──────────────────────────────────────────────────────────────────
const USE_PG = !!process.env.DATABASE_URL;
let db;

async function q(sql, params = []) {
  if (USE_PG) {
    let i = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++i}`);
    const res = await db.query(pgSql, params);
    return res.rows;
  } else {
    const t = sql.trim().toUpperCase();
    if (t.startsWith('SELECT') || t.startsWith('WITH')) {
      return db.prepare(sql).all(...params);
    } else {
      db.prepare(sql).run(...params);
      return [];
    }
  }
}
async function one(sql, params = []) { const r = await q(sql, params); return r[0] || null; }

async function initDb() {
  if (USE_PG) {
    const { Pool } = require('pg');
    db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await db.query(`
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,avatar TEXT DEFAULT '🧑',status TEXT DEFAULT 'online',custom_status TEXT DEFAULT '',created_at BIGINT DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS servers(id TEXT PRIMARY KEY,name TEXT NOT NULL,icon TEXT DEFAULT '🌐',owner_id TEXT NOT NULL,created_at BIGINT DEFAULT 0);
      CREATE TABLE IF NOT EXISTS server_members(server_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT DEFAULT 'member',PRIMARY KEY(server_id,user_id));
      CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,server_id TEXT NOT NULL,name TEXT NOT NULL,type TEXT DEFAULT 'text',topic TEXT DEFAULT '',position INT DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,author_id TEXT NOT NULL,content TEXT NOT NULL,pinned INT DEFAULT 0,edited INT DEFAULT 0,reply_to TEXT,created_at BIGINT DEFAULT 0);
      CREATE TABLE IF NOT EXISTS reactions(message_id TEXT NOT NULL,user_id TEXT NOT NULL,emoji TEXT NOT NULL,PRIMARY KEY(message_id,user_id,emoji));
      CREATE TABLE IF NOT EXISTS friendships(user_a TEXT NOT NULL,user_b TEXT NOT NULL,status TEXT DEFAULT 'accepted',PRIMARY KEY(user_a,user_b));
      CREATE TABLE IF NOT EXISTS direct_messages(id TEXT PRIMARY KEY,from_user TEXT NOT NULL,to_user TEXT NOT NULL,content TEXT NOT NULL,created_at BIGINT DEFAULT 0);
      CREATE INDEX IF NOT EXISTS idx_msg ON messages(channel_id,created_at);
    `);
  } else {
    const Database = require('better-sqlite3');
    db = new Database('./molecord.db');
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,avatar TEXT DEFAULT '🧑',status TEXT DEFAULT 'online',custom_status TEXT DEFAULT '',created_at INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS servers(id TEXT PRIMARY KEY,name TEXT NOT NULL,icon TEXT DEFAULT '🌐',owner_id TEXT NOT NULL,created_at INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS server_members(server_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT DEFAULT 'member',PRIMARY KEY(server_id,user_id));
      CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,server_id TEXT NOT NULL,name TEXT NOT NULL,type TEXT DEFAULT 'text',topic TEXT DEFAULT '',position INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,author_id TEXT NOT NULL,content TEXT NOT NULL,pinned INTEGER DEFAULT 0,edited INTEGER DEFAULT 0,reply_to TEXT,created_at INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS reactions(message_id TEXT NOT NULL,user_id TEXT NOT NULL,emoji TEXT NOT NULL,PRIMARY KEY(message_id,user_id,emoji));
      CREATE TABLE IF NOT EXISTS friendships(user_a TEXT NOT NULL,user_b TEXT NOT NULL,status TEXT DEFAULT 'accepted',PRIMARY KEY(user_a,user_b));
      CREATE TABLE IF NOT EXISTS direct_messages(id TEXT PRIMARY KEY,from_user TEXT NOT NULL,to_user TEXT NOT NULL,content TEXT NOT NULL,created_at INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS idx_msg ON messages(channel_id,created_at);
    `);
  }
}

async function upsert(sql, params) {
  if (!USE_PG) {
    const s = sql.replace('ON CONFLICT DO NOTHING', 'OR IGNORE');
    db.prepare(s).run(...params);
  } else {
    let i = 0;
    await db.query(sql.replace(/\?/g, () => `$${++i}`), params);
  }
}

async function seed() {
  const c = await one('SELECT COUNT(*) as c FROM servers');
  if (parseInt(c?.c || c?.count || 0) > 0) return;
  const sys = 'system';
  await upsert('INSERT INTO users(id,username,display_name,password_hash,avatar,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',
    [sys,'molecord_bot','Molecord Bot','$invalid','🤖',Date.now()]);
  const sid = uuidv4();
  await q('INSERT INTO servers(id,name,icon,owner_id,created_at) VALUES(?,?,?,?,?)',[sid,'Molecord HQ 🎵','🎵',sys,Date.now()]);
  const chs = [
    {id:uuidv4(),name:'general',type:'text',topic:'General chat for everyone',pos:0},
    {id:uuidv4(),name:'introductions',type:'text',topic:'Say hello!',pos:1},
    {id:uuidv4(),name:'off-topic',type:'text',topic:'Anything goes',pos:2},
    {id:uuidv4(),name:'General Voice',type:'voice',topic:'',pos:3},
    {id:uuidv4(),name:'Gaming Voice',type:'voice',topic:'',pos:4},
  ];
  for(const c of chs) await q('INSERT INTO channels(id,server_id,name,type,topic,position) VALUES(?,?,?,?,?,?)',[c.id,sid,c.name,c.type,c.topic,c.pos]);
  await q('INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES(?,?,?,?,?)',
    [uuidv4(),chs[0].id,sys,'👋 Welcome to **Molecord**! Voice channels support real mic audio and screenshare — just click a voice channel to join.',Date.now()]);
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname,'public')));

async function auth(req,res,next){
  const sid=req.cookies?.molecord_session;
  if(!sid) return res.status(401).json({error:'Not authenticated'});
  const now=Math.floor(Date.now()/1000);
  const s=await one('SELECT s.*,u.id as uid,u.username,u.display_name,u.avatar,u.status,u.custom_status FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.id=? AND s.expires_at>?',[sid,now]);
  if(!s) return res.status(401).json({error:'Session expired'});
  req.user=s; next();
}

// ─── WebSocket helpers ────────────────────────────────────────────────────────
const userSockets = new Map(); // uid -> Set<ws>
const wsUsers = new Map();     // ws -> uid
const voiceRooms = new Map();  // channelId -> Map<uid, {muted}>

function bcast(data){
  const m=JSON.stringify(data);
  wss.clients.forEach(ws=>{if(ws.readyState===1)ws.send(m);});
}
function sendTo(uid,data){
  const s=userSockets.get(uid);
  if(s)s.forEach(ws=>{if(ws.readyState===1)ws.send(JSON.stringify(data));});
}

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.post('/api/auth/register',async(req,res)=>{
  try{
    const{username,password,displayName}=req.body;
    if(!username||!password||password.length<6) return res.status(400).json({error:'Username required, password min 6 chars'});
    const clean=username.toLowerCase().replace(/[^a-z0-9_]/g,'');
    if(!clean) return res.status(400).json({error:'Invalid username'});
    if(await one('SELECT id FROM users WHERE username=?',[clean])) return res.status(409).json({error:'Username taken'});
    const id=uuidv4();
    const hash=await bcrypt.hash(password,10);
    const avs=['🧑','👩','👨','🧔','👱','🧑‍💻','👩‍💻','🧑‍🎤','🧑‍🚀','🦸'];
    const av=avs[Math.floor(Math.random()*avs.length)];
    await q('INSERT INTO users(id,username,display_name,password_hash,avatar,created_at) VALUES(?,?,?,?,?,?)',[id,clean,displayName||username,hash,av,Date.now()]);
    const ds=await one('SELECT id FROM servers ORDER BY created_at LIMIT 1');
    if(ds) await upsert('INSERT INTO server_members(server_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING',[ds.id,id]);
    const sessId=uuidv4();
    const exp=Math.floor(Date.now()/1000)+86400*30;
    await q('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)',[sessId,id,exp]);
    res.cookie('molecord_session',sessId,{httpOnly:true,maxAge:86400000*30,sameSite:'lax'});
    res.json({id,username:clean,displayName:displayName||username,avatar:av});
    bcast({type:'USER_JOIN',user:{id,username:clean,displayName:displayName||username,avatar:av,status:'online'}});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'});}
});

app.post('/api/auth/login',async(req,res)=>{
  try{
    const{username,password}=req.body;
    const u=await one('SELECT * FROM users WHERE username=?',[username?.toLowerCase()]);
    if(!u||!(await bcrypt.compare(password,u.password_hash))) return res.status(401).json({error:'Invalid username or password'});
    await q("UPDATE users SET status='online' WHERE id=?",[u.id]);
    const sessId=uuidv4();const exp=Math.floor(Date.now()/1000)+86400*30;
    await q('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)',[sessId,u.id,exp]);
    res.cookie('molecord_session',sessId,{httpOnly:true,maxAge:86400000*30,sameSite:'lax'});
    res.json({id:u.id,username:u.username,displayName:u.display_name,avatar:u.avatar});
    bcast({type:'USER_STATUS',userId:u.id,status:'online'});
  }catch(e){console.error(e);res.status(500).json({error:'Server error'});}
});

app.post('/api/auth/logout',auth,async(req,res)=>{
  await q('DELETE FROM sessions WHERE id=?',[req.cookies.molecord_session]);
  await q("UPDATE users SET status='offline' WHERE id=?",[req.user.uid]);
  res.clearCookie('molecord_session');res.json({ok:true});
  bcast({type:'USER_STATUS',userId:req.user.uid,status:'offline'});
});

app.get('/api/auth/me',auth,async(req,res)=>{
  const u=req.user;
  res.json({id:u.uid,username:u.username,displayName:u.display_name,avatar:u.avatar,status:u.status,customStatus:u.custom_status});
});

app.patch('/api/users/me',auth,async(req,res)=>{
  const{displayName,avatar,status,customStatus}=req.body;const uid=req.user.uid;
  if(displayName) await q('UPDATE users SET display_name=? WHERE id=?',[displayName,uid]);
  if(avatar) await q('UPDATE users SET avatar=? WHERE id=?',[avatar,uid]);
  if(status) await q('UPDATE users SET status=? WHERE id=?',[status,uid]);
  if(customStatus!==undefined) await q('UPDATE users SET custom_status=? WHERE id=?',[customStatus,uid]);
  const u=await one('SELECT * FROM users WHERE id=?',[uid]);
  bcast({type:'USER_UPDATE',user:{id:uid,displayName:u.display_name,avatar:u.avatar,status:u.status,customStatus:u.custom_status}});
  res.json({ok:true});
});

app.get('/api/users',auth,async(req,res)=>{
  const users=await q("SELECT id,username,display_name,avatar,status,custom_status FROM users WHERE id!='system'");
  res.json(users.map(u=>({id:u.id,username:u.username,displayName:u.display_name,avatar:u.avatar,status:u.status,customStatus:u.custom_status})));
});

// ─── Servers ──────────────────────────────────────────────────────────────────
app.get('/api/servers',auth,async(req,res)=>{
  const srvs=await q('SELECT s.* FROM servers s JOIN server_members sm ON s.id=sm.server_id WHERE sm.user_id=? ORDER BY s.created_at',[req.user.uid]);
  const result=await Promise.all(srvs.map(async s=>{
    const channels=await q('SELECT * FROM channels WHERE server_id=? ORDER BY position',[s.id]);
    const members=await q("SELECT u.id,u.username,u.display_name,u.avatar,u.status,u.custom_status,sm.role FROM server_members sm JOIN users u ON sm.user_id=u.id WHERE sm.server_id=? AND u.id!='system'",[s.id]);
    return{id:s.id,name:s.name,icon:s.icon,ownerId:s.owner_id,
      channels:channels.map(c=>({id:c.id,name:c.name,type:c.type,topic:c.topic,position:c.position})),
      members:members.map(m=>({id:m.id,username:m.username,displayName:m.display_name,avatar:m.avatar,status:m.status,customStatus:m.custom_status,role:m.role}))};
  }));
  res.json(result);
});

app.post('/api/servers',auth,async(req,res)=>{
  const{name,icon}=req.body;if(!name) return res.status(400).json({error:'Name required'});
  const id=uuidv4(),ch1=uuidv4(),ch2=uuidv4();
  await q('INSERT INTO servers(id,name,icon,owner_id,created_at) VALUES(?,?,?,?,?)',[id,name,icon||'🌐',req.user.uid,Date.now()]);
  await q('INSERT INTO channels(id,server_id,name,type,topic,position) VALUES(?,?,?,?,?,?)',[ch1,id,'general','text','General chat',0]);
  await q('INSERT INTO channels(id,server_id,name,type,topic,position) VALUES(?,?,?,?,?,?)',[ch2,id,'General Voice','voice','',1]);
  await q('INSERT INTO server_members(server_id,user_id,role) VALUES(?,?,?)',[id,req.user.uid,'admin']);
  res.json({id,name,icon:icon||'🌐',ownerId:req.user.uid,channels:[{id:ch1,name:'general',type:'text',topic:'General chat',position:0},{id:ch2,name:'General Voice',type:'voice',topic:'',position:1}],members:[]});
});

app.post('/api/servers/:sid/join',auth,async(req,res)=>{
  const s=await one('SELECT * FROM servers WHERE id=?',[req.params.sid]);
  if(!s) return res.status(404).json({error:'Not found'});
  await upsert('INSERT INTO server_members(server_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING',[req.params.sid,req.user.uid]);
  res.json({ok:true});
});

app.delete('/api/servers/:sid/leave',auth,async(req,res)=>{
  await q('DELETE FROM server_members WHERE server_id=? AND user_id=?',[req.params.sid,req.user.uid]);
  res.json({ok:true});
});

// ─── Channels ─────────────────────────────────────────────────────────────────
app.post('/api/servers/:sid/channels',auth,async(req,res)=>{
  const{name,type,topic}=req.body;const id=uuidv4();
  const pr=await one('SELECT MAX(position) as m FROM channels WHERE server_id=?',[req.params.sid]);
  const pos=(parseInt(pr?.m||0))+1;
  await q('INSERT INTO channels(id,server_id,name,type,topic,position) VALUES(?,?,?,?,?,?)',[id,req.params.sid,name,type||'text',topic||'',pos]);
  const ch={id,name,type:type||'text',topic:topic||'',position:pos};
  bcast({type:'CHANNEL_CREATE',serverId:req.params.sid,channel:ch});res.json(ch);
});

app.patch('/api/channels/:id',auth,async(req,res)=>{
  const{name,topic}=req.body;
  if(name) await q('UPDATE channels SET name=? WHERE id=?',[name,req.params.id]);
  if(topic!==undefined) await q('UPDATE channels SET topic=? WHERE id=?',[topic,req.params.id]);
  res.json({ok:true});
});

app.delete('/api/channels/:id',auth,async(req,res)=>{
  const ch=await one('SELECT * FROM channels WHERE id=?',[req.params.id]);
  if(!ch) return res.status(404).json({error:'Not found'});
  await q('DELETE FROM channels WHERE id=?',[req.params.id]);
  bcast({type:'CHANNEL_DELETE',serverId:ch.server_id,channelId:req.params.id});res.json({ok:true});
});

// ─── Messages ─────────────────────────────────────────────────────────────────
app.get('/api/channels/:id/messages',auth,async(req,res)=>{
  const msgs=await q('SELECT m.*,u.display_name,u.avatar FROM messages m JOIN users u ON m.author_id=u.id WHERE m.channel_id=? ORDER BY m.created_at DESC LIMIT 80',[req.params.id]);
  msgs.reverse();
  const result=await Promise.all(msgs.map(async m=>{
    const rxns=await q('SELECT emoji,user_id FROM reactions WHERE message_id=?',[m.id]);
    const g={};rxns.forEach(r=>{if(!g[r.emoji])g[r.emoji]=[];g[r.emoji].push(r.user_id);});
    return{id:m.id,channelId:m.channel_id,authorId:m.author_id,authorName:m.display_name,authorAvatar:m.avatar,content:m.content,pinned:!!m.pinned,edited:!!m.edited,replyTo:m.reply_to,timestamp:parseInt(m.created_at),reactions:g};
  }));
  res.json(result);
});

app.post('/api/channels/:id/messages',auth,async(req,res)=>{
  const{content,replyTo}=req.body;if(!content?.trim()) return res.status(400).json({error:'Content required'});
  const mid=uuidv4(),ts=Date.now();
  await q('INSERT INTO messages(id,channel_id,author_id,content,reply_to,created_at) VALUES(?,?,?,?,?,?)',[mid,req.params.id,req.user.uid,content.trim(),replyTo||null,ts]);
  const ch=await one('SELECT server_id FROM channels WHERE id=?',[req.params.id]);
  const msg={id:mid,channelId:req.params.id,authorId:req.user.uid,authorName:req.user.display_name,authorAvatar:req.user.avatar,content:content.trim(),pinned:false,edited:false,replyTo:replyTo||null,timestamp:ts,reactions:{}};
  bcast({type:'MESSAGE_CREATE',message:msg});res.json(msg);
});

app.patch('/api/messages/:id',auth,async(req,res)=>{
  const{content}=req.body;
  const m=await one('SELECT m.*,c.server_id FROM messages m JOIN channels c ON m.channel_id=c.id WHERE m.id=? AND m.author_id=?',[req.params.id,req.user.uid]);
  if(!m) return res.status(403).json({error:'No permission'});
  await q('UPDATE messages SET content=?,edited=1 WHERE id=?',[content,req.params.id]);
  bcast({type:'MESSAGE_UPDATE',messageId:req.params.id,channelId:m.channel_id,content,edited:true});res.json({ok:true});
});

app.delete('/api/messages/:id',auth,async(req,res)=>{
  const m=await one('SELECT m.*,c.server_id FROM messages m JOIN channels c ON m.channel_id=c.id WHERE m.id=?',[req.params.id]);
  if(!m) return res.status(404).json({error:'Not found'});
  if(m.author_id!==req.user.uid) return res.status(403).json({error:'No permission'});
  await q('DELETE FROM messages WHERE id=?',[req.params.id]);
  await q('DELETE FROM reactions WHERE message_id=?',[req.params.id]);
  bcast({type:'MESSAGE_DELETE',messageId:req.params.id,channelId:m.channel_id});res.json({ok:true});
});

app.post('/api/messages/:id/pin',auth,async(req,res)=>{
  const m=await one('SELECT m.*,c.server_id FROM messages m JOIN channels c ON m.channel_id=c.id WHERE m.id=?',[req.params.id]);
  if(!m) return res.status(404).json({error:'Not found'});
  const pinned=!m.pinned;
  await q('UPDATE messages SET pinned=? WHERE id=?',[pinned?1:0,req.params.id]);
  bcast({type:'MESSAGE_PIN',messageId:req.params.id,channelId:m.channel_id,pinned});res.json({ok:true});
});

app.post('/api/messages/:id/react',auth,async(req,res)=>{
  const{emoji}=req.body;
  const ex=await one('SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND emoji=?',[req.params.id,req.user.uid,emoji]);
  if(ex) await q('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?',[req.params.id,req.user.uid,emoji]);
  else await q('INSERT INTO reactions(message_id,user_id,emoji) VALUES(?,?,?)',[req.params.id,req.user.uid,emoji]);
  const all=await q('SELECT emoji,user_id FROM reactions WHERE message_id=?',[req.params.id]);
  const g={};all.forEach(r=>{if(!g[r.emoji])g[r.emoji]=[];g[r.emoji].push(r.user_id);});
  const m=await one('SELECT c.server_id FROM messages m JOIN channels c ON m.channel_id=c.id WHERE m.id=?',[req.params.id]);
  bcast({type:'REACTION_UPDATE',messageId:req.params.id,reactions:g});res.json({reactions:g});
});

// ─── DMs ─────────────────────────────────────────────────────────────────────
app.get('/api/dm/:uid',auth,async(req,res)=>{
  const msgs=await q('SELECT dm.*,u.display_name,u.avatar FROM direct_messages dm JOIN users u ON dm.from_user=u.id WHERE (dm.from_user=? AND dm.to_user=?) OR (dm.from_user=? AND dm.to_user=?) ORDER BY dm.created_at ASC LIMIT 100',
    [req.user.uid,req.params.uid,req.params.uid,req.user.uid]);
  res.json(msgs.map(m=>({id:m.id,authorId:m.from_user,authorName:m.display_name,authorAvatar:m.avatar,content:m.content,timestamp:parseInt(m.created_at)})));
});

app.post('/api/dm/:uid',auth,async(req,res)=>{
  const{content}=req.body;if(!content?.trim()) return res.status(400).json({error:'Content required'});
  const id=uuidv4(),ts=Date.now();
  await q('INSERT INTO direct_messages(id,from_user,to_user,content,created_at) VALUES(?,?,?,?,?)',[id,req.user.uid,req.params.uid,content.trim(),ts]);
  const msg={id,authorId:req.user.uid,authorName:req.user.display_name,authorAvatar:req.user.avatar,content:content.trim(),timestamp:ts};
  const s1=userSockets.get(req.user.uid);const s2=userSockets.get(req.params.uid);
  const data=JSON.stringify({type:'DM_CREATE',toUserId:req.params.uid,fromUserId:req.user.uid,message:msg});
  [s1,s2].forEach(set=>set?.forEach(ws=>{if(ws.readyState===1)ws.send(data);}));
  res.json(msg);
});

// ─── Friends ──────────────────────────────────────────────────────────────────
app.get('/api/friends',auth,async(req,res)=>{
  const uid=req.user.uid;
  const friends=await q('SELECT u.id,u.username,u.display_name,u.avatar,u.status,u.custom_status,f.status as fs FROM friendships f JOIN users u ON (CASE WHEN f.user_a=? THEN f.user_b ELSE f.user_a END)=u.id WHERE f.user_a=? OR f.user_b=?',
    [uid,uid,uid]);
  res.json(friends.map(f=>({id:f.id,username:f.username,displayName:f.display_name,avatar:f.avatar,status:f.status,customStatus:f.custom_status,friendStatus:f.fs})));
});

app.post('/api/friends/:username',auth,async(req,res)=>{
  const t=await one('SELECT * FROM users WHERE username=?',[req.params.username.toLowerCase()]);
  if(!t) return res.status(404).json({error:'User not found'});
  if(t.id===req.user.uid) return res.status(400).json({error:'Cannot friend yourself'});
  const [a,b]=[req.user.uid,t.id].sort();
  await upsert('INSERT INTO friendships(user_a,user_b,status) VALUES(?,?,?) ON CONFLICT DO NOTHING',[a,b,'accepted']);
  sendTo(t.id,{type:'FRIEND_REQUEST',from:{id:req.user.uid,displayName:req.user.display_name,avatar:req.user.avatar}});
  res.json({ok:true});
});

// ─── Invite ───────────────────────────────────────────────────────────────────
app.get('/api/invite/:sid',async(req,res)=>{
  const s=await one('SELECT id,name,icon FROM servers WHERE id=?',[req.params.sid]);
  if(!s) return res.status(404).json({error:'Not found'});
  res.json({serverId:s.id,serverName:s.name,icon:s.icon});
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection',async(ws,req)=>{
  const m=req.headers.cookie?.match(/molecord_session=([^;]+)/);
  if(!m){ws.close();return;}
  const now=Math.floor(Date.now()/1000);
  const sess=await one('SELECT * FROM sessions WHERE id=? AND expires_at>?',[m[1],now]);
  if(!sess){ws.close();return;}
  const uid=sess.user_id;
  wsUsers.set(ws,uid);
  if(!userSockets.has(uid))userSockets.set(uid,new Set());
  userSockets.get(uid).add(ws);
  await q("UPDATE users SET status='online' WHERE id=?",[uid]);
  bcast({type:'USER_STATUS',userId:uid,status:'online'});

  ws.on('message',async raw=>{
    try{
      const d=JSON.parse(raw);
      const uid=wsUsers.get(ws);
      if(!uid)return;

      if(d.type==='TYPING'){
        const u=await one('SELECT display_name FROM users WHERE id=?',[uid]);
        bcast({type:'TYPING',channelId:d.channelId,userId:uid,displayName:u?.display_name});
      }

      // ── Voice join/leave ──
      else if(d.type==='VOICE_JOIN'){
        const{channelId}=d;
        if(!voiceRooms.has(channelId))voiceRooms.set(channelId,new Map());
        const room=voiceRooms.get(channelId);
        // Tell joiner who's already there
        ws.send(JSON.stringify({type:'VOICE_ROOM_STATE',channelId,users:[...room.keys()]}));
        // Tell existing members
        room.forEach((_,existUid)=>sendTo(existUid,{type:'VOICE_USER_JOINED',channelId,userId:uid}));
        room.set(uid,{muted:false});
        bcast({type:'VOICE_PRESENCE',channelId,userId:uid,action:'join'});
      }
      else if(d.type==='VOICE_LEAVE'){
        leaveVoice(uid,d.channelId);
      }

      // ── WebRTC signaling (voice) ──
      else if(['RTC_OFFER','RTC_ANSWER','RTC_ICE'].includes(d.type)){
        sendTo(d.targetUserId,{...d,fromUserId:uid});
      }

      // ── Mute state ──
      else if(d.type==='VOICE_MUTE'){
        const room=voiceRooms.get(d.channelId);
        if(room?.has(uid))room.get(uid).muted=d.muted;
        bcast({type:'VOICE_MUTE',channelId:d.channelId,userId:uid,muted:d.muted});
      }

      // ── Screenshare signaling ──
      else if(d.type==='SCREENSHARE_START'){
        bcast({type:'SCREENSHARE_START',channelId:d.channelId,userId:uid});
      }
      else if(d.type==='SCREENSHARE_STOP'){
        bcast({type:'SCREENSHARE_STOP',channelId:d.channelId,userId:uid});
      }
      else if(['SCREENSHARE_OFFER','SCREENSHARE_ANSWER','SCREENSHARE_ICE'].includes(d.type)){
        sendTo(d.targetUserId,{...d,fromUserId:uid});
      }
    }catch(e){console.error('ws msg err:',e);}
  });

  ws.on('close',async()=>{
    const uid=wsUsers.get(ws);wsUsers.delete(ws);if(!uid)return;
    const s=userSockets.get(uid);
    if(s){s.delete(ws);
      if(s.size===0){
        userSockets.delete(uid);
        await q("UPDATE users SET status='offline' WHERE id=?",[uid]);
        bcast({type:'USER_STATUS',userId:uid,status:'offline'});
        voiceRooms.forEach((_,chId)=>leaveVoice(uid,chId));
      }
    }
  });
});

function leaveVoice(userId,channelId){
  const room=voiceRooms.get(channelId);if(!room||!room.has(userId))return;
  room.delete(userId);
  if(room.size===0)voiceRooms.delete(channelId);
  room.forEach((_,uid)=>sendTo(uid,{type:'VOICE_USER_LEFT',channelId,userId}));
  bcast({type:'VOICE_PRESENCE',channelId,userId,action:'leave'});
}

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

const PORT=process.env.PORT||3000;
initDb().then(()=>seed()).then(()=>{
  server.listen(PORT,()=>console.log(`\n🎵 Molecord running → http://localhost:${PORT}\n`));
}).catch(e=>{console.error('Fatal:',e);process.exit(1);});
