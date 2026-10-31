// SQLite storage (Node's built-in node:sqlite — no native build step).
// Pods and settings are stored as JSON documents; the app is tiny and
// single-process, so this keeps the schema trivial. Accounts and sessions get
// real columns because they are looked up by username / email / token.
// (The old single-game `games` table is left in place but no longer used.)
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pods (
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

export function savePod(pod) {
  db.prepare(`INSERT INTO pods (id, status, created_at, finished_at, data) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at, data = excluded.data`)
    .run(pod.id, pod.status, pod.createdAt, pod.finishedAt || null, JSON.stringify(pod));
}
export function loadPod(id) {
  const row = db.prepare('SELECT data FROM pods WHERE id = ?').get(id);
  return row ? JSON.parse(row.data) : null;
}
export function activePods() {
  return db.prepare(`SELECT data FROM pods WHERE status IN ('playing','awarded') ORDER BY created_at`).all().map(r => JSON.parse(r.data));
}
export function finishedPods() {
  return db.prepare(`SELECT data FROM pods WHERE status = 'done' ORDER BY finished_at DESC`).all().map(r => JSON.parse(r.data));
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
