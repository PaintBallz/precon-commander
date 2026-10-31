# Pre-Con Commander

Commander league companion. Players have accounts and belong to a **league** (3–16 players,
one league at a time). Each league plays **pods**: games of 3–4 of its players, each on a
precon. When a pod ends, the winner gets **3 packs**, everyone else gets **2**, the pod votes
someone a **+1 bonus pack**, and the winner spins a wheel of every Magic set that was sold in
boosters **once**: every pack is that set. League members who **missed** the pod get **1 pack**
of the spun set too. Every opened card goes into the player's **pool** for that league, the
cards they may use on top of their precon.

Live at **https://precon-commander.paintballz.us** (docker-sites stack, Cloudflare Tunnel).
Local: http://127.0.0.1:8101

## Leagues

- **League tab**: any player who isn't in a league can start one. By default it sweeps in
  every player who isn't in a league yet (up to 16). Others join with the league's 6-letter
  **invite code**, or the admin adds them. Players can leave between pods.
- Shows the league's **standings** (pods, wins, win %, bonus votes won, pods missed, packs,
  rares, mythics), **players**, **rules** and an **activity feed** (pods, winners, votes,
  spins, mythic pulls, joins).
- **Per-league rules** (admin): winner packs, everyone-else packs, packs for a missed pod,
  vote bonus (0 turns absent packs or the vote off). A pod keeps the rules it started with.
- **Per-league wheel** (admin, All Sets tab): each league has its own set list and odds.
- **Seasons**: the admin can **end** a league. It becomes a read-only archive (standings,
  history, pools) and its players can join or start another. The admin can also delete a
  league with everything in it.
- A header picker switches between leagues (the admin's view, or your past leagues).

## How a pod works

1. **Log in / sign up**: username, email (for password recovery) and a password of at least
   8 characters with a letter and a number. Set your precon on the **Account** page.
2. **Pods tab**: start a pod with 3 to 4 players from your league, then crown the winner when
   the game ends. Several pods can run at once.
3. **Bonus-pack vote** (Pods tab): every player votes for someone else (never themselves) to
   get **+1 pack**. Ballots are secret until everyone has voted. If the most votes are tied,
   everyone re-votes between just the tied players, until one player has the most. Only the
   pod's players vote (not the rest of the league). The admin can skip a stuck vote.
4. **Wheel tab**: once the vote is decided, the winner spins once for the whole pod. Every phone
   watches the spin live. Every league member who isn't in the pod gets 1 pack of the spun
   set; the Pods tab shows them a "packs waiting for you" list, and those packs can be opened
   even after the pod is finished.
5. Each player then either **opens** their packs of the spun set (its regular booster, never
   a Collector Booster) or uses **Sacrifice a Pack**: give up one spun-set pack to make
   another pack any set they choose (on **All Sets**).
6. **Packs tab**: rip packs open, then **Copy pack list** or **Copy all pulls**. A
   **Copy for: Moxfield | Archidekt** switch (remembered per device) picks the import format:
   - Moxfield: `1 Card Name (SET) 123`, foils `1 Card Name (SET) 123 *F*`
   - Archidekt: `1x Card Name (set) 123`, foils `1x Card Name (set) 123 *F*`

   Double-faced cards keep their full `Front // Back` name. The same switch is on Pools and
   History.
7. **Finish pod** saves it to **History** (standings, packs, pulls).

**Pools tab**: each player's cards from every running or finished pod (discarded pods don't
count), grouped with counts, searchable, and copyable as one deck list.

**Admin delete** (all permanent):
- **A pod** (running, finished or discarded) from the Pods tab or History; its packs, pulls
  and pool cards go with it.
- **The whole league history**: History → *Clear league history* (type `DELETE` to confirm)
  removes every finished and discarded pod; running pods stay.
- **One pack**: *Delete pack* in the Packs tab, or ✕ on a pack in History or Pools; its pulls
  leave the player's pool.
- **One pulled card**: open the card and choose *Remove*; that single copy leaves the pool.

**All Sets tab**: every booster set and its chance on the wheel. Only the admin can turn
sets on or off, change their weights (2 = twice as likely) or change the year/type filters.

## Accounts

- On first start the app creates an **admin** account with the password `changeme`, which
  must be changed on first login.
- Players change their password on the Account page. Forgotten passwords: with SMTP
  configured (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`) the app emails
  a one-hour reset link; without it, the admin creates a reset link on the Account page.
- The admin can also add or remove packs for a player in a pod.

## Packs

- 27 sets use real print-sheet booster data copied from mtg-pack-opener
  (Play Booster > Draft Booster > Set Booster; Collector Boosters are excluded).
- Every other set gets a generated booster from Scryfall's booster cards:
  10 commons + 3 uncommons + 1 rare (1-in-8 mythic) + basic land
  (pre-Shards of Alara: 11 commons, no land slot), with a ~1-in-6 foil from Urza's Legacy on.
- Set list and card pools come from Scryfall and are cached in `data/app.db`
  (set list refreshes daily, card pools every two weeks).

## Data

Everything is saved in SQLite at `data/app.db`. League data lives in tables:

| Table | One row per |
| --- | --- |
| `pods` | pod: status, winner, the pod's one spin |
| `pod_players` | player in a pod (role `player`), or a league member who missed it (role `absent`) |
| `pod_packs` | pack: spun or chosen set, sacrificed / chosen / opened |
| `pool_cards` | opened card, tied to its pod, pack and player (pools are built from this) |
| `booster_sets` | set referenced by a pack (name, symbol, release date) |
| `leagues` | league: name, invite code, status, rules, wheel |
| `league_members` | player in a league (joined / left) |
| `league_events` | the league's activity feed |
| `pod_votes` | ballot in a pod's bonus-pack vote (round, voter, candidate) |
| `users`, `sessions`, `reset_tokens` | accounts and logins |

Deleting a pod cascades to its players, packs and pool cards. Databases from before the
tables existed are migrated on startup, and the old JSON rows are kept in `pods_legacy_json`.

## Running

    docker build -t pre-con-commander .
    docker run -d -p 127.0.0.1:8101:3000 -v ./data:/app/data pre-con-commander

Dev without Docker (Node 22.13+): `npm install && npm start` → http://localhost:3000

## End-to-end test (runs inside the container)

    docker compose exec pre-con-commander npm run e2e          # site already running
    docker compose run --rm pre-con-commander npm run e2e      # or a one-off container

The test starts its own copy of the server on port 3999 with a throwaway database in
/tmp, so real accounts, pods, history and wheel settings are never touched. It plays a full
league night against live Scryfall: admin first login (forced password change) → sign-ups
and password rules → admin reset link → admin-only wheel settings → pod of 4 → crown winner
(3/2/2/2) → the pod's one spin (and the live-sync event a second phone would get) → open a
real-data booster → Sacrifice a Pack → choose sets → generated Alpha (11C/3U/1R, no land)
and Magic 2010 (land slot) boosters → pools → deck-list copy format → finish → History →
wheel weights/exclusions/year filter (120 throwaway pods). Takes under a minute; it fails
loudly if Scryfall can't be reached from the container.

Env: `PORT` (3000), `DATA_DIR` (./data), `PUBLIC_URL` (for reset links), the SMTP settings
above, `SCRYFALL_BASE` (override for testing).
