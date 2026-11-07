// Admin tools (the Admin tab): dashboard, pack manager, moving cards between
// pools, fixing finished pods, player tools, announcements, the admin log
// with undo, and backups. Every route here is site-admin only, except
// stopping "view as player" (the session is the admin's, but req.user is the
// player being viewed).
import crypto from 'node:crypto';
import { db, kvGet, kvSet, loadPod, savePod, activePods, pendingPacks, poolCard, grantsPod, setInfoFor, transaction } from './db.js';
import { getLeague, leagueMembers, isMember, logEvent, listLeagues } from './leagues.js';
import { requireAdmin, getUser, listUsers, publicUser, checkUsername, setViewAs, endAllSessions } from './auth.js';
import { logAdmin, adminLog, undoAction, purgeOldUndo, podRows, renameEverywhere } from './adminlog.js';
import { listBackups, makeBackup, backupFile, scheduleBackups } from './backup.js';
import { mailEnabled, lastMail } from './mail.js';
import { discordEnabled, discordInvite, lastDiscord, announcementPost, testPost } from './discord.js';
import { rateStats } from './ratelimit.js';
import { newFeedbackCount } from './feedback.js';

const now = () => new Date().toISOString();
const newId = (n = 10) => crypto.randomBytes(n).toString('base64url').slice(0, n);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const names = list => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);
const reasonOf = b => String(b?.reason || '').trim().slice(0, 300);
const withReason = (text, reason) => (!reason ? text : text.endsWith('.') ? `${text.slice(0, -1)} (${reason}).` : `${text} (${reason})`);

// ---------- announcements ----------
// One message at the top of the site for every signed-in player, until it's
// cleared or its end date passes.
export function currentAnnouncement() {
  const a = kvGet('announcement');
  if (!a?.text) return null;
  if (a.until && Date.parse(a.until) < Date.now()) return null;
  return a;
}

export function adminRoutes(app, { wrap, HttpError, broadcast, viewLeague, requireLeague, allSets, wheelFor, settingsFor, setInfo }) {
  purgeOldUndo();
  setInterval(purgeOldUndo, 6 * 3600e3).unref();
  scheduleBackups();
  const changed = (leagueId, extra = {}) => broadcast('state', { leagueId: leagueId || null, ...extra });

  // ---------- dashboard ----------
  app.get('/api/admin/overview', wrap(async (req, res) => {
    requireAdmin(req);
    const users = listUsers().filter(u => !u.is_admin);
    const leagues = listLeagues();
    const running = activePods();
    const dayAgo = Date.now() - 864e5;
    const leagueName = id => leagues.find(l => l.id === id)?.name || '';
    const piles = [];
    for (const l of leagues.filter(l => l.status === 'active')) {
      for (const m of leagueMembers(l.id)) {
        const n = pendingPacks(m.id, l.id).length;
        if (n) piles.push({ userId: m.id, name: m.username, league: l.name, count: n });
      }
    }
    const backups = listBackups();
    res.json({
      counts: {
        players: users.length, suspended: users.filter(u => u.suspended_at).length,
        activeLeagues: leagues.filter(l => l.status === 'active').length, runningPods: running.length,
        unopenedPacks: piles.reduce((n, p) => n + p.count, 0), feedbackNew: newFeedbackCount(),
      },
      stuck: running.filter(p => Date.parse(p.updatedAt || p.createdAt) < dayAgo)
        .map(p => ({ id: p.id, name: p.name, league: leagueName(p.leagueId), status: p.status, since: p.updatedAt || p.createdAt })),
      piles: piles.sort((a, b) => b.count - a.count).slice(0, 8),
      email: { enabled: mailEnabled(), last: { ...lastMail } },
      discord: { enabled: discordEnabled(), invite: Boolean(discordInvite()), last: { ...lastDiscord } },
      limits: rateStats(),
      backups: { count: backups.length, latest: backups[0] || null },
      announcement: kvGet('announcement'),
      log: adminLog(6),
    });
  }));

  // ---------- the admin log + undo ----------
  app.get('/api/admin/log', wrap(async (req, res) => {
    requireAdmin(req);
    res.json({ entries: adminLog(Math.min(500, Number(req.query.limit) || 100)) });
  }));
  app.post('/api/admin/log/:id/undo', wrap(async (req, res) => {
    requireAdmin(req);
    const entry = undoAction(Number(req.params.id), req);
    changed(entry.league_id);
    res.json({ ok: true, entries: adminLog(100) });
  }));

  // ---------- pack manager ----------
  // Give packs: to one or more league members, a chosen set, one spin of the
  // league's wheel, or "their choice" (they pick the set, like a sacrificed
  // pack). They land in the league's "Admin packs" container.
  app.post('/api/admin/grants', wrap(async (req, res) => {
    requireAdmin(req);
    const b = req.body || {};
    const league = requireLeague(String(b.league || viewLeague(req)?.id || ''));
    if (league.status !== 'active') throw new HttpError(409, `${league.name} has ended.`);
    const userIds = [...new Set((Array.isArray(b.userIds) ? b.userIds : []).map(String))];
    if (!userIds.length) throw new HttpError(400, 'Pick at least one player.');
    const people = userIds.map(id => {
      const u = getUser(id);
      if (!u || u.is_admin || !isMember(league.id, id)) throw new HttpError(400, `${u?.username || 'That player'} isn't in ${league.name}.`);
      return u;
    });
    const count = Number(b.count ?? 1);
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new HttpError(400, 'Give between 1 and 10 packs at a time.');
    const mode = ['set', 'wheel', 'choice'].includes(b.mode) ? b.mode : 'set';
    let set = null;
    if (mode === 'set') set = await setInfo(String(b.setCode || '').toLowerCase());
    if (mode === 'wheel') {
      const wheel = wheelFor(await allSets(), settingsFor(league));
      if (!wheel.length) throw new HttpError(409, 'The wheel is empty.');
      let r = Math.random() * wheel.reduce((s, w) => s + w.weight, 0), pick = wheel.at(-1);
      for (const w of wheel) { r -= w.weight; if (r < 0) { pick = w; break; } }
      set = await setInfo(pick.code);
    }
    const reason = reasonOf(b);
    const pod = grantsPod(league.id, { create: true });
    const packIds = [];
    for (const u of people) {
      let who = pod.absentees.find(a => a.id === u.id);
      if (!who) { who = { id: u.id, name: u.username, grant: true, packs: [] }; pod.absentees.push(who); }
      who.name = u.username;
      for (let i = 0; i < count; i++) {
        const k = { id: newId(), status: set ? 'ready' : 'choosing', source: 'wheel', set, wheelSet: set, cards: null, kind: 'grant', note: reason, grantedBy: req.user.id };
        who.packs.push(k);
        packIds.push(k.id);
      }
    }
    pod.updatedAt = now();
    savePod(pod);
    const what = set ? `${plural(count, `${set.name} pack`)}` : `${plural(count, 'pack')} of their choice`;
    const text = withReason(`The admin gave ${names(people.map(u => u.username))} ${what}${people.length > 1 ? ' each' : ''}${mode === 'wheel' ? ' (spun on the wheel)' : ''}.`, reason);
    logEvent(league.id, 'pod', req.user.id, text);
    logAdmin(req, { action: 'grant', summary: text, reason, leagueId: league.id, undo: { type: 'ungrant', packIds } });
    changed(league.id, { podId: pod.id });
    res.json({ ok: true, set, packIds });
  }));

  // Every member's unopened packs in a league (running pods, finished pods,
  // admin packs), so any of them can be taken back.
  app.get('/api/admin/packs', wrap(async (req, res) => {
    requireAdmin(req);
    const league = req.query.league ? requireLeague(String(req.query.league)) : viewLeague(req);
    if (!league) return res.json({ leagueId: null, players: [] });
    res.json({
      leagueId: league.id,
      players: leagueMembers(league.id).map(m => ({ id: m.id, username: m.username, packs: pendingPacks(m.id, league.id) })),
    });
  }));

  // ---------- move a card to another player's pool ----------
  app.post('/api/admin/pool-cards/:id/move', wrap(async (req, res) => {
    requireAdmin(req);
    const card = poolCard(Number(req.params.id));
    if (!card) throw new HttpError(404, 'Card not found');
    const from = loadPod(card.pod_id);
    if (!from?.leagueId) throw new HttpError(409, "That card isn't in a league pool.");
    const to = getUser(String(req.body?.toUserId || ''));
    if (!to || to.is_admin || !isMember(from.leagueId, to.id)) throw new HttpError(400, 'Pick a player in the same league.');
    if (to.id === card.user_id) throw new HttpError(400, `It's already in ${to.username}'s pool.`);
    const giver = getUser(card.user_id)?.username || 'a former player';
    const reason = reasonOf(req.body);
    const pod = grantsPod(from.leagueId, { create: true });
    let who = pod.absentees.find(a => a.id === to.id);
    if (!who) { who = { id: to.id, name: to.username, grant: true, packs: [] }; pod.absentees.push(who); }
    const trade = { id: newId(), status: 'opened', source: 'wheel', set: setInfoFor(card.set_code), wheelSet: null, cards: [], openedAt: now(),
      kind: 'trade', note: withReason(`From ${giver}`, reason), grantedBy: req.user.id };
    who.packs.push(trade);
    pod.updatedAt = now();
    savePod(pod);
    db.prepare('UPDATE pool_cards SET pod_id = ?, pack_id = ?, user_id = ? WHERE id = ?').run(pod.id, trade.id, to.id, card.id);
    const text = withReason(`The admin moved ${card.name} from ${giver}'s pool to ${to.username}'s.`, reason);
    logEvent(from.leagueId, 'pod', req.user.id, text);
    logAdmin(req, { action: 'move-card', summary: text, reason, leagueId: from.leagueId,
      undo: { type: 'unmove', cardId: card.id, from: { pod_id: card.pod_id, pack_id: card.pack_id, user_id: card.user_id }, tradePackId: trade.id } });
    changed(from.leagueId);
    res.json({ ok: true });
  }));

  // ---------- fix a finished pod ----------
  // Name, winner, precons, or who sat in a seat (that seat's packs and cards
  // move with it). Standings and stats follow; Undo puts the old pod back.
  app.put('/api/admin/pods/:id', wrap(async (req, res) => {
    requireAdmin(req);
    const pod = loadPod(req.params.id);
    if (!pod || pod.kind !== 'pod') throw new HttpError(404, 'Pod not found');
    if (pod.status !== 'done') throw new HttpError(409, 'Only finished pods can be fixed here. A running pod can still be changed on the Pods tab.');
    const b = req.body || {};
    const before = podRows([pod.id]);
    const changes = [];
    if (b.name != null) {
      const name = String(b.name).trim().slice(0, 40);
      if (!name) throw new HttpError(400, 'Give the pod a name.');
      if (name !== pod.name) { changes.push(`renamed to ${name}`); pod.name = name; }
    }
    if (b.winnerId != null && b.winnerId !== pod.winnerId) {
      const w = pod.players.find(p => p.id === b.winnerId);
      if (!w) throw new HttpError(400, 'The winner has to be one of the pod\'s players.');
      pod.winnerId = w.id;
      changes.push(`winner is now ${w.name}`);
    }
    if (b.precons && typeof b.precons === 'object') {
      for (const p of pod.players) {
        if (b.precons[p.id] == null) continue;
        const v = String(b.precons[p.id]).trim().slice(0, 80);
        if (v !== (p.precon || '')) { changes.push(`${p.name}'s precon is now ${v || 'blank'}`); p.precon = v; }
      }
    }
    let swap = null;
    if (b.swap?.from && b.swap?.to) {
      const seat = [...pod.players, ...pod.absentees].find(p => p.id === b.swap.from);
      const to = getUser(String(b.swap.to));
      if (!seat) throw new HttpError(400, 'That person isn\'t in this pod.');
      if (!to || to.is_admin || !isMember(pod.leagueId, to.id) && !db.prepare('SELECT 1 FROM league_members WHERE league_id = ? AND user_id = ?').get(pod.leagueId, to.id)) throw new HttpError(400, 'Pick someone from this league.');
      // Someone who joined the league later holds unopened catch-up packs for
      // this pod; taking a real seat replaces them.
      const late = pod.absentees.find(p => p.id === to.id);
      if (late && late.packs.every(k => k.kind === 'catchup' && k.status !== 'opened')) {
        pod.absentees = pod.absentees.filter(p => p !== late);
        changes.push(`${to.username}'s unopened catch-up ${late.packs.length === 1 ? 'pack' : 'packs'} for it ${late.packs.length === 1 ? 'was' : 'were'} dropped`);
      }
      if ([...pod.players, ...pod.absentees].some(p => p.id === to.id)) throw new HttpError(409, `${to.username} is already in this pod.`);
      swap = { from: seat.id, fromName: seat.name, to: to.id, toName: to.username };
      changes.push(`${seat.name}'s seat (with its packs and cards) is now ${to.username}'s`);
    }
    if (!changes.length) throw new HttpError(400, 'Nothing to change.');
    pod.updatedAt = now();
    savePod(pod);
    if (swap) {
      transaction(() => {
        db.exec('PRAGMA defer_foreign_keys = ON');
        db.prepare('UPDATE pod_players SET user_id = ?, name = ? WHERE pod_id = ? AND user_id = ?').run(swap.to, swap.toName, pod.id, swap.from);
        db.prepare('UPDATE pod_packs SET user_id = ? WHERE pod_id = ? AND user_id = ?').run(swap.to, pod.id, swap.from);
        db.prepare('UPDATE pool_cards SET user_id = ? WHERE pod_id = ? AND user_id = ?').run(swap.to, pod.id, swap.from);
        db.prepare('UPDATE pod_votes SET voter_id = ? WHERE pod_id = ? AND voter_id = ?').run(swap.to, pod.id, swap.from);
        db.prepare('UPDATE pod_votes SET candidate_id = ? WHERE pod_id = ? AND candidate_id = ?').run(swap.to, pod.id, swap.from);
        db.prepare('UPDATE pods SET winner_id = ? WHERE id = ? AND winner_id = ?').run(swap.to, pod.id, swap.from);
        db.prepare('UPDATE pods SET vote_winner_id = ? WHERE id = ? AND vote_winner_id = ?').run(swap.to, pod.id, swap.from);
      });
    }
    const reason = reasonOf(b);
    const text = withReason(`The admin fixed ${pod.name}: ${changes.join('; ')}.`, reason);
    logEvent(pod.leagueId, 'pod', req.user.id, text);
    logAdmin(req, { action: 'fix-pod', summary: text, reason, leagueId: pod.leagueId, undo: { type: 'restore', rows: before, replacePods: [pod.id] } });
    changed(pod.leagueId, { podId: pod.id });
    res.json({ ok: true, pod: loadPod(pod.id) });
  }));

  // ---------- Discord ----------
  app.post('/api/admin/discord/test', wrap(async (req, res) => {
    requireAdmin(req);
    if (!discordEnabled()) throw new HttpError(409, 'Discord is not connected. Put the channel webhook in DISCORD_WEBHOOK_URL first.');
    const ok = await testPost(req.user.username);
    res.json({ ok, last: { ...lastDiscord } });
  }));

  // ---------- announcement ----------
  app.put('/api/admin/announcement', wrap(async (req, res) => {
    requireAdmin(req);
    const text = String(req.body?.text || '').trim().slice(0, 280);
    let until = req.body?.until ? new Date(req.body.until) : null;
    if (until && Number.isNaN(until.getTime())) throw new HttpError(400, 'That end date isn\'t a date.');
    const a = text ? { id: newId(8), text, until: until ? until.toISOString() : null, at: now() } : null;
    kvSet('announcement', a);
    logAdmin(req, { action: 'announce', summary: a ? `Announcement: "${text}"` : 'Cleared the announcement.' });
    if (a && req.body?.discord !== false) announcementPost(text);
    broadcast('state', {});
    res.json({ ok: true, announcement: a });
  }));

  // ---------- player tools ----------
  app.put('/api/admin/users/:id', wrap(async (req, res) => {
    requireAdmin(req);
    const u = getUser(req.params.id);
    if (!u) throw new HttpError(404, 'Player not found');
    const username = String(req.body?.username || '').trim();
    checkUsername(username);
    if (username === u.username) return res.json({ ok: true, user: publicUser(u) });
    if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').get(username, u.id)) throw new HttpError(409, 'That username is taken.');
    transaction(() => renameEverywhere(u.id, username));
    logAdmin(req, { action: 'rename', summary: `Renamed ${u.username} to ${username}.`, reason: reasonOf(req.body), undo: { type: 'rename', userId: u.id, from: u.username } });
    broadcast('state', {});
    res.json({ ok: true, user: publicUser(getUser(u.id)) });
  }));
  app.post('/api/admin/users/:id/suspend', wrap(async (req, res) => {
    requireAdmin(req);
    const u = getUser(req.params.id);
    if (!u) throw new HttpError(404, 'Player not found');
    if (u.is_admin) throw new HttpError(409, "The admin account can't be suspended.");
    const reason = reasonOf(req.body);
    if (req.body?.suspended === false) {
      db.prepare('UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?').run(u.id);
      logAdmin(req, { action: 'unsuspend', summary: `Un-suspended ${u.username}.`, reason });
    } else {
      db.prepare('UPDATE users SET suspended_at = ?, suspended_reason = ? WHERE id = ?').run(now(), reason || null, u.id);
      endAllSessions(u.id);
      logAdmin(req, { action: 'suspend', summary: withReason(`Suspended ${u.username}.`, reason), reason, undo: { type: 'unsuspend', userId: u.id } });
    }
    broadcast('state', {});
    res.json({ ok: true, user: publicUser(getUser(u.id)) });
  }));
  app.post('/api/admin/users/:id/signout', wrap(async (req, res) => {
    requireAdmin(req);
    const u = getUser(req.params.id);
    if (!u) throw new HttpError(404, 'Player not found');
    if (u.id === req.user.id) throw new HttpError(409, 'Use Log out for your own account.');
    const n = endAllSessions(u.id);
    logAdmin(req, { action: 'signout', summary: `Signed ${u.username} out everywhere (${plural(n, 'session')}).` });
    res.json({ ok: true, sessions: n });
  }));
  app.post('/api/admin/view-as/stop', wrap(async (req, res) => {
    if (!(req.realUser || req.user)?.isAdmin) throw new HttpError(403, 'Only the admin can do that.');
    setViewAs(req, null);
    res.json({ ok: true });
  }));
  app.post('/api/admin/view-as/:id', wrap(async (req, res) => {
    requireAdmin(req);
    const u = getUser(req.params.id);
    if (!u || u.is_admin) throw new HttpError(404, 'Player not found');
    setViewAs(req, u.id);
    logAdmin(req, { action: 'view-as', summary: `Viewed the site as ${u.username}.` });
    res.json({ ok: true });
  }));

  // ---------- backups ----------
  app.get('/api/admin/backups', wrap(async (req, res) => { requireAdmin(req); res.json({ backups: listBackups() }); }));
  app.post('/api/admin/backups', wrap(async (req, res) => {
    requireAdmin(req);
    const b = makeBackup('manual');
    logAdmin(req, { action: 'backup', summary: `Made a backup (${b.name}).` });
    res.json({ ok: true, backup: b, backups: listBackups() });
  }));
  app.get('/api/admin/backups/:name', wrap(async (req, res) => {
    requireAdmin(req);
    const file = backupFile(req.params.name);
    if (!file) throw new HttpError(404, 'No such backup.');
    res.set('Cache-Control', 'no-store');
    res.download(file, req.params.name);
  }));
}

// For destructive admin routes elsewhere: log with a snapshot taken before the delete.
export { logAdmin, podRows };
