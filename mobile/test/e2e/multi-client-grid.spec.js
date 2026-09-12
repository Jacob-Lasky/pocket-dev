import { test, expect, activeSessionId, gotoTest, waitForConnection } from './fixtures.js';
import path from 'node:path';

const grid = page => page.evaluate(() => ({ cols: window.term.cols, rows: window.term.rows }));
const sharedGrid = (page, session) => page.evaluate(async id => {
  const sessions = await (await fetch('/sessions')).json();
  const match = sessions.find(item => item.id === id);
  return match ? { cols: match.cols, rows: match.rows } : null;
}, session);
const copyText = page => page.evaluate(async () => {
  const { renderTerminalText } = await import('/js/view.js');
  return renderTerminalText(window.term, { viewportOnly: true });
});

const sendFixtureLine = (page, session, text) => page.evaluate(async ({ session, text }) => {
  const response = await fetch('/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, text }),
  });
  return { ok: response.ok, status: response.status };
}, { session, text });

const stampGrid = (page, value) => page.evaluate(({ cols, rows }) => {
  const proof = document.createElement('div');
  proof.textContent = `shared grid ${cols} x ${rows}`;
  proof.style.cssText = [
    'position:fixed', 'top:36px', 'right:12px', 'z-index:9999',
    'padding:6px 10px', 'border:1px solid #3fb950', 'border-radius:6px',
    'background:#0d1117', 'color:#56d364', 'font:13px monospace',
  ].join(';');
  document.body.appendChild(proof);
}, value);

test('invalid grids fail closed and a failed operation does not poison the queue', async ({
  pdServerQueryApp,
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.pdTestSocket = this;
      }
    };
  });
  await gotoTest(page, pdServerQueryApp);
  await waitForConnection(page);
  const fitted = await grid(page);

  await page.evaluate(invalidGrids => {
    for (const dimensions of invalidGrids) {
      window.pdTestSocket.onmessage({
        data: JSON.stringify({ type: 'grid', ...dimensions }),
      });
    }
  }, [
    { cols: null, rows: null },
    { cols: 0, rows: 0 },
    { cols: 1.5, rows: 1.5 },
    { cols: 1001, rows: 1001 },
  ]);
  await expect.poll(() => grid(page)).toEqual(fitted);

  // A terminal operation that throws must not poison the promise chain. The
  // marker arriving afterwards is rendered only if the next queued write runs.
  await page.evaluate(async ({ cols, rows }) => {
    const resize = window.term.resize;
    const consoleError = console.error;
    window.term.resize = () => { throw new Error('intentional grid failure'); };
    console.error = () => {};
    window.pdTestSocket.onmessage({
      data: JSON.stringify({ type: 'grid', cols: cols + 1, rows }),
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    window.term.resize = resize;
    console.error = consoleError;
  }, fitted);
  await page.locator('#cmd-input').fill('marker');
  await page.click('#send-btn');
  await expect(page.locator('#terminal-stack')).toContainText('MARKER-ACK-REPLIES-0');
});

test('long old-grid chunks finish before resize, repaint, and reconnect', async ({
  pdServerLiveGrid,
  browser,
  browserName,
}) => {
  test.setTimeout(120000);
  const phone = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const phonePage = await phone.newPage();
  await phonePage.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__testSockets = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__testSockets.push(this);
      }
    };
  });
  await gotoTest(phonePage, pdServerLiveGrid);
  await waitForConnection(phonePage, 15000);
  const phoneFit = await grid(phonePage);
  const session = await activeSessionId(phonePage);

  // Hold the completion callback for the first parsed old-grid chunk. Grid,
  // repaint, and later output must remain queued behind it.
  await phonePage.evaluate(() => {
    const nativeWrite = window.term.write.bind(window.term);
    window.__oldGridGate = { held: false, release: null };
    window.term.write = (data, callback) => nativeWrite(data, () => {
      if (!window.__oldGridGate.held && data.includes('OLD-STREAM-BEGIN')) {
        window.__oldGridGate.held = true;
        window.__oldGridGate.release = () => {
          window.term.write = nativeWrite;
          callback?.();
        };
        return;
      }
      callback?.();
    });
  });
  expect(await sendFixtureLine(phonePage, session, 'stream')).toEqual({ ok: true, status: 200 });
  await expect.poll(() => phonePage.evaluate(() => window.__oldGridGate.held)).toBe(true);

  const desktop = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const desktopPage = await desktop.newPage();
  await gotoTest(desktopPage, pdServerLiveGrid);
  await waitForConnection(desktopPage, 15000);
  const desktopFit = await grid(desktopPage);

  expect(desktopFit.cols).toBeGreaterThan(phoneFit.cols);
  await expect.poll(() => sharedGrid(phonePage, session)).toEqual(desktopFit);
  expect(await grid(phonePage)).toEqual(phoneFit);
  expect(await copyText(phonePage)).not.toContain('NEW GRID FRAME');

  await phonePage.evaluate(() => window.__oldGridGate.release());
  await expect.poll(async () => [await grid(phonePage), await grid(desktopPage)])
    .toEqual([desktopFit, desktopFit]);
  await expect.poll(() => copyText(phonePage), { timeout: 45000 }).toContain('NEW GRID FRAME');
  const expectedRows = [
    'NEW GRID FRAME',
    `shared grid ${desktopFit.cols} x ${desktopFit.rows}`,
    'the newest response owns this whole screen',
    'no rows from the previous response remain',
  ];
  expect((await copyText(phonePage)).split('\n').filter(Boolean)).toEqual(expectedRows);
  expect((await copyText(desktopPage)).split('\n').filter(Boolean)).toEqual(expectedRows);

  const socketsBefore = await phonePage.evaluate(() => window.__testSockets.length);
  await phonePage.evaluate(() => window.__testSockets.at(-1).close());
  await expect.poll(() => phonePage.evaluate(() => window.__testSockets.length), { timeout: 15000 })
    .toBeGreaterThan(socketsBefore);
  await waitForConnection(phonePage, 15000);
  await expect.poll(() => copyText(phonePage), { timeout: 45000 })
    .toContain('NEW GRID FRAME');
  expect((await copyText(phonePage)).split('\n').filter(Boolean)).toEqual(expectedRows);

  await stampGrid(phonePage, desktopFit);
  await stampGrid(desktopPage, desktopFit);

  await phonePage.screenshot({
    path: path.resolve(`test-artifacts/multi-client-grid-phone-${browserName}.png`),
  });
  await desktopPage.screenshot({
    path: path.resolve(`test-artifacts/multi-client-grid-desktop-${browserName}.png`),
  });
  await phone.close();
  await desktop.close();
});
