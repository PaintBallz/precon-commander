// Pre-Con Commander — game-night wheel + booster opener.
// One shared "current game" that every phone sees live (Server-Sent Events).
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { saveGame, loadGame, currentGame, finishedGames, lastGame, kvGet, kvSet } from './db.js';
import { getBoosterSets, BOOSTER_SET_TYPES } from './scryfall.js';
import { openPack, hasRealPack, realPackKind, localPackSets } from './packs.js';

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WINNER_PACKS = 3;
const LOSER_PACKS = 2;

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], maxAge: 0 }));

const id = (n = 8) => crypto.randomBytes(n).toString('base64url').slice(0, n);
const now = () => new Date().toISOString();
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
  if (!(err instanceof HttpError)) console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong' });
});

// ---------- live updates ----------
const clients = new Set();
let version = Date.now();
function broadcast(kind = 'state') {
  version = Date.now();
  const msg = `event: ${kind}\ndata: ${JSON.stringify({ version })}\n\n`;
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

// ---------- sets + wheel settings ----------
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

// ---------- game state ----------
function remaining(p) { return p.awarded - p.sacrificed - p.packs.length; }
function publicGame(g) {
  if (!g) return null;
  return { ...g, players: g.players.map(p => ({ ...p, remaining: remaining(p) })) };
}
function requireGame() {
  const g = currentGame();
  if (!g) throw new HttpError(404, 'No game in progress — start one on the Game tab.');
  return g;
}
function findPlayer(g, playerId) {
  const p = g.players.find(p => p.id === playerId);
  if (!p) throw new HttpError(404, 'Player not found');
  return p;
}
function findPack(g, packId) {
  for (const p of g.players) {
    const pack = p.packs.find(k => k.id === packId);
    if (pack) return { player: p, pack };
  }
  throw new HttpError(404, 'Pack not found');
}
async function setInfo(code) {
  const s = (await allSets()).find(s => s.code === code);
  if (!s) throw new HttpError(400, `Unknown set ${code}`);
  return { code: s.code, name: s.name, icon: s.icon, released: s.released, type: s.type };
}
function commit(g, kind) { g.updatedAt = now(); saveGame(g); broadcast(kind); return publicGame(g); }

app.get('/api/state', (req, res) => {
  const g = currentGame();
  const last = g ? null : lastGame();
  res.json({ version, game: publicGame(g), lastPlayers: (g || last)?.players.map(p => ({ name: p.name, precon: p.precon })) || [] });
});

app.post('/api/game', wrap(async (req, res) => {
  if (currentGame()) throw new HttpError(409, 'A game is already in progress. Finish or discard it first.');
  const players = (req.body?.players || []).map(p => ({ name: String(p.name || '').trim().slice(0, 40), precon: String(p.precon || '').trim().slice(0, 80) })).filter(p => p.name);
  if (players.length < 2 || players.length > 8) throw new HttpError(400, 'Enter between 2 and 8 player names.');
  const g = {
    id: id(10),
    status: 'playing',
    createdAt: now(),
    winnerId: null,
    players: players.map((p, i) => ({ id: `p${i + 1}`, name: p.name, precon: p.precon, awarded: 0, sacrificed: 0, packs: [] })),
    spins: [],
  };
  res.json({ game: commit(g, 'state') });
}));

app.post('/api/game/winner', wrap(async (req, res) => {
  const g = requireGame();
  const winner = findPlayer(g, req.body?.playerId);
  if (g.players.some(p => p.packs.length || p.sacrificed)) throw new HttpError(409, 'Packs have already been spun — adjust pack counts instead of changing the winner.');
  g.winnerId = winner.id;
  g.status = 'awarded';
  g.wonAt = now();
  for (const p of g.players) p.awarded = p.id === winner.id ? WINNER_PACKS : LOSER_PACKS;
  res.json({ game: commit(g, 'state') });
}));

app.post('/api/game/award', wrap(async (req, res) => {
  const g = requireGame();
  const p = findPlayer(g, req.body?.playerId);
  const delta = Math.sign(Number(req.body?.delta) || 0);
  if (delta < 0 && remaining(p) < 1) throw new HttpError(409, `${p.name} has no unspun packs to remove.`);
  p.awarded = Math.max(0, p.awarded + delta);
  res.json({ game: commit(g, 'state') });
}));

app.post('/api/game/spin', wrap(async (req, res) => {
  const g = requireGame();
  if (g.status !== 'awarded') throw new HttpError(409, 'Pick the winner first — packs are awarded after the game.');
  const p = findPlayer(g, req.body?.playerId);
  if (remaining(p) < 1) throw new HttpError(409, `${p.name} has no packs left to spin for.`);
  const sets = await allSets();
  const wheel = wheelFor(sets, getSettings());
  if (!wheel.length) throw new HttpError(409, 'The wheel is empty — loosen the wheel filters.');
  const total = wheel.reduce((s, w) => s + w.weight, 0);
  let r = Math.random() * total, pick = wheel[wheel.length - 1];
  for (const w of wheel) { r -= w.weight; if (r < 0) { pick = w; break; } }
  const set = await setInfo(pick.code);
  const pack = { id: id(10), status: 'ready', source: 'wheel', set, wheelSet: set, spunAt: now(), cards: null };
  p.packs.push(pack);
  const spin = { id: id(10), playerId: p.id, packId: pack.id, setCode: set.code, at: now(), offset: Math.random() };
  g.spins.push(spin);
  res.json({ game: commit(g, 'spin'), spin });
}));

app.post('/api/game/pack/:packId/sacrifice', wrap(async (req, res) => {
  const g = requireGame();
  const { player, pack } = findPack(g, req.params.packId);
  if (pack.status !== 'ready' || pack.source !== 'wheel') throw new HttpError(409, 'Only an unopened pack from the wheel can be swapped.');
  if (remaining(player) < 1) throw new HttpError(409, `${player.name} needs another unspun pack to sacrifice.`);
  player.sacrificed += 1;
  pack.status = 'choosing';
  pack.source = 'sacrifice';
  pack.sacrificedAt = now();
  res.json({ game: commit(g, 'state'), packId: pack.id });
}));

app.post('/api/game/pack/:packId/choose', wrap(async (req, res) => {
  const g = requireGame();
  const { pack } = findPack(g, req.params.packId);
  if (pack.status !== 'choosing') throw new HttpError(409, 'This pack is not waiting for a set choice.');
  pack.set = await setInfo(String(req.body?.setCode || ''));
  pack.status = 'ready';
  pack.chosenAt = now();
  res.json({ game: commit(g, 'state'), packId: pack.id });
}));

const opening = new Set();
app.post('/api/game/pack/:packId/open', wrap(async (req, res) => {
  const packId = req.params.packId;
  if (opening.has(packId)) throw new HttpError(409, 'That pack is already being opened.');
  let g = requireGame();
  let { pack } = findPack(g, packId);
  if (pack.status === 'opened') return res.json({ game: publicGame(g), pack });
  if (pack.status !== 'ready') throw new HttpError(409, 'Choose a set for this pack first.');
  opening.add(packId);
  try {
    const sets = await allSets();
    const set = sets.find(s => s.code === pack.set.code) || pack.set;
    const result = await openPack(set);
    // Re-load in case something else changed while Scryfall was answering.
    g = requireGame();
    ({ pack } = findPack(g, packId));
    pack.cards = result.cards;
    pack.boosterType = result.boosterType;
    pack.generated = result.generated;
    pack.status = 'opened';
    pack.openedAt = now();
    res.json({ game: commit(g, 'state'), pack });
  } finally {
    opening.delete(packId);
  }
}));

app.post('/api/game/finish', wrap(async (req, res) => {
  const g = requireGame();
  if (!g.winnerId) throw new HttpError(409, 'Pick a winner before finishing the game.');
  g.status = 'done';
  g.finishedAt = now();
  saveGame(g);
  broadcast('state');
  res.json({ ok: true });
}));

app.post('/api/game/discard', wrap(async (req, res) => {
  const g = requireGame();
  g.status = 'discarded';
  g.finishedAt = now();
  saveGame(g);
  broadcast('state');
  res.json({ ok: true });
}));

app.get('/api/history', (req, res) => res.json({ games: finishedGames() }));
app.get('/api/game/:id', (req, res) => {
  const g = loadGame(req.params.id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  res.json({ game: publicGame(g) });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Pre-Con Commander listening on :${PORT}`);
  allSets().then(s => console.log(`${s.length} booster sets available`)).catch(() => {});
});
