// Trades between two members of the same league.
//
// A trade is a thread of offers. Each offer is one-way: its sender gives some
// of their pool cards and asks for some of the other player's, and it waits
// until the other player answers, so nobody has to be online at the same time.
// The player whose turn it is can accept, decline, or counter (send back a new
// offer with different or more cards); the sender can cancel while waiting.
// Any number of cards per side, as long as the offer has at least one card.
//
//   trades        the thread: league, the two players, status, whose turn
//   trade_offers  every round, with a snapshot of its cards (so History still
//                 shows them after they've moved)
//
// Accepting moves the cards right away, through the league's "Admin packs"
// container as packs of kind 'trade' (like the admin's "Move to…"), so they
// show in pools but never count as packs opened. Cards you're giving in an
// offer that's waiting on the other player are held: they can't go into a
// second offer until that one is answered or cancelled. When a trade goes
// through, any other open trade that included one of its cards is closed.
import crypto from 'node:crypto';
import { db, grantsPod, savePod, setInfoFor } from './db.js';
import { getLeague, isMember, logEvent, activeLeagueOf } from './leagues.js';
import { getUser } from './auth.js';
import { tradePost } from './discord.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    a_id TEXT NOT NULL,
    b_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'declined', 'cancelled', 'closed')),
    turn_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT,
    closed_by TEXT,
    close_note TEXT
  );
  CREATE INDEX IF NOT EXISTS trades_a ON trades(a_id, status);
  CREATE INDEX IF NOT EXISTS trades_b ON trades(b_id, status);
  CREATE INDEX IF NOT EXISTS trades_league ON trades(league_id, status);
  CREATE TABLE IF NOT EXISTS trade_offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id TEXT NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    cards TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS trade_offers_trade ON trade_offers(trade_id, round);
`);

export const MAX_SIDE = 30; // cards per side of one offer
export const MAX_OPEN = 20; // open trades a player can be part of
const now = () => new Date().toISOString();
const newId = () => crypto.randomBytes(9).toString('base64url');
const nameOf = id => getUser(id)?.username || 'Deleted player';
const listNames = list => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);
const cardList = cards => {
  const names = cards.map(c => c.name);
  return names.length > 4 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : listNames(names);
};

// Pool cards that count in a league (running or finished pods), by id.
function leagueCards(ids, leagueId) {
  if (!ids.length) return new Map();
  const rows = db.prepare(`
    SELECT c.* FROM pool_cards c JOIN pods p ON p.id = c.pod_id
    WHERE c.id IN (${ids.map(() => '?').join(',')}) AND p.league_id = ? AND p.status IN ('playing', 'awarded', 'done')`).all(...ids, leagueId);
  return new Map(rows.map(r => [r.id, r]));
}
const snap = (r, side) => ({ id: r.id, side, owner: r.user_id, name: r.name, set: r.set_code, number: r.number, rarity: r.rarity,
  type: r.type || '', foil: !!r.foil, image: r.image, back: r.back || null, uri: r.uri });

const offersOf = tradeId => db.prepare('SELECT * FROM trade_offers WHERE trade_id = ? ORDER BY round').all(tradeId)
  .map(o => ({ round: o.round, fromId: o.from_id, toId: o.to_id, note: o.note, at: o.created_at, cards: JSON.parse(o.cards) }));
const lastOffer = tradeId => {
  const o = db.prepare('SELECT * FROM trade_offers WHERE trade_id = ? ORDER BY round DESC LIMIT 1').get(tradeId);
  return o && { round: o.round, fromId: o.from_id, toId: o.to_id, cards: JSON.parse(o.cards) };
};
const getTrade = id => db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
const openTradesOf = userId => db.prepare("SELECT * FROM trades WHERE status = 'open' AND (a_id = ? OR b_id = ?)").all(userId, userId);

function close(t, status, by, note = '') {
  db.prepare('UPDATE trades SET status = ?, turn_id = NULL, updated_at = ?, closed_at = ?, closed_by = ?, close_note = ? WHERE id = ?')
    .run(status, now(), now(), by || null, note, t.id);
}

// Open trades that can't go ahead any more (the league ended, or a player
// left it or deleted their account) are closed when anyone looks at them.
function sweep(userId) {
  for (const t of openTradesOf(userId)) {
    const l = getLeague(t.league_id);
    const gone = [t.a_id, t.b_id].find(id => !getUser(id) || !isMember(t.league_id, id));
    if (!l || l.status !== 'active') close(t, 'closed', null, 'The league ended.');
    else if (gone) close(t, 'closed', null, `${nameOf(gone)} left the league.`);
  }
}

// Card ids I'm giving in offers that are waiting on the other player.
export function heldCards(userId, exceptTradeId = null) {
  const held = new Set();
  for (const t of openTradesOf(userId)) {
    if (t.id === exceptTradeId || t.turn_id === userId) continue;
    for (const c of lastOffer(t.id)?.cards || []) if (c.side === 'give' && c.owner === userId) held.add(c.id);
  }
  return held;
}

// Build an offer's card list from ids, checking every card is where it should be.
function offerCards(leagueId, fromId, toId, giveIds, getIds, HttpError, exceptTradeId) {
  const clean = v => [...new Set((Array.isArray(v) ? v : []).map(Number).filter(Number.isInteger))];
  const give = clean(giveIds), get = clean(getIds);
  if (!give.length && !get.length) throw new HttpError(400, 'Pick at least one card.');
  if (give.length > MAX_SIDE || get.length > MAX_SIDE) throw new HttpError(400, `An offer can have up to ${MAX_SIDE} cards on each side.`);
  const found = leagueCards([...give, ...get], leagueId);
  const held = heldCards(fromId, exceptTradeId);
  const out = [];
  for (const id of give) {
    const r = found.get(id);
    if (!r || r.user_id !== fromId) throw new HttpError(409, 'One of the cards you picked isn\'t in your pool any more. Reload and try again.');
    if (held.has(id)) throw new HttpError(409, `${r.name} is already in another offer you sent. Cancel that one first, or wait for an answer.`);
    out.push(snap(r, 'give'));
  }
  for (const id of get) {
    const r = found.get(id);
    if (!r || r.user_id !== toId) throw new HttpError(409, `One of the cards you asked for isn't in ${nameOf(toId)}'s pool any more. Reload and try again.`);
    out.push(snap(r, 'get'));
  }
  return out;
}

// What a player sees: each trade from their side.
function viewTrade(t, me) {
  const offers = offersOf(t.id);
  const otherId = t.a_id === me ? t.b_id : t.a_id;
  const cur = offers.at(-1);
  let missing = [];
  if (t.status === 'open' && cur) {
    const found = leagueCards(cur.cards.map(c => c.id), t.league_id);
    missing = cur.cards.filter(c => found.get(c.id)?.user_id !== c.owner).map(c => c.id);
  }
  return {
    id: t.id, leagueId: t.league_id, status: t.status, startedBy: t.a_id,
    other: { id: otherId, name: nameOf(otherId) },
    turn: t.status !== 'open' ? null : t.turn_id === me ? 'me' : 'them',
    createdAt: t.created_at, updatedAt: t.updated_at, closedAt: t.closed_at, closedBy: t.closed_by, closeNote: t.close_note || '',
    offers: offers.map(o => ({ ...o, fromName: nameOf(o.fromId), mine: o.fromId === me })),
    missing,
  };
}

export function tradesWaiting(userId) {
  const league = activeLeagueOf(userId);
  if (!league) return 0;
  return db.prepare("SELECT COUNT(*) AS n FROM trades WHERE status = 'open' AND turn_id = ? AND league_id = ?").get(userId, league.id).n;
}

// Close every open trade in a league (it ended or was deleted).
export function closeLeagueTrades(leagueId, note) {
  for (const t of db.prepare("SELECT * FROM trades WHERE status = 'open' AND league_id = ?").all(leagueId)) close(t, 'closed', null, note);
}

// Move the accepted cards: one 'trade' pack per receiving player in the
// league's "Admin packs" container, holding every card they got.
function moveCards(leagueId, cards, toId, fromId) {
  if (!cards.length) return;
  const pod = grantsPod(leagueId, { create: true });
  const to = getUser(toId);
  let who = pod.absentees.find(a => a.id === toId);
  if (!who) { who = { id: toId, name: to.username, grant: true, packs: [] }; pod.absentees.push(who); }
  const pack = { id: newId(), status: 'opened', source: 'wheel',
    set: setInfoFor(cards[0].set), wheelSet: null, cards: [], openedAt: now(), kind: 'trade', note: `Traded with ${nameOf(fromId)}`, grantedBy: null };
  who.packs.push(pack);
  pod.updatedAt = now();
  savePod(pod);
  const move = db.prepare('UPDATE pool_cards SET pod_id = ?, pack_id = ?, user_id = ?, seq = ? WHERE id = ?');
  cards.forEach((c, i) => move.run(pod.id, pack.id, toId, i, c.id));
}

export function tradeRoutes(app, { wrap, HttpError, broadcast, viewLeague }) {
  const changed = (t, extra = {}) => broadcast('state', { leagueId: t.league_id, trade: { id: t.id, ...extra } });
  const mustBeIn = (t, me) => {
    if (!t || (t.a_id !== me && t.b_id !== me)) throw new HttpError(404, 'Trade not found');
    if (t.status !== 'open') throw new HttpError(409, 'That trade is already finished.');
  };
  const mustTrade = (req, leagueId) => {
    if (req.user.adminAccount) throw new HttpError(403, 'Only league members can trade.');
    const l = getLeague(leagueId);
    if (!l || l.status !== 'active') throw new HttpError(409, 'Trading is only open in an active league.');
    if (!isMember(l.id, req.user.id)) throw new HttpError(403, `You're not in ${l.name}.`);
    return l;
  };
  const noteOf = b => String(b?.note || '').trim().slice(0, 200);

  // My trades in the league on screen, plus which of my cards are held.
  app.get('/api/trades', wrap(async (req, res) => {
    const me = req.user.id;
    const league = viewLeague(req);
    if (!league) return res.json({ leagueId: null, canTrade: false, trades: [], held: [] });
    sweep(me);
    const rows = db.prepare('SELECT * FROM trades WHERE league_id = ? AND (a_id = ? OR b_id = ?) ORDER BY updated_at DESC').all(league.id, me, me);
    res.json({
      leagueId: league.id,
      canTrade: !req.user.adminAccount && league.status === 'active' && isMember(league.id, me),
      trades: rows.map(t => viewTrade(t, me)),
      held: [...heldCards(me)],
      limits: { side: MAX_SIDE, open: MAX_OPEN },
    });
  }));

  // Start a trade: { to, give: [cardId], get: [cardId], note }
  app.post('/api/trades', wrap(async (req, res) => {
    const me = req.user.id, b = req.body || {};
    const league = mustTrade(req, String(b.league || activeLeagueOf(me)?.id || ''));
    const to = getUser(String(b.to || ''));
    if (!to || to.is_admin || !isMember(league.id, to.id)) throw new HttpError(400, `Pick a player in ${league.name}.`);
    if (to.id === me) throw new HttpError(400, 'Pick someone else to trade with.');
    sweep(me);
    if (openTradesOf(me).length >= MAX_OPEN) throw new HttpError(429, `You have ${MAX_OPEN} open trades. Finish or cancel some first.`);
    const cards = offerCards(league.id, me, to.id, b.give, b.get, HttpError, null);
    const t = { id: newId(), league_id: league.id };
    const at = now();
    db.prepare("INSERT INTO trades (id, league_id, a_id, b_id, status, turn_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)")
      .run(t.id, league.id, me, to.id, to.id, at, at);
    db.prepare('INSERT INTO trade_offers (trade_id, round, from_id, to_id, note, cards, created_at) VALUES (?, 1, ?, ?, ?, ?, ?)')
      .run(t.id, me, to.id, noteOf(b), JSON.stringify(cards), at);
    changed(t, { to: to.id, from: me, kind: 'offer' });
    res.json({ trade: viewTrade(getTrade(t.id), me) });
  }));

  // Counter: the player whose turn it is sends back a new offer.
  app.post('/api/trades/:id/counter', wrap(async (req, res) => {
    const me = req.user.id, b = req.body || {};
    const t = getTrade(req.params.id);
    mustBeIn(t, me);
    mustTrade(req, t.league_id);
    if (t.turn_id !== me) throw new HttpError(409, `It's ${nameOf(t.turn_id)}'s turn to answer.`);
    const other = t.a_id === me ? t.b_id : t.a_id;
    if (!isMember(t.league_id, other)) throw new HttpError(409, `${nameOf(other)} isn't in the league any more.`);
    const cards = offerCards(t.league_id, me, other, b.give, b.get, HttpError, t.id);
    const round = (lastOffer(t.id)?.round || 0) + 1;
    const at = now();
    db.prepare('INSERT INTO trade_offers (trade_id, round, from_id, to_id, note, cards, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, round, me, other, noteOf(b), JSON.stringify(cards), at);
    db.prepare('UPDATE trades SET turn_id = ?, updated_at = ? WHERE id = ?').run(other, at, t.id);
    changed(t, { to: other, from: me, kind: 'counter' });
    res.json({ trade: viewTrade(getTrade(t.id), me) });
  }));

  // Accept: the cards change pools now. Everything below is synchronous, so
  // no other request can move a card between the checks and the move.
  app.post('/api/trades/:id/accept', wrap(async (req, res) => {
    const me = req.user.id;
    const t = getTrade(req.params.id);
    mustBeIn(t, me);
    const league = mustTrade(req, t.league_id);
    if (t.turn_id !== me) throw new HttpError(409, `Waiting on ${nameOf(t.turn_id)} to answer.`);
    const offer = lastOffer(t.id);
    const sender = offer.fromId;
    if (!isMember(league.id, sender)) throw new HttpError(409, `${nameOf(sender)} isn't in the league any more.`);
    const found = leagueCards(offer.cards.map(c => c.id), league.id);
    const gone = offer.cards.filter(c => found.get(c.id)?.user_id !== c.owner);
    if (gone.length) throw new HttpError(409, `${cardList(gone)} ${gone.length === 1 ? 'isn\'t' : 'aren\'t'} where ${gone.length === 1 ? 'it was' : 'they were'} any more, so this offer can't go through. Counter or decline it.`);
    const give = offer.cards.filter(c => c.side === 'give'); // sender → me
    const get = offer.cards.filter(c => c.side === 'get'); // me → sender
    moveCards(league.id, give, me, sender);
    moveCards(league.id, get, sender, me);
    close(t, 'accepted', me);
    // Other open trades that included any of these cards can't happen now.
    const moved = new Set(offer.cards.map(c => c.id));
    const others = db.prepare("SELECT * FROM trades WHERE status = 'open' AND league_id = ? AND id != ?").all(league.id, t.id);
    for (const o of others) {
      if ((lastOffer(o.id)?.cards || []).some(c => moved.has(c.id))) { close(o, 'closed', null, 'A card in it was traded away.'); changed(o, { kind: 'closed' }); }
    }
    const sName = nameOf(sender), mName = nameOf(me);
    const text = !give.length ? `${mName} gave ${cardList(get)} to ${sName}.`
      : !get.length ? `${sName} gave ${cardList(give)} to ${mName}.`
      : `${sName} traded ${cardList(give)} to ${mName} for ${cardList(get)}.`;
    logEvent(league.id, 'trade', me, text);
    tradePost(text, league.name).catch(() => {});
    changed(t, { to: sender, from: me, kind: 'accepted' });
    res.json({ trade: viewTrade(getTrade(t.id), me) });
  }));

  app.post('/api/trades/:id/decline', wrap(async (req, res) => {
    const me = req.user.id;
    const t = getTrade(req.params.id);
    mustBeIn(t, me);
    if (t.turn_id !== me) throw new HttpError(409, 'You can cancel an offer you sent, not decline it.');
    close(t, 'declined', me, noteOf(req.body));
    const other = t.a_id === me ? t.b_id : t.a_id;
    changed(t, { to: other, from: me, kind: 'declined' });
    res.json({ trade: viewTrade(getTrade(t.id), me) });
  }));

  app.post('/api/trades/:id/cancel', wrap(async (req, res) => {
    const me = req.user.id;
    const t = getTrade(req.params.id);
    mustBeIn(t, me);
    if (t.turn_id === me) throw new HttpError(409, 'It\'s your turn: decline the offer instead.');
    close(t, 'cancelled', me);
    const other = t.a_id === me ? t.b_id : t.a_id;
    changed(t, { to: other, from: me, kind: 'cancelled' });
    res.json({ trade: viewTrade(getTrade(t.id), me) });
  }));
}
