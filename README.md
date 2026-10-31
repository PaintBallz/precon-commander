# Pre-Con Commander

Commander league companion. Everyone in the league has an account and starts with one
precon. Games are **pods** of 2 to 4 players. When a pod ends, the winner gets **3 packs**
and everyone else gets **2**, and the winner spins a wheel of every Magic set that was sold
in boosters **once**: every pack in the pod is that set. Every opened card goes into the
player's **pool**, the cards they may use on top of their precon.

Live at **https://precon-commander.paintballz.us** (docker-sites stack, Cloudflare Tunnel).
Local: http://127.0.0.1:8101

## How a pod works

1. **Log in / sign up**: username, email (for password recovery) and a password of at least
   8 characters with a letter and a number. Set your precon on the **Account** page.
2. **Pods tab**: start a pod with 2 to 4 league members, then crown the winner when the game
   ends. Several pods can run at once.
3. **Wheel tab**: the winner spins once for the whole pod. Every phone watches the spin live.
4. Each player then either **opens** their packs of the spun set (its regular booster, never
   a Collector Booster) or uses **Sacrifice a Pack**: give up one spun-set pack to make
   another pack any set they choose (on **All Sets**).
5. **Packs tab**: rip packs open, then **Copy pack list** or **Copy all pulls**. Lists use
   the Moxfield/Archidekt format: `1 Card Name (SET) 123`.
6. **Finish pod** saves it to **History** (standings, packs, pulls).

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
| `pod_players` | player in a pod: precon, packs awarded, packs sacrificed |
| `pod_packs` | pack: spun or chosen set, sacrificed / chosen / opened |
| `pool_cards` | opened card, tied to its pod, pack and player (pools are built from this) |
| `booster_sets` | set referenced by a pack (name, symbol, release date) |
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
