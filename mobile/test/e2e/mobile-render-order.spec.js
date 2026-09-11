import { test, expect, activeSessionId, gotoTest, waitForConnection } from './fixtures.js';
import path from 'node:path';

const copyText = page => page.evaluate(async () => {
  const { renderTerminalText } = await import('/js/view.js');
  return renderTerminalText(window.term, { viewportOnly: true });
});

const terminalGrid = page => page.evaluate(() => ({ cols: window.term.cols, rows: window.term.rows }));

const sendFixtureLine = (page, session, text) => page.evaluate(async ({ session, text }) => {
  const response = await fetch('/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, text }),
  });
  return { session, ok: response.ok, status: response.status, body: await response.text() };
}, { session, text });

test('a same-size mobile reconnect ends on one coherent TUI frame', async ({ pdServerTruncatedTuiFrame, browser, browserName }) => {
  test.setTimeout(120000);
  const context = await browser.newContext({ viewport: { width: 390, height: 780 } });
  await context.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__testSockets = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__testSockets.push(this);
      }
    };
  });
  const page = await context.newPage();
  await gotoTest(page, pdServerTruncatedTuiFrame);
  await waitForConnection(page, 15000);
  await expect.poll(() => activeSessionId(page), { timeout: 15000 }).not.toBeNull();
  const session = await activeSessionId(page);
  const roster = await page.evaluate(async () => (await fetch('/sessions')).json());
  expect(roster.map(item => item.id)).toContain(session);
  expect(await sendFixtureLine(page, session, 'draw')).toEqual({ session, ok: true, status: 200, body: '{"ok":true}' });
  await expect.poll(() => copyText(page), { timeout: 15000 }).toContain('Quick safety check');
  expect(await sendFixtureLine(page, session, 'trim')).toEqual({ session, ok: true, status: 200, body: '{"ok":true}' });
  await expect.poll(async () => {
    const screen = await copyText(page);
    return screen.includes('Quick safety check') && screen.includes('REPLAY WINDOW TRIMMED');
  }, { timeout: 45000 }).toBe(true);

  const gridBefore = await terminalGrid(page);
  const socketsBefore = await page.evaluate(() => window.__testSockets.length);
  await page.evaluate(() => window.__testSockets.at(-1).close());
  await expect.poll(() => page.evaluate(() => window.__testSockets.length), { timeout: 15000 }).toBeGreaterThan(socketsBefore);
  await waitForConnection(page, 15000);
  await expect.poll(() => terminalGrid(page), { timeout: 15000 }).toEqual(gridBefore);
  await expect.poll(async () => {
    const screen = await copyText(page);
    return screen.includes('Quick safety check') && screen.includes('Review this folder before continuing');
  }, { timeout: 45000 }).toBe(true);
  const screen = await copyText(page);
  expect(screen.split('\n').filter(Boolean)).toEqual([
    'Quick safety check',
    'Review this folder before continuing.',
    'Claude Code can read, edit, and execute files here.',
    'Enter to confirm. Esc to cancel.',
    'REPLAY WINDOW TRIMMED',
  ]);

  await page.screenshot({ path: path.resolve(`test-artifacts/mobile-render-order-${browserName}.png`) });
  await context.close();
});
