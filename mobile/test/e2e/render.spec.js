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

  // Filter expected noise in static mode:
  //   - WebSocket / ws:// — there is no ws server attached.
  //   - 404 on /sessions — createApp() is booted without sessionsApi, so the
  //     bootstrap GET/POST against /sessions return 404 by design. The client
  //     swallows the rejection via console.warn (not console.error), but
  //     browsers ALSO emit a network-layer "Failed to load resource" error
  //     for any non-2xx response that we can't suppress from the client.
  const realConsoleErrors = consoleErrors.filter(e =>
    !/WebSocket|ws:\/\//i.test(e)
    && !/Failed to load resource.*404/i.test(e),
  );
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

// Regression for "View mode wraps =====-style separators horribly on Safari".
//
// The existing PTY-driven wrap test in smoke.spec.js sends 200 'x's through
// the cat-echo path. The View renderer rejoins soft-wrapped buffer rows into
// one logical line, so the markup it produces leans on CSS to reflow — and the
// assertion there strips whitespace anyway. To pin the pure CSS invariant
// deterministically (no PTY, no buffer state), this test injects an unbroken
// run straight into #view-content.
//
// At the CSS layer, `word-break: break-word` is interpreted differently
// across engines: Chromium and modern Firefox treat it as equivalent to
// `overflow-wrap: anywhere`, but WebKit/Safari only breaks at natural
// opportunities — so an unbroken run overflows horizontally. The fix is
// `overflow-wrap: anywhere`, the spec-stable form. This test asserts the
// invariant on every browser in the matrix.
test('View pane wraps an unbroken character run at 360px viewport', async ({ pdStaticServer, browser, browserName }) => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 700 } });
  const page = await ctx.newPage();
  await gotoTest(page, pdStaticServer);

  await page.click('#mode-view');
  await expect.poll(() => page.evaluate(() => document.body.dataset.mode)).toBe('view');

  // Inject an unbroken 300-char run of '=' directly into the view content.
  // At 360px viewport with the 13px monospace font, that's ~4x the visible
  // width — needs to break at character boundaries to fit without overflow.
  await page.evaluate(() => {
    document.getElementById('view-content').textContent = '='.repeat(300);
  });

  await page.screenshot({
    path: path.join(ARTIFACTS_DIR, `view-wrap-${browserName}.png`),
    fullPage: true,
  });

  const horizontal = await page.evaluate(() => {
    const el = document.getElementById('view-pane');
    return { scroll: el.scrollWidth, client: el.clientWidth };
  });
  expect(
    horizontal.scroll,
    `${browserName}: #view-pane scrollWidth=${horizontal.scroll} should not exceed clientWidth=${horizontal.client}`,
  ).toBeLessThanOrEqual(horizontal.client);

  await ctx.close();
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
