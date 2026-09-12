import { test as base, expect } from '@playwright/test';
import { spawn, execFile as execFileCb } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn as spawnPty } from 'node-pty';
import { WebSocketServer } from 'ws';
import { createApp, createSessionsApi } from '../../server.js';

const execFile = promisify(execFileCb);

const SERVER_PATH = path.resolve(__dirname, '../../server.js');

async function pickPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Spawn a Node child running the given script with PORT set, and resolve once
// it logs the given ready string. Reject if it exits early or doesn't log
// within timeoutMs.
// Tower is a shared build host and can be CPU-saturated by unrelated media or
// test jobs. A readiness wait must tolerate scheduling delay while still
// failing immediately if the child process exits.
async function spawnReady({ scriptPath, env, readySubstring, timeoutMs = 15000 }) {
  const proc = spawn('node', [scriptPath], { env, stdio: 'pipe' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start within ${timeoutMs}ms`)), timeoutMs);
    proc.stdout.on('data', chunk => {
      if (chunk.toString().includes(readySubstring)) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on('exit', code => reject(new Error(`Server exited early with code ${code}`)));
  });
  return proc;
}

// SIGTERM is the deliberate stop docker sends, and the server's handler writes
// its clean-shutdown marker on the way out. SIGKILL models the container dying:
// no handler runs, no marker, and the next boot must treat it as a crash.
async function killProcAndWait(proc, signal = 'SIGTERM') {
  proc.kill(signal);
  await new Promise(resolve => proc.on('exit', resolve));
}

// Tmux server keeps running after our spawned `node server.js` exits — explicitly
// kill all sessions matching the fixture's prefix so repeated local runs don't
// accumulate orphans. Server uses TMUX_SESSION as a BASE NAME and creates
// `${base}-1`, `${base}-2`, ... so we list and match by prefix.
async function killTmuxSessionsByPrefix(prefix) {
  let stdout = '';
  try {
    ({ stdout } = await execFile('tmux', ['ls', '-F', '#{session_name}']));
  } catch {
    // No tmux server running, or tmux not installed — nothing to clean.
    return;
  }
  const names = stdout.split('\n').filter(n => n === prefix || n.startsWith(`${prefix}-`));
  for (const name of names) {
    try { await execFile('tmux', ['kill-session', '-t', name]); } catch {}
  }
}

// Build a fixture that runs the real server (PTY + WebSocket + tmux) with the
// given SHELL_CMD.
//
// Each one gets its own PD_STATE_DIR. That isolation is load-bearing, not
// tidiness: the server now RESTORES its session roster at boot, so a shared
// state dir would have every test booting into whatever sessions the previous
// test left behind — and would scribble on the developer's real ~/.pocket-dev
// while doing it.
//
// The returned server exposes `restart()`, which stands the server process back
// up on the same port and state dir. With killTmux it models a container
// restart (tmux gone, sessions respawn from the roster); without it, only the
// node process died and `new-session -A` reattaches to the live tmux sessions.
function ptyServerFixture({ prefix, shellCmd }) {
  return async ({}, use) => {
    const port        = await pickPort();
    const sessionName = `${prefix}-${port}`;
    const stateDir    = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-e2e-state-'));
    const env = {
      ...process.env,
      PORT: String(port),
      SHELL_CMD: shellCmd,
      TMUX_SESSION: sessionName,
      PD_STATE_DIR: stateDir,
    };

    let proc = await spawnReady({ scriptPath: SERVER_PATH, env, readySubstring: 'pocket-dev on' });

    await use({
      port,
      baseURL: `http://localhost:${port}`,
      stateDir,
      sessionName,
      async restart({ killTmux = false, signal = 'SIGTERM' } = {}) {
        await killProcAndWait(proc, signal);
        if (killTmux) await killTmuxSessionsByPrefix(sessionName);
        proc = await spawnReady({ scriptPath: SERVER_PATH, env, readySubstring: 'pocket-dev on' });
      },
    });

    await killProcAndWait(proc);
    await killTmuxSessionsByPrefix(sessionName);
    await fs.rm(stateDir, { recursive: true, force: true });
  };
}

async function useSessionsApiServer(sessionsApi, use) {
  const server = http.createServer(createApp({ sessionsApi }));
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    wss.handleUpgrade(req, socket, head, ws => sessionsApi.attachWs(ws, url.searchParams.get('session'), {
      frames: url.searchParams.get('frames') === '1',
      grid: url.searchParams.get('grid') === '1',
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await use({ port, baseURL: `http://127.0.0.1:${port}` });
  for (const { id } of sessionsApi.list()) sessionsApi.destroy(id);
  for (const ws of wss.clients) ws.terminate();
  await new Promise(resolve => server.close(resolve));
  wss.close();
}

const truncatedTuiBaseFrame = [
  '\x1b[2J\x1b[HQuick safety check',
  'Review this folder before continuing.',
  '',
  'Claude Code can read, edit, and execute files here.',
  '',
  'Enter to confirm. Esc to cancel.',
].join('\r\n');
const truncatedTuiMarker = '\x1b[20;1H\x1b[KREPLAY WINDOW TRIMMED';
const truncatedTuiTail = Array.from(
  { length: 30000 },
  (_, i) => `\x1b[20;1H\x1b[K${String(i).padStart(20, '0')}`,
).join('') + truncatedTuiMarker;

function truncatedTuiPty() {
  const proc = new EventEmitter();
  let input = '';
  proc.onData = handler => {
    proc.on('data', handler);
    return { dispose: () => proc.off('data', handler) };
  };
  proc.onExit = handler => {
    proc.on('exit', handler);
    return { dispose: () => proc.off('exit', handler) };
  };
  proc.resize = () => {};
  proc.kill = () => {};
  proc.write = data => {
    input += data;
    let end;
    while ((end = input.indexOf('\r')) >= 0) {
      const command = input.slice(0, end);
      input = input.slice(end + 1);
      if (command === 'draw') proc.emit('data', truncatedTuiBaseFrame);
      if (command === 'trim') proc.emit('data', truncatedTuiTail);
    }
  };
  return proc;
}

const liveGridFrame = (cols, rows, label) => [
  `\x1b[2J\x1b[H${label}`,
  `shared grid ${cols} x ${rows}`,
  'the newest response owns this whole screen',
  'no rows from the previous response remain',
].join('\r\n');

function liveGridPty() {
  const proc = new EventEmitter();
  let cols = 120;
  let rows = 40;
  let streamed = false;
  let currentFrame = liveGridFrame(cols, rows, 'INITIAL GRID FRAME');

  proc.onData = handler => {
    proc.on('data', handler);
    return { dispose: () => proc.off('data', handler) };
  };
  proc.onExit = handler => {
    proc.on('exit', handler);
    return { dispose: () => proc.off('exit', handler) };
  };
  proc.resize = (newCols, newRows) => {
    cols = newCols;
    rows = newRows;
    if (!streamed) return;
    currentFrame = liveGridFrame(cols, rows, 'NEW GRID FRAME');
    // node-pty may emit a TUI repaint synchronously from resize(). The server
    // must have broadcast the new grid before this chunk reaches browsers.
    proc.emit('data', currentFrame);
  };
  proc.kill = () => {};
  proc.write = data => {
    if (data.includes('ready')) {
      proc.emit('data', currentFrame);
      return;
    }
    if (streamed || !data.includes('stream')) return;
    streamed = true;
    // Model a long streamed turn as many differential chunks. The first chunk
    // is held by the browser test while a second client resizes the shared PTY.
    proc.emit('data', '\x1b[2J\x1b[HOLD-STREAM-BEGIN');
    for (let i = 0; i < 250; i += 1) {
      proc.emit('data', `\x1b[12;1H\x1b[2Kold response chunk ${String(i).padStart(4, '0')} ${'x'.repeat(180)}`);
    }
    currentFrame = liveGridFrame(cols, rows, 'OLD GRID FRAME');
    proc.emit('data', currentFrame);
  };
  proc.repaint = () => proc.emit('data', currentFrame);
  return proc;
}

export const test = base.extend({
  // Uses `cat` as a deterministic SHELL_CMD so typing `hello\n` in #cmd-input
  // echoes `hello\n` back into the buffer.
  pdServer: ptyServerFixture({ prefix: 'pdtest', shellCmd: 'cat' }),
  pdServerQueryApp: async ({}, use) => {
    // Put queries directly on the outer PTY. tmux answers an INNER app's DA2
    // itself, which would bypass the browser/WS reply boundary under test.
    const sessionsApi = createSessionsApi({
      spawnPty: () => spawnPty(process.execPath, [path.resolve(__dirname, 'query-app.cjs')], {
        name: 'xterm-256color', cols: 120, rows: 40, env: process.env,
      }),
      killSession: (_id, done) => done(),
      // This fixture deliberately has no tmux client. Do not let a reconnect
      // fall through to the real refresh command and touch a developer session.
      refreshSession: (_id, done) => done(),
    });
    await useSessionsApiServer(sessionsApi, use);
  },

  // SHELL_CMD replays a captured real Claude TUI frame (alt-screen,
  // CHA-positioned words) instead of `cat`. Exercises live display and copy against
  // the exact content the old serialize()+ansi_up path mangled.
  pdServerClaudeFrame: ptyServerFixture({
    prefix: 'pdframe',
    shellCmd: `bash ${path.resolve(__dirname, 'replay-claude-frame.sh')}`,
  }),

  // The fake outer PTY makes the reconnect contract deterministic: the replay
  // suffix contains row deltas only, while refresh emits the authoritative
  // complete screen that a real tmux client owns.
  pdServerTruncatedTuiFrame: async ({}, use) => {
    let pty;
    const sessionsApi = createSessionsApi({
      spawnPty: () => (pty = truncatedTuiPty()),
      killSession: (_id, done) => done(),
      refreshSession: (_id, done) => {
        pty.emit('data', truncatedTuiBaseFrame + truncatedTuiMarker);
        done();
      },
    });
    await useSessionsApiServer(sessionsApi, use);
  },

  // The fake outer PTY reproduces a live multi-client race. One browser is
  // still parsing many old-grid chunks when another resizes the shared PTY;
  // resize emits the new-grid repaint synchronously, as node-pty can.
  pdServerLiveGrid: async ({}, use) => {
    let pty;
    const sessionsApi = createSessionsApi({
      spawnPty: () => (pty = liveGridPty()),
      killSession: (_id, done) => done(),
      refreshSession: (_id, done) => {
        pty.repaint();
        done();
      },
    });
    await useSessionsApiServer(sessionsApi, use);
  },

  // SHELL_CMD enables SGR mouse tracking (as Claude does) then idles. Exercises
  // scroll.js's wheel-forwarding branch: touch-drag on a mouse-tracking session
  // must send wheel events to the pty, not scroll xterm.
  pdServerMouseApp: ptyServerFixture({
    prefix: 'pdmouse',
    shellCmd: `bash ${path.resolve(__dirname, 'mouse-app.sh')}`,
  }),

  // Leaves SHELL_CMD UNSET, so pocket-dev owns the command line and the whole
  // conversation machinery switches on: pd-claude-session runs, mints a uuid,
  // and records it in the state dir. A stub `claude` earlier on PATH stands in
  // for the real one and then execs cat, so the terminal still echoes.
  //
  // This is the only fixture that can reach titles, sid files, and resume. The
  // cat fixture cannot: setting SHELL_CMD disables all of it by design.
  pdServerClaudeStub: async ({}, use) => {
    const port        = await pickPort();
    const sessionName = `pdstub-${port}`;
    const stateDir    = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-e2e-stub-'));
    const projectsDir = path.join(stateDir, 'projects');
    const argvLog     = path.join(stateDir, 'claude-argv.log');
    await fs.mkdir(projectsDir, { recursive: true });

    const env = {
      ...process.env,
      PORT: String(port),
      TMUX_SESSION: sessionName,
      PD_STATE_DIR: stateDir,
      PD_CLAUDE_PROJECTS_DIR: projectsDir,
      PATH: `${path.resolve(__dirname, 'stub-bin')}:${process.env.PATH}`,
    };
    delete env.SHELL_CMD;

    let proc = await spawnReady({ scriptPath: SERVER_PATH, env, readySubstring: 'pocket-dev on' });

    await use({
      port,
      baseURL: `http://localhost:${port}`,
      stateDir,
      projectsDir,
      sessionName,
      // The launcher mints the uuid at runtime, so tests read it back rather
      // than choosing it. It is written a moment AFTER the pty spawns, so this
      // waits rather than assuming: a WebSocket that is already connected is
      // not proof the launcher has reached its first line.
      async uuidFor(id, { timeoutMs = 8000 } = {}) {
        const file = path.join(stateDir, 'sids', `${id}.uuid`);
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          try {
            const uuid = (await fs.readFile(file, 'utf8')).trim();
            if (uuid) return uuid;
          } catch { /* not written yet */ }
          if (Date.now() > deadline) throw new Error(`no conversation id recorded for ${id} within ${timeoutMs}ms`);
          await new Promise(r => setTimeout(r, 100));
        }
      },
      async claudeArgv() {
        try { return (await fs.readFile(argvLog, 'utf8')).trim().split('\n').filter(Boolean); }
        catch { return []; }
      },
      // Write a transcript for a session's conversation, the way Claude would.
      async writeTranscript(uuid, records) {
        const dir = path.join(projectsDir, '-home-claude');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, `${uuid}.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n');
      },
      async restart({ killTmux = false, signal = 'SIGTERM' } = {}) {
        await killProcAndWait(proc, signal);
        if (killTmux) await killTmuxSessionsByPrefix(sessionName);
        proc = await spawnReady({ scriptPath: SERVER_PATH, env, readySubstring: 'pocket-dev on' });
      },
    });

    await killProcAndWait(proc);
    await killTmuxSessionsByPrefix(sessionName);
    await fs.rm(stateDir, { recursive: true, force: true });
  },

  // Static-serving only (no PTY, no WebSocket, no tmux). The page's WS connection
  // will fail and stay in the disconnected state — that's the contract for tests
  // that only need to verify rendering.
  pdStaticServer: async ({}, use) => {
    const port = await pickPort();
    const proc = await spawnReady({
      scriptPath: path.resolve(__dirname, 'static-server.js'),
      env: { ...process.env, PORT: String(port) },
      readySubstring: 'pocket-dev static on',
    });

    await use({ port, baseURL: `http://localhost:${port}` });

    await killProcAndWait(proc);
  },
});

// Common helpers used by multiple specs. Kept in the fixture module so the
// `test=1` query string, the toolbar-expand init script, and the connected-dot
// wait all stay in one place.
export async function gotoTest(page, server) {
  // A collapsed toolbar is max-height: 0, which makes the Copy/Stop/Sessions
  // buttons unreachable for clicks (the parent #controls intercepts pointer
  // events). Pin it open before navigation so any test can click toolbar
  // buttons without per-spec boilerplate.
  //
  // This WRITES the preference, so it also defeats the per-form-factor default
  // (expanded on desktop, collapsed on a phone), which only applies when the
  // key is absent. Anything testing that default must navigate with gotoRaw.
  await page.addInitScript(() => {
    localStorage.setItem('pd-toolbar-collapsed', 'false');
  });
  await page.goto(server.baseURL + '/?test=1');
}

// Panes are created by createSession(), which is a fetch: the click that starts
// it returns before the pane exists, so tests that need the second pane have to
// wait for it rather than for the click.
export async function waitForPanes(page, n) {
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('.terminal-pane').length), { timeout: 10000 })
    .toBe(n);
}

// Navigate with no preferences seeded, for tests about first-run defaults.
export async function gotoRaw(page, server) {
  await page.goto(server.baseURL + '/?test=1');
}

export async function waitForConnection(page, timeout = 5000) {
  await page.waitForFunction(
    () => document.getElementById('conn-dot').classList.contains('connected'),
    null,
    { timeout },
  );
}

// ── Driving the session list ────────────────────────────────────────────────
// The list is how you move between sessions now, so most specs need these.
// They live here rather than being copied per spec: when the UI moves again,
// there is one place to change.

export async function openSessionList(page) {
  await page.click('#sessions-btn');
}

// Which session's pane is on screen. The single synchronous fact that says a
// switch has actually COMPLETED: setActive toggles the class on every pane
// before anything async happens.
export async function activeSessionId(page) {
  return page.evaluate(() => document.querySelector('.terminal-pane.active')?.dataset.sessionId ?? null);
}

// Wait until the pane on screen is a DIFFERENT session than before.
//
// `waitForConnection` is not this: a socket can be open on a session that is not
// the one being switched to, so a test that only waits for a connection can act
// while the previous session is still the active one. Leaving a session now
// flushes its read state, so acting in that window drives output into a session
// the client is about to mark read, and the test sees a state no user could
// produce. Caught 2026-07-27 in `opening a session is what marks it read`.
async function waitForActiveChange(page, previous) {
  await expect.poll(async () => {
    const now = await activeSessionId(page);
    return now !== null && now !== previous;
  }, { timeout: 10000 }).toBe(true);
}

// Start a tab on the DEFAULT provider. The button is labelled by harness now,
// not `+ New`: the picker uses explicit buttons so the choice and the action
// are the same tap and the harness name is in the label. Twenty-eight calls
// across nine specs come through here, so this selector is the single place
// that has to track that label. DO NOT inline `page.click` on the picker in a
// spec; go through one of these helpers.
export async function newSession(page) {
  return newSessionWithProvider(page, 'Claude');
}

// Start a tab on a named provider. `label` is the provider's display label as
// the server supplies it, which is what the button carries.
export async function newSessionWithProvider(page, label) {
  const before = await activeSessionId(page);
  await openSessionList(page);
  await page.click(`#sl-bar >> text=+ ${label}`);
  await waitForActiveChange(page, before);
}

export async function switchToRow(page, index) {
  const before = await activeSessionId(page);
  await openSessionList(page);
  const row    = page.locator('.sl-row').nth(index);
  // Read the target BEFORE clicking: tapping the row you are already in is a
  // legitimate no-op, and there is no change to wait for in that case.
  const target = await row.getAttribute('data-session-id');
  await row.click();
  if (target !== before) await waitForActiveChange(page, before);
}

// Kill lives in the session itself, next to the thing it destroys, rather than
// on a list you scan one-handed. It is two taps: the button reads ✕ until the
// first press arms it, then Kill? until the second confirms. Tests go through
// both presses rather than calling tmuxKill(), so the arming step stays covered
// by everything that kills a session.
export async function killActiveSession(page) {
  const btn = page.locator('#kill-btn');
  await btn.click();
  await expect(btn).toHaveText('Kill?');
  await btn.click();
}

export async function sessionRows(page) {
  return page.evaluate(async () => (await (await fetch('/sessions')).json()));
}

// Type a marker into the input bar, click Send, and wait for the marker to
// actually arrive back in xterm.js's terminal DOM (proves the full PTY
// roundtrip: POST /send → tmux → bash → cat → echo → ws → term.write).
//
// Replaces the older `fill + click + waitForTimeout(500)` pattern, which
// was racing cat-startup on CI runners. There is no "fixture is ready"
// signal we can wait for at fixture-construction time (the only synchronous
// proof tmux + bash + cat are all live is seeing input echo back), so we
// do the proof at test time, per send.
//
// Whitespace is collapsed before comparison: long lines wrap in xterm.js,
// so the visible text contains line breaks splitting the marker, but those
// breaks are layout noise, not data loss.
export async function sendAndWaitForEcho(page, text, { timeout = 8000 } = {}) {
  await page.fill('#cmd-input', text);
  await page.click('#send-btn');
  const expected = text.replace(/\s+/g, '');
  await expect
    .poll(
      async () => {
        const visible = await page.evaluate(
          () => document.querySelector('#terminal-container').innerText,
        );
        return visible.replace(/\s+/g, '');
      },
      { timeout },
    )
    .toContain(expected);
}

export { expect };
