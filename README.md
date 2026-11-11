# Pre-Con Commander

A web app for running a **Commander league** where everyone starts on a preconstructed deck
and earns booster packs by playing. Players join a league, play pods of 3–4, vote one player a
bonus pack, spin a wheel of Magic sets, and rip the packs open. Every card they pull goes into
their **pool**: the cards they may add to their precon.

Built for a group of friends at one table. It works on phones, and everyone sees spins, votes
and packs live.

## How a league works

1. **Join a league.** Someone starts one and shares an invite link or code. Players who join
   late get catch-up packs for the pods they missed, so nobody falls behind.
2. **Play a pod.** 3–4 players sit down with their precons. Several pods can run at once.
3. **Vote.** When the pod ends, its players vote (never for themselves) to give one player a
   bonus pack. Ballots stay hidden until everyone has voted, and a tie means a re-vote.
4. **Spin.** Once everyone in the pod has the wheel open, the winner spins a wheel of booster sets. Every pack from that pod is that set:
   the winner gets the most, everyone else gets some, and league members who missed the pod
   get one too.
5. **Open packs.** A rip-open animation, rares revealed last, and card zoom with double-faced
   flip. Don't like the set? Sacrifice a pack to turn another one into any set you like.
6. **Build.** Your pulls go into your pool, ready to add to your deck.

## Features

- **Real boosters.** Most sets, from Alpha to today, open with their real print sheets and slot
  odds. The few without booster data on record get a pack built with the layout of that era.
  Never a Collector Booster.
- **Pools** of every card each player has pulled in a league: grouped, searchable and filterable
  by pod, with one-tap export to Moxfield or Archidekt.
- **Trades** between two league members, any number of cards for any number. Offers wait for an
  answer (accept, decline or counter), so nobody has to be online at the same time. Each trade
  shows the card images from every round.
- **Fun Packs.** Open boosters from any set just for fun, from a single pack up to a box. Nothing
  is saved, and a stats view compares a batch against the set's print sheets.
- **League page** with standings, players, rules and an activity feed of winners, votes, spins
  and big pulls. Leagues can be ended into a read-only archive, one season at a time.
- **Player pages** with stats for one league or all of them: wins, streaks, rivals, sets opened,
  best pulls and recent pods.
- **Season recap** with the champion, awards (Most Wins, Kingslayer, Mythic Magnet and more),
  top pulls and final standings, ready to paste into Discord.
- **A precon for each league**, locked once saved, with a commander picture you can change any time. Admins can allow a change, and players can ask for one.
- **Deck editor** in the Pools tab: your deck as stacks of card pictures, starting from your
  precon's official list, with your pool in a tray to swap cards in and out. It flags decks that
  aren't 100 cards, have duplicates or go outside the commander's colours.
- **Deck lists** can also come from a Moxfield or Archidekt link or a pasted list, shown with the
  commander, colour identity, mana curve and card types.
- **Discord.** Finished pods, season recaps and announcements can be posted to a Discord channel.
- **Suggest a feature.** Players send ideas and bug reports and can see the replies.
- **League tools.** Whoever starts a league can set its rules and manage its players. Site admins
  can hand out packs, fix finished pods, post announcements and undo their own changes.
- **No prices anywhere.** Cards are for playing, not for trading on value.

## Privacy

Players can read the Privacy Policy (`/privacy`) and Terms of Use (`/terms`) on the site and can
delete their account at any time. A deleted player's past games stay in league history as
"Deleted player".

## Tech

Node.js, Express and SQLite on the server, plain JavaScript in the browser with no build step.
Card data and images come from Scryfall.

## Credits and legal

Pre-Con Commander is unofficial Fan Content permitted under the
[Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy). Not
approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the
Coast. ©Wizards of the Coast LLC.

Card data and images come from [Scryfall](https://scryfall.com) (not affiliated). The
real-booster print sheets come from [MTGJSON](https://mtgjson.com) (MIT License, Copyright ©
2018-Present Zachary Halpern; see `packs/NOTICE.md`).

Released under the [MIT License](LICENSE).
