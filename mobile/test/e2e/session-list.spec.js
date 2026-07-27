// The session list: four states, from two sources.
//
// The transcript says what the conversation is doing — working, finished, or
// blocked on a question it asked ('asking'). What it cannot say is whether a
// human has LOOKED: "waiting on you" and "read" are the same finished state on
// disk, so that axis is the server's unread flag. These tests exist mostly to
// hold that split in place, because it is the part most likely to get quietly
// re-modelled as one server enum.
//
// Runs on pdServerClaudeStub, which leaves SHELL_CMD unset so real conversation
// ids and titles exist. The cat fixture cannot reach any of that.

import {
  test, expect, gotoTest, waitForConnection,
  openSessionList, newSession, switchToRow, sessionRows, sendAndWaitForEcho,
} from './fixtures.js';

const titleRecord  = (t) => ({ type: 'ai-title', aiTitle: t });
const promptRecord = (p) => ({ type: 'last-prompt', lastPrompt: p });
const finishedTurn = { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } };
const workingTurn  = { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } };
// A question put to the user. Indistinguishable from workingTurn except for the
// tool's name, which is the entire point.
const askingTurn   = { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'AskUserQuestion' }] } };

// The badge is an attribute with two tiers, so assert on the tier, never just
// on presence: "something is working" and "something wants you" being
// indistinguishable is the defect it was built to fix.
const badge = (page, tier) => page.locator(`#sessions-btn[data-badge="${tier}"]`);
const anyBadge = (page) => page.locator('#sessions-btn[data-badge]');

const openList = openSessionList;
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

  // Establish the baseline rather than assuming it. Session 1 keeps painting
  // for a moment after session 2 takes over, so it is legitimately unread until
  // it settles: sit in it until the SERVER agrees it is read, then leave.
  await switchToRow(page, 0);
  await expect
    .poll(async () => (await sessionRows(page)).find(r => r.id === `${base}-1`)?.unread, { timeout: 20000 })
    .toBe(false);
  await switchToRow(page, 1);
  await expect(anyBadge(page)).toHaveCount(0, { timeout: 10000 });

  // Session 1 produces output while session 2 is on screen. Learning that
  // without leaving this session is the whole point of the badge.
  await sendTo(page, `${base}-1`, 'output for the other tab');

  // Waits for a metadata poll on purpose. Arriving bytes no longer flag a
  // session in the browser, because the browser cannot tell a finished turn
  // from a repaint, so the badge is worth exactly one poll interval of latency.
  await expect(badge(page, 'attention')).toHaveCount(1, { timeout: 15000 });
});

test('a session merely working does NOT raise the attention badge', async ({ pdServerClaudeStub, page }) => {
  // The reported defect: the badge fired for any session that was not 'read',
  // which includes every session that is thinking. Something is almost always
  // thinking, so the badge was on permanently and answered nothing — the user
  // still had to open the list to find out whether anything wanted them.
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);
  const base = 'pdstub-' + pdServerClaudeStub.port;
  await newSession(page);
  await waitForConnection(page);

  const uuid1 = await pdServerClaudeStub.uuidFor(`${base}-1`);
  await pdServerClaudeStub.writeTranscript(uuid1, [titleRecord('Grinding away'), workingTurn]);

  // Sit in session 2 with session 1 mid-turn. The dim 'working' tier is allowed
  // (it answers "is anything running?"); 'attention' is not.
  await switchToRow(page, 1);
  await expect(badge(page, 'working')).toHaveCount(1, { timeout: 10000 });
  await expect(badge(page, 'attention')).toHaveCount(0);
});

test('a session holding a question wants you, and keeps wanting you once seen', async ({ pdServerClaudeStub, page }) => {
  // The reported defect: a session that had asked a direct multiple-choice
  // question read as "Working", because a pending tool call is a pending tool
  // call whether the answer comes from a machine or a human. Measured on the
  // live container 2026-07-27: one sat that way for 39 minutes.
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);
  const base = 'pdstub-' + pdServerClaudeStub.port;
  await newSession(page);
  await waitForConnection(page);

  const uuid1 = await pdServerClaudeStub.uuidFor(`${base}-1`);
  await pdServerClaudeStub.writeTranscript(uuid1, [titleRecord('Asked you something'), askingTurn]);

  await switchToRow(page, 1);
  await expect(badge(page, 'attention')).toHaveCount(1, { timeout: 10000 });

  await openList(page);
  await expect.poll(() => stateOf(page, 0), { timeout: 8000 }).toBe('asking');

  // Now LOOK at it, and look away again. A glance is not an answer, so unlike
  // an unread finished turn this must not clear.
  await rowFor(page, 0).click();
  await switchToRow(page, 1);
  await openList(page);
  await expect.poll(() => stateOf(page, 0), { timeout: 8000 }).toBe('asking');
  await expect(badge(page, 'attention')).toHaveCount(1);
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

test('a reconnect does not turn a read BACKGROUND session unread', async ({ pdServer, page }) => {
  // The sharp version of the test above, and a real reported bug the loose one
  // missed. After a reload the active session is row 0, and the active session
  // is never unread by definition, so asserting on it proves nothing. The
  // sessions that break are the ones NOT on screen: the server replays its
  // whole buffer to every pane that attaches, and the client used to count any
  // arriving bytes as "unread" for a background session. Every reconnect — a
  // phone waking, a network blip, a restart — therefore claimed that every
  // session the user was not looking at wanted them.
  //
  // Made deterministic by stalling the metadata poll after bootstrap, so the
  // client cannot quietly correct itself before the assertion. Without that
  // this is a race, and racy assertions have cost this repo a day before.
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  const base = 'pdtest-' + pdServer.port;
  await newSession(page);
  await waitForConnection(page);

  // Give session 2 something in its replay buffer, then leave it read. It has
  // to be session 2: after a reload the first session becomes the active one.
  await sendAndWaitForEcho(page, 'bytes in the replay buffer');
  await switchToRow(page, 0);
  await expect
    .poll(async () => (await sessionRows(page)).find(r => r.id === `${base}-2`)?.unread, { timeout: 20000 })
    .toBe(false);

  let getsAllowed = 1;
  await page.route('**/sessions', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (getsAllowed-- > 0) return route.continue();   // bootstrap needs one
    return route.abort();                             // and then no corrections
  });

  await page.reload();
  await waitForConnection(page);
  await openList(page);
  await expect.poll(() => rowCount(page)).toBe(2);

  // Row 1 is session 2: off screen, replayed, and already read.
  expect(await stateOf(page, 1)).toBe('read');
  await expect(rowFor(page, 1)).toHaveAttribute('data-unread', 'false');
  await expect(anyBadge(page)).toHaveCount(0);
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
