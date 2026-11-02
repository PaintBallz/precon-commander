// Booster generation.
//  - Sets with real booster data (bundled in packs/, from the author's mtg-pack-opener project) use those exact
//    print sheets and slot odds — Play Booster where it exists, else Draft,
//    else Set Booster. Collector Boosters are never used.
//  - Every other set gets a generated "regular booster" from its Scryfall pool.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetPool, lookupCards, fallbackImage } from './scryfall.js';

const PACK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'packs');
const PRIORITY = ['play', 'draft', 'set'];

const realPacks = new Map(); // setCode -> { file, kind, name, setName }
for (const f of fs.readdirSync(PACK_DIR).filter(f => f.endsWith('.json'))) {
  const [code, kind] = f.replace('.json', '').split('-');
  if (!PRIORITY.includes(kind)) continue;
  const prev = realPacks.get(code);
  if (!prev || PRIORITY.indexOf(kind) < PRIORITY.indexOf(prev.kind)) realPacks.set(code, { file: path.join(PACK_DIR, f), kind });
}
const meta = fs.existsSync(path.join(PACK_DIR, 'sets.json')) ? JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'sets.json'), 'utf8')) : {};

export function hasRealPack(code) { return realPacks.has(code); }
export function realPackKind(code) { return realPacks.get(code)?.kind || null; }

// Minimal set list for when Scryfall's set list can't be reached.
export function localPackSets() {
  return [...realPacks.keys()].map(code => ({
    code,
    name: meta[code]?.name || code.toUpperCase(),
    type: 'expansion',
    released: meta[code]?.released || '2000-01-01',
    year: Number((meta[code]?.released || '2000').slice(0, 4)),
    cardCount: 0,
    icon: `https://svgs.scryfall.io/sets/${code}.svg`,
  })).sort((a, b) => b.released.localeCompare(a.released));
}

const rnd = n => Math.floor(Math.random() * n);

function weightedPick(items, weightOf) {
  const total = items.reduce((s, it) => s + weightOf(it), 0);
  let r = Math.random() * total;
  for (const it of items) { r -= weightOf(it); if (r < 0) return it; }
  return items[items.length - 1];
}

// Draw `count` distinct cards from a weighted sheet.
function drawFromSheet(sheet, count) {
  const pool = sheet.slice();
  const out = [];
  for (let i = 0; i < count && pool.length; i++) {
    const pick = weightedPick(pool, c => c.weight || 1);
    out.push(pick);
    pool.splice(pool.indexOf(pick), 1);
  }
  return out;
}

async function openRealPack(code) {
  const { file, kind } = realPacks.get(code);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const variant = weightedPick(data.variants, v => v.weight);
  const totalWeight = data.variants.reduce((s, v) => s + v.weight, 0);
  const picks = [];
  const slots = [];
  for (const slot of variant.slots) {
    const sheet = data.sheets[slot.sheet] || [];
    const foil = slot.sheet.includes('foil');
    const first = picks.length;
    for (const c of drawFromSheet(sheet, slot.count)) picks.push({ set: c.set, number: String(c.number), name: c.name, foil, slot: slot.sheet });
    slots.push({ label: sheetLabel(slot.sheet), count: slot.count, poolSize: sheet.length, cards: range(first, picks.length) });
  }
  const looked = await lookupCards(picks);
  const cards = picks.map(p => {
    const s = looked.get(`${p.set}/${p.number}`);
    // Scryfall's collector number (sheets say "123a" for some card faces).
    const number = s?.number || p.number.replace(/^(\d+)[a-z]$/, '$1');
    return {
      name: s?.name || p.name,
      set: p.set,
      number,
      rarity: s?.rarity || guessRarity(p.slot),
      type: s?.type || '',
      image: s?.image || fallbackImage(p.set, number),
      back: s?.back || null,
      uri: s?.uri || `https://scryfall.com/card/${p.set}/${number}`,
      foil: p.foil,
    };
  });
  const label = { play: 'Play Booster', draft: 'Draft Booster', set: 'Set Booster' }[kind];
  const explain = {
    source: 'real',
    summary: `Built from the real ${label} print sheets: each slot draws from its sheet with the printed odds.`,
    variant: { chance: variant.weight / totalWeight, of: data.variants.length },
    slots,
  };
  return { cards, boosterType: label, generated: false, explain };
}

const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
// "rare_mythic_with_showcase" -> "Rare / mythic (with showcase)"
function sheetLabel(sheet) {
  const [main, extra] = sheet.split(/_with_/);
  const words = main.replace(/_/g, ' / ').replace(/^./, ch => ch.toUpperCase());
  return extra ? `${words} (with ${extra.replace(/_/g, ' ')})` : words;
}

function guessRarity(sheet) {
  if (/mythic|rare/.test(sheet)) return 'rare';
  if (/uncommon/.test(sheet)) return 'uncommon';
  return 'common';
}

const isBasic = c => /^Basic( Snow)? Land/.test(c.type);

async function openGeneratedPack(code, released) {
  const pool = await getSetPool(code);
  if (!pool.length) throw new Error(`No cards found for set ${code.toUpperCase()}`);
  const basics = pool.filter(isBasic);
  const nonBasic = pool.filter(c => !isBasic(c));
  const by = r => nonBasic.filter(c => c.rarity === r);
  let commons = by('common'), uncommons = by('uncommon'), rares = by('rare'), mythics = by('mythic');
  // Some older/odd sets have thin rarity buckets — borrow from neighbours.
  if (commons.length < 11) commons = commons.concat(uncommons);
  if (uncommons.length < 3) uncommons = uncommons.concat(commons, rares);
  if (!rares.length) rares = mythics.length ? mythics : uncommons;

  const modern = released >= '2008-10-03'; // Shards of Alara: land slot + mythics
  const hasFoils = released >= '1999-02-15'; // Urza's Legacy
  const sample = (arr, n, taken) => {
    const avail = arr.filter(c => !taken.has(c.number));
    const out = [];
    for (let i = 0; i < n && avail.length; i++) {
      const c = avail.splice(rnd(avail.length), 1)[0];
      taken.add(c.number); out.push(c);
    }
    return out;
  };
  const taken = new Set();
  const nCommons = modern ? 10 : 11;
  const cards = [];
  let commonPicks = sample(commons, nCommons, taken);
  // ~1 in 6 packs: a foil of any rarity replaces a common.
  let foil = null;
  if (hasFoils && Math.random() < 1 / 6) {
    const r = Math.random();
    const src = r < 0.08 && mythics.length ? mythics : r < 0.2 ? rares : r < 0.45 ? uncommons : commons;
    foil = src[rnd(src.length)];
    commonPicks = commonPicks.slice(0, nCommons - 1);
  }
  const slots = [];
  const add = (label, list, poolSize, note) => {
    if (!list.length) return;
    slots.push({ label, count: list.length, poolSize, note, cards: range(cards.length, cards.length + list.length) });
    cards.push(...list);
  };
  if (modern) {
    const land = basics.length ? basics[rnd(basics.length)] : sample(commons, 1, taken)[0];
    if (land) add('Basic land', [{ ...land, foil: false }], basics.length || commons.length);
  }
  add('Common', commonPicks.map(c => ({ ...c, foil: false })), commons.length, foil ? 'one common was replaced by the foil' : '');
  add('Uncommon', sample(uncommons, 3, taken).map(c => ({ ...c, foil: false })), uncommons.length);
  const mythicRoll = mythics.length && Math.random() < 1 / 8;
  const rareSrc = mythicRoll ? mythics : rares;
  add(mythicRoll ? 'Rare slot: hit a mythic (1 in 8)' : 'Rare slot (1 in 8 would be a mythic)', sample(rareSrc, 1, taken).map(c => ({ ...c, foil: false })), rareSrc.length);
  if (foil) add('Foil (about 1 in 6 packs)', [{ ...foil, foil: true }], pool.length);
  const explain = {
    source: 'generated',
    summary: `${released.slice(0, 4)} set with no bundled print sheets, so the pack is generated from Scryfall's list of the set's ${pool.length} booster cards using that era's pack layout.`,
    era: modern ? 'Shards of Alara (2008) or later: basic land slot, 10 commons, 3 uncommons, 1 rare that is a mythic 1 time in 8.'
      : 'Before Shards of Alara (2008): 11 commons, 3 uncommons, 1 rare, no land slot and no mythics.',
    foils: hasFoils ? 'About 1 pack in 6 has a foil of any rarity in place of a common.' : 'Released before foils existed (Urza\'s Legacy, 1999).',
    slots,
  };
  return {
    cards: cards.map(c => ({ ...c, image: c.image || fallbackImage(c.set, c.number), uri: c.uri || `https://scryfall.com/card/${c.set}/${c.number}` })),
    boosterType: 'Booster',
    generated: true,
    explain,
  };
}

export async function openPack(set) {
  return realPacks.has(set.code) ? openRealPack(set.code) : openGeneratedPack(set.code, set.released || '2000-01-01');
}
