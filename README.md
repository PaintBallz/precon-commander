# Pre-Con Commander

A web app for running a **Commander league** where everyone starts on a preconstructed deck
and earns booster packs by playing. Players join a **league**, play **pods** of 3–4, vote one
player a bonus pack, spin a wheel of every Magic set ever sold in boosters, and rip the packs
open. Every card they pull goes into their **pool**: the cards they may add to their precon.

Built for a group of friends at one table. Runs as a single Node process with SQLite, works on
phones, and every phone sees spins, votes and packs live.

## Features

- **Leagues** of 3–16 players. Anyone can start one (it can sweep in everyone who isn't in a
  league yet); others join with a 6-letter **invite code**. One league at a time per player.
- **Pods** of 3–4 league players, each on their precon. Several pods can run at once.
- **Bonus-pack vote**: when a pod ends, its players vote (never for themselves) to give one
  player an extra pack. Ballots are secret until everyone has voted, and a tie triggers a
  re-vote between just the tied players until one leads.
- **One spin per pod**: the winner spins a weighted wheel of every booster set. Every pack in
  the pod is that set: by default 3 for the winner and 2 for everyone else, plus the vote bonus.
- **Sacrifice a Pack**: give up one of your spun-set packs to make another one any set you like.
- **Missed a pod?** Every league member who wasn't in it gets 1 pack of the spun set too.
- **Booster opener**: rip-open animation, rares revealed last, card zoom with double-faced flip.
  170 sets, Alpha to today, use their real print sheets and slot odds; the few with no regular
  booster on record get a generated pack from Scryfall's booster cards (with era-correct slots).
  Never a Collector Booster, and no prices anywhere.
- **Fun Packs**: open a booster from any set just for fun. Nothing is saved (no pool, standings or
  feed), and each pack shows how it was built: real print-sheet slots and odds, or the generated
  layout for that era. Open 1, 3, 6, 12, 24 or 36 packs (a box) at once to test a set's sheets:
  multiple packs open face up, as card images or a compact list with each card's set number and
  slot.
  A **Stats** view compares the batch with the set's print sheets: rarity mix and most-pulled
  charts, each slot's rarity mix vs the sheet, every card's count vs its expected count (flagging
  ones that come up far too often or aren't on the sheets), and how much of each sheet was seen.
- **Pools**: each player's pulls in a league, grouped, searchable, filterable by pod.
- **Copy for Moxfield or Archidekt**: one-tap deck-list export in either site's import format,
  foils included (`1 Name (SET) 123 *F*` / `1x Name (set) 123 *F*`).
- **League tab**: standings, players, rules and an activity feed (winners, votes, spins, mythic
  pulls). Leagues can be ended into a read-only archive (seasons).
- **Player pages**: tap any name for that player's stats in one league or all of them: pods,
  wins, win streaks, bonus votes, packs, mythics and foils, their last results, precons played,
  rivals (their nemesis, who they beat most, a head-to-head table), sets opened, best pulls and
  recent pods. No prices or card values anywhere.
- **Season recap**: "Season so far" while a league runs, "Season recap" once it ends: the
  champion, league totals, awards (Most Wins, Sharpest Shooter, Hot Streak, Kingslayer, Iron
  Commander, Crowd Favourite, Pack Rat, Mythic Magnet, Foil Hunter, Sacrificial Lamb; ties
  share), top pulls, most-spun sets and final standings, plus **Copy for Discord**.
- **Deck lists**: each player can add the deck they play from a public Moxfield or Archidekt
  link, or a pasted list (Moxfield/Archidekt/MTGA export text). Cards are looked up on Scryfall
  once; the player page shows the commander, colour identity, mana curve, type counts and the
  list by type, with card zoom and Copy list.
- **Suggest a feature**: a footer button sends ideas and bug reports to the site admin's inbox.
  Players follow theirs on the Account page and see the admin's status (planned / done /
  declined) and reply.
- **Privacy and account controls**: a Privacy Policy (`/privacy`) and Terms of Use (`/terms`), a
  required "13 or older and I agree" box at sign-up, and **Delete account** on the Account page
  (the admin can delete accounts too). A deleted player's past pods stay in league history as
  "Deleted player". Fonts are self-hosted, so pages make no third-party requests except Scryfall images.
- **Accounts**: username + email + password sign-up, password change, reset by email
  (Cloudflare Email Sending or SMTP) or by an admin-made link.

## Roles

| Can… | Player | League admin | Site admin |
| --- | :---: | :---: | :---: |
| Start or join a league (by code), leave it | ✓ | ✓ | starts only |
| Play pods, vote, spin (as winner), open and sacrifice their own packs | ✓ | ✓ | — |
| Change their league's rules (pack counts, missed-pod packs, vote bonus) | | ✓ | ✓ |
| Kick players from their league | | ✓ | ✓ |
| Add players to a league, rename it, new invite code, end or delete it | | | ✓ |
| Edit a league's wheel (sets and odds) | | | ✓ |
| Adjust or delete packs, cards, pods and history; skip a stuck vote | | | ✓ |
| Make password-reset links | | | ✓ |
| Read and answer feature suggestions | | | ✓ |

The **league admin** is whoever started the league, for as long as they're in it. The **site
admin** is the built-in `admin` account; it manages everything but doesn't play, so it never
appears in player lists. A kicked player can't use the invite code to come back; only the site
admin can re-add them.

## Quick start

### Docker

```bash
docker build -t pre-con-commander .
docker run -d --name pre-con-commander -p 3000:3000 \
  -v "$PWD/data:/app/data" \
  -e PUBLIC_URL=http://localhost:3000 \
  pre-con-commander
```

Or with Compose:

```yaml
services:
  pre-con-commander:
    build: .
    restart: unless-stopped
    ports: ["127.0.0.1:3000:3000"]
    volumes: ["./data:/app/data"]
    environment:
      PUBLIC_URL: https://commander.example.com
```

### Without Docker

Node **22.13+** (it uses the built-in `node:sqlite`, so there's nothing native to compile):

```bash
npm ci
npm start            # http://localhost:3000
```

### First login

Open the site and log in as **`admin`** with the password **`changeme`**. You'll be made to
pick a new password before anything else, so do this before sharing the address. Then have your
players sign up, and one of them starts a league on the **League** tab.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `DATA_DIR` | `./data` | Where the SQLite database (`app.db`) lives. |
| `PUBLIC_URL` | `http://localhost:$PORT` | The site's public address, used in password-reset links. Set it in production. |
| `CF_EMAIL_ACCOUNT_ID`, `CF_EMAIL_TOKEN`, `MAIL_FROM` | unset | Password-reset emails through Cloudflare Email Sending (the token needs the Email Sending permission; `MAIL_FROM` must be on a domain with Email Sending enabled). Used first when set. |
| `SMTP_HOST`, `SMTP_PORT` (`587`), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | unset | Password-reset emails through any SMTP server. With neither option set, "Forgot password" tells players to ask the admin, who makes a reset link on the Account page. |
| `MAIL_FROM_NAME` | `Pre-Con Commander` | Sender name on reset emails. |
| `RATE_ALL_PER_MIN` | `600` | Requests per IP per minute, every URL (pages, scripts, fonts, API). |
| `RATE_API_PER_MIN` | `240` | Requests per IP per minute to `/api/*`. |
| `RATE_HEAVY_PER_MIN` | `30` | Per IP per minute for heavy calls: player pages, recaps, deck imports, fun packs, pack opening, sheet odds. |
| `RATE_STREAMS_PER_IP` | `8` | Live-update connections one IP may hold open. |
| `SCRYFALL_USER_AGENT` | `PreconCommander/1.0 (+repo URL)` | User-Agent for Scryfall API calls. Put your own contact or site in it. |
| `SCRYFALL_BASE` | `https://api.scryfall.com` | Scryfall API base URL (point it at a mock for testing). |

### Running behind a reverse proxy or tunnel

- Serve it over **HTTPS**; session cookies are marked `Secure` when the proxy says the request
  was HTTPS (`X-Forwarded-Proto`). Proxies on the same host or a private network are trusted.
- Live updates use Server-Sent Events (`/api/events`); make sure the proxy doesn't buffer them.
- The page links `app.js` and `styles.css` with a content hash (`?v=…`), so CDNs that cache
  scripts aggressively (Cloudflare does, for hours) never serve a stale script after an update.

## Data and backups

Everything is in one SQLite file, `data/app.db`:

| Table | One row per |
| --- | --- |
| `users`, `sessions`, `reset_tokens` | account, login, password-reset link |
| `leagues` | league: name, invite code, status, rules, wheel |
| `league_members` | player in a league (joined, left, kicked) |
| `league_events` | activity-feed entry |
| `pods` | pod: league, status, winner, its one spin, vote result |
| `pod_players` | player in a pod (`player`), or a league member who missed it (`absent`) |
| `pod_packs` | pack: spun or chosen set, sacrificed / chosen / opened |
| `pod_votes` | ballot in a pod's bonus-pack vote (round, voter, candidate) |
| `pool_cards` | opened card, tied to its pod, pack and player: pools are built from this |
| `booster_sets` | set referenced by a pack (name, symbol, release date) |
| `feedback` | feature idea or bug report: author, status, admin reply |

Deleting a pod or league cascades to everything in it. Back up while it's running with
`sqlite3 data/app.db ".backup app.db.bak"` (or Node's `VACUUM INTO`). Older databases are
migrated automatically on startup.

## How packs are built

- **Real booster data** for 170 sets, from Alpha to today (Play Booster, else Draft Booster,
  else the set's original booster, else Set Booster): print sheets, slot odds and pack layouts
  bundled in `packs/`. Collector, Jumpstart, prerelease and Arena boosters are never used.
- **The few sets with no regular booster on record** (Jumpstart, The List, some special
  printings) get a generated booster from Scryfall's booster cards: 10 commons, 3 uncommons,
  1 rare (1-in-8 mythic) and a basic land; before Shards of Alara, 11 commons and no land slot;
  from Urza's Legacy on, about 1 in 6 packs has a foil.
- **Adding sets:** `node scripts/import-mtgjson-boosters.mjs <set code> ...` downloads a set's
  booster sheets from MTGJSON and writes them to `packs/` (it never calls Scryfall).
- **The wheel** holds every released, non-digital expansion, core, masters and draft-innovation
  set with 40+ cards. Each league's wheel can filter by year and type, drop sets, or weight
  them (2 = twice as likely).
- Scryfall's set list is cached for a day and card pools for two weeks, in the database.

## Tests

An end-to-end suite plays a full league season against live Scryfall, on its own port with a
throwaway database. It covers accounts, leagues, invite codes, roles, pods, votes and ties,
spins, missed-pod packs, real and generated boosters, pools, exports, admin tools and ending a
league:

```bash
npm run e2e                                   # locally
docker exec pre-con-commander npm run e2e     # inside the running container
```

## Project layout

```
server/
  index.js     API, pod and league rules, live updates (SSE)
  leagues.js   leagues, members, invite codes, activity feed
  auth.js      accounts, sessions, password resets, rate limits
  db.js        SQLite schema and pod storage
  packs.js     booster generation
  scryfall.js  rate-limited, cached Scryfall client
  feedback.js  feature suggestions and the admin inbox
  mail.js      optional reset emails (Cloudflare Email Sending or SMTP)
  stats.js     player pages and season recaps
  cache.js     in-memory cache, cleared on every change
  ratelimit.js per-IP request limits
  decks.js     deck-list import (Moxfield, Archidekt, pasted text)
public/        the app: plain ES modules, no build step
packs/         real booster print-sheet data (see packs/NOTICE.md)
scripts/       import-mtgjson-boosters.mjs: add sets' sheets from MTGJSON
test/          end-to-end suite
```

## Performance and limits

- **Indexes** on every column the app filters or sorts by (pods by league/status/finish time,
  packs by player, cards by pod, sessions and reset links by user and expiry, feedback by status…).
  The e2e suite checks the query plans so a new query can't silently scan a table.
- **Caching**: standings, player pages, season recaps and the booster-set list are kept in memory
  and cleared on every change (the same moment phones get a live update). Versioned scripts and
  fonts are cached for a year (`immutable`), images for a week, the legal pages for 10 minutes;
  the page itself is never cached, so a deploy shows up at once. Scryfall card data, set pools and
  print-sheet odds are cached in SQLite.
- **Images**: card art comes from Scryfall's CDN, which offers ready-made sizes. Every card image
  has a `srcset` with the 146px "small" (~15 KB) and 488px "normal" (~100 KB) versions, so
  thumbnails download the small one. Text responses are brotli-compressed by Cloudflare.
  (Cloudflare's free image transformations stop at 5,000 unique images a month and then fail
  for third-party images, which a league's card pool would hit quickly, so they aren't used.)
- **Rate limits** per IP per minute on every request, tighter on `/api` and tighter again on heavy
  calls (see Configuration); 429 answers carry `Retry-After`, API answers `RateLimit-*` headers.
  Login, sign-up, resets, feedback, deck imports and fun packs keep their own limits on top.

## Security notes

- Passwords are hashed with scrypt; sessions are random tokens in `HttpOnly`, `SameSite=Lax`
  cookies; the API only accepts JSON, which blocks cross-site form posts.
- Logins, password-reset requests and sign-ups are rate-limited per IP.
- Password-reset links expire after an hour, work once, and sign out the account's other
  sessions. Reset links always use `PUBLIC_URL`, never the request's Host header.
- The default admin password must be changed on first login.

## Credits and legal

Pre-Con Commander is unofficial Fan Content permitted under the
[Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy). Not
approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the
Coast. ©Wizards of the Coast LLC.

Card data and images come from [Scryfall](https://scryfall.com) (not affiliated). Please follow
the [Scryfall API guidelines](https://scryfall.com/docs/api) if you run your own copy. The
real-booster print sheets come from
[MTGJSON](https://mtgjson.com) (MIT License, Copyright © 2018-Present Zachary Halpern; see
`packs/NOTICE.md`).

Released under the [MIT License](LICENSE).
