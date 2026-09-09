import { test, expect, gotoTest, gotoRaw, waitForConnection, newSession, switchToRow } from './fixtures.js';
import path from 'node:path';

test('composer preserves multiline input, supports cursor editing and sends it together', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  const input = page.locator('#cmd-input');
  await input.fill('first line');
  await input.press('Shift+Enter');
  await input.pressSequentially('second line');
  await expect(input).toHaveValue('first line\nsecond line');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('first line\nsecond line');
  const request = page.waitForRequest(r => r.url().endsWith('/send'));
  await page.click('#send-btn');
  expect((await request).postDataJSON().text).toBe('first line\nsecond line');
  await expect(input).toHaveValue('');
});

test('failed delivery keeps the draft, and a later successful send clears it', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await page.route('**/send', route => route.fulfill({ status: 503, body: 'unavailable' }));
  const input = page.locator('#cmd-input');
  await input.fill('do not lose this message');
  await page.click('#send-btn');
  await expect(page.locator('#composer-error')).toBeVisible();
  await expect(input).toHaveValue('do not lose this message');
  await page.unroute('**/send');
  await page.click('#send-btn');
  await expect(input).toHaveValue('');
  await expect(page.locator('#composer-error')).toBeHidden();
});

test('drafts stay with their session across switches and reloads', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  const input = page.locator('#cmd-input');
  await input.fill('first session draft');
  await newSession(page);
  await expect(input).toHaveValue('');
  await input.fill('second session draft');
  await switchToRow(page, 0);
  await expect(input).toHaveValue('first session draft');
  await page.reload();
  await waitForConnection(page);
  await expect(input).toHaveValue('first session draft');
  await switchToRow(page, 1);
  await expect(input).toHaveValue('second session draft');
});

test('a response cannot erase edits made while a send is in flight', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/send', async route => { await gate; await route.continue(); });
  const input = page.locator('#cmd-input');
  await input.fill('first message');
  const request = page.waitForRequest(r => r.url().endsWith('/send'));
  await page.click('#send-btn');
  await request;
  await input.fill('next message');
  release();
  await expect(page.locator('#send-btn')).toBeEnabled();
  await expect(input).toHaveValue('next message');
});

test('a stalled send does not block sending in another session', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/send', async route => {
    if (route.request().postDataJSON().text === 'first session message') await gate;
    await route.continue();
  });
  const input = page.locator('#cmd-input');
  await input.fill('first session message');
  const first = page.waitForRequest(r => r.url().endsWith('/send'));
  await page.click('#send-btn');
  await first;
  await newSession(page);
  await expect(page.locator('#send-btn')).toBeEnabled();
  await input.fill('second session message');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await switchToRow(page, 0);
  await expect(input).toHaveValue('first session message');
  await expect(page.locator('#send-btn')).toBeDisabled();
  release();
  await expect(input).toHaveValue('');
  await expect(page.locator('#send-btn')).toBeEnabled();
});

test('phone composer grows, Return makes a newline, and controls fit above the keyboard', async ({ pdServer, browser, browserName }) => {
  test.skip(browserName === 'firefox', 'Playwright Firefox cannot emulate touch');
  const context = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await gotoRaw(page, pdServer);
  await waitForConnection(page);
  const input = page.locator('#cmd-input');
  await input.fill('Investigate the deployment');
  await input.press('Enter');
  await input.pressSequentially('Keep the sessions running.');
  await expect(input).toHaveValue('Investigate the deployment\nKeep the sessions running.');
  expect((await input.boundingBox()).height).toBeGreaterThan(48);
  await page.screenshot({ path: path.resolve('test-artifacts/mobile-composer.png') });
  // A visual viewport reduced by the on-screen keyboard is a layout contract.
  // This tests the smaller geometry; physical keyboard behavior needs a phone.
  await page.setViewportSize({ width: 390, height: 420 });
  await expect.poll(() => page.locator('#send-btn').boundingBox()).not.toBeNull();
  const box = await page.locator('#send-btn').boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(420);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await context.close();
});
