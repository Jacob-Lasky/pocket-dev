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
const expectedGridRows = ({ cols, rows }) => [
  'NEW GRID FRAME',
  `shared grid ${cols} x ${rows}`,
  'the newest response owns this whole screen',
  'no rows from the previous response remain',
];
const coherentGridSnapshot = async (phonePage, desktopPage, session) => {
  const shared = await sharedGrid(phonePage, session);
  const phoneGrid = await grid(phonePage);
  const desktopGrid = await grid(desktopPage);
  const phoneRows = (await copyText(phonePage)).split('\n').filter(Boolean);
  const desktopRows = (await copyText(desktopPage)).split('\n').filter(Boolean);
  const expectedRows = expectedGridRows(shared);
  return {
    shared,
    phoneGrid,
    desktopGrid,
    phoneRows,
    desktopRows,
    coherent: JSON.stringify(phoneGrid) === JSON.stringify(shared)
      && JSON.stringify(desktopGrid) === JSON.stringify(shared)
      && JSON.stringify(phoneRows) === JSON.stringify(expectedRows)
      && JSON.stringify(desktopRows) === JSON.stringify(expectedRows),
  };
};

const sendFixtureLine = (page, session, text) => page.evaluate(async ({ session, text }) => {
  const response = await fetch('/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, text }),
  });
  return { ok: response.ok, status: response.status };
}, { session, text });
const sentFrameTypes = (page, session) => page.evaluate(id => {
  const sockets = window.__testSockets.filter(socket => new URL(socket.url).searchParams.get('session') === id);
  return sockets.at(-1)?.testSentFrames || [];
}, session);
const expectClaimBeforeResize = (frames, { last = false } = {}) => {
  const find = last ? 'lastIndexOf' : 'indexOf';
  const claimIndex = frames[find]('claim-grid');
  const resizeIndex = frames[find]('resize');
  expect(claimIndex).toBeGreaterThanOrEqual(0);
  expect(resizeIndex).toBeGreaterThanOrEqual(0);
  expect(claimIndex).toBeLessThan(resizeIndex);
};
const closeSessionSocket = (page, session) => page.evaluate(id => {
  const sockets = window.__testSockets.filter(socket => new URL(socket.url).searchParams.get('session') === id);
  sockets.at(-1).close();
}, session);

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
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    const pendingTimers = new Map();
    let nextTimerId = -1;
    window.__timerGate = {
      held: false,
      capture: false,
      release() {
        this.held = false;
        const callbacks = [...pendingTimers.values()];
        pendingTimers.clear();
        for (const callback of callbacks) nativeSetTimeout(callback, 0);
      },
    };
    window.setTimeout = (callback, delay, ...args) => {
      if (window.__timerGate.held && window.__timerGate.capture
          && (delay === undefined || delay === 0)) {
        const id = nextTimerId--;
        pendingTimers.set(id, () => callback(...args));
        return id;
      }
      return nativeSetTimeout(callback, delay, ...args);
    };
    window.clearTimeout = id => {
      if (!pendingTimers.delete(id)) nativeClearTimeout(id);
    };
    window.__testSockets = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.testSentFrames = [];
        window.__testSockets.push(this);
      }
      send(data) {
        try { this.testSentFrames.push(JSON.parse(data).type || 'raw'); }
        catch { this.testSentFrames.push('raw'); }
        return super.send(data);
      }
    };
  });
  await gotoTest(phonePage, pdServerLiveGrid);
  await waitForConnection(phonePage, 15000);
  const session = await activeSessionId(phonePage);
  expect(await sendFixtureLine(phonePage, session, 'ready')).toEqual({ ok: true, status: 200 });
  await expect.poll(() => copyText(phonePage), { timeout: 15000 }).toContain('INITIAL GRID FRAME');
  const phoneFit = await grid(phonePage);
  const phoneInitialMessages = await sentFrameTypes(phonePage, session);
  expectClaimBeforeResize(phoneInitialMessages);

  // Keep a second local session available so the stale-claim witness can
  // switch away from the blocked session without destroying it.
  await phonePage.evaluate(async () => {
    await window.tmuxNew();
    window.tmuxLast();
  });
  await expect.poll(() => activeSessionId(phonePage)).toBe(session);

  await phonePage.evaluate(id => {
    window.__testOutputFrames = 0;
    const socket = window.__testSockets.find(item => new URL(item.url).searchParams.get('session') === id);
    socket.addEventListener('message', event => {
      try {
        if (JSON.parse(event.data)?.type === 'output') window.__testOutputFrames += 1;
      } catch { /* Ignore non-JSON compatibility frames. */ }
    });
  }, session);

  // Hold xterm's zero-delay parser timer, which models the timer throttling a
  // still-connected background page receives. Grid, repaint, and later output
  // must preserve their order without leaving each WebSocket frame outside
  // xterm until a separate browser timer has fired.
  await phonePage.evaluate(() => {
    const nativeWrite = window.term.write.bind(window.term);
    window.__timerGate.held = true;
    window.__oldGridGate = { writeCalls: 0 };
    window.term.write = (data, callback) => {
      window.__oldGridGate.writeCalls += 1;
      window.__timerGate.capture = true;
      try { nativeWrite(data, callback); }
      finally { window.__timerGate.capture = false; }
    };
  });
  expect(await sendFixtureLine(phonePage, session, 'stream')).toEqual({ ok: true, status: 200 });
  await expect.poll(() => phonePage.evaluate(() => window.__testOutputFrames)).toBeGreaterThan(250);

  // A hidden browser throttles the timer xterm uses to finish a write. All
  // already-arrived output must still enter xterm's own ordered write buffer,
  // rather than waiting one browser timer per WebSocket frame behind this
  // deliberately held parser timer.
  await expect.poll(() => phonePage.evaluate(() => window.__oldGridGate.writeCalls))
    .toBeGreaterThan(250);

  const desktop = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const desktopPage = await desktop.newPage();
  await desktopPage.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__testSockets = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.testSentFrames = [];
        window.__testSockets.push(this);
      }
      send(data) {
        try { this.testSentFrames.push(JSON.parse(data).type || 'raw'); }
        catch { this.testSentFrames.push('raw'); }
        return super.send(data);
      }
    };
  });
  await gotoTest(desktopPage, pdServerLiveGrid);
  await waitForConnection(desktopPage, 15000);
  const desktopFit = await grid(desktopPage);
  const desktopInitialMessages = await sentFrameTypes(desktopPage, session);
  expectClaimBeforeResize(desktopInitialMessages);

  expect(desktopFit.cols).toBeGreaterThan(phoneFit.cols);
  await expect.poll(() => sharedGrid(phonePage, session)).toEqual(desktopFit);
  expect(await grid(phonePage)).toEqual(phoneFit);
  expect(await copyText(phonePage)).not.toContain('NEW GRID FRAME');

  // Queue a phone claim behind its held xterm callbacks, then switch that
  // focused browser to its other session before the queue drains. The stale
  // operation must recheck the active session at execution time instead of
  // stealing authority back from the desktop.
  await phonePage.evaluate(() => {
    window.__nativeHasFocus = document.hasFocus.bind(document);
    document.hasFocus = () => true;
    window.dispatchEvent(new Event('focus'));
    window.tmuxLast();
  });
  await expect.poll(() => activeSessionId(phonePage)).not.toBe(session);
  await desktopPage.evaluate(() => {
    window.__nativeHasFocus = document.hasFocus.bind(document);
    document.hasFocus = () => true;
    window.dispatchEvent(new Event('focus'));
  });
  await phonePage.evaluate(() => window.__timerGate.release());
  await expect.poll(() => sharedGrid(phonePage, session)).toEqual(desktopFit);

  // Returning to the blocked session is now a fresh foreground claim. Both
  // parsers must converge on that phone grid before the desktop takes it back.
  await desktopPage.evaluate(() => { document.hasFocus = () => false; });
  await phonePage.evaluate(() => {
    document.hasFocus = () => true;
    window.tmuxLast();
  });
  await expect.poll(() => activeSessionId(phonePage)).toBe(session);
  await expect.poll(() => sharedGrid(phonePage, session)).toEqual(phoneFit);
  await expect.poll(async () => (await coherentGridSnapshot(phonePage, desktopPage, session)).coherent)
    .toBe(true);
  const converged = await coherentGridSnapshot(phonePage, desktopPage, session);
  expect(converged.coherent).toBe(true);
  const phoneFocusMessages = await sentFrameTypes(phonePage, session);
  expectClaimBeforeResize(phoneFocusMessages, { last: true });

  // A foreground transition explicitly transfers resize authority. The
  // desktop must claim before its fitted dimensions are sent, and both parsers
  // must immediately converge on the resulting authoritative repaint.
  await phonePage.evaluate(() => { document.hasFocus = () => false; });
  await desktopPage.evaluate(() => {
    document.hasFocus = () => true;
    window.dispatchEvent(new Event('focus'));
  });
  await expect.poll(() => sharedGrid(phonePage, session)).toEqual(desktopFit);
  await expect.poll(async () => (await coherentGridSnapshot(phonePage, desktopPage, session)).coherent)
    .toBe(true);
  const desktopFocusMessages = await sentFrameTypes(desktopPage, session);
  expectClaimBeforeResize(desktopFocusMessages, { last: true });

  // Focus loss is a separate cancellation axis from switching sessions. Hold
  // one more write callback, queue a phone claim while A stays active, then
  // blur only the phone before releasing it. The desktop must remain owner.
  const writesBeforeFocusLoss = await phonePage.evaluate(() => window.__oldGridGate.writeCalls);
  await phonePage.evaluate(() => {
    document.hasFocus = () => true;
    window.__timerGate.held = true;
  });
  expect(await sendFixtureLine(phonePage, session, 'ready')).toEqual({ ok: true, status: 200 });
  await expect.poll(() => phonePage.evaluate(() => window.__oldGridGate.writeCalls))
    .toBeGreaterThan(writesBeforeFocusLoss);
  await phonePage.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.hasFocus = () => false;
  });
  await desktopPage.evaluate(() => window.dispatchEvent(new Event('focus')));
  await phonePage.evaluate(() => window.__timerGate.release());
  await expect.poll(() => sharedGrid(phonePage, session)).toEqual(desktopFit);

  // Focus is local to a device, so both pages may report focused. A fit from
  // the foreground phone must claim before resizing rather than diverging
  // locally when the desktop currently owns the server grid.
  await phonePage.evaluate(() => { document.hasFocus = () => true; });
  await phonePage.setViewportSize({ width: 500, height: 700 });
  await expect.poll(async () => {
    const local = await grid(phonePage);
    const shared = await sharedGrid(phonePage, session);
    return JSON.stringify(local) === JSON.stringify(shared)
      && JSON.stringify(shared) !== JSON.stringify(desktopFit);
  }).toBe(true);
  await expect.poll(async () => (await coherentGridSnapshot(phonePage, desktopPage, session)).coherent)
    .toBe(true);
  const phoneResizedFit = await grid(phonePage);
  expect(phoneResizedFit).not.toEqual(desktopFit);
  await phonePage.setViewportSize({ width: 390, height: 780 });
  await expect.poll(() => sharedGrid(phonePage, session)).toEqual(phoneFit);

  // Layout observers still fire in a visible but unfocused desktop window.
  // A passive browser must not fit only its local xterm while the server quite
  // correctly rejects its resize, or the next shared TUI chunk is parsed on a
  // different grid. Changing the passive viewport must leave both grids alone.
  await phonePage.evaluate(() => { document.hasFocus = () => false; });
  await desktopPage.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => sharedGrid(phonePage, session)).toEqual(desktopFit);
  await phonePage.setViewportSize({ width: 500, height: 700 });
  await phonePage.waitForTimeout(300);
  expect(await grid(phonePage)).toEqual(desktopFit);
  expect(await sharedGrid(phonePage, session)).toEqual(desktopFit);
  await phonePage.setViewportSize({ width: 390, height: 780 });
  await phonePage.waitForTimeout(300);

  const socketsBefore = await phonePage.evaluate(() => window.__testSockets.length);
  await closeSessionSocket(phonePage, session);
  await expect.poll(() => phonePage.evaluate(() => window.__testSockets.length), { timeout: 15000 })
    .toBeGreaterThan(socketsBefore);
  await waitForConnection(phonePage, 15000);
  await expect.poll(() => sharedGrid(phonePage, session)).toEqual(desktopFit);
  await expect.poll(async () => (await coherentGridSnapshot(phonePage, desktopPage, session)).coherent,
    { timeout: 45000 }).toBe(true);
  const reconnected = await coherentGridSnapshot(phonePage, desktopPage, session);
  expect(reconnected.coherent).toBe(true);
  expect(reconnected.shared).toEqual(desktopFit);
  const phoneReconnectMessages = await sentFrameTypes(phonePage, session);
  expect(phoneReconnectMessages).not.toContain('claim-grid');
  await phonePage.evaluate(() => { document.hasFocus = window.__nativeHasFocus; });
  await desktopPage.evaluate(() => { document.hasFocus = window.__nativeHasFocus; });

  await stampGrid(phonePage, reconnected.shared);
  await stampGrid(desktopPage, reconnected.shared);

  await phonePage.screenshot({
    path: path.resolve(`test-artifacts/multi-client-grid-phone-${browserName}.png`),
  });
  await desktopPage.screenshot({
    path: path.resolve(`test-artifacts/multi-client-grid-desktop-${browserName}.png`),
  });
  await phone.close();
  await desktop.close();
});

test('reconnect parses buffered history as one replay before the authoritative repaint', async ({
  pdServerLiveGrid,
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__testSockets = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.testFrames = [];
        this.addEventListener('message', event => {
          try { this.testFrames.push(JSON.parse(event.data).type); }
          catch { this.testFrames.push('raw'); }
        });
        window.__testSockets.push(this);
      }
    };
  });
  await gotoTest(page, pdServerLiveGrid);
  await waitForConnection(page, 15000);
  const session = await activeSessionId(page);

  await page.evaluate(() => window.__testSockets.at(-1).close());
  expect(await sendFixtureLine(page, session, 'stream')).toEqual({ ok: true, status: 200 });

  await expect.poll(() => page.evaluate(() => window.__testSockets.length), { timeout: 15000 })
    .toBeGreaterThan(1);
  await waitForConnection(page, 15000);
  await expect.poll(() => copyText(page), { timeout: 15000 }).toContain('OLD GRID FRAME');

  const reconnectFrames = await page.evaluate(() => window.__testSockets.at(-1).testFrames);
  expect(reconnectFrames.filter(type => type === 'replay')).toHaveLength(1);
  expect(reconnectFrames.filter(type => type === 'output')).toHaveLength(1);
  expect((await copyText(page)).split('\n').filter(Boolean)).toEqual([
    'OLD GRID FRAME',
    expect.stringMatching(/^shared grid \d+ x \d+$/),
    'the newest response owns this whole screen',
    'no rows from the previous response remain',
  ]);
});
