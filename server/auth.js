// League accounts: username + password login, email for recovery, one admin.
// Passwords are scrypt-hashed; sessions are random tokens in an HttpOnly cookie.
import crypto from 'node:crypto';
import { db } from './db.js';
import { sendMail, mailEnabled } from './mail.js';
import { clientIp } from './ratelimit.js';
import { logAdmin } from './adminlog.js';

const COOKIE = 'pcc_sid';
const SESSION_DAYS = 30;
const RESET_MINUTES = 60;
// The site's public address, used in password-reset links. Set PUBLIC_URL in
// production; it is never taken from the request (a forged Host header would
// otherwise point reset links somewhere else).
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
if (!process.env.PUBLIC_URL) console.warn(`PUBLIC_URL is not set; password-reset links will point at ${PUBLIC_URL}`);

class AuthError extends Error { constructor(status, msg, extra = {}) { super(msg); this.status = status; Object.assign(this, extra); } }

// ---------- rules ----------
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const PASSWORD_RULES = 'At least 8 characters, with at least one letter and one number.';
export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 128) return 'Password must be 128 characters or fewer.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password needs at least one letter and one number.';
  return null;
}
export function checkUsername(u) {
  if (!USERNAME_RE.test(u)) throw new AuthError(400, 'Username must be 3–20 letters, numbers, _ or -.');
}
function checkEmail(e) {
  if (!EMAIL_RE.test(e) || e.length > 254) throw new AuthError(400, 'Enter a valid email address.');
}
function checkPassword(pw) {
  const p = passwordProblem(pw);
  if (p) throw new AuthError(400, p);
}

// ---------- hashing ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length);
  return crypto.timingSafeEqual(want, got);
}
const token = () => crypto.randomBytes(32).toString('base64url');
// Checked against when the username doesn't exist, so a wrong username takes as
// long as a wrong password (timing can't reveal which accounts exist).
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));
const now = () => new Date().toISOString();

// ---------- users ----------
const userCols = 'id, username, email, is_admin, staff, is_test, must_change, precon, created_at, suspended_at, suspended_reason';
// isAdmin: may use admin powers (the admin account, or a player made an admin).
// adminAccount: the original admin account, which runs the site and never plays.
export function publicUser(r) {
  return r && { id: r.id, username: r.username, email: r.email || '', isAdmin: !!(r.is_admin || r.staff), adminAccount: !!r.is_admin, staff: !!r.staff, ...(r.is_test ? { test: true } : {}), mustChange: !!r.must_change, precon: r.precon || '', createdAt: r.created_at,
    ...(r.suspended_at ? { suspended: true, suspendedAt: r.suspended_at, suspendedReason: r.suspended_reason || '' } : {}) };
}
export const getUser = id => db.prepare(`SELECT ${userCols} FROM users WHERE id = ?`).get(id);
export const setPrecon = (id, precon) => db.prepare('UPDATE users SET precon = ? WHERE id = ?').run(String(precon).trim().slice(0, 80), id);
export const listUsers = () => db.prepare(`SELECT ${userCols} FROM users ORDER BY username COLLATE NOCASE`).all();
const byLogin = login => db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(login, login);

function setPassword(userId, pw, mustChange = 0) {
  db.prepare('UPDATE users SET pass_hash = ?, must_change = ? WHERE id = ?').run(hashPassword(pw), mustChange, userId);
}

// First start: one admin account. Its starting password is ADMIN_INITIAL_PASSWORD,
// or a random one printed once to the server log; either way it must be changed
// on first login. There is no fixed default anyone could guess.
export function seedAdmin() {
  if (db.prepare('SELECT 1 FROM users WHERE is_admin = 1').get()) return;
  const taken = db.prepare('SELECT 1 FROM users WHERE username = ?').get('admin');
  if (taken) { db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run('admin'); return; }
  const fromEnv = String(process.env.ADMIN_INITIAL_PASSWORD || '');
  const pw = fromEnv || crypto.randomBytes(12).toString('base64url');
  db.prepare('INSERT INTO users (id, username, email, pass_hash, is_admin, must_change, created_at) VALUES (?, ?, NULL, ?, 1, 1, ?)')
    .run(crypto.randomUUID(), 'admin', hashPassword(pw), now());
  console.log(fromEnv ? 'Created admin account "admin" with ADMIN_INITIAL_PASSWORD: change it on first login'
    : `Created admin account "admin" with starting password ${pw} (shown once): change it on first login`);
}

// ---------- sessions ----------
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function startSession(req, res, userId) {
  const t = token();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(t, userId, Date.now() + SESSION_DAYS * 864e5);
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}
function endSession(req, res) {
  const t = parseCookies(req.headers.cookie)[COOKIE];
  if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
export const sessionToken = req => parseCookies(req.headers.cookie)[COOKIE] || null;
// The signed-in user and their session. A suspended account has no session.
function sessionOf(req) {
  const t = sessionToken(req);
  if (!t) return null;
  const s = db.prepare('SELECT user_id, expires_at, view_as FROM sessions WHERE token = ?').get(t);
  if (!s || s.expires_at < Date.now()) { if (s) db.prepare('DELETE FROM sessions WHERE token = ?').run(t); return null; }
  const user = getUser(s.user_id);
  if (!user || user.suspended_at) return null;
  return { token: t, user, viewAs: (user.is_admin || user.staff) && s.view_as ? getUser(s.view_as) : null };
}
const sessionUser = req => sessionOf(req)?.user || null;
// The admin's "view as player": this session sees the site as that player,
// read-only, until the admin stops.
export function setViewAs(req, userId) {
  const t = sessionToken(req);
  if (t) db.prepare('UPDATE sessions SET view_as = ? WHERE token = ?').run(userId || null, t);
}
// Signs a player out on every device.
export const endAllSessions = userId => db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;

// ---------- login throttling ----------
const failures = new Map();   // key -> [timestamps]
const WINDOW = 15 * 60e3, MAX_FAILS = 10;
// Failed logins per IP across all usernames (credential stuffing tries many).
const MAX_IP_FAILS = 30;
// New accounts per IP: a handful per hour is plenty for a friend group.
const SIGNUP_WINDOW = 60 * 60e3, MAX_SIGNUPS = Number(process.env.SIGNUPS_PER_HOUR) > 0 ? Number(process.env.SIGNUPS_PER_HOUR) : 10;
// (clientIp, from ratelimit.js, reads CF-Connecting-IP only from the local tunnel.)
function throttled(key, windowMs = WINDOW, max = MAX_FAILS) {
  const list = (failures.get(key) || []).filter(t => t > Date.now() - windowMs);
  failures.set(key, list);
  return list.length >= max;
}
const noteFailure = key => failures.set(key, [...(failures.get(key) || []), Date.now()]);

// ---------- middleware ----------
// Every /api route except the ones below needs a signed-in user. An account
// still on its default password can only reach /api/auth/* until it's changed.
const OPEN = new Set(['/auth/me', '/auth/login', '/auth/signup', '/auth/forgot', '/auth/reset', '/auth/logout']);
// The only changes allowed while the admin views the site as a player.
const VIEW_AS_WRITES = new Set(['/admin/view-as/stop', '/auth/logout']);
export function requireAuth(req, res, next) {
  if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'Send JSON.' });
  if (OPEN.has(req.path)) return next();
  const s = sessionOf(req);
  if (!s) return res.status(401).json({ error: 'Please log in.', loggedOut: true });
  req.user = publicUser(s.user);
  if (req.user.mustChange && !req.path.startsWith('/auth/')) return res.status(403).json({ error: 'Change your password first.', mustChange: true });
  if (s.viewAs) {
    // Viewing as a player: every answer is what they'd see; nothing can be changed.
    req.realUser = req.user;
    req.user = { ...publicUser(s.viewAs), viewAs: true };
    if (req.method !== 'GET' && !VIEW_AS_WRITES.has(req.path)) return res.status(403).json({ error: `You're viewing the site as ${req.user.username} (read-only). Stop viewing to make changes.`, viewAs: true });
  }
  next();
}
export function requireAdmin(req) {
  if (!req.user?.isAdmin) throw new AuthError(403, 'Only the admin can do that.');
}

// ---------- routes (mounted under /api) ----------
export function authRoutes(app, wrap, onChange = () => {}) {
  app.get('/api/auth/me', (req, res) => {
    const s = sessionOf(req);
    const user = s?.viewAs ? { ...publicUser(s.viewAs), viewAs: true } : publicUser(s?.user) || null;
    res.json({ user, ...(s?.viewAs ? { viewAs: { admin: s.user.username } } : {}), passwordRules: PASSWORD_RULES, emailEnabled: mailEnabled() });
  });

  app.post('/api/auth/signup', wrap(async (req, res) => {
    const key = `signup|${clientIp(req)}`;
    if (throttled(key, SIGNUP_WINDOW, MAX_SIGNUPS)) throw new AuthError(429, 'Too many new accounts from here. Try again later.');
    const username = String(req.body?.username || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password;
    checkUsername(username); checkEmail(email); checkPassword(password);
    if (req.body?.agree !== true && req.body?.agree !== 'yes') throw new AuthError(400, 'Please confirm you\'re 13 or older and agree to the Terms of Use and Privacy Policy.');
    // "Taken" answers count toward the limit too, so signup can't be used to
    // test which emails have accounts.
    const taken = msg => { noteFailure(key); return new AuthError(409, msg); };
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw taken('That username is taken.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw taken('An account already uses that email.');
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO users (id, username, email, pass_hash, is_admin, must_change, created_at, terms_accepted_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?)')
      .run(id, username, email, hashPassword(password), now(), now());
    noteFailure(key);
    startSession(req, res, id);
    res.json({ user: publicUser(getUser(id)) });
  }));

  app.post('/api/auth/login', wrap(async (req, res) => {
    const login = String(req.body?.username || '').trim();
    const key = `${clientIp(req)}|${login.toLowerCase()}`;
    const ipKey = `login-ip|${clientIp(req)}`;
    if (throttled(key) || throttled(ipKey, WINDOW, MAX_IP_FAILS)) throw new AuthError(429, 'Too many tries. Wait 15 minutes, or reset your password.');
    const u = login && byLogin(login);
    const good = verifyPassword(req.body?.password || '', u ? u.pass_hash : DUMMY_HASH);
    if (!u || !good) {
      noteFailure(key); noteFailure(ipKey);
      throw new AuthError(401, 'Wrong username or password.');
    }
    if (u.is_test) throw new AuthError(403, "Test players can't sign in. An admin plays for them.");
    if (u.suspended_at) throw new AuthError(403, `This account is suspended${u.suspended_reason ? `: ${u.suspended_reason}` : ''}. Ask the admin.`);
    failures.delete(key);
    startSession(req, res, u.id);
    res.json({ user: publicUser(getUser(u.id)) });
  }));

  app.post('/api/auth/logout', (req, res) => { endSession(req, res); res.json({ ok: true }); });

  app.post('/api/auth/password', wrap(async (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(req.body?.current || '', u.pass_hash)) throw new AuthError(400, 'Your current password is wrong.');
    const pw = req.body?.password;
    checkPassword(pw);
    if (pw === req.body?.current) throw new AuthError(400, 'Pick a different password from the current one.');
    setPassword(u.id, pw);
    // Sign out every other device.
    const t = parseCookies(req.headers.cookie)[COOKIE];
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(u.id, t);
    res.json({ user: publicUser(getUser(u.id)) });
  }));

  app.put('/api/auth/profile', wrap(async (req, res) => {
    const b = req.body || {};
    if (b.email != null) {
      const email = String(b.email).trim().toLowerCase();
      checkEmail(email);
      const other = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (other && other.id !== req.user.id) throw new AuthError(409, 'An account already uses that email.');
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, req.user.id);
    }
    if (b.precon != null) db.prepare('UPDATE users SET precon = ? WHERE id = ?').run(String(b.precon).trim().slice(0, 80), req.user.id);
    res.json({ user: publicUser(getUser(req.user.id)) });
  }));

  // Forgot password: email a one-hour reset link. Same answer whether or not
  // the address exists, so it can't be used to find accounts.
  app.post('/api/auth/forgot', wrap(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!mailEnabled()) return res.json({ ok: true, emailEnabled: false });
    const key = `forgot|${clientIp(req)}`;
    if (throttled(key)) throw new AuthError(429, 'Too many reset requests. Try again later.');
    noteFailure(key);
    const u = email && db.prepare('SELECT id, username, email FROM users WHERE email = ?').get(email);
    if (u) {
      const link = createResetLink(u.id);
      await sendMail({
        to: u.email,
        subject: 'Reset your Pre-Con Commander password',
        text: `Hi ${u.username},\n\nUse this link to set a new password (it works for ${RESET_MINUTES} minutes):\n${link}\n\nIf you didn't ask for this, you can ignore this email.`,
      }).catch(err => console.error('Reset email failed:', err.message));
    }
    res.json({ ok: true, emailEnabled: true });
  }));

  app.post('/api/auth/reset', wrap(async (req, res) => {
    const t = String(req.body?.token || '');
    const row = t && db.prepare('SELECT user_id, expires_at FROM reset_tokens WHERE token = ?').get(t);
    if (!row || row.expires_at < Date.now()) throw new AuthError(400, 'This reset link is invalid or has expired. Ask for a new one.');
    checkPassword(req.body?.password);
    setPassword(row.user_id, req.body.password);
    db.prepare('DELETE FROM reset_tokens WHERE user_id = ?').run(row.user_id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
    startSession(req, res, row.user_id);
    res.json({ user: publicUser(getUser(row.user_id)) });
  }));

  // Delete your own account (password required). The admin account can't be
  // deleted this way: the league needs one.
  app.post('/api/auth/delete', wrap(async (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(req.body?.password || '', u.pass_hash)) throw new AuthError(400, 'That password is wrong.');
    if (u.is_admin) throw new AuthError(409, 'The admin account can\'t be deleted: the league needs an admin.');
    deleteAccount(u.id);
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    onChange();
    res.json({ ok: true });
  }));

  // ---------- admin ----------
  app.get('/api/admin/users', wrap(async (req, res) => {
    requireAdmin(req);
    res.json({ users: listUsers().map(publicUser), emailEnabled: mailEnabled() });
  }));
  app.delete('/api/admin/users/:id', wrap(async (req, res) => {
    requireAdmin(req);
    if (req.params.id === req.user.id) throw new AuthError(409, 'You can\'t delete your own admin account.');
    const target = getUser(req.params.id);
    if (target?.is_admin) throw new AuthError(409, "The main admin account can't be deleted.");
    // Another admin's account is only the main admin's to manage.
    if (target?.staff && !req.user.adminAccount) throw new AuthError(403, 'Only the main admin account can delete another admin.');
    if (!deleteAccount(req.params.id)) throw new AuthError(404, 'User not found');
    logAdmin(req, { action: 'delete-user', summary: `Deleted ${target.username}'s account (can't be undone).`, reason: req.body?.reason });
    onChange();
    res.json({ ok: true });
  }));
  // A reset link the admin can hand over directly (works without email).
  app.post('/api/admin/users/:id/reset-link', wrap(async (req, res) => {
    requireAdmin(req);
    const target = getUser(req.params.id);
    if (!target) throw new AuthError(404, 'User not found');
    // A reset link is a way into the account, so admins' accounts are only the main admin's.
    if ((target.is_admin || target.staff) && !req.user.adminAccount && target.id !== req.user.id) throw new AuthError(403, 'Only the main admin account can make a reset link for an admin.');
    logAdmin(req, { action: 'reset-link', summary: `Made a password-reset link for ${target.username}.` });
    res.json({ link: createResetLink(req.params.id), minutes: RESET_MINUTES });
  }));
}

// Remove an account for good: login details, sessions, reset links, feature
// suggestions and league memberships. Pods they played and packs they opened
// stay, because other players' standings and history depend on them, but
// their name there (pod seats and the activity feed) becomes "Deleted player".
export const DELETED_NAME = 'Deleted player';
export function deleteAccount(userId) {
  const u = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  if (!u) return false;
  const word = new RegExp(`\\b${u.username.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\b`, 'g');
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE pod_players SET name = ?, precon = '' WHERE user_id = ?").run(DELETED_NAME, userId);
    const fix = db.prepare('UPDATE league_events SET text = ? WHERE id = ?');
    const events = db.prepare(`SELECT id, text FROM league_events WHERE text LIKE ?
      AND league_id IN (SELECT league_id FROM league_members WHERE user_id = ?)`).all(`%${u.username}%`, userId);
    for (const e of events) fix.run(e.text.replace(word, DELETED_NAME), e.id);
    db.prepare('DELETE FROM league_members WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM feedback WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM reset_tokens WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return true;
}

function createResetLink(userId) {
  const t = token();
  db.prepare('DELETE FROM reset_tokens WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)').run(t, userId, Date.now() + RESET_MINUTES * 60e3);
  return `${PUBLIC_URL}/#reset?token=${t}`;
}
