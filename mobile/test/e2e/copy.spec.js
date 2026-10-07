import { test, expect, gotoTest, waitForConnection, sendAndWaitForEcho } from './fixtures.js';
import path from 'node:path';

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

  // PREVENT the rejection readClipboard exists to report: Chromium refuses
  // clipboard access from an unfocused document, and a parallel worker's context
  // taking focus is enough to lose it. That is also why this reproduces under
  // CI's scheduling and not on a fast local box (60 runs across 4 workers could
  // not trigger it). Diagnosis and prevention are both wanted here, because a
  // named failure still fails.
  await page.bringToFront();

  // The WRITE half of the same ambiguity. readClipboard covers a refused read;
  // this covers a refused write, which is otherwise indistinguishable from a
  // clipboard that simply never received anything.
  await page.evaluate(() => {
    window.__clipWrite = { ok: null, err: null };
    const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (text) => orig(text)
      .then((r) => { window.__clipWrite = { ok: true, err: null }; return r; })
      .catch((e) => { window.__clipWrite = { ok: false, err: String(e) }; throw e; });
  });

  await page.click('#copy-btn');

  // The write resolved.
  await expect.poll(() => page.evaluate(() => window.__clipWrite), { timeout: 8000 })
    .toEqual({ ok: true, err: null });

  // And the value landed. Poll because clipboardWrite is async with no DOM
  // signal to wait on; ~200ms is typical locally. The timeout is a bound, NOT
  // the mechanism that makes this reliable — see readClipboard above.
  await expect.poll(() => readClipboard(page), { timeout: 8000 })
    .toContain('clipboard-test-marker');

  const clip = await readClipboard(page);
  // No line should have trailing whitespace
  for (const line of clip.split('\n')) {
    expect(line).not.toMatch(/[ \t]+$/);
  }
});

test('Copy on an empty screen flashes failure and leaves the clipboard alone', async ({ pdServer, page }) => {
  // The product half of clipboardWrite's empty-write refusal. `writeText('')`
  // resolves, so before the guard this path replaced whatever the user had
  // copied with nothing AND flashed the success tick: the worst possible report
  // of "I threw away your clipboard". Surfaced by a CI failure reading
  // `Expected substring: "clipboard-test-marker" / Received string: ""` with the
  // write already asserted to have resolved.
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await sendAndWaitForEcho(page, 'sentinel-must-survive');
  await page.bringToFront();

  // Put a known value in the clipboard the honest way, through the app.
  await page.click('#copy-btn');
  await expect.poll(() => readClipboard(page), { timeout: 8000 })
    .toContain('sentinel-must-survive');

  // Now empty the screen and copy again.
  await page.evaluate(() => window.term.clear());
  await expect
    .poll(() => page.evaluate(() => window.term.buffer.normal.getLine(0)?.translateToString(true) ?? ''),
      { timeout: 5000 })
    .toBe('');
  await page.click('#copy-btn');

  // The button says it failed, and it says so for at least a moment.
  await expect(page.locator('#copy-btn')).toHaveText('✗', { timeout: 2000 });

  // And the sentinel is still there. This is the assertion that matters: a guard
  // that only changed the glyph would leave the clipboard destroyed.
  expect(await readClipboard(page)).toContain('sentinel-must-survive');
});

test('xterm programmatic selection auto-copies via onSelectionChange', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await sendAndWaitForEcho(page, 'drag-select-marker');

  await page.evaluate(() => window.term.selectAll());
  await expect.poll(() => readClipboard(page), { timeout: 8000 })
    .toContain('drag-select-marker');
});

test('multiline selection copies as one line across every copy path', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await page.bringToFront();
  await page.evaluate(() => new Promise(done => window.term.write(
    '\x1b[2J\x1b[H    first line\r\n    second line\r\n      nested line', done,
  )));
  await page.evaluate(() => window.term.select(4, 0, 2 * window.term.cols + 13));

  const expected = 'first line second line nested line';
  await expect.poll(() => readClipboard(page), { timeout: 8000 }).toBe(expected);
  await page.evaluate(() => navigator.clipboard.writeText('native-copy-sentinel'));
  const nativeCopy = await page.evaluate(() => {
    window.term.focus();
    return document.execCommand('copy');
  });
  expect(nativeCopy).toBe(true);
  await expect.poll(() => readClipboard(page), { timeout: 8000 }).toBe(expected);
  await page.click('#copy-btn');
  await expect.poll(() => readClipboard(page), { timeout: 8000 }).toBe(expected);
  await page.locator('#cmd-input').fill(await readClipboard(page));
  await expect(page.locator('#cmd-input')).toHaveValue(expected);
  await page.screenshot({ path: path.resolve('test-artifacts/copy-single-line.png') });
});

test('Copy button joins visible terminal rows when nothing is selected', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await page.bringToFront();
  await page.evaluate(() => new Promise(done => window.term.write(
    '\x1b[2J\x1b[H    first line\r\n\r\n      second  line', done,
  )));
  await page.click('#copy-btn');
  await expect.poll(() => readClipboard(page), { timeout: 8000 }).toBe('first line second  line');
});

test('Alt drag keeps rectangular selection columns aligned when copied', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await page.bringToFront();
  await page.evaluate(() => new Promise(done => window.term.write(
    '\x1b[2J\x1b[H    alpha\r\n    bravo', done,
  )));
  const grid = await page.evaluate(() => {
    const rect = document.querySelector('.terminal-pane.active .xterm-screen').getBoundingClientRect();
    return { x: rect.x, y: rect.y, cellWidth: rect.width / window.term.cols,
      cellHeight: rect.height / window.term.rows };
  });
  await page.keyboard.down('Alt');
  await page.mouse.move(grid.x + 2.5 * grid.cellWidth, grid.y + .5 * grid.cellHeight);
  await page.mouse.down();
  await page.mouse.move(grid.x + 9.5 * grid.cellWidth, grid.y + 1.5 * grid.cellHeight, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const raw = await page.evaluate(() => window.term.getSelection());
  expect(raw).toMatch(/^  alpha\n  bravo$/);
  await expect.poll(() => readClipboard(page), { timeout: 8000 }).toBe(raw);
  await page.click('#copy-btn');
  await expect.poll(() => readClipboard(page), { timeout: 8000 }).toBe(raw);
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
