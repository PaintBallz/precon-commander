// Game nights: any league member proposes a date, everyone answers Yes, Maybe
// or No (on the site, or with the buttons on the Discord post), and the site
// suggests pods from who's coming. A league can have up to 3 nights open for
// RSVPs at once. A few hours before it starts, the Discord channel gets a
// reminder that pings the linked players who haven't answered yet.
import crypto from 'node:crypto';
import { db } from './db.js';
import { getLeague, isMember, leagueMembers, logEvent } from './leagues.js';
import { nightChanged, nightReminder, setNightSource } from './discord.js';

export const NIGHTS_OPEN_MAX = 3;
const ANSWERS = ['yes', 'maybe', 'no'];
// A night stays "on" (shown, answerable) until 12 hours after it starts.
const AFTER_MS = 12 * 3600e3;
const REMIND_MS = Number(process.env.NIGHT_REMIND_MS ?? 4 * 3600e3);
const POD_MIN = 3, POD_MAX = 4;

db.exec(`CREATE TABLE IF NOT EXISTS game_nights (
  id TEXT PRIMARY KEY,
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  created_by TEXT,
  starts_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cancelled')),
  created_at TEXT NOT NULL,
  discord_msg TEXT,
  reminder_msg TEXT,
  reminded_at TEXT
);
CREATE INDEX IF NOT EXISTS game_nights_league ON game_nights(league_id, starts_at);
CREATE TABLE IF NOT EXISTS night_rsvps (
  night_id TEXT NOT NULL REFERENCES game_nights(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  answer TEXT NOT NULL CHECK (answer IN ('yes', 'maybe', 'no')),
  at TEXT NOT NULL,
  PRIMARY KEY (night_id, user_id)
);`);

const now = () => new Date().toISOString();
const getNight = id => db.prepare('SELECT * FROM game_nights WHERE id = ?').get(id) || null;
const isOver = n => Date.parse(n.starts_at) + AFTER_MS < Date.now();
const openCount = leagueId => db.prepare("SELECT starts_at FROM game_nights WHERE league_id = ? AND status = 'open'").all(leagueId)
  .filter(n => Date.parse(n.starts_at) + AFTER_MS >= Date.now()).length;

// Pods of 3–4 from the players coming: as many pods as fit, sizes as even as
// possible. The first to say Yes get a seat; with 5 coming, one sits out.
// Seats are dealt by standings (snake order) so the strongest players spread out.
export function suggestPods(players, rankOf = () => 0) {
  const n = players.length;
  let k = Math.ceil(n / POD_MAX);
  while (k > 0 && k * POD_MIN > n) k--;
  if (!k) return { pods: [], out: players };
  const seats = Math.min(n, k * POD_MAX);
  const inn = players.slice(0, seats).sort((a, b) => rankOf(a) - rankOf(b));
  const pods = Array.from({ length: k }, () => []);
  inn.forEach((p, i) => { const round = Math.floor(i / k), j = i % k; pods[round % 2 ? k - 1 - j : j].push(p); });
  return { pods, out: players.slice(seats) };
}

// What a page (or the Discord post) shows for one night.
export function nightView(n, { me = null, rank = null } = {}) {
  if (!n) return null;
  const league = getLeague(n.league_id);
  const members = leagueMembers(n.league_id);
  const nameOf = id => members.find(m => m.id === id)?.username || db.prepare('SELECT username FROM users WHERE id = ?').get(id)?.username || 'Deleted player';
  const rows = db.prepare('SELECT user_id, answer, at FROM night_rsvps WHERE night_id = ? ORDER BY at').all(n.id).filter(r => members.some(m => m.id === r.user_id));
  const by = a => rows.filter(r => r.answer === a).map(r => ({ id: r.user_id, name: nameOf(r.user_id) }));
  const answered = new Set(rows.map(r => r.user_id));
  const yes = by('yes'), maybe = by('maybe');
  const rankOf = p => (rank ? rank(p.id) : 0);
  return {
    id: n.id, leagueId: n.league_id, leagueName: league?.name || '', startsAt: n.starts_at, note: n.note, status: n.status,
    over: isOver(n), createdAt: n.created_at, createdBy: n.created_by ? { id: n.created_by, name: nameOf(n.created_by) } : null,
    rsvps: { yes, maybe, no: by('no'), none: members.filter(m => !answered.has(m.id)).map(m => ({ id: m.id, name: m.username })) },
    mine: me ? rows.find(r => r.user_id === me)?.answer || null : null,
    pods: { yes: suggestPods(yes, rankOf), withMaybe: suggestPods([...yes, ...maybe], rankOf) },
  };
}

// Set (or change) a player's answer. Used by the site and the Discord buttons.
export function setRsvp(nightId, userId, answer) {
  const n = getNight(nightId);
  if (!n || !ANSWERS.includes(answer)) return { error: "That game night isn't there any more." };
  if (n.status !== 'open') return { error: 'That game night was cancelled.' };
  if (isOver(n)) return { error: 'That game night is over.' };
  const league = getLeague(n.league_id);
  if (!league || league.status !== 'active') return { error: 'That league has ended.' };
  if (!isMember(n.league_id, userId)) return { error: `You're not in ${league.name}.` };
  const before = db.prepare('SELECT answer FROM night_rsvps WHERE night_id = ? AND user_id = ?').get(n.id, userId)?.answer || null;
  if (before !== answer) {
    db.prepare(`INSERT INTO night_rsvps (night_id, user_id, answer, at) VALUES (?, ?, ?, ?)
      ON CONFLICT(night_id, user_id) DO UPDATE SET answer = excluded.answer, at = CASE WHEN night_rsvps.answer = 'yes' AND excluded.answer = 'yes' THEN night_rsvps.at ELSE excluded.at END`)
      .run(n.id, userId, answer, now());
    nightChanged(n.id);
  }
  return { ok: true, night: n, league, changed: before !== answer };
}

export function nightRoutes(app, { wrap, HttpError, broadcast, viewLeague, canManage, rankIn }) {
  setNightSource(id => { const n = getNight(id); return n && nightView(n, { rank: rankIn(n.league_id) }); });
  const view = (n, req) => nightView(n, { me: req.user.id, rank: rankIn(n.league_id) });
  const mine = (req, id) => {
    const n = getNight(String(id));
    if (!n) throw new HttpError(404, "That game night isn't there any more.");
    const league = getLeague(n.league_id);
    if (!req.user.isAdmin && !isMember(n.league_id, req.user.id)) throw new HttpError(403, `You're not in ${league?.name || 'that league'}.`);
    return { n, league };
  };

  app.get('/api/nights', wrap(async (req, res) => {
    const l = viewLeague(req);
    if (!l) return res.json({ nights: [], past: [], max: NIGHTS_OPEN_MAX, canPropose: false });
    if (!req.user.isAdmin && !isMember(l.id, req.user.id)) throw new HttpError(403, `You're not in ${l.name}.`);
    const all = db.prepare('SELECT * FROM game_nights WHERE league_id = ? ORDER BY starts_at').all(l.id);
    const current = all.filter(n => n.status === 'open' && !isOver(n));
    const past = all.filter(n => n.status === 'open' && isOver(n)).slice(-5).reverse();
    res.json({
      nights: current.map(n => view(n, req)), past: past.map(n => view(n, req)), max: NIGHTS_OPEN_MAX,
      canPropose: l.status === 'active' && (isMember(l.id, req.user.id) || req.user.isAdmin) && !req.user.viewAs,
    });
  }));

  // Any league member can propose a night (up to 3 open at once).
  app.post('/api/nights', wrap(async (req, res) => {
    const l = viewLeague(req);
    if (!l || l.status !== 'active') throw new HttpError(409, 'Game nights are for an active league.');
    if (!req.user.isAdmin && !isMember(l.id, req.user.id)) throw new HttpError(403, `You're not in ${l.name}.`);
    const t = Date.parse(String(req.body?.startsAt || ''));
    if (!Number.isFinite(t)) throw new HttpError(400, 'Pick a date and time.');
    if (t < Date.now() + 5 * 60e3) throw new HttpError(400, 'Pick a time in the future.');
    if (t > Date.now() + 180 * 24 * 3600e3) throw new HttpError(400, 'Pick a date within the next 6 months.');
    if (openCount(l.id) >= NIGHTS_OPEN_MAX) throw new HttpError(409, `There can be ${NIGHTS_OPEN_MAX} game nights up for RSVP at once. Wait for one to pass, or cancel one.`);
    const note = String(req.body?.note || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const id = crypto.randomBytes(9).toString('base64url');
    db.prepare('INSERT INTO game_nights (id, league_id, created_by, starts_at, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, l.id, req.user.id, new Date(t).toISOString(), note, 'open', now());
    // Whoever proposes it is coming.
    if (isMember(l.id, req.user.id)) db.prepare("INSERT INTO night_rsvps (night_id, user_id, answer, at) VALUES (?, ?, 'yes', ?)").run(id, req.user.id, now());
    logEvent(l.id, 'night', req.user.id, `${req.user.username} proposed a game night${note ? ` (${note})` : ''}. Answer on the Game nights page.`);
    nightChanged(id, { create: true });
    broadcast('state', { leagueId: l.id, night: id });
    res.json({ night: view(getNight(id), req) });
  }));

  app.put('/api/nights/:id/rsvp', wrap(async (req, res) => {
    const { n } = mine(req, req.params.id);
    const answer = String(req.body?.answer || '');
    if (!ANSWERS.includes(answer)) throw new HttpError(400, 'Answer yes, maybe or no.');
    const r = setRsvp(n.id, req.user.id, answer);
    if (r.error) throw new HttpError(409, r.error);
    broadcast('state', { leagueId: n.league_id, night: n.id });
    res.json({ night: view(getNight(n.id), req) });
  }));

  // Whoever proposed it, the league admin or the site admin can cancel it.
  app.delete('/api/nights/:id', wrap(async (req, res) => {
    const { n, league } = mine(req, req.params.id);
    if (n.created_by !== req.user.id && !canManage(req, league)) throw new HttpError(403, 'Only whoever proposed it, the league admin or the site admin can cancel it.');
    if (n.status !== 'open') throw new HttpError(409, 'It was already cancelled.');
    db.prepare("UPDATE game_nights SET status = 'cancelled' WHERE id = ?").run(n.id);
    logEvent(n.league_id, 'night', req.user.id, `${req.user.username} cancelled the game night planned for ${new Date(n.starts_at).toUTCString().slice(0, 11)}.`);
    nightChanged(n.id);
    broadcast('state', { leagueId: n.league_id, night: n.id });
    res.json({ ok: true });
  }));

  // The reminder: once, a few hours before it starts (not for a night proposed inside that window).
  const remind = () => {
    for (const n of db.prepare("SELECT * FROM game_nights WHERE status = 'open' AND reminded_at IS NULL").all()) {
      const start = Date.parse(n.starts_at);
      if (Date.now() < start - REMIND_MS || Date.now() > start) continue;
      db.prepare('UPDATE game_nights SET reminded_at = ? WHERE id = ?').run(now(), n.id);
      if (Date.parse(n.created_at) < start - REMIND_MS && getLeague(n.league_id)?.status === 'active') nightReminder(n.id);
    }
  };
  remind();
  setInterval(remind, Number(process.env.NIGHT_CHECK_MS ?? 60e3)).unref();
}

// The nights still open in a league, short form (for the Pods tab and the menu badge).
export function nightSummaries(leagueId, userId) {
  if (!leagueId) return [];
  return db.prepare("SELECT * FROM game_nights WHERE league_id = ? AND status = 'open' ORDER BY starts_at").all(leagueId).filter(n => !isOver(n)).map(n => {
    const rows = db.prepare('SELECT user_id, answer FROM night_rsvps WHERE night_id = ?').all(n.id).filter(r => isMember(leagueId, r.user_id));
    return { id: n.id, startsAt: n.starts_at, note: n.note, mine: rows.find(r => r.user_id === userId)?.answer || null,
      yes: rows.filter(r => r.answer === 'yes').length, maybe: rows.filter(r => r.answer === 'maybe').length };
  });
}
