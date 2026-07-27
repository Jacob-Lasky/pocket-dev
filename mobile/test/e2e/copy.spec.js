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

// Read the clipboard so a REJECTION is reported instead of swallowed.
//
// `expect.poll` treats a throwing callback as "not ready yet" and retries, so a
// navigator.clipboard.readText() that rejects outright (NotAllowedError from an
// unfocused document is the usual one in headless CI) is indistinguishable from
// a clipboard that is merely slow. Both present as the same bare
// "Timeout Nms exceeded while waiting on the predicate", which names no cause.
//
// That ambiguity is why this suite has already been "fixed" once by raising the
// timeout 3s -> 8s, and why it still flaked afterwards: if the read is being
// refused, no timeout is long enough, and the message never says so. Returning
// the error as the polled VALUE puts the reason in the failure output.
//
// DO NOT collapse this back to a bare `page.evaluate(() => navigator.clipboard
// .readText())`, and DO NOT respond to the next flake by raising the timeout
// again before reading what the failure actually says.
const readClipboard = (page) =>
  page.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch (e) {
      return `<clipboard read rejected: ${e.name}: ${e.message}>`;
    }
  });

test('Copy button writes terminal output to clipboard with no trailing whitespace', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await sendAndWaitForEcho(page, 'clipboard-test-marker');

  await page.click('#copy-btn');
  // Poll because clipboardWrite is async with no DOM signal to wait on; ~200ms
  // is typical locally. The timeout is a bound, NOT the mechanism that makes
  // this reliable — see readClipboard above for why a longer one is not the fix
  // when the read is being refused rather than lagging.
  await expect.poll(() => readClipboard(page), { timeout: 8000 })
    .toContain('clipboard-test-marker');

  const clip = await readClipboard(page);
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
  await expect.poll(() => readClipboard(page), { timeout: 8000 })
    .toContain('drag-select-marker');
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
    { timeout: 8000 },
  ).toContain('copy');
});
