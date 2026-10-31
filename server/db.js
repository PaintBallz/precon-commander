// SQLite storage (Node's built-in node:sqlite — no native build step).
//
// League data lives in real tables:
//   pods         one row per pod (status, winner, the pod's single spin)
//   pod_players  who sat in each pod, their precon and pack counts
//   pod_packs    every pack in a pod (spun set, sacrificed → chosen set, opened)
//   pool_cards   every opened card, tied to its pod, pack and player: a
//                player's pool is their pool_cards in pods that weren't discarded
//   booster_sets name/icon/date for set codes the packs refer to
// Deleting a pod cascades to its players, packs and pool cards.
// Settings and Scryfall caches stay as small JSON documents.
// (The old single-game `games` table and the pre-table `pods_legacy_json` are
// left in place, unused.)
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// Pods used to be one JSON document per row; move that table aside so the
// relational one can take its name, then import its rows below.
const legacyPods = db.prepare(`SELECT 1 FROM pragma_table_info('pods') WHERE name = 'data'`).get();
if (legacyPods) db.exec('ALTER TABLE pods RENAME TO pods_legacy_json');

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT UNIQUE COLLATE NOCASE,
    pass_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    must_change INTEGER NOT NULL DEFAULT 0,
    precon TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reset_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS booster_sets (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    released TEXT,
    type TEXT
  );
  CREATE TABLE IF NOT EXISTS pods (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('playing', 'awarded', 'done', 'discarded')),
    created_at TEXT NOT NULL,
    created_by TEXT,
    winner_id TEXT,
    won_at TEXT,
    finished_at TEXT,
    updated_at TEXT,
    spin_id TEXT,
    spin_set_code TEXT REFERENCES booster_sets(code),
    spin_by TEXT,
    spin_at TEXT,
    spin_offset REAL
  );
  CREATE INDEX IF NOT EXISTS pods_status ON pods(status, created_at);
  CREATE TABLE IF NOT EXISTS pod_players (
    pod_id TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    seat INTEGER NOT NULL,
    name TEXT NOT NULL,
    precon TEXT NOT NULL DEFAULT '',
    awarded INTEGER NOT NULL DEFAULT 0,
    sacrificed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (pod_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS pod_players_user ON pod_players(user_id);
  CREATE TABLE IF NOT EXISTS pod_packs (
    id TEXT PRIMARY KEY,
    pod_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ready', 'choosing', 'opened')),
    source TEXT NOT NULL CHECK (source IN ('wheel', 'sacrifice')),
    set_code TEXT REFERENCES booster_sets(code),
    wheel_set_code TEXT REFERENCES booster_sets(code),
    booster_type TEXT,
    generated INTEGER,
    sacrificed_at TEXT,
    chosen_at TEXT,
    opened_at TEXT,
    FOREIGN KEY (pod_id, user_id) REFERENCES pod_players(pod_id, user_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS pod_packs_pod ON pod_packs(pod_id, user_id, seq);
  CREATE TABLE IF NOT EXISTS pool_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pod_id TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
    pack_id TEXT NOT NULL REFERENCES pod_packs(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    name TEXT NOT NULL,
    set_code TEXT NOT NULL,
    number TEXT NOT NULL,
    rarity TEXT NOT NULL,
    type TEXT,
    foil INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    back TEXT,
    uri TEXT
  );
  CREATE INDEX IF NOT EXISTS pool_cards_user ON pool_cards(user_id, pod_id);
  CREATE INDEX IF NOT EXISTS pool_cards_pack ON pool_cards(pack_id, seq);

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS card_cache (
    key TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS set_pool (
    code TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL,
    data TEXT NOT NULL
  );
`);

export function kvGet(key, fallback = null) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
export function kvSet(key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (err) { db.exec('ROLLBACK'); throw err; }
}

// ---------- pods ----------
// The rest of the app works with a pod as one object:
// { id, name, status, createdAt, createdBy, winnerId, wonAt, finishedAt, updatedAt,
//   spin: { id, setCode, set, by, at, offset } | null,
//   players: [{ id, name, precon, awarded, sacrificed,
//               packs: [{ id, status, source, set, wheelSet, boosterType, generated, sacrificedAt, chosenAt, openedAt, cards }] }] }
// savePod writes that object into the tables; loadPod reads it back.

function putSet(set) {
  if (!set?.code) return null;
  db.prepare(`INSERT INTO booster_sets (code, name, icon, released, type) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(code) DO UPDATE SET name = excluded.name, icon = excluded.icon, released = excluded.released, type = excluded.type`)
    .run(set.code, set.name || set.code.toUpperCase(), set.icon || null, set.released || null, set.type || null);
  return set.code;
}

export function savePod(pod) {
  transaction(() => {
    db.prepare(`INSERT INTO pods (id, name, status, created_at, created_by, winner_id, won_at, finished_at, updated_at, spin_id, spin_set_code, spin_by, spin_at, spin_offset)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status, winner_id = excluded.winner_id, won_at = excluded.won_at,
                  finished_at = excluded.finished_at, updated_at = excluded.updated_at, spin_id = excluded.spin_id, spin_set_code = excluded.spin_set_code,
                  spin_by = excluded.spin_by, spin_at = excluded.spin_at, spin_offset = excluded.spin_offset`)
      .run(pod.id, pod.name, pod.status, pod.createdAt, pod.createdBy || null, pod.winnerId || null, pod.wonAt || null, pod.finishedAt || null,
        pod.updatedAt || null, pod.spin?.id || null, putSet(pod.spin?.set), pod.spin?.by || null, pod.spin?.at || null, pod.spin?.offset ?? null);

    const upPlayer = db.prepare(`INSERT INTO pod_players (pod_id, user_id, seat, name, precon, awarded, sacrificed) VALUES (?, ?, ?, ?, ?, ?, ?)
                                 ON CONFLICT(pod_id, user_id) DO UPDATE SET seat = excluded.seat, name = excluded.name, precon = excluded.precon,
                                   awarded = excluded.awarded, sacrificed = excluded.sacrificed`);
    const upPack = db.prepare(`INSERT INTO pod_packs (id, pod_id, user_id, seq, status, source, set_code, wheel_set_code, booster_type, generated, sacrificed_at, chosen_at, opened_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                               ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, status = excluded.status, source = excluded.source, set_code = excluded.set_code,
                                 wheel_set_code = excluded.wheel_set_code, booster_type = excluded.booster_type, generated = excluded.generated,
                                 sacrificed_at = excluded.sacrificed_at, chosen_at = excluded.chosen_at, opened_at = excluded.opened_at`);
    const hasCards = db.prepare('SELECT 1 FROM pool_cards WHERE pack_id = ? LIMIT 1');
    const addCard = db.prepare(`INSERT INTO pool_cards (pod_id, pack_id, user_id, seq, name, set_code, number, rarity, type, foil, image, back, uri)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const keepPacks = [];
    pod.players.forEach((p, seat) => {
      upPlayer.run(pod.id, p.id, seat, p.name, p.precon || '', p.awarded, p.sacrificed);
      p.packs.forEach((k, seq) => {
        keepPacks.push(k.id);
        upPack.run(k.id, pod.id, p.id, seq, k.status, k.source, putSet(k.set), putSet(k.wheelSet), k.boosterType || null,
          k.generated == null ? null : Number(!!k.generated), k.sacrificedAt || null, k.chosenAt || null, k.openedAt || null);
        // Opened cards never change, so they're written once.
        if (k.status === 'opened' && k.cards?.length && !hasCards.get(k.id)) {
          k.cards.forEach((c, i) => addCard.run(pod.id, k.id, p.id, i, c.name, c.set, String(c.number), c.rarity, c.type || null,
            Number(!!c.foil), c.image || null, c.back || null, c.uri || null));
        }
      });
    });
    // Packs that left the pod (sacrificed, or removed by the admin).
    const placeholders = keepPacks.map(() => '?').join(',');
    db.prepare(`DELETE FROM pod_packs WHERE pod_id = ? ${keepPacks.length ? `AND id NOT IN (${placeholders})` : ''}`).run(pod.id, ...keepPacks);
    const keepPlayers = pod.players.map(p => p.id);
    db.prepare(`DELETE FROM pod_players WHERE pod_id = ? AND user_id NOT IN (${keepPlayers.map(() => '?').join(',')})`).run(pod.id, ...keepPlayers);
  });
}

const setRow = db.prepare('SELECT code, name, icon, released, type FROM booster_sets WHERE code = ?');
function getSet(code, cache) {
  if (!code) return null;
  if (!cache.has(code)) {
    const r = setRow.get(code);
    cache.set(code, r ? { code: r.code, name: r.name, icon: r.icon || '', released: r.released || '', type: r.type || '' } : { code, name: code.toUpperCase(), icon: '', released: '', type: '' });
  }
  return cache.get(code);
}
const cardOf = c => ({ name: c.name, set: c.set_code, number: c.number, rarity: c.rarity, type: c.type || '', image: c.image, back: c.back || null, uri: c.uri, foil: !!c.foil });

function assemble(rows) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const marks = ids.map(() => '?').join(',');
  const players = db.prepare(`SELECT * FROM pod_players WHERE pod_id IN (${marks}) ORDER BY pod_id, seat`).all(...ids);
  const packs = db.prepare(`SELECT * FROM pod_packs WHERE pod_id IN (${marks}) ORDER BY pod_id, user_id, seq`).all(...ids);
  const cards = db.prepare(`SELECT * FROM pool_cards WHERE pod_id IN (${marks}) ORDER BY pack_id, seq`).all(...ids);
  const sets = new Map();
  const cardsByPack = new Map();
  for (const c of cards) (cardsByPack.get(c.pack_id) || cardsByPack.set(c.pack_id, []).get(c.pack_id)).push(cardOf(c));
  const packsBy = new Map();
  for (const k of packs) {
    const key = `${k.pod_id}|${k.user_id}`;
    (packsBy.get(key) || packsBy.set(key, []).get(key)).push({
      id: k.id, status: k.status, source: k.source, set: getSet(k.set_code, sets), wheelSet: getSet(k.wheel_set_code, sets),
      boosterType: k.booster_type || undefined, generated: k.generated == null ? undefined : !!k.generated,
      sacrificedAt: k.sacrificed_at || undefined, chosenAt: k.chosen_at || undefined, openedAt: k.opened_at || undefined,
      cards: k.status === 'opened' ? cardsByPack.get(k.id) || [] : null,
    });
  }
  const playersBy = new Map();
  for (const p of players) {
    (playersBy.get(p.pod_id) || playersBy.set(p.pod_id, []).get(p.pod_id)).push({
      id: p.user_id, name: p.name, precon: p.precon, awarded: p.awarded, sacrificed: p.sacrificed, packs: packsBy.get(`${p.pod_id}|${p.user_id}`) || [],
    });
  }
  return rows.map(r => ({
    id: r.id, name: r.name, status: r.status, createdAt: r.created_at, createdBy: r.created_by, winnerId: r.winner_id,
    wonAt: r.won_at || undefined, finishedAt: r.finished_at || undefined, updatedAt: r.updated_at || undefined,
    spin: r.spin_id ? { id: r.spin_id, setCode: r.spin_set_code, set: getSet(r.spin_set_code, sets), by: r.spin_by, at: r.spin_at, offset: r.spin_offset } : null,
    players: playersBy.get(r.id) || [],
  }));
}

export function loadPod(id) {
  return assemble(db.prepare('SELECT * FROM pods WHERE id = ?').all(id))[0] || null;
}
export function activePods() {
  return assemble(db.prepare(`SELECT * FROM pods WHERE status IN ('playing','awarded') ORDER BY created_at`).all());
}
export function finishedPods() {
  return assemble(db.prepare(`SELECT * FROM pods WHERE status = 'done' ORDER BY finished_at DESC`).all());
}
export function deletePod(id) {
  return db.prepare('DELETE FROM pods WHERE id = ?').run(id).changes > 0;
}

// ---------- pools ----------
// Every opened card in a pod that counts (running or finished), with the pod
// and pack it came from.
export function poolCards() {
  return db.prepare(`
    SELECT c.*, k.set_code AS pack_set, k.source, k.opened_at, p.name AS pod_name, p.status AS pod_status
    FROM pool_cards c
    JOIN pod_packs k ON k.id = c.pack_id
    JOIN pods p ON p.id = c.pod_id
    WHERE p.status IN ('playing', 'awarded', 'done')
    ORDER BY c.user_id, k.opened_at, c.pack_id, c.seq`).all()
    .map(r => ({ ...r, card: cardOf(r) }));
}
export function poolPods() {
  return db.prepare(`
    SELECT pp.user_id, p.id, p.name, p.status, p.created_at
    FROM pod_players pp JOIN pods p ON p.id = pp.pod_id
    WHERE p.status IN ('playing', 'awarded', 'done')
    ORDER BY p.created_at`).all();
}
export const setInfoFor = code => getSet(code, new Map());

// ---------- one-time import of pre-table pods ----------
if (legacyPods) {
  const rows = db.prepare('SELECT data FROM pods_legacy_json ORDER BY created_at').all();
  for (const r of rows) {
    const pod = JSON.parse(r.data);
    if (!db.prepare('SELECT 1 FROM pods WHERE id = ?').get(pod.id)) savePod(pod);
  }
  console.log(`Moved ${rows.length} pod(s) from JSON documents into the pod tables`);
}

export function cacheGetMany(keys) {
  const out = new Map();
  const stmt = db.prepare('SELECT data FROM card_cache WHERE key = ?');
  for (const k of keys) {
    const row = stmt.get(k);
    if (row) out.set(k, JSON.parse(row.data));
  }
  return out;
}
export function cachePut(key, value) {
  db.prepare('INSERT INTO card_cache (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data')
    .run(key, JSON.stringify(value));
}

export function poolGet(code) {
  const row = db.prepare('SELECT data, fetched_at FROM set_pool WHERE code = ?').get(code);
  return row ? { cards: JSON.parse(row.data), fetchedAt: row.fetched_at } : null;
}
export function poolPut(code, cards) {
  db.prepare('INSERT INTO set_pool (code, fetched_at, data) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data')
    .run(code, new Date().toISOString(), JSON.stringify(cards));
}

export { DATA_DIR };
