import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionsApi, buildSessionCommand, buildTmuxSpawnArgs } from '../../server.js';
import { createSessionStore } from '../../sessionStore.js';

// Restore is the whole point of the roster, and it cannot be reached from the
// browser suite: the e2e fixture runs `cat`, which has no conversation to
// resume. The pty spawner is injected here (same dependency-injection shape as
// createApp({ sessionsApi })) so create/restore and the resume decision are
// exercised without a real tmux or a real Claude.

const UUID = '6d7657b2-2e36-4a45-a083-4c300969650d';

function fakePty() {
  const proc = {
    writes: [],
    killed: false,
    dataHandlers: [],
    exitHandlers: [],
    onData(cb) { proc.dataHandlers.push(cb); },
    onExit(cb) { proc.exitHandlers.push(cb); },
    write(data) { proc.writes.push(data); },
    resize() {},
    kill() { proc.killed = true; },
    // Test-side drivers.
    emit(data) { for (const cb of proc.dataHandlers) cb(data); },
    exit()     { for (const cb of proc.exitHandlers) cb(); },
  };
  return proc;
}

let dir, projectsDir, spawned, logger;

function makeApi() {
  const store = createSessionStore({ dir, logger });
  const api = createSessionsApi({
    store,
    projectsDir,
    logger,
    spawnPty: (opts) => {
      const proc = fakePty();
      spawned.push({ ...opts, proc });
      return proc;
    },
  });
  return { api, store };
}

function writeTranscript(uuid, records) {
  const projectDir = path.join(projectsDir, '-home-claude');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${uuid}.jsonl`),
    records.map(r => JSON.stringify(r)).join('\n') + '\n',
  );
}

const BUSY = [{ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use' }] } }];
const IDLE = [{ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'all yours' }] } }];

beforeEach(() => {
  dir         = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-state-'));
  projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-projects-'));
  spawned     = [];
  logger      = { log: vi.fn(), warn: vi.fn() };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(projectsDir, { recursive: true, force: true });
});

describe('roster persistence', () => {
  it('records every created session', () => {
    const { api, store } = makeApi();
    const a = api.create();
    const b = api.create();
    expect(store.load()).toEqual([{ id: a.id }, { id: b.id }]);
  });

  it('drops a session from the roster when it is killed', async () => {
    const { api, store } = makeApi();
    const a = api.create();
    api.create();
    await new Promise(resolve => api.destroy(a.id, resolve));
    expect(store.load().map(s => s.id)).not.toContain(a.id);
  });

  it('drops a session from the roster when its pty dies', () => {
    const { api, store } = makeApi();
    api.create();
    spawned[0].proc.exit();
    expect(store.load()).toEqual([]);
  });

  it('forgets the conversation of a killed session, so a reused id starts clean', async () => {
    const { api, store } = makeApi();
    const state = api.create();
    fs.mkdirSync(path.dirname(store.sidPath(state.id)), { recursive: true });
    fs.writeFileSync(store.sidPath(state.id), UUID);
    await new Promise(resolve => api.destroy(state.id, resolve));
    expect(store.readSid(state.id)).toBeNull();
  });

  it('tells the launcher where to record its uuid', () => {
    const { api, store } = makeApi();
    const state = api.create();
    expect(spawned[0].env.PD_SID_FILE).toBe(store.sidPath(state.id));
  });
});

describe('restore', () => {
  it('does nothing on a first boot', () => {
    const { api } = makeApi();
    expect(api.restore()).toEqual([]);
    expect(api.list()).toEqual([]);
  });

  it('brings back every session under its original id', () => {
    const first = makeApi();
    first.api.create();
    first.api.create();

    const second = makeApi();
    expect(second.api.restore()).toEqual(['main-1', 'main-2']);
    expect(second.api.list().map(s => s.id)).toEqual(['main-1', 'main-2']);
  });

  it('never hands a restored id out again', () => {
    const first = makeApi();
    first.api.create();
    first.api.create();

    const second = makeApi();
    second.api.restore();
    // Regression guard: a fresh +New after a restart must not collide with a
    // restored tab, which create() would silently resolve by returning the
    // existing session and leaving the user with no new tab at all.
    expect(second.api.create().id).toBe('main-3');
  });

  it('keeps going when one session cannot be respawned', () => {
    const first = makeApi();
    first.api.create();
    first.api.create();

    const store = createSessionStore({ dir, logger });
    let call = 0;
    const api = createSessionsApi({
      store, projectsDir, logger,
      spawnPty: () => {
        if (call++ === 0) throw new Error('tmux exploded');
        return fakePty();
      },
    });
    expect(api.restore()).toEqual(['main-2']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('main-1'));
    // The roster is rewritten so the dead entry does not haunt the next boot.
    expect(store.load()).toEqual([{ id: 'main-2' }]);
  });

  it('reattaches rather than duplicating: the tmux args say new-session -A', () => {
    const first = makeApi();
    first.api.create();
    const second = makeApi();
    second.api.restore();
    const args = buildTmuxSpawnArgs('main-1', buildSessionCommand(), { env: spawned[1].env });
    expect(args).toContain('-A');
    expect(args).toContain('-e');
    expect(args).toContain(`PD_SID_FILE=${spawned[1].env.PD_SID_FILE}`);
    // The command must stay last: tmux reads everything after it as arguments.
    expect(args[args.length - 1]).toBe(buildSessionCommand());
  });
});

describe('resuming an interrupted conversation', () => {
  // The prompt reaches Claude as a command-line argument, not as keystrokes:
  // typing into a resuming TUI loses a race that has no ready signal to wait
  // for (see the comment on RESUME_PROMPT in server.js). So what a restore has
  // to get right is the ENV it hands pd-claude-session.
  function restoreWith(records, { autoContinue = true } = {}) {
    const first = makeApi();
    const state = first.api.create();
    const store = createSessionStore({ dir, logger });
    fs.mkdirSync(path.dirname(store.sidPath(state.id)), { recursive: true });
    fs.writeFileSync(store.sidPath(state.id), UUID);
    if (records) writeTranscript(UUID, records);

    const second = makeApi();
    second.api.restore({ autoContinue });
    return spawned[spawned.length - 1];
  }

  it('asks a session that was mid-turn to carry on', () => {
    expect(restoreWith(BUSY).env.PD_RESUME_PROMPT).toBe('continue please');
  });

  it('leaves a session that was waiting on the user completely alone', () => {
    expect(restoreWith(IDLE).env).not.toHaveProperty('PD_RESUME_PROMPT');
  });

  it('says nothing when there is no transcript to judge', () => {
    expect(restoreWith(null).env).not.toHaveProperty('PD_RESUME_PROMPT');
  });

  it('says nothing when the user interrupted on purpose', () => {
    const interrupted = [
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use' }] } },
      { type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } },
    ];
    expect(restoreWith(interrupted).env).not.toHaveProperty('PD_RESUME_PROMPT');
  });

  it('never prompts a brand-new session', () => {
    const { api } = makeApi();
    api.create();
    expect(spawned[0].env).not.toHaveProperty('PD_RESUME_PROMPT');
  });

  it('still hands over the sid file when it prompts', () => {
    // Both halves travel together: without PD_SID_FILE the launcher has no
    // conversation to resume, so a prompt on its own would open a blank one.
    const spawn = restoreWith(BUSY);
    expect(spawn.env.PD_SID_FILE).toMatch(/main-1\.uuid$/);
  });

  it('warns instead of continuing when the shutdown was NOT clean', () => {
    // The container died rather than being restarted on purpose, and the
    // likeliest cause of that is the work itself. Resuming is fine; telling it
    // to carry on means repeating whatever killed the box.
    const prompt = restoreWith(BUSY, { autoContinue: false }).env.PD_RESUME_PROMPT;
    expect(prompt).toContain('unexpected shutdown');
    expect(prompt).toMatch(/do NOT simply retry/i);
    expect(prompt).not.toBe('continue please');
  });

  it('still resumes the conversation after an unclean shutdown', () => {
    // Only the continuing is gated. Throwing away the context would be its own
    // kind of damage.
    const spawn = restoreWith(BUSY, { autoContinue: false });
    expect(spawn.env.PD_SID_FILE).toMatch(/main-1\.uuid$/);
  });

  it('says nothing to an idle session however it went down', () => {
    expect(restoreWith(IDLE, { autoContinue: false }).env).not.toHaveProperty('PD_RESUME_PROMPT');
  });

  it('defaults to the cautious branch when the caller says nothing', () => {
    // restore() with no argument must not auto-continue: an unclean exit is the
    // case where the caller has no marker to hand us.
    const first = makeApi();
    const state = first.api.create();
    const store = createSessionStore({ dir, logger });
    fs.mkdirSync(path.dirname(store.sidPath(state.id)), { recursive: true });
    fs.writeFileSync(store.sidPath(state.id), UUID);
    writeTranscript(UUID, BUSY);

    const second = makeApi();
    second.api.restore();
    expect(spawned[spawned.length - 1].env.PD_RESUME_PROMPT).not.toBe('continue please');
  });

  it('puts the prompt somewhere tmux will actually deliver it', () => {
    // A plain pty env var would be dropped: the tmux server outlives the client
    // and only forwards what `update-environment` names. It has to be `-e`.
    const spawn = restoreWith(BUSY);
    const args  = buildTmuxSpawnArgs('main-1', buildSessionCommand(), { env: spawn.env });
    expect(args).toContain('-e');
    expect(args).toContain('PD_RESUME_PROMPT=continue please');
    expect(args.indexOf('PD_RESUME_PROMPT=continue please')).toBeLessThan(args.length - 1);
  });
});

describe('the command tmux is told to run', () => {
  it('quotes the launcher path, so a checkout dir with spaces still starts', () => {
    const cmd = buildSessionCommand();
    expect(cmd).toMatch(/^'.*pd-claude-session' /);
    expect(cmd).toContain('claude --dangerously-skip-permissions');
  });

  it('tells the launcher where transcripts live, so it and the server agree', () => {
    // Divergence here is invisible and nasty: the launcher would decide there
    // is nothing to resume while the server decides the session was mid-turn.
    const { api } = makeApi();
    api.create();
    expect(spawned[0].env.PD_CLAUDE_PROJECTS_DIR).toBe(projectsDir);
  });
});

describe('with a custom SHELL_CMD', () => {
  // Resume machinery must switch off entirely for a command that is not Claude
  // — this is what keeps the `cat`-based e2e fixture working, and what stops
  // --resume being bolted onto an arbitrary program.
  async function loadWith(env) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    // resetModules above forces a fresh evaluation, so the module-level env
    // reads (RESUME_ENABLED, CMD) pick up the stubs.
    return import('../../server.js');
  }

  afterEach(() => vi.unstubAllEnvs());

  it('falls back to the plain restart loop and never mentions the launcher', async () => {
    const { buildSessionCommand: build } = await loadWith({ SHELL_CMD: 'cat' });
    const cmd = build();
    expect(cmd).toContain('while true; do cat;');
    expect(cmd).not.toContain('pd-claude-session');
  });

  it('honours PD_RESUME=0 even when pocket-dev owns the command line', async () => {
    const { buildSessionCommand: build } = await loadWith({ PD_RESUME: '0' });
    const cmd = build();
    expect(cmd).not.toContain('pd-claude-session');
    expect(cmd).toContain('while true;');
  });
});
