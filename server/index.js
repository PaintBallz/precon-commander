// Pre-Con Commander — league companion: pods, one wheel spin per pod, booster
// opener and per-player card pools. Every phone sees changes live (Server-Sent Events).
//
// League = everyone with an account. Pod = one game of 2–4 league players.
// When a pod ends, its winner spins the wheel ONCE. Every player's packs are
// that set (winner 3, everyone else 2); a player can Sacrifice a Pack (give up
// one of their spun-set packs) to turn another one into any set they like.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { savePod, loadPod, activePods, finishedPods, deletePod, deleteHistory, poolCard, deletePoolCard, poolCards, poolPods, setInfoFor, kvGet, kvSet } from './db.js';
import { getBoosterSets, BOOSTER_SET_TYPES } from './scryfall.js';
import { openPack, hasRealPack, realPackKind, localPackSets } from './packs.js';
import { requireAuth, requireAdmin, authRoutes, seedAdmin, listUsers, getUser } from './auth.js';

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WINNER_PACKS = 3;
const LOSER_PACKS = 2;
const MAX_POD = 4;

const app = express();
app.set('trust proxy', 'loopback, uniquelocal');
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
  .replace('/app.js"', `/app.js?v=${ASSET_VERSION}"`);
app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-cache').type('html').send(INDEX_HTML);
});
app.use(express.static(PUBLIC, { extensions: ['html'], maxAge: 0 }));

const id = (n = 8) => crypto.randomBytes(n).toString('base64url').slice(0, n);
const now = () => new Date().toISOString();
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong' });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/api', requireAuth);
authRoutes(app, wrap);

// ---------- live updates ----------
const clients = new Set();
let version = Date.now();
function broadcast(kind = 'state', data = {}) {
  version = Date.now();
  const msg = `event: ${kind}\ndata: ${JSON.stringify({ version, ...data })}\n\n`;
  for (const res of clients) res.write(msg);
}
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ version })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

// ---------- sets + wheel settings (admin edits, everyone reads) ----------
const DEFAULT_SETTINGS = { minYear: 1993, maxYear: 2100, types: [...BOOSTER_SET_TYPES], excluded: [], weights: {} };
function getSettings() { return { ...DEFAULT_SETTINGS, ...kvGet('wheel_settings', {}) }; }

async function allSets() {
  const sets = await getBoosterSets(localPackSets());
  return sets.map(s => ({ ...s, realPack: hasRealPack(s.code), packKind: realPackKind(s.code) }));
}

function wheelFor(sets, settings) {
  const excluded = new Set(settings.excluded);
  return sets
    .filter(s => settings.types.includes(s.type) && s.year >= settings.minYear && s.year <= settings.maxYear && !excluded.has(s.code))
    .map(s => ({ code: s.code, weight: Number(settings.weights[s.code] ?? 1) }))
    .filter(s => s.weight > 0);
}

app.get('/api/sets', wrap(async (req, res) => {
  const sets = await allSets();
  const settings = getSettings();
  const wheel = wheelFor(sets, settings);
  const total = wheel.reduce((s, w) => s + w.weight, 0);
  const onWheel = new Map(wheel.map(w => [w.code, w.weight]));
  res.json({
    settings,
    types: BOOSTER_SET_TYPES,
    sets: sets.map(s => ({ ...s, weight: Number(settings.weights[s.code] ?? 1), onWheel: onWheel.has(s.code), chance: onWheel.has(s.code) ? onWheel.get(s.code) / total : 0 })),
    wheel,
  });
}));

app.put('/api/settings', wrap(async (req, res) => {
  requireAdmin(req);
  const b = req.body || {};
  const s = getSettings();
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
  kvSet('wheel_settings', s);
  broadcast('sets');
  res.json({ ok: true, settings: s });
}));

// ---------- league members ----------
const members = () => listUsers().map(u => ({ id: u.id, username: u.username, precon: u.precon || '', isAdmin: !!u.is_admin }));
app.get('/api/members', (req, res) => res.json({ members: members() }));

// ---------- pods ----------
const spunPacks = p => p.packs.filter(k => k.status === 'ready' && k.source === 'wheel');
function requirePod(podId) {
  const pod = loadPod(podId);
  if (!pod || !['playing', 'awarded'].includes(pod.status)) throw new HttpError(404, 'That pod is not running.');
  return pod;
}
function findPlayer(pod, playerId) {
  const p = pod.players.find(p => p.id === playerId);
  if (!p) throw new HttpError(404, 'Player not found in this pod');
  return p;
}
function findPack(pod, packId) {
  for (const p of pod.players) {
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
function commit(pod, kind = 'state', data = {}) { pod.updatedAt = now(); savePod(pod); broadcast(kind, { podId: pod.id, ...data }); return loadPod(pod.id); }

app.get('/api/state', (req, res) => {
  res.json({ version, me: req.user, pods: activePods(), members: members() });
});

app.post('/api/pods', wrap(async (req, res) => {
  const wanted = Array.isArray(req.body?.players) ? req.body.players : [];
  const ids = wanted.map(p => String(p.userId || '')).filter(Boolean);
  if (ids.length < 2 || ids.length > MAX_POD) throw new HttpError(400, `A pod has 2 to ${MAX_POD} players.`);
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Each player can only be in the pod once.');
  const busy = new Map(activePods().flatMap(pod => pod.players.map(p => [p.id, pod])));
  const players = wanted.map((w, i) => {
    const u = getUser(String(w.userId));
    if (!u) throw new HttpError(400, `Player ${i + 1} is not a league member.`);
    if (busy.has(u.id)) throw new HttpError(409, `${u.username} is already playing in ${busy.get(u.id).name}.`);
    const precon = String(w.precon ?? u.precon ?? '').trim().slice(0, 80);
    return { id: u.id, name: u.username, precon, awarded: 0, sacrificed: 0, packs: [] };
  });
  if (!req.user.isAdmin && !ids.includes(req.user.id)) throw new HttpError(403, 'Add yourself to the pod (only the admin can start pods for others).');
  const n = kvGet('pod_counter', 0) + 1;
  kvSet('pod_counter', n);
  const pod = { id: id(10), name: `Pod ${n}`, status: 'playing', createdAt: now(), createdBy: req.user.id, winnerId: null, spin: null, players };
  res.json({ pod: commit(pod) });
}));

app.post('/api/pods/:id/winner', wrap(async (req, res) => {
  const pod = requirePod(req.params.id);
  requireMember(pod, req.user);
  if (pod.spin) throw new HttpError(409, 'The wheel has already been spun. Ask the admin to adjust packs instead.');
  const winner = findPlayer(pod, req.body?.playerId);
  pod.winnerId = winner.id;
  pod.status = 'awarded';
  pod.wonAt = now();
  for (const p of pod.players) p.awarded = p.id === winner.id ? WINNER_PACKS : LOSER_PACKS;
  res.json({ pod: commit(pod) });
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
  res.json({ pod: commit(pod) });
}));

// The one spin per pod. Only the winner (or the admin) can pull the lever.
app.post('/api/pods/:id/spin', wrap(async (req, res) => {
  const pod = requirePod(req.params.id);
  if (pod.status !== 'awarded') throw new HttpError(409, 'Crown the winner first: the winner spins the wheel.');
  if (pod.spin) throw new HttpError(409, `This pod already spun ${pod.spin.set.name}. There is only one spin per pod.`);
  if (!req.user.isAdmin && req.user.id !== pod.winnerId) throw new HttpError(403, `Only the winner, ${findPlayer(pod, pod.winnerId).name}, can spin.`);
  const sets = await allSets();
  const wheel = wheelFor(sets, getSettings());
  if (!wheel.length) throw new HttpError(409, 'The wheel is empty. The admin needs to loosen the wheel filters.');
  const total = wheel.reduce((s, w) => s + w.weight, 0);
  let r = Math.random() * total, pick = wheel[wheel.length - 1];
  for (const w of wheel) { r -= w.weight; if (r < 0) { pick = w; break; } }
  const set = await setInfo(pick.code);
  pod.spin = { id: id(10), setCode: set.code, set, by: req.user.id, at: now(), offset: Math.random() };
  for (const p of pod.players) p.packs = Array.from({ length: p.awarded }, () => newPack(set));
  res.json({ pod: commit(pod, 'spin', { spinId: pod.spin.id }), spin: pod.spin });
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
  player.sacrificed += 1;
  pack.status = 'choosing';
  pack.source = 'sacrifice';
  pack.sacrificedAt = now();
  res.json({ pod: commit(pod), packId: pack.id });
}));

app.post('/api/pods/:id/packs/:packId/choose', wrap(async (req, res) => {
  const pod = requirePod(req.params.id);
  const { player, pack } = findPack(pod, req.params.packId);
  requireOwner(player, req.user);
  if (pack.status !== 'choosing') throw new HttpError(409, 'This pack is not waiting for a set choice.');
  pack.set = await setInfo(String(req.body?.setCode || ''));
  pack.status = 'ready';
  pack.chosenAt = now();
  res.json({ pod: commit(pod), packId: pack.id });
}));

const opening = new Set();
app.post('/api/pods/:id/packs/:packId/open', wrap(async (req, res) => {
  const { packId } = req.params;
  let pod = requirePod(req.params.id);
  let { player, pack } = findPack(pod, packId);
  requireOwner(player, req.user);
  if (pack.status === 'opened') return res.json({ pod, pack });
  if (pack.status !== 'ready') throw new HttpError(409, 'Choose a set for this pack first.');
  if (opening.has(packId)) throw new HttpError(409, 'That pack is already being opened.');
  opening.add(packId);
  try {
    const sets = await allSets();
    const set = sets.find(s => s.code === pack.set.code) || pack.set;
    const result = await openPack(set);
    // Re-load in case something else changed while Scryfall was answering.
    pod = requirePod(req.params.id);
    ({ pack } = findPack(pod, packId));
    pack.cards = result.cards;
    pack.boosterType = result.boosterType;
    pack.generated = result.generated;
    pack.status = 'opened';
    pack.openedAt = now();
    const saved = commit(pod);
    res.json({ pod: saved, pack: findPack(saved, packId).pack });
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
  res.json({ ok: true, pod: commit(pod) });
}));

app.post('/api/pods/:id/discard', wrap(async (req, res) => {
  const pod = requirePod(req.params.id);
  requireMember(pod, req.user);
  pod.status = 'discarded';
  pod.finishedAt = now();
  commit(pod);
  res.json({ ok: true });
}));

// Admin: permanently delete a pod (running, finished or discarded). Its
// players, packs and pool cards go with it.
app.delete('/api/pods/:id', wrap(async (req, res) => {
  requireAdmin(req);
  const pod = loadPod(req.params.id);
  if (!pod) throw new HttpError(404, 'Pod not found');
  deletePod(pod.id);
  broadcast('state', { podId: pod.id, deleted: true });
  res.json({ ok: true, deleted: { id: pod.id, name: pod.name } });
}));

// Admin: remove one pack from any pod (its pulls leave the pool with it).
app.delete('/api/pods/:id/packs/:packId', wrap(async (req, res) => {
  requireAdmin(req);
  const pod = loadPod(req.params.id);
  if (!pod) throw new HttpError(404, 'Pod not found');
  const { player, pack } = findPack(pod, req.params.packId);
  player.packs.splice(player.packs.indexOf(pack), 1);
  player.awarded = Math.max(0, player.awarded - 1);
  pod.updatedAt = now();
  savePod(pod);
  broadcast('state', { podId: pod.id });
  res.json({ ok: true, pod: loadPod(pod.id), removed: { packId: pack.id, cards: pack.cards?.length || 0 } });
}));

// Admin: remove a single pulled card from a player's pool.
app.delete('/api/pool-cards/:cardId', wrap(async (req, res) => {
  requireAdmin(req);
  const card = poolCard(Number(req.params.cardId));
  if (!card) throw new HttpError(404, 'Card not found');
  deletePoolCard(card.id);
  broadcast('state', { podId: card.pod_id });
  res.json({ ok: true, removed: { id: card.id, name: card.name, podId: card.pod_id } });
}));

// Admin: clear league history (every finished and discarded pod, with their
// packs and pool cards). Running pods are untouched.
app.delete('/api/history', wrap(async (req, res) => {
  requireAdmin(req);
  const n = deleteHistory();
  broadcast('state');
  res.json({ ok: true, deletedPods: n });
}));

app.get('/api/history', (req, res) => res.json({ pods: finishedPods() }));
app.get('/api/pods/:id', (req, res) => {
  const pod = loadPod(req.params.id);
  if (!pod) return res.status(404).json({ error: 'Not found' });
  res.json({ pod });
});

// ---------- pools ----------
// A player's pool = their pool_cards in running or finished pods (discarded
// or deleted pods don't count), grouped by the pod and pack each came from.
// Their precon is separate and not listed. ?pod=<id> narrows to one pod.
app.get('/api/pools', (req, res) => {
  const only = req.query.pod ? String(req.query.pod) : null;
  const pools = new Map(listUsers().map(u => [u.id, { userId: u.id, username: u.username, precon: u.precon || '', pods: [], packs: [] }]));
  const ensure = (userId, name) => pools.get(userId) || pools.set(userId, { userId, username: name || 'former player', precon: '', pods: [], packs: [] }).get(userId);
  for (const r of poolPods()) {
    if (only && r.id !== only) continue;
    ensure(r.user_id).pods.push({ id: r.id, name: r.name, status: r.status, createdAt: r.created_at });
  }
  const packs = new Map();
  for (const r of poolCards()) {
    if (only && r.pod_id !== only) continue;
    let k = packs.get(r.pack_id);
    if (!k) {
      k = { packId: r.pack_id, podId: r.pod_id, podName: r.pod_name, at: r.opened_at, set: setInfoFor(r.pack_set), source: r.source, cards: [] };
      packs.set(r.pack_id, k);
      ensure(r.user_id).packs.push(k);
    }
    k.cards.push(r.card);
  }
  res.json({ pools: [...pools.values()].sort((a, b) => a.username.localeCompare(b.username)) });
});

seedAdmin();
app.listen(PORT, () => {
  console.log(`Pre-Con Commander listening on :${PORT}`);
  allSets().then(s => console.log(`${s.length} booster sets available`)).catch(() => {});
});
