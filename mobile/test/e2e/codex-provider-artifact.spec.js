// Visual artifact for the three explicit provider/account choices. The
// behavioral contract lives in codex-provider.spec.js; this only proves the
// compact labels still fit the phone-width session bar and remain legible.
//
// On demand, chromium only:
//   PD_ARTIFACTS=1 npx playwright test codex-provider-artifact --project=chromium
// It writes into test-artifacts/.

import path from 'node:path';
import { test, expect, gotoTest, waitForConnection, openSessionList } from './fixtures.js';

const OUT = path.resolve(__dirname, '../../test-artifacts');

test.skip(
  ({ browserName }) => browserName !== 'chromium' || !process.env.PD_ARTIFACTS,
  'artifact run is chromium-only and on demand (set PD_ARTIFACTS=1)',
);

test('artifact: Claude and both Codex account routes fit the phone picker', async ({ pdServerClaudeStub, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);
  await openSessionList(page);

  const bar = page.locator('#sl-bar');
  await expect(bar.getByRole('button')).toHaveCount(3);
  await expect.poll(() => page.locator('#sl-count').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: path.join(OUT, 'codex-provider-picker-phone.png'), fullPage: false });
});
