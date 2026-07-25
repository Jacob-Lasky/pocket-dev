// Regression guard for the bleed bug that motivated the per-session-tabs
// rewrite: switching between sessions in the browser must show ONLY the
// active session's scrollback, never the other session's.
//
// The old single-pty / single-xterm architecture mashed every tmux window's
// output into one xterm.js main buffer; scrolling back showed all windows'
// history mixed together. This spec sends a unique marker into each session
// and verifies the visible terminal only contains that session's marker.

import {
  test, expect, gotoTest, waitForConnection, sendAndWaitForEcho,
  newSession, switchToRow, killActiveSession,
} from './fixtures.js';

// Switching sessions is the session list's job now: the cycle row it replaced
// is gone. The guarantee under test is unchanged (each session keeps its own
// scrollback); only the way you get between them moved.

async function visibleText(page) {
  return page.evaluate(() => document.querySelector('#terminal-container').innerText.replace(/\s+/g, ''));
}

async function sessionCount(page) {
  return page.evaluate(async () => {
    const r = await fetch('/sessions');
    const list = await r.json();
    return list.length;
  });
}

test('+New / Next / Last switches between independent per-session scrollback', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);

  // Session 1: type marker A
  await sendAndWaitForEcho(page, 'marker-alpha-XYZ');

  // Create session 2
  await newSession(page);
  await waitForConnection(page);
  await expect.poll(() => sessionCount(page)).toBe(2);

  // Session 2: marker A must NOT be visible (no bleed), marker B will land here
  expect(await visibleText(page)).not.toContain('marker-alpha-XYZ');
  await sendAndWaitForEcho(page, 'marker-beta-QED');

  // After Beta: session 2 shows B but not A
  let txt = await visibleText(page);
  expect(txt).toContain('marker-beta-QED');
  expect(txt).not.toContain('marker-alpha-XYZ');

  // Back to session 1 — should show A, not B
  await switchToRow(page, 0);
  await expect.poll(() => visibleText(page), { timeout: 3000 }).toContain('marker-alpha-XYZ');
  txt = await visibleText(page);
  expect(txt).not.toContain('marker-beta-QED');

  // Forward to session 2 — should show B, not A
  await switchToRow(page, 1);
  await expect.poll(() => visibleText(page), { timeout: 3000 }).toContain('marker-beta-QED');
  txt = await visibleText(page);
  expect(txt).not.toContain('marker-alpha-XYZ');
});

test('Kill removes current session and switches to next (never zero sessions)', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);

  await newSession(page);
  await waitForConnection(page);
  await expect.poll(() => sessionCount(page)).toBe(2);

  await killActiveSession(page);
  // One session killed → exactly one remains
  await expect.poll(() => sessionCount(page)).toBe(1);

  // Killing the last session should respawn so we never have zero
  await killActiveSession(page);
  await expect.poll(() => sessionCount(page), { timeout: 5000 }).toBe(1);
  // And the dot should reconnect on the replacement session
  await waitForConnection(page);
});
