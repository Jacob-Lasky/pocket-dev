// Visual artifact for the restore path. Not a behavioural guard (restore.spec.js
// is), just proof-of-render: three tabs, a restart with tmux killed underneath,
// and screenshots of the same page before and after so the recovery can be
// eyeballed rather than inferred from a passing assertion.
//
// On demand only, which is what the gate below actually enforces now:
//   PD_ARTIFACTS=1 npx playwright test restore-artifact --project=chromium
// It writes into test-artifacts/.
//
// It used to say "skipped by default" while only skipping non-chromium, so it
// ran in every CI job. That cost a red run on 2026-07-25: the second tab's
// pane came back empty from sendAndWaitForEcho and blocked the merge queue.
// Nothing was lost by gating it, because it guards nothing — restore.spec.js's
// "a container restart brings every session back under its original id" makes
// the same two-tabs-survive-a-restart assertion, behaviourally, and runs on all
// three engines. Screenshot generation does not belong on the critical path.

import path from 'node:path';
import { test, expect, gotoTest, waitForConnection, sendAndWaitForEcho, newSession } from './fixtures.js';

const OUT = path.resolve(__dirname, '../../test-artifacts');

test.skip(
  ({ browserName }) => browserName !== 'chromium' || !process.env.PD_ARTIFACTS,
  'artifact run is chromium-only and on demand (set PD_ARTIFACTS=1)',
);

test('artifact: tabs and terminal survive a container restart', async ({ pdServer, page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await sendAndWaitForEcho(page, 'BEFORE-RESTART: this session was alive');

  await newSession(page);
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
