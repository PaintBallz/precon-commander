// Pre-Con Commander — client. Plain ES modules, no build step.
import { cardLine, listText } from './decklist.js';
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('pcc:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pcc:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const S = {
  game: null, lastPlayers: [], sets: [], setsByCode: new Map(), wheel: [], settings: null, types: [],
  history: null, route: 'game', params: {},
  me: store.get('me', ''), sound: store.get('sound', true),
  wheelPlayer: null, packsPlayer: null, revealPackId: null,
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
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}
const post = (path, body = {}) => api(path, { method: 'POST', body });

async function loadState() {
  const st = await api('/state');
  S.game = st.game;
  S.lastPlayers = st.lastPlayers;
  fillMe();
}
async function loadSets() {
  const d = await api('/sets');
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
const players = () => S.game?.players || [];
const playerById = id => players().find(p => p.id === id);
const allPacks = () => players().flatMap(p => p.packs.map(k => ({ ...k, player: p })));
const findPack = id => allPacks().find(k => k.id === id);
const icon = (set, cls = '') => set?.icon ? `<img class="set-icon ${cls}" src="${esc(set.icon)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '';
const pct = n => n >= 0.1 ? (n * 100).toFixed(1) + '%' : n > 0 ? (n * 100).toFixed(2) + '%' : '—';
const typeLabel = t => ({ expansion: 'Expansion', core: 'Core', masters: 'Masters', draft_innovation: 'Draft Innovation' }[t] || t);
const fmtDate = iso => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, mythic: 3, special: 3, bonus: 3 };

function defaultPlayer() {
  const ps = players();
  const me = ps.find(p => p.name === S.me);
  return me || ps.find(p => p.remaining > 0) || ps[0] || null;
}

function fillMe() {
  const sel = $('#meSelect');
  const names = players().map(p => p.name);
  if (S.me && !names.includes(S.me)) names.push(S.me);
  sel.innerHTML = `<option value="">—</option>` + names.map(n => `<option ${n === S.me ? 'selected' : ''}>${esc(n)}</option>`).join('');
}
$('#meSelect').addEventListener('change', e => { S.me = e.target.value; store.set('me', S.me); S.wheelPlayer = S.packsPlayer = null; render(); });
const soundBtn = $('#soundBtn');
const paintSound = () => { soundBtn.textContent = S.sound ? '🔊' : '🔇'; };
paintSound();
soundBtn.addEventListener('click', () => { S.sound = !S.sound; store.set('sound', S.sound); paintSound(); });

// ---- deck-list text ("1 Card Name (SET) 123" — Moxfield / Archidekt) ----
async function copyText(text, what = 'List') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast(`📋 ${esc(what)} copied — paste it into your deck list`, 'good');
}

// ---------------- routing ----------------
function parseRoute() {
  const [r, q] = location.hash.replace(/^#/, '').split('?');
  S.route = ['game', 'wheel', 'packs', 'sets', 'history'].includes(r) ? r : 'game';
  S.params = Object.fromEntries(new URLSearchParams(q || ''));
}
const go = hash => { if (location.hash === hash) { parseRoute(); render(); } else location.hash = hash; };
window.addEventListener('hashchange', () => { parseRoute(); render(); window.scrollTo(0, 0); });

function render() {
  $$('#tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === S.route));
  const view = $('#view');
  if (S.route !== 'wheel') stopWheelLoop();
  ({ game: renderGame, wheel: renderWheel, packs: renderPacks, sets: renderSets, history: renderHistory })[S.route](view);
}

// =============== GAME TAB ===============
function renderGame(view) {
  const g = S.game;
  if (!g) {
    const seed = S.lastPlayers.length ? S.lastPlayers : [{}, {}, {}, {}];
    view.innerHTML = `
      <div class="hero"><div>
        <h1>New Game Night</h1>
        <p>Everyone starts with one precon. When the game ends, the winner gets <b>3 packs</b> and everyone else gets <b>2</b>, each spun from the wheel.</p>
      </div></div>
      <form class="panel player-form" id="newGame">
        <div class="pf-rows"></div>
        <div class="spread" style="margin-top:6px">
          <button type="button" class="btn ghost sm" id="addP">+ Add player</button>
          <button class="btn gold big">Start game</button>
        </div>
      </form>`;
    const rows = $('.pf-rows', view);
    const addRow = (p = {}) => {
      const n = rows.children.length + 1;
      const d = document.createElement('div');
      d.className = 'pf-row';
      d.innerHTML = `<span class="num">${n}</span>
        <input type="text" name="name" placeholder="Player ${n}" value="${esc(p.name || '')}" maxlength="40" required>
        <input type="text" class="precon" name="precon" placeholder="Precon / commander (optional)" value="${esc(p.precon || '')}" maxlength="80">
        <button type="button" class="btn ghost sm rm" title="Remove">✕</button>`;
      $('.rm', d).onclick = () => { if (rows.children.length > 2) { d.remove(); $$('.num', rows).forEach((e, i) => e.textContent = i + 1); } };
      rows.append(d);
    };
    seed.forEach(addRow);
    $('#addP', view).onclick = () => rows.children.length < 8 && addRow();
    $('#newGame', view).onsubmit = async e => {
      e.preventDefault();
      const ps = $$('.pf-row', rows).map(r => ({ name: $('[name=name]', r).value, precon: $('[name=precon]', r).value }));
      try { await post('/game', { players: ps }); await loadState(); render(); toast('Game on — good luck! 🎲', 'good'); } catch (err) { fail(err); }
    };
    return;
  }

  const awarded = g.status === 'awarded';
  const totalLeft = g.players.reduce((s, p) => s + p.remaining + p.packs.filter(k => k.status !== 'opened').length, 0);
  view.innerHTML = `
    <div class="hero">
      <div>
        <h1>${awarded ? 'Claim Your Packs' : 'Game in Progress'}</h1>
        <p>${awarded
          ? `Winner gets 3 packs, everyone else gets 2. Spin the wheel for each one, or <b>Sacrifice a Pack</b> to pick any set you want.`
          : `Started ${fmtDate(g.createdAt)}. When the game ends, crown the winner to hand out packs.`}</p>
      </div>
      <div class="row">
        ${awarded ? `<a class="btn gold" href="#wheel">Spin the wheel →</a>` : ''}
        ${awarded ? `<button class="btn" id="finish">Finish game night</button>` : ''}
        <button class="btn danger sm" id="discard">Discard game</button>
      </div>
    </div>
    <div class="players">${g.players.map(p => playerCard(p, g)).join('')}</div>`;

  $$('[data-win]', view).forEach(b => b.onclick = async () => {
    const p = playerById(b.dataset.win);
    if (!await confirmBox(`Crown <b>${esc(p.name)}</b> the winner?`, `${esc(p.name)} gets 3 packs, everyone else gets 2.`, 'Crown winner 👑')) return;
    try { await post('/game/winner', { playerId: p.id }); await loadState(); render(); } catch (err) { fail(err); }
  });
  $$('[data-award]', view).forEach(b => b.onclick = async () => {
    try { await post('/game/award', { playerId: b.dataset.award, delta: Number(b.dataset.delta) }); await loadState(); render(); } catch (err) { fail(err); }
  });
  $('#finish', view)?.addEventListener('click', async () => {
    const msg = totalLeft ? `There are still <b>${totalLeft}</b> unopened/unspun packs. They'll be saved in history as-is.` : 'All packs are opened. This saves the game to History.';
    if (!await confirmBox('Finish this game night?', msg, 'Finish & save')) return;
    try { await post('/game/finish'); S.history = null; await loadState(); go('#history'); } catch (err) { fail(err); }
  });
  $('#discard', view).onclick = async () => {
    if (!await confirmBox('Discard this game?', 'It will not be saved to History. Packs already opened are lost.', 'Discard', true)) return;
    try { await post('/game/discard'); await loadState(); render(); } catch (err) { fail(err); }
  };
}

function playerCard(p, g) {
  const won = g.winnerId === p.id;
  const pips = [
    ...p.packs.map(k => `<span class="pip ${k.status === 'opened' ? 'opened' : 'ready'}" title="${esc(k.set?.name || 'Choosing a set…')}">${k.set ? `<img src="${esc(k.set.icon || '')}" alt="">` : '?'}</span>`),
    ...Array.from({ length: p.sacrificed }, () => `<span class="pip sac" title="Sacrificed"></span>`),
    ...Array.from({ length: Math.max(0, p.remaining) }, () => `<span class="pip unspun" title="Not spun yet"></span>`),
  ].join('');
  const opened = p.packs.filter(k => k.status === 'opened').length;
  return `<div class="pcard ${won ? 'winner' : ''}">
    ${won ? '<span class="crown">👑</span>' : ''}
    <div>
      <div class="pname">${esc(p.name)}</div>
      ${p.precon ? `<div class="precon">${esc(p.precon)}</div>` : ''}
    </div>
    ${g.status === 'playing'
      ? `<button class="btn gold" data-win="${p.id}">👑 Won the game</button>`
      : `<div class="pips">${pips || '<span class="dim small">No packs</span>'}</div>
         <div class="stat-line"><span><b>${p.awarded}</b> awarded</span><span><b>${p.remaining}</b> to spin</span><span><b>${opened}</b> opened</span>${p.sacrificed ? `<span><b>${p.sacrificed}</b> sacrificed</span>` : ''}</div>
         <div class="row">
           <a class="btn sm ${p.remaining ? 'gold' : ''}" href="#wheel?player=${p.id}">${p.remaining ? 'Spin' : 'Wheel'}</a>
           <a class="btn sm" href="#packs?player=${p.id}">Packs</a>
           <span style="flex:1"></span>
           <button class="btn ghost sm" data-award="${p.id}" data-delta="-1" title="Remove a pack">−</button>
           <button class="btn ghost sm" data-award="${p.id}" data-delta="1" title="Add a pack">+</button>
         </div>`}
  </div>`;
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

// =============== WHEEL TAB ===============
const PALETTE = ['#e9dfc4', '#3d7fc6', '#5e4e62', '#c8503a', '#3e9a5b', '#d9a84e', '#2f6aa8', '#7a6380', '#b2432f', '#33804c'];
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
  ctx.beginPath(); ctx.arc(0, 0, R - 2, 0, Math.PI * 2);
  const ring = ctx.createLinearGradient(-R, -R, R, R);
  ring.addColorStop(0, '#f1cf7d'); ring.addColorStop(1, '#8e6424');
  ctx.fillStyle = ring; ctx.fill();
  const r = R - 12;
  ctx.rotate(S.rot);
  if (!wheelGeom.length) {
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fillStyle = '#1d2230'; ctx.fill();
  }
  for (const seg of wheelGeom) {
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r, seg.a0, seg.a1); ctx.closePath();
    ctx.fillStyle = seg.color; ctx.fill();
    if (wheelGeom.length < 400) { ctx.strokeStyle = 'rgba(13,15,20,.55)'; ctx.lineWidth = wheelGeom.length > 120 ? 0.5 : 1.2; ctx.stroke(); }
    const span = seg.a1 - seg.a0;
    const fontPx = Math.min(16, Math.max(8, span * r * 0.55));
    if (span * r > 9) {
      ctx.save();
      ctx.rotate((seg.a0 + seg.a1) / 2);
      ctx.fillStyle = ['#e9dfc4', '#d9a84e'].includes(seg.color) ? '#1a1408' : '#f5f1e6';
      ctx.font = `700 ${fontPx}px Inter, sans-serif`;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      const label = span * r > 70 ? (S.setsByCode.get(seg.code)?.name || seg.code.toUpperCase()) : seg.code.toUpperCase();
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
  sh.addColorStop(0, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,.28)');
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
  if (!seg) { t.innerHTML = '<span class="muted">Wheel is empty — loosen the filters</span>'; return; }
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

function renderWheel(view) {
  const g = S.game;
  if (!g) { view.innerHTML = `<div class="empty"><h2>No game yet</h2><p>Start a game first, then spin for packs after someone wins.</p><a class="btn gold" href="#game">Start a game</a></div>`; return; }
  if (S.params.player) { S.wheelPlayer = S.params.player; }
  const p = playerById(S.wheelPlayer) || defaultPlayer();
  S.wheelPlayer = p?.id;
  buildGeom();
  const st = S.settings;
  view.innerHTML = `
    <div class="wheel-layout">
      <div class="wheel-wrap">
        <div class="ticker" id="ticker"></div>
        <div class="wheel-stage">
          <div class="pointer"></div>
          <canvas id="wheelCanvas"></canvas>
          <button class="hub-btn" id="spinBtn">SPIN</button>
        </div>
        <p class="muted small" style="margin-top:12px">${S.wheel.length} sets on the wheel · <a href="#sets">tune odds per set</a></p>
      </div>
      <div class="side">
        <div class="panel">
          <h3>Spinning for</h3>
          <div class="who">${g.players.map(x => `<button data-p="${x.id}" class="${x.id === p?.id ? 'sel' : ''}"><span class="n">${g.winnerId === x.id ? '👑 ' : ''}${esc(x.name)}</span><span class="r">${x.remaining} pack${x.remaining === 1 ? '' : 's'} to spin</span></button>`).join('')}</div>
        </div>
        <div id="revealBox"></div>
        <details class="panel settings-box" ${store.get('wheelSettingsOpen', false) ? 'open' : ''}>
          <summary><span>⚙️ Wheel settings</span><span class="dim small">${S.wheel.length} of ${S.sets.length} sets</span></summary>
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
        </details>
      </div>
    </div>`;

  requestAnimationFrame(drawWheel);
  $$('.who button', view).forEach(b => b.onclick = () => { S.wheelPlayer = b.dataset.p; history.replaceState(null, '', '#wheel'); S.params = {}; renderWheel(view); });
  const spinBtn = $('#spinBtn', view);
  const canSpin = g.status === 'awarded' && p && p.remaining > 0 && !S.spinning && S.wheel.length;
  spinBtn.disabled = !canSpin;
  spinBtn.title = g.status !== 'awarded' ? 'Crown a winner first' : !p?.remaining ? `${p?.name || 'This player'} has no packs left to spin` : 'Spin!';
  spinBtn.onclick = async () => {
    spinBtn.disabled = true;
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const { spin } = await post('/game/spin', { playerId: p.id });
      S.seenSpins.add(spin.id);
      await loadState();
      await runSpin(spin);
    } catch (err) { fail(err); renderWheel(view); }
  };
  const det = $('.settings-box', view);
  det.addEventListener('toggle', () => store.set('wheelSettingsOpen', det.open));
  const saveFilters = async extra => {
    const body = {
      minYear: Number($('#minYear', view).value), maxYear: Number($('#maxYear', view).value),
      types: $$('.types input:checked', view).map(i => i.value), ...extra,
    };
    try { await api('/settings', { method: 'PUT', body }); await loadSets(); renderWheel(view); } catch (err) { fail(err); }
  };
  $('#minYear', view).onchange = () => saveFilters();
  $('#maxYear', view).onchange = () => saveFilters();
  $$('.types input', view).forEach(i => i.onchange = () => saveFilters());
  $$('[data-era]', view).forEach(b => b.onclick = () => { $('#minYear', view).value = b.dataset.era; $('#maxYear', view).value = new Date().getFullYear(); saveFilters(); });
  $('#resetWheel', view).onclick = async () => {
    if (await confirmBox('Reset the wheel?', 'Clears year/type filters, excluded sets and every custom per-set odd.', 'Reset', true)) saveFilters({ reset: true });
  };
  renderReveal();
}

async function runSpin(spin) {
  if (S.route !== 'wheel') return;
  const box = $('#revealBox');
  if (box) box.innerHTML = `<div class="reveal"><div class="inner"><span class="label">Spinning for ${esc(playerById(spin.playerId)?.name)}</span><div class="setname">…</div></div></div>`;
  const sb = $('#spinBtn'); if (sb) sb.disabled = true;
  await animateSpin(spin);
  S.revealPackId = spin.packId;
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

function renderReveal() {
  const box = $('#revealBox');
  if (!box) return;
  const g = S.game;
  const lastSpin = g.spins.at(-1);
  const pack = findPack(S.revealPackId) || (lastSpin && findPack(lastSpin.packId));
  if (!pack) {
    box.innerHTML = `<div class="reveal"><div class="inner"><span class="label">The wheel awaits</span><div class="setname">${g.status === 'awarded' ? 'Spin to reveal a set' : 'Crown a winner first'}</div><p class="muted">${g.status === 'awarded' ? 'Each spin is one booster. The set it lands on shows up here.' : 'Packs are handed out on the Game tab once the game ends.'}</p></div></div>`;
    return;
  }
  const owner = pack.player;
  const wheelSet = pack.wheelSet || pack.set;
  const meta = S.setsByCode.get(wheelSet.code);
  const year = (wheelSet.released || '').slice(0, 4);
  const kind = meta?.realPack ? `${{ play: 'Play', draft: 'Draft', set: 'Set' }[meta.packKind]} Booster` : 'Booster';
  let actions = '';
  if (pack.status === 'ready' && pack.source === 'wheel') {
    actions = `
      <a class="btn gold big" href="#packs?player=${owner.id}&pack=${pack.id}">Open ${esc(wheelSet.name)} ${kind} →</a>
      <button class="btn danger" id="sacBtn" ${owner.remaining < 1 ? 'disabled' : ''}>🔥 Sacrifice a Pack</button>
      <div class="sac-note">${owner.remaining < 1
        ? `${esc(owner.name)} has no other unspun pack to sacrifice.`
        : `Gives up this spin <i>and</i> 1 of ${esc(owner.name)}'s ${owner.remaining} remaining pack${owner.remaining === 1 ? '' : 's'}, then lets you pick any set.`}</div>`;
  } else if (pack.status === 'choosing') {
    actions = `<a class="btn gold" href="#sets?choose=${pack.id}">Choose the replacement set →</a><div class="sac-note">A pack was sacrificed. Pick any set.</div>`;
  } else if (pack.source === 'sacrifice') {
    actions = `<div class="sac-note">🔥 Sacrificed and swapped for <b>${esc(pack.set.name)}</b>.</div><a class="btn" href="#packs?player=${owner.id}&pack=${pack.id}">${pack.status === 'opened' ? 'View pulls' : 'Open it'} →</a>`;
  } else {
    actions = `<a class="btn" href="#packs?player=${owner.id}&pack=${pack.id}">View pulls →</a>`;
  }
  box.innerHTML = `
    <div class="reveal">
      <div class="art" id="revArt"></div>
      <div class="inner">
        <span class="label">${esc(owner.name)} spun</span>
        ${icon(wheelSet, 'xl')}
        <div class="setname">${esc(wheelSet.name)}</div>
        <div class="row"><span class="chip gold">${year}</span><span class="chip">${typeLabel(wheelSet.type)}</span><span class="chip">${kind}</span></div>
        <div class="actions">${actions}</div>
      </div>
    </div>`;
  setArt(wheelSet.code).then(url => { const a = $('#revArt'); if (url && a) a.style.backgroundImage = `url("${url}")`; });
  $('#sacBtn')?.addEventListener('click', async () => {
    const ok = await confirmBox('Sacrifice a Pack?', `${esc(owner.name)} gives up this <b>${esc(wheelSet.name)}</b> spin and 1 more pack (${owner.remaining} → ${owner.remaining - 1} left to spin), and picks any set instead.`, '🔥 Sacrifice', true);
    if (!ok) return;
    try { await post(`/game/pack/${pack.id}/sacrifice`); await loadState(); go(`#sets?choose=${pack.id}`); } catch (err) { fail(err); }
  });
}

// =============== PACKS TAB ===============
function renderPacks(view) {
  const g = S.game;
  if (!g) { view.innerHTML = `<div class="empty"><h2>No game in progress</h2><p>Past pulls live in <a href="#history">History</a>.</p></div>`; return; }
  if (S.params.player) S.packsPlayer = S.params.player;
  const p = playerById(S.packsPlayer) || defaultPlayer();
  S.packsPlayer = p.id;
  const sel = (S.params.pack && p.packs.find(k => k.id === S.params.pack)) || p.packs.find(k => k.status !== 'opened') || p.packs.at(-1);
  const pulls = p.packs.filter(k => k.status === 'opened').flatMap(k => k.cards);
  view.innerHTML = `
    <div class="player-tabs">${g.players.map(x => `<button data-p="${x.id}" class="${x.id === p.id ? 'sel' : ''}">${g.winnerId === x.id ? '👑 ' : ''}${esc(x.name)}</button>`).join('')}</div>
    <div class="packs-layout">
      <aside class="grid" style="gap:12px">
        <div class="pack-list">
          ${p.packs.map(k => `<button class="pack-item ${k.id === sel?.id ? 'sel' : ''}" data-k="${k.id}">
              ${k.set ? icon(k.set) : '<span class="set-icon">❔</span>'}
              <span><div class="t">${esc(k.set?.name || 'Pick a set…')}</div>
              <div class="s">${k.status === 'opened' ? `Opened · ${k.cards.length} cards` : k.status === 'choosing' ? '🔥 Sacrificed: choose a set' : 'Unopened'}${k.source === 'sacrifice' && k.status !== 'choosing' ? ' · 🔥 chosen' : ''}</div></span>
            </button>`).join('') || `<div class="panel muted small">No packs yet.</div>`}
          ${p.remaining > 0 ? `<a class="pack-item" href="#wheel?player=${p.id}" style="text-decoration:none;color:inherit;border-style:dashed"><span class="set-icon">🎡</span><span><div class="t">${p.remaining} pack${p.remaining === 1 ? '' : 's'} left to spin</div><div class="s">Go to the wheel</div></span></a>` : ''}
        </div>
        ${pulls.length ? `<div class="panel">
          <h3>All of ${esc(p.name)}'s pulls</h3>
          <p class="small muted" style="margin:0 0 10px">${pulls.length} cards from ${p.packs.filter(k => k.status === 'opened').length} pack(s), merged into one list.</p>
          <button class="btn gold" id="copyAll" style="width:100%">📋 Copy all pulls</button>
        </div>` : ''}
      </aside>
      <section id="packView"></section>
    </div>`;
  $$('.player-tabs button', view).forEach(b => b.onclick = () => go(`#packs?player=${b.dataset.p}`));
  $$('[data-k]', view).forEach(b => b.onclick = () => go(`#packs?player=${p.id}&pack=${b.dataset.k}`));
  $('#copyAll', view)?.addEventListener('click', () => copyText(listText(pulls), `${p.name}'s ${pulls.length} pulls`));
  renderPackView($('#packView', view), sel, p);
}

function sortForReveal(cards) {
  return cards.map((c, i) => ({ c, i })).sort((a, b) => {
    const ra = (RARITY_ORDER[a.c.rarity] ?? 0) + (a.c.foil ? 0.5 : 0), rb = (RARITY_ORDER[b.c.rarity] ?? 0) + (b.c.foil ? 0.5 : 0);
    return ra - rb || a.i - b.i;
  }).map(x => x.c);
}

function cardHtml(c, i, down) {
  return `<div class="mcard r-${esc(c.rarity)} ${c.foil ? 'foil' : ''} ${down ? 'down' : ''}" data-i="${i}">
    <div class="flip">
      <div class="face"><img src="${esc(c.image)}" alt="${esc(c.name)}" loading="lazy"></div>
      <div class="backface"></div>
    </div>
    <span class="rar">${esc(c.rarity)}${c.foil ? ' · foil' : ''}</span>
  </div>`;
}

function renderPackView(el, pack, owner) {
  if (!pack) { el.innerHTML = `<div class="empty"><h2>No packs yet</h2><p>${owner.remaining ? `<a href="#wheel?player=${owner.id}">Spin the wheel</a> for ${esc(owner.name)}'s first pack.` : 'Crown a winner on the Game tab to hand out packs.'}</p></div>`; return; }
  if (pack.status === 'choosing') {
    el.innerHTML = `<div class="panel empty"><h2>🔥 Pack sacrificed</h2><p>Choose any set for ${esc(owner.name)}'s replacement pack.</p><a class="btn gold" href="#sets?choose=${pack.id}">Choose a set →</a></div>`;
    return;
  }
  const meta = S.setsByCode.get(pack.set.code);
  if (pack.status === 'ready') {
    const kind = meta?.realPack ? `${{ play: 'Play', draft: 'Draft', set: 'Set' }[meta.packKind]} Booster` : 'Booster';
    el.innerHTML = `
      <div class="booster" id="booster">
        ${icon(pack.set, 'lg')}
        <div class="bname">${esc(pack.set.name)}</div>
        <div class="btype">${kind}</div>
      </div>
      <div style="text-align:center"><button class="btn gold big" id="openBtn">Open ${esc(owner.name)}'s pack</button>
      ${meta && !meta.realPack ? `<p class="small dim" style="margin-top:10px">Generated from this set's booster cards: commons, uncommons, a rare (sometimes mythic), and the odd foil.</p>` : ''}</div>`;
    $('#openBtn', el).onclick = async () => {
      const btn = $('#openBtn', el), bo = $('#booster', el);
      btn.disabled = true; btn.textContent = 'Opening…';
      S.opening = true;
      bo.classList.add('shake');
      try {
        const res = await post(`/game/pack/${pack.id}/open`);
        S.animatePacks.add(pack.id);
        bo.classList.remove('shake'); bo.classList.add('rip');
        await new Promise(r => setTimeout(r, 450));
        S.game = res.game;
        S.opening = false;
        renderPacks($('#view'));
      } catch (err) { S.opening = false; fail(err); btn.disabled = false; btn.textContent = 'Try again'; bo.classList.remove('shake'); }
    };
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
      <div class="small muted">${esc(owner.name)} · ${esc(pack.boosterType || 'Booster')} · ${cards.length} cards${pack.source === 'sacrifice' ? ' · 🔥 chosen with a sacrifice' : ''}</div></div></div>
      <div class="row">
        ${animate ? `<button class="btn sm" id="revealAll">Reveal all</button>` : ''}
        <button class="btn gold" id="copyPack">📋 Copy pack list</button>
      </div>
    </div>
    ${hits.length ? `<div class="row" style="margin-bottom:12px">${hits.map(c => `<span class="chip ${c.rarity === 'mythic' ? 'gold' : ''}">${c.rarity === 'mythic' ? '★' : '◆'} ${esc(c.name)}${c.foil ? ' (foil)' : ''}</span>`).join('')}</div>` : ''}
    <div class="cards" id="cards">${cards.map((c, i) => cardHtml(c, i, animate)).join('')}</div>
    <details style="margin-top:16px"><summary class="muted small" style="cursor:pointer">Show list text</summary><pre class="list">${esc(listText(cards))}</pre></details>`;
  $('#copyPack', el).onclick = () => copyText(listText(cards), `${pack.set.name} pack`);
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
        <button class="btn sm" id="copyOne">📋 Copy</button>
        <button class="btn sm ghost" id="closeM">Close</button>
      </div></div>`;
    $('#flipBtn', m)?.addEventListener('click', e => { e.stopPropagation(); showBack = !showBack; paint(); });
    $('#copyOne', m).onclick = e => { e.stopPropagation(); copyText(`1 ${cardLine(c)}`, c.name); };
    $('#closeM', m).onclick = () => { m.hidden = true; };
  };
  paint();
  m.hidden = false;
  m.onclick = e => { if (e.target === m || e.target.classList.contains('box')) m.hidden = true; };
}

// =============== SETS TAB ===============
let setsFilter = { q: '', type: '', sort: 'new', only: '' };
let saveTimer = null, lastSetsMode = null;
function renderSets(view) {
  const choosing = S.params.choose ? findPack(S.params.choose) : null;
  const chooseMode = choosing && choosing.status === 'choosing';
  const mode = chooseMode ? 'choose:' + choosing.id : 'browse';
  if (mode !== lastSetsMode) { setsFilter = { q: '', type: '', sort: setsFilter.sort === 'chance' && chooseMode ? 'new' : setsFilter.sort, only: '' }; lastSetsMode = mode; }
  view.innerHTML = `
    ${chooseMode ? `<div class="choose-banner"><div>🔥 <b>${esc(choosing.player.name)}</b> sacrificed a pack. Tap any set for the replacement booster.</div><a class="btn sm ghost" href="#wheel">Back to wheel</a></div>` : `
      <div class="hero"><div><h1>All Sets</h1><p>Every Magic set that came in boosters. Toggle sets on or off the wheel and change each set's odds: a weight of 2 makes it twice as likely as a weight-1 set.</p></div>
      <div class="row"><span class="chip ok">${S.wheel.length} on the wheel</span></div></div>`}
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
        <td><label class="switch" title="${s.onWheel ? 'On the wheel' : excluded ? 'Excluded' : 'Filtered out by year/type'}"><input type="checkbox" data-tog="${s.code}" ${!excluded ? 'checked' : ''}><span></span></label></td>
        <td><input type="number" min="0" max="100" step="0.5" value="${s.weight}" data-w="${s.code}" ${excluded ? 'disabled' : ''}></td>
        <td class="chance"><div class="small">${pct(s.chance)}</div><div class="bar"><i style="width:${(s.chance / maxChance) * 100}%"></i></div></td>`}
      </tr>`;
    }).join('') || `<tr><td colspan="6" class="empty">No sets match.</td></tr>`;

    if (chooseMode) {
      $$('tr.pickable', view).forEach(tr => tr.onclick = async () => {
        const s = S.setsByCode.get(tr.dataset.code);
        if (!await confirmBox(`Choose ${esc(s.name)}?`, `${esc(choosing.player.name)}'s sacrificed pack becomes a <b>${esc(s.name)}</b> booster.`, 'Choose set')) return;
        try {
          await post(`/game/pack/${choosing.id}/choose`, { setCode: s.code });
          await loadState();
          go(`#packs?player=${choosing.player.id}&pack=${choosing.id}`);
        } catch (err) { fail(err); }
      });
    } else {
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
  if (S.params.choose && !chooseMode) toast('That pack already has a set.', 'err');
}
function queueSave(after) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api('/settings', { method: 'PUT', body: { excluded: S.settings.excluded, weights: S.settings.weights } });
      await loadSets();
      after();
    } catch (err) { fail(err); }
  }, 350);
}

// =============== HISTORY TAB ===============
async function renderHistory(view) {
  if (!S.history) {
    view.innerHTML = '<div class="spinner"></div>';
    try { S.history = (await api('/history')).games; } catch (err) { fail(err); return; }
    if (S.route !== 'history') return;
  }
  const games = S.history;
  if (!games.length) { view.innerHTML = `<div class="empty"><h2>No finished games yet</h2><p>Finish a game night on the Game tab and it shows up here, with every pack and pull.</p></div>`; return; }
  const stats = new Map();
  for (const g of games) for (const p of g.players) {
    const s = stats.get(p.name) || { name: p.name, games: 0, wins: 0, packs: 0, sac: 0, mythics: 0, rares: 0 };
    s.games++; if (g.winnerId === p.id) s.wins++;
    s.sac += p.sacrificed;
    for (const k of p.packs) if (k.status === 'opened') {
      s.packs++;
      for (const c of k.cards) { if (c.rarity === 'mythic') s.mythics++; if (c.rarity === 'rare') s.rares++; }
    }
    stats.set(p.name, s);
  }
  const table = [...stats.values()].sort((a, b) => b.wins - a.wins || b.wins / b.games - a.wins / a.games);
  view.innerHTML = `
    <div class="hero"><div><h1>History</h1><p>${games.length} game night${games.length === 1 ? '' : 's'} logged.</p></div></div>
    <div class="panel" style="margin-bottom:22px;overflow-x:auto">
      <h2>Standings</h2>
      <table class="standings"><thead><tr><th>Player</th><th class="num">Games</th><th class="num">Wins</th><th class="num">Win %</th><th class="num">Packs</th><th class="num">Sacrificed</th><th class="num">Rares</th><th class="num">Mythics</th></tr></thead>
      <tbody>${table.map((s, i) => `<tr><td>${i === 0 && s.wins ? '👑 ' : ''}<b>${esc(s.name)}</b></td><td class="num">${s.games}</td><td class="num">${s.wins}</td><td class="num">${Math.round(s.wins / s.games * 100)}%</td><td class="num">${s.packs}</td><td class="num">${s.sac}</td><td class="num">${s.rares}</td><td class="num">${s.mythics}</td></tr>`).join('')}</tbody></table>
    </div>
    <div class="grid" style="gap:12px">${games.map(g => {
      const w = g.players.find(p => p.id === g.winnerId);
      return `<details class="hgame"><summary>
        <div><b style="font-family:Cinzel">${fmtDate(g.finishedAt || g.createdAt)}</b> <span class="muted">· 👑 ${esc(w?.name || '—')}${w?.precon ? ` with ${esc(w.precon)}` : ''}</span></div>
        <div class="row">${g.players.flatMap(p => p.packs).filter(k => k.set).slice(0, 12).map(k => icon(k.set)).join('')}</div>
      </summary><div class="body">${g.players.map(p => {
        const pulls = p.packs.filter(k => k.status === 'opened').flatMap(k => k.cards);
        const hits = sortForReveal(pulls).reverse().filter(c => c.rarity === 'mythic' || c.rarity === 'rare');
        return `<div class="hplayer">
          <div class="spread"><div><b>${g.winnerId === p.id ? '👑 ' : ''}${esc(p.name)}</b> ${p.precon ? `<span class="muted small">· ${esc(p.precon)}</span>` : ''}</div>
          ${pulls.length ? `<button class="btn sm" data-copy="${g.id}:${p.id}">📋 Copy ${pulls.length} pulls</button>` : ''}</div>
          <div class="row small muted" style="margin-top:6px">${p.packs.map(k => `<span class="chip">${k.set ? icon(k.set) : ''}${esc(k.set?.name || 'unchosen')}${k.source === 'sacrifice' ? ' 🔥' : ''}${k.status !== 'opened' ? ' (unopened)' : ''}</span>`).join('') || 'No packs'}${p.sacrificed ? `<span class="chip">🔥 ${p.sacrificed} sacrificed</span>` : ''}</div>
          ${hits.length ? `<div class="mini-cards">${hits.map(c => `<img src="${esc(c.image)}" alt="${esc(c.name)}" title="${esc(c.name)}" loading="lazy" data-card="${g.id}:${p.id}:${esc(c.set)}/${esc(c.number)}">`).join('')}</div>` : ''}
        </div>`;
      }).join('')}</div></details>`;
    }).join('')}</div>`;
  const lookup = key => { const [gid, pid] = key.split(':'); const g = games.find(x => x.id === gid); return g?.players.find(p => p.id === pid); };
  $$('[data-copy]', view).forEach(b => b.onclick = () => {
    const p = lookup(b.dataset.copy);
    const pulls = p.packs.filter(k => k.status === 'opened').flatMap(k => k.cards);
    copyText(listText(pulls), `${p.name}'s pulls`);
  });
  $$('[data-card]', view).forEach(img => img.onclick = () => {
    const [gid, pid, sn] = img.dataset.card.split(':');
    const p = lookup(`${gid}:${pid}`);
    const c = p.packs.flatMap(k => k.cards || []).find(c => `${c.set}/${c.number}` === sn);
    if (c) cardModal(c);
  });
}

// ---------------- live sync ----------------
function connect() {
  const es = new EventSource('/api/events');
  const dot = $('#liveDot');
  es.addEventListener('hello', () => dot.classList.add('on'));
  es.onerror = () => dot.classList.remove('on');
  const onState = async () => {
    try {
      const prevSpins = new Set(S.game?.spins.map(s => s.id) || []);
      await loadState();
      const fresh = (S.game?.spins || []).filter(s => !prevSpins.has(s.id) && !S.seenSpins.has(s.id));
      fresh.forEach(s => S.seenSpins.add(s.id));
      const spin = fresh.at(-1);
      if (spin && S.route === 'wheel' && !S.spinning) {
        S.wheelPlayer = spin.playerId;
        renderWheel($('#view'));
        await runSpin(spin);
        return;
      }
      if (spin) {
        const set = S.setsByCode.get(spin.setCode);
        toast(`🎡 ${esc(playerById(spin.playerId)?.name)} spun <b>${esc(set?.name || spin.setCode)}</b> · <a href="#wheel">watch</a>`, 'good');
      }
      if (S.spinning || S.opening) return;
      // Don't yank the page out from under someone mid-reveal or typing.
      const typing = document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
      if (S.route === 'sets' && typing) return;
      if (S.route === 'packs' && $('.mcard.down')) return;
      if (S.route === 'history') S.history = null;
      render();
    } catch { /* next event will retry */ }
  };
  es.addEventListener('state', onState);
  es.addEventListener('spin', onState);
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
  parseRoute();
  $('#view').innerHTML = '<div class="spinner"></div>';
  try {
    await Promise.all([loadState(), loadSets()]);
    for (const sp of S.game?.spins || []) S.seenSpins.add(sp.id);
  } catch (err) { fail(err); }
  if (!location.hash) location.replace(S.game?.status === 'awarded' ? '#wheel' : '#game');
  parseRoute();
  render();
  connect();
})();
