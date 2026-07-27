import { describe, it, expect } from 'vitest';
import { STATUSES, WANTS_USER, USER_INPUT_TOOLS } from '../../claudeSession.js';
import { rowState, wantsUser, STATE_TEXT } from '../../public/js/attention.js';

// The status vocabulary crosses a wire. `claudeSession.js` produces it (CJS,
// server), `attention.js` consumes it (ESM, browser), and JSON in between means
// neither can import the other's constants — so the words are necessarily
// written twice. This file is what stops the two copies from drifting.
//
// Without it, adding a fifth status is a silent half-change: the server starts
// emitting it, the browser's rowState falls through to its read/unread default,
// and a session in a state nobody has thought about renders as "Read" — which is
// the most dangerous wrong answer available, since it is the one that says
// "nothing to do here".

const session = (claudeStatus) => ({ id: 'a', claudeStatus, unread: false });

describe('status vocabulary: server producer vs browser consumer', () => {
  it('gives every status the server can emit a row state that is not a fallback', () => {
    for (const status of STATUSES) {
      const state = rowState(session(status), 'other');
      expect(STATE_TEXT[state], `no label for status '${status}'`).toBeTruthy();
    }
  });

  it('lights the badge for every status the server counts as news', () => {
    // WANTS_USER is the server's list of statuses whose ARRIVAL advances the
    // unread counter. Each one must also be a state the browser acts on, or the
    // server counts a turn that the UI then declines to mention.
    for (const status of WANTS_USER) {
      const unseen = { id: 'a', claudeStatus: status, unread: true };
      expect(wantsUser(rowState(unseen, 'other')), `'${status}' counted but not surfaced`).toBe(true);
    }
  });

  it('never treats busy as attention, however unread the server says it is', () => {
    // The asymmetry that matters most, asserted from both ends: the server does
    // not count entering 'busy' as news, and the browser does not surface it
    // even if the unread flag is set by something else (a brand new tab counts
    // its own output before a transcript exists, then classifies as busy).
    expect(WANTS_USER.has('busy')).toBe(false);
    expect(wantsUser(rowState({ id: 'a', claudeStatus: 'busy', unread: true }, 'other'))).toBe(false);
  });

  it('defers to the unread flag for a status it cannot classify', () => {
    // 'unknown' is deliberately NOT in WANTS_USER — becoming unclassifiable is
    // not news — but it has a SECOND news mechanism the others do not: the
    // server counts raw pty output for it, because there is no conversation to
    // read. So the browser must honour the unread flag here rather than take the
    // status as the whole answer.
    expect(WANTS_USER.has('unknown')).toBe(false);
    expect(rowState({ id: 'a', claudeStatus: 'unknown', unread: true },  'other')).toBe('waiting');
    expect(rowState({ id: 'a', claudeStatus: 'unknown', unread: false }, 'other')).toBe('read');
  });

  it('treats an unrecognised status as needing to be seen, not as read', () => {
    // Belt and braces for the case the test above cannot cover: a status this
    // build has never heard of. Falling back to the unread axis means such a
    // session still surfaces once it has said something.
    expect(rowState({ id: 'a', claudeStatus: 'some-future-state', unread: true }, 'other')).toBe('waiting');
  });

  it('keeps the asking discrimination to tools a human actually answers', () => {
    // Guards the other half of the contract: the classifier reads these names
    // out of Claude's own transcript records, so they are an external interface,
    // not ours to rename. A machine-answered tool in here would turn every one
    // of its calls into a summons.
    expect([...USER_INPUT_TOOLS].sort()).toEqual(['AskUserQuestion', 'ExitPlanMode']);
    for (const machineTool of ['Bash', 'Read', 'Edit', 'Write', 'WebFetch', 'Agent', 'Task', 'Skill']) {
      expect(USER_INPUT_TOOLS.has(machineTool), `${machineTool} is answered by the machine`).toBe(false);
    }
  });
});
