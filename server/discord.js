// Posts to the league's Discord server through a channel webhook.
//
//   DISCORD_WEBHOOK_URL  https://discord.com/api/webhooks/<id>/<token>  (a secret)
//   DISCORD_INVITE       https://discord.gg/<code>  (shown in the site footer)
//
// Posts never @mention anyone (allowed_mentions is empty), so a username like
// "everyone" can't ping the server. Sending is fire-and-forget: Discord being
// down never slows or breaks the site; the last result shows on the admin
// dashboard.
// (A loopback http URL is accepted too, so the tests can catch the posts.)
const WEBHOOK_RE = /^(?:https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com|http:\/\/127\.0\.0\.1:\d+)\/api\/webhooks\/\d+\/[\w-]+$/;
const INVITE_RE = /^https:\/\/(?:discord\.gg|discord\.com\/invite)\/[\w-]+$/;

const hook = String(process.env.DISCORD_WEBHOOK_URL || '').trim();
const invite = String(process.env.DISCORD_INVITE || '').trim();
export const discordEnabled = () => WEBHOOK_RE.test(hook);
export const discordInvite = () => (INVITE_RE.test(invite) ? invite : null);
export const lastDiscord = { at: null, ok: null, error: null };

const SITE = (process.env.PUBLIC_URL || 'https://precon-commander.paintballz.us').replace(/\/$/, '');
const GOLD = 0xd4a64a;
// Discord markdown would let a name like "**x**" restyle the post.
const md = s => String(s ?? '').replace(/([\\*_~`|>#\[\]()-])/g, '\\$1').replace(/@/g, '@\u200b');
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Posts go out one at a time so a burst can't trip Discord's per-webhook limit.
let chain = Promise.resolve();
export function postDiscord(embed) {
  if (!discordEnabled()) return Promise.resolve(false);
  const body = JSON.stringify({ username: 'Pre-Con Commander', allowed_mentions: { parse: [] }, embeds: [{ color: GOLD, ...embed }] });
  chain = chain.then(() => send(body)).catch(() => {});
  return chain;
}
async function send(body, retry = true) {
  try {
    const res = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10e3) });
    if (res.status === 429 && retry) {
      const wait = Math.min(10, Number((await res.json().catch(() => ({}))).retry_after) || 2);
      await new Promise(r => setTimeout(r, wait * 1000));
      return send(body, false);
    }
    if (!res.ok) throw new Error(`Discord answered ${res.status}`);
    Object.assign(lastDiscord, { at: new Date().toISOString(), ok: true, error: null });
    return true;
  } catch (e) {
    Object.assign(lastDiscord, { at: new Date().toISOString(), ok: false, error: String(e.message || e).slice(0, 200) });
    return false;
  }
}

// ---------- the posts ----------
export function podFinishedPost(pod, leagueName) {
  const winner = pod.players.find(p => p.id === pod.winnerId);
  const seats = pod.players.map(p => `${p.id === pod.winnerId ? '🏆' : '•'} **${md(p.name)}**${p.precon ? ` — ${md(p.precon)}` : ''}`);
  const fields = [];
  if (pod.spin?.set?.name) fields.push({ name: 'Wheel landed on', value: md(pod.spin.set.name), inline: true });
  const voted = pod.vote?.status === 'done' && pod.players.find(p => p.id === pod.vote.winnerId);
  if (voted) fields.push({ name: 'Bonus-pack vote', value: md(voted.name), inline: true });
  return postDiscord({
    title: cut(`${winner ? winner.name : 'Someone'} won ${pod.name}`, 250),
    url: `${SITE}/#history`,
    description: cut(seats.join('\n'), 3500),
    fields, footer: { text: leagueName }, timestamp: pod.finishedAt || new Date().toISOString(),
  });
}

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
  return postDiscord({ title: 'Pre-Con Commander is connected', url: SITE, description: `Test post from ${md(by)}. Finished pods, season recaps and announcements will show up in this channel.` });
}
