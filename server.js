/**
 * Molecord - Real-time chat with voice, video & screenshare
 * WebRTC signaling server + REST API + SQLite persistence
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new Database('./molecord.db');
db.exec(`
  PRAGMA journal_mode=WAL;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar TEXT DEFAULT '🧑',
    status TEXT DEFAULT 'online',
    custom_status TEXT DEFAULT '',
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT DEFAULT '🌐',
    owner_id TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS server_members (
    server_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    joined_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY(server_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    topic TEXT DEFAULT '',
    position INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    content TEXT NOT NULL,
    pinned INTEGER DEFAULT 0,
    edited INTEGER DEFAULT 0,
    reply_to TEXT,
    created_at INTEGER DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS reactions (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    PRIMARY KEY(message_id, user_id, emoji)
  );

  CREATE TABLE IF NOT EXISTS friendships (
    user_a TEXT NOT NULL,
    user_b TEXT NOT NULL,
    status TEXT DEFAULT 'accepted',
    PRIMARY KEY(user_a, user_b)
  );

  CREATE TABLE IF NOT EXISTS direct_messages (
    id TEXT PRIMARY KEY,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    content TEXT NOT NULL,
    edited INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch() * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

// Seed default server
if (!db.prepare('SELECT id FROM servers LIMIT 1').get()) {
  const sysId = 'system';
  db.prepare(`INSERT OR IGNORE INTO users (id,username,display_name,password_hash,avatar) VALUES (?,?,?,?,?)`)
    .run(sysId, 'molecord_bot', 'Molecord Bot', '$invalid', '🤖');
  const sid = uuidv4();
  db.prepare(`INSERT INTO servers (id,name,icon,owner_id) VALUES (?,?,?,?)`).run(sid, 'Molecord HQ', '🔵', sysId);
  const cids = [uuidv4(), uuidv4(), uuidv4(), uuidv4()];
  db.prepare(`INSERT INTO channels (id,server_id,name,type,topic,position) VALUES (?,?,?,?,?,?)`).run(cids[0], sid, 'general', 'text', 'General chat for everyone', 0);
  db.prepare(`INSERT INTO channels (id,server_id,name,type,topic,position) VALUES (?,?,?,?,?,?)`).run(cids[1], sid, 'introductions', 'text', 'Say hello!', 1);
  db.prepare(`INSERT INTO channels (id,server_id,name,type,topic,position) VALUES (?,?,?,?,?,?)`).run(cids[2], sid, 'General', 'voice', '', 2);
  db.prepare(`INSERT INTO channels (id,server_id,name,type,topic,position) VALUES (?,?,?,?,?,?)`).run(cids[3], sid, 'Gaming', 'voice', '', 3);
  db.prepare(`INSERT INTO messages (id,channel_id,author_id,content) VALUES (?,?,?,?)`)
    .run(uuidv4(), cids[0], sysId, '👋 Welcome to **Molecord**! Create an account and start chatting. Voice channels support real audio and screenshare!');
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  const sid = req.cookies?.mc_session;
  if (!sid) return res.status(401).json({ error: 'Not authenticated' });
  const session = db.prepare(`
    SELECT s.*, u.id as uid, u.username, u.display_name, u.avatar, u.status, u.custom_status
    FROM sessions s JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > unixepoch()
  `).get(sid);
  if (!session) return res.status(401).json({ error: 'Session expired' });
  req.user = session;
  next();
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password || username.length < 2 || password.length < 6)
    return res.status(400).json({ error: 'Username ≥2 chars, password ≥6 chars' });
  const clean = username.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!clean) return res.status(400).json({ error: 'Invalid username' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(clean))
    return res.status(409).json({ error: 'Username taken' });
  const id = uuidv4();
  const avatars = ['🧑','👩','👨','🧔','👱','🧑‍💻','👩‍💻','🧑‍🎤','🧑‍🚀','👾'];
  db.prepare(`INSERT INTO users (id,username,display_name,password_hash,avatar) VALUES (?,?,?,?,?)`)
    .run(id, clean, displayName || username, bcrypt.hashSync(password, 10), avatars[Math.floor(Math.random()*avatars.length)]);
  // Auto-join default server
  const defSrv = db.prepare('SELECT id FROM servers ORDER BY created_at LIMIT 1').get();
  if (defSrv) db.prepare('INSERT OR IGNORE INTO server_members (server_id,user_id) VALUES (?,?)').run(defSrv.id, id);
  const sessionId = uuidv4();
  const expires = Math.floor(Date.now()/1000) + 86400*30;
  db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(sessionId, id, expires);
  res.cookie('mc_session', sessionId, { httpOnly: true, maxAge: 86400*30*1000, sameSite: 'lax' });
  const user = { id, username: clean, displayName: displayName||username, avatar: avatars[0], status: 'online' };
  broadcast(null, { type: 'USER_JOIN', user });
  res.json(user);
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username?.toLowerCase());
  if (!u || !bcrypt.compareSync(password, u.password_hash))
    return res.status(401).json({ error: 'Invalid credentials' });
  db.prepare('UPDATE users SET status=? WHERE id=?').run('online', u.id);
  const sessionId = uuidv4();
  db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(sessionId, u.id, Math.floor(Date.now()/1000)+86400*30);
  res.cookie('mc_session', sessionId, { httpOnly: true, maxAge: 86400*30*1000, sameSite: 'lax' });
  broadcast(null, { type: 'USER_STATUS', userId: u.id, status: 'online' });
  res.json({ id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar, status: 'online', customStatus: u.custom_status });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id=?').run(req.cookies.mc_session);
  db.prepare('UPDATE users SET status=? WHERE id=?').run('offline', req.user.uid);
  res.clearCookie('mc_session');
  broadcast(null, { type: 'USER_STATUS', userId: req.user.uid, status: 'offline' });
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({ id: u.uid, username: u.username, displayName: u.display_name, avatar: u.avatar, status: u.status, customStatus: u.custom_status });
});

// ─── Users ────────────────────────────────────────────────────────────────────
app.get('/api/users', requireAuth, (req, res) => {
  const users = db.prepare(`SELECT id,username,display_name,avatar,status,custom_status FROM users WHERE id!='system'`).all();
  res.json(users.map(u => ({ id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar, status: u.status, customStatus: u.custom_status })));
});

app.patch('/api/users/me', requireAuth, (req, res) => {
  const { displayName, avatar, status, customStatus } = req.body;
  const uid = req.user.uid;
  if (displayName) db.prepare('UPDATE users SET display_name=? WHERE id=?').run(displayName, uid);
  if (avatar) db.prepare('UPDATE users SET avatar=? WHERE id=?').run(avatar, uid);
  if (status) db.prepare('UPDATE users SET status=? WHERE id=?').run(status, uid);
  if (customStatus !== undefined) db.prepare('UPDATE users SET custom_status=? WHERE id=?').run(customStatus, uid);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  broadcast(null, { type: 'USER_UPDATE', user: { id: uid, displayName: u.display_name, avatar: u.avatar, status: u.status, customStatus: u.custom_status } });
  res.json({ ok: true });
});

// ─── Servers ──────────────────────────────────────────────────────────────────
app.get('/api/servers', requireAuth, (req, res) => {
  const srvs = db.prepare(`SELECT s.* FROM servers s JOIN server_members sm ON s.id=sm.server_id WHERE sm.user_id=? ORDER BY s.created_at`).all(req.user.uid);
  res.json(srvs.map(s => ({
    id: s.id, name: s.name, icon: s.icon, ownerId: s.owner_id,
    channels: db.prepare('SELECT * FROM channels WHERE server_id=? ORDER BY position').all(s.id).map(c => ({ id: c.id, name: c.name, type: c.type, topic: c.topic, position: c.position })),
    members: db.prepare(`SELECT u.id,u.username,u.display_name,u.avatar,u.status,u.custom_status,sm.role FROM server_members sm JOIN users u ON sm.user_id=u.id WHERE sm.server_id=? AND u.id!='system'`).all(s.id).map(m => ({ id: m.id, username: m.username, displayName: m.display_name, avatar: m.avatar, status: m.status, customStatus: m.custom_status, role: m.role }))
  })));
});

app.post('/api/servers', requireAuth, (req, res) => {
  const { name, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = uuidv4(); const c1 = uuidv4(); const c2 = uuidv4();
  db.prepare('INSERT INTO servers (id,name,icon,owner_id) VALUES (?,?,?,?)').run(id, name, icon||'🌐', req.user.uid);
  db.prepare('INSERT INTO channels (id,server_id,name,type,topic,position) VALUES (?,?,?,?,?,?)').run(c1, id, 'general', 'text', 'General chat', 0);
  db.prepare('INSERT INTO channels (id,server_id,name,type,topic,position) VALUES (?,?,?,?,?,?)').run(c2, id, 'General', 'voice', '', 1);
  db.prepare('INSERT INTO server_members (server_id,user_id,role) VALUES (?,?,?)').run(id, req.user.uid, 'admin');
  const srv = { id, name, icon: icon||'🌐', ownerId: req.user.uid, channels: [{ id: c1, name: 'general', type: 'text', topic: 'General chat', position: 0 }, { id: c2, name: 'General', type: 'voice', topic: '', position: 1 }], members: [] };
  broadcast(null, { type: 'SERVER_CREATE', server: srv });
  res.json(srv);
});

app.post('/api/servers/:id/join', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  db.prepare('INSERT OR IGNORE INTO server_members (server_id,user_id) VALUES (?,?)').run(req.params.id, req.user.uid);
  broadcast(req.params.id, { type: 'MEMBER_JOIN', serverId: req.params.id, userId: req.user.uid });
  res.json({ ok: true });
});

app.delete('/api/servers/:id/leave', requireAuth, (req, res) => {
  db.prepare('DELETE FROM server_members WHERE server_id=? AND user_id=?').run(req.params.id, req.user.uid);
  res.json({ ok: true });
});

// ─── Channels ─────────────────────────────────────────────────────────────────
app.post('/api/servers/:sid/channels', requireAuth, (req, res) => {
  const { name, type, topic } = req.body;
  const id = uuidv4();
  const pos = (db.prepare('SELECT MAX(position) as m FROM channels WHERE server_id=?').get(req.params.sid).m || 0) + 1;
  db.prepare('INSERT INTO channels (id,server_id,name,type,topic,position) VALUES (?,?,?,?,?,?)').run(id, req.params.sid, name, type||'text', topic||'', pos);
  const ch = { id, name, type: type||'text', topic: topic||'', position: pos };
  broadcast(req.params.sid, { type: 'CHANNEL_CREATE', serverId: req.params.sid, channel: ch });
  res.json(ch);
});

app.patch('/api/channels/:id', requireAuth, (req, res) => {
  const { name, topic } = req.body;
  if (name) db.prepare('UPDATE channels SET name=? WHERE id=?').run(name, req.params.id);
  if (topic !== undefined) db.prepare('UPDATE channels SET topic=? WHERE id=?').run(topic, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/channels/:id', requireAuth, (req, res) => {
  const ch = db.prepare('SELECT * FROM channels WHERE id=?').get(req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM channels WHERE id=?').run(req.params.id);
  broadcast(ch.server_id, { type: 'CHANNEL_DELETE', serverId: ch.server_id, channelId: req.params.id });
  res.json({ ok: true });
});

// ─── Messages ─────────────────────────────────────────────────────────────────
app.get('/api/channels/:id/messages', requireAuth, (req, res) => {
  const msgs = db.prepare(`SELECT m.*,u.display_name,u.avatar FROM messages m JOIN users u ON m.author_id=u.id WHERE m.channel_id=? ORDER BY m.created_at DESC LIMIT 100`).all(req.params.id).reverse();
  res.json(msgs.map(m => {
    const rxns = db.prepare('SELECT emoji,user_id FROM reactions WHERE message_id=?').all(m.id);
    const grouped = {};
    rxns.forEach(r => { if (!grouped[r.emoji]) grouped[r.emoji] = []; grouped[r.emoji].push(r.user_id); });
    return { id: m.id, channelId: m.channel_id, authorId: m.author_id, authorName: m.display_name, authorAvatar: m.avatar, content: m.content, pinned: !!m.pinned, edited: !!m.edited, replyTo: m.reply_to, timestamp: m.created_at, reactions: grouped };
  }));
});

app.post('/api/channels/:id/messages', requireAuth, (req, res) => {
  const { content, replyTo } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Empty' });
  const id = uuidv4(); const ts = Date.now();
  db.prepare('INSERT INTO messages (id,channel_id,author_id,content,reply_to,created_at) VALUES (?,?,?,?,?,?)').run(id, req.params.id, req.user.uid, content.trim(), replyTo||null, ts);
  const ch = db.prepare('SELECT server_id FROM channels WHERE id=?').get(req.params.id);
  const msg = { id, channelId: req.params.id, authorId: req.user.uid, authorName: req.user.display_name, authorAvatar: req.user.avatar, content: content.trim(), pinned: false, edited: false, replyTo: replyTo||null, timestamp: ts, reactions: {} };
  broadcast(ch?.server_id, { type: 'MESSAGE_CREATE', message: msg });
  res.json(msg);
});

app.patch('/api/messages/:id', requireAuth, (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id=? AND author_id=?').get(req.params.id, req.user.uid);
  if (!msg) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('UPDATE messages SET content=?,edited=1 WHERE id=?').run(req.body.content, req.params.id);
  const ch = db.prepare('SELECT server_id FROM channels WHERE id=?').get(msg.channel_id);
  broadcast(ch?.server_id, { type: 'MESSAGE_UPDATE', messageId: req.params.id, channelId: msg.channel_id, content: req.body.content, edited: true });
  res.json({ ok: true });
});

app.delete('/api/messages/:id', requireAuth, (req, res) => {
  const msg = db.prepare('SELECT m.*,c.server_id FROM messages m JOIN channels c ON m.channel_id=c.id WHERE m.id=?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  const isAdmin = db.prepare('SELECT role FROM server_members WHERE server_id=? AND user_id=?').get(msg.server_id, req.user.uid);
  if (msg.author_id !== req.user.uid && isAdmin?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM messages WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM reactions WHERE message_id=?').run(req.params.id);
  broadcast(msg.server_id, { type: 'MESSAGE_DELETE', messageId: req.params.id, channelId: msg.channel_id });
  res.json({ ok: true });
});

app.post('/api/messages/:id/pin', requireAuth, (req, res) => {
  const msg = db.prepare('SELECT m.*,c.server_id FROM messages m JOIN channels c ON m.channel_id=c.id WHERE m.id=?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  const pinned = !msg.pinned;
  db.prepare('UPDATE messages SET pinned=? WHERE id=?').run(pinned?1:0, req.params.id);
  broadcast(msg.server_id, { type: 'MESSAGE_PIN', messageId: req.params.id, channelId: msg.channel_id, pinned });
  res.json({ ok: true });
});

app.post('/api/messages/:id/react', requireAuth, (req, res) => {
  const { emoji } = req.body;
  const existing = db.prepare('SELECT * FROM reactions WHERE message_id=? AND user_id=? AND emoji=?').get(req.params.id, req.user.uid, emoji);
  if (existing) db.prepare('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?').run(req.params.id, req.user.uid, emoji);
  else db.prepare('INSERT INTO reactions (message_id,user_id,emoji) VALUES (?,?,?)').run(req.params.id, req.user.uid, emoji);
  const all = db.prepare('SELECT emoji,user_id FROM reactions WHERE message_id=?').all(req.params.id);
  const grouped = {};
  all.forEach(r => { if (!grouped[r.emoji]) grouped[r.emoji] = []; grouped[r.emoji].push(r.user_id); });
  const ch = db.prepare('SELECT c.server_id FROM messages m JOIN channels c ON m.channel_id=c.id WHERE m.id=?').get(req.params.id);
  broadcast(ch?.server_id, { type: 'REACTION_UPDATE', messageId: req.params.id, reactions: grouped });
  res.json({ reactions: grouped });
});

// ─── DMs ─────────────────────────────────────────────────────────────────────
app.get('/api/dm/:uid', requireAuth, (req, res) => {
  const msgs = db.prepare(`SELECT dm.*,u.display_name,u.avatar FROM direct_messages dm JOIN users u ON dm.from_user=u.id WHERE (dm.from_user=? AND dm.to_user=?) OR (dm.from_user=? AND dm.to_user=?) ORDER BY dm.created_at ASC LIMIT 100`).all(req.user.uid, req.params.uid, req.params.uid, req.user.uid);
  res.json(msgs.map(m => ({ id: m.id, authorId: m.from_user, authorName: m.display_name, authorAvatar: m.avatar, content: m.content, timestamp: m.created_at, edited: !!m.edited, reactions: {} })));
});

app.post('/api/dm/:uid', requireAuth, (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Empty' });
  const id = uuidv4(); const ts = Date.now();
  db.prepare('INSERT INTO direct_messages (id,from_user,to_user,content,created_at) VALUES (?,?,?,?,?)').run(id, req.user.uid, req.params.uid, content.trim(), ts);
  const msg = { id, authorId: req.user.uid, authorName: req.user.display_name, authorAvatar: req.user.avatar, content: content.trim(), timestamp: ts, edited: false, reactions: {} };
  broadcastToUsers([req.user.uid, req.params.uid], { type: 'DM_CREATE', toUserId: req.params.uid, fromUserId: req.user.uid, message: msg });
  res.json(msg);
});

// ─── Friends ──────────────────────────────────────────────────────────────────
app.get('/api/friends', requireAuth, (req, res) => {
  const friends = db.prepare(`SELECT u.id,u.username,u.display_name,u.avatar,u.status,u.custom_status FROM friendships f JOIN users u ON (CASE WHEN f.user_a=? THEN f.user_b ELSE f.user_a END)=u.id WHERE f.user_a=? OR f.user_b=?`).all(req.user.uid, req.user.uid, req.user.uid);
  res.json(friends.map(u => ({ id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar, status: u.status, customStatus: u.custom_status, friendStatus: 'accepted' })));
});

app.post('/api/friends/:username', requireAuth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username=?').get(req.params.username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.uid) return res.status(400).json({ error: 'Cannot friend yourself' });
  const [a, b] = [req.user.uid, target.id].sort();
  db.prepare('INSERT OR IGNORE INTO friendships (user_a,user_b,status) VALUES (?,?,?)').run(a, b, 'accepted');
  broadcastToUsers([target.id], { type: 'FRIEND_ADD', from: { id: req.user.uid, displayName: req.user.display_name, avatar: req.user.avatar } });
  res.json({ ok: true });
});

app.get('/api/invite/:sid', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.sid);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ serverId: s.id, serverName: s.name, icon: s.icon });
});

// ─── WebSocket + WebRTC Signaling ────────────────────────────────────────────
// userId -> Set<ws>
const userSockets = new Map();
// ws -> userId
const wsUsers = new Map();
// channelId -> Map<userId, { muted, deafened, screensharing, video }>
const voiceRooms = new Map();

function broadcast(serverId, data) {
  const msg = JSON.stringify(data);
  if (serverId) {
    const members = db.prepare('SELECT user_id FROM server_members WHERE server_id=?').all(serverId);
    for (const m of members) {
      const sockets = userSockets.get(m.user_id);
      if (sockets) sockets.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
    }
  } else {
    wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
  }
}

function broadcastToUsers(userIds, data) {
  const msg = JSON.stringify(data);
  for (const uid of userIds) {
    const sockets = userSockets.get(uid);
    if (sockets) sockets.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
  }
}

function sendToUser(userId, data) {
  const msg = JSON.stringify(data);
  const sockets = userSockets.get(userId);
  if (sockets) sockets.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

function getVoiceRoomParticipants(channelId) {
  const room = voiceRooms.get(channelId);
  if (!room) return [];
  return Array.from(room.entries()).map(([uid, state]) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
    return { userId: uid, displayName: u?.display_name || 'Unknown', avatar: u?.avatar || '👤', ...state };
  });
}

wss.on('connection', (ws, req) => {
  const cookieStr = req.headers.cookie || '';
  const match = cookieStr.match(/mc_session=([^;]+)/);
  const sessionId = match?.[1];
  if (!sessionId) { ws.close(); return; }
  const session = db.prepare('SELECT * FROM sessions WHERE id=? AND expires_at>unixepoch()').get(sessionId);
  if (!session) { ws.close(); return; }
  const userId = session.user_id;
  wsUsers.set(ws, userId);
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(ws);
  db.prepare('UPDATE users SET status=? WHERE id=?').run('online', userId);
  broadcast(null, { type: 'USER_STATUS', userId, status: 'online' });

  ws.on('message', raw => {
    try {
      const data = JSON.parse(raw);
      const uid = wsUsers.get(ws);
      if (!uid) return;

      switch (data.type) {
        // ── Chat ──
        case 'TYPING':
          const user = db.prepare('SELECT display_name FROM users WHERE id=?').get(uid);
          broadcast(data.serverId, { type: 'TYPING', channelId: data.channelId, userId: uid, displayName: user?.display_name });
          break;

        // ── Voice: join channel ──
        case 'VOICE_JOIN': {
          const { channelId, serverId } = data;
          // Leave any existing voice room
          voiceRooms.forEach((room, chId) => {
            if (room.has(uid)) {
              room.delete(uid);
              broadcast(serverId, { type: 'VOICE_LEAVE', channelId: chId, userId: uid });
              broadcast(serverId, { type: 'VOICE_ROOM_UPDATE', channelId: chId, participants: getVoiceRoomParticipants(chId) });
            }
          });
          if (!voiceRooms.has(channelId)) voiceRooms.set(channelId, new Map());
          const room = voiceRooms.get(channelId);
          const existingUsers = Array.from(room.keys());
          room.set(uid, { muted: false, deafened: false, screensharing: false, video: false });
          // Notify others in room to initiate WebRTC connection to new user
          for (const existingUid of existingUsers) {
            sendToUser(existingUid, { type: 'VOICE_USER_JOINED', channelId, userId: uid });
            // Tell new user to create offers to everyone already there
            sendToUser(uid, { type: 'VOICE_INITIATE_OFFER', channelId, targetUserId: existingUid });
          }
          broadcast(serverId, { type: 'VOICE_JOIN', channelId, userId: uid });
          broadcast(serverId, { type: 'VOICE_ROOM_UPDATE', channelId, participants: getVoiceRoomParticipants(channelId) });
          break;
        }

        // ── Voice: leave channel ──
        case 'VOICE_LEAVE': {
          const { channelId, serverId } = data;
          const room = voiceRooms.get(channelId);
          if (room) {
            room.delete(uid);
            if (room.size === 0) voiceRooms.delete(channelId);
          }
          broadcast(serverId, { type: 'VOICE_LEAVE', channelId, userId: uid });
          broadcast(serverId, { type: 'VOICE_ROOM_UPDATE', channelId, participants: getVoiceRoomParticipants(channelId) });
          break;
        }

        // ── Voice: state update (mute/deafen/screenshare) ──
        case 'VOICE_STATE': {
          const { channelId, serverId, muted, deafened, screensharing, video } = data;
          const room = voiceRooms.get(channelId);
          if (room && room.has(uid)) {
            room.set(uid, { muted, deafened, screensharing, video });
            broadcast(serverId, { type: 'VOICE_STATE_UPDATE', channelId, userId: uid, muted, deafened, screensharing, video });
            broadcast(serverId, { type: 'VOICE_ROOM_UPDATE', channelId, participants: getVoiceRoomParticipants(channelId) });
          }
          break;
        }

        // ── WebRTC Signaling (relay between peers) ──
        case 'RTC_OFFER':
        case 'RTC_ANSWER':
        case 'RTC_ICE':
          // Relay directly to target user
          if (data.targetUserId) {
            sendToUser(data.targetUserId, { ...data, fromUserId: uid });
          }
          break;
      }
    } catch (e) { /* ignore parse errors */ }
  });

  ws.on('close', () => {
    const uid = wsUsers.get(ws);
    wsUsers.delete(ws);
    if (!uid) return;
    const sockets = userSockets.get(uid);
    if (sockets) {
      sockets.delete(ws);
      if (sockets.size === 0) {
        userSockets.delete(uid);
        // Remove from all voice rooms
        voiceRooms.forEach((room, channelId) => {
          if (room.has(uid)) {
            room.delete(uid);
            broadcast(null, { type: 'VOICE_LEAVE', channelId, userId: uid });
            broadcast(null, { type: 'VOICE_ROOM_UPDATE', channelId, participants: getVoiceRoomParticipants(channelId) });
          }
        });
        db.prepare('UPDATE users SET status=? WHERE id=?').run('offline', uid);
        broadcast(null, { type: 'USER_STATUS', userId: uid, status: 'offline' });
      }
    }
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🔵 Molecord running → http://localhost:${PORT}\n`));
