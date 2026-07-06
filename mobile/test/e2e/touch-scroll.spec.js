// Mobile touch-scroll for Live mode — the regression guard for scroll.js's
// DOM wiring in index.html.
//
// WHY this can't ride on the `cat` fixture: a plain shell has no mouse tracking,
// so it only exercises the LOCAL-scroll branch. The wheel-FORWARDING branch (the
// whole point — how a full-screen coder like Claude gets scrolled on mobile)
// only fires when the inner app enabled mouse tracking, so it needs the
// mouse-app fixture. Firefox can't emulate touch (no hasTouch), so this is
// chromium-only; the pure step/sequence math is covered cross-env in
// test/unit/scroll.test.js.

import { test, expect, gotoTest, waitForConnection } from './fixtures.js';

test.skip(({ browserName }) => browserName !== 'chromium', 'touch emulation is chromium-only');

// Install a spy on WebSocket.send BEFORE any session connects, recording every
// string frame the client sends to the pty. Must run as an init script so it's
// in place before bootstrap opens the socket.
async function spySends(page) {
  await page.addInitScript(() => {
    window.__sent = [];
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string') window.__sent.push(data);
      return orig.call(this, data);
    };
  });
}

// Synthesize a one-finger vertical drag on the active terminal pane's screen
// element, in `steps` touchmove increments of `dyPerStep` px (negative = up).
async function dragActivePane(page, { dyPerStep, steps }) {
  await page.evaluate(({ dyPerStep, steps }) => {
    const el = document.querySelector('.terminal-pane.active .xterm-screen')
            || document.querySelector('.terminal-pane.active');
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    let y = r.top + r.height / 2;
    const mk = (type, clientY) => {
      const t = new Touch({ identifier: 1, target: el, clientX: x, clientY });
      return new TouchEvent(type, {
        bubbles: true, cancelable: true,
        touches: type === 'touchend' ? [] : [t],
        targetTouches: type === 'touchend' ? [] : [t],
        changedTouches: [t],
      });
    };
    el.dispatchEvent(mk('touchstart', y));
    for (let i = 0; i < steps; i++) { y += dyPerStep; el.dispatchEvent(mk('touchmove', y)); }
    el.dispatchEvent(mk('touchend', y));
  }, { dyPerStep, steps });
}

test('Live: touch-drag on a mouse-tracking session forwards wheel events to the pty', async ({ pdServerMouseApp, browser }) => {
  const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 780 } });
  const page = await ctx.newPage();
  await spySends(page);
  await gotoTest(page, pdServerMouseApp);
  await waitForConnection(page);

  // Wait until the fixture's mouse-enable bytes have been received + scanned.
  await expect
    .poll(() => page.evaluate(() => document.querySelector('#terminal-container').innerText))
    .toContain('MOUSE-APP-READY');

  // Drag DOWN (finger moves down the screen) → reveal older content → wheel UP (SGR btn 64).
  await dragActivePane(page, { dyPerStep: 20, steps: 8 });
  await expect
    .poll(() => page.evaluate(() => window.__sent.some(s => /\x1b\[<64;/.test(s))))
    .toBe(true);

  // Drag UP → wheel DOWN (SGR btn 65).
  await dragActivePane(page, { dyPerStep: -20, steps: 8 });
  await expect
    .poll(() => page.evaluate(() => window.__sent.some(s => /\x1b\[<65;/.test(s))))
    .toBe(true);

  await ctx.close();
});

test('Live: touch-drag on a plain shell scrolls xterm locally, sends NO wheel bytes', async ({ pdServer, browser }) => {
  const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 780 } });
  const page = await ctx.newPage();
  await spySends(page);
  await gotoTest(page, pdServer);
  await waitForConnection(page);

  // Fill the buffer past one screen so there's real xterm scrollback to move.
  await page.evaluate(() => {
    for (let i = 0; i < 120; i++) window.term.write(`line-${i}\r\n`);
  });
  await expect.poll(() => page.evaluate(() => window.term.buffer.active.baseY)).toBeGreaterThan(0);

  const before = await page.evaluate(() => window.term.buffer.active.viewportY);
  await dragActivePane(page, { dyPerStep: 24, steps: 8 }); // drag down → scroll up locally
  await expect
    .poll(() => page.evaluate(() => window.term.buffer.active.viewportY))
    .toBeLessThan(before);

  // No mouse tracking → nothing wheel-shaped should have gone to the pty.
  const wheelSent = await page.evaluate(() => window.__sent.some(s => /\x1b\[<6[45];/.test(s)));
  expect(wheelSent).toBe(false);

  await ctx.close();
});
