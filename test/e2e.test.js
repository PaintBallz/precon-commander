// End-to-end test for Pre-Con Commander. Runs INSIDE the Docker container:
//
//   docker compose exec pre-con-commander npm run e2e
//   (or, without the site running:  docker compose run --rm pre-con-commander npm run e2e)
//
// It starts a second copy of the server on its own port with a throwaway
// database in /tmp, so real league data and wheel settings are never touched,
// then plays a full league night against live Scryfall: admin first login →
// sign-ups → pod → crown winner → the pod's one spin (with live-sync event) →
// open boosters → Sacrifice a Pack → choose sets → generated old + modern
// boosters → pools → copy lists → admin-only wheel odds → finish → history.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { listText } from '../public/decklist.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 3999);
const BASE = `http://127.0.0.1:${PORT}`;
const LIVE_SCRYFALL = !process.env.SCRYFALL_BASE;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pcc-e2e-'));
let server, serverLog = '';

// One cookie jar per "phone".
function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) };
    const res = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json, headers: res.headers, text };
  };
  return {
    get: url => call('GET', url),
    post: (url, body = {}) => call('POST', url, body),
    put: (url, body) => call('PUT', url, body),
    del: url => call('DELETE', url, {}),
    get cookie() { return cookie; },
  };
}
async function ok(p) {
  const r = await p;
  assert.ok(r.status >= 200 && r.status < 300, `expected 2xx, got ${r.status}: ${JSON.stringify(r.json)}`);
  return r.json;
}
const count = (cards, pred) => cards.filter(pred).length;
const isRareUp = c => c.rarity === 'rare' || c.rarity === 'mythic';
const isBasic = c => /Basic( Snow)? Land/.test(c.type);
const PW = 'league2026';

// Shared state across the ordered steps.
const S = { u: {} };
const anon = client();
const admin = client();
const nick = client(), mike = client(), joe = client(), dan = client(), eve = client();
const player = (pod, who) => pod.players.find(p => p.id === S.u[who].id);

before(async () => {
  server = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, SMTP_HOST: '', MAIL_FROM: '' },
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
  const home = await anon.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /<title>Pre-Con Commander<\/title>/);
  // Cloudflare caches .js/.css for hours, so the page must link versioned URLs.
  assert.match(home.text, /\/app\.js\?v=[0-9a-f]{10}"/, 'script URL carries a content version');
  assert.match(home.text, /\/styles\.css\?v=[0-9a-f]{10}"/, 'stylesheet URL carries a content version');
  assert.equal(home.headers.get('cache-control'), 'no-cache');
  for (const f of ['/app.js', '/styles.css', '/decklist.js', '/favicon.svg']) {
    assert.equal((await anon.get(f)).status, 200, `${f} should be served`);
  }
  const app = (await anon.get('/app.js')).text;
  assert.doesNotMatch(app, /price|\$\d/i, 'no prices or values anywhere in the UI');
  assert.doesNotMatch(app, /booster box|open box/i, 'no booster boxes in the UI');
});

test('the league is behind a login', async () => {
  for (const url of ['/api/state', '/api/sets', '/api/pools', '/api/history', '/api/events']) {
    assert.equal((await anon.get(url)).status, 401, `${url} needs a login`);
  }
  const me = await ok(anon.get('/api/auth/me'));
  assert.equal(me.user, null);
  assert.match(me.passwordRules, /8 characters/);
  assert.equal((await anon.post('/api/auth/login', { username: 'admin', password: 'nope' })).status, 401);
});

test('admin starts on "changeme" and must change it first', async () => {
  const { user } = await ok(admin.post('/api/auth/login', { username: 'admin', password: 'changeme' }));
  assert.equal(user.isAdmin, true);
  assert.equal(user.mustChange, true);
  assert.match(admin.cookie, /^pcc_sid=/);
  const blocked = await admin.get('/api/state');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.mustChange, true);
  assert.equal((await admin.post('/api/auth/password', { current: 'changeme', password: 'short1' })).status, 400, 'too short');
  assert.equal((await admin.post('/api/auth/password', { current: 'changeme', password: 'lettersonly' })).status, 400, 'needs a number');
  assert.equal((await admin.post('/api/auth/password', { current: 'wrong', password: 'Admin2026' })).status, 400, 'current password checked');
  const r = await ok(admin.post('/api/auth/password', { current: 'changeme', password: 'Admin2026' }));
  assert.equal(r.user.mustChange, false);
  await ok(admin.get('/api/state'));
  assert.equal((await anon.post('/api/auth/login', { username: 'admin', password: 'changeme' })).status, 401, 'old password is gone');
});

test('sign-up needs a username, an email and a simple-rules password', async () => {
  assert.equal((await anon.post('/api/auth/signup', { username: 'Nick', password: PW })).status, 400, 'email required');
  assert.equal((await anon.post('/api/auth/signup', { username: 'Nick', email: 'not-an-email', password: PW })).status, 400);
  assert.equal((await anon.post('/api/auth/signup', { username: 'Nick', email: 'nick@example.com', password: 'abc' })).status, 400, 'weak password');
  assert.equal((await anon.post('/api/auth/signup', { username: 'x', email: 'x@example.com', password: PW })).status, 400, 'username too short');
  for (const [name, c] of [['Nick', nick], ['Mike', mike], ['Joe', joe], ['Dan', dan], ['Eve', eve]]) {
    const { user } = await ok(c.post('/api/auth/signup', { username: name, email: `${name.toLowerCase()}@example.com`, password: PW }));
    assert.equal(user.isAdmin, false);
    S.u[name] = user;
  }
  assert.equal((await anon.post('/api/auth/signup', { username: 'nick', email: 'other@example.com', password: PW })).status, 409, 'usernames are unique (any case)');
  assert.equal((await anon.post('/api/auth/signup', { username: 'Nick2', email: 'NICK@example.com', password: PW })).status, 409, 'one account per email');
  await ok(nick.put('/api/auth/profile', { precon: 'Animated Army' }));
  const { members } = await ok(nick.get('/api/members'));
  assert.equal(members.length, 5, '5 players: more than one pod\'s worth');
  assert.ok(!members.some(m => m.username === 'admin'), 'the admin account is not listed as a member');
  assert.equal(JSON.stringify(members).includes('isAdmin'), false);
  assert.equal(members.find(m => m.username === 'Nick').precon, 'Animated Army');
  assert.equal(JSON.stringify(members).includes('@'), false, 'member list does not expose emails');
  // Logging in by email works too.
  await ok(client().post('/api/auth/login', { username: 'eve@example.com', password: PW }));
});

test('password reset: admin link (no email configured) sets a new password', async () => {
  const forgot = await ok(anon.post('/api/auth/forgot', { email: 'joe@example.com' }));
  assert.equal(forgot.emailEnabled, false);
  assert.equal((await joe.post(`/api/admin/users/${S.u.Joe.id}/reset-link`)).status, 403, 'only the admin hands out links');
  const { link } = await ok(admin.post(`/api/admin/users/${S.u.Joe.id}/reset-link`));
  const token = new URL(link.replace('#reset?', 'reset?')).searchParams.get('token');
  assert.ok(token);
  const phone = client();
  assert.equal((await phone.post('/api/auth/reset', { token, password: 'weak' })).status, 400);
  await ok(phone.post('/api/auth/reset', { token, password: 'NewJoe2026' }));
  assert.equal((await phone.post('/api/auth/reset', { token, password: 'NewJoe2027' })).status, 400, 'a link works once');
  assert.equal((await joe.get('/api/state')).status, 401, 'old sessions are signed out');
  await ok(joe.post('/api/auth/login', { username: 'Joe', password: 'NewJoe2026' }));
});

test('set list: every booster set from Scryfall, nothing else', async () => {
  const d = await ok(nick.get('/api/sets'));
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

test('only the admin can edit All Sets / the wheel', async () => {
  assert.equal((await nick.put('/api/settings', { excluded: ['blb'] })).status, 403);
  assert.equal((await nick.put('/api/settings', { reset: true })).status, 403);
  assert.equal((await ok(nick.get('/api/sets'))).settings.excluded.length, 0, 'nothing changed');
});

test('pods hold 2 to 4 league members', async () => {
  const ids = names => names.map(n => ({ userId: S.u[n].id }));
  assert.equal((await nick.post('/api/pods', { players: ids(['Nick']) })).status, 400);
  assert.equal((await nick.post('/api/pods', { players: ids(['Nick', 'Mike', 'Joe', 'Dan', 'Eve']) })).status, 400, 'max 4 per pod');
  assert.equal((await nick.post('/api/pods', { players: [{ userId: S.u.Nick.id }, { userId: 'ghost' }] })).status, 400);
  assert.equal((await eve.post('/api/pods', { players: ids(['Nick', 'Mike']) })).status, 403, 'players add themselves');
  const adminId = (await ok(admin.get('/api/auth/me'))).user.id;
  assert.equal((await admin.post('/api/pods', { players: [{ userId: adminId }, { userId: S.u.Eve.id }] })).status, 400, 'the admin account does not play in pods');
  const { pod } = await ok(nick.post('/api/pods', { players: [...ids(['Nick']), { userId: S.u.Mike.id, precon: 'Death Toll' }, ...ids(['Joe', 'Dan'])] }));
  assert.equal(pod.status, 'playing');
  assert.equal(pod.name, 'Pod 1');
  assert.deepEqual(pod.players.map(p => [p.name, p.precon]), [['Nick', 'Animated Army'], ['Mike', 'Death Toll'], ['Joe', ''], ['Dan', '']]);
  assert.equal((await eve.post('/api/pods', { players: ids(['Eve', 'Nick']) })).status, 409, 'Nick is already in a pod');
  S.pod = pod;
});

test('no spin before the winner is crowned; outsiders can\'t crown', async () => {
  assert.equal((await nick.post(`/api/pods/${S.pod.id}/spin`)).status, 409);
  assert.equal((await eve.post(`/api/pods/${S.pod.id}/winner`, { playerId: S.u.Nick.id })).status, 403);
});

test('winner gets 3 packs, everyone else gets 2', async () => {
  const { pod } = await ok(mike.post(`/api/pods/${S.pod.id}/winner`, { playerId: S.u.Nick.id }));
  assert.equal(pod.status, 'awarded');
  assert.deepEqual(pod.players.map(p => [p.name, p.awarded]), [['Nick', 3], ['Mike', 2], ['Joe', 2], ['Dan', 2]]);
  assert.equal(pod.vote.status, 'open', 'crowning the winner opens the bonus-pack vote');
  assert.equal(pod.vote.current.round, 1);
  assert.equal(pod.vote.current.candidates.length, 4);
});

test('the pod votes for a bonus pack: no self-votes, ties go to a re-vote', async () => {
  const url = `/api/pods/${S.pod.id}/vote`;
  const vote = (c, who) => c.post(url, { candidateId: S.u[who].id });
  assert.equal((await nick.post(`/api/pods/${S.pod.id}/spin`)).status, 409, 'no spin until the vote is decided');
  assert.equal((await vote(nick, 'Nick')).status, 400, "you can't vote for yourself");
  assert.equal((await vote(eve, 'Nick')).status, 403, 'only pod players vote');
  assert.equal((await nick.post(url, { candidateId: S.u.Eve.id })).status, 400, 'only pod players can be voted for');

  // Round 1: 2–2 tie between Nick and Mike (Joe changes his mind once).
  await ok(vote(joe, 'Dan'));
  await ok(vote(joe, 'Nick'));
  let r = await ok(vote(nick, 'Mike'));
  assert.equal(r.result, 'voted');
  assert.deepEqual(r.pod.vote.current.voted.sort(), [S.u.Joe.id, S.u.Nick.id].sort());
  assert.equal(r.pod.vote.current.myVote, S.u.Mike.id, 'you see your own ballot');
  const dansView = (await ok(dan.get('/api/state'))).pods[0].vote;
  assert.equal(dansView.current.myVote, null);
  assert.equal(JSON.stringify(dansView).includes('candidateId'), false, 'other ballots stay secret while the round is open');
  assert.equal((await mike.post(`/api/pods/${S.pod.id}/winner`, { playerId: S.u.Mike.id })).status, 409, 'winner is locked once voting starts');
  await ok(vote(mike, 'Nick'));
  r = await ok(vote(dan, 'Mike'));
  assert.equal(r.result, 'tied');
  const v = r.pod.vote;
  assert.equal(v.status, 'open');
  assert.equal(v.current.round, 2);
  assert.deepEqual(v.current.candidates.sort(), [S.u.Nick.id, S.u.Mike.id].sort(), 're-vote is between the tied players');
  assert.deepEqual(v.rounds[0].tally, { [S.u.Nick.id]: 2, [S.u.Mike.id]: 2, [S.u.Joe.id]: 0, [S.u.Dan.id]: 0 }, 'closed rounds show their counts');
  assert.equal((await vote(joe, 'Dan')).status, 400, 'players who were not tied are out of the re-vote');

  // Round 2: Mike wins 3–1. Mike, a candidate, still can't vote for himself.
  assert.equal((await vote(mike, 'Mike')).status, 400);
  await ok(vote(mike, 'Nick'));
  await ok(vote(nick, 'Mike'));
  await ok(vote(joe, 'Mike'));
  r = await ok(vote(dan, 'Mike'));
  assert.equal(r.result, 'decided');
  assert.equal(r.pod.vote.status, 'done');
  assert.equal(r.pod.vote.winnerId, S.u.Mike.id);
  assert.deepEqual(r.pod.players.map(p => [p.name, p.awarded]), [['Nick', 3], ['Mike', 3], ['Joe', 2], ['Dan', 2]], 'the vote winner gets +1 pack');
  assert.equal((await vote(joe, 'Mike')).status, 409, 'the vote is over');
  S.pod = r.pod;
});

test('only the winner spins, once, and it is pushed live to other devices', async () => {
  assert.equal((await mike.post(`/api/pods/${S.pod.id}/spin`)).status, 403, 'only the winner spins');
  // Listen like a second phone would.
  const ctrl = new AbortController();
  const res = await fetch(BASE + '/api/events', { signal: ctrl.signal, headers: { Cookie: eve.cookie } });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const gotSpin = (async () => {
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return false;
      buf += new TextDecoder().decode(value);
      if (buf.includes('event: spin') && buf.includes(S.pod.id)) return true;
    }
  })();
  await new Promise(r => setTimeout(r, 200));

  // Keep the wheel to real-booster sets for this spin so the pack checks
  // below don't depend on which of ~180 sets comes up.
  const REAL = ['dom', 'war', 'eld', 'neo'];
  await ok(admin.put('/api/settings', { excluded: S.sets.map(s => s.code).filter(c => !REAL.includes(c)) }));
  const { pod, spin } = await ok(nick.post(`/api/pods/${S.pod.id}/spin`));
  await ok(admin.put('/api/settings', { reset: true }));
  const live = await Promise.race([gotSpin, new Promise(r => setTimeout(() => r(false), 5000))]);
  ctrl.abort();
  assert.ok(live, 'spin event reached the other device');
  assert.ok(REAL.includes(spin.setCode), 'landed on a set that is on the wheel');
  for (const p of pod.players) {
    assert.equal(p.packs.length, p.awarded, `${p.name} has all their packs`);
    assert.ok(p.packs.every(k => k.set.code === spin.setCode && k.status === 'ready' && k.source === 'wheel'), `${p.name}'s packs are all the spun set`);
  }
  const again = await nick.post(`/api/pods/${S.pod.id}/spin`);
  assert.equal(again.status, 409, 'there is only one spin per pod');
  S.pod = pod; S.spin = spin;
});

test('a spun pack opens as that set\'s regular booster (never Collector)', async () => {
  const k = player(S.pod, 'Nick').packs[0];
  assert.equal((await mike.post(`/api/pods/${S.pod.id}/packs/${k.id}/open`)).status, 403, 'you can only open your own packs');
  const { pack } = await ok(nick.post(`/api/pods/${S.pod.id}/packs/${k.id}/open`));
  assert.equal(pack.status, 'opened');
  assert.equal(pack.set.code, S.spin.setCode);
  assert.doesNotMatch(pack.boosterType, /collector/i);
  assert.ok(pack.cards.length >= 12 && pack.cards.length <= 16, `pack has ${pack.cards.length} cards`);
  for (const c of pack.cards) {
    assert.ok(c.name && c.set && c.number && c.rarity, `card is complete: ${JSON.stringify(c)}`);
    assert.ok(/^https?:\/\//.test(c.image), 'card has an image');
    assert.equal(c.price, undefined, 'cards carry no price');
  }
  assert.ok(count(pack.cards, isRareUp) >= 1, 'at least one rare or mythic');
  const again = await nick.post(`/api/pods/${S.pod.id}/packs/${k.id}/open`);
  assert.deepEqual(again.json.pack.cards, pack.cards, 're-opening returns the same cards');
  S.nickCards = pack.cards;
});

test('card images load from Scryfall', { skip: !LIVE_SCRYFALL && 'mock Scryfall' }, async () => {
  const card = S.nickCards.find(isRareUp);
  assert.match(card.image, /^https:\/\/cards\.scryfall\.io\//, 'image comes from the Scryfall CDN');
  // The CDN answers 400 to Node's default User-Agent; browsers are fine.
  const img = await fetch(card.image, { method: 'HEAD', headers: { 'User-Agent': 'PreconCommander-e2e/1.0' } });
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type'), /^image\//);
});

test('Sacrifice a Pack gives up one spun pack to pick any set for another', async () => {
  const mk = () => player(S.pod, 'Mike');
  const k = mk().packs[0];
  assert.equal((await joe.post(`/api/pods/${S.pod.id}/packs/${k.id}/sacrifice`)).status, 403, 'not your pack');
  let { pod } = await ok(mike.post(`/api/pods/${S.pod.id}/packs/${k.id}/sacrifice`));
  S.pod = pod;
  assert.equal(mk().sacrificed, 1);
  assert.equal(mk().packs.length, 2, 'Mike: 3 packs (2 + vote bonus) − 1 sacrificed');
  assert.equal(mk().packs[0].status, 'choosing');
  assert.equal((await mike.post(`/api/pods/${S.pod.id}/packs/${k.id}/open`)).status, 409, 'cannot open before choosing');
  assert.equal((await mike.post(`/api/pods/${S.pod.id}/packs/${k.id}/choose`, { setCode: 'nope' })).status, 400);

  ({ pod } = await ok(mike.post(`/api/pods/${S.pod.id}/packs/${k.id}/choose`, { setCode: 'blb' })));
  S.pod = pod;
  const pack = mk().packs[0];
  assert.equal(pack.set.code, 'blb');
  assert.equal(pack.status, 'ready');
  assert.equal(pack.wheelSet.code, S.spin.setCode, 'the spun set is kept for history');

  const opened = (await ok(mike.post(`/api/pods/${S.pod.id}/packs/${k.id}/open`))).pack;
  assert.equal(opened.boosterType, 'Play Booster', 'Bloomburrow uses its real Play Booster data');
  assert.equal(opened.cards.length, 14);
});

test('cannot sacrifice without another spun pack to give up', async () => {
  // Dan opens one of his 2 packs, then can't sacrifice the other.
  const [a, b] = player(S.pod, 'Dan').packs;
  await ok(dan.post(`/api/pods/${S.pod.id}/packs/${a.id}/open`));
  assert.equal((await dan.post(`/api/pods/${S.pod.id}/packs/${b.id}/sacrifice`)).status, 409);
  // Joe sacrifices; his second pack is gone, so he can't sacrifice again.
  const j = player(S.pod, 'Joe').packs[0];
  const { pod } = await ok(joe.post(`/api/pods/${S.pod.id}/packs/${j.id}/sacrifice`));
  S.pod = pod;
  assert.equal(player(pod, 'Joe').packs.length, 1);
  S.joePack = j.id;
});

test('generated booster for an old set (Alpha): 11 commons, 3 uncommons, 1 rare, no land slot', async () => {
  await ok(joe.post(`/api/pods/${S.pod.id}/packs/${S.joePack}/choose`, { setCode: 'lea' }));
  const { pack } = await ok(joe.post(`/api/pods/${S.pod.id}/packs/${S.joePack}/open`));
  assert.equal(pack.generated, true);
  assert.equal(pack.cards.length, 15);
  assert.equal(count(pack.cards, c => c.rarity === 'common'), 11);
  assert.equal(count(pack.cards, c => c.rarity === 'uncommon'), 3);
  assert.equal(count(pack.cards, isRareUp), 1);
  assert.equal(count(pack.cards, isBasic), 0, 'no basic land slot before Shards of Alara');
  assert.ok(pack.cards.every(c => c.set === 'lea'));
});

test('generated booster for a modern set (Magic 2010): land slot + rare/mythic', async () => {
  assert.equal((await nick.post(`/api/pods/${S.pod.id}/award`, { playerId: S.u.Nick.id, delta: 1 })).status, 403, 'only the admin adjusts packs');
  let { pod } = await ok(admin.post(`/api/pods/${S.pod.id}/award`, { playerId: S.u.Nick.id, delta: 1 }));
  const nk = player(pod, 'Nick');
  assert.equal(nk.packs.length, 4, 'admin +1 adds a pack of the spun set');
  assert.equal(nk.packs.at(-1).set.code, S.spin.setCode);
  const k = nk.packs.find(x => x.status === 'ready');
  ({ pod } = await ok(nick.post(`/api/pods/${S.pod.id}/packs/${k.id}/sacrifice`)));
  await ok(nick.post(`/api/pods/${S.pod.id}/packs/${k.id}/choose`, { setCode: 'm10' }));
  const { pack } = await ok(nick.post(`/api/pods/${S.pod.id}/packs/${k.id}/open`));
  assert.equal(pack.cards.length, 15);
  assert.equal(count(pack.cards, isBasic), 1, 'one basic land');
  assert.ok(count(pack.cards, isRareUp) >= 1);
  assert.ok(count(pack.cards, c => c.rarity === 'uncommon') >= 3);
});

test('pools track each player\'s opened cards at all times', async () => {
  const { pools } = await ok(eve.get('/api/pools'));
  const pool = name => pools.find(p => p.username === name);
  const { pod } = await ok(nick.get(`/api/pods/${S.pod.id}`));
  S.pod = pod;
  for (const name of ['Nick', 'Mike', 'Joe', 'Dan']) {
    const opened = player(pod, name).packs.filter(k => k.status === 'opened');
    assert.equal(pool(name).packs.length, opened.length, `${name}'s pool has every opened pack (running pod)`);
    assert.equal(pool(name).packs.flatMap(k => k.cards).length, opened.flatMap(k => k.cards).length);
  }
  assert.equal(pool('Nick').precon, 'Animated Army', 'the precon is shown but not listed as cards');
  assert.equal(pool('Eve').packs.length, 0, 'Eve has not played yet');
  assert.equal(pool('admin'), undefined, 'the admin account is not listed in Pools');
  assert.equal(pool('Eve').pods.length, 0);
  assert.deepEqual(pool('Nick').pods.map(x => x.id), [S.pod.id], 'pools know which pod each player played');
});

test('copied lists match the Moxfield and Archidekt import formats', async () => {
  const pulls = player(S.pod, 'Nick').packs.filter(k => k.status === 'opened').flatMap(k => k.cards);
  const formats = {
    moxfield: /^(\d+) .+ \([A-Z0-9]+\) \S+( \*F\*)?$/,   // 1 Name (SET) 123 [*F*]
    archidekt: /^(\d+)x .+ \([a-z0-9]+\) \S+( \*F\*)?$/, // 1x Name (set) 123 [*F*]
  };
  for (const [site, re] of Object.entries(formats)) {
    const lines = listText(pulls, site).split('\n');
    for (const l of lines) assert.match(l, re, `bad ${site} line: ${l}`);
    const total = lines.reduce((a, l) => a + Number(l.match(re)[1]), 0);
    assert.equal(total, pulls.length, `${site}: every card kept (duplicates merged with counts)`);
    assert.equal(lines.filter(l => l.endsWith(' *F*')).length, new Set(pulls.filter(c => c.foil).map(c => `${c.set}/${c.number}`)).size, `${site}: foils are marked`);
  }
  assert.equal(listText(pulls), listText(pulls, 'moxfield'), 'Moxfield is the default');

  const forest = { name: 'Forest', set: 'blb', number: '278' };
  const foilBolt = { name: 'Lightning Bolt', set: 'm10', number: '146', foil: true };
  const delver = { name: 'Delver of Secrets // Insectile Aberration', set: 'isd', number: '51' };
  assert.equal(listText([forest, forest, foilBolt, { ...foilBolt, foil: false }, delver], 'moxfield'),
    '2 Forest (BLB) 278\n1 Lightning Bolt (M10) 146 *F*\n1 Lightning Bolt (M10) 146\n1 Delver of Secrets // Insectile Aberration (ISD) 51');
  assert.equal(listText([forest, forest, foilBolt, { ...foilBolt, foil: false }, delver], 'archidekt'),
    '2x Forest (blb) 278\n1x Lightning Bolt (m10) 146 *F*\n1x Lightning Bolt (m10) 146\n1x Delver of Secrets // Insectile Aberration (isd) 51');
});

test('finishing saves the pod to history (and its pool stays)', async () => {
  assert.equal((await eve.post(`/api/pods/${S.pod.id}/finish`)).status, 403, 'only pod players (or the admin) finish it');
  await ok(dan.post(`/api/pods/${S.pod.id}/finish`));
  const st = await ok(nick.get('/api/state'));
  assert.equal(st.pods.length, 0);
  const { pods } = await ok(nick.get('/api/history'));
  assert.equal(pods.length, 1);
  assert.equal(pods[0].winnerId, S.u.Nick.id);
  assert.equal(pods[0].spin.setCode, S.spin.setCode);
  assert.ok(pods[0].finishedAt);
  assert.ok(player(pods[0], 'Mike').packs.some(k => k.source === 'sacrifice' && k.cards?.length), 'sacrificed packs and pulls are kept');
  const { pools } = await ok(nick.get('/api/pools'));
  assert.ok(pools.find(p => p.username === 'Mike').packs.length >= 1, 'finished pods stay in the pools');
});

test('2-player pods skip the vote; the admin can skip a stuck one', async () => {
  const two = (await ok(eve.post('/api/pods', { players: [{ userId: S.u.Eve.id }, { userId: S.u.Joe.id }] }))).pod;
  const crowned = (await ok(eve.post(`/api/pods/${two.id}/winner`, { playerId: S.u.Eve.id }))).pod;
  assert.equal(crowned.vote.status, 'skipped', 'two players could only ever tie');
  assert.deepEqual(crowned.players.map(p => p.awarded), [3, 2], 'no bonus pack');
  await ok(eve.post(`/api/pods/${two.id}/discard`));

  const three = (await ok(eve.post('/api/pods', { players: ['Eve', 'Joe', 'Dan'].map(n => ({ userId: S.u[n].id })) }))).pod;
  await ok(eve.post(`/api/pods/${three.id}/winner`, { playerId: S.u.Eve.id }));
  await ok(eve.post(`/api/pods/${three.id}/vote`, { candidateId: S.u.Joe.id }));
  assert.equal((await eve.post(`/api/pods/${three.id}/vote/skip`)).status, 403, 'only the admin can skip');
  const skipped = (await ok(admin.post(`/api/pods/${three.id}/vote/skip`))).pod;
  assert.equal(skipped.vote.status, 'skipped');
  assert.deepEqual(skipped.players.map(p => p.awarded), [3, 2, 2]);
  await ok(eve.post(`/api/pods/${three.id}/spin`));
  await ok(eve.post(`/api/pods/${three.id}/discard`));
});

test('pods, players, packs and pool cards are stored as tables', async () => {
  const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'), { readOnly: true });
  try {
    const pod = db.prepare('SELECT * FROM pods WHERE id = ?').get(S.pod.id);
    assert.equal(pod.status, 'done');
    assert.equal(pod.winner_id, S.u.Nick.id);
    assert.equal(pod.spin_set_code, S.spin.setCode);
    assert.equal(db.prepare('SELECT count(*) n FROM pod_players WHERE pod_id = ?').get(S.pod.id).n, 4);
    const opened = S.pod.players.flatMap(p => p.packs).filter(k => k.status === 'opened');
    assert.equal(db.prepare(`SELECT count(*) n FROM pod_packs WHERE pod_id = ? AND status = 'opened'`).get(S.pod.id).n, opened.length);
    const cards = db.prepare('SELECT * FROM pool_cards WHERE pod_id = ?').all(S.pod.id);
    assert.equal(cards.length, opened.flatMap(k => k.cards).length, 'every opened card is a pool_cards row');
    assert.ok(cards.every(c => c.pack_id && c.user_id && c.name && c.set_code && c.number && c.rarity), 'cards keep pod, pack and player ids');
    const mikes = db.prepare('SELECT count(*) n FROM pool_cards WHERE pod_id = ? AND user_id = ?').get(S.pod.id, S.u.Mike.id).n;
    assert.equal(mikes, 14, "Mike's BLB Play Booster is in his pool for this pod");
    assert.equal(pod.vote_status, 'done');
    assert.equal(pod.vote_winner_id, S.u.Mike.id);
    const ballots = db.prepare('SELECT round, count(*) n FROM pod_votes WHERE pod_id = ? GROUP BY round ORDER BY round').all(S.pod.id);
    assert.deepEqual(ballots.map(b => [b.round, b.n]), [[1, 4], [2, 4]], 'every ballot of both rounds is a pod_votes row');
  } finally { db.close(); }
});

test('pools can be narrowed to one pod', async () => {
  const all = (await ok(eve.get('/api/pools'))).pools.find(p => p.username === 'Mike');
  const one = (await ok(eve.get(`/api/pools?pod=${S.pod.id}`))).pools.find(p => p.username === 'Mike');
  assert.ok(one.packs.length >= 1);
  assert.ok(one.packs.every(k => k.podId === S.pod.id && k.podName === 'Pod 1'));
  assert.equal(one.packs.flatMap(k => k.cards).length, all.packs.filter(k => k.podId === S.pod.id).flatMap(k => k.cards).length);
  assert.equal((await ok(eve.get('/api/pools?pod=nope'))).pools.every(p => !p.packs.length), true);
});

test('wheel odds follow per-set weights and exclusions (admin)', async () => {
  const keep = ['blb', 'lea'];
  const excluded = S.sets.map(s => s.code).filter(c => !keep.includes(c));
  const set = await ok(admin.put('/api/settings', { excluded, weights: { blb: 3 } }));
  assert.equal(set.settings.weights.blb, 3);
  const d = await ok(eve.get('/api/sets'));
  assert.deepEqual(d.wheel.map(w => w.code).sort(), keep.sort());
  assert.ok(Math.abs(d.sets.find(s => s.code === 'blb').chance - 0.75) < 1e-9, 'weight 3 vs 1 → 75%');

  // One spin per pod, so spin N throwaway pods (admin + Eve) and discard them.
  const N = 120;
  const hits = { blb: 0, lea: 0 };
  for (let i = 0; i < N; i++) {
    const { pod } = await ok(admin.post('/api/pods', { players: [{ userId: S.u.Eve.id }, { userId: S.u.Joe.id }] }));
    await ok(eve.post(`/api/pods/${pod.id}/winner`, { playerId: S.u.Eve.id }));
    hits[(await ok(eve.post(`/api/pods/${pod.id}/spin`))).spin.setCode]++;
    await ok(eve.post(`/api/pods/${pod.id}/discard`));
  }
  assert.equal(hits.blb + hits.lea, N, 'only sets on the wheel come up');
  assert.ok(hits.blb / N > 0.6 && hits.blb / N < 0.9, `blb came up ${hits.blb}/${N}, expected ~75%`);

  const filtered = await ok(admin.put('/api/settings', { excluded: [], weights: {}, minYear: 2024, maxYear: 2100 }));
  assert.equal(filtered.settings.minYear, 2024);
  const d2 = await ok(eve.get('/api/sets'));
  assert.ok(d2.wheel.every(w => d2.sets.find(s => s.code === w.code).year >= 2024), 'year filter applies');
  await ok(admin.put('/api/settings', { reset: true }));
  assert.equal((await ok(eve.get('/api/sets'))).wheel.length, S.sets.length, 'reset restores the full wheel');
});

test('discarded pods are not in history or pools', async () => {
  const { pods } = await ok(eve.get('/api/history'));
  assert.equal(pods.length, 1);
  const { pools } = await ok(eve.get('/api/pools'));
  assert.equal(pools.find(p => p.username === 'Eve').packs.length, 0);
});

test('admin can delete a single pulled card and a whole pack', async () => {
  const poolOf = async name => (await ok(eve.get(`/api/pools?pod=${S.pod.id}`))).pools.find(p => p.username === name);
  const histPod = async () => (await ok(eve.get('/api/history'))).pods.find(g => g.id === S.pod.id);

  // One card out of Mike's BLB pack.
  const mikePack = player(await histPod(), 'Mike').packs.find(k => k.status === 'opened');
  const card = mikePack.cards[0];
  assert.ok(Number.isInteger(card.id), 'pulled cards carry their pool_cards id');
  assert.equal((await mike.del(`/api/pool-cards/${card.id}`)).status, 403, 'players cannot delete pulls');
  assert.equal((await admin.del('/api/pool-cards/999999')).status, 404);
  const before = (await poolOf('Mike')).packs.flatMap(k => k.cards).length;
  const r = await ok(admin.del(`/api/pool-cards/${card.id}`));
  assert.equal(r.removed.name, card.name);
  assert.equal((await poolOf('Mike')).packs.flatMap(k => k.cards).length, before - 1, 'the card left Mike\'s pool');
  const after = player(await histPod(), 'Mike').packs.find(k => k.id === mikePack.id);
  assert.equal(after.cards.length, mikePack.cards.length - 1, 'and the pack\'s pulls in History');
  assert.ok(!after.cards.some(c => c.id === card.id));

  // Joe's whole Alpha pack.
  const joePacks = player(await histPod(), 'Joe').packs;
  const alpha = joePacks.find(k => k.set.code === 'lea');
  assert.equal((await joe.del(`/api/pods/${S.pod.id}/packs/${alpha.id}`)).status, 403, 'players cannot delete packs');
  assert.equal((await admin.del(`/api/pods/${S.pod.id}/packs/nope`)).status, 404);
  await ok(admin.del(`/api/pods/${S.pod.id}/packs/${alpha.id}`));
  assert.equal(player(await histPod(), 'Joe').packs.length, joePacks.length - 1, 'pack is gone from History');
  assert.ok(!(await poolOf('Joe')).packs.some(k => k.packId === alpha.id), 'and from Joe\'s pool');
  const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM pool_cards WHERE pack_id = ?').get(alpha.id).n, 0, 'its pool_cards rows were deleted');
    assert.equal(db.prepare('SELECT count(*) n FROM pod_packs WHERE id = ?').get(alpha.id).n, 0);
  } finally { db.close(); }
  ({ pod: S.pod } = await ok(eve.get(`/api/pods/${S.pod.id}`)));
});

test('only the admin can delete pods; history and pools follow', async () => {
  // A running pod with an opened pack, plus the finished Pod 1.
  const { pod } = await ok(eve.post('/api/pods', { players: [{ userId: S.u.Eve.id }, { userId: S.u.Joe.id }] }));
  await ok(eve.post(`/api/pods/${pod.id}/winner`, { playerId: S.u.Eve.id }));
  const spun = (await ok(eve.post(`/api/pods/${pod.id}/spin`))).pod;
  await ok(eve.post(`/api/pods/${pod.id}/packs/${spun.players[0].packs[0].id}/open`));
  assert.ok((await ok(eve.get('/api/pools'))).pools.find(p => p.username === 'Eve').packs.length === 1);

  assert.equal((await eve.del(`/api/pods/${pod.id}`)).status, 403, 'players cannot delete');
  assert.equal((await admin.del('/api/pods/nope')).status, 404);

  await ok(admin.del(`/api/pods/${pod.id}`));
  assert.equal((await ok(eve.get('/api/state'))).pods.length, 0, 'running pod is gone');
  assert.equal((await ok(eve.get('/api/pools'))).pools.find(p => p.username === 'Eve').packs.length, 0, 'its cards left the pool');

  await ok(admin.del(`/api/pods/${S.pod.id}`));
  assert.equal((await ok(eve.get('/api/history'))).pods.length, 0, 'finished pod left History');
  assert.ok((await ok(eve.get('/api/pools'))).pools.every(p => !p.packs.length && !p.pods.length), 'and every pool');

  const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'), { readOnly: true });
  try {
    for (const t of ['pod_players', 'pod_packs', 'pool_cards']) {
      const n = db.prepare(`SELECT count(*) n FROM ${t} WHERE pod_id IN (?, ?)`).get(pod.id, S.pod.id).n;
      assert.equal(n, 0, `${t} rows were deleted with their pod`);
    }
  } finally { db.close(); }
});

test('admin can clear league history; running pods stay', async () => {
  const pod = async (a, b, finish) => {
    const { pod } = await ok(eve.post('/api/pods', { players: [{ userId: S.u[a].id }, { userId: S.u[b].id }] }));
    await ok(eve.post(`/api/pods/${pod.id}/winner`, { playerId: S.u[a].id }));
    const spun = (await ok(eve.post(`/api/pods/${pod.id}/spin`))).pod;
    await ok(eve.post(`/api/pods/${pod.id}/packs/${spun.players[0].packs[0].id}/open`));
    if (finish) await ok(eve.post(`/api/pods/${pod.id}/finish`));
    return pod;
  };
  await pod('Eve', 'Joe', true);
  await pod('Eve', 'Mike', true);
  const running = await pod('Eve', 'Dan', false);
  assert.equal((await ok(eve.get('/api/history'))).pods.length, 2);

  assert.equal((await eve.del('/api/history')).status, 403, 'players cannot clear history');
  const r = await ok(admin.del('/api/history'));
  assert.ok(r.deletedPods >= 2, 'finished (and discarded) pods were deleted');
  assert.equal((await ok(eve.get('/api/history'))).pods.length, 0, 'History is empty');
  const st = await ok(eve.get('/api/state'));
  assert.deepEqual(st.pods.map(p => p.id), [running.id], 'the running pod is untouched');
  const evePool = (await ok(eve.get('/api/pools'))).pools.find(p => p.username === 'Eve');
  assert.ok(evePool.packs.length === 1 && evePool.packs.every(k => k.podId === running.id), 'pools keep only the running pod\'s cards');
  const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'), { readOnly: true });
  try {
    assert.equal(db.prepare(`SELECT count(*) n FROM pods WHERE status IN ('done','discarded')`).get().n, 0, 'the 120 discarded wheel-test pods are gone too');
  } finally { db.close(); }
});

test('logging out ends the session', async () => {
  await ok(eve.post('/api/auth/logout'));
  assert.equal((await eve.get('/api/state')).status, 401);
});
