// Live display and copy test against a REAL captured Claude TUI frame.
//
// The frame (test/e2e/fixtures/claude-trust-frame.b64) is the "trust this
// folder?" prompt, which positions every word with CHA (\x1b[NG, absolute
// column) and emits NO literal spaces. The old serialize()+ansi_up View path
// dropped those cursor-move codes, so words ran together ("Quicksafetycheck").
// This drives the full production pipeline (PTY -> tmux -> WebSocket -> xterm
// -> parsed-buffer copy) and asserts the spaces are reconstructed, plus captures a
// screenshot artifact (required for UI-touching diffs).

import { test, expect, gotoTest, waitForConnection } from './fixtures.js';
import path from 'node:path';
import fs from 'node:fs';

const copyText = page => page.evaluate(async () => {
  const { renderTerminalText } = await import('/js/view.js');
  return renderTerminalText(window.term);
});

const ARTIFACTS_DIR = path.resolve(__dirname, '../../test-artifacts');

test.beforeAll(() => {
  if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
});

test('Live reconstructs spaces from a real Claude alt-screen frame', async ({ pdServerClaudeFrame, page, browserName }) => {
  await gotoTest(page, pdServerClaudeFrame);
  await waitForConnection(page);

  // Wait for the frame to land in the live buffer first.
  await expect
    .poll(async () => page.evaluate(() => document.querySelector('#terminal-container').innerText.replace(/\s+/g, '')),
      { timeout: 8000 })
    .toContain('Quicksafetycheck');


  // The copy helper shows the words WITH the spaces the CHA codes implied.
  // (Strict line-by-line assertions live in the unit test, which writes the
  // frame straight to xterm; through real tmux the exact cursor-up redraw of
  // the menu lines and tmux's startup query handshake vary, so here we assert
  // the robustly-present prose the CHA codes encoded.)
  await expect.poll(() => copyText(page)).toContain(
    'Quick safety check: Is this a project you created or one you trust',
  );
  await expect.poll(() => copyText(page)).toContain(
    "take a moment to review what's in this folder first",
  );

  // The CHA cursor-move codes that broke the old path must not survive as text.
  const viewText = await page.evaluate(() => document.getElementById('terminal-stack').innerText);
  expect(viewText).not.toMatch(/\[\d+G/); // no bare CHA sequences

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
  // Same exposure as copy.spec.js: Chromium rejects a clipboard write from an
  // unfocused document, and a parallel worker's context is enough to take focus.
  await page.bringToFront();
  await expect
    .poll(async () => page.evaluate(() => document.querySelector('#terminal-container').innerText.replace(/\s+/g, '')),
      { timeout: 8000 })
    .toContain('Quicksafetycheck');

  await expect.poll(() => copyText(page)).toContain('Quick safety check');

  await page.click('#copy-btn');
  const clip = await page.evaluate(() => navigator.clipboard.readText());

  // Clean text: real spaces, no escape/cursor codes.
  expect(clip).toContain('Quick safety check: Is this a project you created');
  expect(clip).not.toContain('\x1b');
  expect(clip).not.toMatch(/\[\d+G/);
  // No runs of 3+ blank lines (cleanCopyText collapses them).
  expect(clip).not.toMatch(/\n\n\n/);
});
