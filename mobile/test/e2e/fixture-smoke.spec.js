import { test, expect } from './fixtures.js';

test('fixture starts a server on a random port', async ({ pdServer, page }) => {
  await page.goto(pdServer.baseURL);
  await expect(page).toHaveTitle('pocket-dev');
});
