import { test, expect, gotoTest, waitForConnection } from './fixtures.js';

test.describe('Firefox + Pixel 5 emulation', () => {
  test.skip(({ browserName }) => browserName !== 'firefox', 'firefox-only');

  test('default mode is View on a coarse-pointer device', async ({ pdServer, page }) => {
    await gotoTest(page, pdServer);
    await page.waitForFunction(() => document.body.dataset.mode);
    expect(await page.evaluate(() => document.body.dataset.mode)).toBe('view');
  });

  test('View pane is selectable text (long-press emulation)', async ({ pdServer, page }) => {
    await gotoTest(page, pdServer);
    await waitForConnection(page);

    await page.fill('#cmd-input', 'mobile-select-marker');
    await page.click('#send-btn');
    await page.waitForTimeout(500);

    // Build a Range spanning #view-content, then turn it into a Selection.
    const selectedText = await page.evaluate(() => {
      const node = document.getElementById('view-content');
      const range = document.createRange();
      range.selectNodeContents(node);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return sel.toString();
    });

    expect(selectedText).toContain('mobile-select-marker');
  });
});
