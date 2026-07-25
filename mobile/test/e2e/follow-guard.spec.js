// Regression guard for the follow guard in index.html's installFollowGuard.
//
// The bug (#30): xterm infers "the user scrolled up" from scrollTop deltas it
// did not itself produce, so a scroll event the BROWSER generated latches
// isUserScrolling and the pane stops following new output forever. It was
// found on webkit after a node-only restart, where a viewport refresh shrank
// the scroll area to exactly clientHeight and the browser clamped scrollTop to
// 0 on its own.
//
// These tests do NOT wait for a browser to happen to clamp. They provoke the
// clamp, which is both deterministic and engine-independent, so the guard is
// exercised on chromium and firefox too rather than only on the one engine
// that produced it. They provoke it by shrinking the scroll area and letting
// the browser relocate scrollTop itself, which is the real mechanism, rather
// than by assigning scrollTop, which would leave the geometry intact.
//
// The second and third tests are the counterweight. A guard that pins the pane
// to the bottom unconditionally would pass the first test and destroy
// scrollback reading, so real user scrolling is asserted to still win.
//
// Engine asymmetry, measured by reverting the fix and re-running: the clamp
// test latches isUserScrolling on FIREFOX (offset went to 76 and stayed) and
// passes on CHROMIUM, which absorbs the clamp. So chromium runs it as a
// no-regression check, not as a repro. Do not read a green chromium run as
// proof the guard works; firefox and webkit are the engines that prove it.

import { test, expect, gotoTest, waitForConnection } from './fixtures.js';

const LINES = 120;

// Fill the pane past one screen so there is real xterm scrollback to move.
async function fillScrollback(page) {
  await page.evaluate((n) => {
    for (let i = 0; i < n; i++) window.term.write(`line-${i}\r\n`);
  }, LINES);
  await expect.poll(() => page.evaluate(() => window.term.buffer.active.baseY)).toBeGreaterThan(0);
}

async function offsetFromBottom(page) {
  return page.evaluate(() => {
    const b = window.term.buffer.active;
    return b.baseY - b.viewportY;
  });
}

// Reproduce the clamp the way the browser actually produces it: collapse the
// scroll area under the pane so the current scrollTop no longer fits, and let
// the browser relocate it on its own. Setting scrollTop directly would be a
// weaker imitation, because it leaves the geometry intact and the geometry is
// the whole signal the guard reads.
async function collapseScrollArea(page) {
  await page.evaluate(() => {
    const vp = document.querySelector('.terminal-pane.active .xterm-viewport')
            || document.querySelector('.xterm-viewport');
    const area = vp.querySelector('.xterm-scroll-area');
    area.style.height = vp.clientHeight + 'px';
    // Read back so the layout (and the browser's own clamp) is flushed before
    // the assertion polls.
    return vp.scrollTop;
  });
}

async function wheelOverPane(page, deltaY) {
  const box = await page.locator('.terminal-pane.active .xterm-screen').first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

test('a browser-generated scroll clamp does not unpin the pane', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await fillScrollback(page);
  expect(await offsetFromBottom(page)).toBe(0);

  await collapseScrollArea(page);

  // Without the guard this settles at baseY - 0, and stays there: xterm has
  // latched isUserScrolling and nothing clears it.
  await expect.poll(() => offsetFromBottom(page), { timeout: 5000 }).toBe(0);

  // And the latch itself must be gone, not merely papered over by one
  // reposition, or the very next line of output desyncs the pane again.
  const latched = await page.evaluate(() =>
    !!(window.term._core && window.term._core._bufferService
       && window.term._core._bufferService.isUserScrolling));
  expect(latched).toBe(false);

  // New output still follows.
  await page.evaluate(() => window.term.write('after-clamp\r\n'));
  await expect.poll(() => offsetFromBottom(page), { timeout: 5000 }).toBe(0);
});

test('a real wheel scroll up still wins, and new output does not yank the pane back', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await fillScrollback(page);

  await wheelOverPane(page, -400);
  await expect.poll(() => offsetFromBottom(page), { timeout: 5000 }).toBeGreaterThan(0);
  const parkedAt = await offsetFromBottom(page);

  // Output arriving while the user reads scrollback must not drag them to the
  // bottom. Each write pushes a line into scrollback, so the offset GROWS by
  // the number of lines written; what must not happen is a collapse to 0.
  await page.evaluate(() => {
    for (let i = 0; i < 5; i++) window.term.write(`while-reading-${i}\r\n`);
  });
  await expect.poll(() => offsetFromBottom(page), { timeout: 5000 }).toBeGreaterThanOrEqual(parkedAt);
});

test('scrolling up reveals the scroll-to-bottom button, and it re-arms following', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await fillScrollback(page);
  await expect(page.locator('#scroll-bottom')).toBeHidden();

  await wheelOverPane(page, -400);
  await expect.poll(() => offsetFromBottom(page), { timeout: 5000 }).toBeGreaterThan(0);

  // Asserted explicitly because it used to be false. term.onScroll does not
  // fire for a viewport-sourced scroll (xterm suppresses it), and that was the
  // app's only trigger for updateScrollBtn, so the button stayed hidden until
  // fresh output happened to arrive. Scrolling up on a quiet terminal left no
  // way back down but scrolling by hand.
  await expect(page.locator('#scroll-bottom')).toBeVisible();

  await page.click('#scroll-bottom');
  await expect.poll(() => offsetFromBottom(page), { timeout: 5000 }).toBe(0);

  // The button moving the viewport is not enough on its own. If it did not also
  // clear the "user scrolled away" state, the pane would sit at the bottom
  // while still refusing to follow, and the next line of output would strand it
  // again.
  await page.evaluate(() => window.term.write('after-button\r\n'));
  await expect.poll(() => offsetFromBottom(page), { timeout: 5000 }).toBe(0);
});

test('scrolling back down re-arms following', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await fillScrollback(page);

  await wheelOverPane(page, -400);
  await expect.poll(() => offsetFromBottom(page), { timeout: 5000 }).toBeGreaterThan(0);

  await wheelOverPane(page, 2000);
  await expect.poll(() => offsetFromBottom(page), { timeout: 5000 }).toBe(0);

  // Back at the bottom by the user's own hand, so the pane follows again.
  await page.evaluate(() => window.term.write('followed-again\r\n'));
  await expect.poll(() => offsetFromBottom(page), { timeout: 5000 }).toBe(0);
});
