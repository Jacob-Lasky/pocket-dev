// Visual artifact for the archived-elsewhere close. Not a behavioural guard
// (archive-close.spec.js is), just proof-of-render: three tabs with real
// conversation titles, one of them archived from "another device", and the
// session list shot before and after so the tab actually leaving can be
// eyeballed rather than inferred from a passing assertion.
//
// On demand only, chromium only, for the same reason restore-artifact.spec.js
// is: screenshot generation does not belong on the critical path, and the
// behavioural assertions it would duplicate already run on all three engines.
//   PD_ARTIFACTS=1 npx playwright test archive-close-artifact --project=chromium
// It writes into test-artifacts/.

import path from 'node:path';
import { test, expect, gotoTest, waitForConnection, waitForPanes, openSessionList, newSession } from './fixtures.js';
import { archivedNotice as archived } from '../fixtures/rc-notices.js';

const OUT = path.resolve(__dirname, '../../test-artifacts');

const finishedTurn = { type: 'assistant', uuid: 'f1111111-1111-4111-8111-111111111111', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'all yours' }] } };
const convo = (t, p) => [{ type: 'ai-title', aiTitle: t }, { type: 'last-prompt', lastPrompt: p }, finishedTurn];

test.skip(
  ({ browserName }) => browserName !== 'chromium' || !process.env.PD_ARTIFACTS,
  'artifact run is chromium-only and on demand (set PD_ARTIFACTS=1)',
);

test('artifact: an archived tab leaves the session list on its own', async ({ pdServerClaudeStub, page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);
  await newSession(page);
  await waitForConnection(page);
  await newSession(page);
  await waitForConnection(page);
  await waitForPanes(page, 3);

  const ids = [1, 2, 3].map(n => `${pdServerClaudeStub.sessionName}-${n}`);
  const uuids = [];
  for (const id of ids) uuids.push(await pdServerClaudeStub.uuidFor(id));

  await pdServerClaudeStub.writeTranscript(uuids[0], convo('Bola number transcription', 'stream the files with interim results'));
  await pdServerClaudeStub.writeTranscript(uuids[1], convo('Archived from the desktop app', 'this one is finished with'));
  await pdServerClaudeStub.writeTranscript(uuids[2], convo('Arise phone demo', 'is it green?'));

  await openSessionList(page);
  await expect.poll(async () => (await page.locator('.sl-row').count())).toBe(3);
  await page.screenshot({ path: path.join(OUT, 'archive-close-1-before.png'), fullPage: false });

  // The middle conversation is archived from another device.
  await pdServerClaudeStub.writeTranscript(uuids[1], [
    ...convo('Archived from the desktop app', 'this one is finished with'),
    archived('aaaa1111-1111-4111-8111-111111111111'),
  ]);

  // The list polls itself while it is open, so this needs no extra nudge.
  await expect.poll(async () => (await page.locator('.sl-row').count()), { timeout: 15000 }).toBe(2);
  await page.screenshot({ path: path.join(OUT, 'archive-close-2-after.png'), fullPage: false });

  await page.keyboard.press('Escape');
  await waitForPanes(page, 2);
  await page.screenshot({ path: path.join(OUT, 'archive-close-3-tabs.png'), fullPage: false });
});
