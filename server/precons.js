// Every official Commander precon and its card list, from MTGJSON. A printed
// precon never changes, so each list is downloaded once and kept in the
// database; the list of decks is checked again weekly for new releases.
//
// When a player locks in their precon for a league, its cards go into their
// pool there as one 'precon' pack in the league's "Admin packs" container. That
// pack isn't a pull: standings, stats and awards skip it, and it can't be traded.
import crypto from 'node:crypto';
import { db, grantsPod, savePod, setInfoFor } from './db.js';

const BASE = (process.env.MTGJSON_BASE || 'https://mtgjson.com/api/v5').replace(/\/$/, '');
const HEADERS = { 'User-Agent': 'PreconCommander/1.0 (+https://github.com/PaintBallz/precon-commander)', Accept: 'application/json' };
const WEEK = 7 * 24 * 3600e3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

db.exec(`CREATE TABLE IF NOT EXISTS precon_decks (
  file TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_lc TEXT NOT NULL,
  code TEXT,
  release_date TEXT,
  cards TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS precon_decks_name ON precon_decks(name_lc);`);

const lc = s => String(s || '').trim().toLowerCase();
const image = (id, face = 'front') => (id ? `https://cards.scryfall.io/normal/${face}/${id[0]}/${id[1]}/${id}.jpg` : null);
// One card from an MTGJSON deck file, with what the pool and deck editor need.
function slim(c, board) {
  const id = c.identifiers?.scryfallId || '';
  const set = lc(c.setCode);
  return {
    name: c.name, qty: c.count || 1, board, foil: !!c.isFoil, set, number: String(c.number || ''),
    rarity: c.rarity || 'common', type: c.type || '', mana: c.manaCost || '', cmc: Number(c.manaValue ?? c.convertedManaCost) || 0,
    colors: c.colors || [], ci: c.colorIdentity || [],
    image: image(id), back: ['transform', 'modal_dfc', 'reversible_card'].includes(c.layout) ? image(id, 'back') : null,
    uri: set && c.number ? `https://scryfall.com/card/${set}/${encodeURIComponent(c.number)}` : null,
  };
}

let running = null;
export const syncPrecons = () => (running ||= download().finally(() => { running = null; }));
async function download() {
  let list;
  try {
    const res = await fetch(`${BASE}/DeckList.json`, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`MTGJSON ${res.status}`);
    list = (await res.json()).data.filter(d => d.type === 'Commander Deck');
  } catch (err) { console.warn('Precon lists: could not reach MTGJSON:', err.message); return 0; }
  const have = new Set(db.prepare('SELECT file FROM precon_decks').all().map(r => r.file));
  const put = db.prepare('INSERT OR REPLACE INTO precon_decks (file, name, name_lc, code, release_date, cards, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  let added = 0;
  for (const d of list) {
    if (have.has(d.fileName) || !/^[A-Za-z0-9_-]+$/.test(d.fileName || '')) continue;
    try {
      const res = await fetch(`${BASE}/decks/${d.fileName}.json`, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`MTGJSON ${res.status}`);
      const j = (await res.json()).data || {};
      const pick = (l, board) => (l || []).filter(c => !c.side || c.side === 'a').map(c => slim(c, board));
      const cards = [...pick(j.commander, 'commander'), ...pick(j.mainBoard, 'main')];
      if (cards.length) { put.run(d.fileName, d.name, lc(d.name), d.code || '', d.releaseDate || '', JSON.stringify(cards), new Date().toISOString()); added++; }
    } catch (err) { console.warn(`Precon list ${d.name}: ${err.message}`); }
    await sleep(Number(process.env.MTGJSON_DELAY_MS ?? 150));
  }
  if (added) console.log(`Saved ${added} precon list(s); ${preconCount()} in all`);
  return added;
}
// Download any missing lists now and then weekly; onDone runs after each pass.
export function keepPreconsFresh(onDone) {
  const pass = () => syncPrecons().then(onDone).catch(err => console.warn('Precon lists:', err.message));
  pass();
  setInterval(pass, WEEK).unref();
}

export const preconCount = () => db.prepare('SELECT COUNT(*) AS n FROM precon_decks').get().n;
export const preconNames = () => [...new Set(db.prepare('SELECT name FROM precon_decks').all().map(r => r.name))].sort((a, b) => a.localeCompare(b));
// The official spelling of a precon name (any case), or null.
export const officialName = name => db.prepare('SELECT name FROM precon_decks WHERE name_lc = ? LIMIT 1').get(lc(name))?.name || null;
// A precon and its cards (the newest printing if it was reprinted), or null.
export function findPrecon(name) {
  const r = db.prepare('SELECT * FROM precon_decks WHERE name_lc = ? ORDER BY release_date DESC LIMIT 1').get(lc(name));
  return r ? { name: r.name, code: r.code, releaseDate: r.release_date, cards: JSON.parse(r.cards) } : null;
}

// ---------- a player's precon cards in a league pool ----------
const hasPreconPack = (pod, userId) => !!pod?.absentees.find(a => a.id === userId)?.packs.some(k => k.kind === 'precon');
// Put the precon's cards in the player's pool (replacing any earlier precon's).
// Returns how many cards went in.
export function givePreconCards(leagueId, user, precon) {
  const p = findPrecon(precon);
  const pod = grantsPod(leagueId, { create: !!p });
  if (!pod) return 0;
  let who = pod.absentees.find(a => a.id === user.id);
  const old = who ? who.packs.filter(k => k.kind === 'precon') : [];
  if (!p && !old.length) return 0;
  const drop = db.prepare('DELETE FROM pool_cards WHERE pack_id = ?');
  for (const k of old) drop.run(k.id);
  if (who) who.packs = who.packs.filter(k => k.kind !== 'precon');
  let n = 0;
  if (p) {
    if (!who) { who = { id: user.id, name: user.username, grant: true, packs: [] }; pod.absentees.push(who); }
    const cards = p.cards.flatMap(c => Array.from({ length: c.qty }, () => ({ name: c.name, set: c.set, number: c.number, rarity: c.rarity, type: c.type, foil: c.foil, image: c.image, back: c.back, uri: c.uri })));
    const code = p.cards.find(c => c.board === 'commander')?.set || p.cards[0].set;
    const known = setInfoFor(code);
    const set = known.icon ? known : { ...known, icon: `https://svgs.scryfall.io/sets/${code}.svg` };
    who.packs.push({ id: crypto.randomUUID(), status: 'opened', source: 'wheel', set, wheelSet: null, cards, openedAt: new Date().toISOString(), kind: 'precon', note: p.name, grantedBy: null });
    n = cards.length;
  }
  pod.updatedAt = new Date().toISOString();
  savePod(pod);
  return n;
}
// Locked, official precons whose cards aren't in the pool yet (players who
// locked in before this existed, or before the lists finished downloading).
export function fillMissingPreconCards() {
  const rows = db.prepare(`SELECT m.league_id, m.user_id, m.precon, u.username FROM league_members m
    JOIN users u ON u.id = m.user_id JOIN leagues l ON l.id = m.league_id
    WHERE m.precon_locked = 1 AND m.left_at IS NULL AND l.status = 'active' AND u.is_test = 0`).all();
  const touched = new Set();
  for (const r of rows) {
    if (!officialName(r.precon) || hasPreconPack(grantsPod(r.league_id), r.user_id)) continue;
    if (givePreconCards(r.league_id, { id: r.user_id, username: r.username }, r.precon)) touched.add(r.league_id);
  }
  return [...touched];
}
