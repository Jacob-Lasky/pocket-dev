// Visual artifact for session list groups. Not a behavioural guard
// (session-groups.spec.js is), just proof-of-render: five tabs with real
// conversation titles arranged into groups, shot at desktop and phone width,
// plus one frame taken mid-drag so the lifted row can be looked at.
//
// On demand only, chromium only, same as the other *-artifact specs:
//   PD_ARTIFACTS=1 npx playwright test session-groups-artifact --project=chromium
// It writes into test-artifacts/.

import path from 'node:path';
import { test, expect, gotoTest, waitForConnection, waitForPanes, openSessionList, newSession } from './fixtures.js';

const OUT = path.resolve(__dirname, '../../test-artifacts');

const done = { type: 'assistant', uuid: 'f1111111-1111-4111-8111-111111111111', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } };
const busy = { type: 'assistant', uuid: 'b1111111-1111-4111-8111-111111111111', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } };
const convo = (t, p, last = done) => [{ type: 'ai-title', aiTitle: t }, { type: 'last-prompt', lastPrompt: p }, last];

test.skip(
  ({ browserName }) => browserName !== 'chromium' || !process.env.PD_ARTIFACTS,
  'artifact run is chromium-only and on demand (set PD_ARTIFACTS=1)',
);

test('artifact: grouped session list, desktop and phone', async ({ pdServerClaudeStub, page }) => {
  await page.setViewportSize({ width: 900, height: 760 });
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);
  for (let i = 0; i < 4; i++) { await newSession(page); await waitForConnection(page); }
  await waitForPanes(page, 5);

  const ids = [1, 2, 3, 4, 5].map((n) => `${pdServerClaudeStub.sessionName}-${n}`);
  const uuids = [];
  for (const id of ids) uuids.push(await pdServerClaudeStub.uuidFor(id));
  await pdServerClaudeStub.writeTranscript(uuids[0], convo('Slack scout dedupe fix', 'run the probe against staging', busy));
  await pdServerClaudeStub.writeTranscript(uuids[1], convo('Jellyfin transcode outage', 'check the GPU passthrough'));
  await pdServerClaudeStub.writeTranscript(uuids[2], convo('DeepHive OAuth refresh', 'ship it after review'));
  await pdServerClaudeStub.writeTranscript(uuids[3], convo('Session list groups', 'redesign the sessions page'));
  await pdServerClaudeStub.writeTranscript(uuids[4], convo('DeepHive campaign runtime', 'what does EKS say?'));

  await page.evaluate(async (ids) => {
    await fetch('/layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groups: [
          { id: 'g-deephive', name: 'deephive', sessions: [ids[0], ids[2], ids[4]] },
          { id: 'g-homelab', name: 'homelab', collapsed: true, sessions: [ids[1]] },
        ],
        ungrouped: [ids[3]],
      }),
    });
  }, ids);

  await openSessionList(page);
  await expect.poll(() => page.locator('.sl-group').count()).toBe(3);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'session-groups-1-desktop.png') });

  // Mid-drag: lift the ungrouped row and hold it over the deephive group.
  const grip = await page.locator(`.sl-item[data-session-id="${ids[3]}"] .sl-grip`).boundingBox();
  const target = await page.locator(`.sl-item[data-session-id="${ids[2]}"]`).boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, target.y + 10, { steps: 10 });
  await page.screenshot({ path: path.join(OUT, 'session-groups-2-dragging.png') });
  await page.mouse.up();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'session-groups-3-phone.png') });
});
