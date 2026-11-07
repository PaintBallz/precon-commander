// Pre-Con Commander — league companion: leagues, pods, one wheel spin per pod,
// booster opener and per-player card pools. Every phone sees changes live
// (Server-Sent Events).
//
// League = 3–16 players (joined at creation, by invite code, or added by the
// admin); a player is in one active league at a time. Pod = one game of 3–4
// league players. When a pod ends, its players vote (never for themselves) on
// who earns a bonus pack; a tie means a re-vote between the tied players until
// one has the most votes. Then the winner spins the wheel ONCE: every player's
// packs are that set (by default winner 3, everyone else 2), and every league
// member who missed the pod gets 1 pack of it too. A player can Sacrifice a
// Pack (give up one of their spun-set packs) to turn another into any set.
// Pack counts, absent packs and the vote bonus are each league's own rules.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  savePod, loadPod, activePods, finishedPods, grantsPods, grantsPod, grantsPodId, pendingPacks, deletePod, deleteHistory, poolCard, deletePoolCard,
  poolCards, poolPods, setInfoFor, kvGet, kvSet,
} from './db.js';
import {
  LEAGUE_MIN, LEAGUE_MAX, DEFAULT_RULES, RULE_LIMITS, getLeague, leagueByCode, listLeagues, activeLeagueOf,
  leagueMembers, isMember, addMember, removeMember, wasKicked, createLeague, updateLeague, newLeagueCode, endLeague, deleteLeague,
  logEvent, leagueEvents, migrateToLeagues, leaguesOf,
} from './leagues.js';
import { getBoosterSets, BOOSTER_SET_TYPES } from './scryfall.js';
import { openPack, hasRealPack, realPackKind, localPackSets, sheetOdds } from './packs.js';
import { requireAuth, requireAdmin, authRoutes, seedAdmin, listUsers, getUser, setPrecon } from './auth.js';
import { importDeck, editDeck, getDeck, deleteDeck, DeckError } from './decks.js';
import { playerStats, seasonRecap } from './stats.js';
import { discordInvite, podFinishedPost, leagueEndedPost } from './discord.js';
import { cached, cachedSync, clearCache } from './cache.js';
import { rateLimit, streamSlot } from './ratelimit.js';
import { adminRoutes, currentAnnouncement } from './admin.js';
import { logAdmin, podRows, packRows, cardRows, leagueRows } from './adminlog.js';
import { db } from './db.js';
import { feedbackRoutes, newFeedbackCount } from './feedback.js';
import { tradeRoutes, tradesWaiting, closeLeagueTrades } from './trades.js';

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POD_MIN = 3;
const POD_MAX = 4;

const app = express();
app.disable('x-powered-by');
// Behind a reverse proxy / tunnel on the same host or private network: trust its
// X-Forwarded-* headers (HTTPS detection for secure cookies, client IPs).
app.set('trust proxy', 'loopback, uniquelocal');
// Security headers on everything: no framing by other sites (clickjacking), no
// MIME sniffing, no full URLs in Referer, and HTTPS-only once served over HTTPS.
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});
// Per-IP limits on every request (see ratelimit.js).
app.use(rateLimit);
app.use(express.json({ limit: '200kb' }));

// Cloudflare gives .js/.css a 4-hour browser cache no matter what we send, so
// the page links its script and stylesheet with a content hash: a new deploy
// is a new URL and phones never mix a fresh page with a stale script.
const PUBLIC = path.join(ROOT, 'public');
const ASSET_VERSION = crypto.createHash('sha1')
  .update(['app.js', 'styles.css', 'decklist.js'].map(f => fs.readFileSync(path.join(PUBLIC, f))).join('\0'))
  .digest('hex').slice(0, 10);
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
  .replace('/styles.css"', `/styles.css?v=${ASSET_VERSION}"`)
  .replace('/app.js"', `/app.js?v=${ASSET_VERSION}"`)
  .replace('<!--discord-invite-->', discordInvite()
    ? `<a class="btn sm discord-join" href="${discordInvite()}" target="_blank" rel="noopener">Join the league Discord</a>`
    : '');
// app.js imports decklist.js; give that import the same version stamp so it
// can be cached as long as app.js.
const APP_JS = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8')
  .replace("from './decklist.js'", `from './decklist.js?v=${ASSET_VERSION}'`);
app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-cache').type('html').send(INDEX_HTML);
});
// How long browsers and Cloudflare may keep each kind of file:
//   ?v=<hash> URLs (app.js, styles.css, decklist.js)  1 year, immutable (a deploy changes the URL)
//   fonts                                              1 year, immutable (the files never change)
//   favicon / images                                   7 days
//   privacy, terms                                     10 minutes
//   anything else (unversioned scripts)                5 minutes
const YEAR = 'public, max-age=31536000, immutable';
function cacheFor(req, file) {
  if (req.query.v || /[\\/]fonts[\\/]/.test(file)) return YEAR;
  if (/\.(svg|png|ico|webp|jpg)$/i.test(file)) return 'public, max-age=604800';
  if (/\.html$/i.test(file)) return 'public, max-age=600';
  return 'public, max-age=300';
}
app.get('/app.js', (req, res) => {
  res.set('Cache-Control', cacheFor(req, 'app.js')).type('js').send(APP_JS);
});
app.use((req, res, next) => {
  express.static(PUBLIC, { extensions: ['html'], cacheControl: false, setHeaders: (r, file) => r.setHeader('Cache-Control', cacheFor(req, file)) })(req, res, next);
});

const id = (n = 8) => crypto.randomBytes(n).toString('base64url').slice(0, n);
const now = () => new Date().toISOString();
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
// Expected errors (HttpError and friends carry a status) are shown to the
// player; anything unexpected is logged and answered with a generic message.
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong. Try again in a moment.' });
});
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const names = list => list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/api', requireAuth);
authRoutes(app, wrap, () => broadcast('state'));

// ---------- live updates ----------
const clients = new Set();
let version = Date.now();
function broadcast(kind = 'state', data = {}) {
  version = Date.now();
  clearCache();
  const msg = `event: ${kind}\ndata: ${JSON.stringify({ version, ...data })}\n\n`;
  for (const res of clients) res.write(msg);
}
app.get('/api/events', (req, res) => {
  const release = streamSlot(req);
  if (!release) return res.status(429).json({ error: 'Too many open live-update connections from your connection. Close some tabs and reload.' });
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ version })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); release(); });
});

// ---------- which league a request is about ----------
// ?league=<id> picks one (any league can be viewed); otherwise it's your
// active league, and for the admin (who isn't a member) the newest active one.
function viewLeague(req) {
  const asked = req.query.league || req.body?.league;
  if (asked) {
    const l = getLeague(String(asked));
    if (!l) throw new HttpError(404, 'League not found');
    return l;
  }
  return activeLeagueOf(req.user.id) || (req.user.isAdmin ? listLeagues().find(l => l.status === 'active') || listLeagues()[0] || null : null);
}
function requireLeague(id) {
  const l = getLeague(id);
  if (!l) throw new HttpError(404, 'League not found');
  return l;
}
const rulesOf = pod => ({ ...DEFAULT_RULES, ...(pod.rules || {}) });

// ---------- sets + wheel settings (each league has its own wheel; admin edits) ----------
const DEFAULT_SETTINGS = { minYear: 1993, maxYear: 2100, types: [...BOOSTER_SET_TYPES], excluded: [], weights: {} };
// The site-wide wheel is the starting point for new leagues.
function globalSettings() { return { ...DEFAULT_SETTINGS, ...kvGet('wheel_settings', {}) }; }
function settingsFor(league) { return league ? { ...DEFAULT_SETTINGS, ...league.wheel } : globalSettings(); }

// The booster set list changes when Wizards releases a set: cached for 10 minutes.
async function allSets() {
  return cached('sets', 10 * 60e3, async () => {
    const sets = await getBoosterSets(localPackSets());
    return sets.map(s => ({ ...s, realPack: hasRealPack(s.code), packKind: realPackKind(s.code) }));
  });
}

function wheelFor(sets, settings) {
  const excluded = new Set(settings.excluded);
  return sets
    .filter(s => settings.types.includes(s.type) && s.year >= settings.minYear && s.year <= settings.maxYear && !excluded.has(s.code))
    .map(s => ({ code: s.code, weight: Number(settings.weights[s.code] ?? 1) }))
    .filter(s => s.weight > 0);
}

app.get('/api/sets', wrap(async (req, res) => {
  const league = viewLeague(req);
  const sets = await allSets();
  const settings = settingsFor(league);
  const wheel = wheelFor(sets, settings);
  const total = wheel.reduce((s, w) => s + w.weight, 0);
  const onWheel = new Map(wheel.map(w => [w.code, w.weight]));
  res.json({
    leagueId: league?.id || null,
    settings,
    types: BOOSTER_SET_TYPES,
    sets: sets.map(s => ({ ...s, weight: Number(settings.weights[s.code] ?? 1), onWheel: onWheel.has(s.code), chance: onWheel.has(s.code) ? onWheel.get(s.code) / total : 0 })),
    wheel,
  });
}));

app.put('/api/settings', wrap(async (req, res) => {
  requireAdmin(req);
  const b = req.body || {};
  const league = b.league ? requireLeague(String(b.league)) : null;
  const s = settingsFor(league);
  if (b.minYear != null) s.minYear = Math.max(1993, Math.min(2100, Number(b.minYear) || 1993));
  if (b.maxYear != null) s.maxYear = Math.max(1993, Math.min(2100, Number(b.maxYear) || 2100));
  if (Array.isArray(b.types)) s.types = b.types.filter(t => BOOSTER_SET_TYPES.includes(t));
  if (Array.isArray(b.excluded)) s.excluded = [...new Set(b.excluded.map(String))];
  if (b.weights && typeof b.weights === 'object') {
    const w = {};
    for (const [k, v] of Object.entries(b.weights)) {
      const n = Math.max(0, Math.min(100, Number(v)));
      if (Number.isFinite(n) && n !== 1) w[k] = Math.round(n * 100) / 100;
    }
    s.weights = w;
  }
  if (b.reset) Object.assign(s, structuredClone(DEFAULT_SETTINGS));
  if (league) updateLeague(league.id, { wheel: s });
  else kvSet('wheel_settings', s);
  broadcast('sets', { leagueId: league?.id || null });
  res.json({ ok: true, settings: s });
}));

// ---------- leagues ----------
const creatorName = l => (l.createdBy && getUser(l.createdBy)?.username) || null;
// The player who started a league is its league admin while they're still in
// it. Their only extra powers: changing the league rules and kicking players.
// Everything else (wheel, adding players, invite codes, ending, deleting)
// stays with the site admin.
const leagueAdminId = l => (l.createdBy && isMember(l.id, l.createdBy) ? l.createdBy : null);
const isLeagueAdmin = (req, l) => !req.user.isAdmin && leagueAdminId(l) === req.user.id;
function requireLeagueAdmin(req, l) {
  if (req.user.isAdmin) return;
  if (!isLeagueAdmin(req, l)) throw new HttpError(403, `Only ${l.name}'s league admin (who started it) or the site admin can do that.`);
  if (l.status !== 'active') throw new HttpError(409, `${l.name} has ended.`);
}
// Everything a phone gets about a league. Only members and the admin see the
// invite code. Admin accounts are never listed (they don't play).
function leagueView(req, l) {
  if (!l) return null;
  const member = isMember(l.id, req.user.id);
  const adminId = leagueAdminId(l);
  const members = leagueMembers(l.id).map(m => ({ ...m, leagueAdmin: m.id === adminId }));
  return {
    id: l.id, name: l.name, status: l.status, createdAt: l.createdAt, endedAt: l.endedAt, createdBy: creatorName(l),
    leagueAdmin: adminId ? { id: adminId, username: getUser(adminId)?.username } : null,
    canManage: req.user.isAdmin || isLeagueAdmin(req, l),
    code: member || req.user.isAdmin ? l.code : null, rules: l.rules, members, isMember: member,
    limits: { min: LEAGUE_MIN, max: LEAGUE_MAX, podMin: POD_MIN, podMax: POD_MAX },
  };
}
const leagueList = () => listLeagues().map(l => ({ id: l.id, name: l.name, status: l.status, members: l.members, pods: l.pods, createdAt: l.createdAt, endedAt: l.endedAt }));

// Standings for a league: from its finished pods, plus how many pods each
// member missed (and the packs that earned them).
const standings = leagueId => cachedSync(`standings:${leagueId}`, 10 * 60e3, () => computeStandings(leagueId));
function computeStandings(leagueId) {
  const rows = new Map(leagueMembers(leagueId, { former: true }).map(m => [m.id, {
    id: m.id, name: m.username, active: !m.leftAt, pods: 0, wins: 0, voteWins: 0, packs: 0, sacrificed: 0, rares: 0, mythics: 0, missed: 0,
  }]));
  const row = (id, name) => rows.get(id) || rows.set(id, { id, name, active: false, pods: 0, wins: 0, voteWins: 0, packs: 0, sacrificed: 0, rares: 0, mythics: 0, missed: 0 }).get(id);
  const count = (s, packs) => {
    for (const k of packs) if (k.status === 'opened') {
      if (k.kind !== 'trade') s.packs++; // a trade pack only carries a moved card
      for (const c of k.cards) { if (c.rarity === 'mythic') s.mythics++; if (c.rarity === 'rare') s.rares++; }
    }
  };
  for (const pod of finishedPods(leagueId)) {
    for (const p of pod.players) {
      const s = row(p.id, p.name);
      s.pods++;
      if (pod.winnerId === p.id) s.wins++;
      if (pod.vote?.winnerId === p.id) s.voteWins++;
      s.sacrificed += p.sacrificed;
      count(s, p.packs);
    }
    // Catch-up packs (joined after the pod) aren't a missed pod.
    for (const a of pod.absentees) { const s = row(a.id, a.name); if (!a.packs.every(k => k.kind === 'catchup')) s.missed++; count(s, a.packs); }
  }
  // Packs from the admin and moved cards count toward packs and pulls, not pods.
  for (const pod of grantsPods(leagueId)) for (const a of pod.absentees) count(row(a.id, a.name), a.packs);
  return [...rows.values()].sort((a, b) => b.wins - a.wins || (b.wins / (b.pods || 1)) - (a.wins / (a.pods || 1)) || b.pods - a.pods || a.name.localeCompare(b.name));
}

app.get('/api/leagues', (req, res) => res.json({ leagues: leagueList(), myLeagueId: activeLeagueOf(req.user.id)?.id || null }));

app.get('/api/leagues/:id', (req, res) => {
  const l = getLeague(req.params.id);
  if (!l) return res.status(404).json({ error: 'League not found' });
  res.json({ league: leagueView(req, l), standings: standings(l.id), events: leagueEvents(l.id) });
});

// Any player can start a league (if they're not already in one). By default
// every player who isn't in an active league joins it right away (up to 16).
app.post('/api/leagues', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40) || `League ${listLeagues().length + 1}`;
  if (!req.user.isAdmin) {
    const current = activeLeagueOf(req.user.id);
    if (current) throw new HttpError(409, `You're already in ${current.name}. Leave it first to start a new league.`);
  }
  const league = createLeague({ name, createdBy: req.user.id, wheel: globalSettings() });
  const joined = [];
  if (!req.user.isAdmin) { addMember(league.id, req.user.id, req.user.id); joined.push(req.user.username); }
  if (req.body?.addEveryone !== false) {
    for (const u of listUsers()) {
      if (joined.length >= LEAGUE_MAX) break;
      if (u.is_admin || u.id === req.user.id || activeLeagueOf(u.id)) continue;
      addMember(league.id, u.id, req.user.id);
      joined.push(u.username);
    }
  }
  logEvent(league.id, 'league', req.user.id, `${req.user.username} started ${league.name}${joined.length ? ` with ${names(joined)}` : ''}.`);
  broadcast('state', { leagueId: league.id });
  res.json({ league: leagueView(req, getLeague(league.id)) });
}));

function joinCheck(league, user) {
  if (league.status !== 'active') throw new HttpError(409, `${league.name} has ended.`);
  const current = activeLeagueOf(user.id);
  if (current?.id === league.id) throw new HttpError(409, `${user.username} is already in ${league.name}.`);
  if (current) throw new HttpError(409, `${user.username} is already in ${current.name} (one league at a time).`);
  if (leagueMembers(league.id).length >= LEAGUE_MAX) throw new HttpError(409, `${league.name} is full (${LEAGUE_MAX} players).`);
}

// ---------- catching up a late joiner ----------
// Someone who joins after pods have been played gets what a member who missed
// those pods got: each spun pod's "missed it" packs (the pod's rules, its
// spun set). They're added to each pod as a missed player, so they open like
// any missed-pod pack and the pod shows as missed in their pool. Pods that
// haven't spun yet need nothing: the spin hands packs to every member.
function catchUpPods(leagueId, userId) {
  return [...activePods(leagueId), ...finishedPods(leagueId)]
    .filter(p => p.spin?.set && rulesOf(p).absentPacks > 0 && !p.players.some(x => x.id === userId) && !p.absentees.some(x => x.id === userId));
}
const catchUpCount = (leagueId, userId) => catchUpPods(leagueId, userId).reduce((n, p) => n + rulesOf(p).absentPacks, 0);
function catchUp(league, user) {
  const pods = catchUpPods(league.id, user.id);
  let packs = 0;
  for (const pod of pods) {
    const n = rulesOf(pod).absentPacks;
    pod.absentees.push({ id: user.id, name: user.username, packs: Array.from({ length: n }, () => ({ ...newPack(pod.spin.set), kind: 'catchup' })) });
    pod.updatedAt = now();
    savePod(pod);
    packs += n;
  }
  return { pods: pods.length, packs };
}
const caughtUpText = c => (c.packs ? ` and gets ${plural(c.packs, 'catch-up pack')} for the ${plural(c.pods, 'pod')} played before they joined` : '');

// What an invite link shows before joining: the league and the catch-up packs.
app.get('/api/leagues/invite/:code', wrap(async (req, res) => {
  const league = leagueByCode(req.params.code || '');
  if (!league) throw new HttpError(404, 'No league has that code. Check the link and try again.');
  const current = activeLeagueOf(req.user.id);
  res.json({
    league: { id: league.id, name: league.name, status: league.status, members: leagueMembers(league.id).map(m => m.username), pods: finishedPods(league.id).length, running: activePods(league.id).length },
    catchUpPacks: req.user.isAdmin ? 0 : catchUpCount(league.id, req.user.id),
    catchUpPods: req.user.isAdmin ? 0 : catchUpPods(league.id, req.user.id).length,
    current: current ? { id: current.id, name: current.name } : null,
    full: leagueMembers(league.id).length >= LEAGUE_MAX,
  });
}));

app.post('/api/leagues/join', wrap(async (req, res) => {
  if (req.user.isAdmin) throw new HttpError(400, 'The admin account manages leagues and does not join them.');
  const league = leagueByCode(req.body?.code || '');
  if (!league) throw new HttpError(404, 'No league has that code. Check it and try again.');
  joinCheck(league, req.user);
  if (wasKicked(league.id, req.user.id)) throw new HttpError(403, `You were removed from ${league.name}. Ask the site admin to add you back.`);
  addMember(league.id, req.user.id, req.user.id);
  const caught = catchUp(league, req.user);
  logEvent(league.id, 'join', req.user.id, `${req.user.username} joined with the invite code${caughtUpText(caught)}.`);
  broadcast('state', { leagueId: league.id });
  res.json({ league: leagueView(req, league), catchUp: caught });
}));

const runningPodOf = (leagueId, userId) => activePods(leagueId).find(p => p.players.some(x => x.id === userId));

app.post('/api/leagues/:id/leave', wrap(async (req, res) => {
  const league = requireLeague(req.params.id);
  if (!isMember(league.id, req.user.id)) throw new HttpError(409, `You're not in ${league.name}.`);
  const pod = runningPodOf(league.id, req.user.id);
  if (pod) throw new HttpError(409, `Finish ${pod.name} before leaving the league.`);
  removeMember(league.id, req.user.id);
  logEvent(league.id, 'leave', req.user.id, `${req.user.username} left the league.`);
  broadcast('state', { leagueId: league.id });
  res.json({ ok: true });
}));

// Site admin: add members by hand.
app.post('/api/leagues/:id/members', wrap(async (req, res) => {
  requireAdmin(req);
  const league = requireLeague(req.params.id);
  const u = getUser(String(req.body?.userId || ''));
  if (!u || u.is_admin) throw new HttpError(400, 'Pick a player account.');
  joinCheck(league, { id: u.id, username: u.username });
  addMember(league.id, u.id, req.user.id);
  const caught = catchUp(league, u);
  logEvent(league.id, 'join', req.user.id, `${u.username} was added to the league by the site admin${caughtUpText(caught)}.`);
  broadcast('state', { leagueId: league.id });
  res.json({ league: leagueView(req, league), catchUp: caught });
}));
// Kick a player: the league admin or the site admin.
app.delete('/api/leagues/:id/members/:userId', wrap(async (req, res) => {
  const league = requireLeague(req.params.id);
  requireLeagueAdmin(req, league);
  const u = getUser(req.params.userId);
  if (!u || !isMember(league.id, u.id)) throw new HttpError(404, 'That player is not in this league.');
  if (u.id === req.user.id) throw new HttpError(400, 'Use "Leave league" to leave it yourself.');
  const pod = runningPodOf(league.id, u.id);
  if (pod) throw new HttpError(409, `${u.username} is playing in ${pod.name}. Finish or discard it first.`);
  removeMember(league.id, u.id, { kicked: true });
  const by = req.user.isAdmin ? 'the site admin' : `${req.user.username} (league admin)`;
  logEvent(league.id, 'leave', req.user.id, `${u.username} was removed from the league by ${by}.`);
  broadcast('state', { leagueId: league.id });
  res.json({ league: leagueView(req, league) });
}));
// Players the admin could add: not admins, not in an active league.
app.get('/api/leagues/:id/candidates', wrap(async (req, res) => {
  requireAdmin(req);
  requireLeague(req.params.id);
  res.json({ players: listUsers().filter(u => !u.is_admin && !activeLeagueOf(u.id)).map(u => ({ id: u.id, username: u.username })) });
}));

// Rules: the league admin or the site admin. Renaming, new invite codes,
// ending and deleting: the site admin only.
app.put('/api/leagues/:id', wrap(async (req, res) => {
  const league = requireLeague(req.params.id);
  requireLeagueAdmin(req, league);
  const b = req.body || {};
  const changes = {};
  if (b.name != null && String(b.name).trim() !== league.name) {
    requireAdmin(req);
    changes.name = String(b.name).trim().slice(0, 40);
    if (!changes.name) throw new HttpError(400, 'Give the league a name.');
  }
  if (b.rules && typeof b.rules === 'object') {
    const rules = { ...league.rules };
    for (const [k, [lo, hi]] of Object.entries(RULE_LIMITS)) {
      if (b.rules[k] == null) continue;
      const n = Math.round(Number(b.rules[k]));
      if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, `${k} must be ${lo}–${hi}.`);
      rules[k] = n;
    }
    changes.rules = rules;
  }
  const updated = updateLeague(league.id, changes);
  if (changes.rules) {
    const r = changes.rules;
    const by = req.user.isAdmin ? 'The site admin' : `${req.user.username} (league admin)`;
    logEvent(league.id, 'rules', req.user.id, `${by} changed the rules: winner ${r.winnerPacks}, others ${r.loserPacks}, absent ${r.absentPacks}, vote bonus ${r.voteBonus} pack(s). Running pods keep the rules they started with.`);
  }
  broadcast('state', { leagueId: league.id });
  res.json({ league: leagueView(req, updated) });
}));
app.post('/api/leagues/:id/code', wrap(async (req, res) => {
  requireAdmin(req);
  const league = newLeagueCode(requireLeague(req.params.id).id);
  broadcast('state', { leagueId: league.id });
  res.json({ league: leagueView(req, league) });
}));
app.post('/api/leagues/:id/end', wrap(async (req, res) => {
  requireAdmin(req);
  const league = requireLeague(req.params.id);
  if (league.status !== 'active') throw new HttpError(409, `${league.name} has already ended.`);
  const running = activePods(league.id);
  if (running.length) throw new HttpError(409, `Finish or discard ${names(running.map(p => p.name))} first.`);
  endLeague(league.id);
  closeLeagueTrades(league.id, 'The league ended.');
  logAdmin(req, { action: 'end-league', summary: `Ended ${league.name}.`, leagueId: league.id });
  logEvent(league.id, 'end', req.user.id, `${league.name} ended. Its standings, history and pools stay as an archive.`);
  broadcast('state', { leagueId: league.id });
  Promise.resolve(seasonRecap(league.id, standings(league.id))).then(r => leagueEndedPost(league, r)).catch(() => {});
  res.json({ ok: true });
}));
app.delete('/api/leagues/:id', wrap(async (req, res) => {
  requireAdmin(req);
  const league = requireLeague(req.params.id);
  const rows = leagueRows(league.id);
  deleteLeague(league.id);
  logAdmin(req, { action: 'delete-league', summary: `Deleted the league ${league.name}.`, reason: req.body?.reason, undo: { type: 'restore', rows } });
  broadcast('state', { leagueId: league.id, deleted: true });
  res.json({ ok: true, deleted: { id: league.id, name: league.name } });
}));

// ---------- pods ----------
const spunPacks = p => p.packs.filter(k => k.status === 'ready' && k.source === 'wheel');
// Running pods; with { opened: true } finished pods too (packs can still be opened after a pod is finished).
function requirePod(podId, { opened = false } = {}) {
  const pod = loadPod(podId);
  const ok = ['playing', 'awarded', ...(opened ? ['done'] : [])];
  if (!pod || !ok.includes(pod.status)) throw new HttpError(404, 'That pod is not running.');
  return pod;
}
function findPlayer(pod, playerId) {
  const p = pod.players.find(p => p.id === playerId);
  if (!p) throw new HttpError(404, 'Player not found in this pod');
  return p;
}
// Packs belong to a pod's players or to the league members who missed it.
function findPack(pod, packId) {
  for (const p of [...pod.players, ...pod.absentees]) {
    const pack = p.packs.find(k => k.id === packId);
    if (pack) return { player: p, pack };
  }
  throw new HttpError(404, 'Pack not found');
}
const inPod = (pod, user) => pod.players.some(p => p.id === user.id);
function requireMember(pod, user) {
  if (!user.isAdmin && !inPod(pod, user)) throw new HttpError(403, 'Only players in this pod (or the admin) can do that.');
}
function requireOwner(player, user) {
  if (!user.isAdmin && player.id !== user.id) throw new HttpError(403, `Only ${player.name} (or the admin) can use this pack.`);
}
async function setInfo(code) {
  const s = (await allSets()).find(s => s.code === code);
  if (!s) throw new HttpError(400, `Unknown set ${code}`);
  return { code: s.code, name: s.name, icon: s.icon, released: s.released, type: s.type };
}
const newPack = set => ({ id: id(10), status: 'ready', source: 'wheel', set, wheelSet: set, cards: null });
// Save, tell every phone, and hand back the pod as stored (so cards carry their ids).
function commit(pod, kind = 'state', data = {}) { pod.updatedAt = now(); savePod(pod); broadcast(kind, { podId: pod.id, leagueId: pod.leagueId, ...data }); return loadPod(pod.id); }

// ---------- the bonus-pack vote ----------
// Only the pod's own players vote, and only for each other. Round 1: everyone
// in the pod is a candidate. A round closes when every player has voted; if
// the most votes are tied, the next round is between just those players. The
// first round with a single leader decides it: +voteBonus packs (league rule;
// 0 turns the vote off).
function tallyOf(pod, round, candidates) {
  const tally = Object.fromEntries(candidates.map(c => [c, 0]));
  for (const b of pod.vote.ballots) if (b.round === round && b.candidateId in tally) tally[b.candidateId]++;
  const max = Math.max(...Object.values(tally));
  return { tally, top: candidates.filter(c => tally[c] === max) };
}
function candidatesFor(pod, round) {
  let cands = pod.players.map(p => p.id);
  for (let r = 1; r < round; r++) cands = tallyOf(pod, r, cands).top;
  return cands;
}
function openVote(pod) {
  pod.vote = rulesOf(pod).voteBonus > 0 && pod.players.length >= POD_MIN
    ? { status: 'open', round: 1, winnerId: null, ballots: [] }
    : { status: 'skipped', round: 0, winnerId: null, ballots: [] };
}
function closeRoundIfComplete(pod) {
  const v = pod.vote;
  if (v.ballots.filter(b => b.round === v.round).length < pod.players.length) return;
  const { top } = tallyOf(pod, v.round, candidatesFor(pod, v.round));
  if (top.length > 1) { v.round += 1; return; }
  v.status = 'done';
  v.winnerId = top[0];
  v.decidedAt = now();
  findPlayer(pod, top[0]).awarded += rulesOf(pod).voteBonus;
}
// What a phone gets to see: ballots stay secret while a round is open (only
// who has voted, plus your own choice); closed rounds show their counts.
function view(req, pod) {
  if (!pod) return pod;
  const out = { ...pod, rules: rulesOf(pod) };
  if (!pod.vote) return out;
  const v = pod.vote;
  const closed = v.status === 'open' ? v.round - 1 : v.round;
  const rounds = [];
  for (let r = 1; r <= closed; r++) {
    const candidates = candidatesFor(pod, r);
    const { tally, top } = tallyOf(pod, r, candidates);
    rounds.push({ round: r, candidates, tally, tied: top.length > 1 ? top : null });
  }
  const current = v.status === 'open' ? {
    round: v.round,
    candidates: candidatesFor(pod, v.round),
    voted: v.ballots.filter(b => b.round === v.round).map(b => b.voterId),
    myVote: v.ballots.find(b => b.round === v.round && b.voterId === req.user.id)?.candidateId || null,
  } : null;
  return { ...out, vote: { status: v.status, round: v.round, winnerId: v.winnerId, decidedAt: v.decidedAt, bonus: rulesOf(pod).voteBonus, rounds, current } };
}

app.get('/api/state', wrap(async (req, res) => {
  const league = viewLeague(req);
  const mine = activeLeagueOf(req.user.id);
  // Finished pods where I still have packs to open stay reachable.
  const pending = mine ? pendingPacks(req.user.id, mine.id) : [];
  const running = league ? activePods(league.id) : [];
  const openPodIds = [...new Set(pending.filter(k => k.podStatus === 'done').map(k => k.podId))];
  res.json({
    version, me: req.user, myLeagueId: mine?.id || null,
    announcement: currentAnnouncement(), viewAs: req.realUser ? { admin: req.realUser.username } : null,
    league: leagueView(req, league), leagues: leagueList(),
    pods: running.map(p => view(req, p)),
    openPods: openPodIds.map(id => view(req, loadPod(id))).filter(Boolean),
    members: league ? leagueMembers(league.id).map(m => ({ id: m.id, username: m.username, precon: m.precon })) : [],
    pending,
    tradesWaiting: tradesWaiting(req.user.id),
    ...(req.user.isAdmin ? { feedbackNew: newFeedbackCount() } : {}),
  });
}));

app.get('/api/members', wrap(async (req, res) => {
  const league = viewLeague(req);
  res.json({ members: league ? leagueMembers(league.id).map(m => ({ id: m.id, username: m.username, precon: m.precon })) : [] });
}));

app.post('/api/pods', wrap(async (req, res) => {
  const league = req.body?.league ? requireLeague(String(req.body.league)) : activeLeagueOf(req.user.id);
  if (!league) throw new HttpError(409, 'Join or start a league first: pods belong to a league.');
  if (league.status !== 'active') throw new HttpError(409, `${league.name} has ended.`);
  if (!req.user.isAdmin && !isMember(league.id, req.user.id)) throw new HttpError(403, `You're not in ${league.name}.`);
  const wanted = Array.isArray(req.body?.players) ? req.body.players : [];
  const ids = wanted.map(p => String(p.userId || '')).filter(Boolean);
  if (ids.length < POD_MIN || ids.length > POD_MAX) throw new HttpError(400, `A pod has ${POD_MIN} to ${POD_MAX} players.`);
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Each player can only be in the pod once.');
  const busy = new Map(activePods(league.id).flatMap(pod => pod.players.map(p => [p.id, pod])));
  const players = wanted.map((w, i) => {
    const u = getUser(String(w.userId));
    if (!u) throw new HttpError(400, `Player ${i + 1} is not a league member.`);
    if (u.is_admin) throw new HttpError(400, 'The admin account manages the league and does not play in pods.');
    if (!isMember(league.id, u.id)) throw new HttpError(400, `${u.username} is not in ${league.name}.`);
    if (busy.has(u.id)) throw new HttpError(409, `${u.username} is already playing in ${busy.get(u.id).name}.`);
    const precon = String(w.precon ?? u.precon ?? '').trim().slice(0, 80);
    return { id: u.id, name: u.username, precon, awarded: 0, sacrificed: 0, packs: [] };
  });
  if (!req.user.isAdmin && !ids.includes(req.user.id)) throw new HttpError(403, 'Add yourself to the pod (only the admin can start pods for others).');
  const key = `pod_counter:${league.id}`;
  const n = kvGet(key, 0) + 1;
  kvSet(key, n);
  const pod = {
    id: id(10), leagueId: league.id, rules: { ...league.rules }, name: `Pod ${n}`, status: 'playing', createdAt: now(), createdBy: req.user.id,
    winnerId: null, spin: null, players, absentees: [],
  };
  logEvent(league.id, 'pod', req.user.id, `${pod.name} started: ${names(players.map(p => p.name))}.`);
  res.json({ pod: view(req, commit(pod)) });
}));

app.post('/api/pods/:id/winner', wrap(async (req, res) => {
  const pod = requirePod(req.params.id);
  requireMember(pod, req.user);
  if (pod.spin) throw new HttpError(409, 'The wheel has already been spun. Ask the admin to adjust packs instead.');
  if (pod.vote?.ballots.length) throw new HttpError(409, 'Voting has started, so the winner can no longer be changed.');
  const winner = findPlayer(pod, req.body?.playerId);
  const rules = rulesOf(pod);
  pod.winnerId = winner.id;
  pod.status = 'awarded';
  pod.wonAt = now();
  for (const p of pod.players) p.awarded = p.id === winner.id ? rules.winnerPacks : rules.loserPacks;
  openVote(pod);
  logEvent(pod.leagueId, 'win', req.user.id, `${winner.name} won ${pod.name}.`);
  res.json({ pod: view(req, commit(pod)) });
}));

// Admin-only pack adjustments. Before the spin they change the award; after
// it they add a pack of the spun set or remove an unopened one.
app.post('/api/pods/:id/award', wrap(async (req, res) => {
  requireAdmin(req);
  const pod = requirePod(req.params.id);
  if (pod.status !== 'awarded') throw new HttpError(409, 'Crown a winner first.');
  const p = findPlayer(pod, req.body?.playerId);
  const delta = Math.sign(Number(req.body?.delta) || 0);
  if (pod.spin) {
    if (delta > 0) p.packs.push(newPack(pod.spin.set));
    if (delta < 0) {
      const k = spunPacks(p).at(-1);
      if (!k) throw new HttpError(409, `${p.name} has no unopened wheel pack to remove.`);
      p.packs.splice(p.packs.indexOf(k), 1);
    }
  } else if (delta < 0 && p.awarded < 1) throw new HttpError(409, `${p.name} has no packs to remove.`);
  p.awarded = Math.max(0, p.awarded + delta);
  if (delta) logAdmin(req, { action: 'award', summary: `${delta > 0 ? 'Gave' : 'Took'} ${p.name} one ${delta > 0 ? 'more' : 'fewer'} pack in ${pod.name}.`, leagueId: pod.leagueId });
  res.json({ pod: view(req, commit(pod)) });
}));

// Cast (or change) your ballot for the current round. Pod players only.
app.post('/api/pods/:id/vote', wrap(async (req, res) => {
  const pod = requirePod(req.params.id);
  if (pod.vote?.status !== 'open') throw new HttpError(409, pod.vote ? 'The vote is already over.' : 'Crown the winner first, then vote.');
  if (!inPod(pod, req.user)) throw new HttpError(403, 'Only players in this pod can vote.');
  const candidateId = String(req.body?.candidateId || '');
  if (candidateId === req.user.id) throw new HttpError(400, "You can't vote for yourself.");
  const candidates = candidatesFor(pod, pod.vote.round);
  if (!candidates.includes(candidateId)) {
    throw new HttpError(400, pod.vote.round > 1 ? 'This re-vote is only between the tied players.' : 'Vote for a player in this pod.');
  }
  const v = pod.vote;
  v.ballots = v.ballots.filter(b => !(b.round === v.round && b.voterId === req.user.id));
  v.ballots.push({ round: v.round, voterId: req.user.id, candidateId, at: now() });
  const round = v.round;
  closeRoundIfComplete(pod);
  const kind = v.status === 'done' ? 'decided' : v.round > round ? 'tied' : 'voted';
  if (kind === 'decided') {
    logEvent(pod.leagueId, 'vote', null, `${findPlayer(pod, v.winnerId).name} won ${pod.name}'s bonus-pack vote${v.round > 1 ? ` after ${plural(v.round - 1, 're-vote')}` : ''}.`);
  }
  res.json({ pod: view(req, commit(pod, 'state', { vote: kind })), result: kind });
}));

// Admin: end a stuck vote with no bonus pack.
app.post('/api/pods/:id/vote/skip', wrap(async (req, res) => {
  requireAdmin(req);
  const pod = requirePod(req.params.id);
  if (pod.vote?.status !== 'open') throw new HttpError(409, 'There is no vote in progress.');
  pod.vote.status = 'skipped';
  pod.vote.decidedAt = now();
  logAdmin(req, { action: 'skip-vote', summary: `Skipped ${pod.name}'s bonus-pack vote.`, leagueId: pod.leagueId });
  res.json({ pod: view(req, commit(pod)) });
}));

// The one spin per pod. Only the winner (or the admin) can pull the lever.
// Every pod player gets their packs of the spun set, and every league member
// who missed the pod gets absentPacks of it too.
app.post('/api/pods/:id/spin', wrap(async (req, res) => {
  const canSpin = pod => {
    if (pod.status !== 'awarded') throw new HttpError(409, 'Crown the winner first: the winner spins the wheel.');
    if (pod.spin) throw new HttpError(409, `This pod already spun ${pod.spin.set.name}. There is only one spin per pod.`);
    if (pod.vote?.status === 'open') throw new HttpError(409, 'Finish the bonus-pack vote first: the spin hands out everyone\'s packs.');
    if (!req.user.isAdmin && req.user.id !== pod.winnerId) throw new HttpError(403, `Only the winner, ${findPlayer(pod, pod.winnerId).name}, can spin.`);
  };
  const before = requirePod(req.params.id);
  canSpin(before);
  const league = before.leagueId ? getLeague(before.leagueId) : null;
  const sets = await allSets();
  const wheel = wheelFor(sets, settingsFor(league));
  if (!wheel.length) throw new HttpError(409, 'The wheel is empty. The admin needs to loosen the wheel filters.');
  const total = wheel.reduce((s, w) => s + w.weight, 0);
  let r = Math.random() * total, pick = wheel[wheel.length - 1];
  for (const w of wheel) { r -= w.weight; if (r < 0) { pick = w; break; } }
  const set = await setInfo(pick.code);
  // Check again on a fresh copy: a second tap may have spun while Scryfall
  // answered. From here to the save nothing awaits, so nothing can slip in.
  const pod = requirePod(req.params.id);
  canSpin(pod);
  pod.spin = { id: id(10), setCode: set.code, set, by: req.user.id, at: now(), offset: Math.random() };
  for (const p of pod.players) p.packs = Array.from({ length: p.awarded }, () => newPack(set));
  const absent = rulesOf(pod).absentPacks;
  pod.absentees = absent > 0 && league
    ? leagueMembers(league.id).filter(m => !pod.players.some(p => p.id === m.id))
      .map(m => ({ id: m.id, name: m.username, packs: Array.from({ length: absent }, () => newPack(set)) }))
    : [];
  logEvent(pod.leagueId, 'spin', req.user.id, `${pod.name} spun ${set.name}.${pod.absentees.length ? ` ${names(pod.absentees.map(a => a.name))} missed it and get ${plural(absent, `${set.name} pack`)} each.` : ''}`);
  res.json({ pod: view(req, commit(pod, 'spin', { spinId: pod.spin.id })), spin: pod.spin });
}));

// Sacrifice: give up one of your spun-set packs so this one can be any set.
app.post('/api/pods/:id/packs/:packId/sacrifice', wrap(async (req, res) => {
  const pod = requirePod(req.params.id);
  const { player, pack } = findPack(pod, req.params.packId);
  requireOwner(player, req.user);
  if (pack.status !== 'ready' || pack.source !== 'wheel') throw new HttpError(409, 'Only an unopened pack of the spun set can be swapped.');
  const fodder = spunPacks(player).filter(k => k.id !== pack.id).at(-1);
  if (!fodder) throw new HttpError(409, `${player.name} needs another unopened ${pack.set.name} pack to sacrifice.`);
  player.packs.splice(player.packs.indexOf(fodder), 1);
  player.sacrificed = (player.sacrificed || 0) + 1;
  pack.status = 'choosing';
  pack.source = 'sacrifice';
  pack.sacrificedAt = now();
  res.json({ pod: view(req, commit(pod)), packId: pack.id });
}));

app.post('/api/pods/:id/packs/:packId/choose', wrap(async (req, res) => {
  const set = await setInfo(String(req.body?.setCode || ''));
  // Load after the await, so the save can't overwrite changes made meanwhile.
  // (Finished pods too: admin "their choice" packs and late choices.)
  const pod = requirePod(req.params.id, { opened: true });
  const { player, pack } = findPack(pod, req.params.packId);
  requireOwner(player, req.user);
  if (pack.status !== 'choosing') throw new HttpError(409, 'This pack is not waiting for a set choice.');
  pack.set = set;
  pack.status = 'ready';
  pack.chosenAt = now();
  res.json({ pod: view(req, commit(pod)), packId: pack.id });
}));

const opening = new Set();
app.post('/api/pods/:id/packs/:packId/open', wrap(async (req, res) => {
  const { packId } = req.params;
  let pod = requirePod(req.params.id, { opened: true });
  let { player, pack } = findPack(pod, packId);
  requireOwner(player, req.user);
  if (pack.status === 'opened') return res.json({ pod: view(req, pod), pack });
  if (pack.status !== 'ready') throw new HttpError(409, 'Choose a set for this pack first.');
  if (opening.has(packId)) throw new HttpError(409, 'That pack is already being opened.');
  opening.add(packId);
  try {
    const sets = await allSets();
    const set = sets.find(s => s.code === pack.set.code) || pack.set;
    const result = await openPack(set);
    // Re-load in case something else changed while Scryfall was answering.
    pod = requirePod(req.params.id, { opened: true });
    ({ player, pack } = findPack(pod, packId));
    pack.cards = result.cards;
    pack.boosterType = result.boosterType;
    pack.generated = result.generated;
    pack.status = 'opened';
    pack.openedAt = now();
    for (const c of result.cards.filter(c => c.rarity === 'mythic')) {
      logEvent(pod.leagueId, 'pull', player.id, `${player.name} pulled ${c.name}${c.foil ? ' (foil)' : ''}, a mythic from ${set.name}.`);
    }
    const saved = commit(pod);
    res.json({ pod: view(req, saved), pack: findPack(saved, packId).pack });
  } finally {
    opening.delete(packId);
  }
}));

app.post('/api/pods/:id/finish', wrap(async (req, res) => {
  const pod = requirePod(req.params.id);
  requireMember(pod, req.user);
  if (!pod.winnerId) throw new HttpError(409, 'Pick a winner before finishing the pod.');
  pod.status = 'done';
  pod.finishedAt = now();
  logEvent(pod.leagueId, 'finish', req.user.id, `${pod.name} finished and was saved to History.`);
  const saved = commit(pod);
  podFinishedPost(saved, getLeague(saved.leagueId)?.name || 'League');
  res.json({ ok: true, pod: view(req, saved) });
}));

app.post('/api/pods/:id/discard', wrap(async (req, res) => {
  const pod = requirePod(req.params.id);
  requireMember(pod, req.user);
  pod.status = 'discarded';
  pod.finishedAt = now();
  logEvent(pod.leagueId, 'discard', req.user.id, `${pod.name} was discarded.`);
  commit(pod);
  res.json({ ok: true });
}));

// Admin: permanently delete a pod (running, finished or discarded). Its
// players, packs and pool cards go with it.
app.delete('/api/pods/:id', wrap(async (req, res) => {
  requireAdmin(req);
  const pod = loadPod(req.params.id);
  if (!pod) throw new HttpError(404, 'Pod not found');
  const rows = podRows([pod.id]);
  deletePod(pod.id);
  logAdmin(req, { action: 'delete-pod', summary: `Deleted ${pod.name}.`, reason: req.body?.reason, leagueId: pod.leagueId, undo: { type: 'restore', rows } });
  broadcast('state', { podId: pod.id, leagueId: pod.leagueId, deleted: true });
  res.json({ ok: true, deleted: { id: pod.id, name: pod.name } });
}));

// Admin: remove one pack from any pod (its pulls leave the pool with it).
app.delete('/api/pods/:id/packs/:packId', wrap(async (req, res) => {
  requireAdmin(req);
  const pod = loadPod(req.params.id);
  if (!pod) throw new HttpError(404, 'Pod not found');
  const { player, pack } = findPack(pod, req.params.packId);
  const rows = packRows([pack.id]);
  player.packs.splice(player.packs.indexOf(pack), 1);
  if (player.awarded != null) player.awarded = Math.max(0, player.awarded - 1);
  pod.updatedAt = now();
  savePod(pod);
  const what = pack.status === 'opened' ? `opened ${pack.set?.name || ''} pack (${plural(pack.cards?.length || 0, 'card')})` : `unopened ${pack.set?.name || 'choose-a-set'} pack`;
  logAdmin(req, { action: 'delete-pack', summary: `Took ${player.name}'s ${what} from ${pod.name}.`, reason: req.body?.reason, leagueId: pod.leagueId, undo: { type: 'restore', rows } });
  broadcast('state', { podId: pod.id, leagueId: pod.leagueId });
  res.json({ ok: true, pod: view(req, loadPod(pod.id)), removed: { packId: pack.id, cards: pack.cards?.length || 0 } });
}));

// Admin: remove a single pulled card from a player's pool.
app.delete('/api/pool-cards/:cardId', wrap(async (req, res) => {
  requireAdmin(req);
  const card = poolCard(Number(req.params.cardId));
  if (!card) throw new HttpError(404, 'Card not found');
  const rows = cardRows([card.id]);
  deletePoolCard(card.id);
  logAdmin(req, { action: 'delete-card', summary: `Removed ${card.name} from ${getUser(card.user_id)?.username || 'a player'}'s pool (${card.pod_name}).`, reason: req.body?.reason, undo: { type: 'restore', rows } });
  broadcast('state', { podId: card.pod_id });
  res.json({ ok: true, removed: { id: card.id, name: card.name, podId: card.pod_id } });
}));

// Admin: clear a league's history (its finished and discarded pods, with
// their packs and pool cards). Running pods are untouched.
app.delete('/api/history', wrap(async (req, res) => {
  requireAdmin(req);
  const league = viewLeague(req);
  if (!league) throw new HttpError(404, 'No league to clear.');
  const ids = db.prepare("SELECT id FROM pods WHERE status IN ('done', 'discarded') AND kind = 'pod' AND league_id = ?").all(league.id).map(r => r.id);
  const rows = podRows(ids);
  const n = deleteHistory(league.id);
  logEvent(league.id, 'clear', req.user.id, `League history was cleared (${plural(n, 'pod')}).`);
  logAdmin(req, { action: 'clear-history', summary: `Cleared ${league.name}'s history (${plural(n, 'pod')}).`, reason: req.body?.reason, leagueId: league.id, undo: n ? { type: 'restore', rows } : null });
  broadcast('state', { leagueId: league.id });
  res.json({ ok: true, deletedPods: n });
}));

app.get('/api/history', wrap(async (req, res) => {
  const league = viewLeague(req);
  res.json({ leagueId: league?.id || null, pods: league ? finishedPods(league.id).map(p => view(req, p)) : [] });
}));
app.get('/api/pods/:id', (req, res) => {
  const pod = loadPod(req.params.id);
  if (!pod) return res.status(404).json({ error: 'Not found' });
  res.json({ pod: view(req, pod) });
});

// ---------- fun packs ----------
// Open any booster set just for fun: nothing is saved (no pod, no pool, no
// feed). Up to a box (36 packs) at a time, for testing the sheets.
// Rate-limited per player by packs opened, so Scryfall isn't hammered.
const FUN_WINDOW = 10 * 60 * 1000;
const FUN_MAX = 150;
const FUN_BATCH = 36;
const funOpens = new Map(); // userId -> timestamps, one per pack opened
app.post('/api/fun/open', wrap(async (req, res) => {
  const code = String(req.body?.set || '').toLowerCase();
  const set = (await allSets()).find(s => s.code === code);
  if (!set) throw new HttpError(400, 'Pick a set that came in boosters.');
  const count = req.body?.count === undefined ? 1 : Number(req.body.count);
  if (!Number.isInteger(count) || count < 1 || count > FUN_BATCH) throw new HttpError(400, `Open between 1 and ${FUN_BATCH} packs at a time.`);
  const t = Date.now();
  const recent = (funOpens.get(req.user.id) || []).filter(x => t - x < FUN_WINDOW);
  if (recent.length + count > FUN_MAX) {
    const left = FUN_MAX - recent.length;
    throw new HttpError(429, `That's ${FUN_MAX} fun packs in 10 minutes${left > 0 ? `; you can open ${left} more right now` : ''}. Give Scryfall a breather and try again shortly.`);
  }
  for (let i = 0; i < count; i++) recent.push(t);
  funOpens.set(req.user.id, recent);
  const packs = [];
  for (let i = 0; i < count; i++) packs.push(await openPack(set));
  res.json({ set: { code: set.code, name: set.name, icon: set.icon, released: set.released, type: set.type }, pack: packs[0], packs });
}));

// What a set's print sheets should produce, to compare a batch against.
app.get('/api/fun/odds/:code', wrap(async (req, res) => {
  const code = String(req.params.code || '').toLowerCase();
  const set = (await allSets()).find(s => s.code === code);
  if (!set) throw new HttpError(404, 'Unknown set.');
  const odds = (await sheetOdds(code)) || { real: false };
  // Print sheets only change with a deploy: let the browser keep complete odds for an hour.
  if (!odds.unresolved) res.set('Cache-Control', 'private, max-age=3600');
  res.json(odds);
}));

// ---------- feedback ----------
// Only the admin (new-count badge) and the author (status/reply) care, so the
// event carries just who to tell; everyone else ignores it.
feedbackRoutes(app, wrap, item => broadcast('feedback', { authorId: item.userId, status: item.deleted ? null : item.status, id: item.id }));

// ---------- pools ----------
// A player's pool in a league = their pool_cards from that league's running
// or finished pods (discarded or deleted pods don't count), including packs
// they got for pods they missed. Their precon is separate and not listed.
// ?pod=<id> narrows to one pod.
app.get('/api/pools', wrap(async (req, res) => {
  const league = viewLeague(req);
  if (!league) return res.json({ leagueId: null, pools: [] });
  const only = req.query.pod ? String(req.query.pod) : null;
  const hidden = new Set(listUsers().filter(u => u.is_admin).map(u => u.id));
  const pools = new Map(leagueMembers(league.id).map(m => [m.id, { userId: m.id, username: m.username, precon: m.precon, pods: [], packs: [] }]));
  const ensure = (userId, name) => pools.get(userId) || pools.set(userId, { userId, username: getUser(userId)?.username || name || 'former player', precon: '', pods: [], packs: [] }).get(userId);
  for (const r of poolPods(league.id)) {
    if ((only && r.id !== only) || hidden.has(r.user_id)) continue;
    ensure(r.user_id).pods.push({ id: r.id, name: r.name, status: r.status, createdAt: r.created_at, absent: r.role === 'absent' });
  }
  const packs = new Map();
  for (const r of poolCards(league.id)) {
    if ((only && r.pod_id !== only) || hidden.has(r.user_id)) continue;
    let k = packs.get(r.pack_id);
    if (!k) {
      k = { packId: r.pack_id, podId: r.pod_id, podName: r.pod_name, at: r.opened_at, set: setInfoFor(r.pack_set), source: r.source, absent: r.role === 'absent', ...(r.pack_kind ? { kind: r.pack_kind, note: r.pack_note || '' } : {}), cards: [] };
      packs.set(r.pack_id, k);
      ensure(r.user_id).packs.push(k);
    }
    k.cards.push(r.card);
  }
  res.json({ leagueId: league.id, pools: [...pools.values()].sort((a, b) => a.username.localeCompare(b.username)) });
}));

// ---------- player pages, season recaps, deck lists ----------
// A player page: their stats in one league (?league=…, default: the league
// on screen) or across every league they've been in (?league=all), plus
// their deck. Any signed-in player can look at any other player.
app.get('/api/players/:id', wrap(async (req, res) => {
  const u = getUser(req.params.id);
  if (!u || u.is_admin) throw new HttpError(404, 'Player not found');
  const theirs = leaguesOf(u.id).map(getLeague).filter(Boolean);
  const all = req.query.league === 'all';
  const league = all ? null : (req.query.league ? requireLeague(String(req.query.league)) : (viewLeague(req) && theirs.find(l => l.id === viewLeague(req).id)) || theirs[0] || null);
  const stats = await cached(`player:${u.id}:${league?.id || 'all'}`, 10 * 60e3, () => playerStats(u.id, league?.id || null));
  const rank = league ? standings(league.id).findIndex(s => s.id === u.id) : -1;
  res.json({
    player: { id: u.id, username: u.username, precon: u.precon || '', joined: u.created_at, leagues: theirs.map(l => ({ id: l.id, name: l.name, status: l.status })) },
    league: league ? { id: league.id, name: league.name, status: league.status, rank: rank >= 0 ? rank + 1 : null } : null,
    stats, deck: getDeck(u.id),
  });
}));
app.get('/api/leagues/:id/recap', wrap(async (req, res) => {
  const league = requireLeague(req.params.id);
  res.json({ league: { id: league.id, name: league.name, status: league.status, createdAt: league.createdAt, endedAt: league.endedAt }, ...(await cached(`recap:${league.id}`, 10 * 60e3, () => seasonRecap(league.id, standings(league.id)))) });
}));

const deckFail = err => { if (err instanceof DeckError) throw new HttpError(err.status, err.message); throw err; };
const deckImports = new Map();
app.get('/api/deck', (req, res) => res.json({ deck: getDeck(req.user.id) }));
app.post('/api/deck', wrap(async (req, res) => {
  // Each import asks Scryfall (and maybe a deck site) for up to ~4 lookups.
  const recent = (deckImports.get(req.user.id) || []).filter(t => Date.now() - t < 3600e3);
  if (recent.length >= 15) throw new HttpError(429, 'That\'s a lot of imports. Try again in an hour.');
  deckImports.set(req.user.id, [...recent, Date.now()]);
  const b = req.body || {};
  const deck = await importDeck(req.user.id, { url: b.url, text: b.text, name: b.name }).catch(deckFail);
  // A precon field left blank picks up the deck's name.
  if (!getUser(req.user.id).precon) setPrecon(req.user.id, deck.name);
  broadcast('state');
  res.json({ deck });
}));
app.put('/api/deck', wrap(async (req, res) => {
  const deck = await Promise.resolve().then(() => editDeck(req.user.id, req.body || {})).catch(deckFail);
  res.json({ deck });
}));
app.delete('/api/deck', wrap(async (req, res) => { deleteDeck(req.user.id); res.json({ ok: true }); }));

adminRoutes(app, { wrap, HttpError, broadcast, viewLeague, requireLeague, allSets, wheelFor, settingsFor, setInfo });
tradeRoutes(app, { wrap, HttpError, broadcast, viewLeague });

seedAdmin();
migrateToLeagues(globalSettings());
app.listen(PORT, () => {
  console.log(`Pre-Con Commander listening on :${PORT}`);
  allSets().then(s => console.log(`${s.length} booster sets available`)).catch(() => {});
});
