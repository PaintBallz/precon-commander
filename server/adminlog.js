// The admin log: every admin action, with a reason, and for 30 days enough
// to undo it. Deletes don't lose anything for those 30 days: before rows are
// deleted, they're copied into the log entry (a "snapshot"), and Undo puts
// them back exactly as they were (same ids, same cards).
import { db, transaction } from './db.js';

export const UNDO_DAYS = 30;
const now = () => new Date().toISOString();

// ---------- snapshots ----------
const all = (sql, ...args) => db.prepare(sql).all(...args);
const marks = ids => ids.map(() => '?').join(',');
// Everything that belongs to some pods: the pods, who sat in them, their
// packs and cards, and their votes.
export function podRows(podIds) {
  if (!podIds.length) return {};
  const m = marks(podIds);
  return {
    pods: all(`SELECT * FROM pods WHERE id IN (${m})`, ...podIds),
    pod_players: all(`SELECT * FROM pod_players WHERE pod_id IN (${m})`, ...podIds),
    pod_packs: all(`SELECT * FROM pod_packs WHERE pod_id IN (${m})`, ...podIds),
    pool_cards: all(`SELECT * FROM pool_cards WHERE pod_id IN (${m})`, ...podIds),
    pod_votes: all(`SELECT * FROM pod_votes WHERE pod_id IN (${m})`, ...podIds),
  };
}
export const packRows = packIds => (packIds.length ? {
  pod_packs: all(`SELECT * FROM pod_packs WHERE id IN (${marks(packIds)})`, ...packIds),
  pool_cards: all(`SELECT * FROM pool_cards WHERE pack_id IN (${marks(packIds)})`, ...packIds),
} : {});
export const cardRows = cardIds => ({ pool_cards: all(`SELECT * FROM pool_cards WHERE id IN (${marks(cardIds)})`, ...cardIds) });
export function leagueRows(leagueId) {
  const podIds = all('SELECT id FROM pods WHERE league_id = ?', leagueId).map(r => r.id);
  return {
    leagues: all('SELECT * FROM leagues WHERE id = ?', leagueId),
    league_members: all('SELECT * FROM league_members WHERE league_id = ?', leagueId),
    league_events: all('SELECT * FROM league_events WHERE league_id = ?', leagueId),
    ...podRows(podIds),
  };
}
// Parents before children, so foreign keys are satisfied on the way back in.
const ORDER = ['leagues', 'league_members', 'league_events', 'pods', 'pod_players', 'pod_packs', 'pool_cards', 'pod_votes'];
function insertRows(rows) {
  for (const table of ORDER) {
    for (const row of rows[table] || []) {
      const cols = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${marks(cols)})`).run(...cols.map(c => row[c]));
    }
  }
}

// ---------- the log ----------
// undo: { type: 'restore', rows, replacePods?: [ids] } | { type: 'ungrant', packIds } |
//       { type: 'unmove', cardId, from: { pod_id, pack_id, user_id }, tradePackId } |
//       { type: 'rename', userId, from } | { type: 'unsuspend', userId } | null (can't be undone)
export function logAdmin(req, { action, summary, reason = '', leagueId = null, undo = null }) {
  const r = db.prepare('INSERT INTO admin_log (at, admin_id, action, summary, reason, league_id, undo) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(now(), req.realUser?.id || req.user?.id || null, action, summary, String(reason || '').trim().slice(0, 300), leagueId, undo ? JSON.stringify(undo) : null);
  return Number(r.lastInsertRowid);
}
export function adminLog(limit = 100) {
  const cutoff = Date.now() - UNDO_DAYS * 864e5;
  return db.prepare(`SELECT l.*, u.username AS admin_name FROM admin_log l LEFT JOIN users u ON u.id = l.admin_id ORDER BY l.id DESC LIMIT ?`).all(limit)
    .map(r => ({
      id: r.id, at: r.at, admin: r.admin_name || 'admin', action: r.action, summary: r.summary, reason: r.reason, leagueId: r.league_id,
      undoneAt: r.undone_at || null, canUndo: !!r.undo && !r.undone_at && Date.parse(r.at) > cutoff,
    }));
}
// Snapshots older than 30 days are dropped; the log line stays.
export function purgeOldUndo() {
  const cutoff = new Date(Date.now() - UNDO_DAYS * 864e5).toISOString();
  return db.prepare('UPDATE admin_log SET undo = NULL WHERE undo IS NOT NULL AND at < ?').run(cutoff).changes;
}

export class UndoError extends Error { constructor(msg) { super(msg); this.status = 409; } }
// Reverses one logged action. Returns the entry. Throws UndoError when the
// world has moved on (e.g. the pod a pack belonged to is gone).
export function undoAction(id, req) {
  const entry = db.prepare('SELECT * FROM admin_log WHERE id = ?').get(id);
  if (!entry) { const e = new Error('No such log entry.'); e.status = 404; throw e; }
  if (entry.undone_at) throw new UndoError('That was already undone.');
  if (!entry.undo || Date.parse(entry.at) < Date.now() - UNDO_DAYS * 864e5) throw new UndoError(`That can't be undone${entry.undo ? ` (more than ${UNDO_DAYS} days ago)` : ''}.`);
  const u = JSON.parse(entry.undo);
  transaction(() => {
    if (u.type === 'restore') {
      if (u.replacePods?.length) db.prepare(`DELETE FROM pods WHERE id IN (${marks(u.replacePods)})`).run(...u.replacePods);
      try { insertRows(u.rows); } catch (err) {
        throw new UndoError(/UNIQUE|PRIMARY/.test(err.message) ? 'Part of it already exists again, so it can\'t be put back.' : /FOREIGN KEY/.test(err.message) ? 'What it belonged to (a pod, pack or league) is gone, so it can\'t be put back.' : `Couldn't undo: ${err.message}`);
      }
    } else if (u.type === 'ungrant') {
      const packs = db.prepare(`SELECT id, status FROM pod_packs WHERE id IN (${marks(u.packIds)})`).all(...u.packIds);
      if (packs.some(k => k.status === 'opened')) throw new UndoError('Some of those packs were already opened. Remove them one by one from the pack list instead.');
      db.prepare(`DELETE FROM pod_packs WHERE id IN (${marks(u.packIds)})`).run(...u.packIds);
    } else if (u.type === 'unmove') {
      const card = db.prepare('SELECT * FROM pool_cards WHERE id = ?').get(u.cardId);
      if (!card) throw new UndoError('That card is no longer in any pool.');
      if (!db.prepare('SELECT 1 FROM pod_packs WHERE id = ?').get(u.from.pack_id)) throw new UndoError('The pack it came from is gone.');
      db.prepare('UPDATE pool_cards SET pod_id = ?, pack_id = ?, user_id = ? WHERE id = ?').run(u.from.pod_id, u.from.pack_id, u.from.user_id, u.cardId);
      if (!db.prepare('SELECT 1 FROM pool_cards WHERE pack_id = ?').get(u.tradePackId)) db.prepare('DELETE FROM pod_packs WHERE id = ?').run(u.tradePackId);
    } else if (u.type === 'rename') {
      const taken = db.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').get(u.from, u.userId);
      if (taken) throw new UndoError(`Someone else is called ${u.from} now.`);
      renameEverywhere(u.userId, u.from);
    } else if (u.type === 'unsuspend') {
      db.prepare('UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?').run(u.userId);
    } else throw new UndoError('Unknown kind of action.');
    db.prepare('UPDATE admin_log SET undone_at = ? WHERE id = ?').run(now(), id);
  });
  logAdmin(req, { action: 'undo', summary: `Undid: ${entry.summary}`, leagueId: entry.league_id });
  return entry;
}

// A new username everywhere it's shown: the account, pod seats and feed text.
export function renameEverywhere(userId, username) {
  const old = db.prepare('SELECT username FROM users WHERE id = ?').get(userId)?.username;
  if (!old) return;
  const word = new RegExp(`\\b${old.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\b`, 'g');
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, userId);
  db.prepare('UPDATE pod_players SET name = ? WHERE user_id = ?').run(username, userId);
  const events = db.prepare(`SELECT id, text FROM league_events WHERE text LIKE ? AND league_id IN (SELECT league_id FROM league_members WHERE user_id = ?)`).all(`%${old}%`, userId);
  const fix = db.prepare('UPDATE league_events SET text = ? WHERE id = ?');
  for (const e of events) fix.run(e.text.replace(word, username), e.id);
}
