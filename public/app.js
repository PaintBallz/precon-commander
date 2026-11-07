// Pre-Con Commander — client. Plain ES modules, no build step.
// League = everyone with an account. Pod = one game of 2–4 players; its winner
// spins the wheel once and every player's packs come from that set.
import { listText, SITES } from './decklist.js';
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Card images come from Scryfall's CDN at several sizes: "small" (146px wide,
// ~15 KB) and "normal" (488px, ~70-100 KB). srcset lets each browser download
// the smallest one that's sharp for the slot (thumbnails get "small", even on
// high-density phone screens).
const smallOf = url => String(url || '').replace('/normal/', '/small/').replace('version=normal', 'version=small');
const cardSrc = (url, sizes) => {
  const big = esc(url), small = esc(smallOf(url));
  return small === big ? `src="${big}" decoding="async"` : `src="${big}" srcset="${small} 146w, ${big} 488w" sizes="${sizes}" decoding="async"`;
};
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
  S.announcement = st.announcement || null; S.viewAs = st.viewAs || null;
  S.tradesWaiting = st.tradesWaiting || 0;
  paintMe();
  paintBanners();
  paintLeaguePicker();
}
// Switch the whole app to another league (header picker, joining, creating…).
async function showLeague(id) {
  S.viewLeague = id || null;
  S.leagueDetail = null; S.history = null; S.pools = null; S.trades = null; S.tb = null; S.podId = null;
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
// isAdmin: may use admin powers. isAdminAccount: the main admin account, which
// runs the site and never plays (a player made an admin still plays).
const isAdmin = () => !!S.me?.isAdmin;
const isAdminAccount = () => !!S.me?.adminAccount;
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
const kindLabel = code => { const m = S.setsByCode.get(code); return m?.realPack ? ({ play: 'Play Booster', draft: 'Draft Booster', set: 'Set Booster' }[m.packKind] || 'Booster') : 'Booster'; };

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
  $('#adminTab').hidden = !isAdmin();
  $('#tradesTab').innerHTML = `Trades${S.tradesWaiting ? ` <span class="tbadge" title="${plural(S.tradesWaiting, 'offer')} waiting for you">${S.tradesWaiting}</span>` : ''}`;
  layoutTabs();
}

// ---------------- top tabs + More menu ----------------
// Tabs marked data-more always live in the More menu. The other (main) tabs
// sit in the row; any that don't fit the width move into More too, from the
// right, and come back when there's room. When the page you're on is in More,
// the button shows its name and is highlighted.
const tabMain = $('#tabMain'), moreMenu = $('#moreMenu'), moreBtn = $('#moreBtn');
const TAB_ORDER = $$('a[data-tab]', tabMain);
function layoutTabs() {
  // Start from every main tab in the row, in order.
  for (const a of TAB_ORDER) if (!a.hasAttribute('data-more')) tabMain.append(a);
  const overflow = [];
  const fits = () => tabMain.scrollWidth <= tabMain.clientWidth + 1;
  const inRow = () => $$('a[data-tab]:not([hidden])', tabMain);
  while (!fits() && inRow().length > 1) { const a = inRow().at(-1); overflow.unshift(a); a.remove(); }
  moreMenu.replaceChildren(...overflow, ...TAB_ORDER.filter(a => a.hasAttribute('data-more')));
  const active = $('a.active', moreMenu);
  moreBtn.classList.toggle('active', !!active);
  $('#moreLabel').textContent = active ? active.textContent.trim() : 'More';
  // A waiting-trades badge that moved into More shows on the button.
  const badge = $('.tbadge', moreMenu);
  $('#moreBadge').innerHTML = badge && !active?.contains(badge) ? ` <span class="tbadge">${badge.textContent}</span>` : '';
}
function setMenu(open) {
  moreMenu.hidden = !open;
  moreBtn.setAttribute('aria-expanded', String(open));
  if (open) $('a:not([hidden])', moreMenu)?.focus();
}
moreBtn.addEventListener('click', e => { e.stopPropagation(); setMenu(moreMenu.hidden); });
moreMenu.addEventListener('click', () => setMenu(false));
document.addEventListener('click', e => { if (!moreMenu.hidden && !e.target.closest('#tabMore')) setMenu(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !moreMenu.hidden) { setMenu(false); moreBtn.focus(); } });
window.addEventListener('resize', () => { layoutTabs(); });
document.fonts?.ready.then(() => layoutTabs());
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
const ROUTES = ['league', 'pods', 'wheel', 'packs', 'pools', 'sets', 'history', 'fun', 'account', 'player', 'recap', 'admin', 'trades', 'join'];
function parseRoute() {
  const [r, q] = location.hash.replace(/^#/, '').split('?');
  S.route = ROUTES.includes(r) ? r : 'pods';
  S.params = Object.fromEntries(new URLSearchParams(q || ''));
}
const go = hash => { if (location.hash === hash) { parseRoute(); render(); } else location.hash = hash; };
// The vote is over and the wheel is waiting: nudge the pod's players to open
// it (the spin waits until everyone is watching). Nobody is moved automatically.
function wheelNudge(pod) {
  if (!pod || pod.spin || pod.status !== 'awarded' || voteOpen(pod)) return;
  if (!pod.players.some(p => p.id === S.me?.id)) return;
  if (S.route === 'wheel' && S.podId === pod.id) return;
  toast(`${I.wheel} ${esc(pod.name)} is ready to spin. Everyone watches: <a href="#wheel?pod=${pod.id}">open the wheel</a>`, 'good');
}

// While I have my pod's wheel open (and it hasn't spun), tell the server every
// few seconds so the winner can see I'm watching; say goodbye when I leave.
const WATCH_EVERY = 8e3;
function syncWatch() {
  const pod = S.route === 'wheel' ? currentPod() : null;
  const want = pod && !pod.spin && pod.players.some(p => p.id === S.me?.id) && document.visibilityState === 'visible' ? pod.id : null;
  if (want === S.watchPod) return;
  if (S.watchPod) post(`/pods/${S.watchPod}/watch`, { on: false }).catch(() => {});
  clearInterval(S.watchTimer);
  S.watchPod = want;
  if (!want) return;
  const ping = () => post(`/pods/${want}/watch`, { on: true }).then(w => applyWatch(want, w)).catch(() => {});
  ping();
  S.watchTimer = setInterval(ping, WATCH_EVERY);
}
document.addEventListener('visibilitychange', () => { if (S.me) syncWatch(); });
function applyWatch(podId, w) {
  const pod = podById(podId);
  if (!pod || pod.spin) return;
  if (JSON.stringify([pod.watching, pod.waiting]) === JSON.stringify([w.watching, w.waiting])) return;
  pod.watching = w.watching; pod.waiting = w.waiting;
  if (S.route === 'wheel' && S.podId === podId && !S.spinning) renderWheel($('#view'));
}
window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#reset')) { showAuth(); return; }
  if (!S.me || S.me.mustChange) return;
  parseRoute(); render(); window.scrollTo(0, 0);
});

function render() {
  S.stopReveal?.(); S.stopReveal = null;
  if (!S.me || S.me.mustChange) { showAuth(); return; }
  queueMicrotask(syncWatch);
  $('#top').hidden = false;
  $$('#tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === (S.route === 'player' || S.route === 'recap' || S.route === 'join' ? 'league' : S.route)));
  layoutTabs();
  const view = $('#view');
  if (S.route !== 'wheel') stopWheelLoop();
  ({ league: renderLeague, pods: renderPods, wheel: renderWheel, packs: renderPacks, pools: renderPools, sets: renderSets, history: renderHistory, fun: renderFun, account: renderAccount, player: renderPlayer, recap: renderRecap, admin: renderAdmin, trades: renderTrades, join: renderJoin })[S.route](view);
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
    $('[data-r="0"]', m).focus();
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
  // An invite link: new players most likely need an account first.
  const invited = location.hash.startsWith('#join');
  if (invited && !S.inviteSeen) { S.inviteSeen = true; authMode = 'signup'; }
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
        <label class="check consent"><input type="checkbox" name="agree" value="yes" required><span>I'm 13 or older and agree to the <a href="/terms" target="_blank">Terms of Use</a> and <a href="/privacy" target="_blank">Privacy Policy</a>.</span></label>
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
      ${invited ? `<p class="panel invite-note small">${I.flag} You've been invited to a league. Sign up (or log in) and you'll go straight to it.</p>` : ''}
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
    ${isAdmin() ? '' : '<div id="deckBox"></div>'}
    <div id="fbBox"></div>
    <div id="adminBox"></div>
    ${isAdmin() ? '' : `<form class="panel grid danger-zone" id="delForm">
      <h2>Delete account</h2>
      <p class="small muted" style="margin:0">Permanently removes your username, email, password, precon and deck list, signs you out everywhere and deletes your suggestions. Pods you played and packs you opened stay in your leagues' history (other players' standings depend on them) under the name <b>Deleted player</b>. See the <a href="/privacy" target="_blank">Privacy Policy</a>.</p>
      <label>Your password<input name="password" type="password" autocomplete="current-password" required maxlength="128"></label>
      <button class="btn danger">Delete my account</button>
    </form>`}`;
  $('#lo', view).onclick = logout;
  $('#delForm', view)?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (!await confirmBox('Delete your account?', `This can't be undone. <b>${esc(me.username)}</b> will be gone for good.`, `${I.trash} Delete account`, true)) return;
    try { await post('/auth/delete', f); S.me = null; toast('Your account was deleted.', 'good'); location.hash = ''; location.reload(); } catch (err) { fail(err); }
  });
  renderFeedback($('#fbBox', view));
  renderDeckPanel($('#deckBox', view));
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
  $('#adminBox', view).innerHTML = `<div class="panel" style="margin-top:18px"><h2>Admin</h2><p class="muted" style="margin:0 0 10px">Players, packs, announcements, the admin log and backups are on the Admin tab.</p><a class="btn gold" href="#admin">Open the Admin tab</a></div>`;
}

// =============== LEAGUE TAB ===============
const LIMITS = { min: 3, max: 16, podMin: 3, podMax: 4 };
const FEED_ICONS = { win: 'crown', vote: 'vote', spin: 'wheel', pull: 'spark', clear: 'trash', end: 'flag', league: 'flag', join: 'user', leave: 'x', pod: 'play', rules: 'sliders', discard: 'x', finish: 'check', trade: 'trade' };
const LEADING_EMOJI = /^\p{Extended_Pictographic}\uFE0F?\s*/u;
const fmtWhen = iso => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
async function refreshLeague() { S.leagueDetail = null; S.history = null; S.pools = null; await Promise.all([loadState(), loadSets()]); render(); }

const inviteLink = code => `${location.origin}/#join?code=${encodeURIComponent(code)}`;

// An invite link (#join?code=…): what the league is, how many catch-up packs
// joining now brings, and one button to join.
async function renderJoin(view) {
  const code = String(S.params.code || '').trim().toUpperCase();
  if (!code) { go('#league'); return; }
  view.innerHTML = '<div class="spinner"></div>';
  let d;
  try { d = await api(`/leagues/invite/${encodeURIComponent(code)}`); } catch (err) {
    view.innerHTML = `<div class="empty"><h2>That invite didn't work</h2><p>${esc(err.message)}</p><a class="btn" href="#league">Go to League</a></div>`;
    return;
  }
  if (S.route !== 'join') return;
  const l = d.league;
  const already = d.current?.id === l.id;
  const blocked = isAdminAccount() ? "The admin account runs leagues and doesn't join them."
    : already ? null
    : l.status !== 'active' ? `${esc(l.name)} has ended.`
    : d.current ? `You're in ${esc(d.current.name)}. You can be in one league at a time, so leave it on the League tab first.`
    : d.full ? `${esc(l.name)} is full.` : null;
  view.innerHTML = `<div class="join-wrap"><div class="panel join-box">
    <p class="small muted" style="margin:0">You're invited to</p>
    <h1>${esc(l.name)}</h1>
    <p class="muted">${plural(l.members.length, 'player')}: ${esc(l.members.join(', ')) || 'nobody yet'} · ${plural(l.pods, 'pod')} finished${l.running ? `, ${l.running} running` : ''}</p>
    ${already ? `<p>You're already in ${esc(l.name)}.</p><a class="btn gold" href="#league">Go to the league</a>`
      : blocked ? `<p class="warn-box panel">${blocked}</p><a class="btn" href="#league">Go to League</a>`
      : `${d.catchUpPacks ? `<div class="catchup">${I.pack}<div><b>${plural(d.catchUpPacks, 'catch-up pack')}</b><span class="small muted">For the ${plural(d.catchUpPods, 'pod')} already spun before you joined: the same packs a player who missed ${d.catchUpPods === 1 ? 'it' : 'them'} got, so you start level with everyone else.</span></div></div>` : ''}
         <button class="btn gold big" id="joinNow">Join ${esc(l.name)}</button>`}
  </div></div>`;
  $('#joinNow', view)?.addEventListener('click', async e => {
    e.target.disabled = true;
    try {
      const r = await post('/leagues/join', { code });
      toast(`Welcome to ${esc(r.league.name)}!${r.catchUp?.packs ? ` ${plural(r.catchUp.packs, 'catch-up pack')} ${r.catchUp.packs === 1 ? 'is' : 'are'} waiting for you.` : ''}`, 'good');
      S.viewLeague = r.league.id;
      await Promise.all([loadState(), loadSets()]);
      S.leagueDetail = null; S.pools = null; S.trades = null;
      go(r.catchUp?.packs ? '#packs' : '#league');
    } catch (err) { fail(err); e.target.disabled = false; }
  });
}

function joinCreateForms() {
  const canJoin = !isAdminAccount() && !S.myLeagueId;
  const canCreate = isAdminAccount() || !S.myLeagueId;
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
      toast(`Welcome to ${esc(r.league.name)}!${r.catchUp?.packs ? ` ${plural(r.catchUp.packs, 'catch-up pack')} ${r.catchUp.packs === 1 ? 'is' : 'are'} waiting for you on the Packs tab.` : ''}`, 'good');
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
    view.innerHTML = `<div class="hero"><div><h1>League</h1><p>Pods belong to a league: ${LIMITS.min}–${LIMITS.max} players who play pods of ${LIMITS.podMin}–${LIMITS.podMax}, keep their own card pools, standings and wheel. ${isAdminAccount() ? 'Start one below.' : "You're not in one yet."}</p></div></div>${joinCreateForms()}`;
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
        <a class="btn ${active ? '' : 'gold'}" href="#recap?league=${league.id}">${I.crown} ${active ? 'Season so far' : 'Season recap'}</a>
        ${league.code && active ? `<div class="code-box" title="Friends join with this code on the League tab"><span class="small muted">Invite code</span><b>${esc(league.code)}</b><button class="btn sm" id="copyCode" title="Copies a link that signs people up and joins them">${I.copy} Copy invite link</button></div>` : ''}
        ${league.isMember && active ? `<button class="btn danger sm" id="leaveL">Leave league</button>` : ''}
      </div>
    </div>
    ${active && league.members.length < lim.min ? `<div class="panel warn-box">${esc(league.name)} needs at least ${lim.min} players before a pod can start. Share the invite code.</div>` : ''}
    ${!league.isMember && !isAdmin() ? `<div class="panel warn-box">You're viewing ${esc(league.name)}. ${S.myLeagueId ? '' : active ? 'Ask a member for its invite code to join.' : ''}</div>` : ''}
    <div class="league-grid">
      <section class="panel" style="overflow-x:auto">
        <h2>Standings</h2>
        ${standings.some(s => s.pods || s.missed) ? `<table class="standings"><thead><tr><th>Player</th><th class="num">Pods</th><th class="num">Wins</th><th class="num">Win %</th><th class="num" title="Bonus-pack votes won">${I.vote}</th><th class="num" title="Pods missed (absent packs)">Missed</th><th class="num">Packs</th><th class="num">Rares</th><th class="num">Mythics</th></tr></thead>
          <tbody>${standings.map((s, i) => `<tr class="${s.active ? '' : 'dim'}"><td>${i === 0 && s.wins ? `${I.crown} ` : ''}<b>${plink(s.id, s.name)}</b>${s.active ? '' : ' <span class="small">(left)</span>'}</td><td class="num">${s.pods}</td><td class="num">${s.wins}</td><td class="num">${s.pods ? Math.round(s.wins / s.pods * 100) + '%' : '—'}</td><td class="num">${s.voteWins}</td><td class="num">${s.missed}</td><td class="num">${s.packs}</td><td class="num">${s.rares}</td><td class="num">${s.mythics}</td></tr>`).join('')}</tbody></table>`
          : '<p class="muted">No finished pods yet. Standings fill in as pods are finished.</p>'}
      </section>
      <section class="panel">
        <div class="spread"><h2 style="margin:0">Players</h2><span class="small muted">${league.members.length}/${lim.max}</span></div>
        <div class="member-list">${league.members.map(m => `<div class="member"><div><b>${plink(m.id, m.username)}</b>${m.leagueAdmin ? ' <span class="chip gold" title="Started the league: can change its rules and kick players">League admin</span>' : ''}${m.admin ? ' <span class="chip gold" title="A player with admin powers">admin</span>' : ''}${m.test ? ' <span class="chip" title="Cannot sign in; an admin plays for it">test player</span>' : ''}${m.id === S.me.id ? ' <span class="dim small">(you)</span>' : ''}<div class="small muted">${esc(m.precon) || 'No precon set'}</div></div>
          ${league.canManage && active && m.id !== S.me.id ? `<button class="btn ghost sm" data-rmm="${m.id}" data-name="${esc(m.username)}" title="Kick from the league">✕</button>` : ''}</div>`).join('') || '<p class="muted">Nobody yet.</p>'}</div>
        ${isAdmin() && active ? `<div class="row" style="margin-top:10px">${candidates.length ? `<select class="input" id="addMember"><option value="">Add a player…</option>${candidates.map(c => `<option value="${c.id}">${esc(c.username)}</option>`).join('')}</select><button class="btn sm" id="addMemberBtn">Add</button>` : '<span class="small muted">Every player is already in a league.</span>'}</div>` : ''}
        ${isAdmin() && active ? `<div class="test-tools">
          ${league.members.length < 4 ? `<button class="btn sm" id="addTestBtn">${I.user} Fill to 4 with test players</button>` : ''}
          ${league.members.some(m => m.test) ? `<button class="btn sm danger" id="rmTestBtn">${I.x} Remove test players</button>` : ''}
          <p class="small muted">Test players let you try a league out: they can't sign in, and as an admin you play for them (start pods, crown the winner, skip the vote, spin and open their packs).</p>
        </div>` : ''}
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
    const text = `Join "${league.name}" on Pre-Con Commander: ${inviteLink(league.code)}`;
    try { await navigator.clipboard.writeText(text); } catch { /* shown below anyway */ }
    toast(`${I.copy} Invite link copied. Anyone who opens it can sign up and join (code <b>${esc(league.code)}</b>).`, 'good');
  });
  $('#leaveL', view)?.addEventListener('click', async () => {
    if (!await confirmBox(`Leave ${esc(league.name)}?`, 'You stop getting packs for missed pods and can join or start another league. Your past pods stay in its history.', 'Leave league', true)) return;
    try { await post(`/leagues/${league.id}/leave`); S.viewLeague = null; await refreshLeague(); } catch (err) { fail(err); }
  });
  $$('[data-rmm]', view).forEach(b => b.onclick = async () => {
    if (!await confirmBox(`Kick ${esc(b.dataset.name)}?`, `${esc(b.dataset.name)} is removed from ${esc(league.name)}. Their past pods and pool stay in its history. The invite code won't let them back in; only the site admin can re-add them.`, 'Kick', true)) return;
    try { await del(`/leagues/${league.id}/members/${b.dataset.rmm}`); await refreshLeague(); } catch (err) { fail(err); }
  });
  $('#addTestBtn', view)?.addEventListener('click', async () => {
    const n = 4 - league.members.length;
    if (!await confirmBox(`Add ${plural(n, 'test player')}?`, `${esc(league.name)} gets ${n === 1 ? 'a test player' : `${n} test players`} (TestBot1, TestBot2, …) so it has 4. Remove them with “Remove test players” when you're done.`, 'Add test players')) return;
    try { const r = await post(`/leagues/${league.id}/test-players`); toast(`Added ${esc(r.added.join(', '))}.`, 'good'); await refreshLeague(); } catch (err) { fail(err); }
  });
  $('#rmTestBtn', view)?.addEventListener('click', async () => {
    if (!await confirmBox('Remove the test players?', 'Their accounts are deleted. Pods they played stay in the history as “Deleted player”. To start over completely, delete the league instead.', 'Remove', true)) return;
    try { const r = await del(`/leagues/${league.id}/test-players`); toast(`Removed ${esc(r.removed.join(', '))}.`, 'good'); await refreshLeague(); } catch (err) { fail(err); }
  });
  $('#addMemberBtn', view)?.addEventListener('click', async () => {
    const userId = $('#addMember', view).value;
    if (!userId) return;
    try {
      const r = await post(`/leagues/${league.id}/members`, { userId });
      if (r.catchUp?.packs) toast(`Added, with ${plural(r.catchUp.packs, 'catch-up pack')} for the ${plural(r.catchUp.pods, 'pod')} already played.`, 'good');
      await refreshLeague();
    } catch (err) { fail(err); }
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
    if (!await typedConfirm(`Delete ${esc(league.name)}?`, 'This deletes the league with every pod, pack, vote and pool card in it. You can undo it for 30 days from <b>Admin → Admin log</b>.', 'DELETE', `${I.trash} Delete league`)) return;
    try { await del(`/leagues/${league.id}`); S.viewLeague = null; await refreshLeague(); toast('League deleted.', 'good'); } catch (err) { fail(err); }
  });
}

// =============== PODS TAB ===============
// Packs waiting for me anywhere in my league (including pods I missed).
function pendingBanner() {
  if (!S.pending.length || S.viewLeague !== S.myLeagueId) return '';
  return `<div class="panel pending">
    <h3 style="margin:0 0 8px">${I.pack} ${plural(S.pending.length, 'pack')} waiting for you</h3>
    <div class="row">${S.pending.map(k => `<a class="chip" href="#packs?pod=${k.podId}&player=${S.me.id}&pack=${k.packId}">${k.status === 'choosing' ? `${I.question}` : icon(k.set)} ${k.status === 'choosing' ? 'Choose a set' : esc(k.set?.name || '')} <span class="dim">· ${k.grant ? `from the admin${k.note ? `: ${esc(k.note)}` : ''}` : `${esc(k.podName)}${k.catchup ? ' (catch-up)' : k.absent ? ' (missed)' : ''}`}</span></a>`).join('')}</div>
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
    try { await post(`/pods/${pod.id}/winner`, { playerId: p.id }); await loadState(); render(); wheelNudge(podById(pod.id)); } catch (err) { fail(err); }
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
      if (r.result === 'decided') { toast(`${I.vote} ${esc(nameIn(r.pod, r.pod.vote.winnerId))} wins the bonus pack!`, 'good'); wheelNudge(r.pod); }
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
    `The pack is removed from the pod${n ? ` and its <b>${n} cards</b> leave ${esc(owner.name)}'s pool` : ''}. ${UNDO_NOTE}`, `${I.trash} Delete pack`, true)) return;
  try { await del(`/pods/${podId}/packs/${pack.id}`); await afterAdminDelete('Pack deleted.'); } catch (err) { fail(err); }
}
async function deleteCardFlow(c) {
  if (!await confirmBox(`Remove ${esc(c.name)}?`, `One copy of <b>${esc(c.name)}</b>${c.foil ? ' (foil)' : ''} is removed from the player's pool and from its pack's pulls. ${UNDO_NOTE}`, `${I.trash} Remove card`, true)) return;
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
    `This removes ${esc(pod.name)}${pod.status === 'done' ? ' from History' : ''}, its spin and every pack in it${cards ? `, and takes its <b>${cards} opened cards</b> out of the players' pools` : ''}. ${UNDO_NOTE}`,
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
        ${isAdmin() ? `<button class="btn danger sm" data-delete="${pod.id}" title="Admin: delete this pod (undo-able for 30 days)">${I.trash} Delete</button>` : ''}
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
    const late = a => a.packs.length && a.packs.every(k => k.kind === 'catchup');
    return `<div class="absent-line small muted">${I.pack} Missed it, ${plural(n, 'pack')} each: ${pod.absentees.map(a => `<a class="chip" href="#packs?pod=${pod.id}&player=${a.id}" ${late(a) ? 'title="Joined the league later: catch-up packs"' : ''}>${esc(a.name)}${late(a) ? ' (joined later)' : ''} · ${a.packs.filter(k => k.status === 'opened').length}/${a.packs.length} opened</a>`).join(' ')}</div>`;
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
  return `<div class="player-tabs">${list.map(x => `<a href="#${route}?pod=${x.id}" class="${x.id === pod.id ? 'sel' : ''}">${esc(x.name)}${x.status === 'done' && x.kind !== 'grants' ? ' (finished)' : ''}${people(x).some(p => p.id === S.me.id) ? ' ★' : ''}</a>`).join('')}</div>`;
}

function renderWheel(view) {
  // With no pod running the wheel is still shown (spin locked) so everyone can
  // see which sets are on it.
  const pod = currentPod();
  buildGeom();
  if (pod?.spin && !S.spinning) restOn(pod.spin);
  const st = S.settings;
  const winner = pod?.players.find(p => p.id === pod.winnerId);
  const canSpinNow = !!pod && pod.status === 'awarded' && !pod.spin && !voteOpen(pod) && (isAdmin() || S.me.id === pod.winnerId);
  const waiting = (pod?.waiting || []).filter(id => id !== S.me.id);
  const mayspin = canSpinNow && !waiting.length;
  const showWatch = !!pod && pod.status === 'awarded' && !pod.spin;
  const watchBox = showWatch ? `<div class="panel watch-box">
      <h3>${I.wheel} Everyone watches the spin</h3>
      <div class="watchers">${pod.players.map(p => {
        const here = p.id === S.me.id && S.watchPod === pod.id || pod.watching?.includes(p.id) || !pod.waiting?.includes(p.id);
        return `<span class="chip ${here ? 'here' : 'away'}">${here ? '✓' : '…'} ${esc(p.name)}</span>`;
      }).join('')}</div>
      <p class="small muted" style="margin:8px 0 0">${voteOpen(pod) ? 'Open this page while the vote finishes; the spin unlocks once it\'s decided and everyone is here.'
        : waiting.length ? `Waiting for ${esc(waiting.map(id => nameIn(pod, id)).join(', '))} to open the wheel.` : 'Everyone is here.'}</p>
      ${canSpinNow && waiting.length && isAdmin() ? `<button class="btn ghost sm" id="forceSpin" style="margin-top:10px">Spin anyway (admin)</button>` : ''}
    </div>` : '';
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
        ${watchBox}
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
  spinBtn.title = !pod ? 'Start a pod: its winner spins when it ends' : pod.spin ? 'This pod already spun' : pod.status !== 'awarded' ? 'Crown a winner first' : voteOpen(pod) ? 'Finish the bonus-pack vote first' : !canSpinNow ? `Only ${winner.name} can spin` : waiting.length ? 'Waiting for everyone to open the wheel' : 'Spin!';
  const doSpin = async (force = false) => {
    spinBtn.disabled = true;
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const { spin } = await post(`/pods/${pod.id}/spin`, force ? { force: true } : {});
      S.seenSpins.add(spin.id);
      await loadState();
      await runSpin(pod.id, spin);
    } catch (err) { fail(err); renderWheel(view); }
  };
  spinBtn.onclick = () => doSpin();
  $('#forceSpin', view)?.addEventListener('click', async () => {
    if (await confirmBox('Spin without everyone?', `${esc(waiting.map(id => nameIn(pod, id)).join(', '))} ${waiting.length > 1 ? "aren't" : "isn't"} on the wheel page. They'll still get their packs.`, 'Spin anyway')) doSpin(true);
  });
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
  if (!pod.spin && pod.kind !== 'grants') { view.innerHTML = `${podSwitcher(pod, 'packs')}<div class="empty"><h2>${esc(pod.name)} hasn't spun yet</h2><p>${pod.status === 'playing' ? 'Finish the game and crown the winner first.' : 'The winner spins the wheel once, then everyone opens their packs here.'}</p><a class="btn gold" href="#${pod.status === 'playing' ? 'pods' : `wheel?pod=${pod.id}`}">${pod.status === 'playing' ? 'Go to Pods' : 'Go to the wheel'}</a></div>`; return; }
  if (S.params.player) S.packsPlayer = S.params.player;
  const p = people(pod).find(x => x.id === S.packsPlayer) || people(pod).find(x => x.id === S.me.id) || pod.players[0];
  S.packsPlayer = p.id;
  const sel = (S.params.pack && p.packs.find(k => k.id === S.params.pack)) || p.packs.find(k => k.status !== 'opened') || p.packs.at(-1);
  const pulls = p.packs.filter(k => k.status === 'opened').flatMap(k => k.cards);
  view.innerHTML = `
    ${podSwitcher(pod, 'packs')}
    <div class="player-tabs">${people(pod).map(x => `<a href="#packs?pod=${pod.id}&player=${x.id}" class="${x.id === p.id ? 'sel' : ''}">${pod.winnerId === x.id ? `${I.crown} ` : ''}${esc(x.name)}${x.grant ? ' <span class="dim">· from the admin</span>' : pod.absentees?.includes(x) ? ' <span class="dim">· missed</span>' : ''}</a>`).join('')}</div>
    <div class="packs-layout">
      <aside class="grid" style="gap:12px">
        <div class="pack-list">
          ${p.packs.map(k => `<button class="pack-item ${k.id === sel?.id ? 'sel' : ''}" data-k="${k.id}">
              ${k.status === 'choosing' ? I.question : icon(k.set)}
              <span><div class="t">${k.status === 'choosing' ? 'Pick a set…' : esc(k.set.name)}</div>
              <div class="s">${k.kind === 'trade' ? `Moved card · ${esc(k.note || '')}` : k.status === 'opened' ? `Opened · ${k.cards.length} cards` : k.status === 'choosing' ? (k.kind === 'grant' ? `${I.pack} From the admin: choose a set` : `${I.flame} Sacrificed: choose a set`) : 'Unopened'}${k.source === 'sacrifice' && k.status !== 'choosing' ? ` · ${I.flame} chosen` : ''}${k.kind === 'grant' && k.status !== 'choosing' ? ` · ${I.pack} from the admin` : ''}${k.kind === 'grant' && k.note ? ` · ${esc(k.note)}` : ''}</div></span>
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
      <div class="face"><img ${cardSrc(c.image, '(max-width: 500px) 46vw, 200px')} alt="${esc(c.name)}" loading="lazy"></div>
      <div class="backface"></div>
    </div>
    ${qty > 1 ? `<span class="qty">×${qty}</span>` : ''}
    <span class="rar">${esc(c.rarity)}${c.foil ? ' · foil' : ''}</span>
  </div>`;
}

// ‹ Prev / Next › step through a player's packs (opened or not) without
// opening anything; "Open next pack" jumps to their next unopened pack and opens it.
function packNav(pack, owner, pod) {
  const list = owner.packs, i = list.findIndex(k => k.id === pack.id);
  const href = k => `#packs?pod=${pod.id}&player=${owner.id}&pack=${k.id}`;
  const prev = list[i - 1], next = list[i + 1];
  return `<div class="pack-nav">
    ${prev ? `<a class="btn ghost sm" href="${href(prev)}" aria-label="Previous pack">‹ Prev</a>` : `<span class="btn ghost sm" aria-disabled="true">‹ Prev</span>`}
    <span class="small muted">Pack ${i + 1} of ${list.length}</span>
    ${next ? `<a class="btn ghost sm" href="${href(next)}" aria-label="Next pack">Next ›</a>` : `<span class="btn ghost sm" aria-disabled="true">Next ›</span>`}
  </div>`;
}
const nextUnopened = (owner, pack) => {
  const list = owner.packs, i = list.findIndex(k => k.id === pack.id);
  return [...list.slice(i + 1), ...list.slice(0, i)].find(k => k.status === 'ready') || null;
};

function renderPackView(el, pack, owner, pod) {
  if (!pack) { el.innerHTML = `<div class="empty"><h2>No packs</h2></div>`; return; }
  const mine = canAct(owner);
  if (pack.status === 'choosing') {
    el.innerHTML = `<div class="panel empty"><h2>${pack.kind === 'grant' ? `${I.pack} A pack of your choice` : `${I.flame} Pack sacrificed`}</h2><p>${pack.kind === 'grant' ? `From the admin${pack.note ? ` (${esc(pack.note)})` : ''}. ` : ''}${mine ? `Choose any set for ${esc(owner.name)}'s pack.` : `Waiting for ${esc(owner.name)} to choose a set.`}</p>${mine ? `<a class="btn gold" href="#sets?pod=${pod.id}&choose=${pack.id}">Choose a set →</a>` : ''}</div>`;
    return;
  }
  const meta = S.setsByCode.get(pack.set.code);
  if (pack.status === 'ready') {
    const sp = spunPacks(owner);
    const canSac = mine && pack.source === 'wheel' && sp.length >= 2 && pod.kind !== 'grants';
    el.innerHTML = `
      ${packNav(pack, owner, pod)}
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
        // Stay on the pack just opened (not the next unopened one) so its reveal plays.
        history.replaceState(null, '', `#packs?pod=${pod.id}&player=${owner.id}&pack=${pack.id}`);
        parseRoute();
        renderPacks($('#view'));
      } catch (err) { S.opening = false; fail(err); btn.disabled = false; btn.textContent = 'Try again'; bo.classList.remove('shake'); }
    });
    if (S.autoOpen === pack.id) { S.autoOpen = null; $('#openBtn', el)?.click(); }
    return;
  }
  // opened
  const cards = sortForReveal(pack.cards);
  const animate = S.animatePacks.has(pack.id);
  S.animatePacks.delete(pack.id);
  const hits = cards.filter(c => c.rarity === 'mythic' || c.rarity === 'rare');
  const upNext = mine ? nextUnopened(owner, pack) : null;
  el.innerHTML = `
    ${packNav(pack, owner, pod)}
    <div class="reveal-bar">
      ${animate ? `<button class="btn sm" id="revealAll">Skip animation</button>` : ''}
      ${upNext ? `<button class="btn gold" id="openNext">Open next pack →</button>` : ''}
    </div>
    <div class="spread" style="margin-bottom:14px">
      <div class="row">${icon(pack.set, 'lg')}<div><h2 style="margin:0">${esc(pack.set.name)}</h2>
      <div class="small muted">${esc(owner.name)} · ${esc(pack.boosterType || 'Booster')} · ${cards.length} cards${pack.source === 'sacrifice' ? ` · ${I.flame} chosen with a sacrifice` : ''}</div></div></div>
      <div class="row">
        ${exportToggle()}
        <button class="btn" id="copyPack">${I.copy} Copy pack list</button>
        ${isAdmin() ? `<button class="btn danger sm" id="delPack" title="Admin: delete this pack and its pulls">${I.trash} Delete pack</button>` : ''}
      </div>
    </div>
    ${hits.length ? `<div class="row" style="margin-bottom:12px">${hits.map(c => `<span class="chip ${c.rarity === 'mythic' ? 'gold' : ''}">${c.rarity === 'mythic' ? '★' : '◆'} ${esc(c.name)}${c.foil ? ' (foil)' : ''}</span>`).join('')}</div>` : ''}
    <div class="cards" id="cards">${cards.map((c, i) => cardHtml(c, i, animate)).join('')}</div>
    <details style="margin-top:16px"><summary class="muted small" style="cursor:pointer">Show list text</summary><pre class="list">${esc(listFor(cards))}</pre></details>`;
  $('#copyPack', el).onclick = () => copyText(listFor(cards), `${pack.set.name} pack`);
  $('#delPack', el)?.addEventListener('click', () => deletePackFlow(pod.id, pack, owner));
  $('#openNext', el)?.addEventListener('click', () => {
    S.autoOpen = upNext.id;
    go(`#packs?pod=${pod.id}&player=${owner.id}&pack=${upNext.id}`);
  });
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
    // Leaving mid-reveal (Next pack, Prev/Next, another tab) stops the timer.
    S.stopReveal = () => clearTimeout(timer);
  }
}

// =============== FUN PACKS TAB ===============
// Open any booster set just for fun. The server saves nothing: no pod, no pool,
// no feed. Each pack comes back with how it was built, shown under the cards.
function renderFun(view) {
  const F = S.fun ||= { code: null, filter: '', realOnly: false, result: null, history: [], count: FUN_COUNTS.includes(store.get('funCount', 1)) ? store.get('funCount', 1) : 1 };
  const sets = S.sets.filter(s => (!F.realOnly || s.realPack) && (!F.filter || `${s.name} ${s.code}`.toLowerCase().includes(F.filter.toLowerCase())));
  if (!F.code || !S.setsByCode.has(F.code)) F.code = (S.sets.find(s => s.realPack) || S.sets[0])?.code || null;
  const set = S.setsByCode.get(F.code);
  const real = S.sets.filter(s => s.realPack);
  const generated = S.sets.filter(s => !s.realPack);
  view.innerHTML = `
    <div class="hero"><div><h1>Fun Packs</h1>
      <p>Rip a booster from any set ever sold in boosters, just for fun. <b>Nothing here is saved</b>: it doesn't go into your pool, the league, the standings or the activity feed.</p></div>
      <span class="chip">Not saved · ${plural(S.sets.length, 'set')}</span></div>
    <div class="fun-layout">
      <div class="side">
        <div class="panel grid" style="gap:12px">
          <h2 style="margin:0">Pick a set</h2>
          <input type="search" id="funSearch" placeholder="Search ${S.sets.length} sets…" value="${esc(F.filter)}">
          <div class="fun-list" id="funSet" role="listbox">${sets.map(s => `<button type="button" role="option" class="${s.code === F.code ? 'sel' : ''}" data-code="${s.code}" aria-selected="${s.code === F.code}">${icon(s)}<span class="nm">${esc(s.name)}</span><span class="meta">${s.year || (s.released || '').slice(0, 4)} · ${s.realPack ? 'real sheets' : 'generated'}</span></button>`).join('') || '<p class="small dim" style="margin:8px">No sets match.</p>'}</div>
          <label class="check"><input type="checkbox" id="funReal" ${F.realOnly ? 'checked' : ''}> Only sets with real print sheets (${real.length})</label>
          <div class="row"><button class="btn sm" id="funRandom">Random set</button><button class="btn sm" id="funRandomReal">Random real-sheet set</button></div>
        </div>
        <details class="panel fun-source" ${store.get('funSourceOpen', true) ? 'open' : ''}>
          <summary><h2 style="margin:0">Where packs come from</h2></summary>
          <div class="grid" style="gap:12px;margin-top:12px">
            <div><h3>${I.check} Real print sheets: ${real.length} sets</h3>
              <p class="small muted">The booster print sheets and slot odds for these sets are bundled with the app (Play Booster where the set has one, else Draft, else the set's original booster, else Set Booster; never Collector Boosters). Every slot draws from its sheet at the sheet's rates. Sheet data comes from <a href="https://mtgjson.com" target="_blank" rel="noopener">MTGJSON</a>, compiled by the community, so it can contain mistakes.</p>
            </div>
            <div><h3>${I.sliders} Generated: ${plural(generated.length, 'set')}</h3>
              <p class="small muted">Sets with no regular booster on record (Jumpstart, The List, special printings) are built from Scryfall's list of the cards that set put in boosters, using that era's pack layout:</p>
              <div class="row" style="gap:4px;margin-bottom:8px">${generated.map(s => `<button class="chip fun-pick" data-code="${s.code}" title="${esc(s.name)}">${icon(s)}${esc(s.code.toUpperCase())}</button>`).join('')}</div>
              <ul class="small muted fun-rules">
                <li><b>2008 on</b> (Shards of Alara): a basic land, 10 commons, 3 uncommons and a rare that's a mythic 1 time in 8.</li>
                <li><b>Before 2008</b>: 11 commons, 3 uncommons and a rare. No land slot, no mythics.</li>
                <li><b>Foils</b> (Urza's Legacy, 1999, on): about 1 pack in 6 swaps a common for a foil of any rarity.</li>
              </ul></div>
            <p class="small dim" style="margin:0">Card names, rarities and images come from <a href="https://scryfall.com" target="_blank" rel="noopener">Scryfall</a>. League packs are built exactly the same way.</p>
          </div>
        </details>
        ${F.history.length ? `<div class="panel fun-hist"><h2>This session</h2><div class="fun-history">${F.history.map((h, i) => `<button class="pack-item ${F.result === h ? 'sel' : ''}" data-hist="${i}">${icon(h.set)}<span class="fun-hi"><span class="t">${esc(h.set.name)}${h.packs ? ` ×${h.packs.length}` : ''}</span><span class="s">${esc(h.best)}</span></span></button>`).join('')}</div>
          <p class="small dim" style="margin:8px 0 0">Kept until you reload the page.</p></div>` : ''}
      </div>
      <div id="funStage"></div>
    </div>`;
  const stage = $('#funStage', view);
  if (F.result && F.result.set.code === F.code) (F.result.packs ? renderFunBatch : renderFunPack)(stage, F.result); else renderFunBooster(stage, set);

  const pick = code => { F.code = code; F.result = null; renderFun(view); };
  $('#funSearch', view).oninput = e => {
    F.filter = e.target.value;
    const pos = e.target.selectionStart;
    renderFun(view);
    const el = $('#funSearch', view); el.focus(); el.setSelectionRange(pos, pos);
  };
  $$('#funSet button', view).forEach(b => b.onclick = () => pick(b.dataset.code));
  const sel = $('#funSet .sel', view);
  if (sel) sel.parentElement.scrollTop = sel.offsetTop - sel.parentElement.offsetTop - 60;
  $('#funReal', view).onchange = e => { F.realOnly = e.target.checked; renderFun(view); };
  const randomFrom = list => list.length && pick(list[Math.floor(Math.random() * list.length)].code);
  $('#funRandom', view).onclick = () => randomFrom(S.sets);
  $('#funRandomReal', view).onclick = () => randomFrom(real);
  $$('.fun-pick', view).forEach(b => b.onclick = () => pick(b.dataset.code));
  const det = $('.fun-source', view);
  det.addEventListener('toggle', () => store.set('funSourceOpen', det.open));
  $$('[data-hist]', view).forEach(b => b.onclick = () => { const h = F.history[Number(b.dataset.hist)]; F.code = h.set.code; F.result = h; renderFun(view); });
}

const FUN_COUNTS = [1, 3, 6, 12, 24, 36];
const bestOf = cards => { const b = sortForReveal(cards).at(-1); return b ? `${b.rarity}: ${b.name}${b.foil ? ' (foil)' : ''}` : ''; };

function renderFunBooster(el, set) {
  if (!set) { el.innerHTML = `<div class="panel empty"><h2>No sets</h2><p>The set list hasn't loaded yet.</p></div>`; return; }
  const n = S.fun.count || 1;
  el.innerHTML = `
    <div class="panel fun-stage">
      <div class="booster" id="booster">
        ${icon(set, 'lg')}
        <div class="bname">${esc(set.name)}</div>
        <div class="btype">${kindLabel(set.code)}</div>
      </div>
      <div style="text-align:center">
        <div class="fun-count" role="group" aria-label="How many packs">
          <span class="lbl">Packs</span>${FUN_COUNTS.map(c => `<button type="button" class="${c === n ? 'sel' : ''}" data-n="${c}" aria-pressed="${c === n}">${c}${c === 36 ? ' <small>box</small>' : ''}</button>`).join('')}
        </div>
        <button class="btn gold big" id="funOpen">${n === 1 ? `Open a ${esc(set.name)} pack` : `Open ${n} ${esc(set.name)} packs`}</button>
        <p class="small dim" style="margin:10px 0 0">${set.realPack ? `Real ${kindLabel(set.code)} print sheets.` : `Generated from Scryfall's ${set.name} booster cards.`} Just for fun: not saved.${n > 1 ? ' Several packs open face up, with no reveal animation.' : ''}</p>
      </div>
    </div>`;
  $$('.fun-count button', el).forEach(b => b.onclick = () => { S.fun.count = Number(b.dataset.n); store.set('funCount', S.fun.count); renderFunBooster(el, set); });
  $('#funOpen', el).onclick = async () => {
    const btn = $('#funOpen', el), bo = $('#booster', el);
    btn.disabled = true; btn.textContent = n === 1 ? 'Opening…' : `Opening ${n} packs…`;
    bo.classList.add('shake');
    S.opening = true;
    try {
      const r = await post('/fun/open', { set: set.code, count: n });
      bo.classList.remove('shake'); bo.classList.add('rip');
      await new Promise(res => setTimeout(res, 450));
      const result = n === 1
        ? { set: { ...set, ...r.set }, pack: r.pack, best: bestOf(r.pack.cards), animate: true }
        : { set: { ...set, ...r.set }, packs: r.packs, best: `best ${bestOf(r.packs.flatMap(p => p.cards))}` };
      S.fun.history.unshift(result);
      S.fun.history.length = Math.min(S.fun.history.length, 12);
      S.fun.result = result;
      S.opening = false;
      if (S.route === 'fun') renderFun($('#view'));
    } catch (err) { S.opening = false; fail(err); btn.disabled = false; btn.textContent = 'Try again'; bo.classList.remove('shake'); }
  };
}

function renderFunPack(el, result) {
  const { set, pack } = result;
  const cards = sortForReveal(pack.cards);
  const animate = result.animate; result.animate = false;
  const hits = cards.filter(c => c.rarity === 'mythic' || c.rarity === 'rare');
  const x = pack.explain || {};
  el.innerHTML = `
    <div class="spread" style="margin-bottom:14px">
      <div class="row">${icon(set, 'lg')}<div><h2 style="margin:0">${esc(set.name)}</h2>
        <div class="small muted">${esc(pack.boosterType || 'Booster')} · ${cards.length} cards · <b>just for fun, not saved</b></div></div></div>
      <div class="row">
        ${animate ? `<button class="btn sm" id="revealAll">Skip animation</button>` : ''}
        <button class="btn gold" id="funAgain">Open another</button>
      </div>
    </div>
    ${hits.length ? `<div class="row" style="margin-bottom:12px">${hits.map(c => `<span class="chip ${c.rarity === 'mythic' ? 'gold' : ''}">${c.rarity === 'mythic' ? '★' : '◆'} ${esc(c.name)}${c.foil ? ' (foil)' : ''}</span>`).join('')}</div>` : ''}
    <div class="cards" id="cards">${cards.map((c, i) => cardHtml(c, i, animate)).join('')}</div>
    <div class="panel fun-built">
      <h2>How this pack was built</h2>
      <p class="muted" style="margin-top:0">${esc(x.summary || '')}</p>
      ${x.variant && x.variant.of > 1 ? `<p class="small muted">The set has ${x.variant.of} pack layouts; this one comes up <b>${pct(x.variant.chance)}</b> of the time.</p>` : ''}
      ${x.era ? `<p class="small muted">${esc(x.era)} ${esc(x.foils || '')}</p>` : ''}
      <table class="standings fun-slots"><thead><tr><th>Slot</th><th class="num">Cards</th><th class="num">Drawn from</th><th>Pulled</th></tr></thead>
        <tbody>${(x.slots || []).map(sl => `<tr><td><b>${esc(sl.label)}</b>${sl.note ? `<div class="small dim">${esc(sl.note)}</div>` : ''}</td><td class="num">${sl.count}</td><td class="num">${sl.poolSize}</td>
          <td class="small">${sl.cards.map(i => pack.cards[i]).filter(Boolean).map(c => `<span class="fun-card r-${esc(c.rarity)}">${esc(c.name)}${c.foil ? ' ✦' : ''}</span>`).join(', ')}</td></tr>`).join('')}</tbody></table>
    </div>`;
  $('#funAgain', el).onclick = () => renderFunBooster(el, S.setsByCode.get(set.code) || set);
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

// Several fun packs at once: every pack face up in its own block (card images,
// or a compact list for checking sheets), with one shared "how it's built".
function renderFunBatch(el, result) {
  const { set, packs } = result;
  const mode = ['cards', 'list', 'stats'].includes(store.get('funView', 'cards')) ? store.get('funView', 'cards') : 'cards';
  const list = mode === 'list';
  const all = packs.flatMap(p => p.cards);
  const count = pred => all.filter(pred).length;
  const sorted = packs.map(p => sortForReveal(p.cards));
  const slotOf = p => { const m = []; for (const sl of p.explain?.slots || []) for (const i of sl.cards) m[i] = sl.label; return m; };
  const hitChips = cards => cards.filter(c => c.rarity === 'mythic' || c.rarity === 'rare' || c.foil)
    .map(c => `<span class="chip ${c.rarity === 'mythic' ? 'gold' : ''}">${c.rarity === 'mythic' ? '★' : c.rarity === 'rare' ? '◆' : '✦'} ${esc(c.name)}${c.foil ? ' (foil)' : ''}</span>`).join('');
  const block = (p, n) => {
    const slots = slotOf(p);
    const body = list
      ? `<table class="standings fun-rows"><thead><tr><th class="num">#</th><th>Card</th><th>Set · No.</th><th>Rarity</th><th>Slot</th></tr></thead>
          <tbody>${p.cards.map((c, i) => `<tr data-c="${i}"><td class="num">${i + 1}</td><td><span class="fun-card r-${esc(c.rarity)}">${esc(c.name)}</span>${c.foil ? ' <span class="fun-foil">✦ foil</span>' : ''}</td>
            <td class="mono">${esc(c.set.toUpperCase())} ${esc(c.number)}</td><td class="fun-card r-${esc(c.rarity)}">${esc(c.rarity)}</td><td class="small muted">${esc(slots[i] || '')}</td></tr>`).join('')}</tbody></table>`
      : `<div class="cards">${sorted[n].map((c, i) => cardHtml(c, i, false)).join('')}</div>`;
    return `<section class="panel fun-pack" data-p="${n}">
      <div class="fun-pack-head"><h3>Pack ${n + 1}</h3><span class="small muted">${p.cards.length} cards</span><div class="row">${hitChips(p.cards)}</div></div>
      ${body}</section>`;
  };
  // Shared build info: every distinct slot across the batch, and how many packs had it.
  const x = packs[0].explain || {};
  const rows = new Map();
  for (const p of packs) for (const sl of p.explain?.slots || []) {
    const k = `${sl.label}|${sl.count}|${sl.poolSize}`;
    const r = rows.get(k) || { ...sl, packs: 0 };
    r.packs++; rows.set(k, r);
  }
  const layouts = x.variant?.of > 1;
  el.innerHTML = `
    <div class="spread" style="margin-bottom:14px">
      <div class="row">${icon(set, 'lg')}<div><h2 style="margin:0">${esc(set.name)}</h2>
        <div class="small muted">${esc(packs[0].boosterType || 'Booster')} · ${packs.length} packs · ${all.length} cards · <b>just for fun, not saved</b></div></div></div>
      <div class="row">
        <div class="fun-seg" role="group" aria-label="View">
          ${[['cards', 'Cards'], ['list', 'List'], ['stats', 'Stats']].map(([v, t]) => `<button type="button" data-v="${v}" class="${mode === v ? 'sel' : ''}" aria-pressed="${mode === v}">${t}</button>`).join('')}
        </div>
        <button class="btn gold" id="funAgain">Open ${packs.length} more</button>
      </div>
    </div>
    <div class="row" style="margin-bottom:14px">
      <span class="chip gold">★ ${count(c => c.rarity === 'mythic')} mythic</span>
      <span class="chip">◆ ${count(c => c.rarity === 'rare')} rare</span>
      <span class="chip">${count(c => c.rarity === 'uncommon')} uncommon</span>
      <span class="chip">${count(c => c.rarity === 'common')} common</span>
      <span class="chip">✦ ${count(c => c.foil)} foil</span>
    </div>
    ${mode === 'stats' ? '<div id="funStats"><div class="spinner"></div></div>' : `<div class="fun-packs">${packs.map(block).join('')}</div>`}
    <div class="panel fun-built">
      <h2>How these packs were built</h2>
      <p class="muted" style="margin-top:0">${esc(x.summary || '')}</p>
      ${layouts ? `<p class="small muted">The set has ${x.variant.of} pack layouts, so the slots below didn't all appear in every pack.</p>` : ''}
      ${x.era ? `<p class="small muted">${esc(x.era)} ${esc(x.foils || '')}</p>` : ''}
      <table class="standings fun-slots"><thead><tr><th>Slot</th><th class="num">Cards</th><th class="num">Drawn from</th><th class="num">In packs</th></tr></thead>
        <tbody>${[...rows.values()].map(sl => `<tr><td><b>${esc(sl.label)}</b>${sl.note ? `<div class="small dim">${esc(sl.note)}</div>` : ''}</td><td class="num">${sl.count}</td><td class="num">${sl.poolSize}</td>
          <td class="num">${sl.packs} of ${packs.length}</td></tr>`).join('')}</tbody></table>
    </div>`;
  $('#funAgain', el).onclick = () => { S.fun.count = packs.length; renderFunBooster(el, S.setsByCode.get(set.code) || set); };
  $$('.fun-seg button', el).forEach(b => b.onclick = () => { store.set('funView', b.dataset.v); renderFunBatch(el, result); });
  $$('.fun-pack', el).forEach(sec => {
    const n = Number(sec.dataset.p);
    $$('.mcard', sec).forEach(m => m.onclick = () => cardModal(sorted[n][Number(m.dataset.i)]));
    $$('tr[data-c]', sec).forEach(tr => tr.onclick = () => cardModal(packs[n].cards[Number(tr.dataset.c)]));
  });
  if (mode === 'stats') loadFunStats($('#funStats', el), result);
}

// =============== FUN PACKS: STATS ===============
// Compares a batch with what the set's print sheets should produce: rarity mix,
// each slot's mix, how often each card came up, and how much of each sheet was seen.
const RARITIES = ['common', 'uncommon', 'rare', 'mythic'];
const fmt1 = n => (Math.round(n * 10) / 10).toLocaleString();
// P(X >= k) for X ~ Poisson(lam): how surprising a card's count is.
const poissonAtLeast = (lam, k) => { let p = Math.exp(-lam), cdf = 0; for (let i = 0; i < k; i++) { cdf += p; p *= lam / (i + 1); } return Math.max(0, 1 - cdf); };
const cardKey = c => `${c.set}/${c.number}${c.foil ? '/f' : ''}`;

async function loadFunStats(box, result) {
  const code = result.set.code;
  const cache = S.fun.odds ||= {};
  if (!cache[code]) {
    try { const o = await api(`/fun/odds/${code}`); if (o.unresolved) { if (box.isConnected) renderFunStats(box, result, o); return; } cache[code] = o; }
    catch (err) { box.innerHTML = `<div class="panel empty"><p>Couldn't load the sheet odds: ${esc(err.message)}</p></div>`; return; }
  }
  if (!box.isConnected) return;
  renderFunStats(box, result, cache[code]);
}

function renderFunStats(box, { packs }, odds) {
  const N = packs.length;
  const real = !!odds?.real;
  const all = packs.flatMap(p => p.cards);
  // Observed: copies per card, and per sheet the packs it was in and the cards it gave.
  const pulled = new Map();
  for (const c of all) { const k = cardKey(c); const e = pulled.get(k) || { card: c, n: 0 }; e.n++; pulled.set(k, e); }
  const bySheet = new Map();
  for (const p of packs) {
    const seen = new Set();
    for (const sl of p.explain?.slots || []) {
      const id = sl.sheet || sl.label;
      const o = bySheet.get(id) || { label: sl.label, packs: 0, cards: [] };
      if (!seen.has(id)) { o.packs++; seen.add(id); }
      o.cards.push(...sl.cards.map(i => p.cards[i]).filter(Boolean));
      bySheet.set(id, o);
    }
  }
  const foilPacks = packs.filter(p => p.cards.some(c => c.foil)).length;

  // Expected rarity totals for the batch, from each sheet's weighted mix.
  const expRarity = Object.fromEntries(RARITIES.map(r => [r, real ? N * odds.sheets.reduce((s, sh) => s + sh.perPack * (sh.mix[r] || 0), 0) : null]));
  const obsRarity = Object.fromEntries(RARITIES.map(r => [r, all.filter(c => c.rarity === r).length]));

  // A horizontal bar with an optional expected tick; both on one shared scale.
  const bar = (value, exp, max, cls, tip) => `<div class="fs-bar" title="${esc(tip)}"><i class="${cls}" style="width:${Math.max(value / max * 100, value ? 1 : 0)}%"></i>${exp != null ? `<s style="left:${Math.min(exp / max * 100, 100)}%"></s>` : ''}</div>`;
  const legend = real ? `<div class="fs-legend"><span><i class="fs-sw"></i>Pulled</span><span><s></s>Expected</span></div>` : '';

  const rarityMax = Math.max(1, ...RARITIES.map(r => Math.max(obsRarity[r], expRarity[r] || 0)));
  const rarityChart = RARITIES.filter(r => obsRarity[r] || expRarity[r]).map(r => `
    <div class="fs-row"><span class="fs-lbl">${r}</span>
      ${bar(obsRarity[r], expRarity[r], rarityMax, `v-${r}`, `${r}: ${obsRarity[r]} pulled${real ? `, ${fmt1(expRarity[r])} expected` : ''}`)}
      <span class="fs-val num">${obsRarity[r]}${real ? `<em> / ${fmt1(expRarity[r])}</em>` : ''}</span></div>`).join('');

  // Per card: copies vs expected copies; flag counts the sheet makes very unlikely.
  const freq = [...pulled.entries()].map(([k, e]) => {
    const ex = real ? odds.cards[k] : null;
    const exp = ex ? ex.exp * N : null;
    const p = exp != null ? poissonAtLeast(exp, e.n) : null;
    const flag = real && !ex ? 'missing' : (p != null && e.n >= 3 && p < 0.001 ? 'high' : '');
    return { k, ...e, exp, p, ratio: exp ? e.n / exp : null, flag };
  }).sort((a, b) => (!!b.flag - !!a.flag) || (a.p ?? 1) - (b.p ?? 1) || b.n - a.n);
  const flagged = freq.filter(f => f.flag);
  const top = [...freq].sort((a, b) => b.n - a.n || (b.exp ?? 0) - (a.exp ?? 0)).slice(0, 12);
  const topMax = Math.max(1, ...top.map(f => Math.max(f.n, f.exp || 0)));
  const topChart = top.map(f => `
    <div class="fs-row"><span class="fs-lbl fs-name" title="${esc(f.card.name)}">${esc(f.card.name)}${f.card.foil ? ' ✦' : ''}</span>
      ${bar(f.n, f.exp, topMax, `v-${f.card.rarity}`, `${f.card.name}: ${f.n} pulled${f.exp != null ? `, ${fmt1(f.exp)} expected` : ''}`)}
      <span class="fs-val num">${f.n}${f.exp != null ? `<em> / ${fmt1(f.exp)}</em>` : ''}</span></div>`).join('');

  // Each slot's rarity mix, pulled vs the sheet's, as two stacked bars.
  const stack = mix => `<div class="fs-stack">${RARITIES.filter(r => mix[r] > 0).map(r => `<i class="v-${r}" style="flex:${mix[r]}" title="${r}: ${Math.round(mix[r] * 100)}%"></i>`).join('')}</div>`;
  const sheetRows = real ? odds.sheets : [...bySheet.entries()].map(([id, o]) => ({ sheet: id, label: o.label }));
  const slotCards = sheetRows.map(sh => {
    const o = bySheet.get(sh.sheet) || { packs: 0, cards: [] };
    const obsMix = Object.fromEntries(RARITIES.map(r => [r, o.cards.length ? o.cards.filter(c => c.rarity === r).length / o.cards.length : 0]));
    const off = real && o.cards.length >= 10 && RARITIES.some(r => Math.abs(obsMix[r] - (sh.mix[r] || 0)) > 0.15);
    const parts = RARITIES.filter(r => obsMix[r] || (real && sh.mix[r])).map(r => `${r} ${Math.round(obsMix[r] * 100)}%${real ? ` <em>(exp ${Math.round((sh.mix[r] || 0) * 100)}%)</em>` : ''}`);
    return `<div class="fs-slot ${off ? 'off' : ''}">
      <div class="fs-slot-head"><b>${esc(sh.label)}</b>${sh.foil ? ' <span class="fun-foil">✦ foil</span>' : ''}${off ? ' <span class="chip st-planned">Off target</span>' : ''}
        <span class="small muted">${o.cards.length} cards · in ${o.packs} of ${N} packs${real && sh.appear < 0.999 ? ` <em>(exp ${fmt1(sh.appear * N)})</em>` : ''}</span></div>
      ${o.cards.length ? `<div class="fs-pair"><span class="fs-k">Pulled</span>${stack(obsMix)}</div>` : ''}
      ${real ? `<div class="fs-pair"><span class="fs-k">Expected</span>${stack(sh.mix)}</div>` : ''}
      <div class="small muted">${parts.join(' · ')}</div>
    </div>`;
  }).join('');

  // How much of each sheet showed up, and what didn't.
  const coverage = real ? odds.sheets.map(sh => {
    const missing = sh.keys.filter(k => !pulled.has(k));
    const seen = sh.keys.length - missing.length;
    return `<div class="fs-cov">
      <div class="fs-row"><span class="fs-lbl fs-name">${esc(sh.label)}${sh.foil ? ' ✦' : ''}</span>
        ${bar(seen, null, Math.max(sh.keys.length, 1), 'v-cov', `${seen} of ${sh.keys.length} cards seen`)}
        <span class="fs-val num">${seen}<em> / ${sh.keys.length}</em></span></div>
      ${missing.length ? `<details><summary class="small muted">Not pulled yet (${missing.length})</summary>
        <p class="small fs-missing">${missing.slice(0, 300).map(k => { const c = odds.cards[k]; return `<span class="fun-card r-${esc(c.rarity)}">${esc(c.name)}</span>`; }).join(', ')}${missing.length > 300 ? ` … and ${missing.length - 300} more` : ''}</p></details>` : ''}
    </div>`;
  }).join('') : '';

  const freqRow = f => `<tr class="${f.flag ? 'flag' : ''}"><td><span class="fun-card r-${esc(f.card.rarity)}">${esc(f.card.name)}</span>${f.card.foil ? ' <span class="fun-foil">✦ foil</span>' : ''}</td>
    <td class="mono">${esc(f.card.set.toUpperCase())} ${esc(f.card.number)}</td><td class="fun-card r-${esc(f.card.rarity)}">${esc(f.card.rarity)}</td>
    <td class="num">${f.n}</td>${real ? `<td class="num">${f.exp != null ? fmt1(f.exp) : '–'}</td><td class="num">${f.ratio != null ? `×${fmt1(f.ratio)}` : '–'}</td>
    <td>${f.flag === 'high' ? '<span class="chip st-planned">Too often</span>' : f.flag === 'missing' ? '<span class="chip st-planned">Not on sheet</span>' : ''}</td>` : ''}</tr>`;
  const SHOW = 40;

  box.innerHTML = `
    ${real && odds.unresolved ? `<p class="small muted">${I.question} Scryfall didn't return ${plural(odds.unresolved, 'card')} on this set's sheets just now, so their rarities are guessed. Switch views and back to retry.</p>` : ''}
    ${real ? '' : `<p class="small muted">This set has no real print sheets (its packs are generated), so there are no expected odds to compare with: these are the pulls only.</p>`}
    <div class="fs-tiles">
      <div class="fs-tile"><b class="num">${N}</b><span>packs</span></div>
      <div class="fs-tile"><b class="num">${all.length}</b><span>cards</span></div>
      <div class="fs-tile"><b class="num">${pulled.size}</b><span>different cards</span></div>
      <div class="fs-tile"><b class="num">${foilPacks}</b><span>packs with a foil${real ? ` <em>exp ${fmt1(odds.foilChance * N)}</em>` : ''}</span></div>
      ${real ? `<div class="fs-tile ${flagged.length ? 'warn' : 'good'}"><b class="num">${flagged.length}</b><span>${flagged.length ? 'cards flagged' : 'cards flagged: all within odds'}</span></div>` : ''}
    </div>
    <div class="fs-grid">
      <section class="panel"><h2>Rarity mix</h2>${legend}<div class="fs-chart">${rarityChart}</div></section>
      <section class="panel"><h2>Most pulled cards</h2>${legend}<div class="fs-chart">${topChart}</div></section>
    </div>
    <section class="panel fs-sec"><h2>Slot odds check</h2>
      <p class="small muted" style="margin-top:0">${real ? `Each slot's rarity mix in this batch against its print sheet (by weight). A slot is marked <b>Off target</b> when a rarity is more than 15 points off with at least 10 cards pulled; small batches drift, so open more packs before reading much into it.` : `Each slot's rarity mix in this batch.`}</p>
      <div class="fs-key">${RARITIES.map(r => `<span><i class="v-${r}"></i>${r}</span>`).join('')}</div>
      <div class="fs-slots">${slotCards}</div></section>
    <section class="panel fs-sec"><h2>Card frequency</h2>
      <p class="small muted" style="margin-top:0">${real ? `How many times each card came up against the copies its sheets should give in ${N} packs (sheet weight × slot size, roughly), most surprising first. <b>Too often</b> means a count that's less than 0.1% likely by chance; <b>Not on sheet</b> means the card isn't on any of this booster's sheets.` : `How many times each card came up.`}</p>
      <div class="fs-scroll"><table class="standings fun-rows fs-freq"><thead><tr><th>Card</th><th>Set · No.</th><th>Rarity</th><th class="num">Pulled</th>${real ? '<th class="num">Expected</th><th class="num">Ratio</th><th></th>' : ''}</tr></thead>
        <tbody>${freq.slice(0, SHOW).map(freqRow).join('')}</tbody></table></div>
      ${freq.length > SHOW ? `<button class="btn sm" id="fsAll">Show all ${freq.length} cards</button>` : ''}</section>
    ${real ? `<section class="panel fs-sec"><h2>Sheet coverage</h2>
      <p class="small muted" style="margin-top:0">How many of each sheet's cards showed up at least once in this batch.</p>
      ${coverage}</section>` : ''}`;
  $('#fsAll', box)?.addEventListener('click', e => { $('.fs-freq tbody', box).innerHTML = freq.map(freqRow).join(''); e.target.remove(); });
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
        ${isAdmin() && c.id ? `<button class="btn sm" id="moveOne">Move to…</button><button class="btn sm danger" id="delOne">${I.trash} Remove</button>` : ''}
        <button class="btn sm ghost" id="closeM">Close</button>
      </div></div>`;
    $('#flipBtn', m)?.addEventListener('click', e => { e.stopPropagation(); showBack = !showBack; paint(); });
    $('#copyOne', m).onclick = e => { e.stopPropagation(); copyText(listFor([c]), c.name); };
    $('#closeM', m).onclick = () => { m.hidden = true; };
    $('#delOne', m)?.addEventListener('click', e => { e.stopPropagation(); deleteCardFlow(c); });
    $('#moveOne', m)?.addEventListener('click', e => { e.stopPropagation(); moveCardFlow(c); });
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
        <div class="small muted">${pool.precon ? `Precon: <b>${esc(pool.precon)}</b> · ` : ''}${plural(pool.pods.length, 'pod')} · ${plural(packs.length, 'pack')} · ${plural(cards.length, 'card')} · <a href="#player?id=${pool.userId}${S.viewLeague ? `&league=${S.viewLeague}` : ''}">Stats and deck</a></div>
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
      <div class="row" style="margin-top:10px">${packs.map(k => `<span class="chip">${icon(k.set)}${esc(k.set.name)}${k.source === 'sacrifice' ? ` ${I.flame}` : ''} <span class="dim">· ${k.kind === 'trade' ? esc(k.note || 'moved card') : k.kind === 'grant' ? `from the admin${k.note ? `: ${esc(k.note)}` : ''}` : `${esc(k.podName)}${k.kind === 'catchup' ? ' (catch-up)' : k.absent ? ' (missed)' : ''}`} · ${k.cards.length}</span>${isAdmin() ? `<button class="chip-x" data-delpack="${k.podId}:${k.packId}" title="Admin: delete this pack and its pulls">✕</button>` : ''}</span>`).join('')}</div>
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

// =============== TRADES TAB ===============
// Two players swap pool cards. An offer waits until the other player answers
// (accept, decline or counter with different cards), so nobody has to be
// online at the same time. Incoming / Sent / History list the trades with
// their card images; "New trade" and "Counter" open the builder: both pools
// side by side, click cards to add them, then send.
const tradeSides = (t, o = t.offers.at(-1)) => {
  // Cards from my side of an offer: what I give and what I get.
  const give = o.cards.filter(c => (o.mine ? c.side === 'give' : c.side === 'get'));
  const get = o.cards.filter(c => (o.mine ? c.side === 'get' : c.side === 'give'));
  return { give, get };
};
const tradeBox = t => (t.status !== 'open' ? 'history' : t.turn === 'me' ? 'incoming' : 'sent');
function tcardHtml(c, { gone = false, small = false } = {}) {
  return `<button type="button" class="tcard r-${esc(c.rarity)} ${c.foil ? 'foil' : ''} ${gone ? 'gone' : ''} ${small ? 'small' : ''}" data-zoom="${c.id}" title="${esc(c.name)}${gone ? ' (no longer available)' : ''}">
    <img ${cardSrc(c.image, small ? '64px' : '110px')} alt="${esc(c.name)}" loading="lazy">${gone ? '<span class="tc-tag">gone</span>' : c.foil ? '<span class="tc-tag">foil</span>' : ''}</button>`;
}
function tradeStrip(cards, label, missing = [], small = false) {
  return `<div class="tside"><div class="tside-head">${label} <span class="dim">${cards.length ? plural(cards.length, 'card') : 'nothing'}</span></div>
    <div class="tstrip">${cards.map(c => tcardHtml(c, { gone: missing.includes(c.id), small })).join('') || `<span class="tempty">${small ? '—' : 'Nothing in return'}</span>`}</div></div>`;
}
const STATUS_TEXT = { accepted: 'Accepted', declined: 'Declined', cancelled: 'Cancelled', closed: 'Closed' };
function tradeCardHtml(t) {
  const o = t.offers.at(-1);
  const { give, get } = tradeSides(t);
  const other = plink(t.other.id, t.other.name);
  const counters = t.offers.length - 1;
  const head = t.status === 'open'
    ? (t.turn === 'me' ? `${other} ${o.round === 1 ? 'sent you an offer' : 'countered'}` : `You ${o.round === 1 ? 'offered' : 'countered'} ${other}`)
    : `Trade with ${other}`;
  const chip = t.status === 'open'
    ? (t.turn === 'me' ? '<span class="chip gold">Your turn</span>' : `<span class="chip">Waiting on ${esc(t.other.name)}</span>`)
    : `<span class="chip ${t.status === 'accepted' ? 'ok' : ''}">${STATUS_TEXT[t.status]}</span>`;
  const closed = t.status === 'open' ? '' : `<p class="small muted tnote">${STATUS_TEXT[t.status]}${t.closedBy ? ` by ${t.closedBy === S.me.id ? 'you' : esc(t.other.name)}` : ''} · ${fmtWhen(t.closedAt)}${t.closeNote ? ` · ${esc(t.closeNote)}` : ''}</p>`;
  const earlier = t.offers.slice(0, -1).reverse();
  return `<article class="panel trade" data-trade="${t.id}">
    <div class="trade-head"><span class="trade-who">${I.trade}<span>${head}</span></span><span class="small dim">${counters ? `round ${o.round} · ` : ''}${ago(o.at)}</span><span class="grow"></span>${chip}</div>
    <div class="trade-sides">${tradeStrip(give, 'You give', t.missing)}<div class="tswap" aria-hidden="true">${I.trade}</div>${tradeStrip(get, 'You get', t.missing)}</div>
    ${o.note ? `<p class="tnote"><span class="dim">${o.mine ? 'Your note' : `${esc(o.fromName)} says`}:</span> ${esc(o.note)}</p>` : ''}
    ${t.missing.length && t.status === 'open' ? `<p class="small tnote" style="color:var(--danger)">${plural(t.missing.length, 'card')} in this offer ${t.missing.length === 1 ? 'has' : 'have'} left ${t.missing.length === 1 ? 'its' : 'their'} pool, so it can't be accepted as it is.</p>` : ''}
    ${closed}
    ${earlier.length ? `<details class="trounds"><summary class="small muted">Earlier offers (${earlier.length})</summary>${earlier.map(e => {
      const s = tradeSides(t, e);
      return `<div class="tround"><div class="small dim">${e.mine ? 'You' : esc(e.fromName)} ${e.round === 1 ? 'offered' : 'countered'} · ${fmtWhen(e.at)}${e.note ? ` · “${esc(e.note)}”` : ''}</div>
        <div class="trade-sides">${tradeStrip(s.give, 'You give', [], true)}<div class="tswap" aria-hidden="true">${I.trade}</div>${tradeStrip(s.get, 'You get', [], true)}</div></div>`;
    }).join('')}</details>` : ''}
    ${t.status === 'open' ? `<div class="row trade-acts">${t.turn === 'me'
      ? `<button class="btn ghost" data-act="decline">${I.x} Decline</button><button class="btn" data-act="counter">${I.trade} Counter</button><button class="btn gold" data-act="accept">${I.check} Accept</button>`
      : `<button class="btn ghost" data-act="cancel">${I.x} Cancel offer</button>`}</div>` : ''}
  </article>`;
}

async function loadTrades() { S.trades = await api('/trades' + lq()); return S.trades; }
async function renderTrades(view) {
  if (!S.trades || S.trades.leagueId !== (S.viewLeague || S.trades.leagueId)) {
    view.innerHTML = '<div class="spinner"></div>';
    try { await loadTrades(); } catch (err) { fail(err); return; }
    if (S.route !== 'trades') return;
  }
  if (S.params.new || S.params.counter) return renderTradeBuilder(view);
  S.tb = null;
  const d = S.trades;
  const box = ['incoming', 'sent', 'history'].includes(S.params.box) ? S.params.box : (d.trades.some(t => tradeBox(t) === 'incoming') || !d.trades.length ? 'incoming' : 'sent');
  const list = d.trades.filter(t => tradeBox(t) === box);
  const n = b => d.trades.filter(t => tradeBox(t) === b).length;
  const empty = { incoming: 'No offers waiting for you.', sent: 'You have no offers waiting on someone else.', history: 'Finished trades show up here.' }[box];
  view.innerHTML = `
    <div class="hero"><div><h1>Trades</h1><p>Swap pool cards with anyone in ${esc(S.league?.name || 'your league')}: any number of cards for any number. An offer waits until the other player accepts, declines or counters it, and accepted cards change pools straight away.</p></div>
      ${d.canTrade ? `<a class="btn gold" href="#trades?new=1">${I.trade} New trade</a>` : ''}</div>
    ${d.canTrade ? '' : `<div class="panel small muted" style="margin-bottom:16px">${isAdminAccount() ? 'Trading is between league members, so the admin account can\'t trade. Use “Move to…” on a card to move it yourself.' : S.league?.status === 'ended' ? 'This league has ended, so trading is closed. Its trades stay here as a record.' : 'Join this league to trade with its players.'}</div>`}
    <div class="player-tabs">
      <a href="#trades?box=incoming" class="${box === 'incoming' ? 'sel' : ''}">Incoming <span class="${n('incoming') ? 'tbadge' : 'dim'}">${n('incoming')}</span></a>
      <a href="#trades?box=sent" class="${box === 'sent' ? 'sel' : ''}">Sent <span class="dim">${n('sent')}</span></a>
      <a href="#trades?box=history" class="${box === 'history' ? 'sel' : ''}">History <span class="dim">${n('history')}</span></a>
    </div>
    <div class="trades">${list.map(tradeCardHtml).join('') || `<div class="empty"><p>${empty}</p>${box !== 'history' && d.canTrade ? `<a class="btn gold" href="#trades?new=1">${I.trade} Start a trade</a>` : ''}</div>`}</div>`;
  $$('[data-trade]', view).forEach(el => {
    const t = d.trades.find(x => x.id === el.dataset.trade);
    const cards = t.offers.flatMap(o => o.cards);
    $$('[data-zoom]', el).forEach(b => b.onclick = () => cardModal({ ...cards.find(c => String(c.id) === b.dataset.zoom), id: null }));
    $$('[data-act]', el).forEach(b => b.onclick = () => tradeAction(t, b.dataset.act));
  });
}

async function tradeAction(t, act) {
  if (act === 'counter') return go(`#trades?counter=${t.id}`);
  const { give, get } = tradeSides(t);
  const names = cs => cs.length ? cs.map(c => `<b>${esc(c.name)}</b>`).join(', ') : 'nothing';
  const ask = {
    accept: ['Accept this trade?', `You give ${names(give)} and get ${names(get)}. The cards change pools right away.`, 'Accept trade', false],
    decline: [`Decline ${esc(t.other.name)}'s offer?`, 'The trade ends. You can always start a new one.', 'Decline', true],
    cancel: ['Cancel your offer?', `${esc(t.other.name)} won't be able to accept it any more.`, 'Cancel offer', true],
  }[act];
  if (!await confirmBox(...ask)) return;
  try {
    await post(`/trades/${t.id}/${act}`);
    toast(act === 'accept' ? `${I.check} Trade done. The cards are in your pools.` : act === 'decline' ? 'Offer declined.' : 'Offer cancelled.', 'good');
    S.trades = null; S.pools = null;
    await loadState();
    go(act === 'accept' ? '#trades?box=history' : `#trades?box=${act === 'cancel' ? 'sent' : 'incoming'}`);
  } catch (err) { fail(err); S.trades = null; render(); }
}

// ---- the builder: both pools side by side, a tray with the offer ----
async function renderTradeBuilder(view) {
  const d = S.trades;
  if (!d.canTrade) { go('#trades'); return; }
  if (!S.pools) {
    view.innerHTML = '<div class="spinner"></div>';
    try { S.pools = (await api('/pools' + lq())).pools; } catch (err) { fail(err); return; }
    if (S.route !== 'trades') return;
  }
  const counter = S.params.counter ? d.trades.find(t => t.id === S.params.counter && t.status === 'open' && t.turn === 'me') : null;
  if (S.params.counter && !counter) { toast('That offer has already been answered.', 'err'); go('#trades'); return; }
  const key = counter ? `c:${counter.id}` : 'new';
  if (!S.tb || S.tb.key !== key) {
    const s = counter ? tradeSides(counter) : { give: [], get: [] };
    S.tb = { key, with: counter?.other.id || S.params.with || '', give: new Set(s.give.map(c => c.id)), get: new Set(s.get.map(c => c.id)), note: '', q: '', rarity: '' };
  }
  const tb = S.tb;
  const partners = S.pools.filter(p => p.userId !== S.me.id && S.members.some(m => m.id === p.userId));
  if (!partners.some(p => p.userId === tb.with)) { if (tb.with) { tb.get.clear(); } tb.with = partners[0]?.userId || ''; }
  const mine = S.pools.find(p => p.userId === S.me.id);
  const theirs = partners.find(p => p.userId === tb.with);
  const cardsOf = p => (p ? p.packs.flatMap(k => k.cards) : []);
  const held = new Set(d.held);
  const byId = new Map([...cardsOf(mine), ...cardsOf(theirs)].map(c => [c.id, c]));
  // Cards that left a pool since the offer was made drop out of the tray.
  for (const id of tb.give) if (!cardsOf(mine).some(c => c.id === id)) tb.give.delete(id);
  for (const id of tb.get) if (!cardsOf(theirs).some(c => c.id === id)) tb.get.delete(id);
  const sortCards = list => [...list].sort((a, b) => (RARITY_ORDER[b.rarity] ?? 0) - (RARITY_ORDER[a.rarity] ?? 0) || a.name.localeCompare(b.name));
  const lim = d.limits?.side || 30;

  view.innerHTML = `
    <div class="hero"><div><h1>${counter ? `Counter ${esc(counter.other.name)}'s offer` : 'New trade'}</h1>
      <p>${counter ? 'Change the cards on either side, then send it back. They get the next say.' : 'Pick cards from your pool to give and from theirs to ask for. Any number on each side.'} Click a card to add or remove it.</p></div>
      <a class="btn ghost" href="#trades">${I.x} Back to trades</a></div>
    ${partners.length ? `
    <div class="set-tools">
      <label class="tb-with">Trade with <select class="input" id="tbWith" ${counter ? 'disabled' : ''}>${partners.map(p => `<option value="${p.userId}" ${p.userId === tb.with ? 'selected' : ''}>${esc(p.username)}</option>`).join('')}</select></label>
      <input type="search" id="tbQ" placeholder="Search both pools…" value="${esc(tb.q)}">
      <select class="input" id="tbR"><option value="">All rarities</option>${['mythic', 'rare', 'uncommon', 'common'].map(r => `<option value="${r}" ${tb.rarity === r ? 'selected' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`).join('')}</select>
    </div>
    <div class="tb-pools">
      <section class="panel tb-pool"><h2>Your pool <span class="dim small" id="tbMineN"></span></h2><div class="tb-grid" id="tbMine"></div></section>
      <section class="panel tb-pool"><h2>${esc(theirs?.username || '')}'s pool <span class="dim small" id="tbTheirsN"></span></h2><div class="tb-grid" id="tbTheirs"></div></section>
    </div>
    <div class="panel tb-tray" id="tbTray"></div>` : `<div class="empty"><p>Nobody else is in this league yet.</p></div>`}`;
  if (!partners.length) return;

  const grid = (el, nEl, list, set, isMine) => {
    const q = tb.q.trim().toLowerCase();
    const shown = sortCards(list).filter(c => (!q || c.name.toLowerCase().includes(q) || (c.type || '').toLowerCase().includes(q)) && (!tb.rarity || c.rarity === tb.rarity));
    nEl.textContent = list.length ? `${shown.length === list.length ? '' : `${shown.length} of `}${plural(list.length, 'card')}` : '';
    el.innerHTML = shown.map(c => {
      const h = isMine && held.has(c.id);
      return `<button type="button" class="pick r-${esc(c.rarity)} ${set.has(c.id) ? 'sel' : ''} ${h ? 'held' : ''}" data-pick="${c.id}" ${h ? 'aria-disabled="true"' : ''} aria-pressed="${set.has(c.id)}" title="${esc(c.name)}${h ? ' (in another offer you sent)' : ''}">
        <img ${cardSrc(c.image, '(max-width: 600px) 30vw, 120px')} alt="${esc(c.name)}" loading="lazy">
        ${set.has(c.id) ? `<span class="pick-check">${I.check}</span>` : ''}${h ? '<span class="tc-tag">in an offer</span>' : c.foil ? '<span class="tc-tag">foil</span>' : ''}</button>`;
    }).join('') || `<p class="muted small">${list.length ? 'No cards match.' : 'No cards yet.'}</p>`;
    $$('[data-pick]', el).forEach(b => b.onclick = () => {
      const id = Number(b.dataset.pick);
      if (isMine && held.has(id)) { toast(`${esc(byId.get(id).name)} is in another offer you sent. Cancel that one first, or wait for an answer.`); return; }
      if (set.has(id)) set.delete(id);
      else if (set.size >= lim) { toast(`Up to ${lim} cards on each side.`); return; }
      else set.add(id);
      paintAll();
    });
  };
  const tray = () => {
    const strip = (set, label) => tradeStrip([...set].map(id => byId.get(id)).filter(Boolean), label, [], true);
    const total = tb.give.size + tb.get.size;
    $('#tbTray', view).innerHTML = `
      <div class="trade-sides">${strip(tb.give, 'You give')}<div class="tswap" aria-hidden="true">${I.trade}</div>${strip(tb.get, `You get from ${esc(theirs.username)}`)}</div>
      <div class="row tb-send">
        <input id="tbNote" maxlength="200" placeholder="Add a note (optional)" value="${esc(tb.note)}">
        <button class="btn gold" id="tbSend" ${total ? '' : 'disabled'}>${I.trade} ${counter ? 'Send counter' : 'Send offer'}</button>
      </div>`;
    $$('#tbTray [data-zoom]', view).forEach(b => b.onclick = () => { const id = Number(b.dataset.zoom); tb.give.delete(id); tb.get.delete(id); paintAll(); });
    $('#tbNote', view).oninput = e => { tb.note = e.target.value; };
    $('#tbSend', view).onclick = sendOffer;
  };
  const paintAll = () => {
    grid($('#tbMine', view), $('#tbMineN', view), cardsOf(mine), tb.give, true);
    grid($('#tbTheirs', view), $('#tbTheirsN', view), cardsOf(theirs), tb.get, false);
    tray();
  };
  const sendOffer = async () => {
    const body = { give: [...tb.give], get: [...tb.get], note: tb.note };
    const btn = $('#tbSend', view);
    btn.disabled = true;
    try {
      if (counter) await post(`/trades/${counter.id}/counter`, body);
      else await post('/trades', { ...body, to: tb.with, league: S.viewLeague });
      toast(`${I.trade} ${counter ? 'Counter' : 'Offer'} sent to ${esc(theirs.username)}.`, 'good');
      S.tb = null; S.trades = null;
      go('#trades?box=sent');
    } catch (err) { fail(err); S.pools = null; S.trades = null; render(); }
  };
  $('#tbWith', view).onchange = e => { tb.with = e.target.value; tb.get.clear(); renderTradeBuilder(view); };
  $('#tbQ', view).oninput = e => { tb.q = e.target.value; paintAll(); };
  $('#tbR', view).onchange = e => { tb.rarity = e.target.value; paintAll(); };
  paintAll();
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
    const s = stats.get(p.id) || { id: p.id, name: p.name, games: 0, wins: 0, packs: 0, sac: 0, mythics: 0, rares: 0 };
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
      <tbody>${table.map((s, i) => `<tr><td>${i === 0 && s.wins ? `${I.crown} ` : ''}<b>${plink(s.id, s.name)}</b></td><td class="num">${s.games}</td><td class="num">${s.wins}</td><td class="num">${Math.round(s.wins / s.games * 100)}%</td><td class="num">${s.packs}</td><td class="num">${s.sac}</td><td class="num">${s.rares}</td><td class="num">${s.mythics}</td></tr>`).join('')}</tbody></table>
    </div>
    <div class="grid" style="gap:12px">${pods.map(g => {
      const w = g.players.find(p => p.id === g.winnerId);
      return `<details class="hgame"><summary>
        <div><b class="hname">${esc(g.name)} · ${fmtDate(g.finishedAt || g.createdAt)}</b> <span class="muted">· ${I.crown} ${esc(w?.name || '—')}${w?.precon ? ` with ${esc(w.precon)}` : ''}${g.spin ? ` · spun ${esc(g.spin.set.name)}` : ''}${g.vote?.winnerId ? ` · ${I.vote} ${esc(nameIn(g, g.vote.winnerId))}` : ''}</span></div>
        <div class="row">${g.spin ? icon(g.spin.set) : ''}${g.players.flatMap(p => p.packs).filter(k => k.source === 'sacrifice' && k.status !== 'choosing').slice(0, 8).map(k => icon(k.set)).join('')}</div>
      </summary><div class="body">${isAdmin() ? `<div class="spread small muted" style="margin-bottom:8px"><span>Admin: fix a mistake (winner, precons, who played), or delete the pod (undo-able for 30 days).</span><span class="row"><button class="btn sm" data-hfix="${g.id}">Fix pod</button><button class="btn danger sm" data-hdel="${g.id}">${I.trash} Delete pod</button></span></div>` : ''}${g.players.map(p => {
        const pulls = p.packs.filter(k => k.status === 'opened').flatMap(k => k.cards);
        const hits = sortForReveal(pulls).reverse().filter(c => c.rarity === 'mythic' || c.rarity === 'rare');
        return `<div class="hplayer">
          <div class="spread"><div><b>${g.winnerId === p.id ? `${I.crown} ` : ''}${esc(p.name)}</b> ${p.precon ? `<span class="muted small">· ${esc(p.precon)}</span>` : ''}</div>
          ${pulls.length ? `<button class="btn sm" data-copy="${g.id}:${p.id}">${I.copy} Copy ${pulls.length} pulls</button>` : ''}</div>
          <div class="row small muted" style="margin-top:6px">${p.packs.map(k => `<span class="chip">${k.status === 'choosing' ? '' : icon(k.set)}${k.status === 'choosing' ? 'unchosen' : esc(k.set.name)}${k.source === 'sacrifice' ? ` ${I.flame}` : ''}${k.status !== 'opened' ? ' (unopened)' : ` · ${k.cards.length}`}${isAdmin() ? `<button class="chip-x" data-delpack="${g.id}:${p.id}:${k.id}" title="Admin: delete this pack and its pulls">✕</button>` : ''}</span>`).join('') || 'No packs'}${p.sacrificed ? `<span class="chip">${I.flame} ${p.sacrificed} sacrificed</span>` : ''}</div>
          ${hits.length ? `<div class="mini-cards">${hits.map(c => `<img ${cardSrc(c.image, '72px')} alt="${esc(c.name)}" title="${esc(c.name)}" loading="lazy" data-card="${g.id}:${p.id}:${esc(c.set)}/${esc(c.number)}">`).join('')}</div>` : ''}
        </div>`;
      }).join('')}</div></details>`;
    }).join('')}</div>`;
  const lookup = key => { const [gid, pid] = key.split(':'); const g = pods.find(x => x.id === gid); return g?.players.find(p => p.id === pid); };
  $$('[data-hdel]', view).forEach(b => b.onclick = () => deletePodFlow(pods.find(x => x.id === b.dataset.hdel)));
  $$('[data-hfix]', view).forEach(b => b.onclick = () => fixPodFlow(pods.find(x => x.id === b.dataset.hfix)));
  $$('[data-delpack]', view).forEach(b => b.onclick = e => {
    e.preventDefault(); e.stopPropagation();
    const [gid, pid, kid] = b.dataset.delpack.split(':');
    const owner = lookup(`${gid}:${pid}`);
    deletePackFlow(gid, owner.packs.find(k => k.id === kid), owner);
  });
  $('#clearHist', view)?.addEventListener('click', async () => {
    const cards = pods.reduce((s, g) => s + g.players.reduce((t, p) => t + p.packs.reduce((u, k) => u + (k.cards?.length || 0), 0), 0), 0);
    if (!await typedConfirm('Clear league history?', `This deletes all <b>${plural(pods.length, 'finished pod')}</b> (and any discarded ones), the standings built from them, and their <b>${cards} cards</b> from everyone's pools. Running pods are not touched. ${UNDO_NOTE}`, 'DELETE', `${I.trash} Clear history`)) return;
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

// =============== PLAYER PAGES, SEASON RECAP, DECK LISTS ===============
// Player names link to their page. Deleted players have no page.
const plink = (id, name) => (id && name !== 'Deleted player' ? `<a class="plink" href="#player?id=${encodeURIComponent(id)}${S.viewLeague ? `&league=${encodeURIComponent(S.viewLeague)}` : ''}">${esc(name)}</a>` : esc(name));
const pctOf = (a, b) => (b ? `${Math.round(a / b * 100)}%` : '—');
const tile = (value, label, sub = '') => `<div class="fs-tile"><b>${value}</b><span>${label}${sub ? ` <em>${sub}</em>` : ''}</span></div>`;
const PIP_URL = sym => `https://svgs.scryfall.io/card-symbols/${encodeURIComponent(sym.replace(/\//g, ''))}.svg`;
const manaHtml = cost => esc(cost || '').replace(/\{([^}]+)\}/g, (_, s) => `<img class="ms" src="${PIP_URL(s)}" alt="{${s}}" loading="lazy">`);
const colorPips = colors => (colors?.length ? colors : ['C']).map(c => `<img class="ms" src="${PIP_URL(c)}" alt="${c}" title="${({ W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' })[c]}">`).join('');
const pullCard = (c, extra = '') => `<figure class="pull" data-pull="${esc(c.set)}/${esc(c.number)}/${c.foil ? 'f' : ''}">
    <img ${cardSrc(c.image, '(max-width: 500px) 46vw, 140px')} alt="${esc(c.name)}" loading="lazy">
    <figcaption><b>${esc(c.name)}</b><span>${esc(c.rarity)}${c.foil ? ' · foil' : ''}${extra}</span></figcaption></figure>`;
function wirePulls(view, cards) {
  $$('[data-pull]', view).forEach(el => el.onclick = () => {
    const c = cards.find(x => `${x.set}/${x.number}/${x.foil ? 'f' : ''}` === el.dataset.pull);
    if (c) cardModal(c);
  });
}

// ---------- deck lists ----------
const TYPE_ORDER = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land'];
const typeOf = c => { const front = String(c.type).split(' // ')[0]; return TYPE_ORDER.find(t => front.includes(t)) || 'Other'; };
function deckHtml(deck, { mine = false } = {}) {
  const cmd = deck.cards.filter(c => c.board === 'commander');
  const main = deck.cards.filter(c => c.board !== 'commander');
  const spells = main.filter(c => typeOf(c) !== 'Land');
  const curve = Array(8).fill(0);
  for (const c of spells) curve[Math.min(7, Math.floor(c.cmc))] += c.qty;
  const peak = Math.max(1, ...curve);
  const groups = TYPE_ORDER.concat('Other').map(t => [t, main.filter(c => typeOf(c) === t).sort((a, b) => a.cmc - b.cmc || a.name.localeCompare(b.name))]).filter(([, l]) => l.length);
  const avg = spells.length ? spells.reduce((n, c) => n + c.cmc * c.qty, 0) / spells.reduce((n, c) => n + c.qty, 0) : 0;
  const src = deck.url ? `<a href="${esc(deck.url)}" target="_blank" rel="noopener">${deck.source === 'moxfield' ? 'Moxfield' : 'Archidekt'} ↗</a>` : 'pasted list';
  return `<div class="deck">
    <div class="deck-head">
      ${cmd.map(c => `<img class="deck-cmd" ${cardSrc(c.image, '150px')} alt="${esc(c.name)}" data-dc="${esc(c.name)}" tabindex="0" role="button">`).join('')}
      <div class="deck-meta">
        <h3>${esc(deck.name)}</h3>
        <div class="deck-colors">${colorPips(deck.colors)}</div>
        <div class="small muted">${deck.count} cards · avg. mana value ${avg.toFixed(2)} · from ${src} · updated ${fmtDate(deck.updatedAt)}</div>
        ${cmd.length ? '' : `<div class="small muted">${mine ? 'No commander marked: pick one in your Account page.' : 'No commander marked.'}</div>`}
        ${deck.missing?.length ? `<div class="small" style="color:var(--accent)">Not found on Scryfall: ${deck.missing.map(esc).join(', ')}</div>` : ''}
        <div class="row" style="margin-top:8px"><button class="btn sm" id="deckCopy">${I.copy} Copy list</button></div>
      </div>
      <div class="deck-curve" aria-label="Mana curve">
        ${curve.map((n, i) => `<div class="dc-col" title="${n} card${n === 1 ? '' : 's'} at ${i === 7 ? '7+' : i}"><span>${n || ''}</span><i style="height:${Math.round(n / peak * 92)}px"></i><b>${i === 7 ? '7+' : i}</b></div>`).join('')}
      </div>
    </div>
    <div class="deck-types">${groups.map(([t, l]) => `<span class="chip">${t} <b>${l.reduce((n, c) => n + c.qty, 0)}</b></span>`).join('')}</div>
    <div class="deck-list">${groups.map(([t, l]) => `<div class="deck-group"><h4>${t} <span class="dim">(${l.reduce((n, c) => n + c.qty, 0)})</span></h4>
      ${l.map(c => `<div class="deck-line" data-dc="${esc(c.name)}" tabindex="0" role="button"><span class="q">${c.qty}</span><span class="n">${esc(c.name)}${c.foil ? ' <span class="dim">✦</span>' : ''}</span><span class="m">${manaHtml(c.mana)}</span></div>`).join('')}</div>`).join('')}</div>
  </div>`;
}
function wireDeck(view, deck) {
  $$('[data-dc]', view).forEach(el => el.onclick = () => {
    const c = deck.cards.find(x => x.name === el.dataset.dc);
    if (c) cardModal({ ...c, id: null });
  });
  $('#deckCopy', view)?.addEventListener('click', () => {
    const line = c => `${c.qty} ${c.name} (${String(c.set).toUpperCase()}) ${c.number}${c.foil ? ' *F*' : ''}`;
    const cmd = deck.cards.filter(c => c.board === 'commander');
    const main = deck.cards.filter(c => c.board !== 'commander');
    copyText([...(cmd.length ? ['Commander', ...cmd.map(line), '', 'Deck'] : []), ...main.map(line)].join('\n'), deck.name);
  });
}

// The deck panel on the Account page: import, pick the commander, remove.
async function renderDeckPanel(box) {
  if (!box) return;
  let deck;
  try { deck = (await api('/deck')).deck; } catch (err) { box.innerHTML = ''; return; }
  const legends = deck ? deck.cards.filter(c => /legendary|can be your commander/i.test(c.type)) : [];
  const cmdNames = deck ? deck.cards.filter(c => c.board === 'commander').map(c => c.name) : [];
  box.innerHTML = `<form class="panel grid" id="deckForm" style="margin-top:18px">
      <div class="spread"><h2 style="margin:0">Deck list</h2>${deck ? `<a class="btn sm" href="#player?id=${S.me.id}">See it on your page</a>` : ''}</div>
      <p class="small muted" style="margin:0">Show the deck you play on your player page: paste a public <b>Moxfield</b> or <b>Archidekt</b> link, or paste the list (one card per line, like <code>1 Sol Ring</code>). If a link won't load, use the site's <b>Export</b> option and paste the text. ${deck ? `Importing again replaces <b>${esc(deck.name)}</b> (${deck.count} cards).` : ''}</p>
      <label>Deck link<input name="url" type="url" placeholder="https://moxfield.com/decks/…" maxlength="300" value="${esc(deck?.url || '')}"></label>
      <details ${deck?.source === 'text' ? 'open' : ''}><summary class="small">…or paste the list</summary>
        <textarea name="text" rows="8" maxlength="40000" placeholder="Commander&#10;1 Atraxa, Praetors' Voice&#10;&#10;Deck&#10;1 Sol Ring&#10;1 Command Tower&#10;…"></textarea>
      </details>
      <div class="row"><button class="btn gold" id="deckGo">${deck ? 'Update deck' : 'Import deck'}</button>${deck ? `<button type="button" class="btn danger sm" id="deckDel">${I.trash} Remove deck</button>` : ''}</div>
      ${deck ? `<div class="grid" style="gap:8px;border-top:1px solid var(--line);padding-top:12px">
        <label>Deck name<input id="deckName" value="${esc(deck.name)}" maxlength="80"></label>
        ${legends.length ? `<div class="grid" style="gap:6px"><span class="small muted">Commander (tick one, or two for partners)</span><div class="cmd-picks" id="deckCmd">${legends.map(c => `<label class="chip"><input type="checkbox" value="${esc(c.name)}" ${cmdNames.includes(c.name) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('')}</div></div>` : '<p class="small muted" style="margin:0">No legendary cards in this list to make the commander.</p>'}
        <div><button type="button" class="btn sm" id="deckSave">Save name and commander</button></div>
      </div>` : ''}
    </form>`;
  $('#deckForm', box).onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const text = (f.text || '').trim();
    const body = text ? { text } : { url: (f.url || '').trim() };
    const btn = $('#deckGo', box);
    btn.disabled = true; btn.textContent = 'Looking up cards…';
    try {
      const r = await post('/deck', body);
      toast(`${esc(r.deck.name)} imported: ${r.deck.count} cards${r.deck.missing?.length ? `, ${r.deck.missing.length} not found` : ''}.`, 'good');
      await loadState().catch(() => {});
      renderDeckPanel(box);
    } catch (err) { fail(err); btn.disabled = false; btn.textContent = deck ? 'Update deck' : 'Import deck'; }
  };
  $('#deckDel', box)?.addEventListener('click', async () => {
    if (!await confirmBox('Remove your deck list?', 'It disappears from your player page. Your precon name stays.', `${I.trash} Remove`, true)) return;
    try { await del('/deck'); toast('Deck list removed.', 'good'); renderDeckPanel(box); } catch (err) { fail(err); }
  });
  $('#deckSave', box)?.addEventListener('click', async () => {
    const sel = $('#deckCmd', box);
    const commanders = sel ? $$('input:checked', sel).map(i => i.value) : undefined;
    if (commanders && commanders.length > 2) { toast('Pick at most two commanders.'); return; }
    try { await api('/deck', { method: 'PUT', body: { name: $('#deckName', box).value, commanders } }); toast('Deck saved.', 'good'); renderDeckPanel(box); } catch (err) { fail(err); }
  });
}

// ---------- player page ----------
async function renderPlayer(view) {
  const id = S.params.id;
  if (!id) { go('#league'); return; }
  view.innerHTML = '<div class="spinner"></div>';
  let d;
  const q = S.params.league ? `?league=${encodeURIComponent(S.params.league)}` : '';
  try { d = await api(`/players/${encodeURIComponent(id)}${q}`); } catch (err) { view.innerHTML = `<div class="empty"><h2>Player not found</h2><p>${esc(err.message)}</p><p><a href="#league">Back to the league</a></p></div>`; return; }
  if (S.route !== 'player' || S.params.id !== id) return;
  const { player, league, stats, deck } = d;
  const t = stats.totals;
  const mine = player.id === S.me.id;
  const scope = league ? league.id : 'all';
  const leagueTabs = player.leagues.length ? `<div class="row seg-links">${player.leagues.map(l => `<a class="chip ${scope === l.id ? 'gold' : ''}" href="#player?id=${player.id}&league=${l.id}">${esc(l.name)}${l.status === 'ended' ? ' <span class="dim">(ended)</span>' : ''}</a>`).join('')}${player.leagues.length > 1 ? `<a class="chip ${scope === 'all' ? 'gold' : ''}" href="#player?id=${player.id}&league=all">All leagues</a>` : ''}</div>` : '';
  const opp = stats.opponents;
  view.innerHTML = `
    <div class="hero"><div>
      <h1>${esc(player.username)}${mine ? ' <span class="dim small">(you)</span>' : ''}</h1>
      <p>${player.precon ? `Plays <b>${esc(player.precon)}</b>. ` : ''}${league?.rank ? `#${league.rank} in ${esc(league.name)}. ` : ''}${league ? '' : 'Every league combined. '}Member since ${fmtDate(player.joined)}.</p>
    </div>${leagueTabs}</div>
    ${t.pods || t.packs ? `
    <div class="fs-tiles">
      ${tile(t.pods, 'Pods played', t.missed ? `${t.missed} missed` : '')}
      ${tile(t.wins, 'Wins', t.pods ? pctOf(t.wins, t.pods) : '')}
      ${tile(t.streak.best, 'Best win streak', t.streak.current > 1 ? `on ${t.streak.current} now` : '')}
      ${tile(t.voteWins, 'Bonus votes won')}
      ${tile(t.packs, 'Packs opened', `${t.cards} cards`)}
      ${tile(t.mythics, 'Mythics', `${t.rares} rares`)}
      ${tile(t.foils, 'Foils')}
    </div>
    ${stats.form.length ? `<div class="panel form-strip"><span class="small muted">Last ${stats.form.length} pods</span>${stats.form.map(w => `<span class="res ${w ? 'w' : 'l'}" title="${w ? 'Won' : 'Lost'}">${w ? 'W' : 'L'}</span>`).join('')}</div>` : ''}
    <div class="league-grid player-grid">
      <section class="panel">
        <h2>Rivals</h2>
        <div class="rivals">
          <div class="rival">${I.flame}<div><span class="small muted">Nemesis</span><b>${stats.nemesis ? plink(stats.nemesis.id, stats.nemesis.name) : '—'}</b><span class="small muted">${stats.nemesis ? `won ${plural(stats.nemesis.theirWins, 'pod')} of ${stats.nemesis.pods} together` : 'Nobody has beaten them yet'}</span></div></div>
          <div class="rival">${I.crown}<div><span class="small muted">Favourite to beat</span><b>${stats.prey ? plink(stats.prey.id, stats.prey.name) : '—'}</b><span class="small muted">${stats.prey ? `at the table for ${plural(stats.prey.myWins, 'win')}` : 'No wins yet'}</span></div></div>
        </div>
        ${opp.length ? `<table class="standings"><thead><tr><th>Opponent</th><th class="num">Pods</th><th class="num" title="Pods ${esc(player.username)} won">${esc(player.username)} won</th><th class="num">They won</th></tr></thead>
          <tbody>${opp.map(o => `<tr><td>${plink(o.id, o.name)}</td><td class="num">${o.pods}</td><td class="num">${o.myWins}</td><td class="num">${o.theirWins}</td></tr>`).join('')}</tbody></table>` : ''}
      </section>
      <section class="panel">
        <h2>Precons played</h2>
        ${stats.precons.length ? `<table class="standings"><thead><tr><th>Precon</th><th class="num">Pods</th><th class="num">Wins</th><th class="num">Win %</th></tr></thead>
          <tbody>${stats.precons.map(p => `<tr><td>${esc(p.name)}</td><td class="num">${p.pods}</td><td class="num">${p.wins}</td><td class="num">${pctOf(p.wins, p.pods)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No precon recorded in their pods.</p>'}
        ${stats.sets.length ? `<h2 style="margin-top:18px">Sets opened</h2><div class="set-bars">${stats.sets.map(s => `<div class="sb"><span>${s.icon ? `<img class="set-icon" src="${esc(s.icon)}" alt="">` : ''}${esc(s.name)}</span><i style="width:${Math.round(s.packs / stats.sets[0].packs * 100)}%"></i><b>${s.packs}</b></div>`).join('')}</div>` : ''}
      </section>
    </div>
    ${stats.bestPulls.length ? `<section class="panel" style="margin-top:16px"><h2>Best pulls</h2><div class="pulls">${stats.bestPulls.map(c => pullCard(c)).join('')}</div></section>` : ''}
    ${stats.recent.length ? `<section class="panel" style="margin-top:16px;overflow-x:auto"><h2>Recent pods</h2>
      <table class="standings"><thead><tr><th>Pod</th><th>Result</th><th>Played</th><th>Against</th><th>Spun</th></tr></thead>
      <tbody>${stats.recent.map(p => `<tr><td><b>${esc(p.name)}</b><div class="small muted">${fmtDate(p.at)}</div></td><td>${p.won ? `<span class="res w">W</span>` : `<span class="res l">L</span> <span class="small muted">${esc(p.winner || '—')}</span>`}${p.vote ? ` ${I.vote}` : ''}</td><td class="small">${esc(p.precon) || '<span class="dim">—</span>'}</td><td class="small">${p.others.map(esc).join(', ')}</td><td class="small">${esc(p.spun || '—')}</td></tr>`).join('')}</tbody></table></section>` : ''}
    ` : `<div class="panel muted">${league ? `No finished pods in ${esc(league.name)} yet.` : 'No finished pods yet.'}</div>`}
    <section class="panel" style="margin-top:16px"><h2>Deck</h2>
      ${deck ? deckHtml(deck, { mine }) : `<p class="muted">${mine ? 'You haven\'t added your deck list yet. <a href="#account">Import it from Moxfield, Archidekt or a pasted list</a>.' : 'No deck list yet.'}</p>`}
    </section>`;
  wirePulls(view, stats.bestPulls);
  if (deck) wireDeck(view, deck);
}

// ---------- season recap ----------
async function renderRecap(view) {
  const id = S.params.league || S.viewLeague;
  if (!id) { go('#league'); return; }
  view.innerHTML = '<div class="spinner"></div>';
  let d;
  try { d = await api(`/leagues/${encodeURIComponent(id)}/recap`); } catch (err) { fail(err); view.innerHTML = ''; return; }
  if (S.route !== 'recap') return;
  const { league, champion, totals: t, awards, topPulls, spun, standings } = d;
  const over = league.status === 'ended';
  const span = t.first ? `${fmtDate(t.first)} – ${over ? fmtDate(league.endedAt) : 'today'}` : '';
  view.innerHTML = `
    <div class="hero"><div><h1>${esc(league.name)}: ${over ? 'Season recap' : 'Season so far'}</h1><p>${span}${over ? '' : ' · The league is still running, so this can change.'}</p></div>
      <div class="row"><a class="btn ghost" href="#league">Back to the league</a>${t.pods ? `<button class="btn" id="recapCopy">${I.copy} Copy for Discord</button>` : ''}</div></div>
    ${!t.pods ? '<div class="empty"><h2>No finished pods yet</h2><p>The recap fills in once pods are finished.</p></div>' : `
    ${champion ? `<div class="champ">${I.crown}<div><span>${over ? 'League champion' : 'Leading the league'}</span><b>${plink(champion.id, champion.name)}</b><em>${plural(champion.wins, 'win')} in ${plural(champion.pods, 'pod')}</em></div></div>` : ''}
    <div class="fs-tiles">
      ${tile(t.pods, 'Pods played')}${tile(t.packs, 'Packs opened')}${tile(t.cards, 'Cards pulled')}${tile(t.mythics, 'Mythics')}${tile(t.foils, 'Foils')}${tile(t.precons, 'Precons used')}
    </div>
    <h2>Awards</h2>
    <div class="awards">${awards.map(a => `<div class="award ${a.key === 'pull' ? 'big' : ''}">
      ${a.card ? `<img src="${esc(a.card.image)}" alt="${esc(a.card.name)}" data-pull="${esc(a.card.set)}/${esc(a.card.number)}/${a.card.foil ? 'f' : ''}" tabindex="0" role="button">` : ''}
      <div><span class="aw-title">${esc(a.title)}</span><b>${a.winners.map(w => plink(w.id, w.name)).join(' & ')}</b><span class="aw-val">${esc(a.value)}</span><span class="small muted">${esc(a.blurb)}</span></div></div>`).join('')}</div>
    ${topPulls.length ? `<section class="panel" style="margin-top:16px"><h2>Top pulls</h2><div class="pulls">${topPulls.map(c => pullCard(c, ` · ${esc(c.owner)}`)).join('')}</div></section>` : ''}
    <div class="league-grid" style="margin-top:16px">
      <section class="panel" style="overflow-x:auto"><h2>${over ? 'Final standings' : 'Standings'}</h2>
        <table class="standings"><thead><tr><th>Player</th><th class="num">Pods</th><th class="num">Wins</th><th class="num">Win %</th><th class="num" title="Longest win streak">Streak</th><th class="num">Mythics</th><th class="num">Foils</th></tr></thead>
        <tbody>${standings.filter(s => s.pods || s.packs).map((s, i) => `<tr><td>${i === 0 && s.wins ? `${I.crown} ` : ''}<b>${plink(s.id, s.name)}</b></td><td class="num">${s.pods}</td><td class="num">${s.wins}</td><td class="num">${pctOf(s.wins, s.pods)}</td><td class="num">${s.streak}</td><td class="num">${s.mythics}</td><td class="num">${s.foils}</td></tr>`).join('')}</tbody></table>
      </section>
      ${spun.length ? `<section class="panel"><h2>Most spun sets</h2><div class="set-bars">${spun.map(s => `<div class="sb"><span>${s.icon ? `<img class="set-icon" src="${esc(s.icon)}" alt="">` : ''}${esc(s.name)}</span><i style="width:${Math.round(s.times / spun[0].times * 100)}%"></i><b>${s.times}</b></div>`).join('')}</div></section>` : ''}
    </div>`}`;
  wirePulls(view, [...topPulls, ...awards.filter(a => a.card).map(a => a.card)]);
  $('#recapCopy', view)?.addEventListener('click', () => {
    const lines = [
      `**${league.name}: ${over ? 'Season recap' : 'Season so far'}**`,
      champion ? `👑 ${over ? 'Champion' : 'Leader'}: ${champion.name} (${plural(champion.wins, 'win')} in ${plural(champion.pods, 'pod')})` : '',
      `${plural(t.pods, 'pod')} · ${plural(t.packs, 'pack')} · ${plural(t.mythics, 'mythic')} · ${plural(t.foils, 'foil')}`,
      '',
      ...awards.map(a => `• ${a.title}: ${a.winners.map(w => w.name).join(' & ')} (${a.value})`),
      '',
      `${location.origin}/#recap?league=${league.id}`,
    ].filter((l, i, all) => l || all[i - 1]);
    copyText(lines.join('\n'), 'Recap');
  });
}

// =============== ADMIN TAB ===============
// Dashboard, announcement, pack manager, players, admin log (undo), backups.
const UNDO_NOTE = 'You can undo it for 30 days from <b>Admin → Admin log</b>.';
// A small form dialog: fields = [{ name, label, value, type, options, placeholder }]. Resolves to the values, or null.
function formBox(title, body, fields, okLabel = 'Save', danger = false) {
  return new Promise(resolve => {
    const m = $('#modal');
    m.innerHTML = `<div class="box"><div class="dialog"><form id="fbx" class="grid" style="gap:10px">
      <h2 style="margin:0">${title}</h2>${body ? `<p class="muted" style="margin:0">${body}</p>` : ''}
      ${fields.map(f => `<label>${f.label}${f.type === 'select'
        ? `<select class="input" name="${f.name}">${f.options.map(o => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
        : `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}" maxlength="${f.max || 300}" ${f.required ? 'required' : ''}>`}</label>`).join('')}
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-r="0">Cancel</button><button class="btn ${danger ? 'danger' : 'gold'}">${okLabel}</button></div>
    </form></div></div>`;
    m.hidden = false;
    const done = v => { m.hidden = true; m.innerHTML = ''; resolve(v); };
    $('[data-r="0"]', m).onclick = () => done(null);
    m.onclick = e => { if (e.target === m) done(null); };
    $('#fbx', m).onsubmit = e => { e.preventDefault(); done(Object.fromEntries(new FormData(e.target))); };
    $('input, select', m)?.focus();
  });
}
const ago = iso => {
  if (!iso) return 'never';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const kb = n => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);

async function renderAdmin(view) {
  if (!isAdmin()) { view.innerHTML = '<div class="empty"><h2>Admins only</h2></div>'; return; }
  view.innerHTML = '<div class="spinner"></div>';
  let o, users, packs, log, backups;
  try {
    [o, users, packs, log, backups] = await Promise.all([
      api('/admin/overview'), api('/admin/users'), api('/admin/packs' + lq()), api('/admin/log?limit=60'), api('/admin/backups'),
    ]);
  } catch (err) { fail(err); return; }
  if (S.route !== 'admin') return;
  const c = o.counts;
  const league = S.league;
  const members = S.members || [];
  const ann = o.announcement;
  const lastBackup = o.backups.latest;
  const refused = Object.values(o.limits.refused24h).reduce((a, b) => a + b, 0);
  const attention = [
    ...o.stuck.map(p => `${I.play} <a href="#pods?pod=${p.id}">${esc(p.name)}</a> (${esc(p.league)}) hasn't changed since ${ago(p.since)}.`),
    ...o.piles.filter(p => p.count >= 3).map(p => `${I.pack} ${esc(p.name)} has ${plural(p.count, 'unopened pack')} in ${esc(p.league)}.`),
    ...(c.feedbackNew ? [`${I.bulb} ${plural(c.feedbackNew, 'new suggestion')} on <a href="#account">your Account page</a>.`] : []),
    ...(!o.email.enabled ? [`${I.x} Password-reset emails are off.`] : o.email.last.ok === false ? [`${I.x} The last reset email failed ${ago(o.email.last.at)}: ${esc(o.email.last.error)}`] : []),
    ...(o.discord.enabled && o.discord.last.ok === false ? [`${I.x} The last Discord post failed ${ago(o.discord.last.at)}: ${esc(o.discord.last.error)}`] : []),
    ...(refused ? [`${I.flag} ${plural(refused, 'request')} hit a rate limit in the last 24 hours.`] : []),
    ...(!lastBackup || Date.now() - Date.parse(lastBackup.at) > 2 * 864e5 ? [`${I.x} No backup in the last 2 days.`] : []),
  ];
  view.innerHTML = `
    <div class="hero"><div><h1>Admin</h1><p>Site tools. Changes here show in the league's activity feed where players would care, and every action is in the admin log below, most with <b>Undo</b> for 30 days.</p></div></div>
    <div class="fs-tiles">
      ${tile(c.players, 'Players', c.suspended ? `${c.suspended} suspended` : '')}${tile(c.activeLeagues, 'Active leagues')}${tile(c.runningPods, 'Running pods')}
      ${tile(c.unopenedPacks, 'Unopened packs')}${tile(c.feedbackNew, 'New suggestions')}
      ${tile(o.email.enabled ? (o.email.last.ok === false ? 'Failing' : 'On') : 'Off', 'Reset emails', o.email.last.at ? `last ${ago(o.email.last.at)}` : '')}
      ${tile(lastBackup ? ago(lastBackup.at) : 'none', 'Last backup', `${o.backups.count} kept`)}
      ${tile(o.discord.enabled ? (o.discord.last.ok === false ? 'Failing' : 'On') : 'Off', 'Discord posts', o.discord.last.at ? `last ${ago(o.discord.last.at)}` : (o.discord.invite ? 'invite link on' : ''))}
    </div>
    ${o.discord.enabled ? '<p class="small muted" style="margin:-6px 0 14px">Finished pods, season recaps and announcements post to your Discord channel. <button type="button" class="btn sm ghost" id="discordTest">Send a test post</button></p>' : ''}
    <section class="panel admin-attn"><h2>Needs attention</h2>${attention.length ? `<ul class="rules-list">${attention.map(a => `<li>${a}</li>`).join('')}</ul>` : '<p class="muted" style="margin:0">Nothing. All quiet.</p>'}
      <p class="small muted" style="margin:10px 0 0">Rate limits per IP per minute: ${o.limits.limits.all} requests, ${o.limits.limits.api} API calls, ${o.limits.limits.heavy} heavy lookups, ${o.limits.limits.streams} live connections. Refused in the last 24 h: ${Object.entries(o.limits.refused24h).map(([k, v]) => `${k} ${v}`).join(', ')}.</p></section>

    <div class="league-grid admin-grid">
      <section class="panel">
        <h2>${I.pack} Give packs</h2>
        ${league && league.status === 'active' ? `<form id="grantForm" class="grid" style="gap:10px">
          <p class="small muted" style="margin:0">To players in <b>${esc(league.name)}</b> (switch leagues with the picker at the top). They show up in each player's "packs waiting for you" and count in their pool and stats, not as pods played.</p>
          <div class="cmd-picks">${members.map(m => `<label class="chip"><input type="checkbox" name="u" value="${m.id}"> ${esc(m.username)}</label>`).join('')}</div>
          <div class="row" style="gap:8px"><button type="button" class="btn sm ghost" id="grantAll">Everyone</button><button type="button" class="btn sm ghost" id="grantNone">Nobody</button></div>
          <div class="rules-grid">
            <label>Packs each<input type="number" name="count" min="1" max="10" value="1"></label>
            <label>Which set<select class="input" name="mode"><option value="set">A set I pick</option><option value="wheel">Spin the league wheel</option><option value="choice">Their choice</option></select></label>
          </div>
          <label id="grantSetRow">Set<select class="input" name="setCode">${S.sets.map(s => `<option value="${s.code}">${esc(s.name)} (${s.year})</option>`).join('')}</select></label>
          <label>Reason <span class="dim small">(shown in the feed)</span><input name="reason" maxlength="300" placeholder="e.g. make-up for a missed pod"></label>
          <button class="btn gold">${I.pack} Give packs</button>
        </form>` : '<p class="muted">Pick an active league with the league picker at the top first.</p>'}
      </section>
      <section class="panel">
        <h2>Unopened packs</h2>
        <p class="small muted" style="margin:0 0 10px">Every unopened pack in ${esc(league?.name || 'this league')}. ✕ takes one back (${'undo-able'}).</p>
        <div class="admin-packs">${packs.players.filter(p => p.packs.length).map(p => `<div class="admin-pk"><b>${plink(p.id, p.username)}</b><div class="row">${p.packs.map(k => `<span class="chip">${k.status === 'choosing' ? I.question : icon(k.set)} ${k.status === 'choosing' ? 'Their choice' : esc(k.set?.name || '')} <span class="dim">· ${esc(k.podName)}</span><button class="chip-x" data-take="${k.podId}:${k.packId}" data-who="${esc(p.username)}" title="Take this pack back">✕</button></span>`).join('')}</div></div>`).join('') || '<p class="muted">None.</p>'}</div>
      </section>
    </div>

    <section class="panel" style="margin-top:16px">
      <h2>${I.flag} Announcement</h2>
      <form id="annForm" class="grid" style="gap:10px">
        <p class="small muted" style="margin:0">A banner at the top of the site for every signed-in player. Players can hide it for themselves.${ann?.text ? ` Showing now${ann.until ? ` until ${fmtDate(ann.until)}` : ''}.` : ''}</p>
        <label>Message<input name="text" maxlength="280" value="${esc(ann?.text || '')}" placeholder="e.g. Pod night Friday at 7pm!"></label>
        <label>Show until <span class="dim small">(optional)</span><input name="until" type="date" value="${ann?.until ? ann.until.slice(0, 10) : ''}"></label>
        ${o.discord.enabled ? '<label class="check"><input type="checkbox" name="discord" checked><span>Also post it to Discord</span></label>' : ''}
        <div class="row"><button class="btn gold">Save announcement</button>${ann?.text ? '<button type="button" class="btn danger sm" id="annClear">Clear</button>' : ''}</div>
      </form>
    </section>

    <section class="panel" style="margin-top:16px;overflow-x:auto">
      <h2>${I.user} Players</h2>
      <p class="small muted">${users.emailEnabled ? 'Password-reset emails are on.' : 'Password-reset emails are <b>off</b>: use <b>Reset link</b> and send the link yourself.'} <b>View as</b> shows the site exactly as that player sees it, read-only.</p>
      <table class="standings admin-users"><thead><tr><th>Player</th><th>Email</th><th>Joined</th><th></th></tr></thead>
      <tbody>${users.users.map(u => `<tr class="${u.suspended ? 'dim' : ''}"><td><b>${u.adminAccount ? esc(u.username) : plink(u.id, u.username)}</b>${u.adminAccount ? ' <span class="chip gold">admin account</span>' : u.staff ? ' <span class="chip gold" title="A player with admin powers">admin</span>' : ''}${u.test ? ' <span class="chip" title="Cannot sign in; an admin plays for it">test player</span>' : ''}${u.suspended ? ` <span class="chip" title="${esc(u.suspendedReason)}">suspended</span>` : ''}<div class="small muted">${esc(u.precon) || ''}</div></td>
        <td class="small">${esc(u.email) || '<span class="dim">—</span>'}</td><td class="small muted">${new Date(u.createdAt).toLocaleDateString()}</td>
        <td class="admin-acts">${u.id === S.me.id || u.adminAccount ? '' : `
          ${isAdminAccount() && !u.test ? `<button class="btn sm ${u.staff ? '' : 'gold'}" data-ua="${u.staff ? 'unstaff' : 'staff'}" data-id="${u.id}" data-name="${esc(u.username)}">${u.staff ? 'Remove admin' : 'Make admin'}</button>` : ''}
          <button class="btn sm" data-ua="view" data-id="${u.id}" data-name="${esc(u.username)}">View as</button>
          <button class="btn sm" data-ua="rename" data-id="${u.id}" data-name="${esc(u.username)}">Rename</button>
          <button class="btn sm" data-ua="reset" data-id="${u.id}" data-name="${esc(u.username)}">Reset link</button>
          <button class="btn sm" data-ua="signout" data-id="${u.id}" data-name="${esc(u.username)}">Sign out</button>
          <button class="btn sm ${u.suspended ? 'gold' : ''}" data-ua="${u.suspended ? 'unsuspend' : 'suspend'}" data-id="${u.id}" data-name="${esc(u.username)}">${u.suspended ? 'Un-suspend' : 'Suspend'}</button>
          <button class="btn sm danger" data-ua="delete" data-id="${u.id}" data-name="${esc(u.username)}">${I.trash} Delete</button>`}</td></tr>`).join('')}</tbody></table>
    </section>

    <div class="league-grid admin-grid" style="margin-top:16px">
      <section class="panel">
        <h2>Admin log</h2>
        <div class="admin-log">${log.entries.map(e => `<div class="al-item ${e.undoneAt ? 'undone' : ''}"><span class="small dim">${fmtWhen(e.at)}</span>
          <div><div>${esc(e.summary)}</div>${e.reason ? `<div class="small muted">Reason: ${esc(e.reason)}</div>` : ''}${e.undoneAt ? `<div class="small dim">Undone ${fmtWhen(e.undoneAt)}</div>` : ''}</div>
          ${e.canUndo ? `<button class="btn sm" data-undo="${e.id}">Undo</button>` : '<span></span>'}</div>`).join('') || '<p class="muted">Nothing yet.</p>'}</div>
      </section>
      <section class="panel">
        <div class="spread"><h2 style="margin:0">Backups</h2><button class="btn sm gold" id="backupNow">Back up now</button></div>
        <p class="small muted">A full copy of the database is made every 24 hours (the newest 14 are kept) in <code>pre-con-commander/data/backups</code> on the server. Downloads hold every account's email and password hash: keep them private.</p>
        <div class="admin-backups">${backups.backups.map(b => `<div class="spread small"><span>${fmtWhen(b.at)} · ${b.auto ? 'automatic' : 'manual'} · ${kb(b.size)}</span><a class="btn sm" href="/api/admin/backups/${encodeURIComponent(b.name)}" download>Download</a></div>`).join('') || '<p class="muted">No backups yet. The first automatic one is made a minute after the site starts.</p>'}</div>
      </section>
    </div>`;

  // ---- give packs ----
  const gf = $('#grantForm', view);
  if (gf) {
    const syncMode = () => { $('#grantSetRow', gf).hidden = gf.mode.value !== 'set'; };
    gf.mode.onchange = syncMode; syncMode();
    $('#grantAll', gf).onclick = () => $$('input[name=u]', gf).forEach(i => { i.checked = true; });
    $('#grantNone', gf).onclick = () => $$('input[name=u]', gf).forEach(i => { i.checked = false; });
    gf.onsubmit = async e => {
      e.preventDefault();
      const userIds = $$('input[name=u]:checked', gf).map(i => i.value);
      if (!userIds.length) return toast('Pick at least one player.', 'err');
      try {
        const r = await post('/admin/grants', { league: league.id, userIds, count: Number(gf.count.value), mode: gf.mode.value, setCode: gf.setCode.value, reason: gf.reason.value });
        toast(`${I.pack} Gave ${plural(r.packIds.length, 'pack')}${r.set ? ` of ${esc(r.set.name)}` : ''}.`, 'good');
        renderAdmin(view);
      } catch (err) { fail(err); }
    };
  }
  $$('[data-take]', view).forEach(b => b.onclick = async () => {
    const [podId, packId] = b.dataset.take.split(':');
    const f = await formBox(`Take back ${esc(b.dataset.who)}'s pack?`, `The unopened pack is removed. ${UNDO_NOTE}`, [{ name: 'reason', label: 'Reason (optional)' }], `${I.trash} Take it back`, true);
    if (!f) return;
    try { await api(`/pods/${podId}/packs/${packId}`, { method: 'DELETE', body: { reason: f.reason } }); toast('Pack taken back.', 'good'); renderAdmin(view); } catch (err) { fail(err); }
  });
  // ---- announcement ----
  const dTest = $('#discordTest', view);
  if (dTest) dTest.onclick = async () => {
    dTest.disabled = true;
    try { const r = await api('/admin/discord/test', { method: 'POST' }); r.ok ? toast('Test post sent. Check the channel.', 'good') : toast(`Discord refused it: ${r.last.error}`, 'err'); } catch (err) { fail(err); }
    dTest.disabled = false;
  };
  $('#annForm', view).onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    try { await api('/admin/announcement', { method: 'PUT', body: { text: f.text.value, until: f.until.value ? `${f.until.value}T23:59:59` : null, discord: Boolean(f.discord?.checked) } }); toast(f.text.value.trim() ? 'Announcement is up.' : 'Announcement cleared.', 'good'); await loadState(); renderAdmin(view); } catch (err) { fail(err); }
  };
  $('#annClear', view)?.addEventListener('click', async () => {
    try { await api('/admin/announcement', { method: 'PUT', body: { text: '' } }); toast('Announcement cleared.', 'good'); await loadState(); renderAdmin(view); } catch (err) { fail(err); }
  });
  // ---- players ----
  $$('[data-ua]', view).forEach(b => b.onclick = async () => {
    const { id, name } = b.dataset;
    const who = esc(name);
    try {
      switch (b.dataset.ua) {
        case 'view':
          await post(`/admin/view-as/${id}`);
          location.hash = '#league'; location.reload();
          return;
        case 'rename': {
          const f = await formBox(`Rename ${who}`, 'Their new name shows everywhere, past pods and the feed included.', [{ name: 'username', label: 'New username', value: name, required: true, max: 20 }]);
          if (!f) return;
          await api(`/admin/users/${id}`, { method: 'PUT', body: { username: f.username } });
          toast(`${who} is now ${esc(f.username)}.`, 'good'); await loadState(); break;
        }
        case 'reset': {
          const r = await post(`/admin/users/${id}/reset-link`);
          const m = $('#modal');
          m.innerHTML = `<div class="box"><div class="dialog"><h2>Reset link for ${who}</h2>
            <p class="muted">Send this to ${who}. It works once, for ${r.minutes} minutes.</p>
            <pre class="list" style="white-space:pre-wrap;word-break:break-all">${esc(r.link)}</pre>
            <div class="row" style="justify-content:flex-end"><button class="btn gold" id="cpy">${I.copy} Copy link</button><button class="btn ghost" id="cls">Close</button></div></div></div>`;
          m.hidden = false;
          $('#cpy', m).onclick = async () => { await navigator.clipboard.writeText(r.link).catch(() => {}); toast(`${I.copy} Reset link copied`, 'good'); };
          $('#cls', m).onclick = () => { m.hidden = true; };
          return;
        }
        case 'signout':
          if (!await confirmBox(`Sign ${who} out everywhere?`, 'Every device they\'re signed in on has to log in again. Their account is untouched.', 'Sign out')) return;
          await post(`/admin/users/${id}/signout`); toast(`${who} was signed out everywhere.`, 'good'); break;
        case 'suspend': {
          const f = await formBox(`Suspend ${who}?`, `They're signed out and can't log in until you un-suspend them. Nothing is deleted; their pods and pool stay. ${UNDO_NOTE}`, [{ name: 'reason', label: 'Reason (shown to them when they try to log in)' }], 'Suspend', true);
          if (!f) return;
          await post(`/admin/users/${id}/suspend`, { suspended: true, reason: f.reason }); toast(`${who} is suspended.`, 'good'); break;
        }
        case 'staff':
          if (!await confirmBox(`Make ${who} an admin?`, `${who} keeps playing as normal and also gets the Admin tab: giving and taking packs, fixing pods, moving cards, player tools, test players, the log and backups. Only you (the main admin account) can make or remove admins.`, 'Make admin')) return;
          await post(`/admin/users/${id}/admin`, { admin: true }); toast(`${who} is now an admin.`, 'good'); break;
        case 'unstaff':
          if (!await confirmBox(`Remove ${who}'s admin powers?`, `${who} stays a player. They're signed out so the change takes effect right away.`, 'Remove admin', true)) return;
          await post(`/admin/users/${id}/admin`, { admin: false }); toast(`${who} is a regular player again.`, 'good'); break;
        case 'unsuspend':
          await post(`/admin/users/${id}/suspend`, { suspended: false }); toast(`${who} can log in again.`, 'good'); break;
        case 'delete': {
          if (!await typedConfirm(`Delete ${who}'s account?`, `Removes their login, email, deck list and suggestions <b>for good</b> (this one can't be undone; consider <b>Suspend</b> instead). Their past pods stay in league history as <b>Deleted player</b>.`, 'DELETE', `${I.trash} Delete account`)) return;
          await del(`/admin/users/${id}`); toast(`${who}'s account was deleted.`, 'good'); break;
        }
      }
      renderAdmin(view);
    } catch (err) { fail(err); }
  });
  // ---- log ----
  $$('[data-undo]', view).forEach(b => b.onclick = async () => {
    if (!await confirmBox('Undo this?', 'It goes back to how it was before the action.', 'Undo')) return;
    try { await post(`/admin/log/${b.dataset.undo}/undo`); toast('Undone.', 'good'); S.history = null; S.pools = null; S.leagueDetail = null; await loadState(); renderAdmin(view); } catch (err) { fail(err); }
  });
  // ---- backups ----
  $('#backupNow', view).onclick = async () => {
    try { await post('/admin/backups'); toast('Backup made.', 'good'); renderAdmin(view); } catch (err) { fail(err); }
  };
}

// Admin, History tab: fix a finished pod (name, winner, precons, who sat in a seat).
async function fixPodFlow(pod) {
  const seats = [...pod.players, ...(pod.absentees || [])];
  const others = (S.members || []).filter(m => !seats.some(s => s.id === m.id));
  const m = $('#modal');
  m.innerHTML = `<div class="box"><div class="dialog"><form id="fixForm" class="grid" style="gap:10px">
    <h2 style="margin:0">Fix ${esc(pod.name)}</h2>
    <p class="muted small" style="margin:0">Standings, player pages and the recap follow the change. Packs aren't recounted: use <b>Admin → Give packs</b> or take one back if the winner change should move a pack. ${UNDO_NOTE}</p>
    <label>Pod name<input name="name" value="${esc(pod.name)}" maxlength="40" required></label>
    <label>Winner<select class="input" name="winnerId">${pod.players.map(p => `<option value="${p.id}" ${p.id === pod.winnerId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    ${pod.players.map(p => `<label>${esc(p.name)}'s precon<input name="precon:${p.id}" value="${esc(p.precon || '')}" maxlength="80"></label>`).join('')}
    ${others.length ? `<fieldset class="grid" style="gap:8px;border:1px solid var(--line);padding:10px"><legend class="small muted">Wrong person recorded? Give a seat (with its packs and cards) to someone else</legend>
      <div class="rules-grid"><label>Seat<select class="input" name="swapFrom"><option value="">No change</option>${seats.map(s => `<option value="${s.id}">${esc(s.name)}${pod.absentees?.includes(s) ? ' (missed it)' : ''}</option>`).join('')}</select></label>
      <label>Give it to<select class="input" name="swapTo">${others.map(o => `<option value="${o.id}">${esc(o.username)}</option>`).join('')}</select></label></div></fieldset>` : ''}
    <label>Reason <span class="dim small">(shown in the feed)</span><input name="reason" maxlength="300"></label>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-r="0">Cancel</button><button class="btn gold">Save fix</button></div>
  </form></div></div>`;
  m.hidden = false;
  const close = () => { m.hidden = true; m.innerHTML = ''; };
  $('[data-r="0"]', m).onclick = close;
  $('#fixForm', m).onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const precons = Object.fromEntries(Object.entries(f).filter(([k]) => k.startsWith('precon:')).map(([k, v]) => [k.slice(7), v]));
    const body = { name: f.name, winnerId: f.winnerId, precons, reason: f.reason, ...(f.swapFrom ? { swap: { from: f.swapFrom, to: f.swapTo } } : {}) };
    try { await api(`/admin/pods/${pod.id}`, { method: 'PUT', body }); close(); toast(`${esc(f.name)} fixed.`, 'good'); S.history = null; S.leagueDetail = null; render(); } catch (err) { fail(err); }
  };
}

// Admin, card zoom: move a card to another player's pool (a trade).
async function moveCardFlow(c) {
  const f = await formBox(`Move ${esc(c.name)}`, `It leaves its current pool and joins the other player's, with a note in the feed. ${UNDO_NOTE}`, [
    { name: 'to', label: 'To', type: 'select', options: (S.members || []).map(m => ({ value: m.id, label: m.username })) },
    { name: 'reason', label: 'Reason (optional)', placeholder: 'e.g. traded for Sol Ring' },
  ], 'Move card');
  if (!f) return;
  try { await post(`/admin/pool-cards/${c.id}/move`, { toUserId: f.to, reason: f.reason }); toast(`${esc(c.name)} moved.`, 'good'); S.pools = null; S.history = null; render(); } catch (err) { fail(err); }
}

// Banners: the admin's announcement, and "viewing as" while the admin looks through a player's eyes.
function paintBanners() {
  const box = $('#banners');
  if (!box) return;
  const a = S.announcement;
  let hidden = null;
  try { hidden = localStorage.getItem('pcc:annHidden'); } catch { /* private mode */ }
  box.innerHTML = `${S.viewAs ? `<div class="banner viewas">${I.user}<span>Viewing the site as <b>${esc(S.me.username)}</b> (read-only). Nothing can be changed until you stop.</span><button class="btn sm gold" id="stopViewAs">Stop viewing</button></div>` : ''}
    ${a?.text && hidden !== a.id ? `<div class="banner ann">${I.flag}<span>${esc(a.text)}</span><button class="chip-x" id="annHide" title="Hide this message" aria-label="Hide this message">✕</button></div>` : ''}`;
  $('#stopViewAs', box)?.addEventListener('click', async () => { try { await post('/admin/view-as/stop'); location.hash = '#admin'; location.reload(); } catch (err) { fail(err); } });
  $('#annHide', box)?.addEventListener('click', () => { try { localStorage.setItem('pcc:annHidden', a.id); } catch { /* private mode */ } paintBanners(); });
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
      if (info.trade) {
        S.trades = null;
        const tw = info.trade;
        const who = esc(S.members.find(m => m.id === tw.from)?.username || 'Someone');
        const msg = tw.to === S.me.id && { offer: `${who} sent you a trade offer`, counter: `${who} countered your offer`, accepted: `${who} accepted your trade`, declined: `${who} declined your offer`, cancelled: `${who} cancelled their offer` }[tw.kind];
        if (msg) toast(`${I.trade} ${msg} · <a href="#trades?box=${tw.kind === 'offer' || tw.kind === 'counter' ? 'incoming' : 'history'}">see it</a>`, 'good');
        // Don't wipe a half-built offer.
        if (S.route === 'trades' && (S.params.new || S.params.counter)) return;
      }
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
      if ((info.vote === 'decided' || info.vote === 'ready') && Date.now() - (S.justVoted || 0) > 3000) wheelNudge(podById(info.podId));
      if (S.spinning || S.opening) return;
      // Player pages and recaps are snapshots; they refresh when reopened.
      if (S.route === 'player' || S.route === 'recap' || S.route === 'admin') return;
      // Don't yank the page out from under someone mid-reveal or typing.
      const typing = document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
      if (['sets', 'pods', 'account', 'pools', 'league', 'trades'].includes(S.route) && typing) return;
      if (S.route === 'packs' && $('.mcard.down')) return;
      if (S.route === 'history') S.history = null;
      render();
    } catch { /* next event will retry */ }
  };
  es.addEventListener('state', onState);
  es.addEventListener('spin', onState);
  es.addEventListener('watch', e => { try { const w = JSON.parse(e.data || '{}'); applyWatch(w.podId, w); } catch { /* ignore */ } });
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
// Keyboard access. Cards and clickable rows aren't buttons, so make them
// focusable and let Enter/Space click them. Escape closes the dialog (as
// Cancel, when it asks a question).
const KEYABLE = '.mcard, [data-card], tr.pickable, tr[data-c], [data-dc], [data-pull]';
new MutationObserver(() => $$(`:is(${KEYABLE}):not([tabindex])`).forEach(el => { el.tabIndex = 0; el.setAttribute('role', 'button'); }))
  .observe(document.body, { childList: true, subtree: true });
document.addEventListener('keydown', e => {
  const m = $('#modal');
  if (e.key === 'Escape' && !m.hidden) { const cancel = $('[data-r="0"]', m); if (cancel) cancel.click(); else m.hidden = true; return; }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.(KEYABLE)) { e.preventDefault(); e.target.click(); }
});

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
