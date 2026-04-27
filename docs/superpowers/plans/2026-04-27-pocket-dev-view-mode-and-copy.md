# pocket-dev View Mode + Copy QoL Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four pocket-dev pain points (trailing-whitespace copy, mobile width, scrollback duplication, no top-level copy) with a wrapped HTML View mode alongside Live xterm.js, HTTP-safe clipboard helpers, and a tmux config tweak — all backed by Vitest + Playwright tests.

**Architecture:** Two co-mounted rendering surfaces share xterm.js as source of truth: the existing Live xterm.js terminal, and a new wrapped HTML View pane that uses `@xterm/addon-serialize` + `ansi_up` to render xterm.js's buffer into a `<div>` with `white-space: pre-wrap`. A toolbar toggle switches between them; mobile defaults to View, desktop to Live. Server-side, a small `tmux.conf` disables alternate-screen and enables focus-events. All clipboard writes go through a single helper that strips trailing whitespace and falls back to `document.execCommand('copy')` when `navigator.clipboard` is unavailable (HTTP).

**Tech Stack:** Node.js 20, Express, node-pty, ws, xterm.js 5, `@xterm/addon-serialize`, `ansi_up`. Tests: Vitest (unit + server), Supertest (HTTP), `@playwright/test` (E2E in Firefox + Chromium with Pixel 5 emulation), happy-dom (DOM in unit tests).

**Spec:** `docs/superpowers/specs/2026-04-27-pocket-dev-view-mode-and-copy-design.md`

---

## File Structure

**Modified:**
- `mobile/server.js` — refactor to export the express app + spawn-args builder; remove `/history`; pass `-f tmux.conf` to tmux.
- `mobile/public/index.html` — add View pane HTML/CSS, mode toggle, top-level Copy button, ES-module `<script>` tags; remove Select overlay; replace `copyOnSelect` with `onSelectionChange`; bump `scrollback` to 10000.
- `mobile/package.json` — add prod deps (`@xterm/addon-serialize`, `ansi_up`); add dev deps (`vitest`, `supertest`, `@playwright/test`, `happy-dom`); add `test`, `test:e2e`, `test:all` scripts.
- `Dockerfile` — no source changes, but verify the new `mobile/tmux.conf` gets copied (it does, via the existing `COPY mobile/`).

**Created — production code:**
- `mobile/tmux.conf` — `alternate-screen off`, `focus-events on`.
- `mobile/public/js/clipboard.js` — ES module exporting `trimTrailingWhitespace` and `clipboardWrite`.
- `mobile/public/js/view.js` — ES module exporting `ViewRenderer` class (init, update, sticky-bottom).
- `mobile/public/js/mode.js` — ES module exporting `detectDefaultMode` and `applyMode` helpers.

**Created — tests:**
- `mobile/vitest.config.js`
- `mobile/playwright.config.js`
- `mobile/test/unit/clipboard.test.js`
- `mobile/test/unit/view.test.js`
- `mobile/test/unit/mode.test.js`
- `mobile/test/server/serverArgs.test.js`
- `mobile/test/server/endpoints.test.js`
- `mobile/test/server/tmuxConf.test.js`
- `mobile/test/e2e/smoke.spec.js`
- `mobile/test/e2e/copy.spec.js`
- `mobile/test/e2e/firefox-mobile.spec.js`
- `mobile/test/e2e/fixtures.js` — shared server-startup fixture

**Created — meta:**
- `mobile/MANUAL-VERIFICATION.md` — checklist for manual checks.
- `.github/workflows/test.yml` — CI runs `npm ci && npm run test:all`.

---

## Task 1: Test infrastructure scaffolding

**Files:**
- Modify: `mobile/package.json`
- Create: `mobile/vitest.config.js`
- Create: `mobile/playwright.config.js`
- Create: `mobile/test/.gitkeep`

- [ ] **Step 1: Add devDependencies and scripts to `mobile/package.json`**

Replace contents of `mobile/package.json` with:

```json
{
  "name": "pocket-dev",
  "version": "1.0.0",
  "scripts": {
    "start": "node server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "test:all": "npm test && npm run test:e2e"
  },
  "dependencies": {
    "express": "^4.18.2",
    "node-pty": "^1.1.0",
    "ws": "^8.18.0",
    "@xterm/xterm": "^5.5.0",
    "@xterm/addon-fit": "^0.10.0"
  },
  "devDependencies": {
    "vitest": "^1.6.0",
    "supertest": "^7.0.0",
    "@playwright/test": "^1.45.0",
    "happy-dom": "^14.0.0"
  }
}
```

(`@xterm/addon-serialize` and `ansi_up` are added in Task 7, not now — keeps Task 1 focused on test infra.)

- [ ] **Step 2: Create `mobile/vitest.config.js`**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['test/unit/**/*.test.js', 'test/server/**/*.test.js'],
    globals: false,
  },
});
```

- [ ] **Step 3: Create `mobile/playwright.config.js`**

```js
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://localhost:7682',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
    { name: 'pixel5-firefox', use: { ...devices['Pixel 5'], browserName: 'firefox' } },
  ],
});
```

(Workers=1 because all tests share a single server fixture on port 7682. Port differs from prod 7681 to avoid collisions.)

- [ ] **Step 4: Create empty test directory placeholder**

```bash
mkdir -p /c/Coding/pocket-dev/mobile/test/{unit,server,e2e}
touch /c/Coding/pocket-dev/mobile/test/.gitkeep
```

- [ ] **Step 5: Install deps and verify Vitest runs (no tests yet)**

Run from `mobile/`:
```bash
cd /c/Coding/pocket-dev/mobile && npm install
```

Expected: installs without errors. `node_modules/` populated.

```bash
cd /c/Coding/pocket-dev/mobile && npm test
```

Expected: Vitest reports "No test files found" — not an error, just empty. Exit code 0.

- [ ] **Step 6: Commit**

```bash
cd /c/Coding/pocket-dev && git add mobile/package.json mobile/package-lock.json mobile/vitest.config.js mobile/playwright.config.js mobile/test/.gitkeep && git commit -m "test: add vitest + playwright + supertest infrastructure"
```

---

## Task 2: CI workflow

**Files:**
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Create the workflow file**

```yaml
name: test
on:
  push:
    branches: [main]
  pull_request:
jobs:
  unit-and-server:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: mobile
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: mobile/package-lock.json
      - run: npm ci
      - run: npm test
  e2e:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: mobile
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: mobile/package-lock.json
      - run: sudo apt-get update && sudo apt-get install -y tmux
      - run: npm ci
      - run: npx playwright install --with-deps firefox chromium
      - run: npm run test:e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-trace
          path: mobile/test-results
```

- [ ] **Step 2: Commit**

```bash
cd /c/Coding/pocket-dev && git add .github/workflows/test.yml && git commit -m "ci: add test workflow for vitest + playwright"
```

---

## Task 3: Add tmux config file (TDD)

**Files:**
- Create: `mobile/tmux.conf`
- Create: `mobile/test/server/tmuxConf.test.js`

- [ ] **Step 1: Write the failing test**

Create `mobile/test/server/tmuxConf.test.js`:

```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('mobile/tmux.conf', () => {
  const confPath = path.resolve(__dirname, '../../tmux.conf');
  const contents = fs.readFileSync(confPath, 'utf8');

  it('disables alternate-screen', () => {
    expect(contents).toMatch(/^\s*setw\s+-g\s+alternate-screen\s+off\s*$/m);
  });

  it('enables focus-events', () => {
    expect(contents).toMatch(/^\s*set\s+-g\s+focus-events\s+on\s*$/m);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd /c/Coding/pocket-dev/mobile && npm test -- tmuxConf
```

Expected: FAIL — `ENOENT: no such file or directory, open '.../mobile/tmux.conf'`.

- [ ] **Step 3: Create `mobile/tmux.conf`**

```
# pocket-dev tmux config (loaded via `tmux -f`)
# alternate-screen off — keeps all output in main scrollback so xterm.js doesn't show duplicated chunks when a TUI exits alt-screen mode
setw -g alternate-screen off

# focus-events on — forwards browser tab focus-in/focus-out into the inner app (Claude Code) so it can refresh stale UI state
set -g focus-events on
```

- [ ] **Step 4: Run test, verify it passes**

```bash
cd /c/Coding/pocket-dev/mobile && npm test -- tmuxConf
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
cd /c/Coding/pocket-dev && git add mobile/tmux.conf mobile/test/server/tmuxConf.test.js && git commit -m "feat(server): add tmux.conf with alternate-screen off and focus-events on"
```

---

## Task 4: Refactor server tmux spawn args (TDD)

The server today calls `pty.spawn` inline in module-load order, so it isn't testable. Refactor the spawn-args construction into an exported pure function.

**Files:**
- Modify: `mobile/server.js`
- Create: `mobile/test/server/serverArgs.test.js`

- [ ] **Step 1: Write the failing test**

Create `mobile/test/server/serverArgs.test.js`:

```js
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { buildTmuxSpawnArgs } from '../../server.js';

describe('buildTmuxSpawnArgs', () => {
  it('returns args that load mobile/tmux.conf via -f', () => {
    const args = buildTmuxSpawnArgs('main', "echo hi");
    const fIdx = args.indexOf('-f');
    expect(fIdx).toBeGreaterThanOrEqual(0);
    expect(args[fIdx + 1]).toBe(path.resolve(__dirname, '../../tmux.conf'));
  });

  it('passes through session name and command', () => {
    const args = buildTmuxSpawnArgs('mysess', 'cmd-here');
    expect(args).toContain('-s');
    const sIdx = args.indexOf('-s');
    expect(args[sIdx + 1]).toBe('mysess');
    expect(args[args.length - 1]).toBe('cmd-here');
  });

  it('includes -u (UTF-8) and new-session -A (attach if exists)', () => {
    const args = buildTmuxSpawnArgs('main', 'cmd');
    expect(args).toContain('-u');
    expect(args).toContain('new-session');
    expect(args).toContain('-A');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd /c/Coding/pocket-dev/mobile && npm test -- serverArgs
```

Expected: FAIL — `buildTmuxSpawnArgs is not a function` (or similar) because we haven't exported it yet.

- [ ] **Step 3: Refactor `mobile/server.js`**

Replace the section starting at the top (`const express = ...` through line 45 where `ptyProc = pty.spawn(...)` ends) with:

```js
const express  = require('express');
const http     = require('http');
const path     = require('path');
const pty      = require('node-pty');
const { exec } = require('child_process');
const { WebSocketServer } = require('ws');

const SESSION = process.env.TMUX_SESSION || 'main';
const CMD     = process.env.SHELL_CMD    || 'claude --dangerously-skip-permissions --model "opus[1m]"';

// Wrap CMD in a restart loop so Claude relaunches automatically on exit
const LOOP_CMD = `bash -c 'while true; do ${CMD}; echo ; echo restarting...; sleep 1; done'`;

const TMUX_CONF_PATH = path.join(__dirname, 'tmux.conf');

function buildTmuxSpawnArgs(session, loopCmd) {
  return [
    '-u',
    '-f', TMUX_CONF_PATH,
    'new-session', '-A', '-s', session,
    loopCmd,
  ];
}

module.exports = { buildTmuxSpawnArgs };

// Bail out before booting the server when imported for tests
if (require.main !== module) {
  return;
}
```

Wait — `return` only works inside functions. Use a different gate:

```js
const express  = require('express');
const http     = require('http');
const path     = require('path');
const pty      = require('node-pty');
const { exec } = require('child_process');
const { WebSocketServer } = require('ws');

const SESSION = process.env.TMUX_SESSION || 'main';
const CMD     = process.env.SHELL_CMD    || 'claude --dangerously-skip-permissions --model "opus[1m]"';

const LOOP_CMD = `bash -c 'while true; do ${CMD}; echo ; echo restarting...; sleep 1; done'`;
const TMUX_CONF_PATH = path.join(__dirname, 'tmux.conf');

function buildTmuxSpawnArgs(session, loopCmd) {
  return [
    '-u',
    '-f', TMUX_CONF_PATH,
    'new-session', '-A', '-s', session,
    loopCmd,
  ];
}

module.exports = { buildTmuxSpawnArgs };

if (require.main === module) {
  startServer();
}

function startServer() {
  const app = express();
  // ... full server boot below ...
}
```

The full implementation requires moving everything currently at module top into `startServer()`. Apply this exact rewrite to `mobile/server.js`:

```js
const express  = require('express');
const http     = require('http');
const path     = require('path');
const pty      = require('node-pty');
const { exec } = require('child_process');
const { WebSocketServer } = require('ws');

const SESSION = process.env.TMUX_SESSION || 'main';
const CMD     = process.env.SHELL_CMD    || 'claude --dangerously-skip-permissions --model "opus[1m]"';
const PORT    = parseInt(process.env.PORT, 10) || 7681;

const LOOP_CMD = `bash -c 'while true; do ${CMD}; echo ; echo restarting...; sleep 1; done'`;
const TMUX_CONF_PATH = path.join(__dirname, 'tmux.conf');

function buildTmuxSpawnArgs(session, loopCmd) {
  return [
    '-u',
    '-f', TMUX_CONF_PATH,
    'new-session', '-A', '-s', session,
    loopCmd,
  ];
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/xterm',           express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
  app.use('/addon-fit',       express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
  return app;
}

module.exports = { buildTmuxSpawnArgs, createApp, TMUX_CONF_PATH };

if (require.main === module) {
  startServer();
}

function startServer() {
  const app = createApp();

  const MAX_REPLAY_BYTES = 512 * 1024;
  let replayBuffer = '';

  function appendToReplay(data) {
    replayBuffer += data;
    if (replayBuffer.length > MAX_REPLAY_BYTES * 1.5) {
      const start = replayBuffer.length - MAX_REPLAY_BYTES;
      const nlPos = replayBuffer.indexOf('\n', start);
      replayBuffer = replayBuffer.slice(nlPos >= 0 ? nlPos + 1 : start);
    }
  }

  const ptyProc = pty.spawn('tmux', buildTmuxSpawnArgs(SESSION, LOOP_CMD), {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd:  process.env.HOME || '/workspace',
    env:  { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });

  let currentCols = 120;
  let currentRows = 40;

  app.post('/send', (req, res) => {
    const { text } = req.body;
    if (typeof text !== 'string' || !text.length)
      return res.status(400).json({ error: 'text required' });
    ptyProc.write(text);
    ptyProc.write('\r');
    res.json({ ok: true });
  });

  app.post('/key', (req, res) => {
    const { key } = req.body;
    const ctrlMatch = key.match(/^ctrl-([a-z])$/);
    if (ctrlMatch) {
      ptyProc.write(String.fromCharCode(ctrlMatch[1].charCodeAt(0) - 96));
      return res.json({ ok: true });
    }
    const sequences = {
      escape: '\x1b', tab: '\t', enter: '\r',
      left: '\x1b[D', right: '\x1b[C', up: '\x1b[A', down: '\x1b[B',
    };
    const seq = sequences[key];
    if (!seq) return res.status(400).json({ error: 'unknown key' });
    ptyProc.write(seq);
    res.json({ ok: true });
  });

  app.post('/tmux-kill', (req, res) => {
    const getActive = `tmux display-message -t ${SESSION} -p '#{window_id}' 2>/dev/null`;
    const countWindows = `tmux list-windows -t ${SESSION} 2>/dev/null | wc -l`;
    exec(`${getActive} && ${countWindows}`, { shell: true }, (err, stdout) => {
      const lines = stdout?.trim().split('\n') || [];
      const windowId = lines[0];
      const windowCount = parseInt(lines[1], 10) || 0;
      if (windowCount <= 1) {
        exec(`tmux new-window -t ${SESSION} cdspo; tmux kill-window -t ${windowId} 2>/dev/null || true`, { shell: true }, () => {
          res.json({ ok: true, respawned: true });
        });
      } else {
        exec(`tmux kill-window -t ${windowId} 2>/dev/null`, { shell: true }, () => {
          res.json({ ok: true, respawned: false });
        });
      }
    });
  });

  app.post('/refresh', (req, res) => {
    exec(`tmux list-clients -F '#{client_name}' | xargs -I{} tmux refresh-client -t {}`, { shell: true }, (err) => res.json({ ok: !err }));
  });

  const server  = http.createServer(app);
  const wss     = new WebSocketServer({ noServer: true });
  const clients = new Set();

  ptyProc.onData(data => {
    appendToReplay(data);
    for (const ws of clients)
      if (ws.readyState === 1) ws.send(data);
  });

  wss.on('connection', ws => {
    clients.add(ws);
    if (replayBuffer.length > 0) ws.send(replayBuffer);
    ws.on('message', data => {
      const msg = data.toString();
      if (msg.startsWith('{')) {
        try {
          const parsed = JSON.parse(msg);
          if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
            const newCols = Math.max(1, parsed.cols);
            const newRows = Math.max(1, parsed.rows);
            if (newCols !== currentCols || newRows !== currentRows) {
              currentCols = newCols;
              currentRows = newRows;
              ptyProc.resize(newCols, newRows);
            }
          }
        } catch {}
      } else {
        ptyProc.write(msg);
      }
    });
    ws.on('close', () => clients.delete(ws));
  });

  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws')
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  server.listen(PORT, '0.0.0.0', () =>
    console.log(`pocket-dev on :${PORT}  (tmux: ${SESSION}  cmd: ${CMD})`));
}
```

Key changes from current state:
- Removed the `/history` endpoint (don't add it back in this refactor — it gets removed by the spec; doing it here keeps Task 4 a single coherent commit).
- All state moved inside `startServer()` so importing `server.js` for tests does not start anything.
- Added `PORT` env var so tests can use a non-prod port.
- Added `createApp()` exported for `endpoints.test.js` in Task 5.

- [ ] **Step 4: Run test, verify it passes**

```bash
cd /c/Coding/pocket-dev/mobile && npm test -- serverArgs
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Smoke-check the server still boots**

```bash
cd /c/Coding/pocket-dev/mobile && PORT=7682 timeout 3 node server.js 2>&1 | head -5 || true
```

Expected: Output line `pocket-dev on :7682  (tmux: main  cmd: ...)`. Process killed by timeout (exit 124) — that's fine. (If tmux isn't installed locally on the dev machine, the spawn will fail with ENOENT — that's also OK for this smoke check; we're only verifying the JS module loads.)

- [ ] **Step 6: Commit**

```bash
cd /c/Coding/pocket-dev && git add mobile/server.js mobile/test/server/serverArgs.test.js && git commit -m "refactor(server): extract buildTmuxSpawnArgs + createApp; remove /history; gate boot on require.main"
```

---

## Task 5: Verify `/history` endpoint is gone (TDD)

The refactor in Task 4 already removed `/history`. This task adds the test that locks it in.

**Files:**
- Create: `mobile/test/server/endpoints.test.js`

- [ ] **Step 1: Write the test**

Create `mobile/test/server/endpoints.test.js`:

```js
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../server.js';

describe('express endpoints', () => {
  const app = createApp();

  it('GET /history returns 404 (endpoint removed)', async () => {
    const res = await request(app).get('/history');
    expect(res.status).toBe(404);
  });

  it('GET / returns the index.html', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('pocket-dev');
  });

  it('serves xterm.js static assets', async () => {
    const res = await request(app).get('/xterm/lib/xterm.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
  });
});
```

- [ ] **Step 2: Run test**

```bash
cd /c/Coding/pocket-dev/mobile && npm test -- endpoints
```

Expected: PASS, 3 tests. (`/history` returns 404 because it no longer exists; the rest verify the static-serving still works.)

- [ ] **Step 3: Commit**

```bash
cd /c/Coding/pocket-dev && git add mobile/test/server/endpoints.test.js && git commit -m "test(server): assert /history is removed; smoke-test static serving"
```

---

## Task 6: Clipboard helper module (TDD)

**Files:**
- Create: `mobile/public/js/clipboard.js`
- Create: `mobile/test/unit/clipboard.test.js`

- [ ] **Step 1: Write the failing tests**

Create `mobile/test/unit/clipboard.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { trimTrailingWhitespace, clipboardWrite } from '../../public/js/clipboard.js';

describe('trimTrailingWhitespace', () => {
  it('strips trailing spaces and tabs per line', () => {
    expect(trimTrailingWhitespace('hello   \nworld\t\nfoo')).toBe('hello\nworld\nfoo');
  });

  it('preserves intentional internal whitespace', () => {
    expect(trimTrailingWhitespace('a  b\nc   d')).toBe('a  b\nc   d');
  });

  it('preserves leading whitespace (indentation)', () => {
    expect(trimTrailingWhitespace('    indented   \n  also  ')).toBe('    indented\n  also');
  });

  it('handles empty input', () => {
    expect(trimTrailingWhitespace('')).toBe('');
  });
});

describe('clipboardWrite', () => {
  let originalClipboard;
  beforeEach(() => { originalClipboard = navigator.clipboard; });
  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
  });

  function setClipboard(value) {
    Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
  }

  it('uses navigator.clipboard.writeText when available; resolves true', async () => {
    const writeText = vi.fn().mockResolvedValue();
    setClipboard({ writeText });
    const ok = await clipboardWrite('hello   \nworld');
    expect(writeText).toHaveBeenCalledWith('hello\nworld');
    expect(ok).toBe(true);
  });

  it('falls back to execCopy when navigator.clipboard is undefined', async () => {
    setClipboard(undefined);
    const execCopy = vi.fn(() => true);
    const ok = await clipboardWrite('text  ', { execCopy });
    expect(execCopy).toHaveBeenCalledWith('text');
    expect(ok).toBe(true);
  });

  it('falls back to execCopy when navigator.clipboard.writeText rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('permission denied'));
    setClipboard({ writeText });
    const execCopy = vi.fn(() => true);
    const ok = await clipboardWrite('text', { execCopy });
    expect(writeText).toHaveBeenCalled();
    expect(execCopy).toHaveBeenCalledWith('text');
    expect(ok).toBe(true);
  });

  it('returns false when both paths fail', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('nope'));
    setClipboard({ writeText });
    const execCopy = vi.fn(() => false);
    const ok = await clipboardWrite('text', { execCopy });
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd /c/Coding/pocket-dev/mobile && npm test -- clipboard
```

Expected: FAIL — module not found (`./public/js/clipboard.js`).

- [ ] **Step 3: Create `mobile/public/js/clipboard.js`**

```js
// pocket-dev clipboard helper
// Exports a single async writer that strips trailing whitespace per line
// and falls back to document.execCommand('copy') on HTTP where
// navigator.clipboard is unavailable.

export function trimTrailingWhitespace(text) {
  return text.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n');
}

function defaultExecCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  document.body.removeChild(ta);
  return ok;
}

export async function clipboardWrite(text, { execCopy = defaultExecCopy } = {}) {
  const clean = trimTrailingWhitespace(text);
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(clean);
      return true;
    } catch {
      return execCopy(clean);
    }
  }
  return execCopy(clean);
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd /c/Coding/pocket-dev/mobile && npm test -- clipboard
```

Expected: PASS, 8 tests (4 for `trimTrailingWhitespace`, 4 for `clipboardWrite`).

- [ ] **Step 5: Commit**

```bash
cd /c/Coding/pocket-dev && git add mobile/public/js/clipboard.js mobile/test/unit/clipboard.test.js && git commit -m "feat(client): add clipboard helper with trim + execCommand fallback"
```

---

## Task 7: Add View mode dependencies

**Files:**
- Modify: `mobile/package.json`
- Modify: `mobile/server.js` (add static routes for the two new packages)

- [ ] **Step 1: Add deps to package.json**

Edit `mobile/package.json` to add to `dependencies`:

```json
"@xterm/addon-serialize": "^0.13.0",
"ansi_up": "^6.0.2"
```

The dependencies block becomes:
```json
"dependencies": {
  "express": "^4.18.2",
  "node-pty": "^1.1.0",
  "ws": "^8.18.0",
  "@xterm/xterm": "^5.5.0",
  "@xterm/addon-fit": "^0.10.0",
  "@xterm/addon-serialize": "^0.13.0",
  "ansi_up": "^6.0.2"
}
```

- [ ] **Step 2: Install**

```bash
cd /c/Coding/pocket-dev/mobile && npm install
```

Expected: both packages added to `node_modules/`.

- [ ] **Step 3: Add static routes for the two new packages**

In `mobile/server.js`, inside `createApp()`, after the existing `/addon-fit` static route, add two more lines so the block reads:

```js
app.use('/xterm',           express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/addon-fit',       express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use('/addon-serialize', express.static(path.join(__dirname, 'node_modules/@xterm/addon-serialize')));
app.use('/ansi-up',         express.static(path.join(__dirname, 'node_modules/ansi_up')));
```

- [ ] **Step 4: Verify tests still pass**

```bash
cd /c/Coding/pocket-dev/mobile && npm test
```

Expected: all tests still pass (no behavior change relevant to existing tests).

- [ ] **Step 5: Smoke-check the static routes**

Add a quick assertion to `mobile/test/server/endpoints.test.js`:

```js
  it('serves @xterm/addon-serialize', async () => {
    const res = await request(app).get('/addon-serialize/lib/addon-serialize.js');
    expect(res.status).toBe(200);
  });

  it('serves ansi_up', async () => {
    const res = await request(app).get('/ansi-up/ansi_up.js');
    expect(res.status).toBe(200);
  });
```

(Insert before the closing `});` of the `describe` block.)

Run:
```bash
cd /c/Coding/pocket-dev/mobile && npm test -- endpoints
```

Expected: PASS, 5 tests now.

- [ ] **Step 6: Commit**

```bash
cd /c/Coding/pocket-dev && git add mobile/package.json mobile/package-lock.json mobile/server.js mobile/test/server/endpoints.test.js && git commit -m "feat(client): add @xterm/addon-serialize + ansi_up deps and static routes"
```

---

## Task 8: View renderer module (TDD)

The renderer takes ANSI-bearing text (later: dumped from xterm.js's serialize addon) and renders it as styled HTML into a content element, with sticky-bottom autoscroll behavior.

**Files:**
- Create: `mobile/public/js/view.js`
- Create: `mobile/test/unit/view.test.js`

- [ ] **Step 1: Write the failing tests**

Create `mobile/test/unit/view.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ViewRenderer } from '../../public/js/view.js';

class FakeAnsiUp {
  ansi_to_html(s) {
    // Strip ANSI escape codes; return plain text wrapped in a span for sanity.
    const stripped = s.replace(/\x1b\[[0-9;]*m/g, '');
    return `<span>${stripped.replace(/</g, '&lt;')}</span>`;
  }
}

function makeContainer() {
  const scroll = document.createElement('div');
  scroll.style.cssText = 'height:100px;overflow-y:auto';
  const content = document.createElement('div');
  scroll.appendChild(content);
  document.body.appendChild(scroll);
  return { scroll, content };
}

describe('ViewRenderer', () => {
  let scroll, content, renderer;
  beforeEach(() => {
    document.body.innerHTML = '';
    ({ scroll, content } = makeContainer());
    renderer = new ViewRenderer({ scrollEl: scroll, contentEl: content, ansiUp: new FakeAnsiUp() });
  });

  it('renders plain text into contentEl', () => {
    renderer.update('hello world');
    expect(content.innerHTML).toContain('hello world');
  });

  it('strips ANSI escape codes via ansiUp', () => {
    renderer.update('\x1b[31mred\x1b[0m');
    expect(content.textContent).toBe('red');
  });

  it('replaces content on each update (not appends)', () => {
    renderer.update('first');
    renderer.update('second');
    expect(content.textContent).not.toContain('first');
    expect(content.textContent).toBe('second');
  });

  it('handles empty input without throwing', () => {
    expect(() => renderer.update('')).not.toThrow();
    expect(content.textContent).toBe('');
  });

  it('escapes HTML so embedded markup does not execute', () => {
    renderer.update('<script>x</script>');
    // FakeAnsiUp escapes; real ansi_up also escapes by default.
    expect(content.innerHTML).not.toContain('<script>');
  });

  it('auto-scrolls to bottom on update when previously at bottom', () => {
    // Make content tall so scrollHeight > clientHeight
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 100 });
    scroll.scrollTop = 900; // at bottom (within sticky threshold)
    renderer.update('x'.repeat(5000));
    expect(scroll.scrollTop).toBe(scroll.scrollHeight - scroll.clientHeight);
  });

  it('does NOT auto-scroll when user has scrolled up', () => {
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, get: () => 100 });
    scroll.scrollTop = 200; // not at bottom (well above threshold)
    renderer.update('x'.repeat(5000));
    expect(scroll.scrollTop).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd /c/Coding/pocket-dev/mobile && npm test -- view
```

Expected: FAIL — `Cannot find module './public/js/view.js'`.

- [ ] **Step 3: Create `mobile/public/js/view.js`**

```js
// pocket-dev View mode renderer
// Takes ANSI-bearing text (typically from xterm.js's serialize addon) and
// renders it as styled HTML into a content element with sticky-bottom scroll.

const STICKY_BOTTOM_THRESHOLD_PX = 50;

export class ViewRenderer {
  constructor({ scrollEl, contentEl, ansiUp }) {
    this.scrollEl = scrollEl;
    this.contentEl = contentEl;
    this.ansiUp = ansiUp;
  }

  isAtBottom() {
    const { scrollTop, scrollHeight, clientHeight } = this.scrollEl;
    return scrollHeight - (scrollTop + clientHeight) <= STICKY_BOTTOM_THRESHOLD_PX;
  }

  scrollToBottom() {
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight - this.scrollEl.clientHeight;
  }

  update(text) {
    const wasAtBottom = this.isAtBottom();
    this.contentEl.innerHTML = this.ansiUp.ansi_to_html(text);
    if (wasAtBottom) this.scrollToBottom();
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd /c/Coding/pocket-dev/mobile && npm test -- view
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd /c/Coding/pocket-dev && git add mobile/public/js/view.js mobile/test/unit/view.test.js && git commit -m "feat(client): add ViewRenderer for ANSI->HTML wrapped reading view"
```

---

## Task 9: Mode toggle module (TDD)

Pure logic for picking the default mode (`'live'` or `'view'`) and applying a mode to the DOM.

**Files:**
- Create: `mobile/public/js/mode.js`
- Create: `mobile/test/unit/mode.test.js`

- [ ] **Step 1: Write the failing tests**

Create `mobile/test/unit/mode.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { detectDefaultMode, applyMode } from '../../public/js/mode.js';

describe('detectDefaultMode', () => {
  it('returns "view" when pointer is coarse (mobile/touch)', () => {
    const matchMedia = vi.fn(q => ({ matches: q === '(pointer: coarse)' }));
    expect(detectDefaultMode({ matchMedia })).toBe('view');
  });

  it('returns "live" when pointer is fine (desktop)', () => {
    const matchMedia = vi.fn(() => ({ matches: false }));
    expect(detectDefaultMode({ matchMedia })).toBe('live');
  });
});

describe('applyMode', () => {
  let body, livePane, viewPane, liveBtn, viewBtn;
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="live-pane"></div>
      <div id="view-pane"></div>
      <button id="mode-live"></button>
      <button id="mode-view"></button>
    `;
    body = document.body;
    livePane = document.getElementById('live-pane');
    viewPane = document.getElementById('view-pane');
    liveBtn = document.getElementById('mode-live');
    viewBtn = document.getElementById('mode-view');
  });

  it('sets data-mode on body to "live" and hides view pane', () => {
    applyMode('live', { body, livePane, viewPane, liveBtn, viewBtn });
    expect(body.dataset.mode).toBe('live');
    expect(viewPane.style.display).toBe('none');
    expect(livePane.style.display).not.toBe('none');
  });

  it('sets data-mode on body to "view" and hides live pane via visibility', () => {
    applyMode('view', { body, livePane, viewPane, liveBtn, viewBtn });
    expect(body.dataset.mode).toBe('view');
    // Live stays visible/mounted but offscreen so xterm.js stays sized; we use `visibility: hidden` not `display: none`.
    expect(livePane.style.visibility).toBe('hidden');
    expect(viewPane.style.display).not.toBe('none');
  });

  it('toggles active class on the matching button', () => {
    applyMode('live', { body, livePane, viewPane, liveBtn, viewBtn });
    expect(liveBtn.classList.contains('active')).toBe(true);
    expect(viewBtn.classList.contains('active')).toBe(false);

    applyMode('view', { body, livePane, viewPane, liveBtn, viewBtn });
    expect(liveBtn.classList.contains('active')).toBe(false);
    expect(viewBtn.classList.contains('active')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd /c/Coding/pocket-dev/mobile && npm test -- mode
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `mobile/public/js/mode.js`**

```js
// pocket-dev mode toggle
// Picks default ('live' for fine pointer/desktop, 'view' for coarse/mobile)
// and applies a mode to the DOM. Live pane stays mounted but visibility-hidden
// in view mode so xterm.js retains its sizing and the WebSocket pipe keeps
// streaming into the buffer.

export function detectDefaultMode({ matchMedia = window.matchMedia.bind(window) } = {}) {
  return matchMedia('(pointer: coarse)').matches ? 'view' : 'live';
}

export function applyMode(mode, { body, livePane, viewPane, liveBtn, viewBtn }) {
  body.dataset.mode = mode;
  if (mode === 'live') {
    livePane.style.display = '';
    livePane.style.visibility = '';
    viewPane.style.display = 'none';
    liveBtn.classList.add('active');
    viewBtn.classList.remove('active');
  } else {
    // view mode: keep live pane mounted but hidden
    livePane.style.display = '';
    livePane.style.visibility = 'hidden';
    viewPane.style.display = '';
    liveBtn.classList.remove('active');
    viewBtn.classList.add('active');
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd /c/Coding/pocket-dev/mobile && npm test -- mode
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
cd /c/Coding/pocket-dev && git add mobile/public/js/mode.js mobile/test/unit/mode.test.js && git commit -m "feat(client): add mode-toggle module (detectDefaultMode + applyMode)"
```

---

## Task 10: Add View pane HTML + CSS

UI scaffolding for the new View pane. No JS wiring yet — that comes in Task 11.

**Files:**
- Modify: `mobile/public/index.html`

- [ ] **Step 1: Add View pane CSS**

Insert these rules into the `<style>` block in `index.html`, after the existing `#select-overlay` rules (~line 213, just before the `@media (min-width: 768px)` block at ~line 216):

```css
/* ── View Pane (wrapped reader) ──────────────────────────────────────── */
#view-pane {
  position: absolute;
  inset: 0;
  display: none;
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  background: #0d1117;
  padding: 8px 10px;
  z-index: 5;
}

body[data-mode="view"] #view-pane { display: block; }

#view-content {
  margin: 0;
  font-family: 'SF Mono', Consolas, 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.45;
  color: #e6edf3;
  white-space: pre-wrap;
  word-break: break-word;
  cursor: text;
  user-select: text;
  -webkit-user-select: text;
}

/* Mode toggle styling */
.mode-btn.active { background: #388bfd33; border-color: #388bfd; color: #58a6ff; }
```

- [ ] **Step 2: Add View pane HTML**

Locate `<div id="terminal-container">` (~line 231) and add the View pane as a sibling inside `#terminal-container` so it overlays the same area:

Replace:
```html
    <div id="terminal-container">
      <div id="conn-dot" title="WebSocket disconnected"></div>
    </div>
```

with:
```html
    <div id="terminal-container">
      <div id="conn-dot" title="WebSocket disconnected"></div>
      <div id="view-pane">
        <div id="view-content"></div>
      </div>
    </div>
```

- [ ] **Step 3: Smoke-verify the page still loads**

Start the server briefly:
```bash
cd /c/Coding/pocket-dev/mobile && PORT=7682 timeout 3 node server.js >/dev/null 2>&1 &
sleep 1
curl -s http://localhost:7682/ | grep -o 'view-pane' | head -1
kill %1 2>/dev/null || true
```

Expected: prints `view-pane`. (If tmux isn't available locally, the spawn errors but the HTTP server may still bind — if `curl` fails, that's OK to skip; CI will catch the regression.)

- [ ] **Step 4: Commit**

```bash
cd /c/Coding/pocket-dev && git add mobile/public/index.html && git commit -m "feat(client): add View pane HTML + CSS scaffolding (no wiring yet)"
```

---

## Task 11: Add toolbar buttons (mode toggle + Copy)

**Files:**
- Modify: `mobile/public/index.html`

- [ ] **Step 1: Add buttons to the normal toolbar row**

In `index.html`, the normal button row is at `~line 237`. Replace the Select button line:

```html
          <button class="action-btn select-btn" onclick="enterSelectMode()" title="Select &amp; copy terminal text">Select</button>
```

with three new buttons (Live, View, Copy):

```html
          <button id="mode-live" class="action-btn mode-btn" onclick="setMode('live')" title="Live terminal">Live</button>
          <button id="mode-view" class="action-btn mode-btn" onclick="setMode('view')" title="Wrapped reading view">View</button>
          <button id="copy-btn"  class="action-btn"          onclick="copyAllOutput()" title="Copy terminal output">📋</button>
```

The Select button is now gone from the toolbar. (Its overlay markup and CSS are deleted later in Task 14.)

- [ ] **Step 2: Smoke-verify HTML structure**

```bash
cd /c/Coding/pocket-dev/mobile && grep -c 'mode-btn' public/index.html
```

Expected: prints `4` (two button definitions + two CSS rule references).

- [ ] **Step 3: Commit**

```bash
cd /c/Coding/pocket-dev && git add mobile/public/index.html && git commit -m "feat(client): add Live/View toggle + Copy buttons to toolbar"
```

---

## Task 12: Wire ES modules into index.html and bind toolbar

This task wires our three new ES modules (`clipboard.js`, `view.js`, `mode.js`) into the existing inline `<script>` block, replacing `copyOnSelect` with an explicit selection-change handler, adding the View update loop, and binding the new toolbar functions.

**Files:**
- Modify: `mobile/public/index.html`

- [ ] **Step 1: Convert the existing inline `<script>` to a module and add imports**

Find:
```html
  <script src="/xterm/lib/xterm.js"></script>
  <script src="/addon-fit/lib/addon-fit.js"></script>
  <script>
```

Replace with:
```html
  <script src="/xterm/lib/xterm.js"></script>
  <script src="/addon-fit/lib/addon-fit.js"></script>
  <script src="/addon-serialize/lib/addon-serialize.js"></script>
  <script src="/ansi-up/ansi_up.js"></script>
  <script type="module">
    import { clipboardWrite } from '/js/clipboard.js';
    import { ViewRenderer }   from '/js/view.js';
    import { detectDefaultMode, applyMode } from '/js/mode.js';
```

- [ ] **Step 2: In the Terminal init (~line 294), remove `copyOnSelect` and bump `scrollback`**

Find:
```js
    const term = new Terminal({
      cursorBlink:   true,
      copyOnSelect:  true,
      scrollback:    5000,
      fontSize:    savedFontSize,
```

Replace with:
```js
    const term = new Terminal({
      cursorBlink:   true,
      scrollback:    10000,
      fontSize:    savedFontSize,
```

- [ ] **Step 3: After `term.loadAddon(fitAddon);` (~line 315) load the serialize addon**

Find:
```js
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal-container'));
    requestAnimationFrame(() => fitAddon.fit());
```

Replace with:
```js
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    const serializeAddon = new SerializeAddon.SerializeAddon();
    term.loadAddon(serializeAddon);

    term.open(document.getElementById('terminal-container'));
    requestAnimationFrame(() => fitAddon.fit());

    // ── View mode wiring ──
    const viewRenderer = new ViewRenderer({
      scrollEl: document.getElementById('view-pane'),
      contentEl: document.getElementById('view-content'),
      ansiUp: new AnsiUp(),
    });

    function refreshViewIfActive() {
      if (document.body.dataset.mode === 'view') {
        viewRenderer.update(serializeAddon.serialize({ excludeAltBuffer: true }));
      }
    }

    let viewRefreshTimer = null;
    function scheduleViewRefresh() {
      if (viewRefreshTimer) return;
      viewRefreshTimer = setTimeout(() => {
        viewRefreshTimer = null;
        refreshViewIfActive();
      }, 100);
    }

    // ── Mode toggle ──
    const modeRefs = {
      body: document.body,
      livePane: document.getElementById('terminal-container').querySelector('.xterm') || document.getElementById('terminal-container'),
      viewPane: document.getElementById('view-pane'),
      liveBtn: document.getElementById('mode-live'),
      viewBtn: document.getElementById('mode-view'),
    };

    window.setMode = function(mode) {
      applyMode(mode, modeRefs);
      if (mode === 'view') refreshViewIfActive();
      else fitAddon.fit();
    };

    // After xterm.js renders, livePane is the .xterm container — re-grab it.
    requestAnimationFrame(() => {
      modeRefs.livePane = document.querySelector('#terminal-container .xterm') || document.getElementById('terminal-container');
      window.setMode(detectDefaultMode());
    });

    // ── Copy actions ──
    term.onSelectionChange(() => {
      // Auto-copy on selection (replaces copyOnSelect: true, which silently fails on HTTP).
      if (term.hasSelection()) clipboardWrite(term.getSelection());
    });

    window.copyAllOutput = async function() {
      const text = serializeAddon.serialize({ excludeAltBuffer: true })
        .replace(/\x1b\[[0-9;]*m/g, ''); // strip ANSI for plain-text copy
      const ok = await clipboardWrite(text);
      flashCopyButton(ok);
    };

    function flashCopyButton(ok) {
      const btn = document.getElementById('copy-btn');
      const orig = btn.textContent;
      btn.textContent = ok ? '✓' : '✗';
      setTimeout(() => { btn.textContent = orig; }, 800);
    }

    // Ctrl+Shift+C copies current xterm.js selection (without intercepting Ctrl+C / SIGINT)
    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c' && term.hasSelection()) {
        e.preventDefault();
        clipboardWrite(term.getSelection());
      }
    });
```

- [ ] **Step 4: Hook the WebSocket onmessage to schedule view refreshes**

Find:
```js
      ws.onmessage = e => {
        term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
        // Pulse scroll button if user is scrolled up
        const buf = term.buffer.active;
        if (buf.viewportY < buf.baseY) {
          scrollBtn.classList.add('has-new-output');
        }
      };
```

Replace with:
```js
      ws.onmessage = e => {
        term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
        scheduleViewRefresh();
        const buf = term.buffer.active;
        if (buf.viewportY < buf.baseY) {
          scrollBtn.classList.add('has-new-output');
        }
      };
```

- [ ] **Step 5: Smoke-verify the page still loads via Vitest's static-route check**

```bash
cd /c/Coding/pocket-dev/mobile && npm test -- endpoints
```

Expected: PASS. (No new test, just verifying we didn't break static serving.)

- [ ] **Step 6: Commit**

```bash
cd /c/Coding/pocket-dev && git add mobile/public/index.html && git commit -m "feat(client): wire View renderer + mode toggle + clipboard handlers"
```

---

## Task 13: Delete Select mode overlay

Removes the now-unused Select overlay (HTML, CSS, JS handlers, escape-key listener).

**Files:**
- Modify: `mobile/public/index.html`

- [ ] **Step 1: Delete the Select overlay HTML block**

In `index.html`, locate the entire `<!-- Select Mode Overlay -->` block (originally `~line 272-284`):

```html
  <!-- Select Mode Overlay -->
  <div id="select-overlay">
    <div id="select-topbar">
      <span id="select-hint">Swipe to select · use system copy or tap Copy All</span>
      <div id="select-actions">
        <button class="sel-btn" onclick="copyAll()">Copy All</button>
        <button class="sel-btn exit-btn" onclick="exitSelectMode()">✕ Live</button>
      </div>
    </div>
    <div id="select-scroll">
      <pre id="select-content"></pre>
    </div>
  </div>
```

Delete the entire block.

- [ ] **Step 2: Delete the Select overlay CSS rules**

Locate the block `/* ── Select Mode Overlay ─────... */` in the `<style>` block (originally `~line 155-213`). Delete the entire section through `.sel-btn.exit-btn { ... }` and through `#select-scroll { ... }` and `#select-content { ... }`.

Also delete `.action-btn.select-btn` rules (~line 114-115):
```css
    .action-btn.select-btn    { background: #1f2d1f; border-color: #3fb950; color: #3fb950; }
    .action-btn.select-btn:active { background: #3fb95022; }
```

- [ ] **Step 3: Delete Select-mode JS functions**

Find and delete the entire `// ── Select Mode ──` section (originally `~line 591-650`):

```js
    // ── Select Mode ─────────────────────────────────────────────────────────
    // Fetches full scrollback from tmux ...
    async function enterSelectMode() { ... }
    function exitSelectMode() { ... }
    function copyAll() { ... }
    function writeToClipboard(text, successMsg) { ... }
    function execCopy(text) { ... }
```

(`execCopy` moved into `clipboard.js`. `writeToClipboard` is replaced by `clipboardWrite`. `copyAll` is replaced by `copyAllOutput` from Task 12.)

- [ ] **Step 4: Delete the Escape-key Select handler**

Find and delete (originally `~line 652-655`):

```js
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && document.getElementById('select-overlay').classList.contains('active'))
        exitSelectMode();
    });
```

- [ ] **Step 5: Verify no broken references remain**

```bash
cd /c/Coding/pocket-dev/mobile && grep -n 'select-overlay\|select-content\|enterSelectMode\|exitSelectMode\|writeToClipboard\|copyAll(' public/index.html
```

Expected: no output (nothing matches).

```bash
cd /c/Coding/pocket-dev/mobile && grep -n 'select-btn' public/index.html
```

Expected: no output.

- [ ] **Step 6: Run all unit + server tests**

```bash
cd /c/Coding/pocket-dev/mobile && npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
cd /c/Coding/pocket-dev && git add mobile/public/index.html && git commit -m "refactor(client): delete Select mode overlay (replaced by View mode)"
```

---

## Task 14: E2E fixture — server harness

Set up a Playwright fixture that boots a fresh `mobile/server.js` on a random port with a deterministic `LOOP_CMD` (`cat`) so tests have predictable output. This is shared infrastructure for Tasks 15–17.

**Files:**
- Create: `mobile/test/e2e/fixtures.js`

- [ ] **Step 1: Create the fixture**

```js
import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';

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

export const test = base.extend({
  pdServer: async ({}, use) => {
    const port = await pickPort();
    const proc = spawn('node', [path.resolve(__dirname, '../../server.js')], {
      env: {
        ...process.env,
        PORT: String(port),
        // Deterministic stand-in for Claude — `cat` echoes our typed input back into the buffer.
        SHELL_CMD: 'cat',
        TMUX_SESSION: `pdtest-${port}`,
      },
      stdio: 'pipe',
    });

    // Wait for server to log its listen line
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server did not start within 5s')), 5000);
      proc.stdout.on('data', chunk => {
        if (chunk.toString().includes('pocket-dev on')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      proc.on('exit', code => reject(new Error(`Server exited early with code ${code}`)));
    });

    await use({ port, baseURL: `http://localhost:${port}` });

    proc.kill('SIGTERM');
    await new Promise(resolve => proc.on('exit', resolve));
  },
});

export { expect };
```

- [ ] **Step 2: Smoke-test the fixture with a trivial spec**

Create `mobile/test/e2e/fixture-smoke.spec.js`:

```js
import { test, expect } from './fixtures.js';

test('fixture starts a server on a random port', async ({ pdServer, page }) => {
  await page.goto(pdServer.baseURL);
  await expect(page).toHaveTitle('pocket-dev');
});
```

- [ ] **Step 3: Run only the chromium project for speed**

```bash
cd /c/Coding/pocket-dev/mobile && npx playwright test --project=chromium fixture-smoke
```

Expected: 1 PASS.

(If this fails because `tmux` is not installed locally, install it: on Windows in WSL, `apt install tmux`; on Linux dev hosts, same. CI installs tmux as part of the workflow.)

- [ ] **Step 4: Commit**

```bash
cd /c/Coding/pocket-dev && git add mobile/test/e2e/fixtures.js mobile/test/e2e/fixture-smoke.spec.js && git commit -m "test(e2e): add server fixture and smoke spec"
```

---

## Task 15: E2E smoke test

Page load, WebSocket connection, mode toggle, View live updates, line wrap on a 360px viewport.

**Files:**
- Create: `mobile/test/e2e/smoke.spec.js`

- [ ] **Step 1: Write the test**

```js
import { test, expect } from './fixtures.js';

test('toolbar shows Live / View / Copy buttons', async ({ pdServer, page }) => {
  await page.goto(pdServer.baseURL);
  await expect(page.locator('#mode-live')).toBeVisible();
  await expect(page.locator('#mode-view')).toBeVisible();
  await expect(page.locator('#copy-btn')).toBeVisible();
});

test('typed input echoes back into terminal (WebSocket round-trip)', async ({ pdServer, page }) => {
  await page.goto(pdServer.baseURL);
  // Wait for WebSocket connection
  await page.waitForFunction(() => document.getElementById('conn-dot').classList.contains('connected'), null, { timeout: 5000 });

  // Send "hello\n" via the input bar
  await page.fill('#cmd-input', 'hello');
  await page.click('#send-btn');

  // The xterm.js DOM should eventually contain "hello"
  await expect.poll(async () => {
    return await page.evaluate(() => document.querySelector('#terminal-container').innerText);
  }, { timeout: 5000 }).toContain('hello');
});

test('toggling to View shows current buffer content', async ({ pdServer, page }) => {
  await page.goto(pdServer.baseURL);
  await page.waitForFunction(() => document.getElementById('conn-dot').classList.contains('connected'));

  await page.fill('#cmd-input', 'unique-marker-string');
  await page.click('#send-btn');
  await page.waitForTimeout(500);

  await page.click('#mode-view');
  await expect(page.locator('#view-content')).toContainText('unique-marker-string', { timeout: 3000 });
});

test('View pane wraps long lines on a 360px viewport', async ({ pdServer, browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 700 } });
  const page = await ctx.newPage();
  await page.goto(pdServer.baseURL);
  await page.waitForFunction(() => document.getElementById('conn-dot').classList.contains('connected'));

  const longLine = 'x'.repeat(200);
  await page.fill('#cmd-input', longLine);
  await page.click('#send-btn');
  await page.waitForTimeout(500);
  await page.click('#mode-view');
  await page.waitForTimeout(500);

  // No horizontal scrollbar on the view pane
  const overflow = await page.evaluate(() => {
    const el = document.getElementById('view-pane');
    return el.scrollWidth > el.clientWidth;
  });
  expect(overflow).toBe(false);

  await ctx.close();
});
```

- [ ] **Step 2: Run on chromium**

```bash
cd /c/Coding/pocket-dev/mobile && npx playwright test --project=chromium smoke
```

Expected: 4 PASS. If any fail, check the trace artifact in `test-results/`.

- [ ] **Step 3: Commit**

```bash
cd /c/Coding/pocket-dev && git add mobile/test/e2e/smoke.spec.js && git commit -m "test(e2e): smoke — toolbar, WS round-trip, mode toggle, line wrap"
```

---

## Task 16: E2E copy test

Clipboard write paths: button, drag-select auto-copy, HTTP fallback via mocked `navigator.clipboard`.

**Files:**
- Create: `mobile/test/e2e/copy.spec.js`

- [ ] **Step 1: Write the test**

```js
import { test, expect } from './fixtures.js';

test.use({
  permissions: ['clipboard-read', 'clipboard-write'],
});

test('Copy button writes terminal output to clipboard with no trailing whitespace', async ({ pdServer, page }) => {
  await page.goto(pdServer.baseURL);
  await page.waitForFunction(() => document.getElementById('conn-dot').classList.contains('connected'));

  await page.fill('#cmd-input', 'clipboard-test-marker');
  await page.click('#send-btn');
  await page.waitForTimeout(500);

  await page.click('#copy-btn');
  await page.waitForTimeout(200);

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('clipboard-test-marker');
  // No line should have trailing whitespace
  for (const line of clip.split('\n')) {
    expect(line).not.toMatch(/[ \t]+$/);
  }
});

test('drag-selecting in xterm.js auto-copies via onSelectionChange', async ({ pdServer, page }) => {
  await page.goto(pdServer.baseURL);
  await page.waitForFunction(() => document.getElementById('conn-dot').classList.contains('connected'));
  await page.fill('#cmd-input', 'drag-select-marker');
  await page.click('#send-btn');
  await page.waitForTimeout(500);

  // Programmatically select via xterm.js API
  await page.evaluate(() => window.term && window.term.selectAll());
  // term isn't on window today — expose it for tests
  const sel = await page.evaluate(() => {
    // Fallback: use the addon-serialize'd content as a proxy for "selected"
    return document.querySelector('#terminal-container').innerText;
  });
  expect(sel).toContain('drag-select-marker');
});

test('HTTP fallback path: when navigator.clipboard rejects, execCommand runs', async ({ pdServer, page }) => {
  await page.goto(pdServer.baseURL);
  await page.waitForFunction(() => document.getElementById('conn-dot').classList.contains('connected'));

  // Patch navigator.clipboard to always reject so the fallback path runs
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('simulated http')) },
      configurable: true,
    });
    window.__execCommandCalls = [];
    const orig = document.execCommand.bind(document);
    document.execCommand = (cmd) => {
      window.__execCommandCalls.push(cmd);
      return orig(cmd);
    };
  });

  await page.fill('#cmd-input', 'fallback-marker');
  await page.click('#send-btn');
  await page.waitForTimeout(500);
  await page.click('#copy-btn');
  await page.waitForTimeout(200);

  const calls = await page.evaluate(() => window.__execCommandCalls);
  expect(calls).toContain('copy');
});
```

Note: the second test currently uses an `innerText` proxy because we don't expose `window.term`. To make the auto-copy assertion airtight, expose `term` on `window` for tests:

- [ ] **Step 2: Expose `term` on `window` for tests**

In `mobile/public/index.html`, just after `term.open(...)` (~line 316), add:

```js
    if (window.location.search.includes('test=1')) window.term = term;
```

Then update the test to navigate with `?test=1`:

```js
  await page.goto(pdServer.baseURL + '/?test=1');
```

Apply this in both `smoke.spec.js` and `copy.spec.js` for consistency.

Update the second test in `copy.spec.js` to use the API:

```js
test('drag-selecting in xterm.js auto-copies via onSelectionChange', async ({ pdServer, page }) => {
  await page.goto(pdServer.baseURL + '/?test=1');
  await page.waitForFunction(() => document.getElementById('conn-dot').classList.contains('connected'));
  await page.fill('#cmd-input', 'drag-select-marker');
  await page.click('#send-btn');
  await page.waitForTimeout(500);

  await page.evaluate(() => window.term.selectAll());
  await page.waitForTimeout(100);

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('drag-select-marker');
});
```

- [ ] **Step 3: Run on chromium**

```bash
cd /c/Coding/pocket-dev/mobile && npx playwright test --project=chromium copy
```

Expected: 3 PASS.

- [ ] **Step 4: Commit**

```bash
cd /c/Coding/pocket-dev && git add mobile/public/index.html mobile/test/e2e/copy.spec.js mobile/test/e2e/smoke.spec.js && git commit -m "test(e2e): clipboard paths — button, auto-copy on selection, HTTP fallback"
```

---

## Task 17: Firefox-mobile spec (Pixel 5 emulation)

**Files:**
- Create: `mobile/test/e2e/firefox-mobile.spec.js`

- [ ] **Step 1: Write the test**

```js
import { test, expect } from './fixtures.js';

test.describe('Firefox + Pixel 5 emulation', () => {
  test.skip(({ browserName }) => browserName !== 'firefox', 'firefox-only');

  test('default mode is View on a coarse-pointer device', async ({ pdServer, page }) => {
    await page.goto(pdServer.baseURL + '/?test=1');
    await page.waitForFunction(() => document.body.dataset.mode);
    expect(await page.evaluate(() => document.body.dataset.mode)).toBe('view');
  });

  test('View pane is selectable text (long-press emulation)', async ({ pdServer, page }) => {
    await page.goto(pdServer.baseURL + '/?test=1');
    await page.waitForFunction(() => document.getElementById('conn-dot').classList.contains('connected'));

    await page.fill('#cmd-input', 'mobile-select-marker');
    await page.click('#send-btn');
    await page.waitForTimeout(500);

    // Build a Range spanning #view-content, then turn it into a Selection.
    const selectedText = await page.evaluate(() => {
      const node = document.getElementById('view-content');
      const range = document.createRange();
      range.selectNodeContents(node);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return sel.toString();
    });

    expect(selectedText).toContain('mobile-select-marker');
  });
});
```

- [ ] **Step 2: Run on Pixel 5 + Firefox**

```bash
cd /c/Coding/pocket-dev/mobile && npx playwright test --project=pixel5-firefox firefox-mobile
```

Expected: 2 PASS.

- [ ] **Step 3: Commit**

```bash
cd /c/Coding/pocket-dev && git add mobile/test/e2e/firefox-mobile.spec.js && git commit -m "test(e2e): firefox + pixel 5 — default View mode, native text selection"
```

---

## Task 18: Manual verification checklist

**Files:**
- Create: `mobile/MANUAL-VERIFICATION.md`

- [ ] **Step 1: Create the checklist**

```markdown
# pocket-dev — Manual Verification

Run before tagging a release. Items here can't be reliably automated.

## Real device — Pixel + Firefox
- [ ] Open pocket-dev over the LAN (HTTP, not localhost). Default mode is View.
- [ ] Long-press a word in View → drag selection handles → tap system Copy.
- [ ] Paste somewhere else: text matches what was selected, no trailing whitespace.
- [ ] Scroll View pane: smooth, native momentum scrolling. No horizontal scrollbar.
- [ ] Tap Live → terminal renders. Tap View → wrapped reading view returns.
- [ ] Type via the existing HTML input bar: keystrokes reach the inner Claude session in both modes.

## Desktop — HTTP (not localhost)
- [ ] Highlight text in Live xterm.js with mouse → release → paste in another window: copies.
- [ ] Ctrl+Shift+C copies the current selection if one exists; pass-through to terminal otherwise.
- [ ] Click 📋 toolbar button → entire scrollback copied with no trailing whitespace per line.

## Alt-screen behavior
- [ ] Run a real Claude Code session for 5+ minutes including long responses, tool calls, and exits.
- [ ] Scroll back through the session: no duplicated chunks of history.
- [ ] When Claude exits and restarts (the LOOP_CMD), the prior output stays in scrollback (alternate-screen off behavior).

## Focus events
- [ ] Switch browser tab away from pocket-dev for 30 seconds, then back.
- [ ] Claude Code's UI redraws cleanly (no stuck cursor, no stale spinner).
```

- [ ] **Step 2: Commit**

```bash
cd /c/Coding/pocket-dev && git add mobile/MANUAL-VERIFICATION.md && git commit -m "docs: add manual verification checklist"
```

---

## Task 19: Final integration check

A whole-suite run + a Docker build smoke check to make sure the runtime image still builds with the new files.

**Files:** none modified.

- [ ] **Step 1: Run the full test suite**

```bash
cd /c/Coding/pocket-dev/mobile && npm run test:all
```

Expected: all unit, server, and E2E tests pass on all three Playwright projects (chromium, firefox, pixel5-firefox).

- [ ] **Step 2: Verify Docker build picks up new files**

```bash
cd /c/Coding/pocket-dev && docker build -t pocket-dev:plan-test . 2>&1 | tail -20
```

Expected: build succeeds. The existing `COPY mobile/ /mobile/` line picks up `tmux.conf`, the `js/` directory, and `node_modules/` (after `npm install --production` in the Dockerfile).

- [ ] **Step 3: Confirm tmux.conf is in the image**

```bash
docker run --rm pocket-dev:plan-test cat /mobile/tmux.conf
```

Expected: prints the contents of the conf file (alternate-screen off + focus-events on).

- [ ] **Step 4: Confirm devDependencies aren't shipped**

```bash
docker run --rm pocket-dev:plan-test test -d /mobile/node_modules/vitest && echo BAD || echo OK
```

Expected: `OK` — vitest is a devDependency, `npm install --production` excludes it.

- [ ] **Step 5: Cleanup**

```bash
docker image rm pocket-dev:plan-test || true
```

- [ ] **Step 6: Final commit (only if anything changed)**

If steps 1–5 surfaced a bug, fix it and commit. Otherwise no commit needed for Task 19.

---

## Self-Review

**Spec coverage:**

| Spec section | Implementing task |
|---|---|
| Trailing whitespace fix (#1) | Task 6 (clipboardWrite trims), Task 12 (Live `onSelectionChange` uses it), Task 16 (E2E asserts no trailing whitespace) |
| Mobile width fix (#2) | Task 8 (View renderer with `pre-wrap`), Task 10 (CSS), Task 15 (360px wrap E2E test) |
| Scrollback duplication (#3) | Task 3 (tmux.conf), Task 4 (server passes `-f`), Task 18 (manual check) |
| Top-level copy (#4) | Task 11 (Copy button), Task 12 (`copyAllOutput`, Ctrl+Shift+C), Task 16 (E2E) |
| Two co-mounted surfaces | Task 9 (`applyMode`), Task 12 (mode wiring keeps Live mounted via `visibility: hidden`) |
| Default mode by device | Task 9 (`detectDefaultMode` matchMedia), Task 12 (applies on load), Task 17 (Pixel 5 verifies View default) |
| Replace `copyOnSelect` | Task 12 (`onSelectionChange` listener) |
| Ctrl+Shift+C | Task 12 (keydown handler) |
| Delete `/history` | Task 4 (refactor removes), Task 5 (test asserts 404) |
| Delete Select overlay | Task 13 |
| Bump scrollback to 10000 | Task 12 |
| `setw -g alternate-screen off` | Task 3 (file content), Task 4 (loaded via `-f`) |
| `set -g focus-events on` | Task 3 (file content), Task 4 (loaded via `-f`) |
| `tmux.conf` via `-f` | Task 4 (`buildTmuxSpawnArgs`) |
| Trailing-whitespace strip in clipboardWrite | Task 6 |
| Vitest unit tests | Tasks 6, 8, 9 |
| Vitest server tests | Tasks 3, 4, 5, 7 |
| Playwright E2E (Firefox + Chromium + Pixel 5) | Tasks 14, 15, 16, 17 |
| Manual verification doc | Task 18 |
| CI workflow | Task 2 |

**Placeholder scan:** No "TBD" / "TODO" / "implement later" / "Add appropriate error handling" / "Similar to Task N" patterns. Every task has runnable commands and complete code.

**Type consistency:**
- `clipboardWrite(text, { execCopy })` is the same signature in `clipboard.js`, `clipboard.test.js`, and the `index.html` callsites.
- `ViewRenderer({ scrollEl, contentEl, ansiUp })` is the same constructor everywhere.
- `applyMode(mode, { body, livePane, viewPane, liveBtn, viewBtn })` is consistent.
- `buildTmuxSpawnArgs(session, loopCmd)` is the same signature in `server.js` and `serverArgs.test.js`.
- `createApp()` returns an Express app in both `server.js` and `endpoints.test.js`.

**Caveat for the implementing engineer:** the addon-serialize package may expose its global as `SerializeAddon.SerializeAddon` (mirroring the addon-fit pattern `FitAddon.FitAddon`). If the script tag instead exposes a flat `SerializeAddon` constructor, adjust the call site in Task 12 Step 3 — the test in Task 15 will catch the breakage if the wrong shape is used.
