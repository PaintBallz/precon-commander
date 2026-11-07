// End-to-end test for Pre-Con Commander. Runs INSIDE the Docker container:
//
//   docker compose exec pre-con-commander npm run e2e
//   (or, without the site running:  docker compose run --rm pre-con-commander npm run e2e)
//
// It starts a second copy of the server on its own port with a throwaway
// database in /tmp, so real league data and wheel settings are never touched,
// then plays a full league season against live Scryfall: admin first login →
// sign-ups → league + invite codes → pod → crown winner → bonus-pack vote →
// the pod's one spin (live-sync event, packs for absent members) → open
// boosters → Sacrifice a Pack → generated old + modern boosters → pools →
// copy lists → standings + feed → wheel odds → finish → history → end league.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { listText } from '../public/decklist.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 3999);
const BASE = `http://127.0.0.1:${PORT}`;
const LIVE_SCRYFALL = !process.env.SCRYFALL_BASE;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pcc-e2e-'));
let server, serverLog = '';
// A stand-in for Discord: catches the site's webhook posts.
const HOOK_PORT = PORT - 1;
const discordPosts = [];
const hookServer = http.createServer((req, res) => {
  let b = ''; req.on('data', d => { b += d; });
  req.on('end', () => { discordPosts.push({ path: req.url, body: JSON.parse(b || '{}') }); res.writeHead(204); res.end(); });
});

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
const nick = client(), mike = client(), joe = client(), dan = client(), eve = client(), fay = client(), gus = client();
const player = (pod, who) => pod.players.find(p => p.id === S.u[who].id);

before(async () => {
  await new Promise(r => hookServer.listen(HOOK_PORT, '127.0.0.1', r));
  server = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, SMTP_HOST: '', MAIL_FROM: '', CF_EMAIL_TOKEN: '',
      // The whole suite runs from one IP; the last test checks the heavy limit.
      RATE_ALL_PER_MIN: '100000', RATE_API_PER_MIN: '100000', RATE_HEAVY_PER_MIN: '200', SIGNUPS_PER_HOUR: '20', ADMIN_INITIAL_PASSWORD: 'changeme',
      DISCORD_WEBHOOK_URL: `http://127.0.0.1:${HOOK_PORT}/api/webhooks/123/test-token`, DISCORD_INVITE: 'https://discord.gg/pcctest' },
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
  hookServer.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('the browser code parses (a syntax error there breaks the whole site)', () => {
  for (const f of ['public/app.js', 'public/decklist.js']) {
    const r = spawnSync(process.execPath, ['--check', f], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('serves the app shell and assets', async () => {
  const home = await anon.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /<title>Pre-Con Commander<\/title>/);
  // Top tabs: six main ones; All Sets, History, Fun Packs and Admin under More.
  for (const t of ['sets', 'history', 'fun', 'admin']) assert.match(home.text, new RegExp(`data-tab="${t}"[^>]*data-more`), `${t} is in More`);
  for (const t of ['league', 'pods', 'wheel', 'packs', 'pools', 'trades']) assert.doesNotMatch(home.text, new RegExp(`data-tab="${t}"[^>]*data-more`), `${t} is a main tab`);
  assert.match(home.text, /id="moreBtn"[^>]*aria-haspopup="true"/);
  // Cloudflare caches .js/.css for hours, so the page must link versioned URLs.
  assert.match(home.text, /\/app\.js\?v=[0-9a-f]{10}"/, 'script URL carries a content version');
  assert.match(home.text, /\/styles\.css\?v=[0-9a-f]{10}"/, 'stylesheet URL carries a content version');
  assert.equal(home.headers.get('cache-control'), 'no-cache');
  // Can't be framed by another site (clickjacking), no MIME sniffing.
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.match(home.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await anon.get('/api/state')).headers.get('x-frame-options'), 'DENY', 'API responses too');
  for (const f of ['/app.js', '/styles.css', '/decklist.js', '/favicon.svg']) {
    assert.equal((await anon.get(f)).status, 200, `${f} should be served`);
  }
  // Legal pages are public; fonts come from this site, not Google.
  for (const f of ['/privacy', '/terms', '/fonts/barlow-400.woff2', '/fonts/OFL-Barlow.txt']) {
    assert.equal((await anon.get(f)).status, 200, `${f} should be served`);
  }
  assert.match(home.text, /href="\/privacy"/);
  assert.match((await anon.get('/terms')).text, /unofficial Fan Content permitted under the Fan Content Policy/);
  assert.doesNotMatch(home.text, /fonts\.googleapis|fonts\.gstatic/, 'no third-party font requests');
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

test('admin starts on its initial password and must change it first', async () => {
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
  assert.equal((await anon.post('/api/auth/signup', { agree: true, username: 'Nick', password: PW })).status, 400, 'email required');
  assert.equal((await anon.post('/api/auth/signup', { agree: true, username: 'Nick', email: 'not-an-email', password: PW })).status, 400);
  assert.equal((await anon.post('/api/auth/signup', { agree: true, username: 'Nick', email: 'nick@example.com', password: 'abc' })).status, 400, 'weak password');
  assert.equal((await anon.post('/api/auth/signup', { agree: true, username: 'x', email: 'x@example.com', password: PW })).status, 400, 'username too short');
  assert.equal((await anon.post('/api/auth/signup', { username: 'Nick', email: 'nick@example.com', password: PW })).status, 400, 'must confirm 13+ and accept the terms');
  for (const [name, c] of [['Nick', nick], ['Mike', mike], ['Joe', joe], ['Dan', dan], ['Eve', eve]]) {
    const { user } = await ok(c.post('/api/auth/signup', { agree: true, username: name, email: `${name.toLowerCase()}@example.com`, password: PW }));
    assert.equal(user.isAdmin, false);
    S.u[name] = user;
  }
  assert.equal((await anon.post('/api/auth/signup', { agree: true, username: 'nick', email: 'other@example.com', password: PW })).status, 409, 'usernames are unique (any case)');
  assert.equal((await anon.post('/api/auth/signup', { agree: true, username: 'Nick2', email: 'NICK@example.com', password: PW })).status, 409, 'one account per email');
  await ok(nick.put('/api/auth/profile', { precon: 'Animated Army' }));
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

test('starting a league brings in every player who is not in one', async () => {
  const before = await ok(nick.get('/api/state'));
  assert.equal(before.league, null, 'no league yet');
  assert.equal((await nick.post('/api/pods', { players: ['Nick', 'Mike', 'Joe'].map(n => ({ userId: S.u[n].id })) })).status, 409, 'pods need a league');

  const { league } = await ok(nick.post('/api/leagues', { name: 'Test League' }));
  assert.equal(league.name, 'Test League');
  assert.equal(league.status, 'active');
  assert.match(league.code, /^[A-HJ-NP-Z2-9]{6}$/, 'a 6-character invite code');
  assert.deepEqual(league.members.map(m => m.username).sort(), ['Dan', 'Eve', 'Joe', 'Mike', 'Nick'], 'every player, never the admin');
  assert.deepEqual(league.rules, { winnerPacks: 3, loserPacks: 2, absentPacks: 1, voteBonus: 1 });
  assert.deepEqual(league.limits, { min: 3, max: 16, podMin: 3, podMax: 4 });
  S.league = league.id; S.code = league.code;

  const { members } = await ok(mike.get('/api/members'));
  assert.equal(members.length, 5);
  assert.equal(JSON.stringify(members).includes('@'), false, 'member list does not expose emails');
  assert.equal(members.find(m => m.username === 'Nick').precon, 'Animated Army');
  assert.equal((await mike.post('/api/leagues', { name: 'Another' })).status, 409, 'one league at a time');
});

test('players join with the invite code; one league at a time', async () => {
  for (const [name, c] of [['Fay', fay], ['Gus', gus]]) {
    S.u[name] = (await ok(c.post('/api/auth/signup', { agree: true, username: name, email: `${name.toLowerCase()}@example.com`, password: PW }))).user;
  }
  assert.equal((await fay.post('/api/leagues/join', { code: 'ZZZZZZ' })).status, 404, 'unknown code');
  const { league } = await ok(fay.post('/api/leagues/join', { code: S.code.toLowerCase() }));
  assert.equal(league.members.length, 6, 'codes are not case-sensitive');
  assert.equal((await fay.post('/api/leagues/join', { code: S.code })).status, 409, 'already in it');
  assert.equal((await admin.post('/api/leagues/join', { code: S.code })).status, 400, 'the admin does not join leagues');

  // Gus starts his own league; nobody else is free, so it's just him.
  const gusLeague = (await ok(gus.post('/api/leagues', { name: 'Gus League' }))).league;
  assert.deepEqual(gusLeague.members.map(m => m.username), ['Gus']);
  S.gusLeague = gusLeague.id;
  assert.equal((await fay.post('/api/leagues/join', { code: gusLeague.code })).status, 409, 'Fay is already in Test League');
  assert.equal((await gus.post('/api/pods', { players: ['Gus', 'Fay', 'Eve'].map(n => ({ userId: S.u[n].id })) })).status, 400, 'pods only take members of the league');
  const peek = await ok(gus.get(`/api/leagues/${S.league}`));
  assert.equal(peek.league.code, null, 'only members (and the admin) see the code');
  assert.equal((await ok(eve.get('/api/leagues'))).leagues.length, 2);
});

test('the site admin can add and remove league members', async () => {
  assert.equal((await mike.del(`/api/leagues/${S.league}/members/${S.u.Fay.id}`)).status, 403, 'players cannot kick');
  await ok(admin.del(`/api/leagues/${S.league}/members/${S.u.Fay.id}`));
  assert.equal((await ok(fay.get('/api/state'))).league, null, 'Fay is out');
  assert.equal((await fay.post('/api/leagues/join', { code: S.code })).status, 403, 'a kicked player cannot rejoin with the code');
  const { players } = await ok(admin.get(`/api/leagues/${S.league}/candidates`));
  assert.deepEqual(players.map(p => p.username), ['Fay'], 'free players can be added');
  await ok(admin.post(`/api/leagues/${S.league}/members`, { userId: S.u.Fay.id }));
  assert.equal((await admin.post(`/api/leagues/${S.league}/members`, { userId: S.u.Gus.id })).status, 409, 'Gus is in another league');
  assert.equal((await ok(fay.get('/api/state'))).league.id, S.league);
});

test('whoever starts a league is its league admin: rules and kicking, nothing else', async () => {
  const nickView = (await ok(nick.get('/api/state'))).league;
  assert.equal(nickView.leagueAdmin.username, 'Nick');
  assert.equal(nickView.canManage, true);
  assert.equal(nickView.members.find(m => m.username === 'Nick').leagueAdmin, true);
  assert.equal((await ok(mike.get('/api/state'))).league.canManage, false);

  // Rules: yes (with the same limits as the site admin).
  assert.equal((await mike.put(`/api/leagues/${S.league}`, { rules: { winnerPacks: 9 } })).status, 403, 'other players cannot');
  assert.equal((await nick.put(`/api/leagues/${S.league}`, { rules: { winnerPacks: 99 } })).status, 400);
  const { league } = await ok(nick.put(`/api/leagues/${S.league}`, { rules: { winnerPacks: 4 } }));
  assert.equal(league.rules.winnerPacks, 4);
  assert.ok((await ok(eve.get(`/api/leagues/${S.league}`))).events.some(e => e.text.startsWith('Nick (league admin) changed the rules')));
  await ok(nick.put(`/api/leagues/${S.league}`, { rules: { winnerPacks: 3 } }));
  assert.equal((await nick.put(`/api/leagues/${S.gusLeague}`, { rules: { winnerPacks: 9 } })).status, 403, 'only their own league');

  // Kicking: yes, but not themselves, and the kicked player can't use the code to come back.
  assert.equal((await nick.del(`/api/leagues/${S.league}/members/${S.u.Nick.id}`)).status, 400);
  await ok(nick.del(`/api/leagues/${S.league}/members/${S.u.Fay.id}`));
  assert.equal((await fay.post('/api/leagues/join', { code: S.code })).status, 403);
  await ok(admin.post(`/api/leagues/${S.league}/members`, { userId: S.u.Fay.id }));

  // Everything else stays with the site admin.
  assert.equal((await nick.put(`/api/leagues/${S.league}`, { name: 'Nick Rules' })).status, 403, 'no renaming');
  assert.equal((await nick.post(`/api/leagues/${S.league}/code`)).status, 403, 'no new invite code');
  assert.equal((await nick.post(`/api/leagues/${S.league}/members`, { userId: S.u.Gus.id })).status, 403, 'no adding players');
  assert.equal((await nick.get(`/api/leagues/${S.league}/candidates`)).status, 403);
  assert.equal((await nick.put('/api/settings', { league: S.league, excluded: ['blb'] })).status, 403, 'no wheel edits');
  assert.equal((await nick.post(`/api/leagues/${S.league}/end`)).status, 403, 'no ending');
  assert.equal((await nick.del(`/api/leagues/${S.league}`)).status, 403, 'no deleting');
  assert.equal((await nick.post(`/api/pods/${'x'}/vote/skip`)).status, 403, 'no admin pod tools');
});

test('each league has its own rules', async () => {
  assert.equal((await admin.put(`/api/leagues/${S.league}`, { rules: { winnerPacks: 99 } })).status, 400);
  const { league } = await ok(gus.put(`/api/leagues/${S.gusLeague}`, { rules: { winnerPacks: 4, absentPacks: 0 } }));
  assert.equal(league.rules.winnerPacks, 4, "Gus sets his own league's rules");
  assert.equal((await ok(nick.get('/api/state'))).league.rules.winnerPacks, 3, 'other leagues keep theirs');
});

test('set list: every booster set from Scryfall, nothing else', async () => {
  const d = await ok(nick.get('/api/sets'));
  assert.equal(d.leagueId, S.league, 'the wheel is the league\'s');
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

test('only the admin can edit a league\'s wheel; each league has its own', async () => {
  assert.equal((await nick.put('/api/settings', { league: S.league, excluded: ['blb'] })).status, 403);
  assert.equal((await nick.put('/api/settings', { reset: true })).status, 403);
  await ok(admin.put('/api/settings', { league: S.gusLeague, excluded: ['blb'] }));
  assert.equal((await ok(gus.get('/api/sets'))).settings.excluded.length, 1, "Gus League's wheel changed");
  assert.equal((await ok(nick.get('/api/sets'))).settings.excluded.length, 0, "Test League's wheel did not");
});

test('pods hold 3 to 4 league members', async () => {
  const ids = names => names.map(n => ({ userId: S.u[n].id }));
  assert.equal((await nick.post('/api/pods', { players: ids(['Nick', 'Mike']) })).status, 400, 'at least 3 per pod');
  assert.equal((await nick.post('/api/pods', { players: ids(['Nick', 'Mike', 'Joe', 'Dan', 'Eve']) })).status, 400, 'max 4 per pod');
  assert.equal((await nick.post('/api/pods', { players: [...ids(['Nick', 'Mike']), { userId: 'ghost' }] })).status, 400);
  assert.equal((await nick.post('/api/pods', { players: ids(['Nick', 'Mike', 'Gus']) })).status, 400, 'Gus is not in the league');
  assert.equal((await eve.post('/api/pods', { players: ids(['Nick', 'Mike', 'Joe']) })).status, 403, 'players add themselves');
  const adminId = (await ok(admin.get('/api/auth/me'))).user.id;
  assert.equal((await admin.post('/api/pods', { league: S.league, players: [{ userId: adminId }, ...ids(['Eve', 'Fay'])] })).status, 400, 'the admin account does not play in pods');
  const { pod } = await ok(nick.post('/api/pods', { players: [...ids(['Nick']), { userId: S.u.Mike.id, precon: 'Death Toll' }, ...ids(['Joe', 'Dan'])] }));
  assert.equal(pod.status, 'playing');
  assert.equal(pod.name, 'Pod 1');
  assert.equal(pod.leagueId, S.league);
  assert.deepEqual(pod.players.map(p => [p.name, p.precon]), [['Nick', 'Animated Army'], ['Mike', 'Death Toll'], ['Joe', ''], ['Dan', '']]);
  assert.equal((await eve.post('/api/pods', { players: ids(['Eve', 'Fay', 'Nick']) })).status, 409, 'Nick is already in a pod');
  S.pod = pod;
});

test('no spin before the winner is crowned; outsiders can\'t crown', async () => {
  assert.equal((await nick.post(`/api/pods/${S.pod.id}/spin`)).status, 409);
  assert.equal((await eve.post(`/api/pods/${S.pod.id}/winner`, { playerId: S.u.Nick.id })).status, 403, 'league members outside the pod cannot crown');
});

test('winner gets 3 packs, everyone else gets 2', async () => {
  const { pod } = await ok(mike.post(`/api/pods/${S.pod.id}/winner`, { playerId: S.u.Nick.id }));
  assert.equal(pod.status, 'awarded');
  assert.deepEqual(pod.players.map(p => [p.name, p.awarded]), [['Nick', 3], ['Mike', 2], ['Joe', 2], ['Dan', 2]]);
  assert.equal(pod.vote.status, 'open', 'crowning the winner opens the bonus-pack vote');
  assert.equal(pod.vote.current.round, 1);
  assert.equal(pod.vote.current.candidates.length, 4, 'only the pod\'s players are candidates');
});

test('the pod votes for a bonus pack: pod players only, no self-votes, ties go to a re-vote', async () => {
  const url = `/api/pods/${S.pod.id}/vote`;
  const vote = (c, who) => c.post(url, { candidateId: S.u[who].id });
  assert.equal((await nick.post(`/api/pods/${S.pod.id}/spin`)).status, 409, 'no spin until the vote is decided');
  assert.equal((await vote(nick, 'Nick')).status, 400, "you can't vote for yourself");
  assert.equal((await vote(eve, 'Nick')).status, 403, 'league members outside the pod do not vote');
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

test('only the winner spins, once; league members who missed it get a pack of the spun set', async () => {
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
  await ok(admin.put('/api/settings', { league: S.league, excluded: S.sets.map(s => s.code).filter(c => !REAL.includes(c)) }));
  // A double tap sends two spins at once: exactly one may land.
  const taps = await Promise.all([nick.post(`/api/pods/${S.pod.id}/spin`), nick.post(`/api/pods/${S.pod.id}/spin`)]);
  assert.deepEqual(taps.map(t => t.status).sort(), [200, 409], 'two spins at once: one lands, one is refused');
  const { pod, spin } = taps.find(t => t.status === 200).json;
  assert.equal((await ok(nick.get(`/api/pods/${S.pod.id}`))).pod.spin.id, spin.id, 'the stored spin is the one that landed');
  await ok(admin.put('/api/settings', { league: S.league, reset: true }));
  const live = await Promise.race([gotSpin, new Promise(r => setTimeout(() => r(false), 5000))]);
  ctrl.abort();
  assert.ok(live, 'spin event reached the other device');
  assert.ok(REAL.includes(spin.setCode), 'landed on a set that is on the wheel');
  for (const p of pod.players) {
    assert.equal(p.packs.length, p.awarded, `${p.name} has all their packs`);
    assert.ok(p.packs.every(k => k.set.code === spin.setCode && k.status === 'ready' && k.source === 'wheel'), `${p.name}'s packs are all the spun set`);
  }
  assert.deepEqual(pod.absentees.map(a => a.name).sort(), ['Eve', 'Fay'], 'every league member not in the pod (never other leagues)');
  for (const a of pod.absentees) {
    assert.equal(a.packs.length, 1, `${a.name} gets one pack for the missed pod`);
    assert.equal(a.packs[0].set.code, spin.setCode, 'by default it is the spun set');
  }
  const again = await nick.post(`/api/pods/${S.pod.id}/spin`);
  assert.equal(again.status, 409, 'there is only one spin per pod');
  const fayState = await ok(fay.get('/api/state'));
  assert.equal(fayState.pending.length, 1, 'Fay sees the pack waiting for her');
  assert.equal(fayState.pending[0].absent, true);
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

test('an absent player opens their own pack (and can\'t sacrifice a single pack)', async () => {
  const evePack = S.pod.absentees.find(a => a.name === 'Eve').packs[0];
  assert.equal((await mike.post(`/api/pods/${S.pod.id}/packs/${evePack.id}/open`)).status, 403, 'not Mike\'s pack');
  assert.equal((await eve.post(`/api/pods/${S.pod.id}/packs/${evePack.id}/sacrifice`)).status, 409, 'nothing to give up');
  const { pack } = await ok(eve.post(`/api/pods/${S.pod.id}/packs/${evePack.id}/open`));
  assert.equal(pack.status, 'opened');
  assert.equal(pack.set.code, S.spin.setCode);
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

test('the foreign sets are off the list and cannot be chosen, spun or opened', async () => {
  const codes = new Set((await ok(nick.get('/api/sets'))).sets.map(x => x.code));
  for (const c of ['fbb', '4bb', 'bchr']) {
    assert.ok(!codes.has(c), `${c} is not on the set list`);
    assert.equal((await joe.post(`/api/pods/${S.pod.id}/packs/${S.joePack}/choose`, { setCode: c })).status, 400, `${c} cannot be chosen`);
    assert.equal((await joe.post('/api/fun/open', { set: c })).status, 400, `${c} cannot be opened as a fun pack`);
    assert.equal((await joe.get(`/api/fun/odds/${c}`)).status, 404);
  }
});

test('generated booster for a set with no print sheets (Jumpstart 2022): land slot, 10 commons, 3 uncommons, 1 rare', async () => {
  await ok(joe.post(`/api/pods/${S.pod.id}/packs/${S.joePack}/choose`, { setCode: 'j22' }));
  const { pack } = await ok(joe.post(`/api/pods/${S.pod.id}/packs/${S.joePack}/open`));
  assert.equal(pack.generated, true);
  assert.equal(pack.cards.length, 15);
  assert.equal(count(pack.cards, isBasic), 1, 'one basic land slot');
  assert.ok(count(pack.cards, isRareUp) >= 1);
  assert.ok(count(pack.cards, c => c.rarity === 'uncommon') >= 3);
  assert.ok(pack.cards.every(c => c.set === 'j22'));
});

test('generated booster for a modern set (Jumpstart): land slot + rare/mythic', async () => {
  assert.equal((await nick.post(`/api/pods/${S.pod.id}/award`, { playerId: S.u.Nick.id, delta: 1 })).status, 403, 'only the admin adjusts packs');
  let { pod } = await ok(admin.post(`/api/pods/${S.pod.id}/award`, { playerId: S.u.Nick.id, delta: 1 }));
  const nk = player(pod, 'Nick');
  assert.equal(nk.packs.length, 4, 'admin +1 adds a pack of the spun set');
  assert.equal(nk.packs.at(-1).set.code, S.spin.setCode);
  const k = nk.packs.find(x => x.status === 'ready');
  ({ pod } = await ok(nick.post(`/api/pods/${S.pod.id}/packs/${k.id}/sacrifice`)));
  await ok(nick.post(`/api/pods/${S.pod.id}/packs/${k.id}/choose`, { setCode: 'jmp' }));
  const { pack } = await ok(nick.post(`/api/pods/${S.pod.id}/packs/${k.id}/open`));
  assert.equal(pack.cards.length, 15);
  assert.equal(count(pack.cards, isBasic), 1, 'one basic land');
  assert.ok(count(pack.cards, isRareUp) >= 1);
  assert.ok(count(pack.cards, c => c.rarity === 'uncommon') >= 3);
});

test('double-faced cards from real boosters resolve to Scryfall numbers and images', { skip: !LIVE_SCRYFALL && 'mock Scryfall' }, async () => {
  // Midnight Hunt draft boosters always hold a double-faced card, which the
  // print sheets number "42a"; Scryfall calls it "42".
  let { pod } = await ok(admin.post(`/api/pods/${S.pod.id}/award`, { playerId: S.u.Dan.id, delta: 1 }));
  const k = player(pod, 'Dan').packs.find(x => x.status === 'ready');
  await ok(dan.post(`/api/pods/${S.pod.id}/packs/${k.id}/sacrifice`));
  await ok(dan.post(`/api/pods/${S.pod.id}/packs/${k.id}/choose`, { setCode: 'mid' }));
  const { pack } = await ok(dan.post(`/api/pods/${S.pod.id}/packs/${k.id}/open`));
  assert.equal(pack.boosterType, 'Draft Booster');
  assert.ok(pack.cards.some(c => c.back), 'the pack has a double-faced card');
  for (const c of pack.cards) {
    assert.doesNotMatch(c.number, /^\d+[a-z]$/, `${c.name} uses Scryfall's collector number`);
    assert.match(c.image, /^https:\/\/cards\.scryfall\.io\//, `${c.name} has a real image`);
  }
});

test('pools track each player\'s opened cards in the league, missed pods included', async () => {
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
  assert.equal(pool('Eve').packs.length, 1, "Eve's pack for the pod she missed");
  assert.equal(pool('Eve').packs[0].absent, true);
  assert.equal(pool('Fay').packs.length, 0, 'Fay has not opened hers yet');
  assert.equal(pool('admin'), undefined, 'the admin account is not listed in Pools');
  assert.equal(pool('Gus'), undefined, 'other leagues are not listed');
  assert.deepEqual(pool('Nick').pods.map(x => x.id), [S.pod.id], 'pools know which pod each player played');
  assert.equal(pool('Eve').pods[0].absent, true);
  assert.equal((await ok(gus.get('/api/pools'))).pools.every(p => !p.packs.length), true, "Gus League's pools are separate");
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

test('a missed pod\'s pack can still be opened after the pod is finished', async () => {
  const st = await ok(fay.get('/api/state'));
  assert.equal(st.openPods.length, 1, 'the finished pod stays reachable for Fay');
  const k = st.pending[0];
  const { pack } = await ok(fay.post(`/api/pods/${k.podId}/packs/${k.packId}/open`));
  assert.equal(pack.status, 'opened');
  assert.equal((await ok(fay.get('/api/state'))).pending.length, 0);
  assert.equal((await ok(fay.get('/api/pools'))).pools.find(p => p.username === 'Fay').packs.length, 1);
});

test('a late joiner gets catch-up packs for every pod already spun, through the invite link', async () => {
  const ivy = client();
  await ok(ivy.post('/api/auth/signup', { agree: true, username: 'Ivy', email: 'ivy@example.com', password: PW }));
  const code = (await ok(nick.get(`/api/leagues/${S.league}`))).league.code;
  const spun = [...(await ok(nick.get('/api/history'))).pods, ...(await ok(nick.get('/api/state'))).pods].filter(p => p.spin);
  const expected = spun.reduce((n, p) => n + p.rules.absentPacks, 0);
  assert.ok(spun.length && expected > 0, 'there are spun pods to catch up on');

  // The invite page says what joining brings.
  assert.equal((await ivy.get('/api/leagues/invite/ZZZZZZ')).status, 404);
  const invite = await ok(ivy.get(`/api/leagues/invite/${code.toLowerCase()}`));
  assert.equal(invite.league.id, S.league);
  assert.equal(invite.catchUpPacks, expected);
  assert.equal((await ok(nick.get(`/api/leagues/invite/${code}`))).catchUpPacks, 0, 'a member who played or missed every pod has nothing to catch up');

  const r = await ok(ivy.post('/api/leagues/join', { code }));
  assert.deepEqual(r.catchUp, { pods: spun.length, packs: expected });
  const st = await ok(ivy.get('/api/state'));
  assert.equal(st.pending.length, expected, 'the catch-up packs are waiting');
  assert.ok(st.pending.every(k => k.catchup && k.absent), 'labelled as catch-up');
  const pod = await ok(ivy.get(`/api/pods/${st.pending[0].podId}`));
  assert.equal(pod.pod.absentees.find(a => a.id === st.pending[0] && false) ?? pod.pod.absentees.find(a => a.name === 'Ivy').packs[0].set.code, pod.pod.spin.set.code, 'each pack is that pod\'s spun set');
  const { pack } = await ok(ivy.post(`/api/pods/${st.pending[0].podId}/packs/${st.pending[0].packId}/open`));
  assert.equal(pack.status, 'opened');
  const ivyRow = (await ok(nick.get(`/api/leagues/${S.league}`))).standings.find(s => s.name === 'Ivy');
  assert.deepEqual([ivyRow.pods, ivyRow.missed, ivyRow.packs], [0, 0, 1], 'catch-up pods don\'t count as missed');
  assert.ok((await ok(nick.get(`/api/leagues/${S.league}`))).events.some(e => /Ivy joined with the invite code and gets \d+ catch-up packs? for the \d+ pods? played before they joined/.test(e.text)));

  // Leaving and coming back doesn't hand out the same packs twice.
  await ok(ivy.post(`/api/leagues/${S.league}/leave`));
  assert.deepEqual((await ok(ivy.post('/api/leagues/join', { code }))).catchUp, { pods: 0, packs: 0 });
  await ok(ivy.post('/api/auth/delete', { password: PW })); // keep the later member counts as they were
});

test('league standings and activity feed', async () => {
  const { standings, events } = await ok(eve.get(`/api/leagues/${S.league}`));
  const row = name => standings.find(s => s.name === name);
  assert.equal(standings[0].name, 'Nick', 'the winner leads');
  assert.deepEqual([row('Nick').pods, row('Nick').wins], [1, 1]);
  assert.equal(row('Mike').voteWins, 1);
  assert.equal(row('Eve').missed, 1);
  assert.equal(row('Fay').missed, 1);
  assert.equal(row('Eve').packs, 1, 'missed-pod packs count as opened packs');
  const text = events.map(e => e.text).join('\n');
  for (const bit of ['started Test League', 'joined with the invite code', 'Pod 1 started', 'won Pod 1', "won Pod 1's bonus-pack vote", 'Pod 1 spun', 'Eve and Fay missed it', 'Pod 1 finished']) {
    assert.ok(text.includes(bit), `feed mentions "${bit}"`);
  }
});

test('player pages: stats, rivals and pulls for one league or all of them', async () => {
  const d = await ok(eve.get(`/api/players/${S.u.Nick.id}?league=${S.league}`));
  assert.equal(d.player.username, 'Nick');
  assert.equal(d.league.id, S.league);
  assert.equal(d.league.rank, 1, 'Nick leads the league');
  const t = d.stats.totals;
  assert.deepEqual([t.pods, t.wins, t.streak.best, t.streak.current], [1, 1, 1, 1]);
  assert.ok(t.packs >= 1 && t.cards >= 10, 'opened packs and cards counted');
  assert.deepEqual(d.stats.form, [true]);
  assert.equal(d.stats.nemesis, null, 'nobody has beaten Nick');
  assert.ok(d.stats.prey, 'someone was at the table when Nick won');
  assert.ok(d.stats.opponents.some(o => o.id === S.u.Mike.id && o.pods === 1 && o.myWins === 1 && o.theirWins === 0));
  assert.ok(d.stats.bestPulls.every(c => c.name && c.image), 'best pulls carry card images');
  assert.ok(d.stats.recent[0].won);
  const mike = await ok(nick.get(`/api/players/${S.u.Mike.id}?league=${S.league}`));
  assert.equal(mike.stats.nemesis.id, S.u.Nick.id, "Nick is Mike's nemesis");
  assert.equal(mike.stats.totals.voteWins, 1);
  const eveP = await ok(nick.get(`/api/players/${S.u.Eve.id}?league=all`));
  assert.equal(eveP.league, null, 'all leagues combined');
  assert.equal(eveP.stats.totals.missed, 1);
  const adminId = (await ok(admin.get('/api/auth/me'))).user.id;
  assert.equal((await nick.get(`/api/players/${adminId}`)).status, 404, 'the admin has no player page');
  assert.equal((await nick.get('/api/players/nope')).status, 404);
  assert.equal((await anon.get(`/api/players/${S.u.Nick.id}`)).status, 401);
});

test('season recap: champion, awards, totals and standings', async () => {
  const r = await ok(joe.get(`/api/leagues/${S.league}/recap`));
  assert.equal(r.league.id, S.league);
  assert.equal(r.champion.name, 'Nick');
  assert.equal(r.totals.pods, 1);
  assert.equal(r.totals.packs, r.standings.reduce((n, x) => n + x.packs, 0), 'every opened pack in the league counts');
  assert.ok(r.totals.cards > r.totals.packs);
  const award = key => r.awards.find(a => a.key === key);
  assert.deepEqual(award('wins').winners.map(w => w.name), ['Nick']);
  assert.deepEqual(award('vote').winners.map(w => w.name), ['Mike']);
  assert.ok(award('iron').winners.length >= 3, 'ties share an award');
  assert.ok(!r.awards.some(a => a.key === 'streak'), 'no streak award for a single win');
  assert.equal(r.standings[0].name, 'Nick');
  assert.doesNotMatch(JSON.stringify(r), /usd|price|"value":\d/i, 'no prices or card values');
  assert.equal(r.spun[0].times, 1);
  assert.equal((await joe.get('/api/leagues/nope/recap')).status, 404);
});

test('deck lists: pasted or linked, looked up on Scryfall, shown on the player page', { skip: !LIVE_SCRYFALL && 'mock Scryfall' }, async () => {
  assert.equal((await joe.post('/api/deck', { url: 'https://example.com/decks/abc' })).status, 400, 'only Moxfield and Archidekt links');
  assert.equal((await joe.post('/api/deck', { url: 'http://127.0.0.1/decks/1' })).status, 400);
  assert.equal((await joe.post('/api/deck', {})).status, 400, 'needs a link or a list');
  const text = "1 Sol Ring (C21) 263\n2x Command Tower\n1 Arcane Signet (C21) 1\n1 Not A Real Card Name\n\n1 Atraxa, Praetors' Voice";
  const { deck } = await ok(joe.post('/api/deck', { text }));
  assert.equal(deck.count, 5, 'quantities add up (the unknown card is left out)');
  assert.deepEqual(deck.missing, ['Not A Real Card Name']);
  assert.deepEqual(deck.commanders, ["Atraxa, Praetors' Voice"], 'a trailing legendary is the commander');
  assert.equal(deck.name, "Atraxa, Praetors' Voice");
  assert.deepEqual(deck.colors, ['W', 'U', 'B', 'G']);
  assert.ok(deck.cards.some(c => c.name === 'Arcane Signet'), 'a wrong collector number still finds the named card');
  const sol = deck.cards.find(c => c.name === 'Sol Ring');
  assert.deepEqual([sol.set, sol.number, sol.cmc, sol.mana], ['c21', '263', 1, '{1}']);
  assert.ok(sol.image.startsWith('https://'));
  assert.equal((await ok(joe.get('/api/auth/me'))).user.precon, "Atraxa, Praetors' Voice", 'a blank precon picks up the deck name');
  const renamed = (await ok(joe.put('/api/deck', { name: 'Four Color Counters', commanders: [] }))).deck;
  assert.equal(renamed.name, 'Four Color Counters');
  assert.deepEqual(renamed.commanders, []);
  const page = await ok(nick.get(`/api/players/${S.u.Joe.id}`));
  assert.equal(page.deck.name, 'Four Color Counters', 'others see the deck');
  await ok(joe.del('/api/deck'));
  assert.equal((await ok(joe.get('/api/deck'))).deck, null);
  const again = (await ok(joe.post('/api/deck', { text: "Commander\n1 Atraxa, Praetors' Voice\nDeck\n1 Sol Ring" }))).deck;
  assert.deepEqual(again.commanders, ["Atraxa, Praetors' Voice"], 'a "Commander" section marks the commander');
});

test('admin log: a deleted card is kept for undo and comes back exactly', async () => {
  assert.equal((await nick.get('/api/admin/log')).status, 403, 'players can\'t read the admin log');
  const pool = (await ok(nick.get('/api/pools'))).pools.find(p => p.username === 'Nick');
  const card = pool.packs[0].cards[0];
  await ok(admin.del(`/api/pool-cards/${card.id}`));
  const has = async id => (await ok(nick.get('/api/pools'))).pools.find(p => p.username === 'Nick').packs.some(k => k.cards.some(c => c.id === id));
  assert.equal(await has(card.id), false);
  const entry = (await ok(admin.get('/api/admin/log'))).entries.find(e => e.summary.includes(card.name) && e.canUndo);
  assert.ok(entry, 'the delete is in the log with Undo');
  assert.equal((await nick.post(`/api/admin/log/${entry.id}/undo`)).status, 403);
  await ok(admin.post(`/api/admin/log/${entry.id}/undo`));
  assert.equal(await has(card.id), true, 'same card, same id, back in the pool');
  assert.equal((await admin.post(`/api/admin/log/${entry.id}/undo`)).status, 409, 'only once');
  assert.ok((await ok(admin.get('/api/admin/log'))).entries.some(e => e.summary.startsWith('Undid:')));
});

test('pack manager: give packs (a set, the wheel, their choice), open them, take back, undo', async () => {
  const set = S.sets.find(s => s.realPack) || S.sets[0];
  const standing = async name => (await ok(eve.get(`/api/leagues/${S.league}`))).standings.find(s => s.name === name);
  const historyBefore = (await ok(nick.get('/api/history'))).pods.length;
  const mikeBefore = await standing('Mike');
  assert.equal((await nick.post('/api/admin/grants', { league: S.league, userIds: [S.u.Mike.id], mode: 'set', setCode: set.code })).status, 403);
  assert.equal((await admin.post('/api/admin/grants', { league: S.league, userIds: [S.u.Gus.id], mode: 'set', setCode: set.code })).status, 400, 'only league members');
  assert.equal((await admin.post('/api/admin/grants', { league: S.league, userIds: [S.u.Mike.id], count: 11, mode: 'set', setCode: set.code })).status, 400);
  const g = await ok(admin.post('/api/admin/grants', { league: S.league, userIds: [S.u.Mike.id, S.u.Eve.id], count: 2, mode: 'set', setCode: set.code, reason: 'league prize' }));
  assert.equal(g.packIds.length, 4);
  const pending = (await ok(mike.get('/api/state'))).pending.filter(k => k.grant);
  assert.equal(pending.length, 2, 'Mike sees his two packs waiting');
  assert.equal(pending[0].note, 'league prize');
  const { pack } = await ok(mike.post(`/api/pods/${pending[0].podId}/packs/${pending[0].packId}/open`));
  assert.ok(pack.cards.length >= 10, 'opens like any pack');
  const mikeAfter = await standing('Mike');
  assert.equal(mikeAfter.pods, mikeBefore.pods, 'not counted as a pod played');
  assert.equal(mikeAfter.packs, mikeBefore.packs + 1, 'counted as an opened pack');
  assert.equal((await ok(nick.get('/api/history'))).pods.length, historyBefore, 'History is unchanged');
  assert.ok((await ok(mike.get('/api/pools'))).pools.find(p => p.username === 'Mike').packs.some(k => k.kind === 'grant'), 'the pulls are in his pool');
  const feed = (await ok(nick.get(`/api/leagues/${S.league}`))).events.map(e => e.text).join('\n');
  assert.match(feed, /The admin gave Mike and Eve 2 .+ packs each \(league prize\)\./);
  // Take one back, then undo it.
  await ok(admin.del(`/api/pods/${pending[1].podId}/packs/${pending[1].packId}`));
  assert.equal((await ok(mike.get('/api/state'))).pending.filter(k => k.grant).length, 0);
  const took = (await ok(admin.get('/api/admin/log'))).entries.find(e => e.summary.startsWith("Took Mike's unopened"));
  await ok(admin.post(`/api/admin/log/${took.id}/undo`));
  assert.equal((await ok(mike.get('/api/state'))).pending.filter(k => k.grant).length, 1, 'the pack is back');
  // Their choice: the player picks the set.
  await ok(admin.post('/api/admin/grants', { league: S.league, userIds: [S.u.Fay.id], mode: 'choice' }));
  const choice = (await ok(fay.get('/api/state'))).pending.find(k => k.grant);
  assert.equal(choice.status, 'choosing');
  await ok(fay.post(`/api/pods/${choice.podId}/packs/${choice.packId}/choose`, { setCode: set.code }));
  assert.equal((await ok(fay.get('/api/state'))).pending.find(k => k.packId === choice.packId).status, 'ready');
  // The wheel: one spin of the league's wheel.
  const w = await ok(admin.post('/api/admin/grants', { league: S.league, userIds: [S.u.Dan.id], mode: 'wheel' }));
  assert.ok(w.set?.code, 'the wheel picked a set');
  const wheelGrant = (await ok(admin.get('/api/admin/log'))).entries.find(e => e.summary.includes('spun on the wheel'));
  await ok(admin.post(`/api/admin/log/${wheelGrant.id}/undo`));
  assert.equal((await ok(dan.get('/api/state'))).pending.filter(k => k.grant).length, 0, 'undoing a grant removes its unopened packs');
  const unopened = await ok(admin.get(`/api/admin/packs?league=${S.league}`));
  assert.ok(unopened.players.find(p => p.username === 'Eve').packs.length >= 2, 'the admin sees every unopened pack');
});

test('move a card to another player\'s pool, and undo', async () => {
  const pools = async () => (await ok(nick.get('/api/pools'))).pools;
  const card = (await pools()).find(p => p.username === 'Nick').packs.find(k => !k.kind).cards[0];
  const danPacks = (await ok(eve.get(`/api/leagues/${S.league}`))).standings.find(s => s.name === 'Dan').packs;
  assert.equal((await admin.post(`/api/admin/pool-cards/${card.id}/move`, { toUserId: S.u.Nick.id })).status, 400, 'already theirs');
  assert.equal((await admin.post(`/api/admin/pool-cards/${card.id}/move`, { toUserId: S.u.Gus.id })).status, 400, 'same league only');
  await ok(admin.post(`/api/admin/pool-cards/${card.id}/move`, { toUserId: S.u.Dan.id, reason: 'trade' }));
  let p = await pools();
  assert.ok(!p.find(x => x.username === 'Nick').packs.some(k => k.cards.some(c => c.id === card.id)), 'gone from Nick\'s pool');
  const moved = p.find(x => x.username === 'Dan').packs.find(k => k.cards.some(c => c.id === card.id));
  assert.equal(moved.kind, 'trade');
  assert.match(moved.note, /From Nick \(trade\)/);
  assert.equal((await ok(eve.get(`/api/leagues/${S.league}`))).standings.find(s => s.name === 'Dan').packs, danPacks, 'a moved card isn\'t an opened pack');
  const entry = (await ok(admin.get('/api/admin/log'))).entries.find(e => e.summary.startsWith(`The admin moved ${card.name}`));
  await ok(admin.post(`/api/admin/log/${entry.id}/undo`));
  p = await pools();
  assert.ok(p.find(x => x.username === 'Nick').packs.some(k => k.cards.some(c => c.id === card.id)), 'back with Nick');
});

test('trades: one-way offers, counters with more cards, held cards, accept moves the cards', async () => {
  const pools = async () => (await ok(nick.get('/api/pools'))).pools;
  const cardsOf = (p, name) => p.find(x => x.username === name).packs.flatMap(k => k.cards);
  let p = await pools();
  const [n1, n2, n3] = cardsOf(p, 'Nick');
  const [d1, d2, d3] = cardsOf(p, 'Dan');
  assert.ok(n3 && d3, 'both have cards to trade');
  const nickPacks = (await ok(eve.get(`/api/leagues/${S.league}`))).standings.find(s => s.name === 'Nick').packs;

  // Rules for an offer.
  assert.equal((await nick.post('/api/trades', { to: S.u.Dan.id })).status, 400, 'needs a card');
  assert.equal((await nick.post('/api/trades', { to: S.u.Nick.id, give: [n1.id] })).status, 400, 'not with yourself');
  assert.equal((await nick.post('/api/trades', { to: S.u.Gus.id, give: [n1.id] })).status, 400, 'same league only');
  assert.equal((await nick.post('/api/trades', { to: S.u.Dan.id, give: [d1.id] })).status, 409, 'can only give your own cards');
  assert.equal((await nick.post('/api/trades', { to: S.u.Dan.id, get: [n1.id] })).status, 409, 'can only ask for theirs');
  assert.equal((await admin.post('/api/trades', { league: S.league, to: S.u.Dan.id, get: [d1.id] })).status, 403, 'the admin doesn\'t trade');

  // Nick offers 1 card for 1; Dan sees it as his turn, Nick as waiting.
  const { trade } = await ok(nick.post('/api/trades', { to: S.u.Dan.id, give: [n1.id], get: [d1.id], note: 'straight swap?' }));
  assert.equal(trade.turn, 'them');
  assert.equal((await ok(dan.get('/api/state'))).tradesWaiting, 1, 'badge count');
  let danView = (await ok(dan.get('/api/trades'))).trades.find(t => t.id === trade.id);
  assert.equal(danView.turn, 'me');
  assert.equal(danView.offers[0].note, 'straight swap?');
  assert.equal((await nick.post(`/api/trades/${trade.id}/accept`)).status, 409, 'the sender can\'t accept their own offer');
  assert.equal((await nick.post(`/api/trades/${trade.id}/counter`, { give: [n1.id] })).status, 409, 'not Nick\'s turn');

  // Nick's n1 is held while the offer waits.
  assert.deepEqual((await ok(nick.get('/api/trades'))).held, [n1.id]);
  assert.equal((await nick.post('/api/trades', { to: S.u.Mike.id, give: [n1.id] })).status, 409, 'a held card can\'t go into a second offer');

  // Dan counters, asking for more: 1 of his for 3 of Nick's (not 1 on 1).
  await ok(dan.post(`/api/trades/${trade.id}/counter`, { give: [d1.id], get: [n1.id, n2.id, n3.id], note: 'make it 3' }));
  assert.deepEqual((await ok(nick.get('/api/trades'))).held, [], 'Nick\'s card is free again once it\'s his turn');
  let nickView = (await ok(nick.get('/api/trades'))).trades.find(t => t.id === trade.id);
  assert.equal(nickView.turn, 'me');
  assert.equal(nickView.offers.length, 2, 'every round is kept');
  assert.deepEqual(nickView.offers[1].cards.filter(c => c.side === 'get').map(c => c.id).sort(), [n1.id, n2.id, n3.id].sort());

  // A second open offer that includes n2 gets closed when the trade goes through.
  const { trade: other } = await ok(mike.post('/api/trades', { to: S.u.Nick.id, get: [n2.id] }));
  await ok(nick.post(`/api/trades/${trade.id}/accept`));
  p = await pools();
  const nickNow = cardsOf(p, 'Nick').map(c => c.id), danNow = cardsOf(p, 'Dan').map(c => c.id);
  assert.ok([n1, n2, n3].every(c => danNow.includes(c.id) && !nickNow.includes(c.id)), 'Nick\'s three cards are Dan\'s');
  assert.ok(nickNow.includes(d1.id) && !danNow.includes(d1.id), 'Dan\'s card is Nick\'s');
  const tradePack = p.find(x => x.username === 'Nick').packs.find(k => k.cards.some(c => c.id === d1.id));
  assert.equal(tradePack.kind, 'trade');
  assert.match(tradePack.note, /Traded with Dan/);
  assert.equal((await ok(eve.get(`/api/leagues/${S.league}`))).standings.find(s => s.name === 'Nick').packs, nickPacks, 'traded cards aren\'t packs opened');
  const mikeOther = (await ok(mike.get('/api/trades'))).trades.find(t => t.id === other.id);
  assert.equal(mikeOther.status, 'closed');
  assert.match(mikeOther.closeNote, /traded away/);
  const feed = (await ok(eve.get(`/api/leagues/${S.league}`))).events;
  assert.ok(feed.some(e => e.kind === 'trade' && /Dan traded .* to Nick for /.test(e.text)), 'the trade is in the feed');
  await new Promise(r => setTimeout(r, 300));
  assert.ok(discordPosts.some(x => x.body.embeds?.[0]?.title?.includes('Trade')), 'and posted to Discord');
  const done = (await ok(dan.get('/api/trades'))).trades.find(t => t.id === trade.id);
  assert.equal(done.status, 'accepted');
  assert.deepEqual([(await dan.post(`/api/trades/${trade.id}/accept`)).status, (await nick.post(`/api/trades/${trade.id}/cancel`)).status], [409, 409], 'a finished trade stays finished');

  // An offer with a card that left its pool can't be accepted.
  const [d4] = cardsOf(p, 'Dan').filter(c => ![n1.id, n2.id, n3.id].includes(c.id));
  const { trade: stale } = await ok(dan.post('/api/trades', { to: S.u.Nick.id, give: [d4.id] }));
  await ok(admin.post(`/api/admin/pool-cards/${d4.id}/move`, { toUserId: S.u.Eve.id }));
  const staleView = (await ok(nick.get('/api/trades'))).trades.find(t => t.id === stale.id);
  assert.deepEqual(staleView.missing, [d4.id]);
  assert.equal((await nick.post(`/api/trades/${stale.id}/accept`)).status, 409);
  await ok(nick.post(`/api/trades/${stale.id}/decline`));
  const moveEntry = (await ok(admin.get('/api/admin/log'))).entries.find(e => e.summary.startsWith(`The admin moved ${d4.name}`));
  await ok(admin.post(`/api/admin/log/${moveEntry.id}/undo`)); // keep Eve's pool as the later tests expect
  assert.equal((await ok(dan.get('/api/trades'))).trades.find(t => t.id === stale.id).status, 'declined');

  // Cancelling your own offer; one left open for the league-end test.
  const { trade: c1 } = await ok(joe.post('/api/trades', { to: S.u.Nick.id, get: [d1.id] }));
  assert.equal((await joe.post(`/api/trades/${c1.id}/decline`)).status, 409, 'the sender cancels rather than declines');
  await ok(joe.post(`/api/trades/${c1.id}/cancel`));
  S.openTrade = (await ok(joe.post('/api/trades', { to: S.u.Nick.id, get: [d1.id] }))).trade.id;
});

test('fix a finished pod: winner, precons and who sat in a seat; undo restores it', async () => {
  const hal = client();
  S.u.Hal = (await ok(hal.post('/api/auth/signup', { agree: true, username: 'Hal', email: 'hal@example.com', password: PW }))).user;
  S.hal = hal;
  await ok(admin.post(`/api/leagues/${S.league}/members`, { userId: S.u.Hal.id }));
  const row = async name => (await ok(eve.get(`/api/leagues/${S.league}`))).standings.find(s => s.name === name) || { wins: 0, packs: 0 };
  const [nickWins, mikeWins, fayPacks] = [(await row('Nick')).wins, (await row('Mike')).wins, (await row('Fay')).packs];
  assert.equal((await nick.put(`/api/admin/pods/${S.pod.id}`, { winnerId: S.u.Mike.id })).status, 403);
  assert.equal((await admin.put(`/api/admin/pods/${S.pod.id}`, { winnerId: S.u.Eve.id })).status, 400, 'the winner must have played');
  assert.equal((await admin.put(`/api/admin/pods/${S.pod.id}`, { swap: { from: S.u.Fay.id, to: S.u.Joe.id } })).status, 409, 'not someone already in the pod');
  await ok(admin.put(`/api/admin/pods/${S.pod.id}`, { winnerId: S.u.Mike.id, precons: { [S.u.Mike.id]: 'Fixed Precon' }, swap: { from: S.u.Fay.id, to: S.u.Hal.id }, reason: 'scorekeeping' }));
  assert.equal((await row('Nick')).wins, nickWins - 1, 'standings follow');
  assert.equal((await row('Mike')).wins, mikeWins + 1);
  const { pod } = await ok(nick.get(`/api/pods/${S.pod.id}`));
  assert.equal(pod.winnerId, S.u.Mike.id);
  assert.equal(pod.players.find(p => p.id === S.u.Mike.id).precon, 'Fixed Precon');
  assert.ok(pod.absentees.some(a => a.id === S.u.Hal.id && a.name === 'Hal') && !pod.absentees.some(a => a.id === S.u.Fay.id), 'Fay\'s seat is Hal\'s now');
  assert.equal((await row('Hal')).packs, 1, 'with its pack');
  assert.match((await ok(nick.get(`/api/leagues/${S.league}`))).events[0].text, /The admin fixed Pod 1: winner is now Mike.+\(scorekeeping\)/);
  const entry = (await ok(admin.get('/api/admin/log'))).entries.find(e => e.summary.startsWith('The admin fixed Pod 1'));
  await ok(admin.post(`/api/admin/log/${entry.id}/undo`));
  const back = (await ok(nick.get(`/api/pods/${S.pod.id}`))).pod;
  assert.equal(back.winnerId, S.u.Nick.id, 'undo puts the old pod back');
  assert.ok(back.absentees.some(a => a.id === S.u.Fay.id));
  assert.equal((await row('Fay')).packs, fayPacks);
  await ok(admin.del(`/api/leagues/${S.league}/members/${S.u.Hal.id}`));
});

test('player tools: rename, suspend, sign out everywhere, view as (read-only)', async () => {
  const hal = S.hal;
  await ok(admin.put(`/api/admin/users/${S.u.Hal.id}`, { username: 'Halbert' }));
  assert.equal((await ok(hal.get('/api/auth/me'))).user.username, 'Halbert');
  assert.equal((await admin.put(`/api/admin/users/${S.u.Hal.id}`, { username: 'Nick' })).status, 409, 'names stay unique');
  const rename = (await ok(admin.get('/api/admin/log'))).entries.find(e => e.summary === 'Renamed Hal to Halbert.');
  await ok(admin.post(`/api/admin/log/${rename.id}/undo`));
  assert.equal((await ok(hal.get('/api/auth/me'))).user.username, 'Hal');

  await ok(admin.post(`/api/admin/users/${S.u.Hal.id}/suspend`, { suspended: true, reason: 'cooling off' }));
  assert.equal((await hal.get('/api/state')).status, 401, 'signed out at once');
  const refused = await hal.post('/api/auth/login', { username: 'Hal', password: PW });
  assert.equal(refused.status, 403);
  assert.match(refused.json.error, /suspended: cooling off/);
  assert.ok((await ok(admin.get('/api/admin/users'))).users.find(u => u.username === 'Hal').suspended);
  await ok(admin.post(`/api/admin/users/${S.u.Hal.id}/suspend`, { suspended: false }));
  await ok(hal.post('/api/auth/login', { username: 'Hal', password: PW }));
  await ok(admin.post(`/api/admin/users/${S.u.Hal.id}/signout`));
  assert.equal((await hal.get('/api/state')).status, 401, 'signed out everywhere');

  await ok(admin.post(`/api/admin/view-as/${S.u.Nick.id}`));
  const me = await ok(admin.get('/api/auth/me'));
  assert.equal(me.user.username, 'Nick');
  assert.ok(me.viewAs?.admin);
  assert.equal((await ok(admin.get('/api/state'))).me.username, 'Nick', 'the site answers as Nick');
  const blocked = await admin.post('/api/pods', { players: [] });
  assert.equal(blocked.status, 403);
  assert.ok(blocked.json.viewAs, 'nothing can be changed while viewing');
  assert.equal((await admin.get('/api/admin/overview')).status, 403, 'and admin tools are off');
  await ok(admin.post('/api/admin/view-as/stop'));
  assert.ok((await ok(admin.get('/api/auth/me'))).user.isAdmin, 'back to the admin');
  assert.equal((await nick.post(`/api/admin/view-as/${S.u.Mike.id}`)).status, 403);
  await ok(admin.del(`/api/admin/users/${S.u.Hal.id}`)); // keep later league tests' player counts as they were
  assert.ok((await ok(admin.get('/api/admin/log'))).entries.some(e => e.summary === "Deleted Hal's account (can't be undone)." && !e.canUndo));
});

test('a player can be made an admin and keeps playing; admins fill a league to 4 with test players', async () => {
  // Lex plays in Gus's league.
  const lex = client();
  S.u.Lex = (await ok(lex.post('/api/auth/signup', { agree: true, username: 'Lex', email: 'lex@example.com', password: PW }))).user;
  await ok(admin.post(`/api/leagues/${S.gusLeague}/members`, { userId: S.u.Lex.id }));
  assert.equal((await lex.get('/api/admin/overview')).status, 403, 'not an admin yet');
  assert.equal((await nick.post(`/api/admin/users/${S.u.Lex.id}/admin`)).status, 403, 'only admins');

  // The main admin makes Lex an admin; Lex keeps playing.
  await ok(admin.post(`/api/admin/users/${S.u.Lex.id}/admin`, { admin: true }));
  const me = (await ok(lex.get('/api/auth/me'))).user;
  assert.deepEqual([me.isAdmin, me.adminAccount, me.staff], [true, false, true]);
  await ok(lex.get('/api/admin/overview'));
  const st = await ok(lex.get('/api/state'));
  assert.equal(st.myLeagueId, S.gusLeague, 'still in the league');
  assert.ok(st.members.some(m => m.id === S.u.Lex.id), 'still listed as a player');
  assert.ok((await ok(lex.get(`/api/trades?league=${S.gusLeague}`))).canTrade, 'and can trade');

  // What only the main admin account can do.
  const adminId = (await ok(admin.get('/api/auth/me'))).user.id;
  assert.equal((await lex.post(`/api/admin/users/${S.u.Nick.id}/admin`)).status, 403, 'can\'t make more admins');
  assert.equal((await lex.post(`/api/admin/users/${adminId}/reset-link`)).status, 403, 'can\'t get into the main admin account');
  assert.equal((await lex.del(`/api/admin/users/${adminId}`)).status, 409);
  assert.equal((await lex.post(`/api/admin/users/${adminId}/signout`)).status, 403);
  assert.equal((await lex.put(`/api/admin/users/${adminId}`, { username: 'boss' })).status, 403);

  // Fill Gus's league (Gus and Lex) to 4 with test players.
  const r = await ok(lex.post(`/api/leagues/${S.gusLeague}/test-players`));
  assert.equal(r.added.length, 2);
  assert.ok(r.added.every(n => /^TestBot\d+$/.test(n)));
  assert.equal(r.league.members.length, 4);
  assert.ok(r.league.members.filter(m => m.test).length === 2 && r.league.members.find(m => m.id === S.u.Lex.id).admin);
  assert.equal((await lex.post(`/api/leagues/${S.gusLeague}/test-players`)).status, 409, 'already 4');
  assert.equal((await gus.post(`/api/leagues/${S.gusLeague}/test-players`)).status, 403, 'admins only');
  assert.equal((await anon.post('/api/auth/login', { username: r.added[0], password: 'whatever1' })).status, 401, 'test players can\'t sign in');
  // An admin plays for them: a pod with two test players.
  const bots = r.league.members.filter(m => m.test);
  const { pod } = await ok(lex.post('/api/pods', { league: S.gusLeague, players: [S.u.Gus.id, ...bots.map(b => b.id)].map(userId => ({ userId })) }));
  let p = (await ok(lex.post(`/api/pods/${pod.id}/winner`, { playerId: bots[0].id }))).pod;
  // Test players vote by themselves; the vote waits only on Gus.
  assert.equal(p.vote.status, 'open');
  assert.deepEqual([...p.vote.current.voted].sort(), bots.map(b => b.id).sort(), 'both test players voted right away');
  for (let i = 0; i < 10 && p.vote.status === 'open'; i++) {
    assert.ok(!p.vote.current.voted.includes(S.u.Gus.id), 'each round opens with the test players already voted');
    const pick = p.vote.current.candidates.find(c => c !== S.u.Gus.id);
    p = (await ok(gus.post(`/api/pods/${pod.id}/vote`, { candidateId: pick }))).pod;
  }
  assert.equal(p.vote.status, 'done', 'Gus\'s vote finishes it (test players re-vote on a tie)');
  assert.equal((await lex.del(`/api/leagues/${S.gusLeague}/test-players`)).status, 409, 'not while they\'re in a running pod');
  await ok(lex.post(`/api/pods/${pod.id}/discard`));
  const gone = await ok(lex.del(`/api/leagues/${S.gusLeague}/test-players`));
  assert.equal(gone.removed.length, 2);
  assert.equal(gone.league.members.length, 2);

  // Taking admin away signs Lex out; then Lex's account goes so later member counts hold.
  await ok(admin.post(`/api/admin/users/${S.u.Lex.id}/admin`, { admin: false }));
  assert.equal((await lex.get('/api/admin/overview')).status, 401);
  await ok(admin.del(`/api/admin/users/${S.u.Lex.id}`));
});

test('announcement, dashboard and backups', async () => {
  assert.equal((await nick.put('/api/admin/announcement', { text: 'hi' })).status, 403);
  await ok(admin.put('/api/admin/announcement', { text: 'Pod night Friday at 7pm!' }));
  assert.equal((await ok(nick.get('/api/state'))).announcement.text, 'Pod night Friday at 7pm!');
  await ok(admin.put('/api/admin/announcement', { text: 'Old news', until: '2020-01-01' }));
  assert.equal((await ok(nick.get('/api/state'))).announcement, null, 'past its end date');
  await ok(admin.put('/api/admin/announcement', { text: '' }));

  const o = await ok(admin.get('/api/admin/overview'));
  assert.ok(o.counts.players >= 5 && o.counts.activeLeagues >= 1);
  assert.equal(o.email.enabled, false);
  assert.ok('refused24h' in o.limits && o.log.length);
  assert.equal((await nick.get('/api/admin/overview')).status, 403);

  assert.equal((await nick.post('/api/admin/backups')).status, 403);
  const { backup } = await ok(admin.post('/api/admin/backups'));
  assert.match(backup.name, /^app-manual-\d{4}-\d{2}-\d{2}-\d{6}\.db$/);
  const file = await admin.get(`/api/admin/backups/${backup.name}`);
  assert.equal(file.status, 200);
  assert.ok(file.text.startsWith('SQLite format 3'), 'a real database file');
  assert.equal((await admin.get('/api/admin/backups/..%2Fapp.db')).status, 404, 'no paths');
  assert.equal((await nick.get(`/api/admin/backups/${backup.name}`)).status, 403);
  assert.ok((await ok(admin.get('/api/admin/backups'))).backups.some(b => b.name === backup.name));
});

test('the admin can skip a stuck vote; a league can turn the vote off', async () => {
  const three = (await ok(eve.post('/api/pods', { players: ['Eve', 'Joe', 'Dan'].map(n => ({ userId: S.u[n].id })) }))).pod;
  await ok(eve.post(`/api/pods/${three.id}/winner`, { playerId: S.u.Eve.id }));
  await ok(eve.post(`/api/pods/${three.id}/vote`, { candidateId: S.u.Joe.id }));
  assert.equal((await eve.post(`/api/pods/${three.id}/vote/skip`)).status, 403, 'only the admin can skip');
  const skipped = (await ok(admin.post(`/api/pods/${three.id}/vote/skip`))).pod;
  assert.equal(skipped.vote.status, 'skipped');
  assert.deepEqual(skipped.players.map(p => p.awarded), [3, 2, 2]);
  await ok(eve.post(`/api/pods/${three.id}/spin`));
  await ok(eve.post(`/api/pods/${three.id}/discard`));

  await ok(admin.put(`/api/leagues/${S.league}`, { rules: { voteBonus: 0 } }));
  const off = (await ok(eve.post('/api/pods', { players: ['Eve', 'Joe', 'Dan'].map(n => ({ userId: S.u[n].id })) }))).pod;
  assert.equal((await ok(eve.post(`/api/pods/${off.id}/winner`, { playerId: S.u.Eve.id }))).pod.vote.status, 'skipped', 'vote bonus 0 = no vote');
  await ok(eve.post(`/api/pods/${off.id}/discard`));
  await ok(admin.put(`/api/leagues/${S.league}`, { rules: { voteBonus: 1 } }));
});

test('pods, players, packs, pool cards and leagues are stored as tables', async () => {
  const { pod: live } = await ok(nick.get(`/api/pods/${S.pod.id}`));
  const openedPacks = [...live.players, ...live.absentees].flatMap(p => p.packs).filter(k => k.status === 'opened');
  const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'), { readOnly: true });
  try {
    const pod = db.prepare('SELECT * FROM pods WHERE id = ?').get(S.pod.id);
    assert.equal(pod.status, 'done');
    assert.equal(pod.league_id, S.league);
    assert.equal(pod.winner_id, S.u.Nick.id);
    assert.equal(pod.spin_set_code, S.spin.setCode);
    // Players who joined the league after this pod hold catch-up packs for it; they're counted apart from the two who missed it.
    const roles = db.prepare(`SELECT pp.role, count(*) n FROM pod_players pp WHERE pp.pod_id = ?
      AND NOT EXISTS (SELECT 1 FROM pod_packs k WHERE k.pod_id = pp.pod_id AND k.user_id = pp.user_id AND k.kind = 'catchup') GROUP BY pp.role ORDER BY pp.role`).all(S.pod.id);
    assert.deepEqual(roles.map(r => [r.role, r.n]), [['absent', 2], ['player', 4]]);
    assert.equal(db.prepare("SELECT count(DISTINCT user_id) n FROM pod_packs WHERE pod_id = ? AND kind = 'catchup'").get(S.pod.id).n, 2, 'Ivy and Hal joined later');
    const opened = db.prepare(`SELECT count(*) n FROM pod_packs WHERE pod_id = ? AND status = 'opened'`).get(S.pod.id).n;
    const cards = db.prepare('SELECT * FROM pool_cards WHERE pod_id = ?').all(S.pod.id);
    assert.equal(opened, openedPacks.length, 'opened packs of players and absent members');
    assert.equal(cards.length, openedPacks.flatMap(k => k.cards).length, 'every opened card is a pool_cards row');
    assert.ok(cards.every(c => c.pack_id && c.user_id && c.name && c.set_code && c.number && c.rarity), 'cards keep pod, pack and player ids');
    const mikes = db.prepare('SELECT count(*) n FROM pool_cards WHERE pod_id = ? AND user_id = ?').get(S.pod.id, S.u.Mike.id).n;
    assert.equal(mikes, 14, "Mike's BLB Play Booster is in his pool for this pod");
    assert.equal(pod.vote_status, 'done');
    assert.equal(pod.vote_winner_id, S.u.Mike.id);
    const ballots = db.prepare('SELECT round, count(*) n FROM pod_votes WHERE pod_id = ? GROUP BY round ORDER BY round').all(S.pod.id);
    assert.deepEqual(ballots.map(b => [b.round, b.n]), [[1, 4], [2, 4]], 'every ballot of both rounds is a pod_votes row');
    assert.equal(db.prepare('SELECT count(*) n FROM league_members WHERE league_id = ? AND left_at IS NULL').get(S.league).n, 6);
    assert.ok(db.prepare('SELECT count(*) n FROM league_events WHERE league_id = ?').get(S.league).n >= 8);
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
  const set = await ok(admin.put('/api/settings', { league: S.league, excluded, weights: { blb: 3 } }));
  assert.equal(set.settings.weights.blb, 3);
  const d = await ok(eve.get('/api/sets'));
  assert.deepEqual(d.wheel.map(w => w.code).sort(), keep.sort());
  assert.ok(Math.abs(d.sets.find(s => s.code === 'blb').chance - 0.75) < 1e-9, 'weight 3 vs 1 → 75%');

  // One spin per pod, so spin N throwaway pods and discard them (vote and
  // absent packs off for speed).
  await ok(admin.put(`/api/leagues/${S.league}`, { rules: { voteBonus: 0, absentPacks: 0 } }));
  const N = 120;
  const hits = { blb: 0, lea: 0 };
  for (let i = 0; i < N; i++) {
    const { pod } = await ok(admin.post('/api/pods', { league: S.league, players: ['Eve', 'Joe', 'Dan'].map(n => ({ userId: S.u[n].id })) }));
    await ok(eve.post(`/api/pods/${pod.id}/winner`, { playerId: S.u.Eve.id }));
    hits[(await ok(eve.post(`/api/pods/${pod.id}/spin`))).spin.setCode]++;
    await ok(eve.post(`/api/pods/${pod.id}/discard`));
  }
  await ok(admin.put(`/api/leagues/${S.league}`, { rules: { voteBonus: 1, absentPacks: 1 } }));
  assert.equal(hits.blb + hits.lea, N, 'only sets on the wheel come up');
  assert.ok(hits.blb / N > 0.6 && hits.blb / N < 0.9, `blb came up ${hits.blb}/${N}, expected ~75%`);

  const filtered = await ok(admin.put('/api/settings', { league: S.league, excluded: [], weights: {}, minYear: 2024, maxYear: 2100 }));
  assert.equal(filtered.settings.minYear, 2024);
  const d2 = await ok(eve.get('/api/sets'));
  assert.ok(d2.wheel.every(w => d2.sets.find(s => s.code === w.code).year >= 2024), 'year filter applies');
  await ok(admin.put('/api/settings', { league: S.league, reset: true }));
  assert.equal((await ok(eve.get('/api/sets'))).wheel.length, S.sets.length, 'reset restores the full wheel');
});

test('discarded pods are not in history or pools', async () => {
  const { pods } = await ok(eve.get('/api/history'));
  assert.equal(pods.length, 1);
  const { pools } = await ok(eve.get('/api/pools'));
  assert.equal(pools.find(p => p.username === 'Eve').packs.length, 1, 'only her missed-pod pack from Pod 1');
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

  // Joe's whole Jumpstart 2022 pack.
  const joePacks = player(await histPod(), 'Joe').packs;
  const alpha = joePacks.find(k => k.set.code === 'j22');
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

// A pod of three that's crowned, voted (or skipped), spun and has one pack opened.
async function quickPod(trio, { finish = false } = {}) {
  const { pod } = await ok(eve.post('/api/pods', { players: trio.map(n => ({ userId: S.u[n].id })) }));
  await ok(eve.post(`/api/pods/${pod.id}/winner`, { playerId: S.u[trio[0]].id }));
  await ok(admin.post(`/api/pods/${pod.id}/vote/skip`));
  const spun = (await ok(eve.post(`/api/pods/${pod.id}/spin`))).pod;
  await ok(eve.post(`/api/pods/${pod.id}/packs/${spun.players[0].packs[0].id}/open`));
  if (finish) await ok(eve.post(`/api/pods/${pod.id}/finish`));
  return pod;
}

test('only the admin can delete pods; history and pools follow', async () => {
  const pod = await quickPod(['Eve', 'Joe', 'Dan']);
  assert.ok((await ok(eve.get('/api/pools'))).pools.find(p => p.username === 'Eve').packs.length === 2);

  assert.equal((await eve.del(`/api/pods/${pod.id}`)).status, 403, 'players cannot delete');
  assert.equal((await admin.del('/api/pods/nope')).status, 404);

  await ok(admin.del(`/api/pods/${pod.id}`));
  assert.equal((await ok(eve.get('/api/state'))).pods.length, 0, 'running pod is gone');
  assert.equal((await ok(eve.get('/api/pools'))).pools.find(p => p.username === 'Eve').packs.length, 1, 'its cards left the pool');

  // Standings and player pages are cached; a change must show up right away.
  const nickRow = async () => (await ok(eve.get(`/api/leagues/${S.league}`))).standings.find(s => s.name === 'Nick');
  const nickPage = async () => (await ok(eve.get(`/api/players/${S.u.Nick.id}?league=${S.league}`))).stats.totals.pods;
  const [rowBefore, pageBefore] = [(await nickRow()).pods, await nickPage()];
  assert.equal((await nickRow()).pods, rowBefore, 'served from cache');
  await ok(admin.del(`/api/pods/${S.pod.id}`));
  assert.equal((await nickRow()).pods, rowBefore - 1, 'cached standings refresh after a change');
  assert.equal(await nickPage(), pageBefore - 1, 'cached player pages refresh after a change');
  assert.equal((await ok(eve.get('/api/history'))).pods.length, 0, 'finished pod left History');
  assert.ok((await ok(eve.get('/api/pools'))).pools.every(p => p.packs.every(k => k.kind) && !p.pods.length), 'and every pool (only admin-given packs and moved cards stay)');

  const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'), { readOnly: true });
  try {
    for (const t of ['pod_players', 'pod_packs', 'pool_cards']) {
      const n = db.prepare(`SELECT count(*) n FROM ${t} WHERE pod_id IN (?, ?)`).get(pod.id, S.pod.id).n;
      assert.equal(n, 0, `${t} rows were deleted with their pod`);
    }
  } finally { db.close(); }
});

test('admin can clear a league\'s history; running pods stay', async () => {
  await quickPod(['Eve', 'Joe', 'Dan'], { finish: true });
  await quickPod(['Eve', 'Mike', 'Fay'], { finish: true });
  const running = await quickPod(['Eve', 'Joe', 'Dan']);
  assert.equal((await ok(eve.get('/api/history'))).pods.length, 2);

  assert.equal((await eve.del('/api/history')).status, 403, 'players cannot clear history');
  const r = await ok(admin.del(`/api/history?league=${S.league}`));
  assert.ok(r.deletedPods >= 2, 'finished (and discarded) pods were deleted');
  assert.equal((await ok(eve.get('/api/history'))).pods.length, 0, 'History is empty');
  const st = await ok(eve.get('/api/state'));
  assert.deepEqual(st.pods.map(p => p.id), [running.id], 'the running pod is untouched');
  const evePool = (await ok(eve.get('/api/pools'))).pools.find(p => p.username === 'Eve');
  const evePods = evePool.packs.filter(k => !k.kind);
  assert.ok(evePods.length === 1 && evePods.every(k => k.podId === running.id), 'pools keep only the running pod\'s cards (and admin-given packs)');
  const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'), { readOnly: true });
  try {
    assert.equal(db.prepare(`SELECT count(*) n FROM pods WHERE status IN ('done','discarded') AND kind = 'pod' AND league_id = ?`).get(S.league).n, 0, 'the discarded wheel-test pods are gone too');
  } finally { db.close(); }
  await ok(eve.post(`/api/pods/${running.id}/discard`));
});

test('ending a league archives it and frees its players; deleting removes it', async () => {
  const { pod } = await ok(nick.post('/api/pods', { players: ['Nick', 'Mike', 'Joe'].map(n => ({ userId: S.u[n].id })) }));
  assert.equal((await nick.post(`/api/leagues/${S.league}/end`)).status, 403);
  assert.equal((await admin.post(`/api/leagues/${S.league}/end`)).status, 409, 'running pods must be finished first');
  assert.equal((await nick.post(`/api/leagues/${S.league}/leave`)).status, 409, "can't leave mid-pod");
  await ok(nick.post(`/api/pods/${pod.id}/discard`));
  await ok(admin.post(`/api/leagues/${S.league}/end`));
  const st = await ok(nick.get('/api/state'));
  assert.equal(st.myLeagueId, null, 'Nick is free to join another league');
  assert.equal((await ok(nick.get(`/api/leagues/${S.league}`))).league.status, 'ended', 'the league stays as an archive');
  const left = (await ok(joe.get(`/api/trades?league=${S.league}`))).trades.find(t => t.id === S.openTrade);
  assert.equal(left.status, 'closed', 'open trades close when the league ends');
  assert.equal((await nick.post('/api/pods', { league: S.league, players: ['Nick', 'Mike', 'Joe'].map(n => ({ userId: S.u[n].id })) })).status, 409, 'no new pods');
  const { league } = await ok(fay.post('/api/leagues', { name: 'Season 2' }));
  assert.equal(league.members.length, 6, 'a new league can sweep in everyone who is free (Gus is still in his)');

  assert.equal((await gus.del(`/api/leagues/${S.gusLeague}`)).status, 403);
  await ok(admin.del(`/api/leagues/${S.gusLeague}`));
  assert.equal((await gus.get(`/api/leagues/${S.gusLeague}`)).status, 404);
  assert.equal((await ok(gus.get('/api/state'))).myLeagueId, null, 'Gus is free');
});

test('fun packs: any set, explained, never saved', async () => {
  const before = JSON.stringify((await ok(mike.get('/api/pools'))).pools);
  const eventsBefore = (await ok(mike.get(`/api/leagues/${S.league}`))).events.length;
  assert.equal((await mike.post('/api/fun/open', { set: 'nope' })).status, 400, 'unknown set');
  // A real-sheet set (the one the pod spun, already cached) …
  let r = await ok(mike.post('/api/fun/open', { set: S.spin.setCode }));
  assert.equal(r.set.code, S.spin.setCode);
  assert.equal(r.pack.generated, false);
  assert.equal(r.pack.explain.source, 'real');
  assert.equal(r.pack.explain.slots.reduce((n, sl) => n + sl.count, 0), r.pack.cards.length, 'every card comes from a listed slot');
  assert.ok(r.pack.explain.slots.every(sl => sl.poolSize >= sl.count));
  // Alpha's original booster comes from MTGJSON's print sheets: 11 commons, 3 uncommons, 1 rare.
  r = await ok(mike.post('/api/fun/open', { set: 'lea' }));
  assert.equal(r.pack.generated, false);
  assert.match(r.pack.explain.summary, /MTGJSON/);
  assert.deepEqual(r.pack.explain.slots.map(sl => [sl.label, sl.count]).sort(), [['Common', 11], ['Rare', 1], ['Uncommon', 3]]);
  assert.ok(r.pack.cards.every(c => c.set === 'lea' && c.image));
  // … and a generated one (Jumpstart 2022, cached by the earlier test).
  r = await ok(mike.post('/api/fun/open', { set: 'j22' }));
  assert.equal(r.pack.explain.source, 'generated');
  assert.match(r.pack.explain.era, /Shards of Alara \(2008\) or later/);
  assert.equal(r.pack.explain.slots.reduce((n, sl) => n + sl.count, 0), 15);
  // Several packs at once (up to a box of 36), each built independently.
  assert.equal((await mike.post('/api/fun/open', { set: 'lea', count: 37 })).status, 400, 'more than a box');
  assert.equal((await mike.post('/api/fun/open', { set: 'lea', count: 0 })).status, 400, 'zero packs');
  r = await ok(mike.post('/api/fun/open', { set: 'lea', count: 6 }));
  assert.equal(r.packs.length, 6);
  assert.ok(r.packs.every(p => p.cards.length === 15 && p.explain.source === 'real'));
  assert.ok(new Set(r.packs.map(p => p.cards.map(c => c.number).join())).size > 1, 'packs differ');
  assert.ok(r.packs.every(p => p.explain.slots.every(sl => sl.sheet)), 'slots name their sheet');
  // Sheet odds for the stats view: what a set's sheets should give per pack.
  const odds = await ok(mike.get('/api/fun/odds/lea'));
  assert.equal(odds.real, true);
  assert.equal(odds.foilChance, 0);
  assert.equal(Math.round(Object.values(odds.cards).reduce((s, c) => s + c.exp, 0)), 15, 'expected copies add up to a pack');
  assert.ok(odds.sheets.every(sh => sh.appear === 1 && sh.keys.length === sh.size || sh.keys.length <= sh.size));
  assert.ok(r.packs.flatMap(p => p.cards).every(c => odds.cards[`${c.set}/${c.number}${c.foil ? '/f' : ''}`]), 'every pulled card is on a sheet');
  assert.deepEqual(await ok(mike.get('/api/fun/odds/j22')), { real: false }, 'generated sets have no sheet odds');
  assert.equal((await mike.get('/api/fun/odds/nope')).status, 404);
  assert.equal(JSON.stringify((await ok(mike.get('/api/pools'))).pools), before, 'pools are untouched');
  const { events } = await ok(mike.get(`/api/leagues/${S.league}`));
  assert.ok(events.every(e => !/fun pack/i.test(e.text)) && events.length === eventsBefore, 'nothing in the feed');
});

test('feedback: players send ideas, only the admin sees them all and replies', async () => {
  assert.equal((await mike.post('/api/feedback', { kind: 'idea', text: 'hi' })).status, 400, 'too short');
  const { item } = await ok(mike.post('/api/feedback', { kind: 'idea', text: 'Discord webhook for mythic pulls' }));
  assert.equal(item.status, 'new');
  await ok(joe.post('/api/feedback', { kind: 'bug', text: 'Wheel stutters on my phone' }));
  assert.deepEqual((await ok(mike.get('/api/feedback'))).items.map(i => i.text), ['Discord webhook for mythic pulls'], 'players see only their own');
  assert.equal((await mike.put(`/api/feedback/${item.id}`, { status: 'done' })).status, 403, 'players cannot change status');
  assert.equal((await joe.del(`/api/feedback/${item.id}`)).status, 403, 'or delete someone else\'s');
  const inbox = await ok(admin.get('/api/feedback?status=new'));
  assert.ok(inbox.items.length >= 2 && inbox.counts.new >= 2, 'the admin sees everything new');
  assert.ok((await ok(admin.get('/api/state'))).feedbackNew >= 2, 'and gets a new-count badge');
  assert.equal((await ok(mike.get('/api/state'))).feedbackNew, undefined, 'players don\'t');
  const { item: planned } = await ok(admin.put(`/api/feedback/${item.id}`, { status: 'planned', reply: 'On the list!' }));
  assert.equal(planned.status, 'planned');
  const mine = (await ok(mike.get('/api/feedback'))).items[0];
  assert.equal(mine.reply, 'On the list!', 'the player sees the reply');
  assert.equal((await mike.del(`/api/feedback/${item.id}`)).status, 403, 'reviewed suggestions can\'t be taken back');
  for (let i = 0; i < 5; i++) await ok(eve.post('/api/feedback', { text: `Idea number ${i}` }));
  assert.equal((await eve.post('/api/feedback', { text: 'One too many ideas' })).status, 429, '5 an hour');
  const evesFirst = (await ok(eve.get('/api/feedback'))).items.at(-1);
  await ok(eve.del(`/api/feedback/${evesFirst.id}`));
  await ok(admin.del(`/api/feedback/${item.id}`));
});

test('players can delete their account; past pods keep them as "Deleted player"', async () => {
  const joesPod = (await ok(nick.post('/api/pods', { players: ['Nick', 'Mike', 'Joe'].map(n => ({ userId: S.u[n].id })) }))).pod;
  assert.equal((await joe.post('/api/auth/delete', { password: 'wrongpass1' })).status, 400, 'needs the password');
  await ok(joe.post('/api/auth/delete', { password: 'NewJoe2026' })); // set by the reset test
  assert.equal((await joe.get('/api/state')).status, 401, 'signed out');
  assert.equal((await nick.get(`/api/players/${S.u.Joe.id}`)).status, 404, 'their player page (and deck) is gone');
  assert.equal((await anon.post('/api/auth/login', { username: 'Joe', password: 'NewJoe2026' })).status, 401, 'the login is gone');
  const { pod } = await ok(nick.get(`/api/pods/${joesPod.id}`));
  assert.equal(pod.players.find(p => p.id === S.u.Joe.id).name, 'Deleted player', 'their seat stays, anonymised');
  const { events } = await ok(nick.get(`/api/leagues/${S.league}`));
  assert.ok(events.every(e => !/\bJoe\b/.test(e.text)), 'their name is gone from the feed');
  assert.ok(!(await ok(admin.get('/api/admin/users'))).users.some(u => u.username === 'Joe'));
  // The admin can delete other accounts, but not their own.
  const me = (await ok(admin.get('/api/auth/me'))).user;
  assert.equal((await admin.del(`/api/admin/users/${me.id}`)).status, 409);
  assert.equal((await nick.del(`/api/admin/users/${S.u.Dan.id}`)).status, 403, 'players can\'t delete others');
  await ok(admin.del(`/api/admin/users/${S.u.Dan.id}`));
  assert.equal((await anon.post('/api/auth/login', { username: 'Dan', password: PW })).status, 401);
});

test('logging out ends the session', async () => {
  await ok(eve.post('/api/auth/logout'));
  assert.equal((await eve.get('/api/state')).status, 401);
});

test('every filter and sort the app runs has an index', async () => {
  const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'), { readOnly: true });
  try {
    const plan = (sql, ...args) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(r => r.detail).join(' | ');
    const checks = [
      ["SELECT * FROM pods WHERE status = 'done' AND league_id = ? ORDER BY finished_at DESC", 'pods_league_finished'],
      ["SELECT * FROM pod_packs WHERE user_id = ? AND status != 'opened'", 'pod_packs_user'],
      ['SELECT * FROM pool_cards WHERE pod_id IN (?, ?) ORDER BY pack_id, seq', 'pool_cards_pod'],
      ['DELETE FROM sessions WHERE user_id = ?', 'sessions_user'],
      ['DELETE FROM reset_tokens WHERE user_id = ?', 'reset_tokens_user'],
      ['DELETE FROM reset_tokens WHERE expires_at < ?', 'reset_tokens_expires'],
      ['SELECT id FROM users WHERE is_admin = 1', 'users_admin'],
      ["SELECT * FROM feedback WHERE status = 'new' ORDER BY id DESC", 'feedback_status'],
      ['SELECT * FROM league_events WHERE league_id = ? ORDER BY id DESC LIMIT 60', 'league_events_league'],
      ['SELECT * FROM league_members WHERE user_id = ? AND left_at IS NULL', 'league_members_user'],
      ['SELECT * FROM users WHERE username = ? OR email = ?', 'sqlite_autoindex_users'],
    ];
    for (const [sql, index] of checks) {
      const p = plan(sql, ...Array((sql.match(/\?/g) || []).length).fill('x'));
      assert.match(p, new RegExp(index), `${sql}\n  should use ${index}, plan: ${p}`);
      assert.doesNotMatch(p, /^SCAN \w+$|\| SCAN \w+$/, `no full table scan: ${p}`);
    }
  } finally { db.close(); }
});

test('static files carry long cache headers; the page itself is never cached', async () => {
  const home = await anon.get('/');
  assert.equal(home.headers.get('cache-control'), 'no-cache');
  const appUrl = home.text.match(/\/app\.js\?v=\w+/)[0];
  const app = await anon.get(appUrl);
  assert.match(app.headers.get('cache-control'), /max-age=31536000, immutable/);
  assert.match(app.text, /from '\.\/decklist\.js\?v=\w+'/, 'its import is versioned too');
  assert.match((await anon.get(home.text.match(/\/styles\.css\?v=\w+/)[0])).headers.get('cache-control'), /immutable/);
  assert.match((await anon.get('/fonts/barlow-400.woff2')).headers.get('cache-control'), /max-age=31536000, immutable/);
  assert.match((await anon.get('/favicon.svg')).headers.get('cache-control'), /max-age=604800/);
  assert.match((await anon.get('/privacy')).headers.get('cache-control'), /max-age=600/);
  assert.match(app.text, /srcset=/, 'card images offer Scryfall\'s small size');
});

// Last: these use up this test run's per-minute allowance.
test('Discord: invite button, and finished pods, announcements and season recaps are posted', async () => {
  const home = await anon.get('/');
  assert.ok(home.text.includes('<a class="btn sm discord-join" href="https://discord.gg/pcctest" target="_blank" rel="noopener">Join the Discord</a>'), 'the footer invite button');
  assert.match(home.text, /<div class="foot-actions">\s*<a class="btn sm discord-join"[^]*?id="fbBtn"[^]*?<\/div>/, 'in one row with Suggest a feature');
  const o = await ok(admin.get('/api/admin/overview'));
  assert.equal(o.discord.enabled, true);
  assert.equal((await nick.post('/api/admin/discord/test')).status, 403);
  assert.equal((await ok(admin.post('/api/admin/discord/test'))).ok, true);
  await new Promise(r => setTimeout(r, 300));
  assert.ok(discordPosts.every(p => p.path === '/api/webhooks/123/test-token'));
  assert.ok(discordPosts.every(p => Array.isArray(p.body.allowed_mentions?.parse) && !p.body.allowed_mentions.parse.length), 'never pings anyone');
  const titles = discordPosts.map(p => p.body.embeds[0].title);
  assert.ok(titles.some(t => / won /.test(t)), 'a finished pod');
  const won = discordPosts.find(p => / won /.test(p.body.embeds[0].title)).body.embeds[0];
  assert.match(won.description, /🏆/);
  assert.ok(titles.includes('📣 Announcement'), 'the announcement');
  assert.ok(titles.some(t => / is over!$/.test(t)), 'the season recap');
  assert.ok(titles.includes('Pre-Con Commander is connected'), 'the test post');
  const ann = discordPosts.filter(p => p.body.embeds[0].title === '📣 Announcement').length;
  await ok(admin.put('/api/admin/announcement', { text: 'Banner only', discord: false }));
  await ok(admin.put('/api/admin/announcement', { text: '' }));
  await new Promise(r => setTimeout(r, 300));
  assert.equal(discordPosts.filter(p => p.body.embeds[0].title === '📣 Announcement').length, ann, 'unticked: not posted; cleared: not posted');
});

test('per-IP rate limits: heavy endpoints, then everything, answer 429 with Retry-After', async () => {
  const limited = client();
  const r1 = await limited.get('/api/state');
  assert.ok(r1.headers.get('ratelimit-limit'), 'API answers say the limit');
  let res;
  for (let i = 0; i < 250; i++) { res = await limited.get(`/api/players/${S.u.Nick.id}`); if (res.status === 429) break; }
  assert.equal(res.status, 429, 'heavy lookups are limited per minute');
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  assert.match(res.json.error, /limit 200 a minute/);
  assert.equal((await limited.get('/healthz')).status, 200, 'other requests still go through');
});
