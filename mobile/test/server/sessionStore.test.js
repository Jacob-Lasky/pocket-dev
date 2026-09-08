import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionStore, nullSessionStore, ROSTER_VERSION } from '../../sessionStore.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-store-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const quietLogger = { warn: () => {}, log: () => {} };

describe('session roster', () => {
  it('round-trips the session ids', () => {
    const store = createSessionStore({ dir });
    store.save([{ id: 'main-1' }, { id: 'main-2' }]);
    expect(createSessionStore({ dir }).load())
      .toEqual([{ id: 'main-1', provider: 'claude' }, { id: 'main-2', provider: 'claude' }]);
  });

  it('returns an empty roster on first boot (no file yet)', () => {
    expect(createSessionStore({ dir }).load()).toEqual([]);
  });

  it('creates the state dir on demand', () => {
    const nested = path.join(dir, 'deep', 'deeper');
    createSessionStore({ dir: nested }).save([{ id: 'main-1' }]);
    expect(createSessionStore({ dir: nested }).load()).toEqual([{ id: 'main-1', provider: 'claude' }]);
  });

  it('survives a corrupt roster instead of throwing', () => {
    const store = createSessionStore({ dir, logger: quietLogger });
    fs.writeFileSync(path.join(dir, 'sessions.json'), '{not json at all');
    expect(store.load()).toEqual([]);
  });

  it('survives a roster of the wrong shape', () => {
    const store = createSessionStore({ dir, logger: quietLogger });
    for (const payload of ['{}', '[]', '{"sessions":"nope"}', 'null']) {
      fs.writeFileSync(path.join(dir, 'sessions.json'), payload);
      expect(store.load()).toEqual([]);
    }
  });

  it('drops ids that fail SAFE_ID rather than repairing them', () => {
    // Regression guard: roster ids are interpolated into tmux shell commands
    // (/refresh) and joined into filesystem paths. A poisoned state file must
    // not become a shell injection at boot.
    const store = createSessionStore({ dir, logger: quietLogger });
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [
        { id: "x';rm -rf /;'" },
        { id: '../../escape' },
        { id: 'has space' },
        { id: '' },
        { id: 42 },
        null,
        { id: 'main-9' },
      ],
    }));
    expect(store.load()).toEqual([{ id: 'main-9', provider: 'claude' }]);
  });

  it('de-duplicates repeated ids', () => {
    const store = createSessionStore({ dir, logger: quietLogger });
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{ id: 'main-1' }, { id: 'main-1' }],
    }));
    expect(store.load()).toEqual([{ id: 'main-1', provider: 'claude' }]);
  });

  it('leaves the previous roster intact when a write fails', () => {
    const store = createSessionStore({ dir, logger: quietLogger });
    store.save([{ id: 'main-1' }]);
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    expect(() => store.save([{ id: 'main-2' }])).not.toThrow();
    spy.mockRestore();
    expect(createSessionStore({ dir }).load()).toEqual([{ id: 'main-1', provider: 'claude' }]);
  });

  it('disables itself quietly after a write failure instead of crashing the server', () => {
    const logger = { warn: vi.fn(), log: vi.fn() };
    const store  = createSessionStore({ dir, logger });
    const spy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => { throw new Error('EACCES'); });
    store.save([{ id: 'main-1' }]);
    store.save([{ id: 'main-2' }]);
    store.save([{ id: 'main-3' }]);
    spy.mockRestore();
    // One warning total, not one per persist.
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

describe('per-session Claude uuid handoff', () => {
  const uuid = '6d7657b2-2e36-4a45-a083-4c300969650d';

  it('reads the uuid pd-claude-session recorded', () => {
    const store = createSessionStore({ dir });
    fs.mkdirSync(path.dirname(store.sidPath('main-1')), { recursive: true });
    fs.writeFileSync(store.sidPath('main-1'), `${uuid}\n`);
    expect(store.readSid('main-1')).toBe(uuid);
  });

  it('returns null when there is no uuid on file', () => {
    expect(createSessionStore({ dir }).readSid('main-1')).toBeNull();
  });

  it('rejects a uuid that is not a uuid', () => {
    // The value reaches a shell command line and a filesystem lookup, so a
    // mangled or hand-edited file must not be trusted just because we wrote it.
    const store = createSessionStore({ dir });
    fs.mkdirSync(path.dirname(store.sidPath('main-1')), { recursive: true });
    for (const bad of ['', 'not-a-uuid', `${uuid} ; rm -rf /`, '../../etc/passwd']) {
      fs.writeFileSync(store.sidPath('main-1'), bad);
      expect(store.readSid('main-1')).toBeNull();
    }
  });

  it('refuses to build a sid path for an unsafe id', () => {
    expect(createSessionStore({ dir }).sidPath('../escape')).toBeNull();
  });

  it('clears the uuid so a reused id never resumes a killed conversation', () => {
    const store = createSessionStore({ dir });
    fs.mkdirSync(path.dirname(store.sidPath('main-1')), { recursive: true });
    fs.writeFileSync(store.sidPath('main-1'), uuid);
    store.clearSid('main-1');
    expect(store.readSid('main-1')).toBeNull();
    expect(() => store.clearSid('main-1')).not.toThrow(); // idempotent
  });
});

describe('clean-shutdown marker', () => {
  it('reports unclean when there is no marker — the safe default', () => {
    // Every way a process dies without a say (SIGKILL, OOM kill, power cut)
    // lands here, so this branch must be the one you get by knowing nothing.
    expect(createSessionStore({ dir }).consumeCleanShutdown()).toBe(false);
  });

  it('reports clean after a deliberate shutdown marked it', () => {
    const store = createSessionStore({ dir });
    store.markCleanShutdown();
    expect(createSessionStore({ dir }).consumeCleanShutdown()).toBe(true);
  });

  it('vouches for exactly one shutdown', () => {
    // Regression guard: if the marker survived being read, a single clean stop
    // would excuse every crash after it and Claude would auto-continue work
    // that may have killed the container.
    const store = createSessionStore({ dir });
    store.markCleanShutdown();
    expect(store.consumeCleanShutdown()).toBe(true);
    expect(store.consumeCleanShutdown()).toBe(false);
  });

  it('creates the state dir when marking', () => {
    const nested = path.join(dir, 'not', 'there', 'yet');
    createSessionStore({ dir: nested }).markCleanShutdown();
    expect(createSessionStore({ dir: nested }).consumeCleanShutdown()).toBe(true);
  });

  it('stays unclean, rather than throwing, when the marker cannot be written', () => {
    const store = createSessionStore({ dir, logger: quietLogger });
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('EROFS'); });
    expect(() => store.markCleanShutdown()).not.toThrow();
    spy.mockRestore();
    expect(store.consumeCleanShutdown()).toBe(false);
  });

  it('does not confuse the roster with the marker', () => {
    const store = createSessionStore({ dir });
    store.save([{ id: 'main-1' }]);
    expect(store.consumeCleanShutdown()).toBe(false);
    expect(store.load()).toEqual([{ id: 'main-1', provider: 'claude' }]);
  });
});

describe('the provider each session runs, carried by the roster', () => {
  // The roster went to version 2 to hold this. What makes the migration cheap
  // is that BOTH directions are the same code path: per-entry validation with a
  // default, and no read of parsed.version anywhere in load().

  it('round-trips a provider that is not the default', () => {
    const store = createSessionStore({ dir });
    store.save([{ id: 'main-1', provider: 'codex' }, { id: 'main-2', provider: 'claude' }]);
    expect(createSessionStore({ dir }).load()).toEqual([
      { id: 'main-1', provider: 'codex' },
      { id: 'main-2', provider: 'claude' },
    ]);
  });

  it('writes version 2', () => {
    const store = createSessionStore({ dir });
    store.save([{ id: 'main-1', provider: 'codex' }]);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'));
    expect(raw.version).toBe(2);
    expect(ROSTER_VERSION).toBe(2);
  });

  it('reads a version 1 roster and gives every entry the default provider', () => {
    // The upgrade case, and the whole reason no version switch is needed: an
    // entry with no provider field is indistinguishable from an entry whose
    // provider failed validation, and both want the same answer.
    const store = createSessionStore({ dir, logger: quietLogger });
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{ id: 'main-1' }, { id: 'main-2' }],
    }));
    expect(store.load()).toEqual([
      { id: 'main-1', provider: 'claude' },
      { id: 'main-2', provider: 'claude' },
    ]);
  });

  it('LOADS a roster from a newer pocket-dev instead of refusing it', () => {
    // Regression guard for the version gate nobody should add. A gate here
    // loses every tab on a downgrade, and this module's contract is that a
    // terminal which loses its tabs is degraded while one that will not start
    // is broken. The unknown provider is repaired, the unknown field ignored,
    // and the tabs come back.
    const logger = { warn: vi.fn(), log: vi.fn() };
    const store  = createSessionStore({ dir, logger });
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 99,
      sessions: [
        { id: 'main-1', provider: 'gemini', someFutureField: true },
        { id: 'main-2', provider: 'codex' },
      ],
    }));
    expect(store.load()).toEqual([
      { id: 'main-1', provider: 'claude' },
      { id: 'main-2', provider: 'codex' },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('roster version 99'));
  });

  it('mentions a newer roster once per process, not once per read', () => {
    // Same reasoning as disable(): the roster is read at boot but the store is
    // long-lived, and a notice that scrolls is a notice nobody reads.
    const logger = { warn: vi.fn(), log: vi.fn() };
    const store  = createSessionStore({ dir, logger });
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 99, sessions: [{ id: 'main-1' }],
    }));
    store.load(); store.load(); store.load();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('says nothing about the version when it is the one we write', () => {
    const logger = { warn: vi.fn(), log: vi.fn() };
    const store  = createSessionStore({ dir, logger });
    store.save([{ id: 'main-1', provider: 'codex' }]);
    expect(store.load()).toEqual([{ id: 'main-1', provider: 'codex' }]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('repairs an unrecognised or malformed provider rather than dropping the tab', () => {
    // The asymmetry with the id gate above is deliberate. A bad id has no safe
    // interpretation, so it is dropped; a bad provider has an obvious one, and
    // the tab is worth more than the field. What must NOT happen is the value
    // reaching a command line: every one of these would otherwise be a shell
    // string or an object index.
    const store = createSessionStore({ dir, logger: quietLogger });
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 2,
      sessions: [
        { id: 'a', provider: 'Claude' },
        { id: 'b', provider: 'claude; rm -rf /' },
        { id: 'c', provider: '../../etc/passwd' },
        { id: 'd', provider: '' },
        { id: 'e', provider: 42 },
        { id: 'f', provider: null },
        { id: 'g', provider: '__proto__' },
        { id: 'h', provider: 'constructor' },
        { id: 'i', provider: 'cursor' },
        { id: 'j', provider: 'codex' },
      ],
    }));
    expect(store.load()).toEqual([
      { id: 'a', provider: 'claude' },
      { id: 'b', provider: 'claude' },
      { id: 'c', provider: 'claude' },
      { id: 'd', provider: 'claude' },
      { id: 'e', provider: 'claude' },
      { id: 'f', provider: 'claude' },
      { id: 'g', provider: 'claude' },
      { id: 'h', provider: 'claude' },
      { id: 'i', provider: 'claude' },
      { id: 'j', provider: 'codex' },
    ]);
  });

  it('defaults on the way OUT too, so a stale caller cannot write a bad entry', () => {
    const store = createSessionStore({ dir });
    store.save([{ id: 'main-1' }, { id: 'main-2', provider: 'nope' }]);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'));
    expect(raw.sessions).toEqual([
      { id: 'main-1', provider: 'claude' },
      { id: 'main-2', provider: 'claude' },
    ]);
  });
});

describe('nullSessionStore', () => {
  it('is inert, so an embedder gets no filesystem side effects by default', () => {
    expect(nullSessionStore.load()).toEqual([]);
    expect(nullSessionStore.sidPath('main-1')).toBeNull();
    expect(nullSessionStore.readSid('main-1')).toBeNull();
    expect(nullSessionStore.consumeCleanShutdown()).toBe(false);
    expect(() => {
      nullSessionStore.save([{ id: 'main-1' }]);
      nullSessionStore.clearSid('main-1');
      nullSessionStore.markCleanShutdown();
    }).not.toThrow();
  });
});
