// Player stats pages and season recaps. Everything is worked out from finished
// pods (the same pods the standings count). No prices or card values anywhere:
// best pulls rank by rarity, foils first.
import { finishedPods, grantsPods, leagueSpins } from './db.js';

const pl = (v, word) => `${v} ${word}${v === 1 ? '' : 's'}`;
const RARITY = { mythic: 4, rare: 3, special: 3, uncommon: 2, common: 1 };
const valuable = c => c.rarity === 'mythic' || c.rarity === 'rare' || c.rarity === 'special' || c.foil;
const byDate = (a, b) => String(a.finishedAt || a.createdAt).localeCompare(String(b.finishedAt || b.createdAt));

// Every opened card a person got from a pod (as a player or for missing it).
function pullsOf(pod, userId) {
  const who = [...pod.players, ...pod.absentees].find(p => p.id === userId);
  const out = [];
  for (const k of who?.packs || []) if (k.status === 'opened' && k.kind !== 'precon') for (const c of k.cards || []) out.push({ ...c, podId: pod.id, podName: pod.name, packSet: k.set?.name || '' });
  return out;
}

// Best pulls: mythics before rares, foils first; newest first among equals.
const bestFirst = (a, b) => (RARITY[b.rarity] || 0) - (RARITY[a.rarity] || 0) || Number(b.foil) - Number(a.foil) || (b.id || 0) - (a.id || 0);
const pullView = c => ({ id: c.id, name: c.name, set: c.set, number: c.number, rarity: c.rarity, foil: c.foil, image: c.image, back: c.back, uri: c.uri, podName: c.podName });

function streaks(results) {
  let best = 0, run = 0;
  for (const won of results) { run = won ? run + 1 : 0; best = Math.max(best, run); }
  let current = 0;
  for (let i = results.length - 1; i >= 0 && results[i]; i--) current++;
  return { best, current };
}

// ---------- one player ----------
// leagueId narrows to one league; null = every league they've played in.
export async function playerStats(userId, leagueId) {
  const pods = finishedPods(leagueId || undefined).sort(byDate);
  const played = pods.filter(p => p.players.some(x => x.id === userId));
  const missed = pods.filter(p => p.absentees.some(x => x.id === userId));
  const t = { pods: played.length, wins: 0, voteWins: 0, missed: missed.length, packs: 0, cards: 0, rares: 0, mythics: 0, foils: 0, sacrificed: 0 };
  const precons = new Map(), opponents = new Map(), sets = new Map(), results = [];
  const recent = [];
  for (const pod of played) {
    const me = pod.players.find(x => x.id === userId);
    const won = pod.winnerId === userId;
    results.push(won);
    if (won) t.wins++;
    if (pod.vote?.winnerId === userId) t.voteWins++;
    t.sacrificed += me.sacrificed || 0;
    const precon = me.precon?.trim() || '';
    if (precon) { const r = precons.get(precon) || precons.set(precon, { name: precon, pods: 0, wins: 0 }).get(precon); r.pods++; if (won) r.wins++; }
    const winner = pod.players.find(x => x.id === pod.winnerId);
    for (const o of pod.players) {
      if (o.id === userId) continue;
      const r = opponents.get(o.id) || opponents.set(o.id, { id: o.id, name: o.name, pods: 0, myWins: 0, theirWins: 0 }).get(o.id);
      r.name = o.name; r.pods++;
      if (won) r.myWins++;
      if (pod.winnerId === o.id) r.theirWins++;
    }
    recent.push({ id: pod.id, name: pod.name, at: pod.finishedAt || pod.createdAt, won, precon, winner: winner?.name || null, winnerPrecon: winner?.precon || '',
      spun: pod.spin?.set?.name || null, others: pod.players.filter(x => x.id !== userId).map(x => x.name), vote: pod.vote?.winnerId === userId });
  }
  // Packs the admin handed out (and cards moved in from other pools).
  const given = grantsPods(leagueId || undefined).filter(p => p.absentees.some(x => x.id === userId));
  const pulls = [...played, ...missed, ...given].flatMap(pod => pullsOf(pod, userId));
  for (const pod of [...played, ...missed, ...given]) {
    const who = [...pod.players, ...pod.absentees].find(p => p.id === userId);
    for (const k of who.packs) if (k.status === 'opened' && k.kind !== 'trade' && k.kind !== 'precon') {
      t.packs++;
      const name = k.set?.name || k.set?.code || '?';
      const r = sets.get(name) || sets.set(name, { name, icon: k.set?.icon || '', packs: 0 }).get(name);
      r.packs++;
    }
  }
  for (const c of pulls) {
    t.cards++;
    if (c.rarity === 'rare') t.rares++;
    if (c.rarity === 'mythic') t.mythics++;
    if (c.foil) t.foils++;
  }
  const opp = [...opponents.values()];
  // Nemesis: who has won the most pods you were in (ties: better rate against you).
  const nemesis = opp.filter(o => o.theirWins > 0).sort((a, b) => b.theirWins - a.theirWins || b.theirWins / b.pods - a.theirWins / a.pods)[0] || null;
  // Favourite opponent to beat: who was at the table most when you won.
  const prey = opp.filter(o => o.myWins > 0).sort((a, b) => b.myWins - a.myWins || b.myWins / b.pods - a.myWins / a.pods)[0] || null;
  return {
    totals: { ...t, winRate: t.pods ? t.wins / t.pods : null, streak: streaks(results) },
    form: results.slice(-10),
    precons: [...precons.values()].sort((a, b) => b.pods - a.pods || b.wins - a.wins),
    opponents: opp.sort((a, b) => b.pods - a.pods || a.name.localeCompare(b.name)),
    nemesis, prey,
    sets: [...sets.values()].sort((a, b) => b.packs - a.packs).slice(0, 8),
    bestPulls: pulls.filter(valuable).sort(bestFirst).slice(0, 12).map(pullView),
    recent: recent.reverse().slice(0, 12),
  };
}

// ---------- a league's season ----------
// standings: the league's standings rows (same order as the League tab).
export async function seasonRecap(leagueId, standings) {
  const pods = finishedPods(leagueId).sort(byDate);
  const people = new Map(standings.map(s => [s.id, { id: s.id, name: s.name, foils: 0, results: [], kingslayer: 0 }]));
  const person = (id, name) => people.get(id) || people.set(id, { id, name, foils: 0, results: [], kingslayer: 0 }).get(id);
  const precons = new Map();
  const champion = standings[0]?.wins ? standings[0] : null;
  const allPulls = [];
  for (const pod of pods) {
    for (const p of pod.players) {
      const r = person(p.id, p.name);
      r.results.push(pod.winnerId === p.id);
      if (p.precon) precons.set(p.precon.toLowerCase(), p.precon);
    }
    // Wins in pods the champion played (and lost).
    const winner = pod.players.find(x => x.id === pod.winnerId);
    if (champion && winner && winner.id !== champion.id && pod.players.some(x => x.id === champion.id)) person(winner.id, winner.name).kingslayer++;
    for (const p of [...pod.players, ...pod.absentees]) for (const c of pullsOf(pod, p.id)) allPulls.push({ ...c, owner: p.name, ownerId: p.id });
  }
  for (const pod of grantsPods(leagueId)) for (const p of pod.absentees) for (const c of pullsOf(pod, p.id)) allPulls.push({ ...c, owner: p.name, ownerId: p.id });
  for (const c of allPulls) if (c.foil) person(c.ownerId, c.owner).foils++;

  const rows = standings.map(s => ({ ...s, ...people.get(s.id), name: s.name, streak: streaks(people.get(s.id)?.results || []).best }));
  const avgPods = rows.length ? rows.reduce((n, r) => n + r.pods, 0) / rows.filter(r => r.pods).length || 0 : 0;
  const minPods = Math.max(2, Math.ceil(avgPods / 2));
  // An award goes to whoever has the most of something (ties share it); nobody
  // gets an award for zero.
  const award = (key, title, blurb, value, fmt = v => String(v), eligible = () => true) => {
    const pool = rows.filter(r => eligible(r) && value(r) > 0);
    if (!pool.length) return null;
    const best = Math.max(...pool.map(value));
    const winners = pool.filter(r => value(r) === best);
    return { key, title, blurb, value: fmt(best), winners: winners.map(w => ({ id: w.id, name: w.name })) };
  };
  const pct = v => `${Math.round(v * 100)}%`;
  const awards = [
    award('wins', 'Most Wins', 'Won the most pods', r => r.wins, v => pl(v, 'win')),
    award('rate', 'Sharpest Shooter', `Best win rate (at least ${minPods} pods)`, r => (r.pods ? r.wins / r.pods : 0), pct, r => r.pods >= minPods),
    award('streak', 'Hot Streak', 'Longest run of wins in a row', r => r.streak, v => `${v} in a row`, r => r.streak >= 2),
    award('kingslayer', 'Kingslayer', champion ? `Beat ${champion.name} the most` : '', r => r.kingslayer, v => pl(v, 'pod')),
    award('iron', 'Iron Commander', 'Played the most pods', r => r.pods, v => pl(v, 'pod')),
    award('vote', 'Crowd Favourite', 'Won the most bonus-pack votes', r => r.voteWins, v => pl(v, 'vote')),
    award('packs', 'Pack Rat', 'Opened the most packs', r => r.packs, v => pl(v, 'pack')),
    award('mythics', 'Mythic Magnet', 'Pulled the most mythics', r => r.mythics, v => pl(v, 'mythic')),
    award('foils', 'Foil Hunter', 'Pulled the most foils', r => r.foils, v => pl(v, 'foil')),
    award('sacrifice', 'Sacrificial Lamb', 'Sacrificed the most packs for a set of their choice', r => r.sacrificed, v => pl(v, 'pack')),
  ].filter(a => a && !(a.key === 'kingslayer' && !champion));
  const top = allPulls.filter(valuable).sort(bestFirst).slice(0, 8).map(c => ({ ...pullView(c), owner: c.owner }));
  // Wins race: each winner's running total, starting from 0 before the first pod.
  const raceIds = [...new Set(pods.map(p => p.winnerId).filter(Boolean))];
  const racers = raceIds.map(id => {
    let n = 0;
    return { id, name: people.get(id)?.name || '?', wins: [0, ...pods.map(p => (p.winnerId === id ? ++n : n))] };
  }).sort((a, b) => b.wins.at(-1) - a.wins.at(-1) || a.name.localeCompare(b.name));

  const totals = {
    pods: pods.length, packs: rows.reduce((n, r) => n + r.packs, 0), cards: allPulls.length,
    mythics: allPulls.filter(c => c.rarity === 'mythic').length, foils: allPulls.filter(c => c.foil).length,
    precons: precons.size,
    first: pods[0]?.finishedAt || pods[0]?.createdAt || null, last: pods.at(-1)?.finishedAt || null,
  };
  return {
    champion: champion ? { id: champion.id, name: champion.name, wins: champion.wins, pods: champion.pods } : null,
    totals, awards, topPulls: top,
    spins: leagueSpins(leagueId),
    race: { pods: pods.map(p => p.name), players: racers },
    standings: rows.map(r => ({ id: r.id, name: r.name, active: r.active, pods: r.pods, wins: r.wins, voteWins: r.voteWins, packs: r.packs, mythics: r.mythics, foils: r.foils, streak: r.streak })),
  };
}
