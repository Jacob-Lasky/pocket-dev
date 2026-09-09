import { test, expect, gotoTest, waitForConnection } from './fixtures.js';

async function startQueries(page, server) {
  await gotoTest(page, server);
  await waitForConnection(page);
  await expect(page.locator('#terminal-stack')).toContainText('QUERY-APP-READY');
  await page.locator('#cmd-input').fill('queryagain');
  await page.click('#send-btn');
  await expect(page.locator('#terminal-stack')).toContainText('QUERY-REPLIES-1');
}

test('live queries get replies but historical queries never do, including unseen ones', async ({ pdServerQueryApp, page }) => {
  await startQueries(page, pdServerQueryApp);
  await page.reload();
  await waitForConnection(page);
  await expect(page.locator('#terminal-stack')).toContainText('QUERY-REPLIES-1');
  // Wait for a real round trip after replay; then a missing second reply is
  // evidence, rather than checking before the server had time to receive it.
  await page.locator('#cmd-input').fill('marker');
  await page.click('#send-btn');
  await expect(page.locator('#terminal-stack')).toContainText('MARKER-ACK-REPLIES-1');
  await expect(page.locator('#terminal-stack')).not.toContainText('QUERY-REPLIES-2');
  const [session] = await (await page.request.get(pdServerQueryApp.baseURL + '/sessions')).json();
  await page.goto('about:blank');
  await page.request.post(pdServerQueryApp.baseURL + '/send', { data: { session: session.id, text: 'queryagain' } });
  await expect.poll(async () => (await (await page.request.get(pdServerQueryApp.baseURL + '/sessions')).json())[0].lastOutputAt)
    .toBeGreaterThan(session.lastOutputAt);
  await gotoTest(page, pdServerQueryApp);
  await waitForConnection(page);
  await page.locator('#cmd-input').fill('marker');
  await page.click('#send-btn');
  await expect(page.locator('#terminal-stack')).toContainText('MARKER-ACK-REPLIES-1');
  await expect(page.locator('#terminal-stack')).not.toContainText('QUERY-REPLIES-2');
  await page.locator('#cmd-input').fill('queryagain');
  await page.click('#send-btn');
  await expect(page.locator('#terminal-stack')).toContainText('QUERY-REPLIES-2');
  await page.locator('#cmd-input').fill('marker');
  await page.click('#send-btn');
  await expect(page.locator('#terminal-stack')).toContainText('MARKER-ACK-REPLIES-2');
  await expect(page.locator('#terminal-stack')).not.toContainText('QUERY-REPLIES-3');
});

test('two browsers answer each new terminal query only once', async ({ pdServerQueryApp, page, context }) => {
  await startQueries(page, pdServerQueryApp);
  const other = await context.newPage();
  await gotoTest(other, pdServerQueryApp);
  await waitForConnection(other);
  await expect(other.locator('#terminal-stack')).toContainText('QUERY-REPLIES-1');
  await page.locator('#cmd-input').fill('queryagain');
  await page.click('#send-btn');
  for (const tab of [page, other]) await expect(tab.locator('#terminal-stack')).toContainText('QUERY-REPLIES-2');
  // Both parsers completed before a real round trip establishes the count.
  await other.evaluate(() => window.term.input('marker'));
  await expect(other.locator('#terminal-stack')).toContainText('MARKER-ACK-REPLIES-2');
  await expect(other.locator('#terminal-stack')).not.toContainText('QUERY-REPLIES-3');
  await page.close();
  await other.locator('#cmd-input').fill('queryagain');
  await other.click('#send-btn');
  await expect(other.locator('#terminal-stack')).toContainText('QUERY-REPLIES-3');
});

test('a dropped reply is not replayed into a prompt after reconnect', async ({ pdServerQueryApp, page }) => {
  await startQueries(page, pdServerQueryApp);
  await page.evaluate(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      if (/^\x1b\[>/.test(data)) { window.droppedReply = true; return; }
      return send.call(this, data);
    };
  });
  await page.locator('#cmd-input').fill('queryagain');
  await page.click('#send-btn');
  await expect(page.locator('#terminal-stack')).toContainText('NEW-QUERY');
  await expect.poll(() => page.evaluate(() => window.droppedReply)).toBe(true);
  await page.evaluate(() => window.term.input('marker'));
  await expect(page.locator('#terminal-stack')).toContainText('MARKER-ACK-REPLIES-1');
  await page.reload();
  await waitForConnection(page);
  await page.evaluate(() => window.term.input('marker'));
  await expect(page.locator('#terminal-stack')).toContainText('MARKER-ACK-REPLIES-1');
  await expect(page.locator('#terminal-stack')).not.toContainText('QUERY-REPLIES-2');
  await page.locator('#cmd-input').fill('queryagain');
  await page.click('#send-btn');
  await expect(page.locator('#terminal-stack')).toContainText('QUERY-REPLIES-2');
  await page.evaluate(() => window.term.input('marker'));
  await expect(page.locator('#terminal-stack')).toContainText('MARKER-ACK-REPLIES-2');
  await expect(page.locator('#terminal-stack')).not.toContainText('QUERY-REPLIES-3');
});

test('keyboard and paste bypass a pending terminal reply batch', async ({ pdServerQueryApp, page }) => {
  await startQueries(page, pdServerQueryApp);
  await page.evaluate(() => {
    const write = window.term.write.bind(window.term);
    window.term.write = (data, callback) => write(data, () => {
      if (data.includes('NEW-QUERY')) window.finishOutput = callback;
      else callback?.();
    });
  });
  await page.locator('#cmd-input').fill('queryagain');
  await page.click('#send-btn');
  await expect.poll(() => page.evaluate(() => typeof window.finishOutput)).toBe('function');
  await page.evaluate(() => window.term.focus());
  await page.keyboard.type('mar');
  await page.evaluate(() => window.term.paste('ker'));
  // The reply is still waiting for the parser callback. Human input must reach
  // the app first, even though its resulting output is queued for rendering.
  await page.evaluate(() => window.finishOutput());
  await expect(page.locator('#terminal-stack')).toContainText('MARKER-ACK-REPLIES-1');
  await expect(page.locator('#terminal-stack')).toContainText('QUERY-REPLIES-2');
});
