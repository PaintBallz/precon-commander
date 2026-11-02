// Pre-Con Commander — client. Plain ES modules, no build step.
// League = everyone with an account. Pod = one game of 2–4 players; its winner
// spins the wheel once and every player's packs come from that set.
import { listText, SITES } from './decklist.js';
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('pcc:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pcc:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const S = {
  me: null, passwordRules: '', emailEnabled: false,
  pods: [], openPods: [], pending: [], members: [], sets: [], setsByCode: new Map(), wheel: [], settings: null, types: [],
  league: null, leagues: [], myLeagueId: null, viewLeague: null, leagueDetail: null,
  history: null, pools: null, route: 'pods', params: {},
  sound: store.get('sound', true),
  exportSite: SITES[store.get('exportSite', 'moxfield')] ? store.get('exportSite', 'moxfield') : 'moxfield',
  podId: null, packsPlayer: null,
  seenSpins: new Set(), animatePacks: new Set(), spinning: false, rot: 0,
};

// ---------------- api ----------------
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && json.loggedOut && !path.startsWith('/auth/')) { showAuth(); throw new Error('Please log in.'); }
  if (res.status === 403 && json.mustChange) { S.me = { ...S.me, mustChange: true }; showAuth(); throw new Error(json.error); }
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}
const post = (path, body = {}) => api(path, { method: 'POST', body });
const del = path => api(path, { method: 'DELETE', body: {} });

// Every league-scoped call says which league is on screen (?league=…).
const lq = (sep = '?') => (S.viewLeague ? `${sep}league=${encodeURIComponent(S.viewLeague)}` : '');
async function loadState() {
  const st = await api('/state' + lq());
  S.me = st.me; S.pods = st.pods; S.openPods = st.openPods || []; S.members = st.members; S.pending = st.pending || [];
  S.league = st.league; S.leagues = st.leagues || []; S.myLeagueId = st.myLeagueId;
  S.viewLeague = st.league?.id || null;
  S.feedbackNew = st.feedbackNew || 0;
  paintMe();
  paintLeaguePicker();
}
// Switch the whole app to another league (header picker, joining, creating…).
async function showLeague(id) {
  S.viewLeague = id || null;
  S.leagueDetail = null; S.history = null; S.pools = null; S.podId = null;
  await Promise.all([loadState(), loadSets()]);
  render();
}
async function loadSets() {
  const d = await api('/sets' + lq());
  S.sets = d.sets; S.wheel = d.wheel; S.settings = d.settings; S.types = d.types;
  S.setsByCode = new Map(d.sets.map(s => [s.code, s]));
}

// ---------------- helpers ----------------
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4200);
}
const fail = err => toast(esc(err.message || err), 'err');
const isAdmin = () => !!S.me?.isAdmin;
// Line icons from the sprite in index.html: ${I.crown}, ${I.trash}, …
const I = new Proxy({}, { get: (_, n) => `<svg class="i i-${String(n)}" aria-hidden="true"><use href="#i-${String(n)}"/></svg>` });
const podById = id => S.pods.find(p => p.id === id) || S.openPods.find(p => p.id === id);
const myPod = () => S.pods.find(p => p.players.some(x => x.id === S.me?.id));
function currentPod() {
  const pod = podById(S.params.pod) || podById(S.podId) || myPod() || S.pods[0] || S.openPods[0] || null;
  S.podId = pod?.id || null;
  return pod;
}
const canAct = player => isAdmin() || player.id === S.me?.id;
const spunPacks = p => p.packs.filter(k => k.status === 'ready' && k.source === 'wheel');
const people = pod => [...(pod?.players || []), ...(pod?.absentees || [])];
const findPack = (pod, id) => { for (const p of people(pod)) { const k = p.packs.find(k => k.id === id); if (k) return { ...k, player: p }; } return null; };
const icon = (set, cls = '') => set?.icon ? `<img class="set-icon ${cls}" src="${esc(set.icon)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '';
const pct = n => n >= 0.1 ? (n * 100).toFixed(1) + '%' : n > 0 ? (n * 100).toFixed(2) + '%' : '—';
const typeLabel = t => ({ expansion: 'Expansion', core: 'Core', masters: 'Masters', draft_innovation: 'Draft Innovation' }[t] || t);
const fmtDate = iso => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, mythic: 3, special: 3, bonus: 3 };
const kindLabel = code => { const m = S.setsByCode.get(code); return m?.realPack ? `${{ play: 'Play', draft: 'Draft', set: 'Set' }[m.packKind]} Booster` : 'Booster'; };

function paintLeaguePicker() {
  const sel = $('#leagueSel');
  const show = S.leagues.length && (isAdmin() || S.leagues.length > 1 || (S.league && S.league.id !== S.myLeagueId));
  sel.hidden = !show;
  if (!show) return;
  sel.innerHTML = S.leagues.map(l => `<option value="${l.id}" ${l.id === S.viewLeague ? 'selected' : ''}>${esc(l.name)}${l.status === 'ended' ? ' (ended)' : ''}${l.id === S.myLeagueId ? ' ★' : ''}</option>`).join('');
}
$('#leagueSel').addEventListener('change', e => showLeague(e.target.value).catch(fail));

function paintMe() {
  const fb = isAdmin() && S.feedbackNew ? `<span class="chip st-new" title="${plural(S.feedbackNew, 'new suggestion')}">${I.bulb}${S.feedbackNew}</span>` : '';
  $('#meBtn').innerHTML = S.me ? `${isAdmin() ? '<span class="chip gold">admin</span>' : ''}${fb}<span>${esc(S.me.username)}</span>` : '';
  const inApp = !!S.me && !S.me.mustChange;
  $('#fbBtn').hidden = !inApp; $('#fbOr').hidden = !inApp;
}
const soundBtn = $('#soundBtn');
const paintSound = () => { soundBtn.innerHTML = S.sound ? I.sound : I.mute; };
paintSound();
soundBtn.addEventListener('click', () => { S.sound = !S.sound; store.set('sound', S.sound); paintSound(); });
$('#discordBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText('paintballz'); toast(`${I.copy} Discord username copied: paintballz`, 'good'); }
  catch { toast('My Discord username is paintballz'); }
});

// ---------------- feedback ----------------
const FB_KINDS = { idea: `${I.bulb} Feature idea`, bug: `${I.bug} Bug`, other: `${I.chat} Other` };
const FB_STATUS = { new: 'New', planned: 'Planned', done: 'Done', declined: 'Declined' };
const fbChip = st => `<span class="chip st-${st}">${FB_STATUS[st] || esc(st)}</span>`;
$('#fbBtn').addEventListener('click', () => {
  const m = $('#modal');
  m.innerHTML = `<div class="box"><div class="dialog">
    <h2>${I.bulb} Suggest a feature</h2>
    <p class="muted small">Ideas, bugs, anything that would make the league better. Only the site admin sees it, and you can follow it on your Account page.</p>
    <form id="fbForm" class="grid">
      <div class="fb-filter">${Object.entries(FB_KINDS).map(([k, l], i) => `<label class="chip"><input type="radio" name="kind" value="${k}" ${i ? '' : 'checked'}> ${l}</label>`).join('')}</div>
      <label>Your idea<textarea name="text" rows="5" maxlength="2000" required placeholder="What should it do, and why would it be great?"></textarea></label>
      <div class="row" style="justify-content:space-between;align-items:center">
        <span class="small dim" id="fbCount">0 / 2000</span>
        <div class="row"><button type="button" class="btn ghost" id="fbCancel">Cancel</button><button class="btn gold">Send</button></div>
      </div>
    </form></div></div>`;
  m.hidden = false;
  const ta = $('textarea', m);
  ta.focus();
  ta.oninput = () => { $('#fbCount').textContent = `${ta.value.length} / 2000`; };
  $('#fbCancel', m).onclick = () => { m.hidden = true; };
  $('#fbForm', m).onsubmit = async e => {
    e.preventDefault();
    try {
      await post('/feedback', Object.fromEntries(new FormData(e.target)));
      m.hidden = true;
      toast(`${I.bulb} Thanks! Your suggestion was sent.`, 'good');
      if (S.route === 'account') render();
    } catch (err) { fail(err); }
  };
});

// Account page: a player's own suggestions, or the admin's inbox.
async function renderFeedback(box) {
  const filter = S.fbFilter ?? (isAdmin() ? 'new' : '');
  let d;
  try { d = await api('/feedback' + (isAdmin() && filter ? `?status=${filter}` : '')); } catch (err) { fail(err); return; }
  if (S.route !== 'account' || !box.isConnected) return;
  const when = iso => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  if (!isAdmin()) {
    box.innerHTML = d.items.length ? `<div class="panel" style="margin-top:18px">
      <h2>Your suggestions</h2>
      <div class="fb-list">${d.items.map(it => `<div class="fb-item">
        <div class="fb-head">${fbChip(it.status)}<span class="small">${FB_KINDS[it.kind] || ''}</span><span class="small dim">${when(it.createdAt)}</span>
          ${it.status === 'new' ? `<button class="chip-x" data-fbdel="${it.id}" title="Take it back" style="margin-left:auto">✕</button>` : ''}</div>
        <p class="fb-text">${esc(it.text)}</p>
        ${it.reply ? `<p class="fb-reply"><b>Admin:</b> ${esc(it.reply)}</p>` : ''}
      </div>`).join('')}</div></div>` : '';
  } else {
    const total = Object.values(d.counts).reduce((a, b) => a + b, 0);
    box.innerHTML = `<div class="panel" style="margin-top:18px">
      <h2>${I.bulb} Feedback inbox</h2>
      <div class="fb-filter">${[['new', 'New'], ['planned', 'Planned'], ['done', 'Done'], ['declined', 'Declined'], ['', 'All']].map(([k, l]) =>
        `<button class="btn sm ghost ${filter === k ? 'sel' : ''}" data-fbf="${k}">${l} · ${k ? d.counts[k] : total}</button>`).join('')}</div>
      ${d.items.length ? `<div class="fb-list">${d.items.map(it => `<div class="fb-item" data-fb="${it.id}">
        <div class="fb-head">${fbChip(it.status)}<b>${esc(it.username)}</b><span class="small">${FB_KINDS[it.kind] || ''}</span><span class="small dim">${when(it.createdAt)}</span></div>
        <p class="fb-text">${esc(it.text)}</p>
        <div class="fb-admin">
          <select name="status">${Object.entries(FB_STATUS).map(([k, l]) => `<option value="${k}" ${it.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <input name="reply" maxlength="500" value="${esc(it.reply)}" placeholder="Reply (the player sees this)">
          <button class="btn sm gold" data-fbsave>Save</button>
          <button class="btn sm danger" data-fbdel="${it.id}">Delete</button>
        </div>
      </div>`).join('')}</div>` : `<p class="muted small" style="margin-top:10px">Nothing ${filter ? `marked ${FB_STATUS[filter].toLowerCase()}` : 'here'} yet.</p>`}
    </div>`;
    $$('[data-fbf]', box).forEach(b => b.onclick = () => { S.fbFilter = b.dataset.fbf; renderFeedback(box); });
    $$('[data-fbsave]', box).forEach(b => b.onclick = async () => {
      const item = b.closest('[data-fb]');
      try {
        await api(`/feedback/${item.dataset.fb}`, { method: 'PUT', body: { status: $('[name=status]', item).value, reply: $('[name=reply]', item).value } });
        toast('Saved.', 'good');
        await loadState(); renderFeedback(box);
      } catch (err) { fail(err); }
    });
  }
  $$('[data-fbdel]', box).forEach(b => b.onclick = async () => {
    if (!await confirmBox('Delete this suggestion?', "It can't be brought back.", 'Delete', true)) return;
    try { await del(`/feedback/${b.dataset.fbdel}`); if (isAdmin()) await loadState(); renderFeedback(box); } catch (err) { fail(err); }
  });
}

// ---- deck-list text ("1 Card Name (SET) 123" — Moxfield / Archidekt) ----
// Which deck builder copied lists are formatted for (remembered per device).
const site = () => S.exportSite;
const siteName = () => SITES[S.exportSite];
const listFor = cards => listText(cards, site());
function exportToggle() {
  return `<span class="export-site" title="Copied lists are formatted for this site's import box">Copy for
    ${Object.entries(SITES).map(([k, n]) => `<button type="button" data-site="${k}" class="${k === S.exportSite ? 'sel' : ''}">${n}</button>`).join('')}</span>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-site]');
  if (!b || b.dataset.site === S.exportSite) return;
  S.exportSite = b.dataset.site;
  store.set('exportSite', S.exportSite);
  render();
});

async function copyText(text, what = 'List') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast(`${I.copy} ${esc(what)} copied for ${siteName()}. Paste it into ${siteName()}'s import box.`, 'good');
}

// ---------------- routing ----------------
const ROUTES = ['league', 'pods', 'wheel', 'packs', 'pools', 'sets', 'history', 'account'];
function parseRoute() {
  const [r, q] = location.hash.replace(/^#/, '').split('?');
  S.route = ROUTES.includes(r) ? r : 'pods';
  S.params = Object.fromEntries(new URLSearchParams(q || ''));
}
const go = hash => { if (location.hash === hash) { parseRoute(); render(); } else location.hash = hash; };
window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#reset')) { showAuth(); return; }
  if (!S.me || S.me.mustChange) return;
  parseRoute(); render(); window.scrollTo(0, 0);
});

function render() {
  if (!S.me || S.me.mustChange) { showAuth(); return; }
  $('#top').hidden = false;
  $$('#tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === S.route));
  const view = $('#view');
  if (S.route !== 'wheel') stopWheelLoop();
  ({ league: renderLeague, pods: renderPods, wheel: renderWheel, packs: renderPacks, pools: renderPools, sets: renderSets, history: renderHistory, account: renderAccount })[S.route](view);
}

function confirmBox(title, body, okLabel = 'OK', danger = false) {
  return new Promise(resolve => {
    const m = $('#modal');
    m.innerHTML = `<div class="box"><div class="dialog">
      <h2>${title}</h2><p class="muted">${body}</p>
      <div class="row" style="justify-content:flex-end;margin-top:14px">
        <button class="btn ghost" data-r="0">Cancel</button>
        <button class="btn ${danger ? 'danger' : 'gold'}" data-r="1">${okLabel}</button>
      </div></div></div>`;
    m.hidden = false;
    const done = v => { m.hidden = true; m.innerHTML = ''; resolve(v); };
    $$('[data-r]', m).forEach(b => b.onclick = () => done(b.dataset.r === '1'));
    m.onclick = e => { if (e.target === m) done(false); };
  });
}

// =============== LOGIN / SIGN UP / RESET ===============
let authMode = 'login';
function showAuth() {
  $('#top').hidden = true;
  $('#fbBtn').hidden = true; $('#fbOr').hidden = true;
  stopWheelLoop();
  const view = $('#view');
  const resetToken = location.hash.startsWith('#reset') ? new URLSearchParams(location.hash.split('?')[1] || '').get('token') : null;
  if (resetToken) return renderReset(view, resetToken);
  if (S.me?.mustChange) return renderMustChange(view);
  const tabs = `<div class="auth-tabs">
      <button data-m="login" class="${authMode === 'login' ? 'sel' : ''}">Log in</button>
      <button data-m="signup" class="${authMode === 'signup' ? 'sel' : ''}">Sign up</button>
    </div>`;
  const forms = {
    login: `<form id="authForm" class="grid">
        <label>Username or email<input name="username" autocomplete="username" required maxlength="254"></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="128"></label>
        <button class="btn gold big">Log in</button>
        <button type="button" class="link-btn" data-m="forgot">Forgot your password?</button>
      </form>`,
    signup: `<form id="authForm" class="grid">
        <label>Username<input name="username" autocomplete="username" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_\\-]{3,20}" title="3–20 letters, numbers, _ or -"></label>
        <label>Email <span class="dim small">(to recover your account)</span><input name="email" type="email" autocomplete="email" required maxlength="254"></label>
        <label>Password<input name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128"></label>
        <p class="small muted" style="margin:-4px 0 0">${esc(S.passwordRules)}</p>
        <button class="btn gold big">Create account</button>
      </form>`,
    forgot: `<form id="authForm" class="grid">
        <p class="muted" style="margin:0">Enter the email on your account and we'll send you a link to set a new password.</p>
        <label>Email<input name="email" type="email" autocomplete="email" required maxlength="254"></label>
        <button class="btn gold big">Send reset link</button>
        <button type="button" class="link-btn" data-m="login">Back to log in</button>
      </form>`,
  };
  view.innerHTML = `<div class="auth-wrap"><div class="panel auth-box">
      <div class="auth-brand"><img src="/favicon.svg" alt="" width="44" height="44"><div><h1>Pre-Con <b>Commander</b></h1><p class="muted small">League pods, one wheel spin, every pull tracked.</p></div></div>
      ${authMode === 'forgot' ? '<h2>Reset password</h2>' : tabs}
      ${forms[authMode]}
    </div></div>`;
  $$('[data-m]', view).forEach(b => b.onclick = () => { authMode = b.dataset.m; showAuth(); });
  $('#authForm', view).onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const btn = $('button.gold', e.target); btn.disabled = true;
    try {
      if (authMode === 'forgot') {
        const r = await post('/auth/forgot', f);
        view.querySelector('.auth-box form').outerHTML = r.emailEnabled
          ? `<p>If an account uses <b>${esc(f.email)}</b>, a reset link is on its way. It works for one hour.</p><button class="btn" data-m="login">Back to log in</button>`
          : `<p>Email sending isn't set up yet. Ask the league admin for a password reset link.</p><button class="btn" data-m="login">Back to log in</button>`;
        $$('[data-m]', view).forEach(b => b.onclick = () => { authMode = b.dataset.m; showAuth(); });
        return;
      }
      const r = await post(authMode === 'signup' ? '/auth/signup' : '/auth/login', f);
      await enterApp(r.user);
    } catch (err) { fail(err); btn.disabled = false; }
  };
  $('input', view)?.focus();
}

function passwordFields(withCurrent) {
  return `${withCurrent ? '<label>Current password<input name="current" type="password" autocomplete="current-password" required maxlength="128"></label>' : ''}
    <label>New password<input name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128"></label>
    <label>Confirm new password<input name="confirm" type="password" autocomplete="new-password" required minlength="8" maxlength="128"></label>
    <p class="small muted" style="margin:-4px 0 0">${esc(S.passwordRules)}</p>`;
}
const mismatch = f => { if (f.password !== f.confirm) { toast('The two new passwords don\'t match.', 'err'); return true; } return false; };

function renderMustChange(view) {
  view.innerHTML = `<div class="auth-wrap"><div class="panel auth-box">
      <h2>Choose a new password</h2>
      <p class="muted">${esc(S.me.username)} is still on the default password. Set your own before going in.</p>
      <form id="pwForm" class="grid">${passwordFields(true)}<button class="btn gold big">Save password</button></form>
      <button class="link-btn" id="lo">Log out</button>
    </div></div>`;
  $('#pwForm', view).onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (mismatch(f)) return;
    try { const r = await post('/auth/password', f); toast('Password saved.', 'good'); await enterApp(r.user); } catch (err) { fail(err); }
  };
  $('#lo', view).onclick = logout;
}

function renderReset(view, token) {
  view.innerHTML = `<div class="auth-wrap"><div class="panel auth-box">
      <h2>Set a new password</h2>
      <form id="pwForm" class="grid">${passwordFields(false)}<button class="btn gold big">Save and log in</button></form>
    </div></div>`;
  $('#pwForm', view).onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (mismatch(f)) return;
    try {
      const r = await post('/auth/reset', { token, password: f.password });
      history.replaceState(null, '', '#pods');
      toast('Password updated. You\'re logged in.', 'good');
      await enterApp(r.user);
    } catch (err) { fail(err); }
  };
}

async function enterApp(user) {
  S.me = user;
  if (user.mustChange) { showAuth(); return; }
  $('#view').innerHTML = '<div class="spinner"></div>';
  await Promise.all([loadState(), loadSets()]);
  for (const pod of S.pods) if (pod.spin) S.seenSpins.add(pod.spin.id);
  if (!location.hash || location.hash.startsWith('#reset')) history.replaceState(null, '', !S.league ? '#league' : myPod()?.spin ? '#wheel' : '#pods');
  parseRoute();
  render();
  connect();
}

async function logout() {
  try { await post('/auth/logout'); } catch { /* already gone */ }
  S.me = null; authMode = 'login';
  es?.close(); es = null;
  history.replaceState(null, '', '#');
  showAuth();
}

// =============== ACCOUNT TAB ===============
async function renderAccount(view) {
  const me = S.me;
  view.innerHTML = `
    <div class="hero"><div><h1>${esc(me.username)}</h1><p>${isAdmin() ? 'League admin. ' : ''}Member since ${fmtDate(me.createdAt)}.</p></div>
      <div class="row"><button class="btn danger" id="lo">Log out</button></div></div>
    <div class="account-grid">
      <form class="panel grid" id="profForm">
        <h2>Profile</h2>
        <label>Email <span class="dim small">(for password recovery)</span><input name="email" type="email" value="${esc(me.email)}" maxlength="254" ${me.email ? '' : 'placeholder="Add an email"'}></label>
        <label>Your precon / commander<input name="precon" value="${esc(me.precon)}" maxlength="80" placeholder="e.g. Animated Army"></label>
        <p class="small muted" style="margin:0">Your precon fills in automatically when you join a pod. Its cards aren't listed in your pool.</p>
        <button class="btn gold">Save profile</button>
      </form>
      <form class="panel grid" id="pwForm">
        <h2>Change password</h2>
        ${passwordFields(true)}
        <button class="btn gold">Change password</button>
      </form>
    </div>
    <div id="fbBox"></div>
    <div id="adminBox"></div>`;
  $('#lo', view).onclick = logout;
  renderFeedback($('#fbBox', view));
  $('#profForm', view).onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (!f.email) delete f.email;
    try { const r = await api('/auth/profile', { method: 'PUT', body: f }); S.me = r.user; paintMe(); toast('Profile saved.', 'good'); } catch (err) { fail(err); }
  };
  $('#pwForm', view).onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (mismatch(f)) return;
    try { await post('/auth/password', f); e.target.reset(); toast('Password changed. Other devices were logged out.', 'good'); } catch (err) { fail(err); }
  };
  if (!isAdmin()) return;
  let d;
  try { d = await api('/admin/users'); } catch (err) { fail(err); return; }
  if (S.route !== 'account') return;
  $('#adminBox', view).innerHTML = `<div class="panel" style="margin-top:18px;overflow-x:auto">
      <h2>League members</h2>
      <p class="small muted">${d.emailEnabled ? 'Password-reset emails are on.' : 'Password-reset emails are <b>off</b> (no SMTP server configured). Use <b>Reset link</b> and send the link to the player yourself.'}</p>
      <table class="standings"><thead><tr><th>Username</th><th>Email</th><th>Precon</th><th>Joined</th><th></th></tr></thead>
      <tbody>${d.users.map(u => `<tr><td><b>${esc(u.username)}</b>${u.isAdmin ? ' <span class="chip gold">admin</span>' : ''}</td><td class="small">${esc(u.email) || '<span class="dim">—</span>'}</td><td class="small muted">${esc(u.precon) || '—'}</td><td class="small muted">${new Date(u.createdAt).toLocaleDateString()}</td>
        <td style="text-align:right">${u.id === me.id ? '' : `<button class="btn sm" data-reset="${u.id}" data-name="${esc(u.username)}">Reset link</button>`}</td></tr>`).join('')}</tbody></table>
    </div>`;
  $$('[data-reset]', view).forEach(b => b.onclick = async () => {
    try {
      const r = await post(`/admin/users/${b.dataset.reset}/reset-link`);
      const m = $('#modal');
      m.innerHTML = `<div class="box"><div class="dialog"><h2>Reset link for ${esc(b.dataset.name)}</h2>
        <p class="muted">Send this to ${esc(b.dataset.name)}. It works once, for ${r.minutes} minutes.</p>
        <pre class="list" style="white-space:pre-wrap;word-break:break-all">${esc(r.link)}</pre>
        <div class="row" style="justify-content:flex-end"><button class="btn gold" id="cpy">${I.copy} Copy link</button><button class="btn ghost" id="cls">Close</button></div></div></div>`;
      m.hidden = false;
      $('#cpy', m).onclick = async () => { await navigator.clipboard.writeText(r.link).catch(() => {}); toast(`${I.copy} Reset link copied`, 'good'); };
      $('#cls', m).onclick = () => { m.hidden = true; };
    } catch (err) { fail(err); }
  });
}

// =============== LEAGUE TAB ===============
const LIMITS = { min: 3, max: 16, podMin: 3, podMax: 4 };
const FEED_ICONS = { win: 'crown', vote: 'vote', spin: 'wheel', pull: 'spark', clear: 'trash', end: 'flag', league: 'flag', join: 'user', leave: 'x', pod: 'play', rules: 'sliders', discard: 'x', finish: 'check' };
const LEADING_EMOJI = /^\p{Extended_Pictographic}\uFE0F?\s*/u;
const fmtWhen = iso => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
async function refreshLeague() { S.leagueDetail = null; S.history = null; S.pools = null; await Promise.all([loadState(), loadSets()]); render(); }

function joinCreateForms() {
  const canJoin = !isAdmin() && !S.myLeagueId;
  const canCreate = isAdmin() || !S.myLeagueId;
  if (!canJoin && !canCreate) return '';
  return `<div class="account-grid" style="margin-top:18px">
    ${canJoin ? `<form class="panel grid" id="joinForm">
      <h2>Join a league</h2>
      <p class="small muted" style="margin:0">Got an invite code from a friend? Enter it here. You can be in one league at a time.</p>
      <label>Invite code<input name="code" maxlength="12" autocomplete="off" required style="text-transform:uppercase;letter-spacing:.12em"></label>
      <button class="btn gold">Join league</button>
    </form>` : ''}
    ${canCreate ? `<form class="panel grid" id="createForm">
      <h2>Start a league</h2>
      <p class="small muted" style="margin:0">A league has ${LIMITS.min}–${LIMITS.max} players and runs pods of ${LIMITS.podMin}–${LIMITS.podMax}. Share its invite code to bring people in.</p>
      <label>League name<input name="name" maxlength="40" placeholder="e.g. Friday Night Commander"></label>
      <label class="check"><input type="checkbox" name="addEveryone" checked> Add every player who isn't in a league yet (up to ${LIMITS.max})</label>
      <button class="btn gold">Start league</button>
    </form>` : ''}
  </div>`;
}
function wireJoinCreate(view) {
  $('#joinForm', view)?.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const r = await post('/leagues/join', { code: new FormData(e.target).get('code').trim().toUpperCase() });
      toast(`Welcome to ${esc(r.league.name)}!`, 'good');
      await showLeague(r.league.id);
    } catch (err) { fail(err); }
  });
  $('#createForm', view)?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await post('/leagues', { name: f.get('name'), addEveryone: f.get('addEveryone') === 'on' });
      toast(`${esc(r.league.name)} is ready. Share the invite code ${esc(r.league.code || '')}.`, 'good');
      await showLeague(r.league.id);
    } catch (err) { fail(err); }
  });
}

async function renderLeague(view) {
  const l = S.league;
  if (!l) {
    view.innerHTML = `<div class="hero"><div><h1>League</h1><p>Pods belong to a league: ${LIMITS.min}–${LIMITS.max} players who play pods of ${LIMITS.podMin}–${LIMITS.podMax}, keep their own card pools, standings and wheel. ${isAdmin() ? 'Start one below.' : "You're not in one yet."}</p></div></div>${joinCreateForms()}`;
    wireJoinCreate(view);
    return;
  }
  if (!S.leagueDetail || S.leagueDetail.league.id !== l.id) {
    view.innerHTML = '<div class="spinner"></div>';
    try {
      const d = await api(`/leagues/${l.id}`);
      if (isAdmin() && d.league.status === 'active') d.candidates = (await api(`/leagues/${l.id}/candidates`)).players;
      S.leagueDetail = d;
    } catch (err) { fail(err); return; }
    if (S.route !== 'league') return;
  }
  const { league, standings, events, candidates = [] } = S.leagueDetail;
  const active = league.status === 'active';
  const lim = league.limits || LIMITS;
  const r = league.rules;
  view.innerHTML = `
    <div class="hero">
      <div><h1>${esc(league.name)}</h1>
        <p>${active ? `Started ${fmtDate(league.createdAt)}${league.createdBy ? ` by ${esc(league.createdBy)}` : ''}.${league.leagueAdmin ? ` League admin: <b>${esc(league.leagueAdmin.username)}</b>.` : ''}` : `Ended ${fmtDate(league.endedAt)}. Its standings, history and pools stay here as an archive.`}
        ${plural(league.members.length, 'player')} of ${lim.max}.</p></div>
      <div class="row">
        ${league.code && active ? `<div class="code-box" title="Friends join with this code on the League tab"><span class="small muted">Invite code</span><b>${esc(league.code)}</b><button class="btn sm" id="copyCode">${I.copy} Copy</button></div>` : ''}
        ${league.isMember && active ? `<button class="btn danger sm" id="leaveL">Leave league</button>` : ''}
      </div>
    </div>
    ${active && league.members.length < lim.min ? `<div class="panel warn-box">${esc(league.name)} needs at least ${lim.min} players before a pod can start. Share the invite code.</div>` : ''}
    ${!league.isMember && !isAdmin() ? `<div class="panel warn-box">You're viewing ${esc(league.name)}. ${S.myLeagueId ? '' : active ? 'Ask a member for its invite code to join.' : ''}</div>` : ''}
    <div class="league-grid">
      <section class="panel" style="overflow-x:auto">
        <h2>Standings</h2>
        ${standings.some(s => s.pods || s.missed) ? `<table class="standings"><thead><tr><th>Player</th><th class="num">Pods</th><th class="num">Wins</th><th class="num">Win %</th><th class="num" title="Bonus-pack votes won">${I.vote}</th><th class="num" title="Pods missed (absent packs)">Missed</th><th class="num">Packs</th><th class="num">Rares</th><th class="num">Mythics</th></tr></thead>
          <tbody>${standings.map((s, i) => `<tr class="${s.active ? '' : 'dim'}"><td>${i === 0 && s.wins ? `${I.crown} ` : ''}<b>${esc(s.name)}</b>${s.active ? '' : ' <span class="small">(left)</span>'}</td><td class="num">${s.pods}</td><td class="num">${s.wins}</td><td class="num">${s.pods ? Math.round(s.wins / s.pods * 100) + '%' : '—'}</td><td class="num">${s.voteWins}</td><td class="num">${s.missed}</td><td class="num">${s.packs}</td><td class="num">${s.rares}</td><td class="num">${s.mythics}</td></tr>`).join('')}</tbody></table>`
          : '<p class="muted">No finished pods yet. Standings fill in as pods are finished.</p>'}
      </section>
      <section class="panel">
        <div class="spread"><h2 style="margin:0">Players</h2><span class="small muted">${league.members.length}/${lim.max}</span></div>
        <div class="member-list">${league.members.map(m => `<div class="member"><div><b>${esc(m.username)}</b>${m.leagueAdmin ? ' <span class="chip gold" title="Started the league: can change its rules and kick players">League admin</span>' : ''}${m.id === S.me.id ? ' <span class="dim small">(you)</span>' : ''}<div class="small muted">${esc(m.precon) || 'No precon set'}</div></div>
          ${league.canManage && active && m.id !== S.me.id ? `<button class="btn ghost sm" data-rmm="${m.id}" data-name="${esc(m.username)}" title="Kick from the league">✕</button>` : ''}</div>`).join('') || '<p class="muted">Nobody yet.</p>'}</div>
        ${isAdmin() && active ? `<div class="row" style="margin-top:10px">${candidates.length ? `<select class="input" id="addMember"><option value="">Add a player…</option>${candidates.map(c => `<option value="${c.id}">${esc(c.username)}</option>`).join('')}</select><button class="btn sm" id="addMemberBtn">Add</button>` : '<span class="small muted">Every player is already in a league.</span>'}</div>` : ''}
      </section>
      <section class="panel">
        <h2>Rules</h2>
        ${league.canManage && active ? `<form id="rulesForm" class="grid" style="gap:10px">
          ${isAdmin() ? `<label>League name<input name="name" value="${esc(league.name)}" maxlength="40"></label>` : '<p class="small muted" style="margin:0">You started this league, so you set its rules.</p>'}
          <div class="rules-grid">
            <label>Winner packs<input type="number" name="winnerPacks" min="0" max="10" value="${r.winnerPacks}"></label>
            <label>Everyone else<input type="number" name="loserPacks" min="0" max="10" value="${r.loserPacks}"></label>
            <label>Missed a pod<input type="number" name="absentPacks" min="0" max="5" value="${r.absentPacks}"></label>
            <label>Vote bonus<input type="number" name="voteBonus" min="0" max="5" value="${r.voteBonus}"></label>
          </div>
          <p class="small muted" style="margin:0">0 turns absent packs or the vote off. Running pods keep the rules they started with.</p>
          <button class="btn gold">Save rules</button>
        </form>` : `<ul class="rules-list">
          <li>${I.crown} Winner: <b>${plural(r.winnerPacks, 'pack')}</b></li>
          <li>Everyone else in the pod: <b>${plural(r.loserPacks, 'pack')}</b></li>
          <li>${I.vote} Bonus-pack vote: ${r.voteBonus ? `<b>+${plural(r.voteBonus, 'pack')}</b>` : 'off'}</li>
          <li>${I.pack} Missed a pod: ${r.absentPacks ? `<b>${plural(r.absentPacks, 'pack')}</b> of the spun set` : 'nothing'}</li>
          <li>${I.wheel} One spin per pod, by the winner. Pods have ${lim.podMin}–${lim.podMax} players.</li>
        </ul>`}
      </section>
      <section class="panel">
        <h2>Activity</h2>
        <div class="feed">${events.map(e => `<div class="feed-item"><span>${fmtWhen(e.at)}</span>${I[FEED_ICONS[e.kind] || 'dot']}<span>${esc(e.text.replace(LEADING_EMOJI, ''))}</span></div>`).join('') || '<p class="muted">Nothing yet.</p>'}</div>
      </section>
    </div>
    ${isAdmin() ? `<div class="panel" style="margin-top:18px"><h2>Admin</h2><div class="row">
      ${active ? `<button class="btn" id="newCode">New invite code</button><button class="btn danger" id="endL">End league</button>` : ''}
      <button class="btn danger" id="delL">${I.trash} Delete league</button></div>
      <p class="small muted" style="margin:8px 0 0">Ending keeps everything as a read-only archive and frees the players to join another league. Deleting removes the league with all its pods, packs and pools.</p></div>` : ''}
    ${joinCreateForms()}`;
  wireJoinCreate(view);
  $('#copyCode', view)?.addEventListener('click', async () => {
    const text = `Join "${league.name}" on Pre-Con Commander: ${location.origin}  (League tab, invite code ${league.code})`;
    try { await navigator.clipboard.writeText(text); } catch { /* shown below anyway */ }
    toast(`${I.copy} Invite copied: code <b>${esc(league.code)}</b>`, 'good');
  });
  $('#leaveL', view)?.addEventListener('click', async () => {
    if (!await confirmBox(`Leave ${esc(league.name)}?`, 'You stop getting packs for missed pods and can join or start another league. Your past pods stay in its history.', 'Leave league', true)) return;
    try { await post(`/leagues/${league.id}/leave`); S.viewLeague = null; await refreshLeague(); } catch (err) { fail(err); }
  });
  $$('[data-rmm]', view).forEach(b => b.onclick = async () => {
    if (!await confirmBox(`Kick ${esc(b.dataset.name)}?`, `${esc(b.dataset.name)} is removed from ${esc(league.name)}. Their past pods and pool stay in its history. The invite code won't let them back in; only the site admin can re-add them.`, 'Kick', true)) return;
    try { await del(`/leagues/${league.id}/members/${b.dataset.rmm}`); await refreshLeague(); } catch (err) { fail(err); }
  });
  $('#addMemberBtn', view)?.addEventListener('click', async () => {
    const userId = $('#addMember', view).value;
    if (!userId) return;
    try { await post(`/leagues/${league.id}/members`, { userId }); await refreshLeague(); } catch (err) { fail(err); }
  });
  $('#rulesForm', view)?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const rules = Object.fromEntries(['winnerPacks', 'loserPacks', 'absentPacks', 'voteBonus'].map(k => [k, Number(f[k])]));
    try { await api(`/leagues/${league.id}`, { method: 'PUT', body: { ...(f.name != null ? { name: f.name } : {}), rules } }); toast('Rules saved.', 'good'); await refreshLeague(); } catch (err) { fail(err); }
  });
  $('#newCode', view)?.addEventListener('click', async () => {
    if (!await confirmBox('New invite code?', 'The old code stops working.', 'New code')) return;
    try { await post(`/leagues/${league.id}/code`); await refreshLeague(); } catch (err) { fail(err); }
  });
  $('#endL', view)?.addEventListener('click', async () => {
    if (!await typedConfirm(`End ${esc(league.name)}?`, 'The league becomes a read-only archive (standings, history, pools) and its players can join other leagues. Running pods must be finished first.', 'END', 'End league')) return;
    try { await post(`/leagues/${league.id}/end`); await refreshLeague(); } catch (err) { fail(err); }
  });
  $('#delL', view)?.addEventListener('click', async () => {
    if (!await typedConfirm(`Delete ${esc(league.name)}?`, 'This permanently deletes the league with every pod, pack, vote and pool card in it.', 'DELETE', `${I.trash} Delete league`)) return;
    try { await del(`/leagues/${league.id}`); S.viewLeague = null; await refreshLeague(); toast('League deleted.', 'good'); } catch (err) { fail(err); }
  });
}

// =============== PODS TAB ===============
// Packs waiting for me anywhere in my league (including pods I missed).
function pendingBanner() {
  if (!S.pending.length || S.viewLeague !== S.myLeagueId) return '';
  return `<div class="panel pending">
    <h3 style="margin:0 0 8px">${I.pack} ${plural(S.pending.length, 'pack')} waiting for you</h3>
    <div class="row">${S.pending.map(k => `<a class="chip" href="#packs?pod=${k.podId}&player=${S.me.id}&pack=${k.packId}">${k.status === 'choosing' ? `${I.question}` : icon(k.set)} ${k.status === 'choosing' ? 'Choose a set' : esc(k.set?.name || '')} <span class="dim">· ${esc(k.podName)}${k.absent ? ' (missed)' : ''}</span></a>`).join('')}</div>
  </div>`;
}

function renderPods(view) {
  const l = S.league;
  if (!l) { view.innerHTML = `<div class="empty"><h2>You're not in a league yet</h2><p>Pods belong to a league. Join one with an invite code or start your own.</p><a class="btn gold" href="#league">Go to League</a></div>`; return; }
  const r = l.rules;
  const mine = myPod();
  const canStart = l.status === 'active' && (l.isMember || isAdmin());
  view.innerHTML = `
    <div class="hero"><div>
      <h1>${esc(l.name)} · Pods</h1>
      <p>A pod is one game of ${LIMITS.podMin}–${LIMITS.podMax} league players, each on their precon. When it ends, the winner gets <b>${plural(r.winnerPacks, 'pack')}</b> and everyone else gets <b>${r.loserPacks}</b>${r.voteBonus ? `, and the pod votes someone a <b>+${r.voteBonus}</b> bonus` : ''}. The winner spins the wheel <b>once</b>: every pack is that set (or <b>Sacrifice a Pack</b> to pick any set)${r.absentPacks ? `, and league members who missed the pod get <b>${plural(r.absentPacks, 'pack')}</b> of it too` : ''}.</p>
    </div></div>
    ${pendingBanner()}
    ${S.pods.length ? `<div class="grid" style="gap:18px;margin-bottom:24px">${S.pods.map(podPanel).join('')}</div>` : ''}
    ${l.status !== 'active' ? `<div class="panel muted">${esc(l.name)} has ended, so no new pods. Its history and pools are still here.</div>` : canStart && !mine ? newPodForm() : ''}`;
  wirePods(view);
}

function newPodForm() {
  const busy = new Map(S.pods.flatMap(pod => pod.players.map(p => [p.id, pod.name])));
  const free = S.members.filter(m => !busy.has(m.id));
  if (free.length < LIMITS.podMin) return `<div class="panel"><h2>Start a pod</h2><p class="muted">${S.members.length < LIMITS.podMin ? `A pod needs ${LIMITS.podMin} league players. Share the invite code on the <a href="#league">League tab</a>.` : `Not enough free players for a pod of ${LIMITS.podMin} right now.`}</p></div>`;
  return `<form class="panel player-form" id="newPod">
      <h2>Start a pod</h2>
      <div class="pf-rows"></div>
      <div class="spread" style="margin-top:6px">
        <button type="button" class="btn ghost sm" id="addP">+ Add player</button>
        <button class="btn gold big">Start pod</button>
      </div>
    </form>`;
}

function memberOptions(selected) {
  const busy = new Map(S.pods.flatMap(pod => pod.players.map(p => [p.id, pod.name])));
  return `<option value="">Pick a player…</option>` + S.members.map(m =>
    `<option value="${m.id}" ${m.id === selected ? 'selected' : ''} ${busy.has(m.id) ? 'disabled' : ''}>${esc(m.username)}${busy.has(m.id) ? ` (in ${esc(busy.get(m.id))})` : ''}</option>`).join('');
}

function wirePods(view) {
  const form = $('#newPod', view);
  if (form) {
    const rows = $('.pf-rows', form);
    const addRow = (userId = '') => {
      const n = rows.children.length + 1;
      const d = document.createElement('div');
      d.className = 'pf-row';
      const m = S.members.find(x => x.id === userId);
      d.innerHTML = `<span class="num">${n}</span>
        <select class="input" name="userId" ${isAdmin() || n > 1 ? '' : 'disabled'}>${memberOptions(userId)}</select>
        <input type="text" class="precon" name="precon" placeholder="Precon / commander" value="${esc(m?.precon || '')}" maxlength="80">
        <button type="button" class="btn ghost sm rm" title="Remove" ${n === 1 && !isAdmin() ? 'disabled' : ''}>✕</button>`;
      $('select', d).onchange = e => { const mm = S.members.find(x => x.id === e.target.value); $('.precon', d).value = mm?.precon || ''; };
      $('.rm', d).onclick = () => { if (rows.children.length > LIMITS.podMin) { d.remove(); $$('.num', rows).forEach((e, i) => e.textContent = i + 1); } };
      rows.append(d);
    };
    // The admin doesn't play, so their form starts empty.
    if (isAdmin()) { addRow(); addRow(); addRow(); } else { addRow(S.me.id); addRow(); addRow(); }
    $('#addP', form).onclick = () => rows.children.length < LIMITS.podMax ? addRow() : toast(`A pod has at most ${LIMITS.podMax} players.`, 'err');
    form.onsubmit = async e => {
      e.preventDefault();
      const players = $$('.pf-row', rows).map(r => ({ userId: $('select', r).value, precon: $('.precon', r).value }));
      if (players.some(p => !p.userId)) return toast('Pick a league member for every row (or remove the empty row).', 'err');
      try { const r = await post('/pods', { players, league: S.league?.id }); S.podId = r.pod.id; await loadState(); render(); toast(`${esc(r.pod.name)} is on. Good luck!`, 'good'); } catch (err) { fail(err); }
    };
  }
  $$('[data-win]', view).forEach(b => b.onclick = async () => {
    const pod = podById(b.dataset.pod), p = pod.players.find(x => x.id === b.dataset.win);
    if (!await confirmBox(`Crown <b>${esc(p.name)}</b> the winner?`, `${esc(p.name)} gets ${plural(pod.rules.winnerPacks, 'pack')}, everyone else gets ${pod.rules.loserPacks}, and ${esc(p.name)} spins the wheel for the whole pod.`, `Crown winner ${I.crown}`)) return;
    try { await post(`/pods/${pod.id}/winner`, { playerId: p.id }); await loadState(); render(); } catch (err) { fail(err); }
  });
  $$('[data-award]', view).forEach(b => b.onclick = async () => {
    try { await post(`/pods/${b.dataset.pod}/award`, { playerId: b.dataset.award, delta: Number(b.dataset.delta) }); await loadState(); render(); } catch (err) { fail(err); }
  });
  $$('[data-finish]', view).forEach(b => b.onclick = async () => {
    const pod = podById(b.dataset.finish);
    const left = pod.players.reduce((s, p) => s + p.packs.filter(k => k.status !== 'opened').length, 0) + (pod.spin ? 0 : pod.players.reduce((s, p) => s + p.awarded, 0));
    const msg = left ? `There are still <b>${left}</b> unopened packs. They'll be saved in History as-is and won't be in anyone's pool.` : 'All packs are opened. This saves the pod to History.';
    if (!await confirmBox(`Finish ${esc(pod.name)}?`, msg, 'Finish & save')) return;
    try { await post(`/pods/${pod.id}/finish`); S.history = null; S.pools = null; await loadState(); go('#history'); } catch (err) { fail(err); }
  });
  $$('[data-delete]', view).forEach(b => b.onclick = () => deletePodFlow(podById(b.dataset.delete)));
  $$('[data-vote]', view).forEach(b => b.onclick = async () => {
    b.disabled = true;
    try {
      S.justVoted = Date.now();
      const r = await post(`/pods/${b.dataset.vote}/vote`, { candidateId: b.dataset.cand });
      S.pods = S.pods.map(x => x.id === r.pod.id ? r.pod : x);
      render();
      if (r.result === 'tied') toast(`${I.vote} It's a tie: re-vote between the tied players.`, 'good');
      if (r.result === 'decided') toast(`${I.vote} ${esc(nameIn(r.pod, r.pod.vote.winnerId))} wins the bonus pack!`, 'good');
    } catch (err) { fail(err); b.disabled = false; }
  });
  $$('[data-skipvote]', view).forEach(b => b.onclick = async () => {
    if (!await confirmBox('Skip the vote?', 'Nobody gets the bonus pack, and the winner can spin right away.', 'Skip vote', true)) return;
    try { await post(`/pods/${b.dataset.skipvote}/vote/skip`); await loadState(); render(); } catch (err) { fail(err); }
  });
  $$('[data-discard]', view).forEach(b => b.onclick = async () => {
    const pod = podById(b.dataset.discard);
    if (!await confirmBox(`Discard ${esc(pod.name)}?`, 'It will not be saved to History, and any opened cards leave the players\' pools.', 'Discard', true)) return;
    try { await post(`/pods/${pod.id}/discard`); S.pools = null; await loadState(); render(); } catch (err) { fail(err); }
  });
}

// Big, irreversible admin actions ask for a typed word instead of one click.
function typedConfirm(title, body, word, okLabel) {
  return new Promise(resolve => {
    const m = $('#modal');
    m.innerHTML = `<div class="box"><div class="dialog">
      <h2>${title}</h2><p class="muted">${body}</p>
      <label class="small muted">Type <b>${word}</b> to confirm<input id="typed" autocomplete="off" style="width:100%;margin-top:6px"></label>
      <div class="row" style="justify-content:flex-end;margin-top:14px">
        <button class="btn ghost" data-r="0">Cancel</button>
        <button class="btn danger" data-r="1" disabled>${okLabel}</button>
      </div></div></div>`;
    m.hidden = false;
    const ok = $('[data-r="1"]', m);
    $('#typed', m).oninput = e => { ok.disabled = e.target.value.trim() !== word; };
    $('#typed', m).focus();
    const done = v => { m.hidden = true; m.innerHTML = ''; resolve(v); };
    $$('[data-r]', m).forEach(b => b.onclick = () => done(b.dataset.r === '1'));
    m.onclick = e => { if (e.target === m) done(false); };
  });
}
async function afterAdminDelete(msg) {
  S.history = null; S.pools = null;
  await loadState();
  render();
  toast(msg, 'good');
}
async function deletePackFlow(podId, pack, owner) {
  const n = pack.cards?.length || 0;
  if (!await confirmBox(`Delete ${esc(owner.name)}'s ${esc(pack.set?.name || '')} pack?`,
    `The pack is removed from the pod${n ? ` and its <b>${n} cards</b> leave ${esc(owner.name)}'s pool` : ''}. It can't be undone.`, `${I.trash} Delete pack`, true)) return;
  try { await del(`/pods/${podId}/packs/${pack.id}`); await afterAdminDelete('Pack deleted.'); } catch (err) { fail(err); }
}
async function deleteCardFlow(c) {
  if (!await confirmBox(`Remove ${esc(c.name)}?`, `One copy of <b>${esc(c.name)}</b>${c.foil ? ' (foil)' : ''} is removed from the player's pool and from its pack's pulls. It can't be undone.`, `${I.trash} Remove card`, true)) return;
  try { await del(`/pool-cards/${c.id}`); $('#modal').hidden = true; await afterAdminDelete(`${esc(c.name)} removed.`); } catch (err) { fail(err); }
}

// ---- bonus-pack vote ----
const voteOpen = pod => pod.vote?.status === 'open';
const nameIn = (pod, id) => pod.players.find(p => p.id === id)?.name || '?';
function roundLine(pod, r) {
  const counts = r.candidates.map(c => `${esc(nameIn(pod, c))} <b>${r.tally[c]}</b>`).join(' · ');
  return `<div class="small muted">Round ${r.round}: ${counts}${r.tied ? ` → tie, re-vote between ${r.tied.map(c => esc(nameIn(pod, c))).join(' and ')}` : ''}</div>`;
}
function votePanel(pod) {
  const v = pod.vote;
  if (!v || pod.status !== 'awarded' && v.status === 'open') return '';
  const past = v.rounds.map(r => roundLine(pod, r)).join('');
  if (v.status === 'done') {
    return `<div class="vote-box done"><div><b>${I.vote} ${esc(nameIn(pod, v.winnerId))} won the vote</b> and gets <b>+${v.bonus} pack</b>.</div>${past ? `<details><summary class="small muted">How it went</summary>${past}</details>` : ''}</div>`;
  }
  if (v.status === 'skipped') {
    return `<div class="vote-box done small muted">${I.vote} ${pod.players.length < 3 ? 'No bonus-pack vote: 2-player pods skip it (each player could only vote for the other).' : 'The bonus-pack vote was skipped by the admin.'}</div>`;
  }
  const cur = v.current;
  const me = pod.players.find(p => p.id === S.me.id);
  const tied = cur.round > 1 ? v.rounds.at(-1).tied : null;
  return `<div class="vote-box">
    <div class="spread"><h3 style="margin:0">${I.vote} Bonus pack vote${cur.round > 1 ? ` · re-vote ${cur.round - 1}` : ''}</h3>
      <span class="small muted">${cur.voted.length} of ${pod.players.length} voted</span></div>
    <p class="small muted" style="margin:6px 0 10px">${tied
      ? `Tied between ${tied.map(c => `<b>${esc(nameIn(pod, c))}</b>`).join(' and ')}. Everyone votes again, between them only.`
      : `Everyone votes for the player who earns <b>+${v.bonus} pack</b>. You can't vote for yourself. Ballots stay secret until everyone has voted; a tie means a re-vote.`}</p>
    ${me ? `<div class="vote-opts">${cur.candidates.filter(c => c !== me.id).map(c => `<button class="btn ${cur.myVote === c ? 'gold' : ''}" data-vote="${pod.id}" data-cand="${c}">${cur.myVote === c ? '✓ ' : ''}${esc(nameIn(pod, c))}</button>`).join('')}</div>
      <div class="small muted" style="margin-top:6px">${cur.myVote ? `You voted for <b>${esc(nameIn(pod, cur.myVote))}</b>. You can change it until the last vote is in.` : 'Tap a player to vote.'}</div>`
      : '<div class="small muted">Only the players in this pod vote.</div>'}
    <div class="row" style="margin-top:10px;gap:6px">${pod.players.map(p => `<span class="chip ${cur.voted.includes(p.id) ? 'ok' : ''}">${cur.voted.includes(p.id) ? '✓' : '…'} ${esc(p.name)}</span>`).join('')}</div>
    ${past ? `<div style="margin-top:8px">${past}</div>` : ''}
    ${isAdmin() ? `<div style="margin-top:10px"><button class="btn ghost sm" data-skipvote="${pod.id}">Skip vote (admin, no bonus pack)</button></div>` : ''}
  </div>`;
}

// Admin: permanently delete a pod and everything in it (packs, pulls, pool cards).
async function deletePodFlow(pod) {
  const cards = pod.players.reduce((s, p) => s + p.packs.reduce((t, k) => t + (k.cards?.length || 0), 0), 0);
  if (!await confirmBox(`Delete ${esc(pod.name)} for good?`,
    `This permanently removes ${esc(pod.name)}${pod.status === 'done' ? ' from History' : ''}, its spin and every pack in it${cards ? `, and takes its <b>${cards} opened cards</b> out of the players' pools` : ''}. It can't be undone.`,
    `${I.trash} Delete pod`, true)) return;
  try { await del(`/pods/${pod.id}`); S.history = null; S.pools = null; await loadState(); render(); toast(`${esc(pod.name)} deleted.`, 'good'); } catch (err) { fail(err); }
}

function podPanel(pod) {
  const member = pod.players.some(p => p.id === S.me.id) || isAdmin();
  const winner = pod.players.find(p => p.id === pod.winnerId);
  let head;
  if (pod.status === 'playing') head = `Playing since ${new Date(pod.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. When the game ends, crown the winner.`;
  else if (voteOpen(pod)) head = `${I.crown} ${esc(winner.name)} won. Now vote for who gets the bonus pack, then ${esc(winner.name)} spins.`;
  else if (!pod.spin) head = `${I.crown} ${esc(winner.name)} won and spins the wheel for the whole pod.`;
  else head = `${icon(pod.spin.set)} Spun <b>${esc(pod.spin.set.name)}</b>. Everyone opens that set, or sacrifices a pack to pick any set.`;
  return `<div class="panel pod">
    <div class="spread pod-head">
      <div><h2 style="margin:0">${esc(pod.name)}</h2><div class="small muted">${head}</div></div>
      <div class="row">
        ${pod.status === 'awarded' && !pod.spin && !voteOpen(pod) ? `<a class="btn gold" href="#wheel?pod=${pod.id}">${S.me.id === pod.winnerId ? 'Spin the wheel →' : 'Watch the spin →'}</a>` : ''}
        ${pod.spin ? `<a class="btn gold" href="#packs?pod=${pod.id}">Open packs →</a>` : ''}
        ${member && pod.status === 'awarded' ? `<button class="btn" data-finish="${pod.id}">Finish pod</button>` : ''}
        ${member ? `<button class="btn danger sm" data-discard="${pod.id}">Discard</button>` : ''}
        ${isAdmin() ? `<button class="btn danger sm" data-delete="${pod.id}" title="Admin: delete this pod permanently">${I.trash} Delete</button>` : ''}
      </div>
    </div>
    ${votePanel(pod)}
    <div class="players">${pod.players.map(p => playerCard(p, pod, member)).join('')}</div>
    ${absentLine(pod)}
  </div>`;
}

// League members who aren't in the pod get packs of the spun set.
function absentLine(pod) {
  const n = pod.rules?.absentPacks || 0;
  if (pod.spin) {
    if (!pod.absentees?.length) return '';
    return `<div class="absent-line small muted">${I.pack} Missed it, ${plural(n, 'pack')} each: ${pod.absentees.map(a => `<a class="chip" href="#packs?pod=${pod.id}&player=${a.id}">${esc(a.name)} · ${a.packs.filter(k => k.status === 'opened').length}/${a.packs.length} opened</a>`).join(' ')}</div>`;
  }
  const others = S.members.filter(m => !pod.players.some(p => p.id === m.id));
  return n && others.length ? `<div class="absent-line small muted">${I.pack} ${names(others.map(m => esc(m.username)))} ${others.length === 1 ? 'is' : 'are'} not in this pod and will get ${plural(n, 'pack')} of the spun set.</div>` : '';
}
const names = list => list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;

function playerCard(p, pod, member) {
  const won = pod.winnerId === p.id;
  const pips = pod.spin ? [
    ...p.packs.map(k => `<span class="pip ${k.status === 'opened' ? 'opened' : 'ready'}" title="${esc(k.set?.name || 'Choosing a set…')}">${k.status === 'choosing' ? '?' : `<img src="${esc(k.set.icon || '')}" alt="">`}</span>`),
    ...Array.from({ length: p.sacrificed }, () => `<span class="pip sac" title="Sacrificed"></span>`),
  ].join('') : Array.from({ length: p.awarded }, () => `<span class="pip unspun" title="Waiting for the spin"></span>`).join('');
  const opened = p.packs.filter(k => k.status === 'opened').length;
  return `<div class="pcard ${won ? 'winner' : ''} ${p.id === S.me.id ? 'me' : ''}">
    ${won ? `<span class="crown">${I.crown}</span>` : ''}
    <div>
      <div class="pname">${esc(p.name)}${p.id === S.me.id ? ' <span class="dim small">(you)</span>' : ''}${pod.vote?.winnerId === p.id ? ` <span class="chip gold" title="Won the bonus-pack vote">${I.vote} +1</span>` : ''}</div>
      ${p.precon ? `<div class="precon">${esc(p.precon)}</div>` : ''}
    </div>
    ${pod.status === 'playing'
      ? (member ? `<button class="btn gold" data-pod="${pod.id}" data-win="${p.id}">${I.crown} Won the game</button>` : '<span class="dim small">Playing…</span>')
      : `<div class="pips">${pips || '<span class="dim small">No packs</span>'}</div>
         <div class="stat-line"><span><b>${pod.spin ? p.packs.length : p.awarded}</b> pack${(pod.spin ? p.packs.length : p.awarded) === 1 ? '' : 's'}</span><span><b>${opened}</b> opened</span>${p.sacrificed ? `<span><b>${p.sacrificed}</b> sacrificed</span>` : ''}</div>
         <div class="row">
           ${pod.spin ? `<a class="btn sm ${canAct(p) && p.packs.some(k => k.status !== 'opened') ? 'gold' : ''}" href="#packs?pod=${pod.id}&player=${p.id}">Packs</a>` : ''}
           <span style="flex:1"></span>
           ${isAdmin() ? `<button class="btn ghost sm" data-pod="${pod.id}" data-award="${p.id}" data-delta="-1" title="Remove a pack (admin)">−</button>
           <button class="btn ghost sm" data-pod="${pod.id}" data-award="${p.id}" data-delta="1" title="Add a pack (admin)">+</button>` : ''}
         </div>`}
  </div>`;
}

// =============== WHEEL TAB ===============
const PALETTE = ['#1b1f26', '#ff5b1f', '#2c323c', '#14171c', '#e8e8e2', '#222730', '#3a414d', '#33c9ff', '#181b21'];
const LIGHT_SEGMENTS = ['#e8e8e2', '#33c9ff', '#ff5b1f'];
let wheelGeom = [];   // [{code, a0, a1, color}]
let raf = null, audioCtx = null;

function buildGeom() {
  const total = S.wheel.reduce((s, w) => s + w.weight, 0) || 1;
  let a = 0;
  wheelGeom = S.wheel.map((w, i) => {
    const span = (w.weight / total) * Math.PI * 2;
    const seg = { code: w.code, a0: a, a1: a + span, color: PALETTE[i % PALETTE.length] };
    a += span;
    return seg;
  });
  // Avoid same-coloured neighbours at the seam.
  const n = wheelGeom.length;
  if (n > 2 && wheelGeom[0].color === wheelGeom[n - 1].color) {
    wheelGeom[n - 1].color = PALETTE.find(c => c !== wheelGeom[0].color && c !== wheelGeom[n - 2].color);
  }
}

function drawWheel() {
  const cv = $('#wheelCanvas');
  if (!cv) return;
  const size = cv.clientWidth, dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(size * dpr)) { cv.width = cv.height = Math.round(size * dpr); }
  const ctx = cv.getContext('2d');
  const R = size / 2;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(R, R);
  // outer ring
  ctx.beginPath(); ctx.arc(0, 0, R - 1, 0, Math.PI * 2);
  ctx.fillStyle = '#000'; ctx.fill();
  const r = R - 12;
  ctx.strokeStyle = '#ff5b1f'; ctx.lineWidth = 2;
  for (let t = 0; t < 48; t++) {
    const a = (t / 48) * Math.PI * 2, len = t % 4 ? 3 : 7;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * (R - 2), Math.sin(a) * (R - 2)); ctx.lineTo(Math.cos(a) * (R - 2 - len), Math.sin(a) * (R - 2 - len)); ctx.stroke();
  }
  ctx.rotate(S.rot);
  if (!wheelGeom.length) {
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fillStyle = '#1b1f26'; ctx.fill();
  }
  for (const seg of wheelGeom) {
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r, seg.a0, seg.a1); ctx.closePath();
    ctx.fillStyle = seg.color; ctx.fill();
    if (wheelGeom.length < 400) { ctx.strokeStyle = '#000'; ctx.lineWidth = wheelGeom.length > 120 ? 0.5 : 1.2; ctx.stroke(); }
    const span = seg.a1 - seg.a0;
    const fontPx = Math.min(16, Math.max(8, span * r * 0.55));
    if (span * r > 9) {
      ctx.save();
      ctx.rotate((seg.a0 + seg.a1) / 2);
      ctx.fillStyle = LIGHT_SEGMENTS.includes(seg.color) ? '#000' : '#f1f1ec';
      ctx.font = `700 ${fontPx * 1.1}px 'Barlow Condensed', sans-serif`;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      const label = (span * r > 70 ? (S.setsByCode.get(seg.code)?.name || seg.code) : seg.code).toUpperCase();
      const maxW = r * 0.62;
      let text = label;
      while (ctx.measureText(text).width > maxW && text.length > 4) text = text.slice(0, -2);
      if (text !== label) text = text.trimEnd() + '…';
      ctx.fillText(text, r - 10, 0);
      ctx.restore();
    }
  }
  ctx.restore();
  // inner shadow
  const sh = ctx.createRadialGradient(R, R, r * 0.6, R, R, r);
  sh.addColorStop(0, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,.35)');
  ctx.beginPath(); ctx.arc(R, R, r, 0, Math.PI * 2); ctx.fillStyle = sh; ctx.fill();
  paintTicker();
}

const TAU = Math.PI * 2;
const norm = a => ((a % TAU) + TAU) % TAU;
function segUnderPointer() {
  const a = norm(-Math.PI / 2 - S.rot);
  return wheelGeom.find(s => a >= s.a0 && a < s.a1) || wheelGeom[0];
}
let lastTick = null;
function paintTicker() {
  const t = $('#ticker');
  if (!t) return;
  const seg = segUnderPointer();
  if (!seg) { t.innerHTML = '<span class="muted">Wheel is empty — the admin needs to loosen the filters</span>'; return; }
  if (seg.code !== lastTick || t.dataset.code !== seg.code) {
    lastTick = seg.code;
    t.dataset.code = seg.code;
    const set = S.setsByCode.get(seg.code);
    t.innerHTML = `${icon(set)}<span>${esc(set?.name || seg.code)}</span>`;
    if (S.spinning) tick();
  }
}
function tick() {
  if (!S.sound) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'triangle'; o.frequency.value = 1400 + Math.random() * 200;
    g.gain.setValueAtTime(0.05, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.05);
    o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.05);
  } catch { /* no audio */ }
}
function fanfare() {
  if (!S.sound) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    [523, 659, 784, 1047].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t0 = audioCtx.currentTime + i * 0.09;
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.08, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
      o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.45);
    });
  } catch { /* no audio */ }
}

function stopWheelLoop() { if (raf) cancelAnimationFrame(raf); raf = null; }

function animateSpin(spin) {
  return new Promise(resolve => {
    const seg = wheelGeom.find(s => s.code === spin.setCode);
    if (!seg) { resolve(); return; }
    S.spinning = true;
    const target = seg.a0 + (seg.a1 - seg.a0) * (0.15 + 0.7 * (spin.offset ?? Math.random()));
    const start = S.rot;
    const end = start + TAU * 7 + norm(-Math.PI / 2 - target - start);
    const dur = 6800, t0 = performance.now();
    const ease = t => 1 - Math.pow(1 - t, 4);
    const step = now => {
      const t = Math.min(1, (now - t0) / dur);
      S.rot = start + (end - start) * ease(t);
      drawWheel();
      if (t < 1 && $('#wheelCanvas')) raf = requestAnimationFrame(step);
      else { S.rot = norm(end); S.spinning = false; drawWheel(); resolve(); }
    };
    stopWheelLoop();
    raf = requestAnimationFrame(step);
  });
}

// Rest the wheel on the spun set (when arriving after the spin already happened).
function restOn(spin) {
  const seg = wheelGeom.find(s => s.code === spin.setCode);
  if (seg) S.rot = norm(-Math.PI / 2 - (seg.a0 + (seg.a1 - seg.a0) * (0.15 + 0.7 * spin.offset)));
}

function podSwitcher(pod, route) {
  const list = route === 'packs' ? [...S.pods, ...S.openPods] : S.pods;
  if (list.length < 2) return '';
  return `<div class="player-tabs">${list.map(x => `<a href="#${route}?pod=${x.id}" class="${x.id === pod.id ? 'sel' : ''}">${esc(x.name)}${x.status === 'done' ? ' (finished)' : ''}${people(x).some(p => p.id === S.me.id) ? ' ★' : ''}</a>`).join('')}</div>`;
}

function renderWheel(view) {
  // With no pod running the wheel is still shown (spin locked) so everyone can
  // see which sets are on it.
  const pod = currentPod();
  buildGeom();
  if (pod?.spin && !S.spinning) restOn(pod.spin);
  const st = S.settings;
  const winner = pod?.players.find(p => p.id === pod.winnerId);
  const mayspin = !!pod && pod.status === 'awarded' && !pod.spin && !voteOpen(pod) && (isAdmin() || S.me.id === pod.winnerId);
  view.innerHTML = `
    ${pod ? podSwitcher(pod, 'wheel') : ''}
    <div class="wheel-layout">
      <div class="wheel-wrap">
        <div class="ticker" id="ticker"></div>
        <div class="wheel-stage">
          <div class="pointer"></div>
          <canvas id="wheelCanvas"></canvas>
          <button class="hub-btn" id="spinBtn">SPIN</button>
        </div>
        <p class="muted small" style="margin-top:12px">${S.wheel.length} sets on the wheel · <a href="#sets">see every set's odds</a></p>
      </div>
      <div class="side">
        ${!pod ? `<div class="panel">
          <h3>Preview: no pod running</h3>
          <p class="small muted">This is ${S.league ? `${esc(S.league.name)}'s` : 'the'} wheel: <b>${plural(S.wheel.length, 'set')}</b> anyone's pack could come from. When a pod ends, its winner spins it once and every pack in the pod is that set.</p>
          <p class="small muted" style="margin:0 0 12px">Each set's exact odds are on <a href="#sets">All Sets</a>.</p>
          ${S.league?.status === 'active' ? '<a class="btn gold" href="#pods">Start a pod</a>' : ''}
        </div>` : `<div class="panel">
          <h3>${esc(pod.name)}</h3>
          <p class="small muted" style="margin:0">${pod.status === 'playing' ? 'Still playing. Crown the winner on the Pods tab first.'
            : pod.spin ? `${esc(pod.players.find(p => p.id === pod.spin.by)?.name || winner.name)} spun the wheel. One spin per pod: every pack is this set unless sacrificed.`
            : voteOpen(pod) ? `${I.vote} The pod is voting on the bonus pack. <a href="#pods">Vote on the Pods tab</a>; the spin unlocks when it's decided.`
            : `${I.crown} <b>${esc(winner.name)}</b> spins once for the whole pod.${mayspin ? '' : ' Waiting for them to spin…'}`}</p>
        </div>`}
        <div id="revealBox"></div>
        ${isAdmin() ? `<details class="panel settings-box" ${store.get('wheelSettingsOpen', false) ? 'open' : ''}>
          <summary><span>${I.sliders} Wheel settings <span class="chip gold">admin</span></span><span class="dim small">${S.wheel.length} of ${S.sets.length} sets</span></summary>
          <div class="grid" style="gap:14px">
            <div>
              <div class="small muted" style="margin-bottom:6px">Release years</div>
              <div class="yr"><input type="number" id="minYear" min="1993" max="2100" value="${st.minYear}"> <span class="dim">to</span> <input type="number" id="maxYear" min="1993" max="2100" value="${Math.min(st.maxYear, new Date().getFullYear())}">
              <button class="btn sm ghost" data-era="2015">2015+</button><button class="btn sm ghost" data-era="2003">Modern era</button><button class="btn sm ghost" data-era="1993">All</button></div>
            </div>
            <div>
              <div class="small muted" style="margin-bottom:6px">Set types</div>
              <div class="types">${S.types.map(t => `<label><input type="checkbox" value="${t}" ${st.types.includes(t) ? 'checked' : ''}> ${typeLabel(t)}</label>`).join('')}</div>
            </div>
            <div class="spread">
              <span class="small muted">${st.excluded.length} excluded · ${Object.keys(st.weights).length} custom odds</span>
              <div class="row"><a class="btn sm" href="#sets">Per-set odds</a><button class="btn sm danger" id="resetWheel">Reset wheel</button></div>
            </div>
          </div>
        </details>` : ''}
      </div>
    </div>`;

  requestAnimationFrame(drawWheel);
  const spinBtn = $('#spinBtn', view);
  spinBtn.disabled = !mayspin || S.spinning || !S.wheel.length;
  spinBtn.title = !pod ? 'Start a pod: its winner spins when it ends' : pod.spin ? 'This pod already spun' : pod.status !== 'awarded' ? 'Crown a winner first' : voteOpen(pod) ? 'Finish the bonus-pack vote first' : !mayspin ? `Only ${winner.name} can spin` : 'Spin!';
  spinBtn.onclick = async () => {
    spinBtn.disabled = true;
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const { spin } = await post(`/pods/${pod.id}/spin`);
      S.seenSpins.add(spin.id);
      await loadState();
      await runSpin(pod.id, spin);
    } catch (err) { fail(err); renderWheel(view); }
  };
  if (isAdmin()) {
    const det = $('.settings-box', view);
    det.addEventListener('toggle', () => store.set('wheelSettingsOpen', det.open));
    const saveFilters = async extra => {
      const body = {
        minYear: Number($('#minYear', view).value), maxYear: Number($('#maxYear', view).value),
        types: $$('.types input:checked', view).map(i => i.value), ...extra,
      };
      try { await api('/settings', { method: 'PUT', body: { ...body, league: S.league?.id } }); await loadSets(); renderWheel(view); } catch (err) { fail(err); }
    };
    $('#minYear', view).onchange = () => saveFilters();
    $('#maxYear', view).onchange = () => saveFilters();
    $$('.types input', view).forEach(i => i.onchange = () => saveFilters());
    $$('[data-era]', view).forEach(b => b.onclick = () => { $('#minYear', view).value = b.dataset.era; $('#maxYear', view).value = new Date().getFullYear(); saveFilters(); });
    $('#resetWheel', view).onclick = async () => {
      if (await confirmBox('Reset the wheel?', 'Clears year/type filters, excluded sets and every custom per-set odd.', 'Reset', true)) saveFilters({ reset: true });
    };
  }
  if (pod) renderReveal(pod);
}

async function runSpin(podId, spin) {
  if (S.route !== 'wheel' || S.podId !== podId) return;
  const box = $('#revealBox');
  if (box) box.innerHTML = `<div class="reveal"><div class="inner"><span class="label">Spinning for the whole pod</span><div class="setname">…</div></div></div>`;
  const sb = $('#spinBtn'); if (sb) sb.disabled = true;
  // Draw from where the wheel was before the spin landed.
  await animateSpin(spin);
  fanfare();
  if (S.route === 'wheel') { renderWheel($('#view')); $('.reveal')?.classList.add('pop'); }
}

const artCache = new Map();
async function setArt(code) {
  if (artCache.has(code)) return artCache.get(code);
  const p = fetch(`https://api.scryfall.com/cards/random?q=${encodeURIComponent(`e:${code} (r:r OR r:m) -is:digital`)}`)
    .then(r => r.ok ? r.json() : null)
    .then(c => c?.image_uris?.art_crop || c?.card_faces?.[0]?.image_uris?.art_crop || null)
    .catch(() => null);
  artCache.set(code, p);
  return p;
}

function renderReveal(pod) {
  const box = $('#revealBox');
  if (!box) return;
  if (!pod.spin) {
    box.innerHTML = `<div class="reveal"><div class="inner"><span class="label">The wheel awaits</span><div class="setname">${pod.status === 'awarded' ? 'One spin decides the set' : 'Crown a winner first'}</div><p class="muted">${pod.status === 'awarded' ? 'Whatever it lands on, every pack in the pod is that set.' : 'Packs are handed out on the Pods tab once the game ends.'}</p></div></div>`;
    return;
  }
  const set = pod.spin.set;
  const year = (set.released || '').slice(0, 4);
  const rows = people(pod).map(p => {
    const sp = spunPacks(p).length;
    const status = p.packs.map(k => `<span class="chip">${k.status === 'choosing' ? `${I.question} choosing` : `${icon(k.set)}${k.source === 'sacrifice' ? `${I.flame} ` : ''}${k.status === 'opened' ? '✓' : ''}`}</span>`).join('');
    const mine = canAct(p);
    return `<div class="reveal-row">
      <div><b>${pod.winnerId === p.id ? `${I.crown} ` : ''}${esc(p.name)}</b>${pod.absentees?.includes(p) ? ' <span class="dim small">missed the pod</span>' : ''}<div class="row" style="gap:4px;margin-top:4px">${status}</div></div>
      ${mine ? `<div class="row">
        <a class="btn sm gold" href="#packs?pod=${pod.id}&player=${p.id}">Open</a>
        ${sp >= 2 ? `<button class="btn sm danger" data-sac="${p.id}">${I.flame} Sacrifice</button>` : ''}
        ${p.packs.find(k => k.status === 'choosing') ? `<a class="btn sm" href="#sets?pod=${pod.id}&choose=${p.packs.find(k => k.status === 'choosing').id}">Choose set</a>` : ''}
      </div>` : ''}
    </div>`;
  }).join('');
  box.innerHTML = `
    <div class="reveal">
      <div class="art" id="revArt"></div>
      <div class="inner">
        <span class="label">The pod spun</span>
        ${icon(set, 'xl')}
        <div class="setname">${esc(set.name)}</div>
        <div class="row"><span class="chip gold">${year}</span><span class="chip">${typeLabel(set.type)}</span><span class="chip">${kindLabel(set.code)}</span></div>
        <p class="small muted" style="margin:10px 0 0">Open the ${esc(set.name)} packs, or <b>Sacrifice a Pack</b>: give up one to make another any set you want.</p>
      </div>
    </div>
    <div class="panel reveal-list">${rows}</div>`;
  setArt(set.code).then(url => { const a = $('#revArt'); if (url && a) a.style.backgroundImage = `url("${url}")`; });
  $$('[data-sac]', box).forEach(b => b.onclick = () => sacrifice(pod, people(pod).find(p => p.id === b.dataset.sac)));
}

// Sacrifice: give up one spun-set pack so another becomes any set.
async function sacrifice(pod, player, packId) {
  const sp = spunPacks(player);
  const pack = sp.find(k => k.id === packId) || sp[0];
  if (!pack || sp.length < 2) return toast(`${esc(player.name)} needs 2 unopened ${esc(pod.spin.set.name)} packs to sacrifice one.`, 'err');
  const n = player.packs.length;
  const ok = await confirmBox('Sacrifice a Pack?',
    `${esc(player.name)} gives up 1 of ${plural(sp.length, `${esc(pod.spin.set.name)} pack`)} to pick <b>any set</b> for another one. That leaves ${plural(n - 1, 'pack')}: ${plural(sp.length - 2, `${esc(pod.spin.set.name)} pack`)} and 1 of your choice.`,
    `${I.flame} Sacrifice`, true);
  if (!ok) return;
  try { await post(`/pods/${pod.id}/packs/${pack.id}/sacrifice`); await loadState(); go(`#sets?pod=${pod.id}&choose=${pack.id}`); } catch (err) { fail(err); }
}

// =============== PACKS TAB ===============
function renderPacks(view) {
  const pod = currentPod();
  if (!pod) { view.innerHTML = `<div class="empty"><h2>No pods running</h2><p>Opened cards live in <a href="#pools">Pools</a> and <a href="#history">History</a>.</p></div>`; return; }
  if (!pod.spin) { view.innerHTML = `${podSwitcher(pod, 'packs')}<div class="empty"><h2>${esc(pod.name)} hasn't spun yet</h2><p>${pod.status === 'playing' ? 'Finish the game and crown the winner first.' : 'The winner spins the wheel once, then everyone opens their packs here.'}</p><a class="btn gold" href="#${pod.status === 'playing' ? 'pods' : `wheel?pod=${pod.id}`}">${pod.status === 'playing' ? 'Go to Pods' : 'Go to the wheel'}</a></div>`; return; }
  if (S.params.player) S.packsPlayer = S.params.player;
  const p = people(pod).find(x => x.id === S.packsPlayer) || people(pod).find(x => x.id === S.me.id) || pod.players[0];
  S.packsPlayer = p.id;
  const sel = (S.params.pack && p.packs.find(k => k.id === S.params.pack)) || p.packs.find(k => k.status !== 'opened') || p.packs.at(-1);
  const pulls = p.packs.filter(k => k.status === 'opened').flatMap(k => k.cards);
  view.innerHTML = `
    ${podSwitcher(pod, 'packs')}
    <div class="player-tabs">${people(pod).map(x => `<a href="#packs?pod=${pod.id}&player=${x.id}" class="${x.id === p.id ? 'sel' : ''}">${pod.winnerId === x.id ? `${I.crown} ` : ''}${esc(x.name)}${pod.absentees?.includes(x) ? ' <span class="dim">· missed</span>' : ''}</a>`).join('')}</div>
    <div class="packs-layout">
      <aside class="grid" style="gap:12px">
        <div class="pack-list">
          ${p.packs.map(k => `<button class="pack-item ${k.id === sel?.id ? 'sel' : ''}" data-k="${k.id}">
              ${k.status === 'choosing' ? I.question : icon(k.set)}
              <span><div class="t">${k.status === 'choosing' ? 'Pick a set…' : esc(k.set.name)}</div>
              <div class="s">${k.status === 'opened' ? `Opened · ${k.cards.length} cards` : k.status === 'choosing' ? `${I.flame} Sacrificed: choose a set` : 'Unopened'}${k.source === 'sacrifice' && k.status !== 'choosing' ? ` · ${I.flame} chosen` : ''}</div></span>
            </button>`).join('') || `<div class="panel muted small">No packs.</div>`}
          ${p.sacrificed ? `<div class="small dim" style="padding:4px 8px">${I.flame} ${plural(p.sacrificed, 'pack')} sacrificed</div>` : ''}
        </div>
        ${pulls.length ? `<div class="panel">
          <h3>All of ${esc(p.name)}'s pulls this pod</h3>
          <p class="small muted" style="margin:0 0 10px">${pulls.length} cards from ${plural(p.packs.filter(k => k.status === 'opened').length, 'pack')}, merged into one list. Everything is also in <a href="#pools?player=${p.id}">${esc(p.name)}'s pool</a>.</p>
          <button class="btn gold" id="copyAll" style="width:100%">${I.copy} Copy all pulls</button>
          <div style="margin-top:8px">${exportToggle()}</div>
        </div>` : ''}
      </aside>
      <section id="packView"></section>
    </div>`;
  $$('[data-k]', view).forEach(b => b.onclick = () => go(`#packs?pod=${pod.id}&player=${p.id}&pack=${b.dataset.k}`));
  $('#copyAll', view)?.addEventListener('click', () => copyText(listFor(pulls), `${p.name}'s ${pulls.length} pulls`));
  renderPackView($('#packView', view), sel, p, pod);
}

function sortForReveal(cards) {
  return cards.map((c, i) => ({ c, i })).sort((a, b) => {
    const ra = (RARITY_ORDER[a.c.rarity] ?? 0) + (a.c.foil ? 0.5 : 0), rb = (RARITY_ORDER[b.c.rarity] ?? 0) + (b.c.foil ? 0.5 : 0);
    return ra - rb || a.i - b.i;
  }).map(x => x.c);
}

function cardHtml(c, i, down, qty = 0) {
  return `<div class="mcard r-${esc(c.rarity)} ${c.foil ? 'foil' : ''} ${down ? 'down' : ''}" data-i="${i}">
    <div class="flip">
      <div class="face"><img src="${esc(c.image)}" alt="${esc(c.name)}" loading="lazy"></div>
      <div class="backface"></div>
    </div>
    ${qty > 1 ? `<span class="qty">×${qty}</span>` : ''}
    <span class="rar">${esc(c.rarity)}${c.foil ? ' · foil' : ''}</span>
  </div>`;
}

function renderPackView(el, pack, owner, pod) {
  if (!pack) { el.innerHTML = `<div class="empty"><h2>No packs</h2></div>`; return; }
  const mine = canAct(owner);
  if (pack.status === 'choosing') {
    el.innerHTML = `<div class="panel empty"><h2>${I.flame} Pack sacrificed</h2><p>${mine ? `Choose any set for ${esc(owner.name)}'s pack.` : `Waiting for ${esc(owner.name)} to choose a set.`}</p>${mine ? `<a class="btn gold" href="#sets?pod=${pod.id}&choose=${pack.id}">Choose a set →</a>` : ''}</div>`;
    return;
  }
  const meta = S.setsByCode.get(pack.set.code);
  if (pack.status === 'ready') {
    const sp = spunPacks(owner);
    const canSac = mine && pack.source === 'wheel' && sp.length >= 2;
    el.innerHTML = `
      <div class="booster" id="booster">
        ${icon(pack.set, 'lg')}
        <div class="bname">${esc(pack.set.name)}</div>
        <div class="btype">${kindLabel(pack.set.code)}</div>
      </div>
      <div style="text-align:center">
        ${mine ? `<button class="btn gold big" id="openBtn">Open ${owner.id === S.me.id ? 'your' : `${esc(owner.name)}'s`} pack</button>` : `<p class="muted">Only ${esc(owner.name)} can open this pack.</p>`}
        ${canSac ? `<div style="margin-top:12px"><button class="btn danger" id="sacBtn">${I.flame} Sacrifice a Pack</button><div class="sac-note">Give up another ${esc(pack.set.name)} pack and make this one any set.</div></div>` : ''}
        ${isAdmin() ? `<div style="margin-top:12px"><button class="btn danger sm" id="delPack">${I.trash} Delete pack (admin)</button></div>` : ''}
        ${meta && !meta.realPack ? `<p class="small dim" style="margin-top:10px">Generated from this set's booster cards: commons, uncommons, a rare (sometimes mythic), and the odd foil.</p>` : ''}
      </div>`;
    $('#sacBtn', el)?.addEventListener('click', () => sacrifice(pod, owner, pack.id));
    $('#delPack', el)?.addEventListener('click', () => deletePackFlow(pod.id, pack, owner));
    $('#openBtn', el)?.addEventListener('click', async () => {
      const btn = $('#openBtn', el), bo = $('#booster', el);
      btn.disabled = true; btn.textContent = 'Opening…';
      S.opening = true;
      bo.classList.add('shake');
      try {
        const res = await post(`/pods/${pod.id}/packs/${pack.id}/open`);
        S.animatePacks.add(pack.id);
        S.pools = null;
        bo.classList.remove('shake'); bo.classList.add('rip');
        await new Promise(r => setTimeout(r, 450));
        S.pods = S.pods.map(x => x.id === res.pod.id ? res.pod : x);
        S.opening = false;
        renderPacks($('#view'));
      } catch (err) { S.opening = false; fail(err); btn.disabled = false; btn.textContent = 'Try again'; bo.classList.remove('shake'); }
    });
    return;
  }
  // opened
  const cards = sortForReveal(pack.cards);
  const animate = S.animatePacks.has(pack.id);
  S.animatePacks.delete(pack.id);
  const hits = cards.filter(c => c.rarity === 'mythic' || c.rarity === 'rare');
  el.innerHTML = `
    <div class="spread" style="margin-bottom:14px">
      <div class="row">${icon(pack.set, 'lg')}<div><h2 style="margin:0">${esc(pack.set.name)}</h2>
      <div class="small muted">${esc(owner.name)} · ${esc(pack.boosterType || 'Booster')} · ${cards.length} cards${pack.source === 'sacrifice' ? ` · ${I.flame} chosen with a sacrifice` : ''}</div></div></div>
      <div class="row">
        ${animate ? `<button class="btn sm" id="revealAll">Reveal all</button>` : ''}
        ${exportToggle()}
        <button class="btn gold" id="copyPack">${I.copy} Copy pack list</button>
        ${isAdmin() ? `<button class="btn danger sm" id="delPack" title="Admin: delete this pack and its pulls">${I.trash} Delete pack</button>` : ''}
      </div>
    </div>
    ${hits.length ? `<div class="row" style="margin-bottom:12px">${hits.map(c => `<span class="chip ${c.rarity === 'mythic' ? 'gold' : ''}">${c.rarity === 'mythic' ? '★' : '◆'} ${esc(c.name)}${c.foil ? ' (foil)' : ''}</span>`).join('')}</div>` : ''}
    <div class="cards" id="cards">${cards.map((c, i) => cardHtml(c, i, animate)).join('')}</div>
    <details style="margin-top:16px"><summary class="muted small" style="cursor:pointer">Show list text</summary><pre class="list">${esc(listFor(cards))}</pre></details>`;
  $('#copyPack', el).onclick = () => copyText(listFor(cards), `${pack.set.name} pack`);
  $('#delPack', el)?.addEventListener('click', () => deletePackFlow(pod.id, pack, owner));
  $$('.mcard', el).forEach(m => m.onclick = () => {
    if (m.classList.contains('down')) { m.classList.remove('down'); return; }
    cardModal(cards[Number(m.dataset.i)]);
  });
  if (animate) {
    const downs = $$('.mcard.down', el);
    let i = 0, timer;
    const next = () => {
      const m = downs[i++];
      if (!m) { $('#revealAll', el)?.remove(); return; }
      m.classList.remove('down');
      if (m.classList.contains('r-mythic') || m.classList.contains('r-rare')) fanfare(); else tick();
      timer = setTimeout(next, i >= downs.length - 2 ? 650 : 220);
    };
    timer = setTimeout(next, 300);
    $('#revealAll', el).onclick = () => { clearTimeout(timer); downs.forEach(m => m.classList.remove('down')); $('#revealAll', el)?.remove(); };
  }
}

function cardModal(c) {
  const m = $('#modal');
  let showBack = false;
  const paint = () => {
    m.innerHTML = `<div class="box">
      <img src="${esc(showBack ? c.back : c.image)}" alt="${esc(c.name)}">
      <div class="row">
        ${c.back ? `<button class="btn sm" id="flipBtn">↻ Flip</button>` : ''}
        <a class="btn sm" href="${esc(c.uri)}" target="_blank" rel="noopener">Scryfall ↗</a>
        <button class="btn sm" id="copyOne" title="Formatted for ${siteName()}">${I.copy} Copy (${siteName()})</button>
        ${isAdmin() && c.id ? `<button class="btn sm danger" id="delOne">${I.trash} Remove</button>` : ''}
        <button class="btn sm ghost" id="closeM">Close</button>
      </div></div>`;
    $('#flipBtn', m)?.addEventListener('click', e => { e.stopPropagation(); showBack = !showBack; paint(); });
    $('#copyOne', m).onclick = e => { e.stopPropagation(); copyText(listFor([c]), c.name); };
    $('#closeM', m).onclick = () => { m.hidden = true; };
    $('#delOne', m)?.addEventListener('click', e => { e.stopPropagation(); deleteCardFlow(c); });
  };
  paint();
  m.hidden = false;
  m.onclick = e => { if (e.target === m || e.target.classList.contains('box')) m.hidden = true; };
}

// =============== POOLS TAB ===============
// Each player's legal cards beyond their precon: everything they've opened in
// a running or finished pod.
let poolFilter = { q: '', rarity: '', sort: 'rarity', pod: '' };
async function renderPools(view) {
  if (!S.pools) {
    view.innerHTML = '<div class="spinner"></div>';
    try { S.pools = (await api('/pools' + lq())).pools; } catch (err) { fail(err); return; }
    if (S.route !== 'pools') return;
  }
  const pools = S.pools;
  if (!pools.length) { view.innerHTML = `<div class="empty"><h2>No players yet</h2></div>`; return; }
  const pool = pools.find(p => p.userId === S.params.player) || pools.find(p => p.userId === S.me.id) || pools[0];
  if (poolFilter.pod && !pool.pods.some(x => x.id === poolFilter.pod)) poolFilter.pod = '';
  const packs = pool.packs.filter(k => !poolFilter.pod || k.podId === poolFilter.pod);
  const cards = packs.flatMap(k => k.cards);
  const podName = poolFilter.pod && pool.pods.find(x => x.id === poolFilter.pod)?.name;
  // Group identical printings (foil kept apart) with a count.
  const groups = new Map();
  for (const c of cards) {
    const key = `${c.set}/${c.number}/${c.foil ? 'f' : ''}`;
    const g = groups.get(key) || { card: c, qty: 0 };
    g.qty++;
    groups.set(key, g);
  }
  const count = r => cards.filter(c => c.rarity === r).length;
  view.innerHTML = `
    <div class="hero"><div><h1>${esc(S.league?.name || 'League')} Pools</h1><p>Every card a player may use in this league on top of the precon they started with: everything they've opened in its pods, including packs for pods they missed (discarded pods don't count).</p></div></div>
    <div class="player-tabs">${pools.map(p => `<a href="#pools?player=${p.userId}" class="${p.userId === pool.userId ? 'sel' : ''}">${esc(p.username)} <span class="dim">${p.packs.reduce((s, k) => s + k.cards.length, 0)}</span></a>`).join('')}</div>
    <div class="panel pool-head">
      <div>
        <h2 style="margin:0">${esc(pool.username)}'s pool${podName ? ` <span class="muted" style="font-size:.9rem">from ${esc(podName)}</span>` : ''}</h2>
        <div class="small muted">${pool.precon ? `Precon: <b>${esc(pool.precon)}</b> · ` : ''}${plural(pool.pods.length, 'pod')} · ${plural(packs.length, 'pack')} · ${plural(cards.length, 'card')}</div>
        <div class="row" style="margin-top:8px"><span class="chip gold">★ ${count('mythic')} mythic</span><span class="chip">◆ ${count('rare')} rare</span><span class="chip">${count('uncommon')} uncommon</span><span class="chip">${count('common')} common</span></div>
      </div>
      <div class="row">
        ${pool.pods.length ? `<select class="input" id="pp" title="Show cards from one pod"><option value="">All pods</option>${pool.pods.map(x => `<option value="${x.id}" ${poolFilter.pod === x.id ? 'selected' : ''}>${esc(x.name)}${x.status === 'done' ? '' : ' (running)'}</option>`).join('')}</select>` : ''}
        ${cards.length ? `${exportToggle()}<button class="btn gold" id="copyPool">${I.copy} Copy ${podName ? 'these cards' : 'whole pool'}</button>` : ''}
      </div>
    </div>
    ${cards.length ? `
    <div class="set-tools">
      <input type="search" id="pq" placeholder="Search ${groups.size} cards…" value="${esc(poolFilter.q)}">
      <select class="input" id="pr"><option value="">All rarities</option>${['mythic', 'rare', 'uncommon', 'common'].map(r => `<option value="${r}" ${poolFilter.rarity === r ? 'selected' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`).join('')}</select>
      <select class="input" id="ps">
        <option value="rarity" ${poolFilter.sort === 'rarity' ? 'selected' : ''}>Rarity</option>
        <option value="name" ${poolFilter.sort === 'name' ? 'selected' : ''}>A–Z</option>
        <option value="set" ${poolFilter.sort === 'set' ? 'selected' : ''}>Set</option>
      </select>
    </div>
    <div class="cards" id="poolCards"></div>
    <details class="panel" style="margin-top:18px"><summary class="muted" style="cursor:pointer">Packs in this pool (${packs.length})</summary>
      <div class="row" style="margin-top:10px">${packs.map(k => `<span class="chip">${icon(k.set)}${esc(k.set.name)}${k.source === 'sacrifice' ? ` ${I.flame}` : ''} <span class="dim">· ${esc(k.podName)}${k.absent ? ' (missed)' : ''} · ${k.cards.length}</span>${isAdmin() ? `<button class="chip-x" data-delpack="${k.podId}:${k.packId}" title="Admin: delete this pack and its pulls">✕</button>` : ''}</span>`).join('')}</div>
      ${isAdmin() ? `<p class="small dim" style="margin:10px 0 0">Admin: ✕ deletes a whole pack; open a card and use ${I.trash} Remove to delete a single copy.</p>` : ''}
    </details>` : `<div class="empty"><p>${pool.userId === S.me.id ? 'Your' : `${esc(pool.username)}'s`} pool is empty. Cards show up here as soon as packs are opened.</p></div>`}`;
  $('#copyPool', view)?.addEventListener('click', () => copyText(listFor(cards), `${pool.username}'s pool${podName ? ` from ${podName}` : ''} (${cards.length} cards)`));
  $('#pp', view)?.addEventListener('change', e => { poolFilter.pod = e.target.value; renderPools(view); });
  $$('[data-delpack]', view).forEach(b => b.onclick = () => {
    const [podId, packId] = b.dataset.delpack.split(':');
    const k = packs.find(x => x.packId === packId);
    deletePackFlow(podId, { id: packId, set: k.set, cards: k.cards }, { name: pool.username });
  });
  if (!cards.length) return;
  const paint = () => {
    const q = poolFilter.q.trim().toLowerCase();
    let list = [...groups.values()].filter(g => (!q || g.card.name.toLowerCase().includes(q) || (g.card.type || '').toLowerCase().includes(q)) && (!poolFilter.rarity || g.card.rarity === poolFilter.rarity));
    const sorters = {
      rarity: (a, b) => (RARITY_ORDER[b.card.rarity] ?? 0) - (RARITY_ORDER[a.card.rarity] ?? 0) || a.card.name.localeCompare(b.card.name),
      name: (a, b) => a.card.name.localeCompare(b.card.name),
      set: (a, b) => a.card.set.localeCompare(b.card.set) || a.card.name.localeCompare(b.card.name),
    };
    list.sort(sorters[poolFilter.sort]);
    $('#poolCards', view).innerHTML = list.map((g, i) => cardHtml(g.card, i, false, g.qty)).join('') || '<p class="muted">No cards match.</p>';
    $$('#poolCards .mcard', view).forEach(m => m.onclick = () => cardModal(list[Number(m.dataset.i)].card));
  };
  paint();
  $('#pq', view).oninput = e => { poolFilter.q = e.target.value; paint(); };
  $('#pr', view).onchange = e => { poolFilter.rarity = e.target.value; paint(); };
  $('#ps', view).onchange = e => { poolFilter.sort = e.target.value; paint(); };
}

// =============== SETS TAB ===============
let setsFilter = { q: '', type: '', sort: 'new', only: '' };
let saveTimer = null, lastSetsMode = null;
function renderSets(view) {
  const pod = podById(S.params.pod);
  const choosing = S.params.choose ? findPack(pod, S.params.choose) : null;
  const chooseMode = choosing && choosing.status === 'choosing' && canAct(choosing.player);
  const edit = !chooseMode && isAdmin();
  const mode = chooseMode ? 'choose:' + choosing.id : 'browse';
  if (mode !== lastSetsMode) { setsFilter = { q: '', type: '', sort: setsFilter.sort === 'chance' && chooseMode ? 'new' : setsFilter.sort, only: '' }; lastSetsMode = mode; }
  view.innerHTML = `
    ${chooseMode ? `<div class="choose-banner"><div>${I.flame} <b>${esc(choosing.player.name)}</b> sacrificed a pack. Tap any set for the replacement booster.</div><a class="btn sm ghost" href="#packs?pod=${pod.id}&player=${choosing.player.id}">Back to packs</a></div>` : `
      <div class="hero"><div><h1>All Sets${S.league ? ` · ${esc(S.league.name)}` : ''}</h1><p>Every Magic set that came in boosters, and its chance of coming up on ${S.league ? 'this league\'s' : 'the'} wheel (each league has its own). ${edit ? 'As admin you can toggle sets on or off the wheel and change their odds: a weight of 2 makes a set twice as likely as a weight-1 set.' : 'Only the league admin can change which sets are on the wheel and their odds.'}</p></div>
      <div class="row"><span class="chip ok">${S.wheel.length} on the wheel</span>${edit ? '<span class="chip gold">admin</span>' : ''}</div></div>`}
    <div class="set-tools">
      <input type="search" id="q" placeholder="Search ${S.sets.length} sets…" value="${esc(setsFilter.q)}">
      <select class="input" id="ft"><option value="">All types</option>${S.types.map(t => `<option value="${t}" ${setsFilter.type === t ? 'selected' : ''}>${typeLabel(t)}</option>`).join('')}</select>
      ${chooseMode ? '' : `<select class="input" id="fo"><option value="">On & off wheel</option><option value="on" ${setsFilter.only === 'on' ? 'selected' : ''}>On the wheel</option><option value="off" ${setsFilter.only === 'off' ? 'selected' : ''}>Off the wheel</option><option value="custom" ${setsFilter.only === 'custom' ? 'selected' : ''}>Custom odds</option></select>`}
      <select class="input" id="fs">
        <option value="new" ${setsFilter.sort === 'new' ? 'selected' : ''}>Newest</option>
        <option value="old" ${setsFilter.sort === 'old' ? 'selected' : ''}>Oldest</option>
        <option value="name" ${setsFilter.sort === 'name' ? 'selected' : ''}>A–Z</option>
        ${chooseMode ? '' : `<option value="chance" ${setsFilter.sort === 'chance' ? 'selected' : ''}>Highest chance</option>`}
      </select>
    </div>
    <table class="set-table"><thead><tr>
      <th>Set</th><th class="hide-sm">Year</th><th class="hide-sm">Type</th>
      ${chooseMode ? '<th></th>' : '<th>Wheel</th><th>Weight</th><th>Chance</th>'}
    </tr></thead><tbody id="setRows"></tbody></table>`;

  const paintRows = () => {
    const q = setsFilter.q.trim().toLowerCase();
    let rows = S.sets.filter(s => (!q || s.name.toLowerCase().includes(q) || s.code.includes(q)) && (!setsFilter.type || s.type === setsFilter.type));
    if (!chooseMode && setsFilter.only === 'on') rows = rows.filter(s => s.onWheel);
    if (!chooseMode && setsFilter.only === 'off') rows = rows.filter(s => !s.onWheel);
    if (!chooseMode && setsFilter.only === 'custom') rows = rows.filter(s => s.weight !== 1 || S.settings.excluded.includes(s.code));
    const sorters = { new: (a, b) => b.released.localeCompare(a.released), old: (a, b) => a.released.localeCompare(b.released), name: (a, b) => a.name.localeCompare(b.name), chance: (a, b) => b.chance - a.chance };
    rows.sort(sorters[setsFilter.sort] || sorters.new);
    const maxChance = Math.max(...S.sets.map(s => s.chance), 0.0001);
    $('#setRows', view).innerHTML = rows.map(s => {
      const excluded = S.settings.excluded.includes(s.code);
      return `<tr data-code="${s.code}" class="${chooseMode ? 'pickable' : s.onWheel ? '' : 'off'}">
        <td><div class="nm">${icon(s)}<span>${esc(s.name)} <span class="code">${s.code.toUpperCase()}</span>${s.realPack ? ' <span class="chip" title="Uses real booster print-sheet data">real odds</span>' : ''}</span></div></td>
        <td class="hide-sm">${s.year}</td>
        <td class="hide-sm muted small">${typeLabel(s.type)}</td>
        ${chooseMode ? `<td style="text-align:right"><button class="btn sm gold" data-pick="${s.code}">Choose</button></td>` : `
        <td>${edit ? `<label class="switch" title="${s.onWheel ? 'On the wheel' : excluded ? 'Excluded' : 'Filtered out by year/type'}"><input type="checkbox" data-tog="${s.code}" ${!excluded ? 'checked' : ''}><span></span></label>`
          : `<span class="small ${s.onWheel ? '' : 'dim'}">${s.onWheel ? 'On' : 'Off'}</span>`}</td>
        <td>${edit ? `<input type="number" min="0" max="100" step="0.5" value="${s.weight}" data-w="${s.code}" ${excluded ? 'disabled' : ''}>` : `<span class="small">${s.weight}</span>`}</td>
        <td class="chance"><div class="small">${pct(s.chance)}</div><div class="bar"><i style="width:${(s.chance / maxChance) * 100}%"></i></div></td>`}
      </tr>`;
    }).join('') || `<tr><td colspan="6" class="empty">No sets match.</td></tr>`;

    if (chooseMode) {
      $$('tr.pickable', view).forEach(tr => tr.onclick = async () => {
        const s = S.setsByCode.get(tr.dataset.code);
        if (!await confirmBox(`Choose ${esc(s.name)}?`, `${esc(choosing.player.name)}'s sacrificed pack becomes a <b>${esc(s.name)}</b> booster.`, 'Choose set')) return;
        try {
          await post(`/pods/${pod.id}/packs/${choosing.id}/choose`, { setCode: s.code });
          await loadState();
          go(`#packs?pod=${pod.id}&player=${choosing.player.id}&pack=${choosing.id}`);
        } catch (err) { fail(err); }
      });
    } else if (edit) {
      $$('[data-tog]', view).forEach(i => i.onchange = () => {
        const ex = new Set(S.settings.excluded);
        i.checked ? ex.delete(i.dataset.tog) : ex.add(i.dataset.tog);
        S.settings.excluded = [...ex];
        queueSave(paintRows);
      });
      $$('[data-w]', view).forEach(i => i.onchange = () => {
        const v = Math.max(0, Math.min(100, Number(i.value) || 0));
        S.settings.weights[i.dataset.w] = v;
        queueSave(paintRows);
      });
    }
  };
  paintRows();
  $('#q', view).oninput = e => { setsFilter.q = e.target.value; paintRows(); };
  $('#ft', view).onchange = e => { setsFilter.type = e.target.value; paintRows(); };
  $('#fs', view).onchange = e => { setsFilter.sort = e.target.value; paintRows(); };
  $('#fo', view)?.addEventListener('change', e => { setsFilter.only = e.target.value; paintRows(); });
  if (S.params.choose && !chooseMode) toast('That pack isn\'t waiting for you to choose a set.', 'err');
}
function queueSave(after) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api('/settings', { method: 'PUT', body: { excluded: S.settings.excluded, weights: S.settings.weights, league: S.league?.id } });
      await loadSets();
      after();
    } catch (err) { fail(err); }
  }, 350);
}

// =============== HISTORY TAB ===============
async function renderHistory(view) {
  if (!S.history) {
    view.innerHTML = '<div class="spinner"></div>';
    try { S.history = (await api('/history' + lq())).pods; } catch (err) { fail(err); return; }
    if (S.route !== 'history') return;
  }
  const pods = S.history;
  if (!pods.length) { view.innerHTML = `<div class="empty"><h2>No finished pods yet</h2><p>Finish a pod on the Pods tab and it shows up here, with every pack and pull.</p></div>`; return; }
  const stats = new Map();
  for (const g of pods) for (const p of g.players) {
    const s = stats.get(p.id) || { name: p.name, games: 0, wins: 0, packs: 0, sac: 0, mythics: 0, rares: 0 };
    s.name = p.name;
    s.games++; if (g.winnerId === p.id) s.wins++;
    s.sac += p.sacrificed;
    for (const k of p.packs) if (k.status === 'opened') {
      s.packs++;
      for (const c of k.cards) { if (c.rarity === 'mythic') s.mythics++; if (c.rarity === 'rare') s.rares++; }
    }
    stats.set(p.id, s);
  }
  const table = [...stats.values()].sort((a, b) => b.wins - a.wins || b.wins / b.games - a.wins / a.games);
  view.innerHTML = `
    <div class="hero"><div><h1>${esc(S.league?.name || 'League')} History</h1><p>${plural(pods.length, 'pod')} played.</p></div>
      <div class="row">${exportToggle()}${isAdmin() ? `<button class="btn danger" id="clearHist">${I.trash} Clear league history</button>` : ''}</div></div>
    <div class="panel" style="margin-bottom:22px;overflow-x:auto">
      <h2>Standings</h2>
      <table class="standings"><thead><tr><th>Player</th><th class="num">Pods</th><th class="num">Wins</th><th class="num">Win %</th><th class="num">Packs</th><th class="num">Sacrificed</th><th class="num">Rares</th><th class="num">Mythics</th></tr></thead>
      <tbody>${table.map((s, i) => `<tr><td>${i === 0 && s.wins ? `${I.crown} ` : ''}<b>${esc(s.name)}</b></td><td class="num">${s.games}</td><td class="num">${s.wins}</td><td class="num">${Math.round(s.wins / s.games * 100)}%</td><td class="num">${s.packs}</td><td class="num">${s.sac}</td><td class="num">${s.rares}</td><td class="num">${s.mythics}</td></tr>`).join('')}</tbody></table>
    </div>
    <div class="grid" style="gap:12px">${pods.map(g => {
      const w = g.players.find(p => p.id === g.winnerId);
      return `<details class="hgame"><summary>
        <div><b class="hname">${esc(g.name)} · ${fmtDate(g.finishedAt || g.createdAt)}</b> <span class="muted">· ${I.crown} ${esc(w?.name || '—')}${w?.precon ? ` with ${esc(w.precon)}` : ''}${g.spin ? ` · spun ${esc(g.spin.set.name)}` : ''}${g.vote?.winnerId ? ` · ${I.vote} ${esc(nameIn(g, g.vote.winnerId))}` : ''}</span></div>
        <div class="row">${g.spin ? icon(g.spin.set) : ''}${g.players.flatMap(p => p.packs).filter(k => k.source === 'sacrifice' && k.status !== 'choosing').slice(0, 8).map(k => icon(k.set)).join('')}</div>
      </summary><div class="body">${isAdmin() ? `<div class="spread small muted" style="margin-bottom:8px"><span>Admin: deleting removes this pod from History and its cards from the pools.</span><button class="btn danger sm" data-hdel="${g.id}">${I.trash} Delete pod</button></div>` : ''}${g.players.map(p => {
        const pulls = p.packs.filter(k => k.status === 'opened').flatMap(k => k.cards);
        const hits = sortForReveal(pulls).reverse().filter(c => c.rarity === 'mythic' || c.rarity === 'rare');
        return `<div class="hplayer">
          <div class="spread"><div><b>${g.winnerId === p.id ? `${I.crown} ` : ''}${esc(p.name)}</b> ${p.precon ? `<span class="muted small">· ${esc(p.precon)}</span>` : ''}</div>
          ${pulls.length ? `<button class="btn sm" data-copy="${g.id}:${p.id}">${I.copy} Copy ${pulls.length} pulls</button>` : ''}</div>
          <div class="row small muted" style="margin-top:6px">${p.packs.map(k => `<span class="chip">${k.status === 'choosing' ? '' : icon(k.set)}${k.status === 'choosing' ? 'unchosen' : esc(k.set.name)}${k.source === 'sacrifice' ? ` ${I.flame}` : ''}${k.status !== 'opened' ? ' (unopened)' : ` · ${k.cards.length}`}${isAdmin() ? `<button class="chip-x" data-delpack="${g.id}:${p.id}:${k.id}" title="Admin: delete this pack and its pulls">✕</button>` : ''}</span>`).join('') || 'No packs'}${p.sacrificed ? `<span class="chip">${I.flame} ${p.sacrificed} sacrificed</span>` : ''}</div>
          ${hits.length ? `<div class="mini-cards">${hits.map(c => `<img src="${esc(c.image)}" alt="${esc(c.name)}" title="${esc(c.name)}" loading="lazy" data-card="${g.id}:${p.id}:${esc(c.set)}/${esc(c.number)}">`).join('')}</div>` : ''}
        </div>`;
      }).join('')}</div></details>`;
    }).join('')}</div>`;
  const lookup = key => { const [gid, pid] = key.split(':'); const g = pods.find(x => x.id === gid); return g?.players.find(p => p.id === pid); };
  $$('[data-hdel]', view).forEach(b => b.onclick = () => deletePodFlow(pods.find(x => x.id === b.dataset.hdel)));
  $$('[data-delpack]', view).forEach(b => b.onclick = e => {
    e.preventDefault(); e.stopPropagation();
    const [gid, pid, kid] = b.dataset.delpack.split(':');
    const owner = lookup(`${gid}:${pid}`);
    deletePackFlow(gid, owner.packs.find(k => k.id === kid), owner);
  });
  $('#clearHist', view)?.addEventListener('click', async () => {
    const cards = pods.reduce((s, g) => s + g.players.reduce((t, p) => t + p.packs.reduce((u, k) => u + (k.cards?.length || 0), 0), 0), 0);
    if (!await typedConfirm('Clear league history?', `This permanently deletes all <b>${plural(pods.length, 'finished pod')}</b> (and any discarded ones), the standings built from them, and their <b>${cards} cards</b> from everyone's pools. Running pods are not touched.`, 'DELETE', `${I.trash} Clear history`)) return;
    try { const r = await del('/history' + lq()); await afterAdminDelete(`League history cleared (${plural(r.deletedPods, 'pod')} deleted).`); } catch (err) { fail(err); }
  });
  $$('[data-copy]', view).forEach(b => b.onclick = () => {
    const p = lookup(b.dataset.copy);
    const pulls = p.packs.filter(k => k.status === 'opened').flatMap(k => k.cards);
    copyText(listFor(pulls), `${p.name}'s pulls`);
  });
  $$('[data-card]', view).forEach(img => img.onclick = () => {
    const [gid, pid, sn] = img.dataset.card.split(':');
    const p = lookup(`${gid}:${pid}`);
    const c = p.packs.flatMap(k => k.cards || []).find(c => `${c.set}/${c.number}` === sn);
    if (c) cardModal(c);
  });
}

// ---------------- live sync ----------------
let es = null;
function connect() {
  es?.close();
  es = new EventSource('/api/events');
  const dot = $('#liveDot');
  es.addEventListener('hello', () => dot.classList.add('on'));
  es.onerror = () => dot.classList.remove('on');
  const onState = async e => {
    try {
      const info = JSON.parse(e.data || '{}');
      await loadState();
      S.pools = null; S.leagueDetail = null;
      if (e.type === 'spin') {
        const pod = podById(info.podId);
        if (pod?.spin && !S.seenSpins.has(pod.spin.id)) {
          S.seenSpins.add(pod.spin.id);
          if (S.route === 'wheel' && S.podId === pod.id && !S.spinning) {
            // Animate from the resting position, as if we'd watched it live.
            buildGeom();
            const view = $('#view');
            const keep = S.rot;
            renderWheel(view);
            S.rot = keep; drawWheel();
            await runSpin(pod.id, pod.spin);
            return;
          }
          toast(`${I.wheel} ${esc(pod.name)} spun <b>${esc(pod.spin.set.name)}</b> · <a href="#wheel?pod=${pod.id}">see it</a>`, 'good');
        }
      }
      if ((info.vote === 'tied' || info.vote === 'decided') && Date.now() - (S.justVoted || 0) > 3000) {
        const pod = podById(info.podId);
        if (pod?.players.some(p => p.id === S.me.id)) toast(info.vote === 'tied' ? `${I.vote} ${esc(pod.name)}: tie! Re-vote between the tied players.` : `${I.vote} ${esc(pod.name)}: ${esc(nameIn(pod, pod.vote.winnerId))} wins the bonus pack.`, 'good');
      }
      if (S.spinning || S.opening) return;
      // Don't yank the page out from under someone mid-reveal or typing.
      const typing = document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
      if (['sets', 'pods', 'account', 'pools', 'league'].includes(S.route) && typing) return;
      if (S.route === 'packs' && $('.mcard.down')) return;
      if (S.route === 'history') S.history = null;
      render();
    } catch { /* next event will retry */ }
  };
  es.addEventListener('state', onState);
  es.addEventListener('spin', onState);
  es.addEventListener('feedback', async e => {
    const info = JSON.parse(e.data || '{}');
    const mine = info.authorId === S.me?.id;
    if (mine && info.status && info.status !== 'new') toast(`${I.bulb} Your suggestion was marked <b>${FB_STATUS[info.status] || esc(info.status)}</b>. <a href="#account">See it</a>`, 'good');
    if (!isAdmin() && !mine) return;
    if (isAdmin()) await loadState().catch(() => {});
    const typing = document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
    if (S.route === 'account' && !typing && $('#fbBox')) renderFeedback($('#fbBox'));
  });
  es.addEventListener('sets', async () => {
    await loadSets().catch(() => {});
    if (S.spinning) return;
    const typing = document.activeElement && ['INPUT', 'SELECT'].includes(document.activeElement.tagName);
    if ((S.route === 'wheel' || S.route === 'sets') && !typing) render();
  });
}

window.addEventListener('resize', () => { if (S.route === 'wheel' && !S.spinning) drawWheel(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#modal').hidden = true; });

// ---------------- boot ----------------
(async function boot() {
  $('#view').innerHTML = '<div class="spinner"></div>';
  try {
    const r = await api('/auth/me');
    S.passwordRules = r.passwordRules; S.emailEnabled = r.emailEnabled;
    if (r.user && !location.hash.startsWith('#reset')) await enterApp(r.user);
    else showAuth();
  } catch (err) { fail(err); showAuth(); }
})();
