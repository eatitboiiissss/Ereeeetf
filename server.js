/**
 * Chord - Discord Knockoff
 * Real multiplayer server with SQLite persistence + WebSocket live updates
 * Run: npm install && node server.js
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── Database Setup ───────────────────────────────────────────────────────────
const db = new Database('./chord.db');

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
    created_at INTEGER DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT DEFAULT '🌐',
    owner_id TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY(owner_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS server_members (
    server_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    joined_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY(server_id, user_id),
    FOREIGN KEY(server_id) REFERENCES servers(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    topic TEXT DEFAULT '',
    position INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY(server_id) REFERENCES servers(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    content TEXT NOT NULL,
    pinned INTEGER DEFAULT 0,
    edited INTEGER DEFAULT 0,
    reply_to TEXT,
    created_at INTEGER DEFAULT (unixepoch() * 1000),
    FOREIGN KEY(channel_id) REFERENCES channels(id),
    FOREIGN KEY(author_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS reactions (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    PRIMARY KEY(message_id, user_id, emoji),
    FOREIGN KEY(message_id) REFERENCES messages(id)
  );

  CREATE TABLE IF NOT EXISTS friendships (
    user_a TEXT NOT NULL,
    user_b TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY(user_a, user_b),
    FOREIGN KEY(user_a) REFERENCES users(id),
    FOREIGN KEY(user_b) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS direct_messages (
    id TEXT PRIMARY KEY,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    content TEXT NOT NULL,
    edited INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch() * 1000),
    FOREIGN KEY(from_user) REFERENCES users(id),
    FOREIGN KEY(to_user) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS dm_reactions (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    PRIMARY KEY(message_id, user_id, emoji)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_members_server ON server_members(server_id);
  CREATE INDEX IF NOT EXISTS idx_dm_users ON direct_messages(from_user, to_user);
`);

// Seed default server if empty
const serverCount = db.prepare('SELECT COUNT(*) as c FROM servers').get();
if (serverCount.c === 0) {
  const sysId = 'system';
  // Create system user
  db.prepare(`INSERT OR IGNORE INTO users (id, username, display_name, password_hash, avatar) VALUES (?,?,?,?,?)`)
    .run(sysId, 'chord_bot', 'Chord Bot', '$2a$10$invalid', '🤖');
  
  const serverId = uuidv4();
  db.prepare(`INSERT INTO servers (id, name, icon, owner_id) VALUES (?,?,?,?)`)
    .run(serverId, 'Chord HQ 🎵', '🎵', sysId);
  
  const channels = [
    { id: uuidv4(), name: 'general', type: 'text', topic: 'General chat for everyone', pos: 0 },
    { id: uuidv4(), name: 'introductions', type: 'text', topic: 'Say hello!', pos: 1 },
    { id: uuidv4(), name: 'off-topic', type: 'text', topic: 'Anything goes!', pos: 2 },
    { id: uuidv4(), name: 'General Voice', type: 'voice', topic: '', pos: 3 },
  ];
  
  for (const ch of channels) {
    db.prepare(`INSERT INTO channels (id, server_id, name, type, topic, position) VALUES (?,?,?,?,?,?)`)
      .run(ch.id, serverId, ch.name, ch.type, ch.topic, ch.pos);
  }
  
  // Welcome message
  const welcomeId = uuidv4();
  db.prepare(`INSERT INTO messages (id, channel_id, author_id, content) VALUES (?,?,?,?)`)
    .run(welcomeId, channels[0].id, sysId, '👋 Welcome to **Chord HQ**! Create an account and start chatting with real people.');
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Session auth middleware
function requireAuth(req, res, next) {
  const sessionId = req.cookies?.chord_session;
  if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });
  
  const session = db.prepare(`
    SELECT s.*, u.id as user_id, u.username, u.display_name, u.avatar, u.status, u.custom_status
    FROM sessions s JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > unixepoch()
  `).get(sessionId);
  
  if (!session) return res.status(401).json({ error: 'Session expired' });
  req.user = session;
  next();
}

// ─── Auth Routes ─────────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password || username.length < 2 || password.length < 6)
    return res.status(400).json({ error: 'Username min 2 chars, password min 6 chars' });
  
  const clean = username.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!clean) return res.status(400).json({ error: 'Invalid username' });
  
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(clean);
  if (existing) return res.status(409).json({ error: 'Username already taken' });
  
  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  const avatars = ['🧑','👩','👨','🧔','👱','🧑‍💻','👩‍💻','🧑‍🎤','👩‍🎤','🧑‍🚀'];
  const avatar = avatars[Math.floor(Math.random() * avatars.length)];
  
  db.prepare(`INSERT INTO users (id, username, display_name, password_hash, avatar) VALUES (?,?,?,?,?)`)
    .run(id, clean, displayName || username, hash, avatar);
  
  // Auto-join the default server
  const defaultServer = db.prepare('SELECT id FROM servers ORDER BY created_at LIMIT 1').get();
  if (defaultServer) {
    db.prepare('INSERT OR IGNORE INTO server_members (server_id, user_id) VALUES (?,?)').run(defaultServer.id, id);
  }
  
  const sessionId = uuidv4();
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30 days
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)').run(sessionId, id, expires);
  
  res.cookie('chord_session', sessionId, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000, sameSite: 'lax' });
  res.json({ id, username: clean, displayName: displayName || username, avatar });
  
  broadcast(null, { type: 'USER_JOIN', user: { id, username: clean, displayName: displayName || username, avatar, status: 'online' } });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username?.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid username or password' });
  
  // Update status to online
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run('online', user.id);
  
  const sessionId = uuidv4();
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)').run(sessionId, user.id, expires);
  
  res.cookie('chord_session', sessionId, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000, sameSite: 'lax' });
  res.json({ id: user.id, username: user.username, displayName: user.display_name, avatar: user.avatar });
  
  broadcast(null, { type: 'USER_STATUS', userId: user.id, status: 'online' });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.cookies.chord_session);
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run('offline', req.user.user_id);
  res.clearCookie('chord_session');
  res.json({ ok: true });
  broadcast(null, { type: 'USER_STATUS', userId: req.user.user_id, status: 'offline' });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({ id: u.user_id, username: u.username, displayName: u.display_name, avatar: u.avatar, status: u.status, customStatus: u.custom_status });
});

// ─── User Routes ─────────────────────────────────────────────────────────────
app.patch('/api/users/me', requireAuth, (req, res) => {
  const { displayName, avatar, status, customStatus } = req.body;
  const uid = req.user.user_id;
  
  if (displayName) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, uid);
  if (avatar) db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, uid);
  if (status) db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, uid);
  if (customStatus !== undefined) db.prepare('UPDATE users SET custom_status = ? WHERE id = ?').run(customStatus, uid);
  
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  broadcast(null, { type: 'USER_UPDATE', user: { id: uid, displayName: updated.display_name, avatar: updated.avatar, status: updated.status, customStatus: updated.custom_status } });
  res.json({ ok: true });
});

app.get('/api/users', requireAuth, (req, res) => {
  const users = db.prepare('SELECT id, username, display_name, avatar, status, custom_status FROM users WHERE id != ?').all('system');
  res.json(users.map(u => ({ id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar, status: u.status, customStatus: u.custom_status })));
});

// ─── Server Routes ────────────────────────────────────────────────────────────
app.get('/api/servers', requireAuth, (req, res) => {
  const servers = db.prepare(`
    SELECT s.* FROM servers s
    JOIN server_members sm ON s.id = sm.server_id
    WHERE sm.user_id = ?
    ORDER BY s.created_at
  `).all(req.user.user_id);
  
  const result = servers.map(s => {
    const channels = db.prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY position').all(s.id);
    const members = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.avatar, u.status, u.custom_status, sm.role
      FROM server_members sm JOIN users u ON sm.user_id = u.id
      WHERE sm.server_id = ?
    `).all(s.id);
    return {
      id: s.id, name: s.name, icon: s.icon, ownerId: s.owner_id,
      channels: channels.map(c => ({ id: c.id, name: c.name, type: c.type, topic: c.topic, position: c.position })),
      members: members.map(m => ({ id: m.id, username: m.username, displayName: m.display_name, avatar: m.avatar, status: m.status, customStatus: m.custom_status, role: m.role }))
    };
  });
  res.json(result);
});

app.post('/api/servers', requireAuth, (req, res) => {
  const { name, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  
  const id = uuidv4();
  db.prepare('INSERT INTO servers (id, name, icon, owner_id) VALUES (?,?,?,?)').run(id, name, icon || '🌐', req.user.user_id);
  
  const ch1 = uuidv4(); const ch2 = uuidv4();
  db.prepare('INSERT INTO channels (id, server_id, name, type, topic, position) VALUES (?,?,?,?,?,?)').run(ch1, id, 'general', 'text', 'General chat', 0);
  db.prepare('INSERT INTO channels (id, server_id, name, type, topic, position) VALUES (?,?,?,?,?,?)').run(ch2, id, 'General Voice', 'voice', '', 1);
  db.prepare('INSERT INTO server_members (server_id, user_id, role) VALUES (?,?,?)').run(id, req.user.user_id, 'admin');
  
  const newServer = {
    id, name, icon: icon || '🌐', ownerId: req.user.user_id,
    channels: [{ id: ch1, name: 'general', type: 'text', topic: 'General chat', position: 0 }, { id: ch2, name: 'General Voice', type: 'voice', topic: '', position: 1 }],
    members: [{ id: req.user.user_id, role: 'admin' }]
  };
  broadcast(null, { type: 'SERVER_CREATE', server: newServer });
  res.json(newServer);
});

app.post('/api/servers/:serverId/join', requireAuth, (req, res) => {
  const { serverId } = req.params;
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  db.prepare('INSERT OR IGNORE INTO server_members (server_id, user_id) VALUES (?,?)').run(serverId, req.user.user_id);
  broadcast(serverId, { type: 'MEMBER_JOIN', serverId, userId: req.user.user_id });
  res.json({ ok: true });
});

app.delete('/api/servers/:serverId/leave', requireAuth, (req, res) => {
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(req.params.serverId, req.user.user_id);
  res.json({ ok: true });
});

// ─── Channel Routes ───────────────────────────────────────────────────────────
app.post('/api/servers/:serverId/channels', requireAuth, (req, res) => {
  const { name, type, topic } = req.body;
  const member = db.prepare('SELECT role FROM server_members WHERE server_id = ? AND user_id = ?').get(req.params.serverId, req.user.user_id);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  
  const id = uuidv4();
  const pos = db.prepare('SELECT MAX(position) as m FROM channels WHERE server_id = ?').get(req.params.serverId).m + 1 || 0;
  db.prepare('INSERT INTO channels (id, server_id, name, type, topic, position) VALUES (?,?,?,?,?,?)').run(id, req.params.serverId, name, type || 'text', topic || '', pos);
  
  const ch = { id, name, type: type || 'text', topic: topic || '', position: pos };
  broadcast(req.params.serverId, { type: 'CHANNEL_CREATE', serverId: req.params.serverId, channel: ch });
  res.json(ch);
});

app.patch('/api/channels/:channelId', requireAuth, (req, res) => {
  const { name, topic } = req.body;
  if (name) db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(name, req.params.channelId);
  if (topic !== undefined) db.prepare('UPDATE channels SET topic = ? WHERE id = ?').run(topic, req.params.channelId);
  res.json({ ok: true });
});

app.delete('/api/channels/:channelId', requireAuth, (req, res) => {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.channelId);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM channels WHERE id = ?').run(req.params.channelId);
  broadcast(ch.server_id, { type: 'CHANNEL_DELETE', serverId: ch.server_id, channelId: req.params.channelId });
  res.json({ ok: true });
});

// ─── Message Routes ───────────────────────────────────────────────────────────
app.get('/api/channels/:channelId/messages', requireAuth, (req, res) => {
  const { before, limit = 50 } = req.query;
  let query = `SELECT m.*, u.display_name, u.avatar, u.username FROM messages m JOIN users u ON m.author_id = u.id WHERE m.channel_id = ?`;
  const params = [req.params.channelId];
  if (before) { query += ` AND m.created_at < ?`; params.push(before); }
  query += ` ORDER BY m.created_at DESC LIMIT ?`;
  params.push(parseInt(limit));
  
  const messages = db.prepare(query).all(...params).reverse();
  
  const result = messages.map(m => {
    const reactions = db.prepare('SELECT emoji, user_id FROM reactions WHERE message_id = ?').all(m.id);
    const grouped = {};
    for (const r of reactions) {
      if (!grouped[r.emoji]) grouped[r.emoji] = [];
      grouped[r.emoji].push(r.user_id);
    }
    return { id: m.id, channelId: m.channel_id, authorId: m.author_id, authorName: m.display_name, authorAvatar: m.avatar, content: m.content, pinned: !!m.pinned, edited: !!m.edited, replyTo: m.reply_to, timestamp: m.created_at, reactions: grouped };
  });
  res.json(result);
});

app.post('/api/channels/:channelId/messages', requireAuth, (req, res) => {
  const { content, replyTo } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
  
  const id = uuidv4();
  const ts = Date.now();
  db.prepare('INSERT INTO messages (id, channel_id, author_id, content, reply_to, created_at) VALUES (?,?,?,?,?,?)').run(id, req.params.channelId, req.user.user_id, content.trim(), replyTo || null, ts);
  
  const ch = db.prepare('SELECT server_id FROM channels WHERE id = ?').get(req.params.channelId);
  const msg = {
    id, channelId: req.params.channelId, authorId: req.user.user_id,
    authorName: req.user.display_name, authorAvatar: req.user.avatar,
    content: content.trim(), pinned: false, edited: false, replyTo: replyTo || null,
    timestamp: ts, reactions: {}
  };
  broadcast(ch?.server_id, { type: 'MESSAGE_CREATE', message: msg });
  res.json(msg);
});

app.patch('/api/messages/:messageId', requireAuth, (req, res) => {
  const { content } = req.body;
  const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND author_id = ?').get(req.params.messageId, req.user.user_id);
  if (!msg) return res.status(403).json({ error: 'Not your message' });
  db.prepare('UPDATE messages SET content = ?, edited = 1 WHERE id = ?').run(content, req.params.messageId);
  const ch = db.prepare('SELECT server_id FROM channels WHERE id = ?').get(msg.channel_id);
  broadcast(ch?.server_id, { type: 'MESSAGE_UPDATE', messageId: req.params.messageId, channelId: msg.channel_id, content, edited: true });
  res.json({ ok: true });
});

app.delete('/api/messages/:messageId', requireAuth, (req, res) => {
  const msg = db.prepare('SELECT m.*, c.server_id FROM messages m JOIN channels c ON m.channel_id = c.id WHERE m.id = ?').get(req.params.messageId);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  
  // Allow author or server admin
  const isAdmin = db.prepare('SELECT role FROM server_members WHERE server_id = ? AND user_id = ?').get(msg.server_id, req.user.user_id);
  if (msg.author_id !== req.user.user_id && isAdmin?.role !== 'admin')
    return res.status(403).json({ error: 'No permission' });
  
  db.prepare('DELETE FROM messages WHERE id = ?').run(req.params.messageId);
  db.prepare('DELETE FROM reactions WHERE message_id = ?').run(req.params.messageId);
  broadcast(msg.server_id, { type: 'MESSAGE_DELETE', messageId: req.params.messageId, channelId: msg.channel_id });
  res.json({ ok: true });
});

app.post('/api/messages/:messageId/pin', requireAuth, (req, res) => {
  const msg = db.prepare('SELECT m.*, c.server_id FROM messages m JOIN channels c ON m.channel_id = c.id WHERE m.id = ?').get(req.params.messageId);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  const pinned = !msg.pinned;
  db.prepare('UPDATE messages SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, req.params.messageId);
  broadcast(msg.server_id, { type: 'MESSAGE_PIN', messageId: req.params.messageId, channelId: msg.channel_id, pinned });
  res.json({ ok: true });
});

app.post('/api/messages/:messageId/react', requireAuth, (req, res) => {
  const { emoji } = req.body;
  const existing = db.prepare('SELECT * FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(req.params.messageId, req.user.user_id, emoji);
  
  if (existing) {
    db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(req.params.messageId, req.user.user_id, emoji);
  } else {
    db.prepare('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?,?,?)').run(req.params.messageId, req.user.user_id, emoji);
  }
  
  const all = db.prepare('SELECT emoji, user_id FROM reactions WHERE message_id = ?').all(req.params.messageId);
  const grouped = {};
  for (const r of all) { if (!grouped[r.emoji]) grouped[r.emoji] = []; grouped[r.emoji].push(r.user_id); }
  
  const msg = db.prepare('SELECT c.server_id FROM messages m JOIN channels c ON m.channel_id = c.id WHERE m.id = ?').get(req.params.messageId);
  broadcast(msg?.server_id, { type: 'REACTION_UPDATE', messageId: req.params.messageId, reactions: grouped });
  res.json({ reactions: grouped });
});

// ─── Direct Messages ──────────────────────────────────────────────────────────
app.get('/api/dm/:userId', requireAuth, (req, res) => {
  const messages = db.prepare(`
    SELECT dm.*, u.display_name, u.avatar FROM direct_messages dm
    JOIN users u ON dm.from_user = u.id
    WHERE (dm.from_user = ? AND dm.to_user = ?) OR (dm.from_user = ? AND dm.to_user = ?)
    ORDER BY dm.created_at ASC LIMIT 100
  `).all(req.user.user_id, req.params.userId, req.params.userId, req.user.user_id);
  
  res.json(messages.map(m => ({ id: m.id, authorId: m.from_user, authorName: m.display_name, authorAvatar: m.avatar, content: m.content, timestamp: m.created_at, edited: !!m.edited, reactions: {} })));
});

app.post('/api/dm/:userId', requireAuth, (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
  
  const id = uuidv4();
  const ts = Date.now();
  db.prepare('INSERT INTO direct_messages (id, from_user, to_user, content, created_at) VALUES (?,?,?,?,?)').run(id, req.user.user_id, req.params.userId, content.trim(), ts);
  
  const msg = { id, authorId: req.user.user_id, authorName: req.user.display_name, authorAvatar: req.user.avatar, content: content.trim(), timestamp: ts, edited: false, reactions: {} };
  
  // Send to both users via WS
  broadcastToUsers([req.user.user_id, req.params.userId], { type: 'DM_CREATE', toUserId: req.params.userId, fromUserId: req.user.user_id, message: msg });
  res.json(msg);
});

// ─── Friends ──────────────────────────────────────────────────────────────────
app.get('/api/friends', requireAuth, (req, res) => {
  const friends = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar, u.status, u.custom_status, f.status as fs
    FROM friendships f
    JOIN users u ON (CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END) = u.id
    WHERE f.user_a = ? OR f.user_b = ?
  `).all(req.user.user_id, req.user.user_id, req.user.user_id);
  
  res.json(friends.map(f => ({ id: f.id, username: f.username, displayName: f.display_name, avatar: f.avatar, status: f.status, customStatus: f.custom_status, friendStatus: f.fs })));
});

app.post('/api/friends/:username', requireAuth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.user_id) return res.status(400).json({ error: 'Cannot friend yourself' });
  
  const [a, b] = [req.user.user_id, target.id].sort();
  db.prepare('INSERT OR IGNORE INTO friendships (user_a, user_b, status) VALUES (?,?,?)').run(a, b, 'accepted');
  
  broadcastToUsers([target.id], { type: 'FRIEND_REQUEST', from: { id: req.user.user_id, displayName: req.user.display_name, avatar: req.user.avatar } });
  res.json({ ok: true });
});

// ─── Invite system ────────────────────────────────────────────────────────────
app.get('/api/invite/:serverId', requireAuth, (req, res) => {
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  res.json({ serverId: server.id, serverName: server.name, icon: server.icon });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
// Map: userId -> Set of WebSocket clients
const userSockets = new Map();
// Map: ws -> userId  
const wsUsers = new Map();

function broadcast(serverId, data) {
  const msg = JSON.stringify(data);
  if (serverId) {
    // Only to members of this server
    const members = db.prepare('SELECT user_id FROM server_members WHERE server_id = ?').all(serverId);
    for (const m of members) {
      const sockets = userSockets.get(m.user_id);
      if (sockets) sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
    }
  } else {
    // To all connected
    wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
  }
}

function broadcastToUsers(userIds, data) {
  const msg = JSON.stringify(data);
  for (const uid of userIds) {
    const sockets = userSockets.get(uid);
    if (sockets) sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
  }
}

wss.on('connection', (ws, req) => {
  // Parse session cookie
  const cookieStr = req.headers.cookie || '';
  const match = cookieStr.match(/chord_session=([^;]+)/);
  const sessionId = match?.[1];
  
  if (!sessionId) { ws.close(); return; }
  
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > unixepoch()').get(sessionId);
  if (!session) { ws.close(); return; }
  
  const userId = session.user_id;
  wsUsers.set(ws, userId);
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(ws);
  
  // Mark online
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run('online', userId);
  broadcast(null, { type: 'USER_STATUS', userId, status: 'online' });
  
  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === 'TYPING') {
        const user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId);
        broadcast(data.serverId, { type: 'TYPING', channelId: data.channelId, userId, displayName: user?.display_name });
      }
      if (data.type === 'VOICE_JOIN') {
        broadcast(data.serverId, { type: 'VOICE_JOIN', channelId: data.channelId, userId });
      }
      if (data.type === 'VOICE_LEAVE') {
        broadcast(data.serverId, { type: 'VOICE_LEAVE', channelId: data.channelId, userId });
      }
    } catch {}
  });
  
  ws.on('close', () => {
    wsUsers.delete(ws);
    const sockets = userSockets.get(userId);
    if (sockets) {
      sockets.delete(ws);
      if (sockets.size === 0) {
        userSockets.delete(userId);
        db.prepare('UPDATE users SET status = ? WHERE id = ?').run('offline', userId);
        broadcast(null, { type: 'USER_STATUS', userId, status: 'offline' });
      }
    }
  });
});

// ─── Catch-all → serve index.html ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎵 Chord server running at http://localhost:${PORT}`);
  console.log(`   Open your browser and create an account!\n`);
});
