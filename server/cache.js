// A small in-memory cache for answers that are slow to work out and change
// rarely: standings, player pages, season recaps, the set list. Every write
// the app makes ends in broadcast() (that's how phones learn something
// changed), and broadcast() clears this cache, so a cached answer is never
// older than the last change. Entries also expire after a TTL as a backstop.
const store = new Map();
const MAX_ENTRIES = 500;

export async function cached(key, ttlMs, compute) {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await compute();
  if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}
export function cachedSync(key, ttlMs, compute) {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = compute();
  if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}
export const clearCache = (prefix = '') => {
  if (!prefix) { store.clear(); return; }
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
};
