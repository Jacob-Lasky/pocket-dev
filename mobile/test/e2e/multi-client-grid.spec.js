import { test, expect, gotoTest, waitForConnection } from './fixtures.js';
import path from 'node:path';

const grid = page => page.evaluate(() => ({ cols: window.term.cols, rows: window.term.rows }));

test('different browser viewports converge on the shared PTY grid', async ({
  pdServerQueryApp,
  browser,
  browserName,
}) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const phonePage = await phone.newPage();
  await gotoTest(phonePage, pdServerQueryApp);
  await waitForConnection(phonePage);
  const phoneFit = await grid(phonePage);

  const desktop = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const desktopPage = await desktop.newPage();
  await gotoTest(desktopPage, pdServerQueryApp);
  await waitForConnection(desktopPage);
  const desktopFit = await grid(desktopPage);

  expect(desktopFit.cols).toBeGreaterThan(phoneFit.cols);
  await expect.poll(async () => [await grid(phonePage), await grid(desktopPage)])
    .toEqual([desktopFit, desktopFit]);

  await phonePage.screenshot({
    path: path.resolve(`test-artifacts/multi-client-grid-phone-${browserName}.png`),
  });
  await desktopPage.screenshot({
    path: path.resolve(`test-artifacts/multi-client-grid-desktop-${browserName}.png`),
  });
  await phone.close();
  await desktop.close();
});
