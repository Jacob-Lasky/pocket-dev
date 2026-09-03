// Closing a tab whose conversation was archived from another device, end to end.
//
// This runs on the pdServerClaudeStub fixture, NOT the usual `cat` one, for the
// same reason titles.spec.js does: setting SHELL_CMD switches the whole
// conversation machinery off (see RESUME_ENABLED in server.js), and this feature
// reads the transcript, so on the cat fixture it is not merely untested, it is
// disabled. That is the documented cat gap, and it is why the assertions below
// exist alongside the unit tests rather than instead of them.
//
// What only this level can prove: that the BROWSER actually lets the pane go.
// The server dropping a session is invisible to the client until its WebSocket
// closes with GONE_CODE and ws.onclose resyncs the roster, so the unit tests
// stop one layer short of the thing a user sees.

import path from 'node:path';
import { test, expect, gotoTest, waitForConnection, waitForPanes, openSessionList, newSession, activeSessionId, sessionRows } from './fixtures.js';
import { archivedNotice as archived } from '../fixtures/rc-notices.js';

const NOTICE = 'aaaa1111-1111-4111-8111-111111111111';

const finishedTurn = { type: 'assistant', uuid: 'f1111111-1111-4111-8111-111111111111', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'all yours' }] } };
const workingTurn  = { type: 'assistant', uuid: 'f2222222-2222-4222-8222-222222222222', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } };
const title = (t) => ({ type: 'ai-title', aiTitle: t });

// Opening the session list refetches GET /sessions, which is the poll that
// notices the archive. Escape closes it again.
async function poll(page) {
  await openSessionList(page);
  await page.keyboard.press('Escape');
}

// Stand up two tabs, each bound to its own conversation, and return their ids
// and uuids. The second one is left active, because newSession switches to it.
async function twoSessions(server, page) {
  await gotoTest(page, server);
  await waitForConnection(page);
  await newSession(page);
  await waitForConnection(page);
  await waitForPanes(page, 2);

  const [first, second] = [`${server.sessionName}-1`, `${server.sessionName}-2`];
  const uuids = {
    [first]:  await server.uuidFor(first),
    [second]: await server.uuidFor(second),
  };
  await server.writeTranscript(uuids[first],  [title('The archived one'), finishedTurn]);
  await server.writeTranscript(uuids[second], [title('The survivor'), finishedTurn]);
  await poll(page);
  return { first, second, uuids };
}

test('a background tab archived elsewhere disappears on its own', async ({ pdServerClaudeStub, page }) => {
  const { first, second, uuids } = await twoSessions(pdServerClaudeStub, page);
  expect(await activeSessionId(page)).toBe(second);

  await pdServerClaudeStub.writeTranscript(uuids[first], [title('The archived one'), finishedTurn, archived(NOTICE)]);
  await poll(page);

  // The pane goes, and the one the user is looking at is untouched.
  await waitForPanes(page, 1);
  expect(await activeSessionId(page)).toBe(second);
  const rows = await sessionRows(page);
  expect(rows.map(r => r.id)).not.toContain(first);
});

test('archiving the tab you are LOOKING at falls back instead of going blank', async ({ pdServerClaudeStub, page }) => {
  // The pane is removed under the user, so removeSession has to pick a fallback
  // and make it active. Leaving activeId null shows an empty terminal with a
  // disconnected dot and no way back except a reload.
  const { first, second, uuids } = await twoSessions(pdServerClaudeStub, page);
  expect(await activeSessionId(page)).toBe(second);

  await pdServerClaudeStub.writeTranscript(uuids[second], [title('The survivor'), finishedTurn, archived(NOTICE)]);
  await poll(page);

  await waitForPanes(page, 1);
  expect(await activeSessionId(page)).toBe(first);
});

test('a tab archived mid-turn survives until the turn finishes', async ({ pdServerClaudeStub, page }) => {
  // The settled gate, from the outside. A tab killed mid-tool-call is the one
  // failure mode that leaves no record of what was lost.
  const { first, second, uuids } = await twoSessions(pdServerClaudeStub, page);

  await pdServerClaudeStub.writeTranscript(uuids[first], [title('The archived one'), archived(NOTICE), workingTurn]);
  await poll(page);
  await poll(page);
  await waitForPanes(page, 2);

  // Turn ends. The notice is latched, so it closes even though the notice is
  // now behind the finished turn.
  await pdServerClaudeStub.writeTranscript(uuids[first], [title('The archived one'), archived(NOTICE), workingTurn, finishedTurn]);
  await poll(page);
  await waitForPanes(page, 1);
  expect(await activeSessionId(page)).toBe(second);
});

test('the last tab archived away is replaced, never left with nothing', async ({ pdServerClaudeStub, page }) => {
  // resyncSessions creates a session when the roster comes back empty. Worth
  // asserting from here, because this feature is the first thing that can empty
  // the roster without the user asking.
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);
  const only = `${pdServerClaudeStub.sessionName}-1`;
  const uuid = await pdServerClaudeStub.uuidFor(only);
  await pdServerClaudeStub.writeTranscript(uuid, [title('The only one'), finishedTurn, archived(NOTICE)]);

  await poll(page);
  await waitForPanes(page, 1);
  await expect.poll(async () => await activeSessionId(page)).not.toBe(only);
});

test('the browser is told the session is GONE, not that the link hiccuped', async ({ pdServerClaudeStub, page }) => {
  // The other tests in this file pass WITHOUT this, and that is the point of
  // having it: measured by reverting the close code to a bare ws.close(), all
  // four stayed green and merely got three times slower, because the client
  // retries for two seconds and then earns a 4404 from the reconnect. So they
  // prove the pane eventually goes; only the close code proves no dead pane is
  // left on screen in the meantime, and waitForPanes' timeout hides the
  // difference by design.
  //
  // Asserted as the code the browser RECEIVED rather than as elapsed time,
  // because a timing assertion for this would be flaky in exactly the
  // conditions it matters (a loaded CI runner).
  await page.addInitScript(() => {
    window.__wsCloses = [];
    const Real = window.WebSocket;
    window.WebSocket = class extends Real {
      constructor(...args) {
        super(...args);
        this.addEventListener('close', (ev) => window.__wsCloses.push({ url: this.url, code: ev.code }));
      }
    };
  });

  const { first, uuids } = await twoSessions(pdServerClaudeStub, page);
  await pdServerClaudeStub.writeTranscript(uuids[first], [title('The archived one'), finishedTurn, archived(NOTICE)]);
  await poll(page);
  await waitForPanes(page, 1);

  const codes = await page.evaluate((id) => window.__wsCloses
    .filter(c => c.url.includes(`session=${id}`))
    .map(c => c.code), first);
  expect(codes, `no close observed for ${first}`).not.toHaveLength(0);
  // 1005 is "no status received", which is what a bare ws.close() looks like on
  // the wire and what the client reads as a transient blip worth retrying.
  expect(codes).toContain(4404);
  expect(codes).not.toContain(1005);
});
