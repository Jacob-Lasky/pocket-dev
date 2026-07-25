// Regression guard for session survival across a server restart.
//
// Before this, a container restart dropped every tab: the roster lived only in
// the server process's memory, so the browser's reconnect attempts got a 4404
// and sat there as dead panes until the user reloaded and found one blank
// session. Now the roster is on disk and restored before the listener opens.
//
// Two distinct recoveries, both covered here:
//   - container restart  (restart({ killTmux: true }))  tmux is gone; sessions
//     respawn from the roster under the same ids.
//   - node restart       (restart())                    tmux survived; the
//     `new-session -A` spawn reattaches to the live sessions, scrollback intact.
//
// Note the fixture sets SHELL_CMD=cat, which disables the Claude conversation
// resume path (see RESUME_ENABLED in server.js). What is proven here is the
// roster half; the resume half is proven in test/server/sessionLauncher.test.js
// and test/server/sessionsRestore.test.js, since `cat` has no conversation.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test, expect, gotoTest, waitForConnection, sendAndWaitForEcho } from './fixtures.js';

async function sessionIds(page) {
  return page.evaluate(async () => {
    const r = await fetch('/sessions');
    return (await r.json()).map(s => s.id);
  });
}

async function visibleText(page) {
  return page.evaluate(() => document.querySelector('#terminal-container').innerText.replace(/\s+/g, ''));
}

async function paneCount(page) {
  return page.evaluate(() => document.querySelectorAll('.terminal-pane').length);
}

// Count the marker on the terminal SCREEN, read bottom-anchored out of the
// buffer rather than out of the rendered DOM.
//
// Counting rendered text was wrong twice over. The rendered text depends on
// where the pane is scrolled, which is the very thing the restart bug broke; and
// counting across the whole buffer depends on the ROW COUNT, because shrinking
// a terminal reflows lines that no longer fit into scrollback and growing it
// pulls them back. `fitAndResize()` runs on every reconnect, so the row count is
// not stable across a restart and no whole-buffer count is comparable with one
// taken before it. Measured in CI: whole-buffer went 2 -> 4 -> 6 while this
// bottom-anchored screen count stayed 2 through a restart and two resizes on all
// three browsers. DO NOT change this back to reading innerText.
async function markerCount(page) {
  return page.evaluate((m) => {
    const t = window.term;
    if (!t || !t.buffer) return -1;
    const buf = t.buffer.normal;
    let n = 0;
    for (let i = buf.baseY; i < buf.baseY + t.rows; i++) {
      const line = buf.getLine(i);
      if (line && line.translateToString(true).includes(m)) n++;
    }
    return n;
  }, 'survives-node-restart-ECHO');
}

// Is the pane following the bottom, or stuck showing older rows?
async function scrollOffsetFromBottom(page) {
  return page.evaluate(() => {
    const t = window.term;
    if (!t || !t.buffer) return -1;
    return t.buffer.normal.baseY - t.buffer.normal.viewportY;
  });
}

async function newSession(page) {
  await page.click('#tmux-btn');
  await page.click('#btn-row-tmux >> text=+New');
}

test('a container restart brings every session back under its original id', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await newSession(page);
  await waitForConnection(page);
  await expect.poll(() => sessionIds(page)).toHaveLength(2);
  const before = await sessionIds(page);

  await pdServer.restart({ killTmux: true });

  // The page was never reloaded: its own reconnect loop has to find the
  // restored sessions on its own.
  await expect.poll(() => sessionIds(page), { timeout: 20000 }).toEqual(before);
  await waitForConnection(page);
  expect(await paneCount(page)).toBe(2);

  // And the respawned session is a live terminal, not just an entry in a list.
  await sendAndWaitForEcho(page, 'after-restart-ECHO');
});

test('a fresh page load after a restart finds the restored sessions, not a blank one', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await newSession(page);
  await waitForConnection(page);
  await newSession(page);
  await waitForConnection(page);
  await expect.poll(() => sessionIds(page)).toHaveLength(3);
  const before = await sessionIds(page);

  await pdServer.restart({ killTmux: true });

  await page.reload();
  await waitForConnection(page);
  await expect.poll(() => sessionIds(page), { timeout: 20000 }).toEqual(before);
  expect(await paneCount(page)).toBe(3);
});

test('+New after a restart does not collide with a restored id', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await newSession(page);
  await waitForConnection(page);
  const before = await sessionIds(page);

  await pdServer.restart({ killTmux: true });
  await expect.poll(() => sessionIds(page), { timeout: 20000 }).toEqual(before);
  await waitForConnection(page);

  await newSession(page);
  await waitForConnection(page);
  const after = await sessionIds(page);
  expect(after).toHaveLength(3);
  expect(new Set(after).size).toBe(3);
});

test('when only the server process restarts, sessions reattach with their scrollback', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await sendAndWaitForEcho(page, 'survives-node-restart-ECHO');
  // With `cat` the marker legitimately appears twice on screen (the tty echoes
  // the input, then cat echoes it back), so what matters is that the count does
  // not GROW across the reconnect.
  const before = await markerCount(page);
  expect(before).toBeGreaterThan(0);

  // tmux is left running, which is what happens when node dies but the
  // container does not: `new-session -A` reattaches instead of respawning, so
  // the session's screen comes back with its contents.
  await pdServer.restart();

  await waitForConnection(page);
  await expect.poll(() => visibleText(page), { timeout: 20000 }).toContain('survives-node-restart-ECHO');

  // The server replays its whole buffer on every attach, so a pane that does
  // not reset on WS open ends up showing the reattached screen stacked on top
  // of what it already had.
  await expect.poll(() => markerCount(page), { timeout: 10000 }).toBe(before);

  // And it has to come back pinned to the BOTTOM. A pane left scrolled up after
  // a reconnect shows a window straddling the pre-restart paint and the
  // replayed one, which is what made this test fail in CI: the content was
  // right, the scroll position was not.
  // Polled, not sampled: the fit on reconnect sends a resize, and tmux's
  // repaint comes back asynchronously, so the pane settles a beat after the
  // socket opens.
  await expect.poll(() => scrollOffsetFromBottom(page), { timeout: 10000 }).toBe(0);
});

test('tabs come back after a hard kill, and the shutdown marker tells the two apart', async ({ pdServer, page }) => {
  // The marker is what stops a crashed session being told "continue please",
  // which would mean redoing whatever killed the container. Here it is checked
  // against real signals rather than a stubbed store.
  const marker = path.join(pdServer.stateDir, 'clean-shutdown');

  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await newSession(page);
  await waitForConnection(page);
  const before = await sessionIds(page);
  expect(before).toHaveLength(2);

  // SIGKILL: the container dying. No handler runs, so no marker is left.
  await pdServer.restart({ killTmux: true, signal: 'SIGKILL' });
  expect(existsSync(marker)).toBe(false);
  await expect.poll(() => sessionIds(page), { timeout: 20000 }).toEqual(before);
  await waitForConnection(page);

  // SIGTERM: a deliberate stop. The marker is written, then consumed by the
  // next boot so it can only ever vouch for that one shutdown.
  await pdServer.restart({ killTmux: true });
  expect(existsSync(marker)).toBe(false);
  await expect.poll(() => sessionIds(page), { timeout: 20000 }).toEqual(before);
  await waitForConnection(page);
  await sendAndWaitForEcho(page, 'alive-after-both-restarts-ECHO');
});

test('a killed session stays killed across a restart', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await newSession(page);
  await waitForConnection(page);
  await expect.poll(() => sessionIds(page)).toHaveLength(2);

  await page.click('#tmux-btn');
  await page.click('#btn-row-tmux >> text=Kill');
  await expect.poll(() => sessionIds(page)).toHaveLength(1);
  const survivor = await sessionIds(page);

  await pdServer.restart({ killTmux: true });

  await expect.poll(() => sessionIds(page), { timeout: 20000 }).toEqual(survivor);
});

test('the client re-adopts the server roster when the state dir is lost', async ({ pdServer, page }) => {
  // A container RECREATE (image update) with no bind mount loses the roster
  // entirely. The tab must not sit on dead panes: it resyncs and lands on a
  // working session instead.
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await newSession(page);
  await waitForConnection(page);
  await expect.poll(() => sessionIds(page)).toHaveLength(2);

  await pdServer.restart({ killTmux: true });
  // Simulate the wipe after the restart so the surviving roster cannot be read
  // by a later boot, then force the client to notice by restarting once more.
  await fs.rm(pdServer.stateDir, { recursive: true, force: true });
  await pdServer.restart({ killTmux: true });

  await expect.poll(() => paneCount(page), { timeout: 25000 }).toBe(1);
  await waitForConnection(page);
  await sendAndWaitForEcho(page, 'recovered-after-wipe-ECHO');
});
