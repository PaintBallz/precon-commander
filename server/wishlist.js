// Wishlists: the cards a player wants, one list per league. Only the player
// sees their own. When anyone else in the league pulls a card on it, the
// player gets a ping (Discord, if they linked their ID) with a link that opens
// a trade offer for that card, and a toast on the site. The Wishlist page
// shows who has each card right now (worked out in the browser from the pools).
import { db } from './db.js';
import { cardKey, isMember } from './leagues.js';
import { findCard } from './scryfall.js';
import { wishCardsChanged, wishlistChanged } from './discord.js';

export const WISH_MAX = 100;

db.exec(`CREATE TABLE IF NOT EXISTS wishlist (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  image TEXT,
  uri TEXT,
  added_at TEXT NOT NULL,
  PRIMARY KEY (user_id, league_id, name_key)
);
CREATE INDEX IF NOT EXISTS wishlist_league ON wishlist(league_id, name_key);`);

const listOf = (userId, leagueId) => db.prepare('SELECT name, image, uri, added_at FROM wishlist WHERE user_id = ? AND league_id = ? ORDER BY name COLLATE NOCASE')
  .all(userId, leagueId).map(r => ({ name: r.name, image: r.image || null, uri: r.uri || null, addedAt: r.added_at }));

// Pack cards were just pulled: ping whoever has them on their wishlist.
export function wishPulled(leagueId, fromId, cards) {
  if (!leagueId || !cards?.length) return;
  const keys = [...new Set(cards.map(c => cardKey(c.name)))];
  const wanted = new Set(db.prepare(`SELECT DISTINCT name_key FROM wishlist WHERE league_id = ? AND user_id != ? AND name_key IN (${keys.map(() => '?').join(',')})`)
    .all(leagueId, fromId, ...keys).map(r => r.name_key));
  const ids = cards.filter(c => c.id != null && wanted.has(cardKey(c.name))).map(c => c.id);
  if (ids.length) wishCardsChanged(ids);
}

export function wishlistRoutes(app, { wrap, HttpError, viewLeague }) {
  const lookups = new Map();
  const myLeague = (req, { change = false } = {}) => {
    const l = viewLeague(req);
    if (!l || !isMember(l.id, req.user.id)) throw new HttpError(409, 'Join a league first: wishlists are kept per league.');
    if (change && l.status !== 'active') throw new HttpError(409, `${l.name} has ended.`);
    return l;
  };
  app.get('/api/wishlist', wrap(async (req, res) => {
    const l = viewLeague(req);
    if (!l || !isMember(l.id, req.user.id)) return res.json({ cards: [], max: WISH_MAX });
    res.json({ cards: listOf(req.user.id, l.id), max: WISH_MAX });
  }));
  // { cardId } adds a card seen in a league pool; { name } looks the card up on Scryfall.
  app.post('/api/wishlist', wrap(async (req, res) => {
    const l = myLeague(req, { change: true });
    const b = req.body || {};
    let card;
    if (b.cardId != null) {
      const r = db.prepare(`SELECT c.name, c.image, c.uri FROM pool_cards c JOIN pods p ON p.id = c.pod_id WHERE c.id = ? AND p.league_id = ?`).get(Number(b.cardId), l.id);
      if (!r) throw new HttpError(404, "That card isn't in this league's pools.");
      card = { name: r.name, image: r.image, uri: r.uri };
    } else {
      const name = String(b.name || '').trim().slice(0, 150);
      if (!name) throw new HttpError(400, 'Type a card name.');
      const recent = (lookups.get(req.user.id) || []).filter(t => Date.now() - t < 3600e3);
      if (recent.length >= 60) throw new HttpError(429, "That's a lot of lookups. Try again in an hour.");
      lookups.set(req.user.id, [...recent, Date.now()]);
      const found = await findCard(name).catch(() => { throw new HttpError(502, "Scryfall couldn't be reached. Try again in a moment."); });
      if (!found) throw new HttpError(404, `No single card matches "${name}". Try more of its name.`);
      card = found;
    }
    const key = cardKey(card.name);
    if (db.prepare('SELECT 1 FROM wishlist WHERE user_id = ? AND league_id = ? AND name_key = ?').get(req.user.id, l.id, key)) throw new HttpError(409, `${card.name} is already on your wishlist.`);
    if (db.prepare('SELECT COUNT(*) AS n FROM wishlist WHERE user_id = ? AND league_id = ?').get(req.user.id, l.id).n >= WISH_MAX) throw new HttpError(400, `Your wishlist holds up to ${WISH_MAX} cards.`);
    db.prepare('INSERT INTO wishlist (user_id, league_id, name, name_key, image, uri, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, l.id, card.name, key, card.image || null, card.uri || null, new Date().toISOString());
    res.json({ cards: listOf(req.user.id, l.id), added: card.name, max: WISH_MAX });
  }));
  app.delete('/api/wishlist', wrap(async (req, res) => {
    const l = myLeague(req);
    const name = String(req.query.name || req.body?.name || '');
    db.prepare('DELETE FROM wishlist WHERE user_id = ? AND league_id = ? AND name_key = ?').run(req.user.id, l.id, cardKey(name));
    wishlistChanged(req.user.id);
    res.json({ cards: listOf(req.user.id, l.id), max: WISH_MAX });
  }));
}
