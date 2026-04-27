// No-PTY render spec: boots only the express static layer (via createApp) so we
// can verify index.html parses and renders without depending on tmux. Catches
// JS-level regressions (broken imports, syntax errors, missing globals) that
// the PTY-dependent specs would surface only when tmux is available.
//
// The page's WebSocket connection will fail (no ws server) — that's expected
// and we deliberately tolerate it. We assert the static UI renders correctly
// regardless.

import { test, expect, gotoTest } from './fixtures.js';
import path from 'node:path';
import fs from 'node:fs';

const ARTIFACTS_DIR = path.resolve(__dirname, '../../test-artifacts');

test.beforeAll(() => {
  if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
});

test('index.html loads without JS errors and renders the toolbar', async ({ pdStaticServer, page }) => {
  const consoleErrors = [];
  const pageErrors = [];

  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => pageErrors.push(err.message));

  await gotoTest(page, pdStaticServer);
  await expect(page).toHaveTitle('pocket-dev');

  // Toolbar elements all rendered
  await expect(page.locator('#mode-live')).toBeVisible();
  await expect(page.locator('#mode-view')).toBeVisible();
  await expect(page.locator('#copy-btn')).toBeVisible();
  await expect(page.locator('#cmd-input')).toBeVisible();
  await expect(page.locator('#send-btn')).toBeVisible();

  // Module wired correctly: window.term is exposed under ?test=1 (proves the
  // <script type="module"> block executed without throwing).
  await expect.poll(() => page.evaluate(() => typeof window.term)).toBe('object');

  // setMode landed on window (proves applyMode + initial mode-detect ran).
  await expect.poll(() => page.evaluate(() => typeof window.setMode)).toBe('function');

  // Default mode applied. On a desktop emulation profile this is 'live';
  // we accept either to keep the spec portable across projects.
  const mode = await page.evaluate(() => document.body.dataset.mode);
  expect(['live', 'view']).toContain(mode);

  // Filter expected WebSocket failure noise (no ws server in static mode).
  const realConsoleErrors = consoleErrors.filter(e => !/WebSocket|ws:\/\//i.test(e));
  expect(realConsoleErrors, `Unexpected console errors: ${realConsoleErrors.join(' | ')}`).toEqual([]);
  expect(pageErrors,       `Unhandled page errors: ${pageErrors.join(' | ')}`).toEqual([]);

  // Visual artifact — pinned filename so reviewers know where to look.
  await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'render-default.png'), fullPage: true });
});

test('toggling to View renders the view pane (empty buffer is OK)', async ({ pdStaticServer, page }) => {
  await gotoTest(page, pdStaticServer);
  await expect(page.locator('#mode-view')).toBeVisible();

  await page.click('#mode-view');
  await expect.poll(() => page.evaluate(() => document.body.dataset.mode)).toBe('view');
  await expect(page.locator('#view-pane')).toBeVisible();

  await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'render-view-mode.png'), fullPage: true });
});

test('every onclick handler resolves to a real function on window', async ({ pdStaticServer, page }) => {
  await gotoTest(page, pdStaticServer);

  const result = await page.evaluate(() => {
    const onclickAttrs = Array.from(document.querySelectorAll('[onclick]'))
      .map(el => el.getAttribute('onclick'));
    const names = new Set();
    for (const attr of onclickAttrs) {
      const m = attr.match(/^\s*([A-Za-z_$][\w$]*)\s*\(/);
      if (m) names.add(m[1]);
    }
    const missing = [];
    for (const n of names) {
      if (typeof window[n] !== 'function') missing.push(n);
    }
    return { count: names.size, missing };
  });

  expect(result.count).toBeGreaterThan(0);
  expect(result.missing, `onclick handlers not on window: ${result.missing.join(', ')}`).toEqual([]);
});
