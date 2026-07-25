// The session list: three states, from two sources.
//
// The server can only say whether a conversation is mid-turn or finished.
// "Waiting on you" and "read" are the SAME finished state and differ only by
// whether the user has looked since its last output, so that axis is tracked in
// the browser. These tests exist mostly to hold that split in place, because it
// is the part most likely to get quietly re-modelled as three server states.
//
// Runs on pdServerClaudeStub, which leaves SHELL_CMD unset so real conversation
// ids and titles exist. The cat fixture cannot reach any of that.

import { test, expect, gotoTest, waitForConnection } from './fixtures.js';

const titleRecord  = (t) => ({ type: 'ai-title', aiTitle: t });
const promptRecord = (p) => ({ type: 'last-prompt', lastPrompt: p });
const finishedTurn = { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } };
const workingTurn  = { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use' }] } };

const openList  = (page) => page.click('#sessions-btn');
const rowCount  = (page) => page.locator('.sl-row').count();
const listShown = (page) => page.evaluate(() => document.body.dataset.view === 'list');

function rowFor(page, index) {
  return page.locator('.sl-row').nth(index);
}
async function stateOf(page, index) {
  return rowFor(page, index).locator('.sl-status').getAttribute('data-state');
}

// Drive output into a session that is not on screen.
async function sendTo(page, id, text) {
  await page.evaluate(async ({ id, text }) => {
    await fetch('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: id, text }),
    });
  }, { id, text });
}

async function newSession(page) {
  await openList(page);
  await page.click('#sl-bar >> text=+ New');
}

test('the list shows one row per session, titled by its conversation', async ({ pdServerClaudeStub, page }) => {
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);

  const base = 'pdstub-' + pdServerClaudeStub.port;
  await newSession(page);
  await waitForConnection(page);

  const uuid1 = await pdServerClaudeStub.uuidFor(`${base}-1`);
  const uuid2 = await pdServerClaudeStub.uuidFor(`${base}-2`);
  await pdServerClaudeStub.writeTranscript(uuid1, [titleRecord('Restore sessions across restarts'), promptRecord('continue please'), finishedTurn]);
  await pdServerClaudeStub.writeTranscript(uuid2, [titleRecord('Dispatcharr ranked matchups'), promptRecord('what would the llm buy us?'), workingTurn]);

  await openList(page);
  expect(await listShown(page)).toBe(true);
  await expect.poll(() => rowCount(page)).toBe(2);
  await expect.poll(() => rowFor(page, 0).locator('.sl-title').textContent(), { timeout: 8000 })
    .toBe('Restore sessions across restarts');
  await expect(rowFor(page, 1).locator('.sl-title')).toHaveText('Dispatcharr ranked matchups');
  await expect(rowFor(page, 0).locator('.sl-prev')).toHaveText('continue please');
});

test('a mid-turn conversation reads as working, whether or not you have seen it', async ({ pdServerClaudeStub, page }) => {
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);

  const uuid = await pdServerClaudeStub.uuidFor('pdstub-' + pdServerClaudeStub.port + '-1');
  await pdServerClaudeStub.writeTranscript(uuid, [titleRecord('Busy one'), workingTurn]);

  await openList(page);
  // busy wins over the read/unread axis: it is the one state the transcript
  // knows for certain, and it is the one that means "do not wait on me".
  await expect.poll(() => stateOf(page, 0), { timeout: 8000 }).toBe('working');
});

test('opening a session is what marks it read', async ({ pdServerClaudeStub, page }) => {
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);

  const base = 'pdstub-' + pdServerClaudeStub.port;
  await newSession(page);
  await waitForConnection(page);

  const uuid1 = await pdServerClaudeStub.uuidFor(`${base}-1`);
  await pdServerClaudeStub.writeTranscript(uuid1, [titleRecord('Finished and unseen'), finishedTurn]);

  // Unread is driven by OUTPUT, not by the transcript: a conversation file
  // changing on disk is not something the user could have seen or missed. So
  // make session 1 actually produce something while session 2 is on screen.
  await sendTo(page, `${base}-1`, 'a reply you have not looked at');

  // Session 1 is now finished with output the user has not seen. Same
  // transcript state as "read"; only the looking differs.
  await openList(page);
  await expect.poll(() => stateOf(page, 0), { timeout: 8000 }).toBe('waiting');
  await expect(rowFor(page, 0)).toHaveAttribute('data-unread', 'true');

  await rowFor(page, 0).click();
  expect(await listShown(page)).toBe(false);

  await openList(page);
  await expect.poll(() => stateOf(page, 0), { timeout: 8000 }).toBe('read');
  await expect(rowFor(page, 0)).toHaveAttribute('data-unread', 'false');
});

test('tapping a row switches to that session', async ({ pdServerClaudeStub, page }) => {
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);
  const base = 'pdstub-' + pdServerClaudeStub.port;
  await newSession(page);
  await waitForConnection(page);

  await openList(page);
  await rowFor(page, 0).click();

  // The pane that is visible is the one whose row was tapped.
  await expect.poll(() => page.evaluate(
    () => document.querySelector('.terminal-pane.active')?.dataset.sessionId,
  )).toBe(`${base}-1`);
});

test('the Sessions button flags another session wanting attention', async ({ pdServerClaudeStub, page }) => {
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);
  const base = 'pdstub-' + pdServerClaudeStub.port;
  await newSession(page);
  await waitForConnection(page);

  // Nothing pending: both sessions have been looked at.
  await expect(page.locator('#sessions-btn')).not.toHaveClass(/has-unread/);

  // Session 1 produces output while session 2 is on screen. Learning that
  // without leaving this session is the whole point of the badge.
  await sendTo(page, `${base}-1`, 'output for the other tab');

  await expect(page.locator('#sessions-btn')).toHaveClass(/has-unread/, { timeout: 8000 });
});

test('a page reload does not turn read sessions unread', async ({ pdServerClaudeStub, page }) => {
  // The server replays its whole buffer on every attach. Counting that as new
  // output would make every reload claim all five sessions need you.
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);
  const base = 'pdstub-' + pdServerClaudeStub.port;
  await newSession(page);
  await waitForConnection(page);

  const uuid1 = await pdServerClaudeStub.uuidFor(`${base}-1`);
  await pdServerClaudeStub.writeTranscript(uuid1, [titleRecord('Seen already'), finishedTurn]);

  await openList(page);
  await rowFor(page, 0).click();          // read it
  await openList(page);
  await expect.poll(() => stateOf(page, 0), { timeout: 8000 }).toBe('read');

  await page.reload();
  await waitForConnection(page);
  await openList(page);
  await expect.poll(() => rowCount(page)).toBe(2);
  expect(await stateOf(page, 0)).toBe('read');
});

test('the list survives having no titles at all', async ({ pdServer, page }) => {
  // The cat fixture has no conversations, so every status is unknown. The list
  // still has to be usable: that is also what a brand new tab looks like.
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await openList(page);
  await expect.poll(() => rowCount(page)).toBe(1);
  await expect(rowFor(page, 0).locator('.sl-title')).toHaveText('Current session');
  expect(await stateOf(page, 0)).toBe('read');

  await rowFor(page, 0).click();
  expect(await listShown(page)).toBe(false);
});

test('Escape closes the list', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await openList(page);
  expect(await listShown(page)).toBe(true);
  await page.keyboard.press('Escape');
  expect(await listShown(page)).toBe(false);
});
