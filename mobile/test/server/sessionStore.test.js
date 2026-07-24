import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionStore, nullSessionStore } from '../../sessionStore.js';

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
    expect(createSessionStore({ dir }).load()).toEqual([{ id: 'main-1' }, { id: 'main-2' }]);
  });

  it('returns an empty roster on first boot (no file yet)', () => {
    expect(createSessionStore({ dir }).load()).toEqual([]);
  });

  it('creates the state dir on demand', () => {
    const nested = path.join(dir, 'deep', 'deeper');
    createSessionStore({ dir: nested }).save([{ id: 'main-1' }]);
    expect(createSessionStore({ dir: nested }).load()).toEqual([{ id: 'main-1' }]);
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
    expect(store.load()).toEqual([{ id: 'main-9' }]);
  });

  it('de-duplicates repeated ids', () => {
    const store = createSessionStore({ dir, logger: quietLogger });
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{ id: 'main-1' }, { id: 'main-1' }],
    }));
    expect(store.load()).toEqual([{ id: 'main-1' }]);
  });

  it('leaves the previous roster intact when a write fails', () => {
    const store = createSessionStore({ dir, logger: quietLogger });
    store.save([{ id: 'main-1' }]);
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    expect(() => store.save([{ id: 'main-2' }])).not.toThrow();
    spy.mockRestore();
    expect(createSessionStore({ dir }).load()).toEqual([{ id: 'main-1' }]);
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

describe('nullSessionStore', () => {
  it('is inert, so an embedder gets no filesystem side effects by default', () => {
    expect(nullSessionStore.load()).toEqual([]);
    expect(nullSessionStore.sidPath('main-1')).toBeNull();
    expect(nullSessionStore.readSid('main-1')).toBeNull();
    expect(() => {
      nullSessionStore.save([{ id: 'main-1' }]);
      nullSessionStore.clearSid('main-1');
    }).not.toThrow();
  });
});
