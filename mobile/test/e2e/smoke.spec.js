import { test, expect, gotoTest, waitForConnection, sendAndWaitForEcho } from './fixtures.js';

test('toolbar shows Live / View / Copy buttons', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await expect(page.locator('#mode-live')).toBeVisible();
  await expect(page.locator('#mode-view')).toBeVisible();
  await expect(page.locator('#copy-btn')).toBeVisible();
});

test('typed input echoes back into terminal (WebSocket round-trip)', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await sendAndWaitForEcho(page, 'hello');
});

test('toggling to View shows current buffer content', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await sendAndWaitForEcho(page, 'unique-marker-string');

  await page.click('#mode-view');
  // refreshViewIfActive runs synchronously inside setMode('view'), reading
  // the current xterm.js buffer — which already contains the marker because
  // sendAndWaitForEcho just confirmed it landed in #terminal-container.
  await expect(page.locator('#view-content')).toContainText('unique-marker-string', { timeout: 3000 });
});

test('View pane wraps long lines on a 360px viewport', async ({ pdServer, browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 700 } });
  const page = await ctx.newPage();
  await gotoTest(page, pdServer);
  await waitForConnection(page);

  const longLine = 'x'.repeat(200);
  await sendAndWaitForEcho(page, longLine);
  await page.click('#mode-view');
  // Wait for the View pane to actually contain the long line, not just
  // a fixed time — same root cause as the toggle test.
  await expect(page.locator('#view-content')).toContainText(longLine, { timeout: 3000 });

  // No horizontal scrollbar on the view pane
  const overflow = await page.evaluate(() => {
    const el = document.getElementById('view-pane');
    return el.scrollWidth > el.clientWidth;
  });
  expect(overflow).toBe(false);

  await ctx.close();
});
