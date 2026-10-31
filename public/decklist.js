// Deck-list text in the Moxfield / Archidekt import format: "1 Card Name (SET) 123".
// Shared by the browser app and the end-to-end test.
export const cardLine = c => `${c.name} (${String(c.set).toUpperCase()}) ${c.number}`;

export function listText(cards) {
  const counts = new Map();
  for (const c of cards) {
    const line = cardLine(c);
    counts.set(line, (counts.get(line) || 0) + 1);
  }
  return [...counts].map(([line, n]) => `${n} ${line}`).join('\n');
}
