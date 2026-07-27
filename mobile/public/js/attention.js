// What wants the user, and what the Sessions button is allowed to claim.
//
// FOUR row states, from two sources that answer different questions.
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
export const STATE_TEXT = {
  asking:  'Asked you a question',
  working: 'Working',
  waiting: 'Waiting on you',
  read:    'Read',
};

// The session on screen is never unread: you are looking at it, so whatever it
// prints is read as it arrives. Without this, a busy active session re-flags
// itself the instant it paints.
export function isUnread(session, activeId) {
  if (session.id === activeId) return false;
  return session.unread === true;
}

export function rowState(session, activeId) {
  if (session.claudeStatus === 'asking') return 'asking';
  if (session.claudeStatus === 'busy')   return 'working';
  return isUnread(session, activeId) ? 'waiting' : 'read';
}

// Does this state mean a human has to do something? 'working' does not, and
// that is the load-bearing half of the answer.
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
export function pollDelay({ listOpen, sessions, activeId }) {
  if (listOpen) return 3000;
  for (const session of sessions) {
    if (session.id === activeId) continue;
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
