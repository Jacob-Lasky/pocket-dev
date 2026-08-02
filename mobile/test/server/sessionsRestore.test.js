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

// Re-evaluate server.js with env stubs in place. CMD, RESUME_ENABLED and
// REMOTE_CONTROL are all read once at module level, so resetModules is the only
// way to see a different configuration. Shared by the SHELL_CMD and the
// Remote Control cases, which both need it.
async function loadWith(env) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import('../../server.js');
}

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
// A question put to the user. Blocked on a human, so it is neither busy nor
// merely finished, and it must never be told to continue.
const ASKING = [{ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'AskUserQuestion' }] } }];

// Turn records carrying their own uuid, which is what the unread axis compares.
const TURN_A = 'a1111111-1111-4111-8111-111111111111';
const TURN_B = 'b2222222-2222-4222-8222-222222222222';
const finished = (uuid) => ({ type: 'assistant', uuid, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'over to you' }] } });
const midTurn  = (uuid) => ({ type: 'assistant', uuid, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } });
const question = (uuid) => ({ type: 'assistant', uuid, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'AskUserQuestion' }] } });

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

  it('says nothing to a session holding a question — the prompt would answer it', () => {
    // The sharpest case for not nudging. The pending record is a question put to
    // the user, so "continue please" arrives AS the answer and Claude acts on a
    // choice nobody made. Both shutdown kinds, because neither makes it OK.
    expect(restoreWith(ASKING).env).not.toHaveProperty('PD_RESUME_PROMPT');
    expect(restoreWith(ASKING, { autoContinue: false }).env).not.toHaveProperty('PD_RESUME_PROMPT');
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

// The unread axis for a session whose conversation we CAN read. It advances per
// TURN, not per byte, and these are the guards for the three ways the byte
// version was wrong in production (all reported 2026-07-27).
describe('unread counts turns, not output', () => {
  // The sid file has to exist BEFORE create(), because create seeds the
  // session's status from it: a conversation that was already finished must not
  // read as newly-finished the first time anyone looks.
  function withConversation(records, { id = 'main-1' } = {}) {
    const store = createSessionStore({ dir, logger });
    fs.mkdirSync(path.dirname(store.sidPath(id)), { recursive: true });
    fs.writeFileSync(store.sidPath(id), UUID);
    if (records) writeTranscript(UUID, records);
    const { api } = makeApi();
    api.create(id);
    return { api, proc: spawned[spawned.length - 1].proc, id };
  }

  it('does not go unread while it is thinking, however much it paints', () => {
    // The reported bug: a TUI coder emits a frame per thought, and every frame
    // used to count as something new to read.
    const { api, proc } = withConversation([midTurn(TURN_A)]);
    for (let i = 0; i < 50; i++) proc.emit(`\x1b[2K frame ${i}`);
    const [session] = api.describe();
    expect(session.status).toBe('busy');
    expect(session.unread).toBe(false);
  });

  it('goes unread when a turn finishes', () => {
    const { api } = withConversation([midTurn(TURN_A)]);
    writeTranscript(UUID, [midTurn(TURN_A), finished(TURN_B)]);
    const [session] = api.describe();
    expect(session.status).toBe('idle');
    expect(session.unread).toBe(true);
  });

  it('stays read when a finished session merely repaints', () => {
    // The other reported bug: a session sitting there waiting reverted to
    // needing attention on its own. Anything that redraws the screen without
    // advancing the conversation must not move this.
    const { api, proc, id } = withConversation([midTurn(TURN_A)]);
    writeTranscript(UUID, [midTurn(TURN_A), finished(TURN_B)]);
    expect(api.describe()[0].unread).toBe(true);
    api.markViewed(id);

    for (let i = 0; i < 20; i++) proc.emit('\x1b[H\x1b[2J redrawn');
    expect(api.describe()[0].unread).toBe(false);
  });

  it('goes unread for a NEW finished turn even though the status did not change', () => {
    // Two consecutive finished turns both read 'idle'. Comparing status alone
    // would miss the second one whenever the busy phase fell between two polls,
    // so the comparison is against the deciding record's uuid.
    const { api, id } = withConversation([finished(TURN_A)]);
    expect(api.describe()[0].unread).toBe(false);
    api.markViewed(id);

    writeTranscript(UUID, [finished(TURN_A), { type: 'user', message: { role: 'user', content: 'and another thing' } }, finished(TURN_B)]);
    const [session] = api.describe();
    expect(session.status).toBe('idle');
    expect(session.unread).toBe(true);
  });

  it('reports a pending question as asking, and counts it as something new', () => {
    const { api } = withConversation([midTurn(TURN_A)]);
    writeTranscript(UUID, [midTurn(TURN_A), question(TURN_B)]);
    const [session] = api.describe();
    expect(session.status).toBe('asking');
    expect(session.unread).toBe(true);
  });

  it('keeps reporting asking after the session has been viewed', () => {
    // Looking at a question is not answering it. The unread axis clears, the
    // status does not, and the client leans on the status for exactly this.
    const { api, id } = withConversation([midTurn(TURN_A)]);
    writeTranscript(UUID, [midTurn(TURN_A), question(TURN_B)]);
    api.describe();
    api.markViewed(id);
    const [session] = api.describe();
    expect(session.unread).toBe(false);
    expect(session.status).toBe('asking');
  });

  it('is not unread on the first look at a conversation that was already finished', () => {
    // Restore's invariant: the pty history is gone, so a session you already
    // dealt with must not resurface just because this process is new.
    const { api } = withConversation([finished(TURN_A)]);
    const [session] = api.describe();
    expect(session.status).toBe('idle');
    expect(session.unread).toBe(false);
  });

  it('does not count output for a session it can classify', () => {
    // Bytes are the fallback for a session with no readable conversation, not a
    // second opinion on one that has one.
    const { api, proc, id } = withConversation([finished(TURN_A)]);
    api.markViewed(id);
    proc.emit('a stray repaint');
    expect(api.describe()[0].unread).toBe(false);
  });

  it('does not announce a turn the user opened the session to read', () => {
    // markViewed OBSERVES before it catches up. The unread axis only advances
    // when someone reads the transcript, so a turn that finished since the last
    // poll is uncounted at the moment the user opens the session; catching up
    // first would bank a total that excludes it, and the next poll would then
    // announce a turn already read. Reachable in the seconds between a turn
    // ending and the next poll, which is exactly when a waiting user shows up.
    const { api, id } = withConversation([midTurn(TURN_A)]);
    writeTranscript(UUID, [midTurn(TURN_A), finished(TURN_B)]);

    // No describe() in between: nobody has polled since the turn landed.
    api.markViewed(id);
    expect(api.describe()[0].unread).toBe(false);
  });

  it('forgets a killed session conversation metadata', async () => {
    // The memo cache is keyed by conversation uuid and was append-only: every
    // session ever killed kept its title and preview resident for the life of
    // the process.
    //
    // Proved behaviourally rather than by peering at the cache, by forcing a
    // cache-key COLLISION: the second transcript is written to the same byte
    // length and its mtime is put back, so {file, mtimeMs, size} is identical.
    // A surviving entry therefore answers with the stale title; an evicted one
    // has to re-read and sees the new one.
    const titleFile = path.join(projectsDir, '-home-claude', `${UUID}.jsonl`);
    const { api, id } = withConversation([{ type: 'ai-title', aiTitle: 'AAAAA' }, finished(TURN_A)]);
    expect(api.describe()[0].title).toBe('AAAAA');
    const { atime, mtime } = fs.statSync(titleFile);
    const sizeBefore = fs.statSync(titleFile).size;

    await new Promise(resolve => api.destroy(id, resolve));

    writeTranscript(UUID, [{ type: 'ai-title', aiTitle: 'BBBBB' }, finished(TURN_A)]);
    fs.utimesSync(titleFile, atime, mtime);
    expect(fs.statSync(titleFile).size).toBe(sizeBefore);   // the key really does collide

    // Same id, same conversation: what a restore looks like.
    const store = createSessionStore({ dir, logger });
    fs.writeFileSync(store.sidPath(id), UUID);
    api.create(id);
    expect(api.describe()[0].title).toBe('BBBBB');
  });

  it('reads the sid file BEFORE clearing it when a session is destroyed', () => {
    // The uuid IS the cache key, and clearSid destroys the only record of it, so
    // reordering these two lines turns eviction into a silent no-op. Nothing
    // observable breaks, which is exactly why it gets a test.
    const real  = createSessionStore({ dir, logger });
    const calls = [];
    const store = {
      ...real,
      readSid:  (sid) => { calls.push(`readSid:${sid}`);  return real.readSid(sid); },
      clearSid: (sid) => { calls.push(`clearSid:${sid}`); return real.clearSid(sid); },
    };
    const api = createSessionsApi({
      store, projectsDir, logger,
      spawnPty: (opts) => { const proc = fakePty(); spawned.push({ ...opts, proc }); return proc; },
    });
    const state = api.create();
    calls.length = 0;
    api.destroy(state.id, () => {});

    expect(calls.indexOf(`readSid:${state.id}`)).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf(`readSid:${state.id}`)).toBeLessThan(calls.indexOf(`clearSid:${state.id}`));
  });
});

describe('read/unread, server-side so devices agree', () => {
  it('a session that has produced output nobody has opened is unread', () => {
    const { api } = makeApi();
    api.create();
    spawned[0].proc.emit('claude says something');
    expect(api.describe()[0].unread).toBe(true);
  });

  it('marking it viewed clears it', () => {
    const { api } = makeApi();
    const state = api.create();
    spawned[0].proc.emit('output');
    expect(api.markViewed(state.id)).toBe(true);
    expect(api.describe()[0].unread).toBe(false);
  });

  it('output after the last view makes it unread again', () => {
    const { api } = makeApi();
    const state = api.create();
    spawned[0].proc.emit('first');
    api.markViewed(state.id);
    spawned[0].proc.emit('and then more');
    expect(api.describe()[0].unread).toBe(true);
  });

  it('a session that has said nothing is not unread', () => {
    const { api } = makeApi();
    api.create();
    expect(api.describe()[0].unread).toBe(false);
  });

  it('markViewed on an unknown session is a no-op, not a throw', () => {
    const { api } = makeApi();
    expect(api.markViewed('main-99')).toBe(false);
  });

  it('starts a restart with nothing unread', () => {
    // Both counters restart with the process. The pty history is gone anyway,
    // so resurfacing sessions you already dealt with would be pure noise.
    const first = makeApi();
    const state = first.api.create();
    spawned[0].proc.emit('output');
    first.api.markViewed(state.id);

    const second = makeApi();
    second.api.restore();
    expect(second.api.describe()[0].unread).toBe(false);
  });

  it('counts output rather than timing it', () => {
    // Regression guard for a real defect: comparing wall-clock timestamps
    // swallowed output that landed in the same millisecond as the view, and no
    // choice of > or >= fixes that because the timestamps cannot tell "just
    // before you looked" from "just after".
    const { api } = makeApi();
    const state = api.create();
    api.markViewed(state.id);
    spawned[0].proc.emit('same millisecond as the view');
    expect(api.describe()[0].unread).toBe(true);
  });

  it('surfaces output that arrived after the restart', () => {
    const first = makeApi();
    const state = first.api.create();
    first.api.markViewed(state.id);

    const second = makeApi();
    second.api.restore();
    spawned[spawned.length - 1].proc.emit('something new');
    expect(second.api.describe()[0].unread).toBe(true);
  });
});

describe('the command tmux is told to run', () => {
  // The PD_REMOTE_CONTROL case stubs env and reloads the module; without this
  // the stub leaks into every test that runs after it.
  afterEach(() => vi.unstubAllEnvs());

  it('quotes the launcher path, so a checkout dir with spaces still starts', () => {
    const cmd = buildSessionCommand();
    expect(cmd).toMatch(/^'.*pd-claude-session' /);
    expect(cmd).toContain('claude --dangerously-skip-permissions');
  });

  it('turns Remote Control on, so a tab can be driven from the phone', () => {
    // Source-level guard, for the same reason tmuxConf.test.js is one: the
    // bridge needs a real logged-in account and a round trip to claude.ai, so
    // the cat-based e2e suite cannot reach this at all.
    //
    // It has to be the flag. Measured 2026-08-02 on Claude Code 2.1.220, the
    // documented `remoteControlAtStartup` user setting is read and then never
    // starts a bridge, so a future "simplify this into settings.json" is a
    // silent revert to no Remote Control.
    expect(buildSessionCommand()).toContain('--rc ');
  });

  it('spells it --rc, never -rc, which would parse as --resume', () => {
    // Commander reads a single-dash -rc as -r c, so the session would come up
    // hunting for a conversation called "c" instead of enabling anything.
    expect(buildSessionCommand()).not.toMatch(/(^|\s)-rc(\s|$)/);
  });

  it('keeps a flag directly after --rc, so it cannot eat the next argument', () => {
    // --rc takes an OPTIONAL session name. Left at the end of the command it
    // would swallow the first thing pd-claude-session appends and name the
    // Remote Control session after it.
    const tokens = buildSessionCommand().split(/\s+/);
    const rc = tokens.indexOf('--rc');
    expect(rc).toBeGreaterThan(-1);
    expect(tokens[rc + 1]).toMatch(/^--/);
  });

  it('honours PD_REMOTE_CONTROL=0, because a bridged tab is drivable by the account', () => {
    // Every other thing pocket-dev does to a session on the operator's behalf
    // has an off switch (PD_RESUME, PD_TRUST_WORKSPACE). Registering with the
    // bridge is the one that most needs one, and the flag lives in the image,
    // so without this the only way out is a rebuild.
    return loadWith({ PD_REMOTE_CONTROL: '0' }).then(({ buildSessionCommand: build }) => {
      const cmd = build();
      expect(cmd).not.toContain('--rc');
      expect(cmd).not.toContain('remote-control');
      // Still Claude, still resuming: the knob turns off Remote Control only.
      expect(cmd).toContain('claude --dangerously-skip-permissions');
      expect(cmd).toContain('pd-claude-session');
    });
  });

  it('names Remote Control sessions after pocket-dev, not the container id', () => {
    // Auto-generated names are <hostname>-<random words>, and the hostname here
    // is a docker id that is different after every recreate, so the phone would
    // show a fresh set of meaningless names each time the image is updated.
    expect(buildSessionCommand()).toContain('--remote-control-session-name-prefix pocket-dev');
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

describe('describe(): what the browser is told about each session', () => {
  const title  = (t) => ({ type: 'ai-title', aiTitle: t, sessionId: UUID });
  const prompt = (p) => ({ type: 'last-prompt', lastPrompt: p, sessionId: UUID });

  function withConversation(records) {
    const { api, store } = makeApi();
    const state = api.create();
    fs.mkdirSync(path.dirname(store.sidPath(state.id)), { recursive: true });
    fs.writeFileSync(store.sidPath(state.id), UUID);
    if (records) writeTranscript(UUID, records);
    return { api, store, id: state.id };
  }

  it('carries the conversation title, preview and status', () => {
    const { api } = withConversation([title('Restore sessions across restarts'), prompt('continue please'), ...BUSY]);
    expect(api.describe()).toEqual([{
      id: 'main-1', cols: 120, rows: 40,
      title: 'Restore sessions across restarts',
      lastPrompt: 'continue please',
      status: 'busy',
      unread: false,
      lastOutputAt: 0,
    }]);
  });

  it('reports nulls for a session whose conversation has not been written yet', () => {
    // A tab created a second ago. The client falls back rather than being
    // handed an invented name.
    const { api } = withConversation(null);
    expect(api.describe()[0]).toMatchObject({ title: null, lastPrompt: null, status: 'unknown' });
  });

  it('reports nulls for a session with no conversation id at all', () => {
    const { api } = makeApi();
    api.create();
    expect(api.describe()[0]).toMatchObject({ title: null, lastPrompt: null, status: 'unknown' });
  });

  it('keeps list() cheap and free of transcript reads', () => {
    // list() is what gets written to the roster on every create and destroy.
    // Pulling metadata in there would turn each persist into a pile of file IO.
    const { api } = withConversation([title('Something'), prompt('hi'), ...IDLE]);
    expect(api.list()).toEqual([{ id: 'main-1', cols: 120, rows: 40 }]);
  });

  it('re-reads only when the transcript actually changed', () => {
    const { api } = withConversation([title('Before'), prompt('one'), ...IDLE]);
    expect(api.describe()[0].title).toBe('Before');

    const spy = vi.spyOn(fs, 'openSync');
    api.describe();
    api.describe();
    expect(spy).not.toHaveBeenCalled();   // served from the mtime cache
    spy.mockRestore();
  });

  it('picks up a new title once the transcript moves on', () => {
    const { api } = withConversation([title('Before'), prompt('one'), ...IDLE]);
    expect(api.describe()[0].title).toBe('Before');

    // Same path, more content: mtime and size both move, so the cache misses.
    writeTranscript(UUID, [title('After'), prompt('two'), ...BUSY, { type: 'ai-title', aiTitle: 'After', pad: 'x'.repeat(64) }]);
    const after = api.describe()[0];
    expect(after.title).toBe('After');
    expect(after.status).toBe('busy');
  });

  it('survives a transcript that is deleted under it', () => {
    const { api } = withConversation([title('Doomed'), prompt('one'), ...IDLE]);
    expect(api.describe()[0].title).toBe('Doomed');
    fs.rmSync(path.join(projectsDir, '-home-claude', `${UUID}.jsonl`));
    expect(api.describe()[0]).toMatchObject({ title: null, status: 'unknown' });
  });
});
