// Imports real booster print sheets from MTGJSON (https://mtgjson.com, MIT
// License) into packs/ for sets that don't have bundled sheets yet.
//
//   node scripts/import-mtgjson-boosters.mjs lea m10 ktk ...   (set codes)
//   node scripts/import-mtgjson-boosters.mjs --force ...       (overwrite existing files)
//
// For each set it downloads that set's MTGJSON file, picks the regular booster
// (Play, else Draft, else the original "default" booster, else Set; never
// Collector, Jumpstart, prerelease, Arena or starter decks) and writes
// packs/<code>-<kind>.json in the same shape as the other pack files:
//
//   variants: [{ weight, totalWeight, slots: [{ sheet, count }] }]
//   sheets:   { <sheet>: [{ set, number, name, weight }] }
//   sheetInfo:{ <sheet>: { foil, fixed, allowDuplicates } }
//
// Sheets can hold cards from other sets (The List, bonus sheets); those sets'
// files are downloaded too, to turn MTGJSON card ids into set + number.
// Only MTGJSON is contacted, never Scryfall.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const PACK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'packs');
const KINDS = ['play', 'draft', 'default', 'set'];
const API = 'https://mtgjson.com/api/v5';
const force = process.argv.includes('--force');
const codes = process.argv.slice(2).filter(a => !a.startsWith('--')).map(c => c.toLowerCase());
if (!codes.length) { console.error('Usage: node scripts/import-mtgjson-boosters.mjs [--force] <set code> ...'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const setFiles = new Map(); // CODE -> MTGJSON set data (or null)
async function mtgjsonSet(code) {
  code = code.toUpperCase();
  if (setFiles.has(code)) return setFiles.get(code);
  await sleep(250); // be polite to MTGJSON's CDN
  const res = await fetch(`${API}/${encodeURIComponent(code)}.json.gz`, { headers: { 'User-Agent': 'PreconCommander pack importer (+https://github.com/PaintBallz/precon-commander)' } });
  const data = res.ok ? JSON.parse(zlib.gunzipSync(Buffer.from(await res.arrayBuffer()))).data : null;
  setFiles.set(code, data);
  return data;
}

const meta = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'sets.json'), 'utf8'));
const existing = new Set(fs.readdirSync(PACK_DIR).filter(f => /-(play|draft|default|set)\.json$/.test(f)).map(f => f.split('-')[0]));
const report = { written: [], skipped: [] };

for (const code of codes) {
  if (existing.has(code) && !force) { report.skipped.push(`${code}: already has sheets`); continue; }
  const set = await mtgjsonSet(code);
  if (!set) { report.skipped.push(`${code}: not on MTGJSON`); continue; }
  const kind = KINDS.find(k => set.booster?.[k]);
  if (!kind) { report.skipped.push(`${code}: no regular booster (has ${Object.keys(set.booster || {}).join(', ') || 'none'})`); continue; }
  const b = set.booster[kind];

  // uuid -> card, across every set the sheets draw from.
  const byUuid = new Map();
  for (const src of new Set([set.code, ...(b.sourceSetCodes || [])])) {
    const s = src.toUpperCase() === set.code ? set : await mtgjsonSet(src);
    for (const c of [...(s?.cards || []), ...(s?.tokens || [])]) byUuid.set(c.uuid, c);
  }

  const used = new Set(b.boosters.flatMap(v => Object.keys(v.contents)));
  const sheets = {}, sheetInfo = {};
  let missing = 0;
  for (const name of used) {
    const sh = b.sheets[name];
    const cards = [];
    for (const [uuid, weight] of Object.entries(sh.cards)) {
      const c = byUuid.get(uuid);
      if (!c) { missing++; continue; }
      cards.push({ set: c.setCode.toLowerCase(), number: String(c.number), name: c.name, weight });
    }
    sheets[name] = cards;
    sheetInfo[name] = { foil: !!sh.foil, fixed: !!sh.fixed, allowDuplicates: !!sh.allowDuplicates };
  }
  const variants = b.boosters.map(v => ({
    weight: v.weight,
    totalWeight: b.boostersTotalWeight,
    slots: Object.entries(v.contents).map(([sheet, count]) => ({ sheet, count })),
  }));
  // Every slot must be fillable.
  const short = variants.flatMap(v => v.slots).filter(sl => !sheetInfo[sl.sheet].allowDuplicates && !sheetInfo[sl.sheet].fixed && sheets[sl.sheet].length < sl.count);
  if (short.length) { report.skipped.push(`${code}: sheet too small (${short.map(s => s.sheet).join(', ')})`); continue; }

  const out = { id: `${code}-${kind}`, name: `${set.name} ${kind} booster`, source: 'MTGJSON', variants, sheets, sheetInfo };
  fs.writeFileSync(path.join(PACK_DIR, `${code}-${kind}.json`), JSON.stringify(out));
  meta[code] = { name: set.name, released: set.releaseDate };
  report.written.push(`${code}-${kind}${missing ? ` (${missing} unknown card ids dropped)` : ''}`);
  console.log('wrote', `${code}-${kind}`, `${variants.length} layouts, ${Object.keys(sheets).length} sheets`, missing ? `${missing} dropped` : '');
}

fs.writeFileSync(path.join(PACK_DIR, 'sets.json'), JSON.stringify(Object.fromEntries(Object.entries(meta).sort()), null, 1) + '\n');
console.log(`\n${report.written.length} written, ${report.skipped.length} skipped`);
for (const s of report.skipped) console.log('  skipped', s);
