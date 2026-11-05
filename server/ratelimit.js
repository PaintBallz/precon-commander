// Per-IP request limits, counted per minute (fixed one-minute windows).
//
//   every request (pages, scripts, fonts, API)    RATE_ALL_PER_MIN    default 600
//   /api/*                                         RATE_API_PER_MIN    default 240
//   heavy endpoints (Scryfall lookups, stats)      RATE_HEAVY_PER_MIN  default 30
//   live-update streams (/api/events) open at once RATE_STREAMS_PER_IP default 8
//
// A page load is ~10 requests and a busy pod night a few API calls a second at
// most, so real players never get near these; a script hammering the site
// gets 429 Too Many Requests with a Retry-After header. Login, sign-up,
// password reset, feedback, deck imports and fun packs keep their own,
// stricter limits on top (see auth.js, feedback.js and index.js).
//
// The client IP comes from Cloudflare's CF-Connecting-IP header, trusted only
// when the request arrives from the local tunnel (a private address); anything
// else is counted by its socket address.
const PRIVATE_PEER = /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^::1$|^f[cd]/i;
export const clientIp = req => (PRIVATE_PEER.test(req.socket.remoteAddress || '') && req.get('cf-connecting-ip')) || req.ip || 'unknown';

const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
export const LIMITS = {
  all: num(process.env.RATE_ALL_PER_MIN, 600),
  api: num(process.env.RATE_API_PER_MIN, 240),
  heavy: num(process.env.RATE_HEAVY_PER_MIN, 30),
  streams: num(process.env.RATE_STREAMS_PER_IP, 8),
};
// Endpoints that call Scryfall, Moxfield/Archidekt or crunch a whole league.
const HEAVY = [
  ['GET', /^\/api\/players\/[^/]+$/], ['GET', /^\/api\/leagues\/[^/]+\/recap$/], ['GET', /^\/api\/fun\/odds\//],
  ['POST', /^\/api\/deck$/], ['PUT', /^\/api\/deck$/], ['POST', /^\/api\/fun\/open$/],
  ['POST', /^\/api\/pods\/[^/]+\/packs\/[^/]+\/open$/],
];
const isHeavy = req => HEAVY.some(([m, re]) => m === req.method && re.test(req.path));

const WINDOW_MS = 60e3;
const counters = new Map(); // "tier|ip" -> { count, resetAt }
function hit(tier, ip, limit) {
  const key = `${tier}|${ip}`;
  const t = Date.now();
  let c = counters.get(key);
  if (!c || c.resetAt <= t) { c = { count: 0, resetAt: t + WINDOW_MS }; counters.set(key, c); }
  c.count++;
  return { ok: c.count <= limit, limit, remaining: Math.max(0, limit - c.count), resetIn: Math.ceil((c.resetAt - t) / 1000) };
}
// Forget finished windows so the map can't grow without bound.
setInterval(() => { const t = Date.now(); for (const [k, c] of counters) if (c.resetAt <= t) counters.delete(k); }, WINDOW_MS).unref();

function refuse(res, r, what) {
  res.set('Retry-After', String(r.resetIn));
  res.status(429).json({ error: `Too many ${what} from your connection (limit ${r.limit} a minute). Wait ${r.resetIn} seconds and try again.` });
}

export function rateLimit(req, res, next) {
  const ip = clientIp(req);
  const all = hit('all', ip, LIMITS.all);
  if (!all.ok) return refuse(res, all, 'requests');
  if (req.path.startsWith('/api/')) {
    const api = hit('api', ip, LIMITS.api);
    res.set({ 'RateLimit-Limit': String(api.limit), 'RateLimit-Remaining': String(api.remaining), 'RateLimit-Reset': String(api.resetIn) });
    if (!api.ok) return refuse(res, api, 'requests');
    if (isHeavy(req)) {
      const heavy = hit('heavy', ip, LIMITS.heavy);
      if (!heavy.ok) return refuse(res, heavy, 'card or stats lookups');
    }
  }
  next();
}

// Live-update streams stay open, so they're limited by how many one IP holds.
const streams = new Map();
export function streamSlot(req) {
  const ip = clientIp(req);
  const n = streams.get(ip) || 0;
  if (n >= LIMITS.streams) return null;
  streams.set(ip, n + 1);
  return () => { const left = (streams.get(ip) || 1) - 1; if (left > 0) streams.set(ip, left); else streams.delete(ip); };
}
