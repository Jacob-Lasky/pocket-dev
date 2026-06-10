// Live View-mode test against a REAL captured Claude TUI frame.
//
// The frame (test/e2e/fixtures/claude-trust-frame.b64) is the "trust this
// folder?" prompt, which positions every word with CHA (\x1b[NG, absolute
// column) and emits NO literal spaces. The old serialize()+ansi_up View path
// dropped those cursor-move codes, so words ran together ("Quicksafetycheck").
// This drives the full production pipeline (PTY -> tmux -> WebSocket -> xterm
// -> View renderer) and asserts the spaces are reconstructed, plus captures a
// screenshot artifact (required for UI-touching diffs).

import { test, expect, gotoTest, waitForConnection } from './fixtures.js';
import path from 'node:path';
import fs from 'node:fs';

const ARTIFACTS_DIR = path.resolve(__dirname, '../../test-artifacts');

test.beforeAll(() => {
  if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
});

test('View reconstructs spaces from a real Claude alt-screen frame', async ({ pdServerClaudeFrame, page, browserName }) => {
  await gotoTest(page, pdServerClaudeFrame);
  await waitForConnection(page);

  // Wait for the frame to land in the live buffer first.
  await expect
    .poll(async () => page.evaluate(() => document.querySelector('#terminal-container').innerText.replace(/\s+/g, '')),
      { timeout: 8000 })
    .toContain('Quicksafetycheck');

  await page.click('#mode-view');
  await expect.poll(() => page.evaluate(() => document.body.dataset.mode)).toBe('view');

  // The fix: View shows the words WITH the spaces the CHA codes implied.
  // (Strict line-by-line assertions live in the unit test, which writes the
  // frame straight to xterm; through real tmux the exact cursor-up redraw of
  // the menu lines and tmux's startup query handshake vary, so here we assert
  // the robustly-present prose the CHA codes encoded.)
  await expect(page.locator('#view-content')).toContainText(
    'Quick safety check: Is this a project you created or one you trust',
    { timeout: 3000 },
  );
  await expect(page.locator('#view-content')).toContainText(
    "take a moment to review what's in this folder first",
  );

  // The CHA cursor-move codes that broke the old path must not survive as text.
  const viewText = await page.evaluate(() => document.getElementById('view-content').innerText);
  expect(viewText).not.toMatch(/\[\d+G/); // no bare CHA sequences

  // Colour is preserved: the amber header rule is truecolor #ffc107.
  const hasColour = await page.evaluate(() =>
    !!document.querySelector('#view-content span[style*="color:#ffc107"]'));
  expect(hasColour).toBe(true);

  // Visual artifact (required for UI-touching diffs).
  await page.screenshot({
    path: path.join(ARTIFACTS_DIR, `view-claude-frame-${browserName}.png`),
    fullPage: true,
  });
});

test('Copy grabs the visible window as clean text (chromium clipboard)', async ({ pdServerClaudeFrame, page, browserName, context }) => {
  test.skip(browserName !== 'chromium', 'clipboard read permission only granted reliably in chromium');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await gotoTest(page, pdServerClaudeFrame);
  await waitForConnection(page);
  await expect
    .poll(async () => page.evaluate(() => document.querySelector('#terminal-container').innerText.replace(/\s+/g, '')),
      { timeout: 8000 })
    .toContain('Quicksafetycheck');

  await page.click('#mode-view');
  await expect.poll(() => page.evaluate(() => document.body.dataset.mode)).toBe('view');
  await expect(page.locator('#view-content')).toContainText('Quick safety check', { timeout: 3000 });

  await page.click('#copy-btn');
  const clip = await page.evaluate(() => navigator.clipboard.readText());

  // Clean text: real spaces, no escape/cursor codes.
  expect(clip).toContain('Quick safety check: Is this a project you created');
  expect(clip).not.toContain('\x1b');
  expect(clip).not.toMatch(/\[\d+G/);
  // No runs of 3+ blank lines (cleanCopyText collapses them).
  expect(clip).not.toMatch(/\n\n\n/);
});
