// Clicking a row must actually enter that session, even while other sessions
// are producing output.
//
// The bug (desktop-only in practice): renderSessionList() rebuilt every row
// with slRows.replaceChildren(), and ws.onmessage called it on EVERY frame from
// a non-active session. A DOM click only fires when mousedown and mouseup land
// on the same element, so with a background session streaming, the row you
// pressed was destroyed before you released and no click event was ever
// generated. CSS :hover/:active still lit up whatever was under the cursor, so
// the row looked interactive while doing nothing, and an occasional press that
// happened to fall between rebuilds worked. That is the "responds randomly"
// report.
//
// A touch tap is much shorter than a mouse press and the synthesized click is
// more forgiving about a replaced target, which is why this only bit on
// desktop. These tests therefore press with a REAL duration rather than using
// Playwright's .click(), which is fast enough to usually slip through the gap
// and would have shipped this green.

import { test, expect, gotoTest, waitForConnection, openSessionList, newSession, waitForPanes } from './fixtures.js';

const PRESS_MS = 300;
const CHURN_MS = 25;

// Hammer a background session with input so cat echoes it back, which is what
// drives ws.onmessage -> renderSessionList for a non-active session.
async function startBackgroundOutput(page, id) {
  await page.evaluate(({ id, every }) => {
    window.__churn = setInterval(() => {
      fetch('/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: id, text: 'churn\n' }),
      }).catch(() => {});
    }, every);
  }, { id, every: CHURN_MS });
}

async function stopBackgroundOutput(page) {
  await page.evaluate(() => clearInterval(window.__churn));
}

// A human press, not an instantaneous synthetic one.
async function pressRow(page, index, holdMs = PRESS_MS) {
  const box = await page.locator('.sl-row').nth(index).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(holdMs);
  await page.mouse.up();
}

async function activeSessionId(page) {
  return page.evaluate(() => document.querySelector('.terminal-pane.active')?.dataset.sessionId ?? null);
}

// The session that is NOT on screen. Derived from the panes rather than from
// id ordering: only a background session re-renders the list on output
// (ws.onmessage guards on activeId !== this.id), so churning the wrong one
// silently exercises nothing and the test passes against broken code.
async function backgroundSessionId(page) {
  return page.evaluate(() => {
    const p = [...document.querySelectorAll('.terminal-pane')].find(x => !x.classList.contains('active'));
    return p ? p.dataset.sessionId : null;
  });
}

async function rowIndexFor(page, id) {
  return page.evaluate((wanted) =>
    [...document.querySelectorAll('.sl-row')].findIndex(r => r.dataset.sessionId === wanted), id);
}

test('a row click lands while another session is streaming output', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await newSession(page);           // second session, now active
  await waitForPanes(page, 2);      // the create is a fetch; the pane lands after the click returns
  await waitForConnection(page);

  const targetId = await backgroundSessionId(page);
  expect(targetId).toBeTruthy();

  await openSessionList(page);
  await expect.poll(() => page.locator('.sl-row').count()).toBe(2);
  const targetIndex = await rowIndexFor(page, targetId);
  expect(targetIndex).toBeGreaterThanOrEqual(0);

  await startBackgroundOutput(page, targetId);
  await page.waitForTimeout(200);   // let the churn get going
  await pressRow(page, targetIndex);
  await stopBackgroundOutput(page);

  // The click has to have been delivered: list closed, and we are in that session.
  await expect.poll(() => page.evaluate(() => document.body.dataset.view), { timeout: 5000 }).toBe('session');
  expect(await activeSessionId(page)).toBe(targetId);
});

// Tag the live rows so we can tell reuse from replacement. Nothing in the app
// reads these; a surviving tag means it is literally the same DOM node.
async function tagRows(page) {
  await page.evaluate(() => {
    [...document.querySelectorAll('.sl-row')].forEach((r, i) => { r.dataset.probeTag = `row-${i}`; });
  });
}
async function rowTags(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.sl-row')].map(r => r.dataset.probeTag ?? null));
}

test('rows survive a re-render, so a press is never orphaned mid-click', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await newSession(page);
  await waitForPanes(page, 2);
  await waitForConnection(page);

  const bg = await backgroundSessionId(page);
  expect(bg).toBeTruthy();
  await openSessionList(page);
  await expect.poll(() => page.locator('.sl-row').count()).toBe(2);
  await tagRows(page);

  // Re-render through the production path (background output), not by calling
  // the renderer, which is module-scoped and deliberately not on window.
  await startBackgroundOutput(page, bg);
  await page.waitForTimeout(600);   // many frames, so many re-render calls
  await stopBackgroundOutput(page);

  expect(await rowTags(page)).toEqual(['row-0', 'row-1']);
});

test('a re-render still updates what a row says', async ({ pdServerClaudeStub, page }) => {
  // Reusing the nodes must not mean showing stale content: the whole reason the
  // list re-renders is that status and preview change under you.
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);

  const id = 'pdstub-' + pdServerClaudeStub.port + '-1';
  const uuid = await pdServerClaudeStub.uuidFor(id);
  await pdServerClaudeStub.writeTranscript(uuid, [
    { type: 'ai-title', aiTitle: 'First title' },
    { type: 'last-prompt', lastPrompt: 'first prompt' },
    { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
  ]);

  await openSessionList(page);
  await expect.poll(() => page.locator('.sl-row').nth(0).locator('.sl-prev').textContent(), { timeout: 8000 })
    .toBe('first prompt');
  await tagRows(page);

  await pdServerClaudeStub.writeTranscript(uuid, [
    { type: 'ai-title', aiTitle: 'Second title' },
    { type: 'last-prompt', lastPrompt: 'second prompt' },
    { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
  ]);

  // The poll picks the change up and the row must show it...
  await expect.poll(() => page.locator('.sl-row').nth(0).locator('.sl-prev').textContent(), { timeout: 10000 })
    .toBe('second prompt');
  await expect(page.locator('.sl-row').nth(0).locator('.sl-title')).toHaveText('Second title');
  // ...without having been replaced to do it.
  expect(await rowTags(page)).toEqual(['row-0']);
});
