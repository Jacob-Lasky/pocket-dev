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

  // Whitespace-stripped poll: a 200-char line wraps to ~5 rows in xterm.js
  // at this viewport width, so the visible text has line breaks splitting
  // the x's. Stripping whitespace lets us assert "the marker is in the
  // buffer" without caring about layout.
  await expect.poll(
    async () => {
      const text = await page.evaluate(() => document.getElementById('view-content').innerText);
      return text.replace(/\s+/g, '');
    },
    { timeout: 3000 },
  ).toContain(longLine);

  // No horizontal scrollbar on the view pane
  const overflow = await page.evaluate(() => {
    const el = document.getElementById('view-pane');
    return el.scrollWidth > el.clientWidth;
  });
  expect(overflow).toBe(false);

  await ctx.close();
});
