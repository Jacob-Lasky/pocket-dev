import { test, expect } from './fixtures.js';

test('toolbar shows Live / View / Copy buttons', async ({ pdServer, page }) => {
  await page.goto(pdServer.baseURL + '/?test=1');
  await expect(page.locator('#mode-live')).toBeVisible();
  await expect(page.locator('#mode-view')).toBeVisible();
  await expect(page.locator('#copy-btn')).toBeVisible();
});

test('typed input echoes back into terminal (WebSocket round-trip)', async ({ pdServer, page }) => {
  await page.goto(pdServer.baseURL + '/?test=1');
  // Wait for WebSocket connection
  await page.waitForFunction(() => document.getElementById('conn-dot').classList.contains('connected'), null, { timeout: 5000 });

  // Send "hello\n" via the input bar
  await page.fill('#cmd-input', 'hello');
  await page.click('#send-btn');

  // The xterm.js DOM should eventually contain "hello"
  await expect.poll(async () => {
    return await page.evaluate(() => document.querySelector('#terminal-container').innerText);
  }, { timeout: 5000 }).toContain('hello');
});

test('toggling to View shows current buffer content', async ({ pdServer, page }) => {
  await page.goto(pdServer.baseURL + '/?test=1');
  await page.waitForFunction(() => document.getElementById('conn-dot').classList.contains('connected'));

  await page.fill('#cmd-input', 'unique-marker-string');
  await page.click('#send-btn');
  await page.waitForTimeout(500);

  await page.click('#mode-view');
  await expect(page.locator('#view-content')).toContainText('unique-marker-string', { timeout: 3000 });
});

test('View pane wraps long lines on a 360px viewport', async ({ pdServer, browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 700 } });
  const page = await ctx.newPage();
  await page.goto(pdServer.baseURL + '/?test=1');
  await page.waitForFunction(() => document.getElementById('conn-dot').classList.contains('connected'));

  const longLine = 'x'.repeat(200);
  await page.fill('#cmd-input', longLine);
  await page.click('#send-btn');
  await page.waitForTimeout(500);
  await page.click('#mode-view');
  await page.waitForTimeout(500);

  // No horizontal scrollbar on the view pane
  const overflow = await page.evaluate(() => {
    const el = document.getElementById('view-pane');
    return el.scrollWidth > el.clientWidth;
  });
  expect(overflow).toBe(false);

  await ctx.close();
});
