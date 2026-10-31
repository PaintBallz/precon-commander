// End-to-end test for Pre-Con Commander. Runs INSIDE the Docker container:
//
//   docker compose exec pre-con-commander npm run e2e
//   (or, without the site running:  docker compose run --rm pre-con-commander npm run e2e)
//
// It starts a second copy of the server on its own port with a throwaway
// database in /tmp, so real game nights and wheel settings are never touched,
// then plays a full game night against live Scryfall: create game → crown
// winner → spin (with live-sync event) → open a real-data booster → Sacrifice a
// Pack → choose sets → open generated old + modern boosters → copy lists →
// wheel odds → finish → history.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listText } from '../public/decklist.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 3999);
const BASE = `http://127.0.0.1:${PORT}`;
const LIVE_SCRYFALL = !process.env.SCRYFALL_BASE;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pcc-e2e-'));
let server, serverLog = '';

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json, headers: res.headers, text };
}
const get = url => call('GET', url);
const post = (url, body = {}) => call('POST', url, body);
const put = (url, body) => call('PUT', url, body);
async function ok(p) {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `expected 2xx, got ${r.status}: ${JSON.stringify(r.json)}`);
  return r.json;
}
const player = (g, id) => g.players.find(p => p.id === id);
const count = (cards, pred) => cards.filter(pred).length;
const isRareUp = c => c.rarity === 'rare' || c.rarity === 'mythic';
const isBasic = c => /Basic( Snow)? Land/.test(c.type);

// Shared state across the ordered steps.
const S = {};

before(async () => {
  server = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Test server did not start:\n' + serverLog);
});

after(() => {
  server?.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('serves the app shell and assets', async () => {
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /<title>Pre-Con Commander<\/title>/);
  for (const f of ['/app.js', '/styles.css', '/decklist.js', '/favicon.svg']) {
    assert.equal((await get(f)).status, 200, `${f} should be served`);
  }
  const app = (await get('/app.js')).text;
  assert.doesNotMatch(app, /price|\$\d/i, 'no prices or values anywhere in the UI');
  assert.doesNotMatch(app, /booster box|open box/i, 'no booster boxes in the UI');
});

test('set list: every booster set from Scryfall, nothing else', async () => {
  const d = await ok(get('/api/sets'));
  S.sets = d.sets;
  const codes = new Set(d.sets.map(s => s.code));
  if (LIVE_SCRYFALL) assert.ok(d.sets.length > 100, `expected 100+ booster sets, got ${d.sets.length}`);
  for (const c of ['lea', 'blb', 'm10']) assert.ok(codes.has(c), `set ${c} should be on the list`);
  const today = new Date().toISOString().slice(0, 10);
  for (const s of d.sets) {
    assert.ok(['expansion', 'core', 'masters', 'draft_innovation'].includes(s.type), `${s.code} has non-booster type ${s.type}`);
    assert.ok(s.released <= today, `${s.code} is not released yet`);
    assert.ok(s.icon, `${s.code} has a set symbol`);
    assert.equal(s.price, undefined, 'sets carry no price');
  }
  assert.equal(d.wheel.length, d.sets.length, 'default wheel holds every set');
  const total = d.sets.reduce((a, s) => a + s.chance, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, 'wheel chances add up to 100%');
  assert.ok(d.sets.find(s => s.code === 'blb').realPack, 'BLB uses the real booster data');
});

test('creating a game validates players', async () => {
  assert.equal((await post('/api/game', { players: [{ name: 'Solo' }] })).status, 400);
  const { game } = await ok(post('/api/game', { players: [
    { name: 'Nick', precon: 'Animated Army' }, { name: 'Mike', precon: 'Death Toll' }, { name: 'Joe' }, { name: 'Dan' },
  ] }));
  assert.equal(game.status, 'playing');
  assert.equal(game.players.length, 4);
  assert.equal((await post('/api/game', { players: [{ name: 'A' }, { name: 'B' }] })).status, 409, 'only one game at a time');
  S.game = game;
});

test('no spinning before a winner is crowned', async () => {
  const r = await post('/api/game/spin', { playerId: 'p1' });
  assert.equal(r.status, 409);
});

test('winner gets 3 packs, everyone else gets 2', async () => {
  const { game } = await ok(post('/api/game/winner', { playerId: 'p1' }));
  assert.equal(game.status, 'awarded');
  assert.deepEqual(game.players.map(p => [p.name, p.awarded, p.remaining]), [['Nick', 3, 3], ['Mike', 2, 2], ['Joe', 2, 2], ['Dan', 2, 2]]);
});

test('a spin picks a set from the wheel and is pushed live to other devices', async () => {
  // Listen like a second phone would.
  const ctrl = new AbortController();
  const res = await fetch(BASE + '/api/events', { signal: ctrl.signal });
  const reader = res.body.getReader();
  const gotSpin = (async () => {
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return false;
      buf += new TextDecoder().decode(value);
      if (buf.includes('event: spin')) return true;
    }
  })();
  await new Promise(r => setTimeout(r, 200));

  const { game, spin } = await ok(post('/api/game/spin', { playerId: 'p1' }));
  const live = await Promise.race([gotSpin, new Promise(r => setTimeout(() => r(false), 5000))]);
  ctrl.abort();
  assert.ok(live, 'spin event reached the other device');

  const pack = player(game, 'p1').packs.find(k => k.id === spin.packId);
  assert.equal(pack.status, 'ready');
  assert.equal(pack.source, 'wheel');
  assert.ok(S.sets.some(s => s.code === spin.setCode), 'landed on a set from the list');
  assert.equal(player(game, 'p1').remaining, 2);
  S.p1Pack = pack;
});

test('a spun pack opens as that set\'s regular booster (never Collector)', async () => {
  const { pack } = await ok(post(`/api/game/pack/${S.p1Pack.id}/open`));
  assert.equal(pack.status, 'opened');
  assert.doesNotMatch(pack.boosterType, /collector/i);
  assert.ok(pack.cards.length >= 12 && pack.cards.length <= 16, `pack has ${pack.cards.length} cards`);
  for (const c of pack.cards) {
    assert.ok(c.name && c.set && c.number && c.rarity, `card is complete: ${JSON.stringify(c)}`);
    assert.ok(/^https?:\/\//.test(c.image), 'card has an image');
    assert.equal(c.price, undefined, 'cards carry no price');
  }
  assert.ok(count(pack.cards, isRareUp) >= 1, 'at least one rare or mythic');
  const again = await post(`/api/game/pack/${S.p1Pack.id}/open`);
  assert.deepEqual(again.json.pack.cards, pack.cards, 're-opening returns the same cards');
});

test('card images load from Scryfall', { skip: !LIVE_SCRYFALL && 'mock Scryfall' }, async () => {
  const { game } = await ok(get('/api/state'));
  const card = player(game, 'p1').packs[0].cards.find(isRareUp);
  assert.match(card.image, /^https:\/\/cards\.scryfall\.io\//, 'image comes from the Scryfall CDN');
  // The CDN answers 400 to Node's default User-Agent; browsers are fine.
  const img = await fetch(card.image, { method: 'HEAD', headers: { 'User-Agent': 'PreconCommander-e2e/1.0' } });
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type'), /^image\//);
});

test('Sacrifice a Pack costs one extra pack and lets you pick any set', async () => {
  const { spin } = await ok(post('/api/game/spin', { playerId: 'p2' }));
  let { game } = await ok(post(`/api/game/pack/${spin.packId}/sacrifice`));
  const mike = player(game, 'p2');
  assert.equal(mike.sacrificed, 1);
  assert.equal(mike.remaining, 0, 'Mike: 2 awarded − 1 spun − 1 sacrificed');
  assert.equal(mike.packs[0].status, 'choosing');
  assert.equal((await post(`/api/game/pack/${spin.packId}/open`)).status, 409, 'cannot open before choosing');
  assert.equal((await post(`/api/game/pack/${spin.packId}/choose`, { setCode: 'nope' })).status, 400);

  ({ game } = await ok(post(`/api/game/pack/${spin.packId}/choose`, { setCode: 'blb' })));
  const pack = player(game, 'p2').packs[0];
  assert.equal(pack.set.code, 'blb');
  assert.equal(pack.status, 'ready');
  assert.notEqual(pack.wheelSet, undefined, 'the original wheel result is kept for history');

  const opened = (await ok(post(`/api/game/pack/${spin.packId}/open`))).pack;
  assert.equal(opened.boosterType, 'Play Booster', 'Bloomburrow uses its real Play Booster data');
  assert.equal(opened.cards.length, 14);
  assert.equal((await post('/api/game/spin', { playerId: 'p2' })).status, 409, 'Mike has nothing left to spin');
});

test('cannot sacrifice your last pack', async () => {
  // Joe: 2 packs. Spin one, sacrifice (uses the 2nd), then spin is impossible.
  const a = await ok(post('/api/game/spin', { playerId: 'p3' }));
  await ok(post(`/api/game/pack/${a.spin.packId}/sacrifice`));
  // Dan: spin both, then try to sacrifice with nothing left.
  await ok(post('/api/game/spin', { playerId: 'p4' }));
  const b = await ok(post('/api/game/spin', { playerId: 'p4' }));
  const r = await post(`/api/game/pack/${b.spin.packId}/sacrifice`);
  assert.equal(r.status, 409);
  S.joePack = a.spin.packId;
});

test('generated booster for an old set (Alpha): 11 commons, 3 uncommons, 1 rare, no land slot', async () => {
  await ok(post(`/api/game/pack/${S.joePack}/choose`, { setCode: 'lea' }));
  const { pack } = await ok(post(`/api/game/pack/${S.joePack}/open`));
  assert.equal(pack.generated, true);
  assert.equal(pack.cards.length, 15);
  assert.equal(count(pack.cards, c => c.rarity === 'common'), 11);
  assert.equal(count(pack.cards, c => c.rarity === 'uncommon'), 3);
  assert.equal(count(pack.cards, isRareUp), 1);
  assert.equal(count(pack.cards, isBasic), 0, 'no basic land slot before Shards of Alara');
  assert.ok(pack.cards.every(c => c.set === 'lea'));
});

test('generated booster for a modern set (Magic 2010): land slot + rare/mythic', async () => {
  const { game } = await ok(post('/api/game/award', { playerId: 'p2', delta: 1 }));
  assert.equal(player(game, 'p2').remaining, 1, 'manual +1 pack works');
  const { spin } = await ok(post('/api/game/spin', { playerId: 'p2' }));
  await ok(post('/api/game/award', { playerId: 'p2', delta: 1 }));
  await ok(post(`/api/game/pack/${spin.packId}/sacrifice`));
  await ok(post(`/api/game/pack/${spin.packId}/choose`, { setCode: 'm10' }));
  const { pack } = await ok(post(`/api/game/pack/${spin.packId}/open`));
  assert.equal(pack.cards.length, 15);
  assert.equal(count(pack.cards, isBasic), 1, 'one basic land');
  assert.ok(count(pack.cards, isRareUp) >= 1);
  assert.ok(count(pack.cards, c => c.rarity === 'uncommon') >= 3);
});

test('copy-to-clipboard text is Moxfield/Archidekt format', async () => {
  const { game } = await ok(get('/api/state'));
  const pulls = player(game, 'p2').packs.filter(k => k.status === 'opened').flatMap(k => k.cards);
  const text = listText(pulls);
  const lines = text.split('\n');
  for (const l of lines) assert.match(l, /^\d+ .+ \([A-Z0-9]+\) \S+$/, `bad line: ${l}`);
  const total = lines.reduce((a, l) => a + Number(l.split(' ')[0]), 0);
  assert.equal(total, pulls.length, 'combined list keeps every card (duplicates merged with counts)');
  assert.equal(listText([{ name: 'Forest', set: 'blb', number: '278' }, { name: 'Forest', set: 'blb', number: '278' }]), '2 Forest (BLB) 278');
});

test('wheel odds follow per-set weights and exclusions', async () => {
  const keep = ['blb', 'lea'];
  const excluded = S.sets.map(s => s.code).filter(c => !keep.includes(c));
  const set = await ok(put('/api/settings', { excluded, weights: { blb: 3 } }));
  assert.equal(set.settings.weights.blb, 3);
  const d = await ok(get('/api/sets'));
  assert.deepEqual(d.wheel.map(w => w.code).sort(), keep.sort());
  assert.ok(Math.abs(d.sets.find(s => s.code === 'blb').chance - 0.75) < 1e-9, 'weight 3 vs 1 → 75%');

  const N = 120;
  for (let i = 0; i < N; i++) await ok(post('/api/game/award', { playerId: 'p4', delta: 1 }));
  const hits = { blb: 0, lea: 0 };
  for (let i = 0; i < N; i++) hits[(await ok(post('/api/game/spin', { playerId: 'p4' }))).spin.setCode]++;
  assert.equal(hits.blb + hits.lea, N, 'only sets on the wheel come up');
  assert.ok(hits.blb / N > 0.6 && hits.blb / N < 0.9, `blb came up ${hits.blb}/${N}, expected ~75%`);

  const filtered = await ok(put('/api/settings', { excluded: [], weights: {}, minYear: 2024, maxYear: 2100 }));
  assert.equal(filtered.settings.minYear, 2024);
  const d2 = await ok(get('/api/sets'));
  assert.ok(d2.wheel.every(w => d2.sets.find(s => s.code === w.code).year >= 2024), 'year filter applies');
  await ok(put('/api/settings', { reset: true }));
  assert.equal((await ok(get('/api/sets'))).wheel.length, S.sets.length, 'reset restores the full wheel');
});

test('finishing saves the game night to history', async () => {
  await ok(post('/api/game/finish'));
  const st = await ok(get('/api/state'));
  assert.equal(st.game, null);
  assert.deepEqual(st.lastPlayers.map(p => p.name), ['Nick', 'Mike', 'Joe', 'Dan'], 'next game pre-fills the same players');
  const { games } = await ok(get('/api/history'));
  assert.equal(games.length, 1);
  const g = games[0];
  assert.equal(g.winnerId, 'p1');
  assert.ok(g.finishedAt);
  assert.ok(player(g, 'p2').packs.some(k => k.source === 'sacrifice' && k.cards?.length), 'sacrificed packs and pulls are kept');
});

test('a discarded game is not saved to history', async () => {
  await ok(post('/api/game', { players: [{ name: 'A' }, { name: 'B' }] }));
  await ok(post('/api/game/discard'));
  const { games } = await ok(get('/api/history'));
  assert.equal(games.length, 1);
});
