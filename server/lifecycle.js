// Every state machine in the app, in one place.
//
// Each machine lists its states (what each one means) and the moves allowed
// between them. Code changes a status only through move(), so an illegal move
// is a clear 409 instead of quietly bad data, and this file is the one place to
// read (or change) how things flow. docs/state-machines.md is generated from it
// (`npm run states`), and a test keeps the two in step.
//
// A pod's *phase* isn't stored: it's worked out from its status, its vote, its
// spin and its packs. podPhase() does that once, for the server, the Discord
// pings and the browser alike.
export const MACHINES = {
  pod: {
    about: 'One game of 3-4 league players. Stored in pods.status.',
    initial: 'playing',
    states: {
      playing: 'The game is on. Any pod player can crown the winner.',
      awarded: 'A winner is crowned: packs are awarded, then the bonus vote, the spin and opening packs.',
      done: 'Finished and in History. Packs not yet opened can still be opened.',
      discarded: "Thrown away: not in History, standings or pools.",
    },
    moves: {
      playing: ['awarded', 'discarded'],
      // Re-crowning (before anyone has voted) keeps it awarded.
      awarded: ['awarded', 'done', 'discarded'],
      done: [],
      discarded: [],
    },
  },
  vote: {
    about: "A pod's bonus-pack vote. Opens when the winner is crowned. Stored in pod.vote.status.",
    initial: 'open',
    states: {
      open: 'Pod players vote (never for themselves). A tie starts a re-vote between the tied players (the round goes up).',
      done: 'Decided: the winner of the vote gets the bonus pack(s).',
      skipped: 'No vote: the league turned it off, or an admin skipped a stuck one.',
    },
    moves: { open: ['done', 'skipped'], done: [], skipped: [] },
  },
  pack: {
    about: 'One booster a player was given. Stored in pod_packs.status.',
    initial: 'ready',
    states: {
      ready: 'Unopened, with a set.',
      choosing: 'Waiting for its owner to pick a set (after a sacrifice, or an admin "their choice" pack).',
      opened: 'Opened: its cards are in the pool.',
    },
    moves: { ready: ['choosing', 'opened'], choosing: ['ready'], opened: [] },
  },
  trade: {
    about: 'A thread of offers between two league members. Stored in trades.status, with turn_id = whose answer it waits on.',
    initial: 'open',
    states: {
      open: 'Waiting on turn_id to accept, decline or counter (a counter keeps it open and passes the turn).',
      accepted: 'Went through: the cards moved.',
      declined: 'Turned down by the player it waited on.',
      cancelled: 'Withdrawn by whoever sent the last offer.',
      closed: 'Closed by the site: the league ended, a player left, or another trade took one of its cards.',
    },
    moves: { open: ['accepted', 'declined', 'cancelled', 'closed'], accepted: [], declined: [], cancelled: [], closed: [] },
  },
  league: {
    about: 'A season. Stored in leagues.status. Deleting one removes it entirely.',
    initial: 'active',
    states: {
      active: 'Pods, packs, trades and game nights happen here. A player is in at most one active league.',
      ended: 'A read-only archive: standings, history and pools stay.',
    },
    moves: { active: ['ended'], ended: [] },
  },
  night: {
    about: 'A proposed game night. Stored in game_nights.status. It counts as over 12 hours after it starts (worked out from the time, not stored).',
    initial: 'open',
    states: {
      open: 'Players answer Yes / Maybe / No. Up to 3 open per league.',
      cancelled: 'Called off by whoever proposed it, the league admin or the site admin.',
    },
    moves: { open: ['cancelled'], cancelled: [] },
  },
  feedback: {
    about: 'A suggestion or bug report. Stored in feedback.status. The admin can set any status.',
    initial: 'new',
    states: { new: 'Not looked at yet.', planned: 'Going to happen.', done: 'Built or fixed.', declined: "Won't happen." },
    moves: {
      new: ['planned', 'done', 'declined'], planned: ['new', 'done', 'declined'],
      done: ['new', 'planned', 'declined'], declined: ['new', 'planned', 'done'],
    },
  },
};

export class LifecycleError extends Error {
  constructor(machine, from, to) {
    super(`Can't go from ${from} to ${to} (${machine}).`);
    this.status = 409; this.code = 'illegal_transition'; this.machine = machine; this.from = from; this.to = to;
  }
}
export const canMove = (machine, from, to) => !!MACHINES[machine]?.moves[from]?.includes(to);
// Change something's status, if that move is allowed. Returns the thing.
export function move(machine, thing, to, key = 'status') {
  const from = thing[key];
  if (!canMove(machine, from, to)) throw new LifecycleError(machine, from, to);
  thing[key] = to;
  return thing;
}
// For statuses that live in a table row: checks the move, the caller writes it.
export function assertMove(machine, from, to) {
  if (!canMove(machine, from, to)) throw new LifecycleError(machine, from, to);
}

// ---------- a pod's phase ----------
// phase:     playing | voting | spin | packs | finished | discarded
// waitingOn: who the pod waits on: [{ id, kind: 'crown' | 'vote' | 'spin' | 'packs', round? }]
// actions:   what can be done now (names of the API actions)
export const POD_PHASES = {
  playing: 'The game is on; crown the winner when it ends.',
  voting: 'The winner is crowned; pod players vote for who gets the bonus pack.',
  spin: 'Waiting for the winner to spin the wheel (everyone watches).',
  packs: 'The wheel is spun; players open (or sacrifice) their packs. Finish the pod to save it to History.',
  finished: 'In History. Any packs still unopened can be opened.',
  discarded: 'Thrown away.',
};
export function podPhase(pod) {
  const waitingOn = [];
  const unopened = p => p.packs?.some(k => k.status !== 'opened');
  const packsWait = () => {
    for (const p of [...(pod.players || []), ...(pod.absentees || [])]) if (unopened(p) && !waitingOn.some(w => w.id === p.id)) waitingOn.push({ id: p.id, kind: 'packs' });
  };
  if (pod.status === 'discarded') return { phase: 'discarded', waitingOn, actions: [] };
  if (pod.status === 'done') { packsWait(); return { phase: 'finished', waitingOn, actions: waitingOn.length ? ['open'] : [] }; }
  if (pod.status === 'playing') return { phase: 'playing', waitingOn: [{ id: null, kind: 'crown' }], actions: ['winner', 'discard'] };
  const v = pod.vote;
  if (!pod.spin && v?.status === 'open') {
    const voted = new Set(v.ballots.filter(b => b.round === v.round).map(b => b.voterId));
    for (const p of pod.players) if (!voted.has(p.id)) waitingOn.push({ id: p.id, kind: 'vote', round: v.round });
    return { phase: 'voting', round: v.round, waitingOn, actions: ['vote', ...(v.ballots.length ? [] : ['winner']), 'finish', 'discard'] };
  }
  if (!pod.spin) {
    if (pod.winnerId) waitingOn.push({ id: pod.winnerId, kind: 'spin' });
    return { phase: 'spin', waitingOn, actions: ['watch', 'spin', ...(v?.ballots?.length ? [] : ['winner']), 'finish', 'discard'] };
  }
  packsWait();
  return { phase: 'packs', waitingOn, actions: ['open', 'sacrifice', 'finish', 'discard'] };
}

// ---------- the docs ----------
// docs/state-machines.md, generated from the tables above.
export function machinesMarkdown() {
  const out = ['# State machines', '',
    '<!-- Generated from server/lifecycle.js by `npm run states`. Do not edit by hand: a test checks it matches. -->', '',
    'Every status in Pre-Con Commander and the moves allowed between them. Code changes a status only through',
    "`move()` in `server/lifecycle.js`; any other move is refused with a 409 (`code: 'illegal_transition'`).", ''];
  for (const [name, m] of Object.entries(MACHINES)) {
    out.push(`## ${name}`, '', m.about, '', '```mermaid', 'stateDiagram-v2', `  [*] --> ${m.initial}`);
    for (const [from, tos] of Object.entries(m.moves)) for (const to of tos) out.push(`  ${from} --> ${to}`);
    for (const [s, tos] of Object.entries(m.moves)) if (!tos.length) out.push(`  ${s} --> [*]`);
    out.push('```', '', '| State | Meaning |', '| --- | --- |');
    for (const [s, about] of Object.entries(m.states)) out.push(`| \`${s}\` | ${about} |`);
    out.push('');
  }
  out.push('## A pod\'s phase', '', "Not stored: `podPhase(pod)` works it out from the pod's status, vote, spin and packs. Every pod the API returns carries it as `phase` (`{ phase, waitingOn, actions }`), and the Discord pings use the same `waitingOn`.", '',
    '```mermaid', 'stateDiagram-v2', '  [*] --> playing', '  playing --> voting: winner crowned', '  playing --> spin: winner crowned (no vote)',
    '  voting --> spin: vote decided or skipped', '  spin --> packs: wheel spun', '  packs --> finished: finish', '  voting --> finished: finish', '  spin --> finished: finish',
    '  playing --> discarded', '  voting --> discarded', '  spin --> discarded', '  packs --> discarded', '  finished --> [*]', '  discarded --> [*]', '```', '',
    '| Phase | Meaning |', '| --- | --- |');
  for (const [p, about] of Object.entries(POD_PHASES)) out.push(`| \`${p}\` | ${about} |`);
  out.push('');
  return out.join('\n');
}
