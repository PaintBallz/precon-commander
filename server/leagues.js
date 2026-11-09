// Leagues: the parent of pods. A league has 3–16 players, an invite code, its
// own rules (packs for winner / losers / absent players, vote bonus) and its
// own wheel. A player is in at most one active league; ended leagues stay as
// a read-only archive (standings, history, pools).
import crypto from 'node:crypto';
import { db, transaction } from './db.js';

export const LEAGUE_MIN = 3;
export const LEAGUE_MAX = 16;
export const DEFAULT_RULES = { winnerPacks: 3, loserPacks: 2, absentPacks: 1, voteBonus: 1 };
export const RULE_LIMITS = { winnerPacks: [0, 10], loserPacks: [0, 10], absentPacks: [0, 5], voteBonus: [0, 5] };

const now = () => new Date().toISOString();
// No 0/O or 1/I, so codes survive being read out loud.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    const code = Array.from(crypto.randomBytes(6), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
    if (!db.prepare('SELECT 1 FROM leagues WHERE code = ?').get(code)) return code;
  }
}

function leagueOf(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, code: r.code, status: r.status, createdAt: r.created_at, createdBy: r.created_by, endedAt: r.ended_at || null,
    rules: { ...DEFAULT_RULES, ...JSON.parse(r.rules || '{}') }, wheel: JSON.parse(r.wheel || '{}'),
  };
}
export const getLeague = id => leagueOf(db.prepare('SELECT * FROM leagues WHERE id = ?').get(id));
export const leagueByCode = code => leagueOf(db.prepare('SELECT * FROM leagues WHERE code = ?').get(String(code).trim().toUpperCase()));

export function listLeagues() {
  return db.prepare(`
    SELECT l.*, (SELECT count(*) FROM league_members m WHERE m.league_id = l.id AND m.left_at IS NULL) AS members,
           (SELECT count(*) FROM pods p WHERE p.league_id = l.id AND p.status != 'discarded' AND p.kind = 'pod') AS pods
    FROM leagues l ORDER BY l.status = 'ended', l.created_at DESC`).all()
    .map(r => ({ ...leagueOf(r), members: r.members, pods: r.pods }));
}

// The one active league a player is in (or null).
export function activeLeagueOf(userId) {
  return leagueOf(db.prepare(`
    SELECT l.* FROM leagues l JOIN league_members m ON m.league_id = l.id
    WHERE m.user_id = ? AND m.left_at IS NULL AND l.status = 'active'`).get(userId));
}
// Every league a player has been in, newest first.
export function leaguesOf(userId) {
  return db.prepare(`SELECT l.id FROM leagues l JOIN league_members m ON m.league_id = l.id WHERE m.user_id = ? ORDER BY l.created_at DESC`)
    .all(userId).map(r => r.id);
}

export function leagueMembers(leagueId, { former = false } = {}) {
  return db.prepare(`
    SELECT u.id, u.username, m.precon, m.precon_locked, m.commander, m.precon_request, u.is_test, u.staff, m.joined_at, m.left_at FROM league_members m JOIN users u ON u.id = m.user_id
    WHERE m.league_id = ? ${former ? '' : 'AND m.left_at IS NULL'} AND u.is_admin = 0
    ORDER BY m.left_at IS NOT NULL, u.username COLLATE NOCASE`).all(leagueId)
    .map(r => ({ id: r.id, username: r.username, precon: r.precon || '', preconLocked: !!r.precon_locked, commander: r.commander ? JSON.parse(r.commander) : null, preconRequest: r.precon_request ? JSON.parse(r.precon_request) : null, joinedAt: r.joined_at, leftAt: r.left_at || null, ...(r.is_test ? { test: true } : {}), ...(r.staff ? { admin: true } : {}) }));
}
// ---- a player's precon and commander card for one league ----
export const memberRow = (leagueId, userId) => db.prepare('SELECT * FROM league_members WHERE league_id = ? AND user_id = ?').get(leagueId, userId);
export const hasPrecon = (leagueId, userId) => !!memberRow(leagueId, userId)?.precon;
export const lockPrecon = (leagueId, userId, precon) => db.prepare('UPDATE league_members SET precon = ?, precon_locked = 1, precon_request = NULL WHERE league_id = ? AND user_id = ?').run(precon, leagueId, userId);
export const allowPreconChange = (leagueId, userId) => db.prepare('UPDATE league_members SET precon_locked = 0, precon_request = NULL WHERE league_id = ? AND user_id = ?').run(leagueId, userId);
export const setPreconRequest = (leagueId, userId, request) => db.prepare('UPDATE league_members SET precon_request = ? WHERE league_id = ? AND user_id = ?').run(request ? JSON.stringify(request) : null, leagueId, userId);
export const setCommander = (leagueId, userId, card) => db.prepare('UPDATE league_members SET commander = ? WHERE league_id = ? AND user_id = ?').run(card ? JSON.stringify(card) : null, leagueId, userId);
// Who in the league already has this precon (any capitalisation), if anyone.
export const preconTakenBy = (leagueId, precon, exceptUserId) => db.prepare(`SELECT u.username FROM league_members m JOIN users u ON u.id = m.user_id
  WHERE m.league_id = ? AND m.left_at IS NULL AND m.user_id != ? AND lower(m.precon) = lower(?)`).get(leagueId, exceptUserId, precon)?.username || null;

export const isMember = (leagueId, userId) =>
  !!db.prepare('SELECT 1 FROM league_members WHERE league_id = ? AND user_id = ? AND left_at IS NULL').get(leagueId, userId);

export function addMember(leagueId, userId, addedBy) {
  db.prepare(`INSERT INTO league_members (league_id, user_id, joined_at, left_at, added_by, kicked) VALUES (?, ?, ?, NULL, ?, 0)
              ON CONFLICT(league_id, user_id) DO UPDATE SET joined_at = excluded.joined_at, left_at = NULL, added_by = excluded.added_by, kicked = 0`)
    .run(leagueId, userId, now(), addedBy || null);
}
// kicked: the player was removed (not a leave), so the invite code no longer
// lets them back in; only the site admin can re-add them.
export function removeMember(leagueId, userId, { kicked = false } = {}) {
  db.prepare('UPDATE league_members SET left_at = ?, kicked = ? WHERE league_id = ? AND user_id = ? AND left_at IS NULL').run(now(), kicked ? 1 : 0, leagueId, userId);
}
export const wasKicked = (leagueId, userId) =>
  !!db.prepare('SELECT 1 FROM league_members WHERE league_id = ? AND user_id = ? AND kicked = 1').get(leagueId, userId);

export function createLeague({ name, createdBy, wheel, rules = DEFAULT_RULES }) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO leagues (id, name, code, status, created_at, created_by, rules, wheel) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`)
    .run(id, name, newCode(), now(), createdBy || null, JSON.stringify(rules), JSON.stringify(wheel || {}));
  return getLeague(id);
}
export function updateLeague(id, { name, rules, wheel }) {
  if (name != null) db.prepare('UPDATE leagues SET name = ? WHERE id = ?').run(name, id);
  if (rules) db.prepare('UPDATE leagues SET rules = ? WHERE id = ?').run(JSON.stringify(rules), id);
  if (wheel) db.prepare('UPDATE leagues SET wheel = ? WHERE id = ?').run(JSON.stringify(wheel), id);
  return getLeague(id);
}
export function newLeagueCode(id) {
  db.prepare('UPDATE leagues SET code = ? WHERE id = ?').run(newCode(), id);
  return getLeague(id);
}
export function endLeague(id) {
  db.prepare(`UPDATE leagues SET status = 'ended', ended_at = ? WHERE id = ?`).run(now(), id);
}
// Deletes the league with every pod in it (and their packs, pulls, votes).
export function deleteLeague(id) {
  transaction(() => {
    db.prepare('DELETE FROM pods WHERE league_id = ?').run(id);
    db.prepare('DELETE FROM leagues WHERE id = ?').run(id);
  });
}

// ---------- activity feed ----------
export function logEvent(leagueId, kind, actorId, text) {
  if (!leagueId) return;
  db.prepare('INSERT INTO league_events (league_id, at, kind, actor_id, text) VALUES (?, ?, ?, ?, ?)').run(leagueId, now(), kind, actorId || null, text);
}
export function leagueEvents(leagueId, limit = 60) {
  return db.prepare('SELECT at, kind, text FROM league_events WHERE league_id = ? ORDER BY id DESC LIMIT ?').all(leagueId, limit);
}

// ---------- one-time move of pre-league pods ----------
// Pods from before leagues existed go into "League 1", whose members are the
// players of those pods plus every other player account (up to 16).
export function migrateToLeagues(defaultWheel) {
  const orphans = db.prepare('SELECT id, created_by FROM pods WHERE league_id IS NULL ORDER BY created_at').all();
  if (!orphans.length) return;
  transaction(() => {
    const first = db.prepare(`SELECT created_by FROM pods WHERE league_id IS NULL AND created_by IS NOT NULL ORDER BY created_at LIMIT 1`).get();
    const league = createLeague({ name: 'League 1', createdBy: first?.created_by, wheel: defaultWheel });
    const played = db.prepare(`SELECT DISTINCT user_id FROM pod_players pp JOIN pods p ON p.id = pp.pod_id WHERE p.league_id IS NULL`).all().map(r => r.user_id);
    const others = db.prepare('SELECT id FROM users WHERE is_admin = 0 ORDER BY created_at').all().map(r => r.id);
    const members = [...new Set([...played, ...others])].slice(0, Math.max(LEAGUE_MAX, played.length));
    for (const u of members) addMember(league.id, u, null);
    db.prepare('UPDATE pods SET league_id = ? WHERE league_id IS NULL').run(league.id);
    logEvent(league.id, 'league', null, `League 1 was set up with the ${orphans.length} pod(s) played before leagues existed.`);
    console.log(`Moved ${orphans.length} pre-league pod(s) and ${members.length} player(s) into League 1`);
  });
}
