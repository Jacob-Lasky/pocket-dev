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

  let diag;
  try {
    await expect(page.locator('#view-content')).toContainText('unique-marker-string', { timeout: 3000 });
  } catch (e) {
    diag = await page.evaluate(() => {
      const probe = {
        bodyDataMode: document.body.dataset.mode,
        viewContentInnerHTML: document.getElementById('view-content').innerHTML.slice(0, 400),
        rawSerialized: '',
        rawSerializedLen: 0,
        rawSerializedSample: '',
        ansiHtml: '',
        ansiHtmlLen: 0,
      };
      try {
        const raw = window.serializeAddon?.serialize({ excludeAltBuffer: true }) ?? '<<no-serializeAddon>>';
        probe.rawSerializedLen = raw.length;
        probe.rawSerializedSample = JSON.stringify(raw.slice(0, 400));
        const html = window.viewRenderer?.ansiUp?.ansi_to_html(raw) ?? '<<no-viewRenderer>>';
        probe.ansiHtml = html.slice(0, 400);
        probe.ansiHtmlLen = html.length;
        // Try without excludeAltBuffer to see if alt-screen is involved
        const rawAlt = window.serializeAddon?.serialize() ?? '';
        probe.rawSerializedNoExcludeAltLen = rawAlt.length;
        probe.rawSerializedNoExcludeAltSample = JSON.stringify(rawAlt.slice(0, 400));
      } catch (probeErr) {
        probe.probeError = String(probeErr);
      }
      return probe;
    });
    throw new Error(`toContainText failed; diag=${JSON.stringify(diag, null, 2)}`);
  }
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
