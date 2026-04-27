import { test as base, expect } from '@playwright/test';
import { spawn, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import net from 'node:net';

const execFile = promisify(execFileCb);

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

async function killProcAndWait(proc) {
  proc.kill('SIGTERM');
  await new Promise(resolve => proc.on('exit', resolve));
}

// Tmux server keeps running after our spawned `node server.js` exits — explicitly
// kill the test session so repeated local runs don't accumulate orphan sessions.
async function killTmuxSession(name) {
  try {
    await execFile('tmux', ['kill-session', '-t', name]);
  } catch {
    // Either tmux isn't installed or the session no longer exists; both are fine.
  }
}

export const test = base.extend({
  // Full server with PTY + WebSocket. Uses `cat` as a deterministic SHELL_CMD so
  // typing `hello\n` in #cmd-input echoes `hello\n` back into the buffer.
  pdServer: async ({}, use) => {
    const port = await pickPort();
    const sessionName = `pdtest-${port}`;
    const proc = await spawnReady({
      scriptPath: path.resolve(__dirname, '../../server.js'),
      env: {
        ...process.env,
        PORT: String(port),
        SHELL_CMD: 'cat',
        TMUX_SESSION: sessionName,
      },
      readySubstring: 'pocket-dev on',
    });

    await use({ port, baseURL: `http://localhost:${port}` });

    await killProcAndWait(proc);
    await killTmuxSession(sessionName);
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
// `test=1` query string and the connected-dot wait stay in one place.
export async function gotoTest(page, server) {
  await page.goto(server.baseURL + '/?test=1');
}

export async function waitForConnection(page, timeout = 5000) {
  await page.waitForFunction(
    () => document.getElementById('conn-dot').classList.contains('connected'),
    null,
    { timeout },
  );
}

export { expect };
