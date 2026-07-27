import { describe, it, expect } from 'vitest';
import { STATE_TEXT, isUnread, rowState, wantsUser, badgeState, summarise, pollDelay } from '../../public/js/attention.js';

// These tests are the contract for what "needs me" means, and that is the whole
// reason the module exists as a module: the answer was previously inline in
// index.html, where nothing could check it, and it was wrong in three separate
// ways at once (2026-07-27) — a working session claimed attention, a session
// already read claimed it again, and a session holding a direct question did
// not claim it at all.

const session = (id, claudeStatus, unread = false) => ({ id, claudeStatus, unread });

describe('rowState', () => {
  it('calls a pending question asking, whatever the unread flag says', () => {
    // Not gated on unread on purpose: looking at a question is not answering
    // it, so a glance must not clear the one state that blocks progress.
    expect(rowState(session('a', 'asking', true),  'b')).toBe('asking');
    expect(rowState(session('a', 'asking', false), 'b')).toBe('asking');
  });

  it('shows a pending question even for the session on screen', () => {
    // You are looking at it, so nothing is "unread" — but it is still blocked
    // on you, and the row is the only thing that says so.
    expect(rowState(session('a', 'asking', false), 'a')).toBe('asking');
  });

  it('calls a mid-turn conversation working', () => {
    expect(rowState(session('a', 'busy', true),  'b')).toBe('working');
    expect(rowState(session('a', 'busy', false), 'b')).toBe('working');
  });

  it('splits a finished conversation on whether it has been seen', () => {
    expect(rowState(session('a', 'idle', true),  'b')).toBe('waiting');
    expect(rowState(session('a', 'idle', false), 'b')).toBe('read');
  });

  it('never calls the session on screen unread', () => {
    // Without this, a session you are sitting in re-flags itself forever.
    expect(rowState(session('a', 'idle', true), 'a')).toBe('read');
    expect(isUnread(session('a', 'idle', true), 'a')).toBe(false);
  });

  it('keeps working for a session with no classifiable conversation', () => {
    // A brand new tab, or a custom SHELL_CMD that is not Claude at all. The
    // unread axis still applies; there is just no transcript state to add.
    expect(rowState(session('a', 'unknown', true),  'b')).toBe('waiting');
    expect(rowState(session('a', 'unknown', false), 'b')).toBe('read');
  });
});

describe('wantsUser', () => {
  it('is true for the two states a human has to act on', () => {
    expect(wantsUser('asking')).toBe(true);
    expect(wantsUser('waiting')).toBe(true);
  });

  it('is FALSE for working — this is the fix, not a detail', () => {
    // A coder that is thinking is the normal case. Counting it as attention is
    // what made the badge fire almost permanently and stop meaning anything.
    expect(wantsUser('working')).toBe(false);
    expect(wantsUser('read')).toBe(false);
  });

  it('has a label for every state it can be asked about', () => {
    for (const state of ['asking', 'working', 'waiting', 'read']) {
      expect(typeof STATE_TEXT[state]).toBe('string');
      expect(STATE_TEXT[state].length).toBeGreaterThan(0);
    }
  });
});

describe('badgeState', () => {
  it('is empty when the only session is the one you are in', () => {
    expect(badgeState([session('a', 'idle', true)], 'a')).toBe('');
  });

  it('is empty when every other session is read', () => {
    expect(badgeState([session('a', 'idle'), session('b', 'idle')], 'a')).toBe('');
  });

  it('says working — not attention — when another session is merely mid-turn', () => {
    expect(badgeState([session('a', 'idle'), session('b', 'busy', true)], 'a')).toBe('working');
  });

  it('says attention when another session is finished and unseen', () => {
    expect(badgeState([session('a', 'idle'), session('b', 'idle', true)], 'a')).toBe('attention');
  });

  it('says attention when another session is holding a question', () => {
    expect(badgeState([session('a', 'idle'), session('b', 'asking')], 'a')).toBe('attention');
  });

  it('prefers attention over working, whatever the order', () => {
    const busy = session('b', 'busy', true);
    const needy = session('c', 'asking');
    expect(badgeState([session('a', 'idle'), busy, needy], 'a')).toBe('attention');
    expect(badgeState([session('a', 'idle'), needy, busy], 'a')).toBe('attention');
  });

  it('ignores the active session entirely, even holding a question', () => {
    // The badge answers "is anything ELSE waiting", which is the only question
    // it can usefully answer from inside a session.
    expect(badgeState([session('a', 'asking'), session('b', 'idle')], 'a')).toBe('');
  });
});

// The poll interval is the badge's worst-case latency now that arriving bytes do
// not flag anything in the browser, so it is worth pinning rather than leaving
// as an inline number nothing checks.
describe('pollDelay', () => {
  const args = (sessions, activeId = 'a', listOpen = false) => ({ listOpen, sessions, activeId });

  it('is quickest with the list open, whatever the sessions are doing', () => {
    expect(pollDelay(args([session('a', 'idle')], 'a', true))).toBe(3000);
  });

  it('tightens while another session is mid-turn', () => {
    expect(pollDelay(args([session('a', 'idle'), session('b', 'busy')]))).toBe(4000);
  });

  it('tightens for a session with no conversation to read', () => {
    // Judged by its output alone, and output can arrive at any moment.
    expect(pollDelay(args([session('a', 'idle'), session('b', 'unknown')]))).toBe(4000);
  });

  it('relaxes when everything else has settled', () => {
    // Nothing can change without first becoming busy, which the 4s tier catches.
    expect(pollDelay(args([session('a', 'busy'), session('b', 'idle'), session('c', 'asking')]))).toBe(8000);
  });

  it('ignores what the ACTIVE session is doing', () => {
    // You are looking at it; the poll is for learning about the others.
    expect(pollDelay(args([session('a', 'busy')], 'a'))).toBe(8000);
  });

  it('accepts an iterator, which is what the caller has', () => {
    // index.html passes sessions.values() straight through, so this must not
    // require an array.
    const map = new Map([['a', session('a', 'idle')], ['b', session('b', 'busy')]]);
    expect(pollDelay(args(map.values()))).toBe(4000);
  });
});

describe('summarise', () => {
  it('counts only what wants the user', () => {
    const list = [session('a', 'idle'), session('b', 'busy', true), session('c', 'asking')];
    expect(summarise(list, 'a')).toBe('3 sessions · 1 needs you');
  });

  it('agrees on number', () => {
    expect(summarise([session('a', 'idle', true), session('b', 'asking')], 'z')).toBe('2 sessions · 2 need you');
    expect(summarise([session('a', 'idle', true)], 'z')).toBe('1 session · 1 needs you');
  });

  it('says what is running when nothing wants the user', () => {
    // "all quiet" over two grinding sessions would be the same lie the badge
    // used to tell, just in words.
    expect(summarise([session('a', 'busy', true), session('b', 'busy', true)], 'a')).toBe('2 sessions · 2 working');
  });

  it('describes the whole list, including the session you are in', () => {
    // Deliberately unlike badgeState, which skips the active session because it
    // answers "is anything ELSE waiting". This header describes what the rows
    // say, and the active session has a row like any other.
    expect(summarise([session('a', 'busy')], 'a')).toBe('1 session · 1 working');
    expect(badgeState([session('a', 'busy')], 'a')).toBe('');
  });

  it('says all quiet only when nothing needs you AND nothing is running', () => {
    expect(summarise([session('a', 'idle'), session('b', 'idle')], 'a')).toBe('2 sessions · all quiet');
  });

  it('prefers the count that would make someone open the list', () => {
    const list = [session('a', 'idle'), session('b', 'busy', true), session('c', 'asking')];
    expect(summarise(list, 'a')).toBe('3 sessions · 1 needs you');
  });
});
