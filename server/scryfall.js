// Scryfall access: set list, per-set card pools, and card lookups by set/number.
// Scryfall asks for <=10 req/s (2 req/s for card search/collection lookups), a
// User-Agent and an Accept header, so every request goes through one queue:
// 110 ms apart, 550 ms after a search/collection call. A 429 is retried after
// a pause (twice) instead of failing the lookup.
import { cacheGetMany, cachePut, poolGet, poolPut, kvGet, kvSet } from './db.js';

const BASE = process.env.SCRYFALL_BASE || 'https://api.scryfall.com';
const HEADERS = { 'User-Agent': process.env.SCRYFALL_USER_AGENT || 'PreconCommander/1.0 (+https://github.com/PaintBallz/precon-commander)', Accept: 'application/json' };

let chain = Promise.resolve();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function sfFetch(url, opts = {}) {
  const slow = /\/cards\/(collection|search|named|random)/.test(url);
  const run = chain.then(async () => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url.startsWith('http') ? url : BASE + url, { ...opts, headers: { ...HEADERS, ...(opts.headers || {}) } });
      await sleep(slow ? 550 : 110);
      if (res.status === 429 && attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Scryfall ${res.status} for ${url}`);
      return res.json();
    }
  });
  chain = run.catch(() => {});
  return run;
}

// Set types that were sold in regular boosters.
export const BOOSTER_SET_TYPES = ['expansion', 'core', 'masters', 'draft_innovation'];

export function slimCard(c) {
  const face0 = c.card_faces?.[0];
  const face1 = c.card_faces?.[1];
  return {
    name: c.name,
    set: c.set,
    number: c.collector_number,
    rarity: c.rarity,
    type: c.type_line || face0?.type_line || '',
    image: c.image_uris?.normal || face0?.image_uris?.normal || null,
    back: !c.image_uris && face1?.image_uris?.normal ? face1.image_uris.normal : null,
    uri: c.scryfall_uri,
  };
}

export function fallbackImage(set, number) {
  return `https://api.scryfall.com/cards/${encodeURIComponent(set)}/${encodeURIComponent(number)}?format=image&version=normal`;
}

// One card by (roughly) its name, for a player's commander image.
export async function findCard(name) {
  const c = await sfFetch(`/cards/named?fuzzy=${encodeURIComponent(name)}`);
  if (!c) return null;
  const s = slimCard(c);
  return { name: s.name, image: s.image, uri: s.uri };
}

// Official Commander precon names for the suggestions on the precon field, from
// MTGJSON's deck list. Cached for a week; if it can't be reached the field still
// takes any name.
const PRECON_TTL_MS = 7 * 24 * 3600 * 1000;
async function preconList() {
  const cached = kvGet('precon_list');
  if (cached && Date.now() - cached.fetchedAt < PRECON_TTL_MS) return cached.decks;
  try {
    const res = await fetch('https://mtgjson.com/api/v5/DeckList.json', { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`MTGJSON ${res.status}`);
    const json = await res.json();
    const decks = json.data.filter(d => d.type === 'Commander Deck').map(d => ({ name: d.name, file: d.fileName, date: d.releaseDate || '' }));
    kvSet('precon_list', { fetchedAt: Date.now(), decks });
    return decks;
  } catch (err) {
    console.warn('Could not refresh precon names:', err.message);
    return cached?.decks || [];
  }
}
export async function getPreconNames() {
  return [...new Set((await preconList()).map(d => d.name))].sort((a, b) => a.localeCompare(b));
}
// The official precon with this name (newest printing if it was reprinted), or null.
export async function findPrecon(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return (await preconList()).filter(d => d.name.toLowerCase() === n).sort((a, b) => b.date.localeCompare(a.date))[0] || null;
}
// An official precon's card list from MTGJSON, as deck-import entries.
export async function getPreconDeck(name) {
  const d = await findPrecon(name);
  if (!d || !/^[A-Za-z0-9_-]+$/.test(d.file)) return null;
  const res = await fetch(`https://mtgjson.com/api/v5/decks/${d.file}.json`, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`MTGJSON ${res.status}`);
  const j = (await res.json()).data || {};
  const map = (list, board) => (list || []).map(c => ({ qty: c.count || 1, name: c.name, id: c.identifiers?.scryfallId, foil: !!c.isFoil, board }));
  return { name: d.name, entries: [...map(j.commander, 'commander'), ...map(j.mainBoard, 'main')] };
}

const SETS_TTL_MS = 24 * 3600 * 1000;

// All booster sets, newest first. Cached in the DB and refreshed daily; if
// Scryfall is unreachable the last good copy (or the local pack list) is used.
export async function getBoosterSets(localPackSets) {
  const cached = kvGet('scryfall_sets');
  if (cached && Date.now() - cached.fetchedAt < SETS_TTL_MS) return cached.sets;
  try {
    const json = await sfFetch('/sets');
    const today = new Date().toISOString().slice(0, 10);
    const sets = json.data
      .filter(s => BOOSTER_SET_TYPES.includes(s.set_type) && !s.digital && s.released_at && s.released_at <= today && s.card_count >= 40)
      .map(s => ({
        code: s.code,
        name: s.name,
        type: s.set_type,
        released: s.released_at,
        year: Number(s.released_at.slice(0, 4)),
        cardCount: s.card_count,
        icon: s.icon_svg_uri,
      }))
      .sort((a, b) => b.released.localeCompare(a.released));
    kvSet('scryfall_sets', { fetchedAt: Date.now(), sets });
    return sets;
  } catch (err) {
    console.warn('Could not refresh set list from Scryfall:', err.message);
    if (cached) return cached.sets;
    return localPackSets;
  }
}

const POOL_TTL_MS = 14 * 24 * 3600 * 1000;

// Every card from a set that appears in its boosters (falls back to the whole
// set when Scryfall has no booster flags for it).
export async function getSetPool(code) {
  const cached = poolGet(code);
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < POOL_TTL_MS && cached.cards.length) return cached.cards;
  async function search(q) {
    const cards = [];
    let url = `/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=set&include_extras=false`;
    while (url) {
      const page = await sfFetch(url);
      if (!page) break;
      for (const c of page.data) cards.push(slimCard(c));
      url = page.has_more ? page.next_page : null;
    }
    return cards;
  }
  try {
    let cards = await search(`e:${code} is:booster -is:digital`);
    if (cards.length < 20) cards = await search(`e:${code} -is:digital`);
    if (cards.length) poolPut(code, cards);
    for (const c of cards) cachePut(`${c.set}/${c.number}`, c);
    return cards;
  } catch (err) {
    if (cached) return cached.cards;
    throw err;
  }
}

// Look up exact printings by set + collector number (75 per request).
// Looks cards up by set + collector number. The bundled print sheets number
// the faces of double-faced / split / adventure cards "123a"; Scryfall knows
// them as "123", so a miss with a letter suffix is retried without it and
// cached under the sheet's number too.
export async function lookupCards(idents) {
  const found = await lookupExact(idents);
  const suffixed = idents.filter(i => !found.has(`${i.set}/${i.number}`) && /^\d+[a-z]$/.test(i.number));
  if (suffixed.length) {
    const plain = await lookupExact(suffixed.map(i => ({ set: i.set, number: i.number.slice(0, -1) })));
    for (const i of suffixed) {
      const s = plain.get(`${i.set}/${i.number.slice(0, -1)}`);
      if (s) { cachePut(`${i.set}/${i.number}`, s); found.set(`${i.set}/${i.number}`, s); }
    }
  }
  return found;
}

async function lookupExact(idents) {
  const keys = idents.map(i => `${i.set}/${i.number}`);
  const found = cacheGetMany(keys);
  const missing = idents.filter((i, n) => !found.has(keys[n]));
  const unique = [...new Map(missing.map(i => [`${i.set}/${i.number}`, i])).values()];
  for (let i = 0; i < unique.length; i += 75) {
    const batch = unique.slice(i, i + 75);
    try {
      const json = await sfFetch('/cards/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers: batch.map(b => ({ set: b.set, collector_number: b.number })) }),
      });
      for (const c of json?.data || []) {
        const s = slimCard(c);
        const key = `${s.set}/${s.number}`;
        cachePut(key, s);
        found.set(key, s);
      }
    } catch (err) {
      console.warn('Card lookup failed:', err.message);
    }
  }
  return found;
}

// ---------- full card data (deck lists) ----------
// identifiers: Scryfall's own shapes ({id} | {set, collector_number} | {name}).
// Returns one entry per identifier, in order: the raw card, or null if Scryfall
// doesn't know it. Not cached: callers keep what they need.
const norm = s => String(s || '').toLowerCase();
function matches(c, ident) {
  if (ident.id) return c.id === ident.id;
  if (ident.collector_number) return norm(c.set) === norm(ident.set) && norm(c.collector_number) === norm(ident.collector_number);
  const n = norm(ident.name);
  return norm(c.name) === n || norm(c.name).startsWith(n + ' // ') || (c.card_faces || []).some(f => norm(f.name) === n);
}
export async function fetchCollection(identifiers) {
  const out = new Array(identifiers.length).fill(null);
  for (let i = 0; i < identifiers.length; i += 75) {
    const batch = identifiers.slice(i, i + 75);
    const json = await sfFetch('/cards/collection', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiers: batch }),
    });
    const found = json?.data || [];
    batch.forEach((ident, n) => { out[i + n] = found.find(c => matches(c, ident)) || null; });
  }
  return out;
}

