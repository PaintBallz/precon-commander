// Deck lists: each player can keep one deck (the precon they play) on their
// profile. It comes from a Moxfield or Archidekt link, or a pasted list, and
// every card is looked up on Scryfall once at import so the deck page has
// images, mana values and colours without asking again.
//
// Only moxfield.com and archidekt.com links are fetched, and only through their
// fixed public API addresses (the link just supplies the deck id), so a link
// can't make the server request anything else.
import { db } from './db.js';
import { fetchCollection, getPreconDeck } from './scryfall.js';

db.exec(`CREATE TABLE IF NOT EXISTS decks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  league_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  url TEXT,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, league_id)
)`);
// Decks used to be one per account: they move to the player's current league
// (or the latest one they were in).
if (!db.prepare("SELECT 1 FROM pragma_table_info('decks') WHERE name = 'league_id'").get()) {
  db.exec(`BEGIN IMMEDIATE;
    ALTER TABLE decks RENAME TO decks_old;
    CREATE TABLE decks (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      league_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL, source TEXT NOT NULL, url TEXT, data TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, league_id)
    );
    INSERT INTO decks (user_id, league_id, name, source, url, data, updated_at)
      SELECT d.user_id, COALESCE((SELECT m.league_id FROM league_members m WHERE m.user_id = d.user_id ORDER BY m.left_at IS NOT NULL, m.joined_at DESC LIMIT 1), ''),
             d.name, d.source, d.url, d.data, d.updated_at FROM decks_old d;
    DROP TABLE decks_old;
    COMMIT;`);
}

export class DeckError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const MAX_LINES = 250;
const UA = { 'User-Agent': 'PreconCommander/1.0 (+https://github.com/PaintBallz/precon-commander)', Accept: 'application/json' };

// ---------- reading a source into [{ qty, name, set?, number?, id?, foil, board }] ----------
const SECTION = /^(?:\/\/\s*)?(commanders?|companions?|deck|main(?:board)?|sideboard|maybe(?:board)?|considering|tokens?)\s*:?\s*(?:\(\d+\))?$/i;
// "1 Name", "1x Name", "Name", optionally "(SET) 123" and "*F*" / "*E*" (foil/etched).
const LINE = /^(?:(\d+)\s*x?\s+)?(.+?)(?:\s+\(([A-Za-z0-9]{2,6})\)\s+([A-Za-z0-9★†-]+))?(\s+\*[FE]\*)?\s*$/;

export function parseList(text) {
  const blocks = [[]];
  let board = 'main', explicitCommander = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { if (blocks.at(-1).length) blocks.push([]); continue; }
    const sec = line.match(SECTION);
    if (sec) {
      const s = sec[1].toLowerCase();
      board = s.startsWith('commander') ? 'commander' : /^(deck|main)/.test(s) ? 'main' : 'skip';
      if (board === 'commander') explicitCommander = true;
      if (blocks.at(-1).length) blocks.push([]);
      continue;
    }
    if (board === 'skip' || line.startsWith('#') || line.startsWith('//')) continue;
    const m = line.match(LINE);
    if (!m) continue;
    const qty = Math.min(99, Number(m[1] || 1));
    blocks.at(-1).push({ qty, name: m[2].trim(), set: m[3]?.toLowerCase(), number: m[4], foil: !!m[5], board });
  }
  const cards = blocks.flat();
  // Moxfield's and Archidekt's plain-text exports put the commander(s) in a
  // last short block after a blank line; treat 1–2 single cards there as the
  // commander unless the list already says which is the commander.
  const last = blocks.filter(b => b.length).at(-1);
  if (!explicitCommander && blocks.filter(b => b.length).length > 1 && last.length <= 2 && last.every(c => c.qty === 1)) {
    for (const c of last) c.board = 'maybe-commander';
  }
  return cards;
}

export function deckSource(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { throw new DeckError(400, 'That is not a link. Paste a Moxfield or Archidekt deck link, or paste the list itself.'); }
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'moxfield.com') {
    const id = u.pathname.match(/^\/decks\/([A-Za-z0-9_-]{4,64})/)?.[1];
    if (id) return { site: 'moxfield', id, url: `https://moxfield.com/decks/${id}` };
  }
  if (host === 'archidekt.com') {
    const id = u.pathname.match(/^\/decks\/(\d{1,12})/)?.[1];
    if (id) return { site: 'archidekt', id, url: `https://archidekt.com/decks/${id}` };
  }
  throw new DeckError(400, 'Only Moxfield (moxfield.com/decks/…) and Archidekt (archidekt.com/decks/…) links work. For anything else, paste the list.');
}

// How to get a list out of each site by hand, for when a link can't be read.
const PASTE_HELP = {
  moxfield: 'On Moxfield, open the deck, choose More → Export, copy the plain-text list and paste it below instead.',
  archidekt: 'On Archidekt, open the deck, choose Export, copy the text list and paste it below instead.',
};
// Moxfield sits behind bot protection that sometimes turns servers away; the
// site then answers 403 and the player is told to paste the list.
async function getJson(url, site) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal, redirect: 'error' });
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403 || res.status === 429) throw new DeckError(502, `${site === 'moxfield' ? 'Moxfield' : 'Archidekt'} wouldn't let this site read the deck. ${PASTE_HELP[site]}`);
    if (!res.ok) throw new DeckError(502, `The deck site answered ${res.status}. ${PASTE_HELP[site]}`);
    return await res.json();
  } catch (err) {
    if (err instanceof DeckError) throw err;
    throw new DeckError(502, `Couldn't reach the deck site. ${PASTE_HELP[site]}`);
  } finally { clearTimeout(t); }
}

async function readSite(src) {
  if (src.site === 'moxfield') {
    const j = await getJson(`https://api2.moxfield.com/v3/decks/all/${src.id}`, 'moxfield');
    if (!j?.boards) throw new DeckError(404, "Couldn't find that Moxfield deck. Check the link, and that the deck is public or unlisted.");
    const cards = [];
    for (const [board, key] of [['commander', 'commanders'], ['main', 'mainboard'], ['main', 'companions']]) {
      for (const e of Object.values(j.boards[key]?.cards || {})) {
        cards.push({ qty: e.quantity || 1, name: e.card?.name, id: e.card?.scryfall_id, set: e.card?.set, number: e.card?.cn, foil: e.finish === 'foil' || e.finish === 'etched' || !!e.isFoil, board });
      }
    }
    return { name: j.name, cards };
  }
  const j = await getJson(`https://archidekt.com/api/decks/${src.id}/`, 'archidekt');
  if (!j?.cards) throw new DeckError(404, "Couldn't find that Archidekt deck. Check the link, and that the deck is public.");
  const outCats = new Set((j.categories || []).filter(c => c.includedInDeck === false).map(c => c.name));
  const cards = [];
  for (const e of j.cards) {
    const cats = e.categories || [];
    if (cats.length && cats.every(c => outCats.has(c))) continue;
    if (cats.some(c => /^(maybeboard|sideboard)$/i.test(c))) continue;
    cards.push({
      qty: e.quantity || 1, name: e.card?.oracleCard?.name, id: e.card?.uid, set: e.card?.edition?.editioncode, number: e.card?.collectorNumber,
      foil: /foil|etched/i.test(e.modifier || ''), board: cats.some(c => /^commander$/i.test(c)) ? 'commander' : 'main',
    });
  }
  return { name: j.name, cards };
}

// ---------- looking cards up ----------
const faceImage = (c, i) => c.card_faces?.[i]?.image_uris?.normal || null;
function deckCard(entry, c) {
  const front = c.card_faces?.[0];
  return {
    qty: entry.qty, board: entry.board, foil: !!entry.foil,
    name: c.name, set: c.set, number: c.collector_number, rarity: c.rarity,
    type: c.type_line || front?.type_line || '',
    mana: c.mana_cost ?? front?.mana_cost ?? '',
    cmc: Number(c.cmc) || 0,
    colors: c.colors || front?.colors || [],
    ci: c.color_identity || [],
    image: c.image_uris?.normal || faceImage(c, 0),
    back: !c.image_uris ? faceImage(c, 1) : null,
    art: c.image_uris?.art_crop || c.card_faces?.[0]?.image_uris?.art_crop || null,
    uri: c.scryfall_uri,
  };
}

async function resolve(entries) {
  // Merge repeats of the same printing (pasted lists sometimes split them).
  const merged = new Map();
  for (const e of entries) {
    if (!e.name && !e.id) continue;
    const key = `${e.board}|${e.id || ''}|${(e.name || '').toLowerCase()}|${e.set || ''}|${e.number || ''}|${e.foil}`;
    if (merged.has(key)) merged.get(key).qty += e.qty; else merged.set(key, { ...e });
  }
  const list = [...merged.values()];
  if (!list.length) throw new DeckError(400, 'No cards found. Paste one card per line, like "1 Sol Ring" or "1 Sol Ring (C21) 263".');
  if (list.length > MAX_LINES) throw new DeckError(400, `That's ${list.length} different cards; a Commander deck has at most ${MAX_LINES}.`);
  const ident = e => (e.id ? { id: e.id } : e.set && e.number ? { set: e.set, collector_number: e.number } : { name: e.name.split(' // ')[0] });
  let raw = await fetchCollection(list.map(ident));
  // A set/number that's off by a little finds some other card: only keep it
  // if the name agrees. A wrong set/number (or id) falls back to the name.
  const norm = s => String(s || '').toLowerCase().trim();
  const sameName = (c, name) => {
    const n = norm(name), full = norm(c.name);
    return full === n || full.startsWith(n + ' // ') || (c.card_faces || []).some(f => norm(f.name) === n);
  };
  raw = raw.map((c, i) => (c && list[i].name && !list[i].id && !sameName(c, list[i].name) ? null : c));
  const retry = list.map((e, i) => (!raw[i] && e.name && (e.id || e.set) ? i : -1)).filter(i => i >= 0);
  if (retry.length) {
    const again = await fetchCollection(retry.map(i => ({ name: list[i].name.split(' // ')[0] })));
    retry.forEach((i, n) => { raw[i] = again[n]; });
  }
  const cards = [], missing = [];
  list.forEach((e, i) => (raw[i] ? cards.push(deckCard(e, raw[i])) : missing.push(e.name || e.id)));
  // A trailing block guessed as the commander only counts if it's legendary
  // (or says it can be your commander).
  for (const c of cards) {
    if (c.board !== 'maybe-commander') continue;
    c.board = /legendary/i.test(c.type) || /can be your commander/i.test(c.type) ? 'commander' : 'main';
  }
  return { cards, missing };
}

// ---------- the stored deck ----------
function summary(cards) {
  const commanders = cards.filter(c => c.board === 'commander');
  const ci = new Set(commanders.length ? commanders.flatMap(c => c.ci) : cards.flatMap(c => c.ci));
  const count = cards.reduce((n, c) => n + c.qty, 0);
  return { count, colors: 'WUBRG'.split('').filter(x => ci.has(x)), commanders: commanders.map(c => c.name) };
}
function rowOf(r) {
  if (!r) return null;
  const d = JSON.parse(r.data);
  return { name: r.name, source: r.source, url: r.url || null, updatedAt: r.updated_at, ...d, ...summary(d.cards) };
}
// One league's deck, or (with no league) the player's most recently updated one.
export const getDeck = (userId, leagueId) => rowOf(leagueId
  ? db.prepare('SELECT * FROM decks WHERE user_id = ? AND league_id = ?').get(userId, leagueId)
  : db.prepare('SELECT * FROM decks WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1').get(userId));
export function deckSummaries(userIds) {
  const out = new Map();
  for (const id of userIds) {
    const d = getDeck(id);
    if (d) out.set(id, { name: d.name, commanders: d.commanders, colors: d.colors, count: d.count });
  }
  return out;
}
export const deleteDeck = (userId, leagueId) => db.prepare('DELETE FROM decks WHERE user_id = ? AND league_id = ?').run(userId, leagueId).changes > 0;

function save(userId, leagueId, deck) {
  db.prepare(`INSERT INTO decks (user_id, league_id, name, source, url, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id, league_id) DO UPDATE SET name = excluded.name, source = excluded.source, url = excluded.url, data = excluded.data, updated_at = excluded.updated_at`)
    .run(userId, leagueId, deck.name, deck.source, deck.url || null, JSON.stringify({ cards: deck.cards, missing: deck.missing, base: deck.base || null }), new Date().toISOString());
  return getDeck(userId, leagueId);
}

export async function importDeck(userId, leagueId, { url, text, name }) {
  let entries, deckName, source, link = null;
  if (url && String(url).trim()) {
    const src = deckSource(url);
    const got = await readSite(src);
    entries = got.cards; deckName = got.name; source = src.site; link = src.url;
  } else if (text && String(text).trim()) {
    if (String(text).length > 40000) throw new DeckError(400, 'That list is too long.');
    entries = parseList(text); source = 'text';
  } else throw new DeckError(400, 'Paste a Moxfield or Archidekt link, or the deck list.');
  const { cards, missing } = await resolve(entries);
  const commanders = cards.filter(c => c.board === 'commander');
  deckName = String(name || deckName || commanders.map(c => c.name.split(' // ')[0]).join(' & ') || 'My deck').trim().slice(0, 80);
  return save(userId, leagueId, { name: deckName, source, url: link, cards, missing, base: cards });
}

// ---------- the deck editor (Pools tab) ----------
// A deck = its starting list (base: the precon, from MTGJSON or an import)
// plus pool cards swapped in. Each card has a key: pool cards by their pool
// card id, precon cards by name. Cut precon cards can be put back.
const keyOf = c => (c.poolId ? `pool:${c.poolId}` : `base:${c.name}`);
const baseOf = d => d.base || d.cards.filter(c => !c.poolId);
export async function startFromPrecon(userId, leagueId, precon) {
  let got;
  try { got = await getPreconDeck(precon); } catch { throw new DeckError(502, "Couldn't load the precon list right now. Try again in a minute."); }
  if (!got) throw new DeckError(404, `"${precon}" isn't an official precon name, so there's no list to load. Import your list on the League tab instead.`);
  const { cards, missing } = await resolve(got.entries);
  return save(userId, leagueId, { name: got.name, source: 'precon', url: null, cards, missing, base: cards });
}
// pool: this player's pool_cards rows in the league.
export async function changeDeck(userId, leagueId, { add, remove, pool }) {
  const d = getDeck(userId, leagueId);
  if (!d) throw new DeckError(404, 'Start your deck first.');
  const base = baseOf(d), cards = d.cards;
  if (remove) {
    const i = cards.findIndex(c => keyOf(c) === remove);
    if (i < 0) throw new DeckError(404, "That card isn't in your deck.");
    if (cards[i].qty > 1) cards[i] = { ...cards[i], qty: cards[i].qty - 1 }; else cards.splice(i, 1);
  } else if (add?.startsWith('pool:')) {
    const id = Number(add.slice(5));
    const pc = pool.find(r => r.id === id);
    if (!pc) throw new DeckError(404, "That card isn't in your pool.");
    if (cards.some(c => c.poolId === id)) throw new DeckError(409, 'That card is already in your deck.');
    const [sf] = await fetchCollection([{ set: pc.set_code, collector_number: pc.number }]).catch(() => [null]);
    const card = sf && sf.name === pc.name ? deckCard({ qty: 1, board: 'main', foil: !!pc.foil }, sf)
      : { qty: 1, board: 'main', foil: !!pc.foil, name: pc.name, set: pc.set_code, number: pc.number, rarity: pc.rarity, type: pc.type || '', mana: '', cmc: 0, colors: [], ci: [], image: pc.image, back: pc.back || null, art: null, uri: pc.uri };
    cards.push({ ...card, poolId: id });
  } else if (add?.startsWith('base:')) {
    const name = add.slice(5);
    const b = base.find(c => c.name === name);
    if (!b) throw new DeckError(404, "That card isn't from your precon.");
    const have = cards.filter(c => !c.poolId && c.name === name);
    if (have.reduce((n, c) => n + c.qty, 0) >= b.qty) throw new DeckError(409, 'All of those are already in your deck.');
    if (have.length) have[0].qty++; else cards.push({ ...b, qty: 1 });
  } else throw new DeckError(400, 'Pick a card to add or remove.');
  return save(userId, leagueId, { name: d.name, source: d.source, url: d.url, cards, missing: d.missing, base });
}

// Pick (or clear) which cards are the commander(s), and rename the deck.
export function editDeck(userId, leagueId, { commanders, name }) {
  const d = getDeck(userId, leagueId);
  if (!d) throw new DeckError(404, "You haven't imported a deck yet.");
  if (Array.isArray(commanders)) {
    const want = new Set(commanders.slice(0, 2).map(String));
    for (const c of d.cards) c.board = want.has(c.name) ? 'commander' : 'main';
  }
  return save(userId, leagueId, { name: name != null ? String(name).trim().slice(0, 80) || d.name : d.name, source: d.source, url: d.url, cards: d.cards, missing: d.missing, base: d.base });
}
