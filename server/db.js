// SQLite storage (Node's built-in node:sqlite — no native build step).
//
// League data lives in real tables:
//   leagues        a league: name, invite code, rules, its own wheel; active or ended
//   league_members who is (or was) in each league; a player is in one active league
//   league_events  the league's activity feed
//   pods         one row per pod (league, status, winner, the pod's single spin)
//   pod_players  who sat in each pod (role 'player') and the league members
//                who missed it (role 'absent', they get packs of the spun set)
//   pod_packs    every pack in a pod (spun set, sacrificed → chosen set, opened)
//   pool_cards   every opened card, tied to its pod, pack and player: a
//                player's pool is their pool_cards in pods that weren't discarded
//   booster_sets name/icon/date for set codes the packs refer to
//   pod_votes    the pod's bonus-pack vote: one ballot per voter per round
//                (a tie starts a new round between the tied players)
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
  CREATE TABLE IF NOT EXISTS pod_votes (
    pod_id TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    voter_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    cast_at TEXT NOT NULL,
    PRIMARY KEY (pod_id, round, voter_id)
  );

  CREATE TABLE IF NOT EXISTS leagues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
    created_at TEXT NOT NULL,
    created_by TEXT,
    ended_at TEXT,
    rules TEXT NOT NULL,
    wheel TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS league_members (
    league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    left_at TEXT,
    added_by TEXT,
    PRIMARY KEY (league_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS league_members_user ON league_members(user_id, left_at);
  CREATE TABLE IF NOT EXISTS league_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    actor_id TEXT,
    text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS league_events_league ON league_events(league_id, id);

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    username TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    reply TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS feedback_user ON feedback(user_id, created_at);

  -- Every admin action. undo holds what's needed to reverse it (a snapshot
  -- of deleted rows, or the old values) for 30 days, then it's cleared.
  CREATE TABLE IF NOT EXISTS admin_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    admin_id TEXT,
    action TEXT NOT NULL,
    summary TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    league_id TEXT,
    undo TEXT,
    undone_at TEXT
  );
  CREATE INDEX IF NOT EXISTS admin_log_at ON admin_log(at);

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

// Columns added after these tables first shipped.
for (const [table, col, def] of [
  ['pods', 'vote_status', 'TEXT'], ['pods', 'vote_round', 'INTEGER'], ['pods', 'vote_winner_id', 'TEXT'], ['pods', 'vote_decided_at', 'TEXT'],
  ['pods', 'league_id', 'TEXT'], ['pods', 'rules', 'TEXT'],
  ['pod_players', 'role', "TEXT NOT NULL DEFAULT 'player'"],
  ['league_members', 'kicked', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'terms_accepted_at', 'TEXT'],
  // 'pod' (a game) or 'grants' (one per league: holds packs the admin hands out and cards moved between pools)
  ['pods', 'kind', "TEXT NOT NULL DEFAULT 'pod'"],
  // 'grant' (handed out by the admin) or 'trade' (carries a card moved between pools; not counted as a pack)
  ['pod_packs', 'kind', 'TEXT'], ['pod_packs', 'note', 'TEXT'], ['pod_packs', 'granted_by', 'TEXT'],
  ['users', 'suspended_at', 'TEXT'], ['users', 'suspended_reason', 'TEXT'],
  // The admin's "view as player" (read-only) for this session.
  ['sessions', 'view_as', 'TEXT'],
]) {
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
// One index per filter or sort the app runs (see EXPLAIN QUERY PLAN checks in
// the e2e test). Primary keys and UNIQUE columns (users.username/email,
// leagues.code, sessions.token, reset_tokens.token, kv/card_cache/set_pool
// keys) are indexed by SQLite already.
db.exec(`
  CREATE INDEX IF NOT EXISTS pods_league ON pods(league_id, status);
  CREATE INDEX IF NOT EXISTS pods_league_finished ON pods(league_id, status, finished_at);
  CREATE INDEX IF NOT EXISTS pods_league_created ON pods(league_id, created_at);
  CREATE INDEX IF NOT EXISTS pod_packs_user ON pod_packs(user_id, status);
  CREATE INDEX IF NOT EXISTS pool_cards_pod ON pool_cards(pod_id, pack_id, seq);
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS reset_tokens_user ON reset_tokens(user_id);
  CREATE INDEX IF NOT EXISTS reset_tokens_expires ON reset_tokens(expires_at);
  CREATE INDEX IF NOT EXISTS users_admin ON users(is_admin, created_at);
  CREATE INDEX IF NOT EXISTS feedback_status ON feedback(status, id);
  CREATE INDEX IF NOT EXISTS leagues_status ON leagues(status, created_at);
`);

export function kvGet(key, fallback = null) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
export function kvSet(key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (err) { db.exec('ROLLBACK'); throw err; }
}

// ---------- pods ----------
// The rest of the app works with a pod as one object:
// { id, leagueId, name, status, createdAt, createdBy, winnerId, wonAt, finishedAt, updatedAt,
//   rules: { winnerPacks, loserPacks, absentPacks, voteBonus } (the league's rules when the pod started),
//   spin: { id, setCode, set, by, at, offset } | null,
//   vote: { status: 'open'|'done'|'skipped', round, winnerId, decidedAt, ballots: [{ round, voterId, candidateId, at }] } | null,
//   players: [{ id, name, precon, awarded, sacrificed,
//               packs: [{ id, status, source, set, wheelSet, boosterType, generated, sacrificedAt, chosenAt, openedAt, cards }] }],
//   absentees: [{ id, name, packs }] }   league members who missed the pod
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
    db.prepare('UPDATE pods SET league_id = ?, rules = ?, kind = ? WHERE id = ?').run(pod.leagueId || null, pod.rules ? JSON.stringify(pod.rules) : null, pod.kind || 'pod', pod.id);
    const v = pod.vote;
    db.prepare('UPDATE pods SET vote_status = ?, vote_round = ?, vote_winner_id = ?, vote_decided_at = ? WHERE id = ?')
      .run(v?.status || null, v?.round ?? null, v?.winnerId || null, v?.decidedAt || null, pod.id);
    db.prepare('DELETE FROM pod_votes WHERE pod_id = ?').run(pod.id);
    const addBallot = db.prepare('INSERT INTO pod_votes (pod_id, round, voter_id, candidate_id, cast_at) VALUES (?, ?, ?, ?, ?)');
    for (const b of v?.ballots || []) addBallot.run(pod.id, b.round, b.voterId, b.candidateId, b.at);

    const upPlayer = db.prepare(`INSERT INTO pod_players (pod_id, user_id, seat, name, precon, awarded, sacrificed, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                                 ON CONFLICT(pod_id, user_id) DO UPDATE SET seat = excluded.seat, name = excluded.name, precon = excluded.precon,
                                   awarded = excluded.awarded, sacrificed = excluded.sacrificed, role = excluded.role`);
    const upPack = db.prepare(`INSERT INTO pod_packs (id, pod_id, user_id, seq, status, source, set_code, wheel_set_code, booster_type, generated, sacrificed_at, chosen_at, opened_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                               ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, status = excluded.status, source = excluded.source, set_code = excluded.set_code,
                                 wheel_set_code = excluded.wheel_set_code, booster_type = excluded.booster_type, generated = excluded.generated,
                                 sacrificed_at = excluded.sacrificed_at, chosen_at = excluded.chosen_at, opened_at = excluded.opened_at`);
    const hasCards = db.prepare('SELECT 1 FROM pool_cards WHERE pack_id = ? LIMIT 1');
    const addCard = db.prepare(`INSERT INTO pool_cards (pod_id, pack_id, user_id, seq, name, set_code, number, rarity, type, foil, image, back, uri)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const keepPacks = [];
    const people = [...pod.players.map(p => ({ ...p, role: 'player' })), ...(pod.absentees || []).map(p => ({ ...p, role: p.grant ? 'grant' : 'absent' }))];
    const packExtras = db.prepare('UPDATE pod_packs SET kind = ?, note = ?, granted_by = ? WHERE id = ?');
    people.forEach((p, seat) => {
      upPlayer.run(pod.id, p.id, seat, p.name, p.precon || '', p.awarded || 0, p.sacrificed || 0, p.role);
      p.packs.forEach((k, seq) => {
        keepPacks.push(k.id);
        upPack.run(k.id, pod.id, p.id, seq, k.status, k.source, putSet(k.set), putSet(k.wheelSet), k.boosterType || null,
          k.generated == null ? null : Number(!!k.generated), k.sacrificedAt || null, k.chosenAt || null, k.openedAt || null);
        if (k.kind || k.note || k.grantedBy) packExtras.run(k.kind || null, k.note || null, k.grantedBy || null, k.id);
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
    const keepPlayers = people.map(p => p.id);
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
const cardOf = c => ({ id: c.id, name: c.name, set: c.set_code, number: c.number, rarity: c.rarity, type: c.type || '', image: c.image, back: c.back || null, uri: c.uri, foil: !!c.foil });

function assemble(rows) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const marks = ids.map(() => '?').join(',');
  const players = db.prepare(`SELECT * FROM pod_players WHERE pod_id IN (${marks}) ORDER BY pod_id, seat`).all(...ids);
  const packs = db.prepare(`SELECT * FROM pod_packs WHERE pod_id IN (${marks}) ORDER BY pod_id, user_id, seq`).all(...ids);
  const cards = db.prepare(`SELECT * FROM pool_cards WHERE pod_id IN (${marks}) ORDER BY pack_id, seq`).all(...ids);
  const ballots = db.prepare(`SELECT * FROM pod_votes WHERE pod_id IN (${marks}) ORDER BY pod_id, round, cast_at`).all(...ids);
  const ballotsBy = new Map();
  for (const b of ballots) (ballotsBy.get(b.pod_id) || ballotsBy.set(b.pod_id, []).get(b.pod_id)).push({ round: b.round, voterId: b.voter_id, candidateId: b.candidate_id, at: b.cast_at });
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
      ...(k.kind ? { kind: k.kind } : {}), ...(k.note ? { note: k.note } : {}), ...(k.granted_by ? { grantedBy: k.granted_by } : {}),
    });
  }
  const playersBy = new Map(), absentBy = new Map();
  for (const p of players) {
    const packs = packsBy.get(`${p.pod_id}|${p.user_id}`) || [];
    if (p.role === 'absent' || p.role === 'grant') {
      (absentBy.get(p.pod_id) || absentBy.set(p.pod_id, []).get(p.pod_id)).push({ id: p.user_id, name: p.name, packs, ...(p.role === 'grant' ? { grant: true } : {}) });
      continue;
    }
    (playersBy.get(p.pod_id) || playersBy.set(p.pod_id, []).get(p.pod_id)).push({
      id: p.user_id, name: p.name, precon: p.precon, awarded: p.awarded, sacrificed: p.sacrificed, packs,
    });
  }
  return rows.map(r => ({
    id: r.id, leagueId: r.league_id || null, rules: r.rules ? JSON.parse(r.rules) : null, kind: r.kind || 'pod',
    name: r.name, status: r.status, createdAt: r.created_at, createdBy: r.created_by, winnerId: r.winner_id,
    wonAt: r.won_at || undefined, finishedAt: r.finished_at || undefined, updatedAt: r.updated_at || undefined,
    spin: r.spin_id ? { id: r.spin_id, setCode: r.spin_set_code, set: getSet(r.spin_set_code, sets), by: r.spin_by, at: r.spin_at, offset: r.spin_offset } : null,
    vote: r.vote_status ? { status: r.vote_status, round: r.vote_round, winnerId: r.vote_winner_id || null, decidedAt: r.vote_decided_at || undefined, ballots: ballotsBy.get(r.id) || [] } : null,
    players: playersBy.get(r.id) || [],
    absentees: absentBy.get(r.id) || [],
  }));
}

export function loadPod(id) {
  return assemble(db.prepare('SELECT * FROM pods WHERE id = ?').all(id))[0] || null;
}
// leagueId narrows to one league; leave it out for every league.
const inLeague = leagueId => (leagueId ? ['AND league_id = ?', [leagueId]] : ['', []]);
export function activePods(leagueId) {
  const [where, args] = inLeague(leagueId);
  return assemble(db.prepare(`SELECT * FROM pods WHERE status IN ('playing','awarded') ${where} ORDER BY created_at`).all(...args));
}
// The "Admin packs" containers (one per league, or every league).
export function grantsPods(leagueId) {
  const [where, args] = inLeague(leagueId);
  return assemble(db.prepare(`SELECT * FROM pods WHERE kind = 'grants' ${where}`).all(...args));
}
export function finishedPods(leagueId) {
  const [where, args] = inLeague(leagueId);
  return assemble(db.prepare(`SELECT * FROM pods WHERE status = 'done' AND kind = 'pod' ${where} ORDER BY finished_at DESC`).all(...args));
}
// A player's unopened packs in a league, wherever they are: pods they played
// (running or finished) and pods they missed.
export function pendingPacks(userId, leagueId) {
  return db.prepare(`
    SELECT k.id AS pack_id, k.status, k.set_code, k.note, k.kind, p.id AS pod_id, p.name AS pod_name, p.status AS pod_status, pp.role
    FROM pod_packs k JOIN pods p ON p.id = k.pod_id
    JOIN pod_players pp ON pp.pod_id = k.pod_id AND pp.user_id = k.user_id
    WHERE k.user_id = ? AND p.league_id = ? AND k.status != 'opened' AND p.status IN ('playing', 'awarded', 'done')
    ORDER BY p.created_at, k.seq`).all(userId, leagueId)
    .map(r => ({ packId: r.pack_id, status: r.status, set: getSet(r.set_code, new Map()), podId: r.pod_id, podName: r.pod_name, podStatus: r.pod_status, absent: r.role === 'absent', ...(r.kind === 'catchup' ? { catchup: true } : {}), ...(r.role === 'grant' ? { grant: true, note: r.note || '' } : {}) }));
}
export function deletePod(id) {
  return db.prepare('DELETE FROM pods WHERE id = ?').run(id).changes > 0;
}
// Clearing league history removes every finished and discarded pod; running pods stay.
export function deleteHistory(leagueId) {
  const [where, args] = inLeague(leagueId);
  return db.prepare(`DELETE FROM pods WHERE status IN ('done', 'discarded') AND kind = 'pod' ${where}`).run(...args).changes;
}
export function poolCard(id) {
  return db.prepare('SELECT c.*, p.name AS pod_name FROM pool_cards c JOIN pods p ON p.id = c.pod_id WHERE c.id = ?').get(id) || null;
}
export function deletePoolCard(id) {
  return db.prepare('DELETE FROM pool_cards WHERE id = ?').run(id).changes > 0;
}

// ---------- pools ----------
// Every opened card in a pod that counts (running or finished), with the pod
// and pack it came from.
export function poolCards(leagueId) {
  return db.prepare(`
    SELECT c.*, k.set_code AS pack_set, k.source, k.opened_at, k.kind AS pack_kind, k.note AS pack_note, p.name AS pod_name, p.status AS pod_status, pp.role
    FROM pool_cards c
    JOIN pod_packs k ON k.id = c.pack_id
    JOIN pods p ON p.id = c.pod_id
    JOIN pod_players pp ON pp.pod_id = c.pod_id AND pp.user_id = c.user_id
    WHERE p.status IN ('playing', 'awarded', 'done') AND p.league_id = ?
    ORDER BY c.user_id, k.opened_at, c.pack_id, c.seq`).all(leagueId)
    .map(r => ({ ...r, card: cardOf(r) }));
}
export function poolPods(leagueId) {
  return db.prepare(`
    SELECT pp.user_id, pp.role, p.id, p.name, p.status, p.created_at
    FROM pod_players pp JOIN pods p ON p.id = pp.pod_id
    WHERE p.status IN ('playing', 'awarded', 'done') AND p.kind = 'pod' AND p.league_id = ?
    ORDER BY p.created_at`).all(leagueId);
}
export const setInfoFor = code => getSet(code, new Map());

// ---------- the league's "Admin packs" container ----------
// Packs the admin hands out (and cards moved between pools) live in one
// pod-shaped row per league with kind 'grants', so opening, pools and the
// pending-packs banner work the same as for any pod. It never counts as a
// game: standings, History and the recap only read kind = 'pod'.
export const grantsPodId = leagueId => `grants-${leagueId}`;
export function grantsPod(leagueId, { create = false } = {}) {
  const existing = loadPod(grantsPodId(leagueId));
  if (existing || !create) return existing;
  const at = new Date().toISOString();
  return { id: grantsPodId(leagueId), leagueId, kind: 'grants', name: 'Admin packs', status: 'done', createdAt: at, finishedAt: at, updatedAt: at,
    createdBy: null, winnerId: null, rules: null, spin: null, vote: null, players: [], absentees: [] };
}

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
