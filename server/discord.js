// Posts to the league's Discord server through a channel webhook, all in one
// channel.
//
//   DISCORD_WEBHOOK_URL  https://discord.com/api/webhooks/<id>/<token>  (a secret)
//   DISCORD_INVITE       https://discord.gg/<code>  (shown in the site footer)
//
// - Each pod gets one live post, edited in place as it goes (started, winner,
//   vote, spin, packs opened, finished). A discarded or deleted pod's post is
//   removed.
// - Pings: a player who adds their Discord user ID on the Account page gets a
//   short @mention when it's their turn (vote, spin, packs to open, a trade
//   offer). The ping is deleted once they've done it, so the channel keeps
//   only what's still waiting.
// - Season recaps, accepted trades and announcements are separate posts.
//
// Nothing else can ping: allowed_mentions is always empty except for the one
// linked user a ping is for, so a username like "everyone" can't ping the
// server. Sending is fire-and-forget and one call at a time; Discord being
// down never slows or breaks the site, and the last result shows on the admin
// dashboard.
// (A loopback http URL is accepted too, so the tests can catch the posts.)
import { db, loadPod } from './db.js';
import { decryptDiscordId } from './emailcrypt.js';
import { bestFirst } from './stats.js';

const WEBHOOK_RE = /^(?:https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com|http:\/\/127\.0\.0\.1:\d+)\/api\/webhooks\/\d+\/[\w-]+$/;
const INVITE_RE = /^https:\/\/(?:discord\.gg|discord\.com\/invite)\/[\w-]+$/;
export const DISCORD_ID_RE = /^\d{17,20}$/;

const hook = String(process.env.DISCORD_WEBHOOK_URL || '').trim();
const invite = String(process.env.DISCORD_INVITE || '').trim();
export const discordEnabled = () => WEBHOOK_RE.test(hook);
export const discordInvite = () => (INVITE_RE.test(invite) ? invite : null);
export const lastDiscord = { at: null, ok: null, error: null };

const SITE = (process.env.PUBLIC_URL || 'https://precon-commander.paintballz.us').replace(/\/$/, '');
const NAME = 'Pre-Con Commander';
const GOLD = 0xd4a64a, GREEN = 0x5dcaa5;
// Edits wait this long so a burst (say, five packs opened) becomes one edit.
const SETTLE_MS = Number(process.env.DISCORD_SETTLE_MS ?? 2500);
// Discord markdown would let a name like "**x**" restyle the post.
const md = s => String(s ?? '').replace(/([\\*_~`|>#\[\]()-])/g, '\\$1').replace(/@/g, '@\u200b');
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const NO_PINGS = { parse: [] };

db.exec(`CREATE TABLE IF NOT EXISTS discord_pings (
  scope TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  msg_id TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (scope, user_id)
)`);
// The "top 3 pulls" post each player gets once a pod's packs are all opened.
// When the table is first made, pods already fully opened count as sent, so
// old pods aren't posted all at once.
const pullsNew = !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'discord_pulls'").get();
db.exec(`CREATE TABLE IF NOT EXISTS discord_pulls (
  pod_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  msg_id TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (pod_id, user_id)
)`);
if (pullsNew) db.prepare(`INSERT OR IGNORE INTO discord_pulls (pod_id, user_id, msg_id, at)
  SELECT pp.pod_id, pp.user_id, NULL, ? FROM pod_players pp JOIN pods p ON p.id = pp.pod_id
  WHERE p.spin_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pod_packs k WHERE k.pod_id = p.id AND k.status != 'opened' AND k.user_id IN (SELECT user_id FROM pod_players WHERE pod_id = p.id))`).run(new Date().toISOString());

// ---------- talking to the webhook ----------
// Everything goes out one call at a time so a burst can't trip Discord's per-webhook limit.
let chain = Promise.resolve();
const enqueue = job => (chain = chain.then(job).catch(() => {}));
async function request(method, suffix, body, retry = true) {
  try {
    const res = await fetch(hook + suffix, {
      method, signal: AbortSignal.timeout(10e3),
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    if (res.status === 429 && retry) {
      const wait = Math.min(10, Number((await res.json().catch(() => ({}))).retry_after) || 2);
      await new Promise(r => setTimeout(r, wait * 1000));
      return request(method, suffix, body, false);
    }
    // A message someone deleted by hand is fine to lose.
    if (res.status === 404 && method !== 'POST') return { ok: false, status: 404 };
    if (!res.ok) throw new Error(`Discord answered ${res.status}`);
    Object.assign(lastDiscord, { at: new Date().toISOString(), ok: true, error: null });
    return { ok: true, status: res.status, data: res.status === 204 ? null : await res.json().catch(() => null) };
  } catch (e) {
    Object.assign(lastDiscord, { at: new Date().toISOString(), ok: false, error: String(e.message || e).slice(0, 200) });
    return { ok: false, status: 0 };
  }
}
const newMessage = body => request('POST', '?wait=true', { username: NAME, allowed_mentions: NO_PINGS, ...body });

export function postDiscord(embed) {
  if (!discordEnabled()) return Promise.resolve(false);
  return enqueue(async () => (await newMessage({ embeds: [{ color: GOLD, ...embed }] })).ok);
}

// ---------- the live pod post ----------
const when = iso => `<t:${Math.floor(Date.parse(iso) / 1000)}:R>`;
const RANK = { mythic: 3, rare: 2, uncommon: 1, common: 0 };
function podEmbed(pod) {
  const league = db.prepare('SELECT name FROM leagues WHERE id = ?').get(pod.leagueId)?.name || 'League';
  const nameOf = id => md(pod.players.find(p => p.id === id)?.name || '?');
  const winner = pod.players.find(p => p.id === pod.winnerId);
  const seats = pod.players.map(p => `${p.id === pod.winnerId ? '🏆' : '•'} **${md(p.name)}**${p.precon ? ` — ${md(p.precon)}` : ''}`);
  const fields = [];
  const v = pod.vote;
  if (v?.status === 'open') {
    const voted = new Set(v.ballots.filter(b => b.round === v.round).map(b => b.voterId));
    const left = pod.players.filter(p => !voted.has(p.id)).map(p => nameOf(p.id));
    fields.push({ name: 'Bonus-pack vote', value: `${v.round > 1 ? `Re-vote (round ${v.round})` : 'Voting'} · waiting on ${left.join(', ')}`, inline: false });
  } else if (v?.status === 'done') fields.push({ name: 'Bonus-pack vote', value: nameOf(v.winnerId), inline: true });
  if (pod.spin) fields.push({ name: 'Wheel landed on', value: md(pod.spin.set.name), inline: true });
  else if (pod.status === 'awarded' && v?.status !== 'open') fields.push({ name: 'Wheel', value: `Waiting on ${nameOf(pod.winnerId)} to spin`, inline: false });
  if (pod.spin) {
    const people = [...pod.players, ...(pod.absentees || []).filter(a => !a.grant)].filter(p => p.packs.length);
    const lines = people.map(p => {
      const opened = p.packs.filter(k => k.status === 'opened').length;
      return `${opened === p.packs.length ? '✅' : '📦'} ${md(p.name)} — ${opened}/${p.packs.length} opened${pod.players.includes(p) ? '' : ' (missed the pod)'}`;
    });
    if (lines.length) fields.push({ name: 'Packs', value: cut(lines.join('\n'), 1020), inline: false });
    const hits = people.flatMap(p => p.packs.flatMap(k => (k.cards || []).map(c => ({ ...c, who: p.name }))))
      .filter(c => c.rarity === 'mythic' || (c.foil && c.rarity === 'rare'))
      .sort((a, b) => RANK[b.rarity] - RANK[a.rarity] || Number(b.foil) - Number(a.foil)).slice(0, 8);
    if (hits.length) fields.push({ name: 'Best pulls', value: cut(hits.map(c => `${c.foil ? '✨' : '•'} ${md(c.name)} — ${md(c.who)}`).join('\n'), 1020), inline: false });
  }
  const done = pod.status === 'done';
  return {
    color: done ? GREEN : GOLD,
    title: cut(pod.status === 'playing' ? `${pod.name} is being played` : `${winner ? winner.name : 'Someone'} won ${pod.name}`, 250),
    url: `${SITE}/#${done ? 'history' : 'pods'}`,
    description: cut([...seats, '', pod.status === 'playing' ? `🎲 Started ${when(pod.createdAt)}` : done ? `Finished ${when(pod.finishedAt || pod.updatedAt)}` : ''].join('\n').trim(), 3500),
    fields, footer: { text: league }, timestamp: pod.updatedAt || new Date().toISOString(),
  };
}
const msgOf = podId => db.prepare('SELECT discord_msg FROM pods WHERE id = ?').get(podId)?.discord_msg || null;
const setMsg = (podId, msg) => db.prepare('UPDATE pods SET discord_msg = ? WHERE id = ?').run(msg, podId);

async function syncPod(podId, create) {
  const pod = loadPod(podId);
  if (!pod) return;
  if (pod.kind === 'pod') {
    let msg = msgOf(podId);
    if (pod.status === 'discarded') {
      if (msg) { await request('DELETE', `/messages/${msg}`); setMsg(podId, null); }
      await dropPulls(podId);
    } else {
      const embed = podEmbed(pod);
      if (msg && !(await request('PATCH', `/messages/${msg}`, { embeds: [embed], allowed_mentions: NO_PINGS })).ok) msg = null;
      // A new post only for a running pod (or one just finished): fixing an old
      // finished pod doesn't repost it.
      if (!msg && (create || pod.status === 'playing' || pod.status === 'awarded')) {
        const r = await newMessage({ embeds: [embed] });
        setMsg(podId, r.data?.id || null);
      }
      await postPulls(pod);
    }
  }
  await syncPings(`pod:${podId}`, waitingOn(pod));
}

// ---------- top 3 pulls per player ----------
// Once every player who sat at the table has opened all their packs from the
// pod, each of them gets their own post with their 3 best pulls (rarity, then
// foil, the same order as the site; never prices). It @mentions them if they
// linked their Discord ID. Sent once per player per pod, and kept.
const pullsFrom = p => p.packs.filter(k => k.kind !== 'precon' && k.kind !== 'trade').flatMap(k => (k.cards || []).map(c => ({ ...c, packSet: k.set?.name || '' })));
const RARITY_LABEL = { mythic: 'Mythic', rare: 'Rare', special: 'Special', uncommon: 'Uncommon', common: 'Common' };
async function postPulls(pod) {
  if (pod.kind !== 'pod' || !pod.spin) return;
  const packed = pod.players.filter(p => p.packs.some(k => k.kind !== 'precon' && k.kind !== 'trade'));
  if (!packed.length || !pod.players.every(p => p.packs.every(k => k.status === 'opened'))) return;
  const sent = new Set(db.prepare('SELECT user_id FROM discord_pulls WHERE pod_id = ?').all(pod.id).map(r => r.user_id));
  const league = db.prepare('SELECT name FROM leagues WHERE id = ?').get(pod.leagueId)?.name || 'League';
  for (const p of packed) {
    if (sent.has(p.id)) continue;
    const top = pullsFrom(p).sort(bestFirst).slice(0, 3);
    if (!top.length) continue;
    const u = db.prepare('SELECT discord_id, is_test FROM users WHERE id = ?').get(p.id);
    // Decrypted only here, for the one message that mentions them.
    const discordId = u && !u.is_test ? decryptDiscordId(u.discord_id) : '';
    const ping = DISCORD_ID_RE.test(discordId);
    const medals = ['🥇', '🥈', '🥉'];
    const lines = top.map((c, i) => {
      const name = c.uri ? `[${md(c.name)}](${c.uri})` : `**${md(c.name)}**`;
      return `${medals[i]} ${name}${c.foil ? ' ✨ foil' : ''} — ${RARITY_LABEL[c.rarity] || md(c.rarity || '')}${c.packSet ? ` · ${md(c.packSet)}` : ''}`;
    });
    const r = await request('POST', '?wait=true', {
      username: NAME,
      ...(ping ? { content: `<@${discordId}> your best pulls from **${md(pod.name)}**` } : {}),
      allowed_mentions: ping ? { parse: [], users: [discordId] } : NO_PINGS,
      embeds: [{
        color: GOLD,
        title: cut(`${p.name}'s top ${top.length === 1 ? 'pull' : `${top.length} pulls`} from ${pod.name}`, 250),
        url: `${SITE}/#history`,
        description: cut(lines.join('\n'), 3500),
        ...(top[0].image ? { image: { url: top[0].image } } : {}),
        footer: { text: league }, timestamp: new Date().toISOString(),
      }],
    });
    if (r.ok) db.prepare('INSERT OR REPLACE INTO discord_pulls (pod_id, user_id, msg_id, at) VALUES (?, ?, ?, ?)').run(pod.id, p.id, r.data?.id || null, new Date().toISOString());
  }
}
async function dropPulls(podId) {
  for (const r of db.prepare('SELECT msg_id FROM discord_pulls WHERE pod_id = ?').all(podId)) if (r.msg_id) await request('DELETE', `/messages/${r.msg_id}`);
  db.prepare('DELETE FROM discord_pulls WHERE pod_id = ?').run(podId);
}
const settling = new Map();
// Something in a pod changed: update its post and pings once things settle.
export function podChanged(podId, { create = false } = {}) {
  if (!discordEnabled() || !podId) return;
  const t = settling.get(podId);
  if (t) clearTimeout(t.timer);
  const job = { create: create || !!t?.create };
  job.timer = setTimeout(() => { settling.delete(podId); enqueue(() => syncPod(podId, job.create)); }, SETTLE_MS);
  job.timer.unref?.();
  settling.set(podId, job);
}
// The admin deleted a pod: its post and pings go too.
export function podDeleted(podId, msg) {
  if (!discordEnabled()) return;
  const t = settling.get(podId);
  if (t) { clearTimeout(t.timer); settling.delete(podId); }
  enqueue(async () => {
    if (msg) await request('DELETE', `/messages/${msg}`);
    await dropPulls(podId);
    await syncPings(`pod:${podId}`, new Map());
  });
}

// ---------- pings ----------
// Who a pod is waiting on: userId -> { kind, text }. A ping is sent once per
// kind, and deleted when that person is no longer waited on for it.
function waitingOn(pod) {
  const w = new Map();
  if (!pod || pod.status === 'discarded') return w;
  const name = `**${md(pod.name)}**`;
  if (pod.kind === 'pod' && pod.status === 'awarded' && !pod.spin) {
    const v = pod.vote;
    if (v?.status === 'open') {
      const voted = new Set(v.ballots.filter(b => b.round === v.round).map(b => b.voterId));
      for (const p of pod.players) if (!voted.has(p.id)) w.set(p.id, { kind: `vote${v.round}`, text: v.round > 1 ? `the bonus-pack vote in ${name} is tied: vote again` : `vote for who gets the bonus pack in ${name}` });
    } else if (pod.winnerId) w.set(pod.winnerId, { kind: 'spin', text: `you won ${name}! Spin the wheel once everyone's watching` });
  }
  for (const p of [...pod.players, ...(pod.absentees || [])]) {
    if (w.has(p.id) || !p.packs.some(k => k.status !== 'opened')) continue;
    w.set(p.id, { kind: 'packs', text: pod.kind === 'grants' ? 'you have packs waiting from the admin' : pod.players.includes(p) ? `you have packs to open from ${name}` : `you missed ${name}, and have packs waiting` });
  }
  return w;
}
async function syncPings(scope, wanted) {
  const have = db.prepare('SELECT * FROM discord_pings WHERE scope = ?').all(scope);
  for (const r of have) {
    if (wanted.get(r.user_id)?.kind === r.kind) continue;
    if (r.msg_id) await request('DELETE', `/messages/${r.msg_id}`);
    db.prepare('DELETE FROM discord_pings WHERE scope = ? AND user_id = ?').run(scope, r.user_id);
  }
  const kept = new Set(db.prepare('SELECT user_id FROM discord_pings WHERE scope = ?').all(scope).map(r => r.user_id));
  for (const [userId, want] of wanted) {
    if (kept.has(userId)) continue;
    const u = db.prepare('SELECT discord_id, is_test FROM users WHERE id = ?').get(userId);
    // Decrypted only here, for the one message that pings them.
    const discordId = u && !u.is_test ? decryptDiscordId(u.discord_id) : '';
    if (!DISCORD_ID_RE.test(discordId)) continue;
    const page = want.page || (scope.startsWith('trade:') ? 'trades' : want.kind === 'packs' ? 'packs' : 'pods');
    const r = await request('POST', '?wait=true', {
      username: NAME, content: `<@${discordId}> ${want.text} → <${SITE}/#${page}>`, allowed_mentions: { parse: [], users: [discordId] },
    });
    db.prepare('INSERT OR REPLACE INTO discord_pings (scope, user_id, kind, msg_id, at) VALUES (?, ?, ?, ?, ?)')
      .run(scope, userId, want.kind, r.data?.id || null, new Date().toISOString());
  }
}
function tradeWanted(tradeId) {
  const t = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  const w = new Map();
  if (t?.status === 'open' && t.turn_id) {
    const from = db.prepare('SELECT username FROM users WHERE id = ?').get(t.turn_id === t.a_id ? t.b_id : t.a_id)?.username || 'Someone';
    w.set(t.turn_id, { kind: `offer:${t.updated_at}`, text: `**${md(from)}** sent you a trade offer` });
  }
  return w;
}
// A trade changed: ping whoever has to answer it, and clear the old ping.
// A wishlist ping for a card in it goes once the card is in an offer.
export function tradeChanged(tradeId) {
  if (!discordEnabled() || !tradeId) return;
  enqueue(async () => {
    await syncPings(`trade:${tradeId}`, tradeWanted(tradeId));
    const ids = new Set(db.prepare('SELECT cards FROM trade_offers WHERE trade_id = ?').all(tradeId).flatMap(o => JSON.parse(o.cards).map(c => c.id)));
    for (const { scope } of db.prepare("SELECT DISTINCT scope FROM discord_pings WHERE scope LIKE 'wish:%'").all()) {
      if (ids.has(Number(scope.slice(5)))) await syncPings(scope, wishWanted(Number(scope.slice(5))));
    }
  });
}

// ---------- wishlist pings ----------
// Someone pulled a card on your wishlist: one ping per card, with a link that
// opens a trade offer asking for it. It goes once you've made an offer that
// includes it, the card was traded on, or you took it off your wishlist.
const wishKey = s => String(s || '').split(' // ')[0].trim().toLowerCase();
function wishWanted(cardId) {
  const w = new Map();
  const c = db.prepare(`SELECT c.id, c.name, c.user_id, p.league_id, p.status, k.kind, l.status AS league_status FROM pool_cards c
    JOIN pods p ON p.id = c.pod_id JOIN pod_packs k ON k.id = c.pack_id JOIN leagues l ON l.id = p.league_id WHERE c.id = ?`).get(cardId);
  if (!c || c.league_status !== 'active' || !['playing', 'awarded', 'done'].includes(c.status) || c.kind === 'precon' || c.kind === 'trade') return w;
  const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(c.user_id)?.username || 'Someone';
  const wishers = db.prepare(`SELECT w.user_id FROM wishlist w JOIN league_members m ON m.league_id = w.league_id AND m.user_id = w.user_id AND m.left_at IS NULL
    WHERE w.league_id = ? AND w.name_key = ? AND w.user_id != ?`).all(c.league_id, wishKey(c.name), c.user_id);
  for (const { user_id: me } of wishers) {
    // Already in an open trade between them: nothing to nudge.
    const asked = db.prepare(`SELECT t.id FROM trades t WHERE t.status = 'open' AND ((t.a_id = ? AND t.b_id = ?) OR (t.a_id = ? AND t.b_id = ?))`).all(me, c.user_id, c.user_id, me)
      .some(t => JSON.parse(db.prepare('SELECT cards FROM trade_offers WHERE trade_id = ? ORDER BY round DESC LIMIT 1').get(t.id)?.cards || '[]').some(x => x.id === c.id));
    if (asked) continue;
    w.set(me, { kind: 'wish', text: `**${md(owner)}** pulled **${md(c.name)}**, which is on your wishlist. Make an offer`, page: `trades?new=1&with=${c.user_id}&card=${c.id}` });
  }
  return w;
}
// Cards were just pulled (or a wishlist changed): ping the players who want them.
export function wishCardsChanged(cardIds) {
  if (!discordEnabled() || !cardIds?.length) return;
  enqueue(async () => { for (const id of cardIds.slice(0, 30)) await syncPings(`wish:${id}`, wishWanted(id)); });
}
// A player took cards off their wishlist: their pings for those go.
export function wishlistChanged(userId) {
  if (!discordEnabled()) return;
  enqueue(async () => {
    for (const { scope } of db.prepare("SELECT scope FROM discord_pings WHERE user_id = ? AND scope LIKE 'wish:%'").all(userId)) await syncPings(scope, wishWanted(Number(scope.slice(5))));
  });
}
// A player linked, changed or removed their Discord ID: catch them up.
export function pingsChanged(userId) {
  if (!discordEnabled()) return;
  enqueue(async () => {
    for (const r of db.prepare('SELECT scope FROM discord_pings WHERE user_id = ?').all(userId)) {
      const row = db.prepare('SELECT msg_id FROM discord_pings WHERE scope = ? AND user_id = ?').get(r.scope, userId);
      if (row?.msg_id) await request('DELETE', `/messages/${row.msg_id}`);
      db.prepare('DELETE FROM discord_pings WHERE scope = ? AND user_id = ?').run(r.scope, userId);
    }
    const open = db.prepare(`SELECT DISTINCT k.pod_id FROM pod_packs k JOIN pods p ON p.id = k.pod_id
      WHERE k.user_id = ? AND k.status != 'opened' AND p.status != 'discarded'`).all(userId).map(r => r.pod_id);
    const running = db.prepare(`SELECT p.id FROM pods p JOIN pod_players pp ON pp.pod_id = p.id
      WHERE pp.user_id = ? AND p.status = 'awarded' AND p.spin_id IS NULL`).all(userId).map(r => r.id);
    for (const podId of new Set([...open, ...running])) await syncPings(`pod:${podId}`, waitingOn(loadPod(podId)));
    for (const t of db.prepare("SELECT id FROM trades WHERE status = 'open' AND turn_id = ?").all(userId)) await syncPings(`trade:${t.id}`, tradeWanted(t.id));
  });
}
// Every few minutes (and at start), recheck every ping still up, so one whose
// reason went away some other way (a league ended, an admin fixed a pod) goes.
export function keepPingsTidy() {
  if (!discordEnabled()) return;
  const tidy = () => enqueue(async () => {
    for (const { scope } of db.prepare('SELECT DISTINCT scope FROM discord_pings').all()) {
      const [kind, id] = [scope.slice(0, scope.indexOf(':')), scope.slice(scope.indexOf(':') + 1)];
      await syncPings(scope, kind === 'trade' ? tradeWanted(id) : kind === 'wish' ? wishWanted(Number(id)) : waitingOn(loadPod(id)));
    }
  });
  tidy();
  setInterval(tidy, 10 * 60e3).unref();
}
// "Send me a test ping": deleted again after a minute.
export async function testPing(discordId) {
  if (!discordEnabled()) return false;
  let ok = false;
  await enqueue(async () => {
    const r = await request('POST', '?wait=true', { username: NAME, content: `<@${discordId}> this is a test ping from Pre-Con Commander. You'll get one like it when it's your turn. (This one deletes itself in a minute.)`, allowed_mentions: { parse: [], users: [discordId] } });
    ok = r.ok;
    if (r.data?.id) setTimeout(() => enqueue(() => request('DELETE', `/messages/${r.data.id}`)), 60e3).unref();
  });
  return ok;
}

// ---------- other posts ----------
export function leagueEndedPost(league, recap) {
  const medals = ['🥇', '🥈', '🥉'];
  const top = recap.standings.filter(r => r.pods).slice(0, 3).map((r, i) => `${medals[i]} **${md(r.name)}** — ${r.wins} win${r.wins === 1 ? '' : 's'} in ${r.pods} pod${r.pods === 1 ? '' : 's'}`);
  const awards = recap.awards.slice(0, 10).map(a => `**${md(a.title)}**: ${a.winners.map(w => md(w.name)).join(', ')} (${md(a.value)})`);
  const t = recap.totals;
  return postDiscord({
    title: cut(`${league.name} is over!`, 250),
    url: `${SITE}/#recap`,
    description: cut([
      recap.champion ? `👑 Champion: **${md(recap.champion.name)}**` : 'No pods were finished this season.',
      `${t.pods} pods · ${t.packs} packs · ${t.mythics} mythics · ${t.foils} foils`,
      top.length ? `\n${top.join('\n')}` : '',
    ].join('\n'), 3500),
    fields: awards.length ? [{ name: 'Awards', value: cut(awards.join('\n'), 1020) }] : [],
    timestamp: new Date().toISOString(),
  });
}

export function announcementPost(text) {
  return postDiscord({ title: '📣 Announcement', url: SITE, description: cut(md(text), 3500), timestamp: new Date().toISOString() });
}

export function tradePost(text, leagueName) {
  return postDiscord({ title: '🤝 Trade', url: `${SITE}/#trades`, description: cut(md(text), 3500), footer: { text: leagueName }, timestamp: new Date().toISOString() });
}

export function testPost(by) {
  return postDiscord({ title: 'Pre-Con Commander is connected', url: SITE, description: `Test post from ${md(by)}. Each pod gets one live post here that updates as it goes, plus season recaps, trades and announcements. Players who link their Discord ID get a ping when it's their turn.` });
}
