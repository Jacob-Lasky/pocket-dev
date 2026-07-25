import { test as base, expect } from '@playwright/test';
import { spawn, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

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
async function spawnReady({ scriptPath, env, readySubstring, timeoutMs = 5000 }) {
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

export const test = base.extend({
  // Uses `cat` as a deterministic SHELL_CMD so typing `hello\n` in #cmd-input
  // echoes `hello\n` back into the buffer.
  pdServer: ptyServerFixture({ prefix: 'pdtest', shellCmd: 'cat' }),

  // SHELL_CMD replays a captured real Claude TUI frame (alt-screen,
  // CHA-positioned words) instead of `cat`. Exercises the View renderer against
  // the exact content the old serialize()+ansi_up path mangled.
  pdServerClaudeFrame: ptyServerFixture({
    prefix: 'pdframe',
    shellCmd: `bash ${path.resolve(__dirname, 'replay-claude-frame.sh')}`,
  }),

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
  // Default localStorage state has the toolbar collapsed (max-height: 0), which
  // makes the Copy/Select/tmux buttons unreachable for clicks (the parent
  // #controls intercepts pointer events). Expand it before navigation so any
  // test can click toolbar buttons without per-spec boilerplate.
  await page.addInitScript(() => {
    localStorage.setItem('pd-toolbar-collapsed', 'false');
  });
  await page.goto(server.baseURL + '/?test=1');
}

export async function waitForConnection(page, timeout = 5000) {
  await page.waitForFunction(
    () => document.getElementById('conn-dot').classList.contains('connected'),
    null,
    { timeout },
  );
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
