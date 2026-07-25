// Visual artifact for the restore path. Not a behavioural guard (restore.spec.js
// is), just proof-of-render: three tabs, a restart with tmux killed underneath,
// and screenshots of the same page before and after so the recovery can be
// eyeballed rather than inferred from a passing assertion.
//
// Skipped by default — it exists to be run on demand with
//   npx playwright test restore-artifact --project=chromium
// and writes into test-artifacts/.

import path from 'node:path';
import { test, expect, gotoTest, waitForConnection, sendAndWaitForEcho } from './fixtures.js';

const OUT = path.resolve(__dirname, '../../test-artifacts');

test.skip(({ browserName }) => browserName !== 'chromium', 'artifact run is chromium-only');

test('artifact: tabs and terminal survive a container restart', async ({ pdServer, page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await sendAndWaitForEcho(page, 'BEFORE-RESTART: this session was alive');

  await page.click('#sessions-btn');
  await page.click('#sl-bar >> text=+ New');
  await waitForConnection(page);
  await sendAndWaitForEcho(page, 'SECOND TAB: also alive');
  await expect.poll(async () => (await page.evaluate(async () => (await (await fetch('/sessions')).json()).length))).toBe(2);

  await page.screenshot({ path: path.join(OUT, 'restore-1-before.png'), fullPage: false });

  // Container goes down: server process dies and tmux dies with it.
  await pdServer.restart({ killTmux: true });

  // No reload. The page reconnects itself.
  await expect
    .poll(async () => (await page.evaluate(async () => (await (await fetch('/sessions')).json()).length)), { timeout: 20000 })
    .toBe(2);
  await waitForConnection(page);
  await sendAndWaitForEcho(page, 'AFTER-RESTART: same tab, still typing');

  await page.screenshot({ path: path.join(OUT, 'restore-2-after.png'), fullPage: false });

  // Prove the UI still reports both sessions rather than a single fresh one.
  await page.click('#sessions-btn');
  await expect(page.locator('.sl-row')).toHaveCount(2);
  await page.screenshot({ path: path.join(OUT, 'restore-3-tabs.png'), fullPage: false });
});
