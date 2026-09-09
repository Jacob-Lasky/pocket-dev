import { test, expect, gotoTest, waitForConnection } from './fixtures.js';
import path from 'node:path';

test('ordinary drag selects live text while the app has mouse tracking enabled', async ({ pdServerMouseApp, page }) => {
  await gotoTest(page, pdServerMouseApp);
  await waitForConnection(page);
  const marker = page.locator('.terminal-pane.active .xterm-rows > div').filter({ hasText: 'MOUSE-APP-READY' }).first();
  await expect(marker).toBeVisible();
  const box = await marker.boundingBox();
  const cellWidth = await page.evaluate(() => {
    const screen = document.querySelector('.terminal-pane.active .xterm-screen');
    return screen.getBoundingClientRect().width / window.term.cols;
  });
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + cellWidth * 15, box.y + box.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() || window.term.getSelection()))
    .toContain('MOUSE-APP-READY');
  await page.mouse.move(box.x + cellWidth * 20, box.y + box.height * 2);
  await expect.poll(() => page.evaluate(() => window.term.getSelection())).toContain('MOUSE-APP-READY');
});

test('a click still reaches a mouse-tracking application', async ({ pdServerMouseApp, page }) => {
  await page.addInitScript(() => {
    window.sentFrames = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) { window.sentFrames.push(data); return send.call(this, data); };
  });
  await gotoTest(page, pdServerMouseApp);
  await waitForConnection(page);
  const marker = page.locator('.terminal-pane.active .xterm-rows > div').filter({ hasText: 'MOUSE-APP-READY' }).first();
  await expect(marker).toBeVisible();
  await marker.click({ position: { x: 15, y: 8 } });
  await expect.poll(() => page.evaluate(() => window.sentFrames.some(s => /\x1b\[<0;/.test(s)))).toBe(true);
});

test('ordinary multiline drag selects text in reading order', async ({ pdServerMouseApp, page }) => {
  await gotoTest(page, pdServerMouseApp);
  await waitForConnection(page);
  await expect(page.locator('.terminal-pane.active')).toContainText('MOUSE-APP-READY');
  await page.evaluate(() => new Promise(done => window.term.write('\x1b[2J\x1b[Halpha one two three\r\nbravo four five six\r\ncharlie seven eight', done)));
  const box = await page.locator('.terminal-pane.active .xterm-screen').boundingBox();
  const { cols, rows } = await page.evaluate(() => ({ cols: window.term.cols, rows: window.term.rows }));
  await page.mouse.move(box.x + box.width / cols * 6 + 1, box.y + box.height / rows / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / cols * 12, box.y + box.height / rows * 2.5, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.term.getSelection())).toBe('one two three\nbravo four five six\ncharlie seve');
});

test('long press selects in Live, handles extend the selection and Copy works', async ({ pdServerMouseApp, browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP drives actual touch input in Chromium');
  const context = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true,
    permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await gotoTest(page, pdServerMouseApp);
  await waitForConnection(page);
  await expect(page.locator('.terminal-pane.active')).toContainText('MOUSE-APP-READY');
  await page.evaluate(() => new Promise(done => window.term.write('\r\nselectable words here', done)));
  const marker = page.locator('.terminal-pane.active .xterm-rows > div').filter({ hasText: 'selectable words here' }).first();
  await expect(marker).toBeVisible();
  const box = await marker.boundingBox();
  const cdp = await context.newCDPSession(page);
  const touch = (type, x = 0, y = 0) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
  });
  await touch('touchStart', box.x + 20, box.y + box.height / 2);
  await expect.poll(() => page.evaluate(() => window.term.getSelection())).toBe('selectable');
  await touch('touchEnd');
  await expect(page.locator('.terminal-pane.active .selection-tools')).toBeVisible();
  const handle = await page.locator('.terminal-pane.active .selection-end').boundingBox();
  const width = await page.evaluate(() => document.querySelector('.terminal-pane.active .xterm-screen').getBoundingClientRect().width / window.term.cols);
  await touch('touchStart', handle.x + 20, handle.y + 15);
  await touch('touchMove', handle.x + 20 + width * 6, handle.y + 15);
  await touch('touchEnd');
  await expect.poll(() => page.evaluate(() => window.term.getSelection())).toBe('selectable words');
  await page.bringToFront();
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('selectable words');
  await page.screenshot({ path: path.resolve('test-artifacts/mobile-live-selection.png') });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.term.hasSelection())).toBe(false);
  // A short tap must still reach interactive choices in the application.
  await page.evaluate(() => {
    window.touchFrames = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) { window.touchFrames.push(data); return send.call(this, data); };
  });
  await touch('touchStart', box.x + 20, box.y + box.height / 2);
  await touch('touchEnd');
  await expect.poll(() => page.evaluate(() => window.touchFrames.some(s => /\x1b\[<0;/.test(s)))).toBe(true);
  await expect(page.locator('#mode-select')).toHaveCount(0);
  // Wide glyphs occupy two cells; dragging onto their continuation cell must
  // keep the whole glyph instead of copying a placeholder space.
  await page.evaluate(() => new Promise(done => window.term.write('\x1b[2J\x1b[H漢字 more', done)));
  const wide = await page.locator('.terminal-pane.active .xterm-rows > div').filter({ hasText: '漢字 more' }).first().boundingBox();
  await touch('touchStart', wide.x + 2, wide.y + wide.height / 2);
  await expect.poll(() => page.evaluate(() => window.term.getSelection())).toBe('漢字');
  await touch('touchEnd');
  const start = await page.locator('.terminal-pane.active .selection-start').boundingBox();
  await touch('touchStart', start.x + 22, start.y + 15);
  await touch('touchMove', start.x + 22 + width, start.y + 15);
  await touch('touchEnd');
  await expect.poll(() => page.evaluate(() => window.term.getSelection())).toBe('漢字');
  await context.close();
});
