import { test, expect, gotoTest, waitForConnection, sendAndWaitForEcho } from './fixtures.js';

// Playwright doesn't expose clipboard-read / clipboard-write permissions in
// Firefox (they're chromium-only). Run the entire clipboard E2E suite under
// chromium; the underlying clipboardWrite logic is already covered for both
// the navigator.clipboard path and the document.execCommand fallback by the
// unit tests in test/unit/clipboard.test.js, so we don't lose coverage.
test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'clipboard permissions only available in chromium',
);

test.use({
  permissions: ['clipboard-read', 'clipboard-write'],
});

test('Copy button writes terminal output to clipboard with no trailing whitespace', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await sendAndWaitForEcho(page, 'clipboard-test-marker');

  await page.click('#copy-btn');
  // Poll the clipboard until the marker shows up — clipboardWrite is async
  // and there's no DOM signal we can wait on. ~200ms is typical, 3s is safe.
  await expect.poll(
    () => page.evaluate(() => navigator.clipboard.readText()),
    { timeout: 3000 },
  ).toContain('clipboard-test-marker');

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  // No line should have trailing whitespace
  for (const line of clip.split('\n')) {
    expect(line).not.toMatch(/[ \t]+$/);
  }
});

test('drag-selecting in xterm.js auto-copies via onSelectionChange', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await sendAndWaitForEcho(page, 'drag-select-marker');

  await page.evaluate(() => window.term.selectAll());
  await expect.poll(
    () => page.evaluate(() => navigator.clipboard.readText()),
    { timeout: 3000 },
  ).toContain('drag-select-marker');
});

test('HTTP fallback path: when navigator.clipboard rejects, execCommand runs', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);

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

  await sendAndWaitForEcho(page, 'fallback-marker');
  await page.click('#copy-btn');
  // Poll for execCommand('copy') to be observed; it's invoked synchronously
  // after the clipboardWrite promise rejects, which depends on microtask order.
  await expect.poll(
    () => page.evaluate(() => window.__execCommandCalls),
    { timeout: 3000 },
  ).toContain('copy');
});
