# Pre-Con Commander

Commander game-night companion: four players each start with one precon. When the
game ends, the winner gets **3 packs** and everyone else gets **2**. Each pack is
spun from a wheel of every Magic set that was sold in boosters.

Live at **https://precon-commander.paintballz.us** (docker-sites stack, Cloudflare Tunnel).
Local: http://127.0.0.1:8101

## How a game night works

1. **Game tab**: enter the players (and their precons), then crown the winner when the game ends.
2. **Wheel tab**: spin for each pack. Every phone on the site watches the same spin live.
   - **Open Booster** goes straight to that set's regular booster (never a Collector Booster).
   - **Sacrifice a Pack** gives up this spin *plus one more* of your remaining packs, then
     opens **All Sets** so you can pick any set you want.
3. **Packs tab**: rip packs open, then **Copy pack list** or **Copy all pulls**. Lists use
   the Moxfield/Archidekt format: `1 Card Name (SET) 123`.
4. **Finish game night** saves everything to **History** (standings, packs, pulls).

**All Sets tab**: turn sets on or off the wheel and give each set a weight (2 = twice as
likely). Year range and set-type filters are under *Wheel settings* on the Wheel tab.

## Packs

- 27 sets use real print-sheet booster data copied from mtg-pack-opener
  (Play Booster > Draft Booster > Set Booster; Collector Boosters are excluded).
- Every other set gets a generated booster from Scryfall's booster cards:
  10 commons + 3 uncommons + 1 rare (1-in-8 mythic) + basic land
  (pre-Shards of Alara: 11 commons, no land slot), with a ~1-in-6 foil from Urza's Legacy on.
- Set list and card pools come from Scryfall and are cached in `data/app.db`
  (set list refreshes daily, card pools every two weeks).

## Running

    docker build -t pre-con-commander .
    docker run -d -p 127.0.0.1:8101:3000 -v ./data:/app/data pre-con-commander

Dev without Docker (Node 22.13+): `npm install && npm start` → http://localhost:3000

## End-to-end test (runs inside the container)

    docker compose exec pre-con-commander npm run e2e          # site already running
    docker compose run --rm pre-con-commander npm run e2e      # or a one-off container

The test starts its own copy of the server on port 3999 with a throwaway database in
/tmp, so real games, history and wheel settings are never touched. It plays a full game
night against live Scryfall: create game → crown winner (3/2/2/2) → spin (and checks the
live-sync event a second phone would get) → open a real-data booster → Sacrifice a Pack →
choose sets → generated Alpha (11C/3U/1R, no land) and Magic 2010 (land slot) boosters →
deck-list copy format → wheel weights/exclusions/year filter (120 spins) → finish → History.
Takes about a minute; it fails loudly if Scryfall can't be reached from the container.

Env: `PORT` (3000), `DATA_DIR` (./data), `SCRYFALL_BASE` (override for testing).
