const express  = require('express');
const fs       = require('fs');
const http     = require('http');
const os       = require('os');
const path     = require('path');
const pty      = require('node-pty');
const { setTimeout: delay } = require('node:timers/promises');
const { exec, execFile, spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');
const { SAFE_ID, UUID_RE } = require('./safeId');
const { createSessionStore, nullSessionStore } = require('./sessionStore');
const {
  PROVIDER_IDS, DEFAULT_PROVIDER, isProvider, labelFor,
  sessionKindFor, resolveInput,
  commandFor: providerCommand, resolveCapabilities, statusTracked,
} = require('./providers');
const claudeSession = require('./claudeSession');
const { normalizeCodexTurnStatus, classifyCodexTurnStatus } = require('./codexTurnStatus');

const SESSION_BASE = process.env.TMUX_SESSION || 'main';
// Remote Control is on by default, so a session can also be driven from
// claude.ai or the Claude mobile app. Reaching pocket-dev from a phone is the
// whole point of the project, and Remote Control is the good way to do it.
//
// Measured 2026-08-02 against Claude Code 2.1.220: `--rc` is an undocumented
// alias for `--remote-control` and it does start the bridge, while the
// documented `remoteControlAtStartup` setting in ~/.claude/settings.json is
// read and then never acted on. Three launches with that setting true, one of
// them through this server, all came up with no bridge; the flag came up with
// one every time. DO NOT swap this flag for that setting.
//
// DO NOT write `-rc` with one dash. Commander splits it into `-r c`, which
// means `--resume c`, and the session dies looking for a conversation named c.
//
// The prefix is load-bearing. An auto-generated Remote Control name is
// `<hostname>-<random words>`, and this container's hostname is a docker id
// that changes on every recreate, so without it each tab reaches the phone as
// something like `d969bbd91655-mossy-frog`.
//
// PD_REMOTE_CONTROL=0 turns it off, the same shape as PD_RESUME and
// PD_TRUST_WORKSPACE. Registering a tab with the bridge makes it drivable by
// anyone holding the account, so this one in particular needs a way out that
// does not involve editing the image.
const REMOTE_CONTROL = process.env.PD_REMOTE_CONTROL !== '0';

// The one thing that OUTRANKS a session's provider, and it stays PROCESS-WIDE
// on purpose: two per-session command sources is how you get a tab whose
// command line nobody can predict. It exists because the e2e fixture needs a
// deterministic command (`cat`), the UnRAID template exposes it as an advanced
// operator knob, and it is documented as the escape hatch.
//
// THE CHECK IS `!SHELL_CMD`, NEVER `=== ''`. Measured 2026-09-07 against
// `docker inspect pocket-dev`: the variable is NOT SET AT ALL on the live
// container, zero matching rows. The template declares it with an empty default
// and UnRAID omits an empty variable from the generated `docker run`, which is
// where the plausible-but-wrong "set but empty" reading comes from. The real
// states are `undefined` and a non-empty string.
const SHELL_CMD    = process.env.SHELL_CMD;
const PORT         = parseInt(process.env.PORT, 10) || 7681;
const MAX_REPLAY_BYTES = 512 * 1024;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
// Bounds xterm's visible allocation to one million cells while remaining far
// above any real browser viewport. This crosses the grid wire protocol, so
// statusContract.test.js ties it to the browser's copy.
const MAX_GRID_DIMENSION = 1000;

const TMUX_CONF_PATH = path.join(__dirname, 'tmux.conf');
const LAUNCHER_PATH       = path.join(__dirname, 'pd-claude-session');
const CODEX_LAUNCHER_PATH = path.join(__dirname, 'pd-codex-session');
const CODEX_HOOK_PATH     = path.join(__dirname, 'pd-codex-session-start');
const CODEX_STATUS_PATH   = path.join(__dirname, 'pd-codex-thread-status');

// One HOME authority. It is also the cwd every session is spawned with, which
// matters for resume: `claude --resume` only finds conversations belonging to
// the current directory's project.
const HOME = process.env.HOME || os.homedir();

// Where the session roster and per-session provider conversation ids live.
// Bind-mount this to survive a container RECREATE (an image update); without a
// mount it still survives a restart, which is the common case.
const STATE_DIR    = process.env.PD_STATE_DIR || path.join(HOME, '.pocket-dev');
const PROJECTS_DIR = process.env.PD_CLAUDE_PROJECTS_DIR || path.join(HOME, '.claude', 'projects');

// Conversation resume is only wired up when pocket-dev owns the command line.
// A custom SHELL_CMD is not necessarily Claude (the e2e fixture runs `cat`),
// and bolting --resume/--session-id onto an arbitrary command is nonsense.
// PD_RESUME=0 turns it off outright.
//
// This is now only the KNOB. Whether a given session gets resume is a
// per-provider question. Claude uses its transcript and Codex uses one
// restore-time App Server status read; CAPABILITIES folds this knob together
// with SHELL_CMD and the provider's own declaration.
const RESUME_KNOB = process.env.PD_RESUME !== '0';

// Give a NEW tab's Remote Control session a real name once Claude has worked
// out what the conversation is about.
//
// Only a new tab needs this. Claude resolves a bridge session's name at
// REGISTRATION, preferring a custom title, then its own ai-title, then the last
// user message, and only then the random `<prefix>-<two words>`. A resumed
// conversation therefore already has a name on disk to register under; a tab
// opened seconds ago has nothing, gets the random one, and keeps it for the
// life of the process because nothing pushes the ai-title afterwards (measured
// 2026-08-02: a real session produced an ai-title and no rename followed).
//
// The ONLY channel for this is typing into the pty. claudeSession.js is
// inspection-only and pocket-dev does not write into ~/.claude/projects, so
// appending the record directly is off the table. That is also why this is
// hedged so carefully below: a write lands in whatever the user is typing.
//
// It rides the metadata poll rather than a timer of its own, which bounds it
// deliberately: nothing polling means nothing renamed. That is the right trade
// because creating a tab requires the browser in the first place, and the
// browser polls every few seconds while it is open, so the moment this fires
// (about ten seconds after the first turn) is a moment it is already open. A
// timer would buy the closed-browser case at the cost of advancing the unread
// axis with nobody watching, which is a worse thing to get wrong.
//
// PD_AUTO_NAME=0 turns it off on its own, separately from PD_REMOTE_CONTROL,
// because "bridge my sessions" and "type into my terminal for me" are different
// amounts of trust and someone may reasonably want the first without the second.
//
// Like resume, this is now only the KNOB. It is also a SAFETY gate rather than
// a feature flag once a second harness exists: maybeAutoName's only channel is
// writing `/rename <title>\r` into the pty, which is a CLAUDE slash command, so
// a provider that does not speak it must have this off in the registry and not
// merely happen to have no title. See CAPABILITIES and providers.js.
const AUTO_NAME_KNOB = process.env.PD_AUTO_NAME !== '0';

// Close a tab whose conversation the user archived from ANOTHER device: the
// desktop app, the phone, or claude.ai/code. Archiving there closes the Remote
// Control bridge 4090 and Claude Code records it in the transcript, but the
// process carries on, so without this the tab sits in the strip forever holding
// a conversation its owner has already declared finished. Measured on the live
// container 2026-09-03: 6 of 11 open tabs were in exactly that state.
//
// It rides the metadata poll, like maybeAutoName, and is bounded the same way:
// nothing polling means nothing closed. That is the right trade here too. The
// user archives from somewhere else, so nobody is watching pocket-dev at that
// moment, and the effect they want is that the tab is gone the next time they
// look, which is a moment the browser is by definition open and polling.
//
// It depends on the transcriptStatus capability because of the DATA, not as a
// preference: observe() answers NO_META without it, so there is no transcript to
// read and nothing to detect. PD_ARCHIVE_CLOSE=0 turns just this off.
//
// WHAT A CLOSE ACTUALLY COSTS, because it is easy to overstate and was: the
// tmux session and its scrollback, and the sid file that points this tab at its
// conversation. It does NOT cost the conversation. Nothing here writes to
// ~/.claude/projects, archiving is a state on the CLOUD side of the bridge
// (every "archived" branch in the binary reads worker_status or
// environment_kind, never the local transcript), and the transcript is what
// `claude --resume` lists. So a wrongly closed tab is recovered with a new tab
// and the resume picker.
//
// KNOWN AND ACCEPTED: this fires on something the user was still using about
// once in six. Of 23 real archive events measured across the container's
// transcripts, 19 were the last thing that ever happened in the conversation,
// but 4 were followed by more work (at +1.3 min, +21 min, +129 min and +16 h),
// two of them by roughly 1450 further turns. Jake chose the outright close on
// 2026-09-03 knowing those numbers, and the resume path above is why that is a
// cheap bet rather than a lossy one. DO NOT soften it into a grace period on
// the strength of the same numbers: a delay cannot save the +129 min and +16 h
// cases, so it would buy far less than it appears to while making the feature
// stop doing the thing it was asked for.
//
// Knob only, as above; the data dependency is expressed per provider in
// CAPABILITIES, since a provider with no transcript has no notice to find.
const ARCHIVE_CLOSE_KNOB = process.env.PD_ARCHIVE_CLOSE !== '0';

// What pocket-dev is allowed to believe about a session, resolved once per
// provider at boot.
//
// This replaces three process-wide booleans (RESUME_ENABLED, AUTO_NAME,
// ARCHIVE_CLOSE) that all keyed off SHELL_CMD. That coupling is what made "let
// a tab run Codex" and "make the session layer provider-agnostic" the same
// piece of work: shipping the first half alone would have switched conversation
// resume, transcript status, the title, the unread axis and archive-close off
// for EVERY tab, and would have left the auto-rename ON and typing at a TUI
// that does not understand it.
//
// Resolved eagerly for every provider rather than lazily per session so that an
// id which cannot be resolved is a startup error and not a runtime one.
const CAPABILITIES = new Map(PROVIDER_IDS.map(id => [id, resolveCapabilities(id, {
  shellOverride: Boolean(SHELL_CMD),
  resume:        RESUME_KNOB,
  remoteControl: REMOTE_CONTROL,
  autoName:      AUTO_NAME_KNOB,
  archiveClose:  ARCHIVE_CLOSE_KNOB,
})]));

// A provider id selects a COMMAND LINE, so an unrecognised one is REJECTED and
// never defaulted through: a typo must not silently start the wrong harness.
// Callers that take a provider from outside (POST /sessions) check isProvider
// first and answer 400; reaching this throw means an internal caller invented
// an id, which is a bug and should say so.
function capsFor(provider) {
  const caps = CAPABILITIES.get(provider);
  if (!caps) throw new Error(`unknown provider: ${provider}`);
  return caps;
}

function inputFor(provider, shellOverride = Boolean(SHELL_CMD)) {
  return resolveInput(provider, { shellOverride });
}

// How long the session has to have been quiet, input-wise, before we type into
// it. The rename fires just after the first turn, when the user is reading
// rather than typing, so in practice this never waits; it exists for the case
// where they started composing the next message in that window. Losing a
// half-typed line to a cosmetic rename would be a bad trade, and deferring
// costs nothing because the next poll tries again.
const AUTO_NAME_QUIET_MS = 10_000;

// What a restored session that was mid-turn is asked, so it picks the work back
// up instead of sitting there waiting for a human who thinks it is still going.
//
// Each launcher passes it as the provider's resume prompt rather than typing it
// into the terminal. Measured 2026-07-24 against real Claude: typing it in loses
// the race, because a resuming TUI paints, pauses while it initialises, then
// repaints, and anything typed into that gap is swallowed with no error. There
// is no ready signal to wait for, so DO NOT "fix" this by writing to the pty
// after a settle timeout. A command-line prompt is owned by the provider and
// survives even the workspace-trust gate.
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

// Variables a session needs that may not be in the tmux SERVER's environment.
//
// LAVISH_AXI_HOST is resolved at boot by entrypoint.sh, so it is in this
// process's environment and in a tmux server this process started. It is NOT in
// one that was already running, and by the comment in buildTmuxSpawnArgs that is
// the environment `new-session` actually inherits: a `docker exec tmux` before
// the first web session is enough to produce a tmux server without it, after
// which every session binds Lavish to loopback and its published port refuses
// connections. Forwarding by PREFIX rather than by a list of names so that a
// second runtime-resolved Lavish variable cannot reintroduce this by being
// forgotten.
const SESSION_ENV_PREFIX = 'LAVISH_';

function sessionEnvForwards(source = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    // Resolve the same harness binaries as the launching server, even when a
    // different process started tmux first. Otherwise a test stub PATH (or an
    // updated installed tool) is silently replaced by tmux's stale PATH.
    if ((key === 'PATH' || key.startsWith(SESSION_ENV_PREFIX)) && value !== undefined) out[key] = value;
  }
  return out;
}

function buildTmuxSpawnArgs(session, sessionCmd, { env = {}, envSource = process.env } = {}) {
  // `-e KEY=value` sets the tmux SESSION environment. It has to go this way
  // round rather than through the pty's own env: tmux's server outlives any one
  // client and only forwards the variables named in `update-environment`, so a
  // custom var set on the client is dropped before the command ever runs.
  //
  // The caller's explicit `env` wins over a forwarded one: the PD_* values are
  // computed per session, while the forwards are process-wide.
  const merged = { ...sessionEnvForwards(envSource), ...env };
  const envArgs = [];
  for (const [key, value] of Object.entries(merged)) envArgs.push('-e', `${key}=${value}`);
  return [
    '-u',
    '-f', TMUX_CONF_PATH,
    'new-session', '-A', '-s', session,
    ...envArgs,
    // Multiple command arguments make tmux exec directly. A single string is
    // interpreted by the existing tmux server's default shell; fish startup
    // can rewrite PATH and bypass both a selected harness and test stubs.
    '/bin/bash', '-c',
    sessionCmd,
  ];
}

// The non-resume fallback loop: restart the command forever, with no
// resume-or-start-fresh decision to make.
//
// IT TAKES THE COMMAND RATHER THAN CLOSING OVER ONE. Baked at module load
// (`LOOP_CMD`) it was process-wide, so with the provider per session a Codex
// tab would have come up running Claude in a restart loop.
function loopCommand(cmd) {
  return `bash -c 'while true; do ${cmd}; echo ; echo restarting...; sleep 1; done'`;
}

// What a session of this provider actually runs. SHELL_CMD wins outright; see
// its comment for why that stays process-wide.
function commandForSession(provider) {
  return SHELL_CMD || providerCommand(provider, { remoteControl: REMOTE_CONTROL });
}

// The command tmux runs for a session.
//
// Each resumable provider owns its restart loop because the first iteration
// resumes and later iterations start fresh. A provider without resume support,
// and every session under a custom SHELL_CMD, gets the plain inline loop.
function launcherFor(provider) {
  if (!capsFor(provider).resumeConversation) return null;
  const sessionKind = sessionKindFor(provider);
  if (sessionKind === 'claude') return LAUNCHER_PATH;
  if (sessionKind === 'codex') return CODEX_LAUNCHER_PATH;
  throw new Error(`no resume launcher for provider: ${provider}`);
}

function buildSessionCommand(provider = DEFAULT_PROVIDER) {
  const cmd = commandForSession(provider);
  const launcher = launcherFor(provider);
  return launcher ? `'${launcher}' ${cmd}` : loopCommand(cmd);
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

// Classify persisted Codex turns in one bounded helper invocation without
// loading or resuming their threads. Ids travel on stdin, never argv, and both
// stderr and malformed output fail closed so diagnostics cannot leak them.
function readCodexTurnStatuses(threadIds) {
  if (!Array.isArray(threadIds) || !threadIds.length) return [];
  const statuses = threadIds.map(() => 'unknown');
  const valid = threadIds
    .map((threadId, index) => ({ threadId, index }))
    .filter(({ threadId }) => UUID_RE.test(threadId || ''));
  if (!valid.length) return statuses;
  const result = spawnSync(CODEX_STATUS_PATH, [], {
    input: `${valid.map(({ threadId }) => threadId).join('\n')}\n`,
    encoding: 'utf8',
    timeout: 12_000,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || result.error) return statuses;
  const resolved = result.stdout.trimEnd().split('\n');
  if (resolved.length !== valid.length) return statuses;
  valid.forEach(({ index }, resolvedIndex) => {
    statuses[index] = normalizeCodexTurnStatus(resolved[resolvedIndex]);
  });
  return statuses;
}

function readCodexTurnStatus(threadId) {
  return readCodexTurnStatuses([threadId])[0] || 'unknown';
}

function createApp({ sessionsApi, shellOverride = Boolean(SHELL_CMD) } = {}) {
  const app = express();
  const inputTails = new WeakMap();

  // Preserve request order through a provider's delayed submit. Without one
  // tail per session, two composer requests can write both payloads before
  // either Enter and merge two prompts into one turn.
  function enqueueInput(session, operation) {
    const previous = inputTails.get(session) || Promise.resolve();
    const current = previous.then(operation);
    const settled = current.then(() => undefined, () => undefined);
    inputTails.set(session, settled);
    settled.then(() => {
      if (inputTails.get(session) === settled) inputTails.delete(session);
    });
    return current;
  }

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
      // The provider is OPTIONAL and an absent one takes the default, so a
      // client that predates the picker keeps working. An id we do not
      // recognise is a 400 and NEVER the default: the id selects a command
      // line, and quietly starting the wrong harness on a mistyped one is worse
      // than refusing.
      const requested = req.body ? req.body.provider : undefined;
      if (requested !== undefined && !isProvider(requested))
        return res.status(400).json({ error: 'unknown provider' });
      const state = requested === undefined
        ? sessionsApi.create()
        : sessionsApi.create(undefined, { provider: requested });
      res.json({ id: state.id, provider: state.provider });
    });

    app.delete('/sessions/:id', (req, res) => {
      if (!SAFE_ID.test(req.params.id))
        return res.status(400).json({ error: 'invalid session id' });
      sessionsApi.destroy(req.params.id, (ok) => res.json({ ok }));
    });

    app.post('/send', requireSession, (req, res, next) => {
      const { text } = req.body;
      if (typeof text !== 'string' || !text.length)
        return res.status(400).json({ error: 'text required' });
      sessionsApi.noteInput(req.session);
      // The browser reads the negotiated mode from xterm. Bracketed paste
      // keeps embedded newlines in one message for supporting terminal apps.
      const payload = req.body.bracketedPaste === true
        ? '\x1b[200~' + text.replace(/\x1b/g, '') + '\x1b[201~'
        : text;
      const input = inputFor(req.session.provider, shellOverride);
      enqueueInput(req.session, async () => {
        req.session.pty.write(payload);
        if (input.submitDelayMs) await delay(input.submitDelayMs);
        req.session.pty.write(input.submitSequence);
      }).then(() => res.json({ ok: true }), next);
    });

    app.post('/key', requireSession, (req, res) => {
      const { key } = req.body;
      const ctrlMatch = key && key.match(/^ctrl-([a-z])$/);
      if (ctrlMatch) {
        sessionsApi.noteInput(req.session);
        req.session.pty.write(String.fromCharCode(ctrlMatch[1].charCodeAt(0) - 96));
        return res.json({ ok: true });
      }
      const sequences = {
        escape: '\x1b', tab: '\t',
        left: '\x1b[D', right: '\x1b[C', up: '\x1b[A', down: '\x1b[B',
      };
      const seq = key === 'enter' ? inputFor(req.session.provider, shellOverride).submitSequence : sequences[key];
      if (!seq) return res.status(400).json({ error: 'unknown key' });
      sessionsApi.noteInput(req.session);
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
      refreshTmuxSession(req.session.id, (err) => res.json({ ok: !err }));
    });
  }

  return app;
}

// Kill a tmux session by name. The pty is only a CLIENT of it, so killing the
// pty leaves the tmux session (and whatever is running in it) alive.
//
// INJECTABLE BECAUSE THE DEFAULT IS DESTRUCTIVE TO THINGS THE TESTS DO NOT OWN.
// The server test suite creates sessions named from SESSION_BASE, which
// defaults to 'main' when TMUX_SESSION is unset OR EMPTY, and pocket-dev's own
// container sets it empty. So `api.destroy('main-1')` in a test used to run a
// real `tmux kill-session -t main-1` against whatever tmux server the test
// process could see, which inside pocket-dev is Jake's live one. It aborted
// nothing and warned about nothing, because killing a session that happens not
// to exist looks exactly like the same call killing one that does.
//
// It is also the only place that can tell us a kill FAILED, which matters: the
// caller has already dropped the session from the roster and forgotten its
// conversation by then, so a failure leaves the tmux session orphaned with
// Claude still running in it and nothing pointing at it.
function killTmuxSession(id, cb) {
  execFile('tmux', ['kill-session', '-t', id], cb);
}

// A replay buffer is terminal BYTE HISTORY, not a screen snapshot. Once its
// bounded prefix has been dropped, a full-screen TUI's remaining cursor deltas
// cannot reconstruct the state they were written against. tmux still owns the
// authoritative current screen, so repaint every attached client from there.
//
// tmux refresh-client targets clients, not sessions. List the clients attached
// to this session, then refresh each. Callers resolve ids from the guarded
// session map, but validate here too because this helper owns interpolation.
function refreshTmuxSession(id, cb = () => {}, run = exec) {
  if (!SAFE_ID.test(id)) return cb(new Error('invalid session id'));
  run(
    `tmux list-clients -t '${id}' -F '#{client_name}' | xargs -r -I{} tmux refresh-client -t {}`,
    { shell: '/bin/bash' },
    cb,
  );
}

// Close code for "this session does not exist any more". The browser's
// ws.onclose branches on it: 4404 means stop reconnecting and re-read the
// roster, anything else means a transient hiccup worth retrying in two seconds.
//
// Every deliberate removal sends it, not just a WS that arrives for an unknown
// id. Closing a session's clients with no code told them the opposite of the
// truth, so a tab killed from another device (or closed by maybeArchiveClose, or
// whose tmux session was killed by hand) left a dead pane on screen until the
// retry earned itself a 4404 the long way round.
const GONE_CODE = 4404;

function createSessionsApi({
  store          = nullSessionStore,
  spawnPty       = spawnTmuxPty,
  killSession    = killTmuxSession,
  refreshSession = refreshTmuxSession,
  projectsDir    = PROJECTS_DIR,
  logger         = console,
  codexTurnStatuses = readCodexTurnStatuses,
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

  // `resumePrompt` is passed through to the provider launcher, which appends it
  // only when its first iteration actually resumes a conversation.
  function create(id = nextSessionId(), { resumePrompt = null, provider = DEFAULT_PROVIDER } = {}) {
    if (sessions.has(id)) return sessions.get(id);
    // Before anything else, and it THROWS rather than defaulting: the provider
    // decides the command line, so an id nobody recognises must not become a
    // running process. Both real callers have already screened it (the endpoint
    // answers 400, the roster repairs), so reaching here is an internal bug.
    const caps = capsFor(provider);
    noteId(id);

    // Where this session's conversation already stood before we adopted it.
    // Cheap: metaFor is memoised, and for a session with no recorded uuid (any
    // brand new tab) it answers without touching the disk.
    const {
      status: initialStatus,
      turnId: initialTurnId,
      title: initialTitle,
      archivedId: initialArchivedId,
    } = observe(id, caps);

    // Each resumable provider gets only the environment its own launcher and
    // capture path understand. The shared sid path is safe because the roster
    // fixes one provider to a tab for its lifetime.
    const env = {};
    if (caps.resumeConversation) {
      const sidFile = store.sidPath(id);
      const sessionKind = sessionKindFor(provider);
      if (sessionKind === 'claude') {
        env.PD_CLAUDE_PROJECTS_DIR = projectsDir;
        if (sidFile) env.PD_SID_FILE = sidFile;
        if (resumePrompt) env.PD_RESUME_PROMPT = resumePrompt;
      } else if (sessionKind === 'codex' && sidFile) {
        env.PD_CODEX_SID_FILE = sidFile;
        if (store.dir) env.PD_STATE_DIR = store.dir;
        if (resumePrompt) env.PD_RESUME_PROMPT = resumePrompt;
      }
    }

    const ptyProc = spawnPty({
      session: id,
      command: buildSessionCommand(provider),
      env,
      cols:    DEFAULT_COLS,
      rows:    DEFAULT_ROWS,
    });

    const state = {
      id,
      // Which harness this tab runs, and what that lets us believe about it.
      // Held per session rather than read per call so one lookup answers for
      // the life of the tab, and so a capability cannot be re-derived
      // differently by two call sites.
      provider,
      caps,
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
      // When a human last typed at this session, so the auto-rename can refuse
      // to write into a half-composed message. Seeded to 0, not to now: a tab
      // nobody has touched is the quietest one there is.
      lastInputAt: 0,
      // Whether the Remote Control name has been dealt with.
      //
      // Seeded from the title the conversation ALREADY had when we adopted it,
      // which is what confines the whole feature to genuinely new tabs. A
      // restored or resumed session has an ai-title on disk, so Claude named its
      // bridge session correctly at registration and there is nothing to fix;
      // marking it done here means a long conversation can never be renamed out
      // from under a name the user chose on their phone. A brand new tab has no
      // title, so this is false and the first one to appear triggers the rename.
      autoNamed: !caps.autoName || initialTitle !== null,
      // The newest Remote Control archive notice this session's conversation
      // already carried when we adopted it. SEEDING IS THE MECHANISM, exactly
      // as it is for status and turnId above: the notice stays in the tail
      // window while a conversation carries on, and 4 of 23 measured archives
      // were followed by more work, so a restart that compared against nothing
      // would close the very tabs whose owner came back to them. Only a notice
      // that appears AFTER this point is news.
      archivedId: initialArchivedId,
      // A notice seen while the session was mid-turn, waiting for it to settle.
      // Memory-only ON PURPOSE: it must not survive a restart, or a tab that
      // was archived and then worked in would close itself after every reboot.
      archivePending: null,
    };

    ptyProc.onData(data => {
      state.lastOutputAt = Date.now();
      // THE UNREAD AXIS, and which of its three values a session has decides
      // whether raw output may claim the user's attention. Written out per value
      // rather than as a negation, because the values are not interchangeable
      // and one of them is a defect if it is guessed.
      //
      //   'bytes'  output is the only evidence that exists, PERMANENTLY. That
      //            is a session under a custom SHELL_CMD (the e2e fixture runs
      //            `cat`) or with PD_RESUME=0: observe() answers NO_META
      //            unconditionally, so no transcript will ever appear and this
      //            is the only writer of attentionSeq there will ever be. Right
      //            for a plain shell, whose line output really is news.
      //
      //   'turns'  noteTurn owns the axis, so a repaint or a thinking frame
      //            cannot make the session claim it wants you. Bytes still
      //            count WHILE THE STATUS IS 'unknown', and that clause is
      //            load-bearing rather than a leftover: a brand new Claude tab
      //            is 'unknown' until its transcript appears, and noteTurn
      //            cannot cover the gap because WANTS_USER is {idle, asking}
      //            and deliberately excludes 'unknown'. So line 499 is the ONLY
      //            writer for such a tab. The window is transient and closes
      //            itself the moment a transcript exists. Four named guards in
      //            sessionsRestore.test.js depend on it, one of them the
      //            same-millisecond guard that is why this counts rather than
      //            compares clocks.
      //
      //   'none'   nothing counts, and this is the defect the enum exists to
      //            prevent. A provider whose harness writes no transcript is
      //            'unknown' FOREVER, so under 'turns' semantics every frame it
      //            painted while THINKING would advance the counter with nothing
      //            to ever close the guard. The row then reads "Waiting on you"
      //            and lights the attention badge: the strongest signal the UI
      //            has, fired by a session doing the opposite of needing the
      //            user. The row says it has no status instead. Codex is 'none'
      //            whether or not it repaints when idle, which is UNVERIFIED:
      //            if it repaints this avoids a false summons, and if it is
      //            silent then counting its bytes could only ever add noise.
      //            See issue #53.
      const axis = state.caps.unreadAxis;
      if (axis === 'bytes' || (axis === 'turns' && state.status === 'unknown')) {
        state.attentionSeq += 1;
      }
      appendToReplay(state, data);
      // One browser answers live terminal queries. Replayed queries may have
      // already timed out in tmux, so they must NEVER be answered on attach.
      const responder = [...state.clients].find(ws => ws.pdFrames && ws.readyState === 1);
      for (const ws of state.clients) {
        if (ws.readyState === 1) ws.send(ws.pdFrames
          ? JSON.stringify({ type: 'output', data, reply: ws === responder }) : data);
      }
    });

    ptyProc.onExit(() => {
      // PTY died (e.g. tmux session killed externally). Drop state and close clients.
      sessions.delete(id);
      forgetMeta(id);
      store.clearSid(id);
      persist();
      for (const ws of state.clients) {
        try { ws.close(GONE_CODE, 'session gone'); } catch {}
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
  // the provider launcher resuming the conversation from its recorded uuid. Either
  // way the tabs come back under the SAME ids, so a browser left open across
  // the outage reconnects into them instead of showing dead panes.
  function restore({ autoContinue = false } = {}) {
    const restored = [];
    const records = [];
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
        const caps = capsFor(entry.provider);
        const uuid = caps.resumeConversation ? store.readSid(entry.id) : null;
        records.push({ entry, caps, uuid, codexStatus: 'unknown' });
      } catch (err) {
        logger.warn(`failed to restore session ${entry.id}: ${err.message}`);
      }
    }

    const codexRecords = records.filter(({ entry, uuid }) => (
      sessionKindFor(entry.provider) === 'codex' && uuid
    ));
    if (codexRecords.length) {
      try {
        const statuses = codexTurnStatuses(codexRecords.map(({ uuid }) => uuid));
        codexRecords.forEach((record, index) => {
          record.codexStatus = normalizeCodexTurnStatus(statuses?.[index]);
        });
      } catch {
        logger.warn('failed to read Codex turn statuses, restoring without continuation');
      }
    }

    for (const { entry, caps, uuid, codexStatus } of records) {
      try {
        const status = caps.transcriptStatus
          ? metaFor(uuid).status
          : classifyCodexTurnStatus(codexStatus);

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
        create(entry.id, { resumePrompt: resumePrompt || null, provider: entry.provider });
        restored.push(entry.id);

        // Say so when there is nothing to classify, because `docker logs` IS
        // the artifact for restore (see the lines below) and silence there
        // reads as a session that was skipped rather than one that has no
        // conversation to have an opinion about.
        if (status === 'busy' && autoContinue) {
          logger.log(`session ${entry.id}: was mid-turn, resuming with "${resumePrompt}"`);
        } else if (status === 'busy') {
          logger.log(`session ${entry.id}: was mid-turn but the last shutdown was NOT clean, resuming without continuing the work`);
        } else if (caps.transcriptStatus) {
          if (status === 'idle')   logger.log(`session ${entry.id}: was waiting on the user, restored as-is`);
          if (status === 'asking') logger.log(`session ${entry.id}: was waiting for an answer to a question, restored as-is`);
        } else if (status === 'settled') {
          logger.log(`session ${entry.id}: ${labelFor(entry.provider)} last turn ${codexStatus}, restored as-is`);
        } else {
          logger.log(`session ${entry.id}: ${labelFor(entry.provider)} session with no transcript status, restored as-is`);
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
      try { ws.close(GONE_CODE, 'session destroyed'); } catch {}
    }
    // Kill the tmux session (the pty is just the client; tmux server persists otherwise).
    killSession(id, (err) => {
      // Reported, not swallowed. Everything above has already run, so pocket-dev
      // has forgotten this session either way; if the kill failed, tmux is still
      // running Claude in it and nothing left points at it. The log line is the
      // only place that can say so.
      if (err) logger.warn(`[${id}] tmux kill-session failed, session may be orphaned: ${err.message}`);
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
    noteTurn(state, observe(id, state.caps));
    state.viewedSeq = state.attentionSeq;
    return true;
  }

  // Also what gets written to the roster, so the provider has to be in here or
  // a restart forgets which harness every tab was running.
  function list() {
    return [...sessions.values()].map(s => ({
      id: s.id, provider: s.provider, cols: s.cols, rows: s.rows,
    }));
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
  const NO_META = Object.freeze({ status: 'unknown', turnId: null, title: null, lastPrompt: null, archivedId: null });

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

  // A human just typed at this session. The auto-rename is the only reader:
  // everything else on the input path already has its own bookkeeping.
  function noteInput(state) {
    state.lastInputAt = Date.now();
  }

  // Push Claude's own conversation title to the Remote Control bridge, once, by
  // typing `/rename` at it. See AUTO_NAME_KNOB for why this is worth doing and why
  // the pty is the only way to do it.
  //
  // Every condition here is load-bearing:
  //
  //   autoNamed        already handled, or a session that arrived with a title
  //                    and so was never ours to rename (see create).
  //   title            nothing to rename it to yet. This is the trigger: a new
  //                    tab flips from null to a title after its first turn.
  //   status busy      Claude is mid-turn. Input typed at a busy TUI is not
  //                    lost, but it queues and lands in a repaint, and there is
  //                    no reason to race it when the next poll will do.
  //   quiet            the user may be composing. A rename is cosmetic and a
  //                    half-written message is not, so it always yields.
  //
  // `autoNamed` is set BEFORE the write, not after: a failed write must not
  // leave this retrying on every poll for the life of the session.
  //
  // The command and its newline go as ONE write. Verified 2026-08-02 against
  // the real TUI: the slash-command palette opens on `/` but does not swallow
  // the trailing carriage return, and the session renamed on the first try.
  function maybeAutoName(state, meta) {
    // The provider gate, and it is a SAFETY gate. The write below is
    // `/rename ...` INTO THE PTY, which is a Claude slash command, so for any
    // other harness this is pocket-dev typing at a TUI that does not speak it.
    // It is inert today for such a session only because meta.title is always
    // null without a transcript, and that is protection by accident of the data
    // path, not by a gate. DO NOT drop this on the strength of the null title.
    if (!state.caps.autoName) return;
    if (state.autoNamed || !meta.title) return;
    if (meta.status === 'busy') return;
    if (Date.now() - state.lastInputAt < AUTO_NAME_QUIET_MS) return;

    state.autoNamed = true;
    logger.log(`[${state.id}] naming Remote Control session: ${meta.title}`);
    state.pty.write(`/rename ${meta.title}\r`);
  }

  // Close a tab whose conversation was archived from another device.
  //
  // Returns whether it closed, because the caller must then stop touching the
  // session: advancing an unread axis or renaming a bridge session that is on
  // its way out is work on a corpse, and destroy() has already removed it from
  // the map, so the row must not be reported either.
  //
  // Every condition is load-bearing:
  //
  //   archiveClose    the capability, which folds together the knob and the
  //                   data dependency: a provider with no transcript has no
  //                   notice to find in the first place.
  //   a NEW notice     different from the one this session was adopted with.
  //                    See the seed in create(): without the comparison every
  //                    restart re-closes tabs whose owner archived them and
  //                    then came back, which is 4 of the 23 archives that have
  //                    actually happened.
  //   TURN_SETTLED     the turn is over. Killing tmux mid-turn destroys work in
  //                    flight with nothing recording that it ever ran. Asked
  //                    POSITIVELY, not as `!== 'busy'`: see TURN_SETTLED in
  //                    claudeSession.js for why 'unknown' must not pass, which
  //                    is the case where a tool_result bigger than the tail
  //                    window is the only thing in it.
  //
  // THE NOTICE IS LATCHED THE MOMENT IT IS SEEN, before the settled check, and
  // that is not tidiness. findArchivedNotice only sees the last TAIL_BYTES of
  // the transcript, so a notice that arrives mid-turn can be pushed out of the
  // window by the rest of that turn's output and never be seen again. Deferring
  // on the status alone therefore loses the event outright, and silently: the
  // tab just never closes. `archivePending` is memory-only, so it holds until
  // the turn settles and is correctly forgotten on a restart, where the seed
  // takes over.
  //
  // `archivedId` is advanced BEFORE the destroy, not after, so a kill that
  // fails cannot leave this retrying on every poll for the life of the process.
  function maybeArchiveClose(state, meta) {
    if (!state.caps.archiveClose) return false;
    if (meta.archivedId && meta.archivedId !== state.archivedId) {
      state.archivePending = meta.archivedId;
    }
    if (!state.archivePending) return false;
    if (!claudeSession.TURN_SETTLED.has(meta.status)) return false;

    state.archivedId     = state.archivePending;
    state.archivePending = null;
    logger.log(`[${state.id}] archived from another device, closing the tab`);
    destroy(state.id);
    return true;
  }

  // What a session's conversation says right now. The one place that decides
  // whether we are allowed to look at all: with a custom SHELL_CMD, or a
  // provider that writes no transcript, there is no conversation, and
  // create/describe/markViewed must not each re-decide that.
  //
  // Takes the resolved capabilities rather than the provider id so that create()
  // can call it before the session state exists, with the same answer every
  // later caller gets.
  function observe(id, caps) {
    return caps.transcriptStatus ? metaFor(store.readSid(id)) : NO_META;
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
    const rows = [];
    // Snapshot first: maybeArchiveClose mutates `sessions`.
    for (const s of [...sessions.values()]) {
      const meta = observe(s.id, s.caps);
      // Closing comes first and short-circuits the rest. A closed session is
      // gone from the map, so reporting a row for it would tell the browser to
      // keep a pane whose next reconnect gets a 4404.
      if (maybeArchiveClose(s, meta)) continue;
      noteTurn(s, meta);
      maybeAutoName(s, meta);
      rows.push({
        id: s.id,
        cols: s.cols,
        rows: s.rows,
        title: meta.title,
        lastPrompt: meta.lastPrompt,
        status: meta.status,
        unread: s.attentionSeq > s.viewedSeq,
        lastOutputAt: s.lastOutputAt,
        provider: s.provider,
        // The display name comes from the SERVER, not from a client-side map of
        // ids to names. A label duplicated across a JSON boundary is exactly the
        // drift test/unit/statusContract.test.js exists to stop, and this one
        // would show up as a tab labelled with a raw id.
        providerLabel: labelFor(s.provider),
        // Whether the four attention states mean anything for this session at
        // all. See statusTracked in providers.js: false is NOT "status unknown",
        // it is "there is no axis on which a status could be known", and the
        // browser renders a fifth row state for it that sits outside the
        // attention axis entirely.
        statusTracked: statusTracked(s.caps),
      });
    }
    return rows;
  }

  // A session has one PTY grid even when several browsers are attached. Every
  // grid-capable framed client must parse the shared byte stream at that same
  // size. Legacy framed clients deliberately stay on the old protocol during
  // a rolling update, because an unknown JSON frame renders as terminal text.
  // Send the grid before pty.resize(), because the resize can synchronously
  // make the TUI repaint with cursor addresses that only make sense on the new
  // grid.
  function sendGrid(ws, state) {
    if (ws.pdGrid && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'grid', cols: state.cols, rows: state.rows }));
    }
  }

  function broadcastGrid(state) {
    for (const ws of state.clients) sendGrid(ws, state);
  }

  function attachWs(ws, sessionId, { frames = false, grid = false } = {}) {
    const state = sessions.get(sessionId);
    if (!state) {
      try { ws.close(GONE_CODE, 'session not found'); } catch {}
      return;
    }
    state.clients.add(ws);
    ws.pdFrames = frames;
    ws.pdGrid = frames && grid;
    // Grid comes before replay: replay bytes may contain cursor addressing and
    // wrapping decisions made for the PTY's current dimensions.
    sendGrid(ws, state);
    if (state.replayBuffer.length > 0) {
      ws.send(frames ? JSON.stringify({ type: 'replay', data: state.replayBuffer }) : state.replayBuffer);
      // Queue the authoritative screen AFTER the replay suffix. WebSocket
      // ordering and the browser's write queue preserve that order, so a TUI
      // reconnect always ends on tmux's complete current frame even when the
      // bounded byte history began halfway through a differential repaint.
      refreshSession(sessionId, (err) => {
        if (err) logger.warn(`[${sessionId}] replay refresh failed: ${err.message}`);
      });
    }

    ws.on('message', data => {
      const msg = data.toString();
      if (msg.startsWith('{')) {
        try {
          const parsed = JSON.parse(msg);
          if (parsed.type === 'resize'
              && Number.isInteger(parsed.cols) && Number.isInteger(parsed.rows)
              && parsed.cols >= 1 && parsed.rows >= 1
              && parsed.cols <= MAX_GRID_DIMENSION && parsed.rows <= MAX_GRID_DIMENSION) {
            const newCols = parsed.cols;
            const newRows = parsed.rows;
            if (newCols !== state.cols || newRows !== state.rows) {
              state.cols = newCols;
              state.rows = newRows;
              broadcastGrid(state);
              state.pty.resize(newCols, newRows);
            }
          }
        } catch {}
      } else {
        // The browser's keystrokes. This is the path the auto-rename cares
        // about most: it is what "the user is typing right now" actually means.
        noteInput(state);
        state.pty.write(msg);
      }
    });

    ws.on('close', () => state.clients.delete(ws));
  }

  return { create, restore, destroy, get, list, describe, markViewed, noteInput, attachWs };
}

module.exports = {
  GONE_CODE,
  buildTmuxSpawnArgs,
  buildSessionCommand,
  createApp,
  createSessionsApi,
  refreshTmuxSession,
  TMUX_CONF_PATH,
  LAUNCHER_PATH,
  CODEX_LAUNCHER_PATH,
  CODEX_HOOK_PATH,
  CODEX_STATUS_PATH,
  readCodexTurnStatuses,
  readCodexTurnStatus,
  SAFE_ID,
  MAX_GRID_DIMENSION,
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
    wss.handleUpgrade(req, socket, head, ws => sessionsApi.attachWs(ws, sessionId, {
      frames: url.searchParams.get('frames') === '1',
      grid: url.searchParams.get('grid') === '1',
    }));
  });

  server.listen(PORT, '0.0.0.0', () =>
    console.log(`pocket-dev on :${PORT}  (base session: ${SESSION_BASE}  cmd: ${commandForSession(DEFAULT_PROVIDER)}  state: ${store.file})`));
}
