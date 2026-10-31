// Deck-list text for pasting into a deck builder's import box. Shared by the
// browser app and the end-to-end test.
//
//   Moxfield:  1 Card Name (SET) 123        foil: 1 Card Name (SET) 123 *F*
//   Archidekt: 1x Card Name (set) 123       foil: 1x Card Name (set) 123 *F*
//
// (Archidekt's own text export is "1x Name (set) 123 *F*"; Moxfield's is
// "1 Name (SET) 123" with *F* for foil.) Double-faced cards keep their full
// "Front // Back" name, which both sites accept.
export const SITES = { moxfield: 'Moxfield', archidekt: 'Archidekt' };

export function cardLine(c, site = 'moxfield') {
  const set = site === 'archidekt' ? String(c.set).toLowerCase() : String(c.set).toUpperCase();
  return `${c.name} (${set}) ${c.number}${c.foil ? ' *F*' : ''}`;
}

export function listText(cards, site = 'moxfield') {
  const counts = new Map();
  for (const c of cards) {
    const line = cardLine(c, site);
    counts.set(line, (counts.get(line) || 0) + 1);
  }
  const qty = n => (site === 'archidekt' ? `${n}x` : `${n}`);
  return [...counts].map(([line, n]) => `${qty(n)} ${line}`).join('\n');
}
