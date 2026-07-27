const express  = require('express');
const fs       = require('fs');
const http     = require('http');
const os       = require('os');
const path     = require('path');
const pty      = require('node-pty');
const { exec, execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const { SAFE_ID } = require('./safeId');
const { createSessionStore, nullSessionStore } = require('./sessionStore');
const claudeSession = require('./claudeSession');

const SESSION_BASE = process.env.TMUX_SESSION || 'main';
const DEFAULT_CMD  = 'claude --dangerously-skip-permissions --model "opus[1m]"';
const CMD          = process.env.SHELL_CMD    || DEFAULT_CMD;
const PORT         = parseInt(process.env.PORT, 10) || 7681;
const MAX_REPLAY_BYTES = 512 * 1024;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

const LOOP_CMD       = `bash -c 'while true; do ${CMD}; echo ; echo restarting...; sleep 1; done'`;
const TMUX_CONF_PATH = path.join(__dirname, 'tmux.conf');
const LAUNCHER_PATH  = path.join(__dirname, 'pd-claude-session');

// One HOME authority. It is also the cwd every session is spawned with, which
// matters for resume: `claude --resume` only finds conversations belonging to
// the current directory's project.
const HOME = process.env.HOME || os.homedir();

// Where the session roster and the per-session Claude uuids live. Bind-mount
// this to survive a container RECREATE (an image update); without a mount it
// still survives a restart, which is the common case.
const STATE_DIR    = process.env.PD_STATE_DIR || path.join(HOME, '.pocket-dev');
const PROJECTS_DIR = process.env.PD_CLAUDE_PROJECTS_DIR || path.join(HOME, '.claude', 'projects');

// Conversation resume is only wired up when pocket-dev owns the command line.
// A custom SHELL_CMD is not necessarily Claude (the e2e fixture runs `cat`),
// and bolting --resume/--session-id onto an arbitrary command is nonsense.
// PD_RESUME=0 turns it off outright.
const RESUME_ENABLED = !process.env.SHELL_CMD && process.env.PD_RESUME !== '0';

// What a restored session that was mid-turn is asked, so it picks the work back
// up instead of sitting there waiting for a human who thinks it is still going.
//
// It is handed to Claude as a command-line prompt (`claude --resume <id> "..."`)
// rather than typed into the terminal. Measured 2026-07-24 against the real
// thing: typing it in loses the race, because a resuming Claude paints, pauses
// while it initialises, then repaints, and anything typed into that gap is
// swallowed with no error. There is no ready signal to wait for, so DO NOT
// "fix" this by writing to the pty after a settle timeout. The command-line
// prompt is queued by Claude itself and survives even the workspace-trust gate.
const RESUME_PROMPT = process.env.PD_RESUME_NUDGE ?? 'continue please';

// The same situation, except the container DIED rather than being restarted on
// purpose. A session is still resumed, because losing the context helps nobody,
// but it is emphatically NOT told to carry on: the likeliest cause of an
// unexplained death is the work itself (an out-of-memory build being the
// classic), and "continue please" there means doing the thing that killed the
// box a second time. So it is warned instead, and asked to check before it
// retries. Set PD_CRASH_NUDGE='' to restore in silence.
const CRASH_PROMPT = process.env.PD_CRASH_NUDGE ?? (
  'pocket-dev came back from an unexpected shutdown, so this session was cut off mid-task. '
  + 'Do NOT simply retry what you were doing: it may be what brought the container down, '
  + 'for example by running the host out of memory. Work out whether that is likely first, '
  + 'and if it is, take a different approach rather than repeating it.'
);

function buildTmuxSpawnArgs(session, sessionCmd, { env = {} } = {}) {
  // `-e KEY=value` sets the tmux SESSION environment. It has to go this way
  // round rather than through the pty's own env: tmux's server outlives any one
  // client and only forwards the variables named in `update-environment`, so a
  // custom var set on the client is dropped before the command ever runs.
  const envArgs = [];
  for (const [key, value] of Object.entries(env)) envArgs.push('-e', `${key}=${value}`);
  return [
    '-u',
    '-f', TMUX_CONF_PATH,
    'new-session', '-A', '-s', session,
    ...envArgs,
    sessionCmd,
  ];
}

// The command tmux runs for a session.
//
// With Claude (the default), pd-claude-session owns the restart loop, because
// the resume-or-start-fresh decision has to be remade on every iteration of it
// — see the contract comment in that script. With a custom SHELL_CMD we keep
// the original inline loop untouched.
function buildSessionCommand() {
  return RESUME_ENABLED ? `'${LAUNCHER_PATH}' ${CMD}` : LOOP_CMD;
}

function spawnTmuxPty({ session, command, env, cols, rows }) {
  return pty.spawn('tmux', buildTmuxSpawnArgs(session, command, { env }), {
    name: 'xterm-256color',
    cols,
    rows,
    cwd:  HOME,
    env:  { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
}

function createApp({ sessionsApi } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/xterm',           express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
  app.use('/addon-fit',       express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));

  if (sessionsApi) {
    // Validate body.session against SAFE_ID and resolve to state — or short-circuit
    // with the right 400/404 if missing/unknown. Attaches `req.session` for the handler.
    function requireSession(req, res, next) {
      const session = req.body && req.body.session;
      if (!session || !SAFE_ID.test(session))
        return res.status(400).json({ error: 'session required' });
      const state = sessionsApi.get(session);
      if (!state) return res.status(404).json({ error: 'session not found' });
      req.session = state;
      next();
    }

    app.get('/sessions', (req, res) => {
      // describe(), not list(): the browser wants each session's title and
      // state, not just its id. list() stays cheap because it is also what
      // gets written to the roster on every create and destroy.
      res.json(sessionsApi.describe());
    });

    app.post('/sessions', (req, res) => {
      const state = sessionsApi.create();
      res.json({ id: state.id });
    });

    app.delete('/sessions/:id', (req, res) => {
      if (!SAFE_ID.test(req.params.id))
        return res.status(400).json({ error: 'invalid session id' });
      sessionsApi.destroy(req.params.id, (ok) => res.json({ ok }));
    });

    app.post('/send', requireSession, (req, res) => {
      const { text } = req.body;
      if (typeof text !== 'string' || !text.length)
        return res.status(400).json({ error: 'text required' });
      req.session.pty.write(text);
      req.session.pty.write('\r');
      res.json({ ok: true });
    });

    app.post('/key', requireSession, (req, res) => {
      const { key } = req.body;
      const ctrlMatch = key && key.match(/^ctrl-([a-z])$/);
      if (ctrlMatch) {
        req.session.pty.write(String.fromCharCode(ctrlMatch[1].charCodeAt(0) - 96));
        return res.json({ ok: true });
      }
      const sequences = {
        escape: '\x1b', tab: '\t', enter: '\r',
        left: '\x1b[D', right: '\x1b[C', up: '\x1b[A', down: '\x1b[B',
      };
      const seq = sequences[key];
      if (!seq) return res.status(400).json({ error: 'unknown key' });
      req.session.pty.write(seq);
      res.json({ ok: true });
    });

    // Opening a session is what marks it read: it is the entire difference
    // between "waiting on you" and "read", and the transcript cannot tell them
    // apart. Kept server-side so it holds across every device.
    app.post('/viewed', requireSession, (req, res) => {
      res.json({ ok: sessionsApi.markViewed(req.session.id) });
    });

    app.post('/refresh', requireSession, (req, res) => {
      // tmux refresh-client targets clients, not sessions. List clients of
      // this session, then refresh each. SAFE_ID guard in requireSession
      // guarantees no shell metacharacters in `req.session.id`.
      exec(
        `tmux list-clients -t '${req.session.id}' -F '#{client_name}' | xargs -r -I{} tmux refresh-client -t {}`,
        { shell: '/bin/bash' },
        (err) => res.json({ ok: !err }),
      );
    });
  }

  return app;
}

function createSessionsApi({
  store       = nullSessionStore,
  spawnPty    = spawnTmuxPty,
  projectsDir = PROJECTS_DIR,
  logger      = console,
} = {}) {
  const sessions = new Map();
  let nextSeq = 1;

  // Ids we adopt at restore must never be handed out again by nextSessionId().
  const seqPattern = new RegExp(`^${SESSION_BASE.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}-(\\d+)$`);

  function nextSessionId() {
    return `${SESSION_BASE}-${nextSeq++}`;
  }

  function noteId(id) {
    const match = id.match(seqPattern);
    if (match) nextSeq = Math.max(nextSeq, parseInt(match[1], 10) + 1);
  }

  function persist() {
    store.save(list());
  }

  function appendToReplay(state, data) {
    state.replayBuffer += data;
    if (state.replayBuffer.length > MAX_REPLAY_BYTES * 1.5) {
      const start = state.replayBuffer.length - MAX_REPLAY_BYTES;
      const nlPos = state.replayBuffer.indexOf('\n', start);
      state.replayBuffer = state.replayBuffer.slice(nlPos >= 0 ? nlPos + 1 : start);
    }
  }

  // `resumePrompt` is passed through to pd-claude-session, which appends it to
  // `claude --resume` when (and only when) it actually resumes a conversation.
  function create(id = nextSessionId(), { resumePrompt = null } = {}) {
    if (sessions.has(id)) return sessions.get(id);
    noteId(id);

    // Where this session's conversation already stood before we adopted it.
    // Cheap: metaFor is memoised, and for a session with no recorded uuid (any
    // brand new tab) it answers without touching the disk.
    const { status: initialStatus, turnId: initialTurnId } = observe(id);

    const sidFile = store.sidPath(id);
    // The launcher decides whether a transcript exists and the server decides
    // what state it was in, so they MUST agree on where transcripts live. Pass
    // the resolved directory rather than letting the shell script re-derive it
    // from $HOME, which would silently diverge under PD_CLAUDE_PROJECTS_DIR.
    const env = { PD_CLAUDE_PROJECTS_DIR: projectsDir };
    if (sidFile) env.PD_SID_FILE = sidFile;
    if (resumePrompt) env.PD_RESUME_PROMPT = resumePrompt;

    const ptyProc = spawnPty({
      session: id,
      command: buildSessionCommand(),
      env,
      cols:    DEFAULT_COLS,
      rows:    DEFAULT_ROWS,
    });

    const state = {
      id,
      pty: ptyProc,
      replayBuffer: '',
      clients: new Set(),
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      // The unread axis, server-side so every device agrees.
      //
      // It COUNTS rather than timing. Wall-clock comparison looked fine and was
      // wrong: something landing in the SAME millisecond as a view compares
      // equal and gets swallowed, and no ordering of > or >= fixes that,
      // because the timestamps genuinely cannot distinguish "arrived just
      // before you looked" from "just after". A monotonic counter can, exactly,
      // and owes nothing to clock resolution or a clock that steps.
      //
      // What it counts is TURNS, not bytes — see noteTurn. Bytes were the first
      // implementation and they are the wrong unit: a TUI coder emits a stream
      // of frames while it thinks, so every thought re-flagged the session as
      // having something to read, and Jake reported exactly that (2026-07-27).
      // A session's byte count is a measure of how much it is painting, which
      // is not related to whether anything happened that a human needs to see.
      //
      // Both counters restart at zero with the process, so after a restart
      // nothing is unread until the session actually finishes something new.
      // That is deliberate: the pty history is gone anyway, and resurfacing
      // five sessions you already dealt with would be noise. A session left
      // holding a QUESTION still surfaces, because 'asking' does not travel on
      // this axis at all (see describe).
      attentionSeq: 0,
      viewedSeq: 0,
      // Last status we OBSERVED, and the turn it was decided from. Seeded at
      // create so a session that was already finished before this process
      // existed is not reported as newly-finished the first time we look.
      status: initialStatus,
      turnId: initialTurnId,
      // Display only: how long ago the session last said anything.
      lastOutputAt: 0,
    };

    ptyProc.onData(data => {
      state.lastOutputAt = Date.now();
      // Bytes move the unread axis ONLY for a session we cannot classify: no
      // transcript (a brand new tab), or a custom SHELL_CMD that is not Claude
      // at all. There, output is the only evidence of anything happening that
      // exists. For a Claude session noteTurn owns this, so a repaint or a
      // thinking frame cannot make the session claim it wants you.
      if (state.status === 'unknown') state.attentionSeq += 1;
      appendToReplay(state, data);
      for (const ws of state.clients) {
        if (ws.readyState === 1) ws.send(data);
      }
    });

    ptyProc.onExit(() => {
      // PTY died (e.g. tmux session killed externally). Drop state and close clients.
      sessions.delete(id);
      forgetMeta(id);
      store.clearSid(id);
      persist();
      for (const ws of state.clients) {
        try { ws.close(); } catch {}
      }
    });

    sessions.set(id, state);
    persist();
    return state;
  }

  // Bring back the sessions a previous process was hosting.
  //
  // `autoContinue` says whether the last shutdown was deliberate. It gates only
  // the prompt, never the restore: tabs and conversations come back either way,
  // but work only restarts by itself after a shutdown somebody asked for. See
  // sessionStore's markCleanShutdown for why unclean is the default.
  //
  // Two failure cases, one code path: if the tmux session is still alive (node
  // restarted, container did not) the `new-session -A` in buildTmuxSpawnArgs
  // reattaches to it with its scrollback and running Claude intact; if the
  // container restarted, tmux is gone and the same call creates it fresh, with
  // pd-claude-session resuming the conversation from its recorded uuid. Either
  // way the tabs come back under the SAME ids, so a browser left open across
  // the outage reconnects into them instead of showing dead panes.
  function restore({ autoContinue = false } = {}) {
    const restored = [];
    for (const entry of store.load()) {
      try {
        // Read the uuid BEFORE spawning: the launcher may mint a new one, and
        // the question being asked here is about the conversation that DIED.
        //
        // Via metaFor, not claudeSession.statusOf, so this read and the one
        // create() makes to seed the session's unread axis are the SAME read.
        // Two independent reads could disagree if a turn landed between them,
        // and the session would then look newly-finished the first time anyone
        // opened the list after a restart.
        const uuid   = RESUME_ENABLED ? store.readSid(entry.id) : null;
        const status = metaFor(uuid).status;

        // 'unknown' never prompts — see claudeSession.js. Only a conversation
        // we can positively see was mid-turn gets asked to carry on; one that
        // was waiting on the user comes back and goes on waiting, which is the
        // whole point of classifying instead of always continuing.
        //
        // 'asking' must not prompt either, and it is the sharper case: the
        // pending record is a question put to the user, so "continue please"
        // would arrive as the answer to it and Claude would act on a choice the
        // user never made.
        const resumePrompt = status === 'busy'
          ? (autoContinue ? RESUME_PROMPT : CRASH_PROMPT)
          : null;
        create(entry.id, { resumePrompt: resumePrompt || null });
        restored.push(entry.id);

        if (status !== 'busy') {
          if (status === 'idle')   logger.log(`session ${entry.id}: was waiting on the user, restored as-is`);
          if (status === 'asking') logger.log(`session ${entry.id}: was waiting for an answer to a question, restored as-is`);
        } else if (autoContinue) {
          logger.log(`session ${entry.id}: was mid-turn, resuming with "${resumePrompt}"`);
        } else {
          logger.log(`session ${entry.id}: was mid-turn but the last shutdown was NOT clean, resuming without continuing the work`);
        }
      } catch (err) {
        // One bad session must not stop the server from coming up.
        logger.warn(`failed to restore session ${entry.id}: ${err.message}`);
      }
    }
    // Rewrite the roster so any session that failed to restore drops out of it.
    persist();
    return restored;
  }

  function destroy(id, cb) {
    const state = sessions.get(id);
    if (!state) return cb && cb(false);
    // Remove from map first so concurrent attachWs/list calls don't pick up a dying session.
    sessions.delete(id);
    // Drop the recorded conversation too: ids are reused across restarts, and a
    // future `main-1` must not resume a conversation the user deliberately killed.
    forgetMeta(id);
    store.clearSid(id);
    persist();
    for (const ws of state.clients) {
      try { ws.close(); } catch {}
    }
    // Kill the tmux session (the pty is just the client; tmux server persists otherwise).
    execFile('tmux', ['kill-session', '-t', id], () => {
      try { state.pty.kill(); } catch {}
      if (cb) cb(true);
    });
  }

  function get(id) {
    return sessions.get(id);
  }

  // Someone looked at this session. Recorded here rather than in the browser so
  // reading a session on the phone also clears it on the desktop.
  //
  // It OBSERVES before it catches up, and that ordering is load-bearing. The
  // unread axis only advances when someone reads the transcript, so a turn that
  // finished since the last poll has not been counted yet. Catching up first
  // would bank a count that does not include it, and the next poll would then
  // announce a turn the user has already read — reachable in the two-second
  // window between a turn ending and the next poll, which is exactly when
  // someone who was waiting opens the session.
  function markViewed(id) {
    const state = sessions.get(id);
    if (!state) return false;
    noteTurn(state, observe(id));
    state.viewedSeq = state.attentionSeq;
    return true;
  }

  function list() {
    return [...sessions.values()].map(s => ({ id: s.id, cols: s.cols, rows: s.rows }));
  }

  // Transcript metadata, memoised against the file's mtime and size.
  //
  // Without this, every GET /sessions would re-read a tail window per session,
  // and the session list polls. A transcript only ever grows, so mtime plus
  // size is a sound cache key: any new turn moves both. Re-resolving the path
  // is also skipped while it still points at a real file, since findTranscript
  // scans the project directories.
  const metaCache = new Map();

  // Frozen because metaFor hands the SAME object to every caller that has
  // nothing to read; a caller that decided to annotate its copy would be
  // editing every other session's answer.
  const NO_META = Object.freeze({ status: 'unknown', turnId: null, title: null, lastPrompt: null });

  function metaFor(uuid) {
    if (!uuid) return NO_META;

    const cached = metaCache.get(uuid);
    let file = cached && cached.file;
    let stat = null;
    if (file) {
      try { stat = fs.statSync(file); } catch { file = null; }
    }
    if (!file) {
      file = claudeSession.findTranscript(uuid, { projectsDir });
      if (!file) return NO_META;
      try { stat = fs.statSync(file); } catch { return NO_META; }
    }

    if (cached && cached.file === file && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.value;
    }
    const value = claudeSession.inspectTranscript(file);
    metaCache.set(uuid, { file, mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  }

  // Fold a fresh reading of a session's conversation into its unread axis.
  //
  // One turn that wants the user is one thing to read, however many frames it
  // painted getting there. `turnId` is the deciding record's uuid, so this fires
  // once per turn and cannot be fooled by a repaint (which does not touch the
  // transcript) or by the bookkeeping records Claude appends between turns
  // (which are not message records, so they never become the deciding one).
  //
  // Comparing the turn rather than the status is what closes the gap where a
  // whole turn starts and finishes between two polls: two consecutive finished
  // turns read as 'idle' both times, but they are different records.
  //
  // 'asking' counts here too, so a question that arrives while you are
  // elsewhere lights the badge like any other finished turn. It does not stop
  // there, though: describe reports the status as well, and a pending question
  // outranks the unread axis on the client, because looking at a question is not
  // answering it.
  //
  // A change, and only a change, is news. What stops a restart from declaring
  // every finished session unread is that create() SEEDS status and turnId from
  // the same read, so the first look after adopting a session compares equal.
  // DO NOT add a "skip the first observation" special case on top of that: the
  // seed is the mechanism, and a second one hides real transitions (measured —
  // a null-turnId guard here suppressed every transition in a transcript whose
  // records carry no uuid).
  function noteTurn(state, meta) {
    if (meta.status === state.status && meta.turnId === state.turnId) return;
    if (claudeSession.WANTS_USER.has(meta.status)) state.attentionSeq += 1;
    state.status = meta.status;
    state.turnId = meta.turnId;
  }

  // What a session's conversation says right now. The one place that decides
  // whether we are allowed to look at all: with a custom SHELL_CMD there is no
  // conversation, and create/describe/markViewed must not each re-decide that.
  function observe(id) {
    return RESUME_ENABLED ? metaFor(store.readSid(id)) : NO_META;
  }

  // Evict a dead session's memo entry. Called while the sid file still exists,
  // because the uuid IS the cache key and clearSid destroys the only record of
  // it. Without this the cache is append-only for the life of the process: every
  // session ever killed keeps its title and preview resident, and a long-lived
  // container churns through plenty of them.
  function forgetMeta(id) {
    const uuid = store.readSid(id);
    if (uuid) metaCache.delete(uuid);
  }

  // What the browser gets: the roster plus what each session actually IS.
  // `title` is null for a session whose conversation has not been written yet
  // (a tab created seconds ago) and for any session pocket-dev does not own the
  // command line for; the client falls back rather than inventing a name.
  //
  // This is a GET handler's body and it MUTATES, which is worth being explicit
  // about: reading each transcript is the only moment pocket-dev learns that a
  // turn ended, so it is also where the unread axis advances. The alternative, a
  // server-side timer polling every transcript on its own schedule, buys
  // nothing — nobody can be waiting on an answer that no browser has asked for
  // — and costs a wakeup per session forever.
  function describe() {
    return [...sessions.values()].map(s => {
      const meta = observe(s.id);
      noteTurn(s, meta);
      return {
        id: s.id,
        cols: s.cols,
        rows: s.rows,
        title: meta.title,
        lastPrompt: meta.lastPrompt,
        status: meta.status,
        unread: s.attentionSeq > s.viewedSeq,
        lastOutputAt: s.lastOutputAt,
      };
    });
  }

  function attachWs(ws, sessionId) {
    const state = sessions.get(sessionId);
    if (!state) {
      try { ws.close(4404, 'session not found'); } catch {}
      return;
    }
    state.clients.add(ws);
    if (state.replayBuffer.length > 0) ws.send(state.replayBuffer);

    ws.on('message', data => {
      const msg = data.toString();
      if (msg.startsWith('{')) {
        try {
          const parsed = JSON.parse(msg);
          if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
            const newCols = Math.max(1, parsed.cols);
            const newRows = Math.max(1, parsed.rows);
            if (newCols !== state.cols || newRows !== state.rows) {
              state.cols = newCols;
              state.rows = newRows;
              state.pty.resize(newCols, newRows);
            }
          }
        } catch {}
      } else {
        state.pty.write(msg);
      }
    });

    ws.on('close', () => state.clients.delete(ws));
  }

  return { create, restore, destroy, get, list, describe, markViewed, attachWs };
}

module.exports = {
  buildTmuxSpawnArgs,
  buildSessionCommand,
  createApp,
  createSessionsApi,
  TMUX_CONF_PATH,
  LAUNCHER_PATH,
  SAFE_ID,
};

if (require.main === module) {
  startServer();
}

function startServer() {
  const store       = createSessionStore({ dir: STATE_DIR });
  const sessionsApi = createSessionsApi({ store });

  // Ask, once, whether the previous process meant to stop, then arrange to
  // leave that answer behind for the next one. Reading it clears it, so a
  // subsequent crash cannot inherit this shutdown's good name.
  const cleanExit = store.consumeCleanShutdown();
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      store.markCleanShutdown();
      process.exit(0);
    });
  }
  console.log(cleanExit
    ? 'previous shutdown was clean; interrupted work may resume itself'
    : 'no clean-shutdown marker; interrupted sessions will be restored but NOT continued');

  // Restore BEFORE listening. A browser left open across the outage retries its
  // WebSocket every couple of seconds; if it lands before the sessions exist it
  // gets a 4404 and has to resync, which is a visible flicker of dead tabs.
  const restored = sessionsApi.restore({ autoContinue: cleanExit });
  if (restored.length) console.log(`restored ${restored.length} session(s): ${restored.join(', ')}`);

  const app    = createApp({ sessionsApi });
  const server = http.createServer(app);
  const wss    = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host}`);
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const sessionId = url.searchParams.get('session');
    if (!sessionId || !SAFE_ID.test(sessionId)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => sessionsApi.attachWs(ws, sessionId));
  });

  server.listen(PORT, '0.0.0.0', () =>
    console.log(`pocket-dev on :${PORT}  (base session: ${SESSION_BASE}  cmd: ${CMD}  state: ${store.file})`));
}
