// What wants the user, and what the Sessions button is allowed to claim.
//
// FIVE row states. Four of them come from two sources that answer different
// questions; the fifth sits OUTSIDE that axis entirely and is described last.
//
// The transcript says what the CONVERSATION is doing: working, finished, or
// blocked on a question it put to the user ('asking'). What it cannot say is
// whether a human has looked, because "waiting on you" and "read" are the same
// finished state on disk — that axis is the server's unread flag. DO NOT go
// hunting for a third transcript state; there isn't one.
//
// The ordering below is the whole point of the module, so it is stated once:
//
//   asking   a direct question is pending. Outranks everything, and is NOT
//            gated on unread, because looking at a question is not answering
//            it. A glance must not clear it, or the one state that genuinely
//            blocks progress is the one that hides itself.
//   working  mid-turn. Wants no one. Explicitly NOT attention: a coder that is
//            thinking is the normal case, and a badge that fires for it is a
//            badge that fires almost always, which is how "does anything need
//            me?" stopped being answerable without opening the list.
//   waiting  finished, and not looked at since. Wants the user.
//   read     finished, and looked at. Wants nothing; the user saw it and chose
//            not to reply, which is their business.
//
// And the fifth, which is not a point on that axis but the absence of the axis:
//
//   opaque   this session's harness writes no transcript AND its output is not
//            evidence of anything (a TUI paints while it thinks). All four
//            states above are claims about a conversation nobody can read, so
//            the row says it has no status instead of picking one. It wants
//            nobody, and wantsUser() excludes it for free by not naming it.
export const STATE_TEXT = {
  asking:  'Asked you a question',
  working: 'Working',
  waiting: 'Waiting on you',
  read:    'Read',
  opaque:  'Status not tracked',
};

// The session on screen is never unread: you are looking at it, so whatever it
// prints is read as it arrives. Without this, a busy active session re-flags
// itself the instant it paints.
export function isUnread(session, activeId) {
  if (session.id === activeId) return false;
  return session.unread === true;
}

export function rowState(session, activeId) {
  // CHECKED FIRST, AND AGAINST === false RATHER THAN FALSY. The server says
  // whether this session has any axis on which a status could be known. When it
  // says no, the four states below are all claims about a conversation nobody
  // can read, and falling through to the unread axis is what makes a session
  // that is THINKING report "Waiting on you" and light the attention badge.
  //
  // Strict on purpose, both halves:
  //
  //   === false   a row that predates the field, or a server that did not send
  //               it, is undefined and must behave exactly as before.
  //   the FIELD   and never `claudeStatus === 'unknown'`, which is the
  //               natural-looking mistake. 'unknown' is also what a BRAND NEW
  //               Claude tab reads before its first turn is written, and that
  //               session does have an axis: its output. Keying off the status
  //               would make every new tab opaque and would break the
  //               unknown-plus-unread case that statusContract.test.js pins.
  if (session.statusTracked === false) return 'opaque';
  if (session.claudeStatus === 'asking') return 'asking';
  if (session.claudeStatus === 'busy')   return 'working';
  return isUnread(session, activeId) ? 'waiting' : 'read';
}

// Does this state mean a human has to do something? 'working' does not, and
// that is the load-bearing half of the answer. Neither does 'opaque', which
// falls out of naming the two that do rather than needing its own clause: a
// session we know nothing about is not thereby a summons.
export function wantsUser(state) {
  return state === 'asking' || state === 'waiting';
}

// What the Sessions button should show for the sessions the user is NOT in.
//
// Two tiers, because one dot had to mean both "you are needed" and "something
// is happening" and therefore meant neither:
//
//   'attention'  at least one other session wants the user. Act.
//   'working'    none do, but at least one is mid-turn. Nothing to do; shown so
//                the button can still distinguish "busy elsewhere" from "all
//                quiet", which is the only reason the old dot was tolerable.
//   ''           all quiet.
export function badgeState(sessions, activeId) {
  let working = false;
  for (const session of sessions) {
    if (session.id === activeId) continue;
    const state = rowState(session, activeId);
    if (wantsUser(state)) return 'attention';
    if (state === 'working') working = true;
  }
  return working ? 'working' : '';
}

// How soon to ask the server again, in milliseconds.
//
// The poll is the ONLY thing that can tell the badge a session wants you:
// arriving bytes deliberately do not, because the browser cannot tell a finished
// turn from a repaint. So this interval IS the badge's worst-case latency, and
// it is set by whether news is even possible.
//
//   list open              3000  the rows show relative times and states
//   something could change 4000  a session is mid-turn, or has no conversation
//                                to read and so is judged by its output alone
//   everything settled     8000  nothing can change without first becoming one
//                                of the two above, which this will notice
//
// A session with no status axis at all is excluded from the middle tier: see
// the comment on the skip below.
export function pollDelay({ listOpen, sessions, activeId }) {
  if (listOpen) return 3000;
  for (const session of sessions) {
    if (session.id === activeId) continue;
    // An opaque session learns nothing from a poll: there is no transcript to
    // re-read and its bytes do not move anything. Left in the tier below it
    // would read as 'unknown' and pin the interval at 4 seconds forever from
    // the moment one such tab exists, which is a wakeup every four seconds for
    // news that cannot arrive.
    if (session.statusTracked === false) continue;
    if (session.claudeStatus === 'busy' || session.claudeStatus === 'unknown') return 4000;
  }
  return 8000;
}

// How the list summarises itself, in the same three tiers as the badge, for the
// same reason: "all quiet" has to mean nothing needs you AND nothing is
// running. Saying it over three grinding sessions would be a second version of
// the defect this all exists to fix, just in words instead of a dot.
export function summarise(sessions, activeId) {
  const total = sessions.length;
  let needy = 0;
  let working = 0;
  for (const session of sessions) {
    const state = rowState(session, activeId);
    if (wantsUser(state)) needy++;
    else if (state === 'working') working++;
  }
  const count = `${total} session${total === 1 ? '' : 's'}`;
  if (needy)   return `${count} · ${needy} need${needy === 1 ? 's' : ''} you`;
  if (working) return `${count} · ${working} working`;
  return `${count} · all quiet`;
}
