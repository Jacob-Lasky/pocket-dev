// A tab whose harness pocket-dev cannot read must not claim the user.
//
// THIS IS THE TEST THAT WOULD HAVE CAUGHT THIS FEATURE SHIPPING A DEFECT, and
// the defect was not a missing indicator. `rowState` has no branch for status
// 'unknown' (asserted deliberately, twice, in attention.test.js and
// statusContract.test.js, because a brand new Claude tab is 'unknown' and DOES
// have an axis), so a session with no transcript fell through to the unread
// axis. Server-side, the byte branch in ptyProc.onData advanced attentionSeq on
// every frame with nothing to ever close the guard. Net: a session that is
// THINKING reports "Waiting on you" and lights the attention badge.
//
// Measured on the production code path before the fix, nobody typing: ~5
// increments per second, unbounded, and re-armed under a second after a view.
// The control that identified the mechanism: the same harness writing ONE real
// transcript record froze the counter instantly and moved to 'working'. So the
// bug is precisely "nothing closes the byte guard when no transcript ever
// arrives", which is what unreadAxis 'none' fixes.
//
// Runs on pdServerClaudeStub because it is the only fixture that leaves
// SHELL_CMD UNSET, so the whole provider and capability layer is live. Its PATH
// already puts test/e2e/stub-bin first, which is what shadows `codex`.
//
// THE CLAUDE STUB IS DELIBERATELY UNTOUCHED. It also runs with no transcript,
// but it is a CLAUDE-provider session, and Claude's axis counts bytes while the
// status is still 'unknown' (the brand-new-tab window). So a repainting Claude
// stub SHOULD light the badge, and session-list.spec.js:135-159 depends on
// exactly that: it types at the session, cat echoes, bytes count, badge fires.
// That test is right and must keep passing unchanged.

import {
  test, expect, gotoTest, waitForConnection,
  openSessionList, newSession, newSessionWithProvider, switchToRow, activeSessionId,
} from './fixtures.js';

const anyBadge  = (page) => page.locator('#sessions-btn[data-badge]');
const summary   = (page) => page.locator('#sl-count');
const rowFor    = (page, id) => page.locator(`.sl-row[data-session-id="${id}"]`);

// Read GET /sessions from inside the page, so the assertion is against what the
// server actually reports rather than what the DOM happened to render.
async function serverRows(page) {
  return page.evaluate(async () => (await fetch('/sessions')).json());
}

// Wait until the server has seen output from this session. THE TEST IS WORTHLESS
// WITHOUT THIS: if the stub ever stops repainting, every assertion below passes
// for the wrong reason, and a silent stub is indistinguishable from a fixed bug.
// lastOutputAt comes from raw pty data and needs no transcript, so it is the one
// signal such a session genuinely has, which makes it the right proof of life.
async function waitForRepaint(page, id, { timeout = 15000 } = {}) {
  await expect.poll(async () => {
    const row = (await serverRows(page)).find(r => r.id === id);
    return row ? row.lastOutputAt : 0;
  }, { timeout }).toBeGreaterThan(0);
}

test('a repainting tab with no transcript never raises the attention badge', async ({ pdServerClaudeStub, page }) => {
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);

  const claudeId = await activeSessionId(page);
  await newSessionWithProvider(page, 'Codex DG');
  const codexId = await activeSessionId(page);
  expect(codexId).not.toBe(claudeId);

  // The badge answers "is anything ELSE waiting", so the Codex tab has to be in
  // the background for this to be a question at all.
  await switchToRow(page, 0);
  expect(await activeSessionId(page)).toBe(claudeId);

  // Prove it is painting, THEN prove the painting claimed nothing.
  await waitForRepaint(page, codexId);

  const row = (await serverRows(page)).find(r => r.id === codexId);
  expect(row.provider).toBe('codex');
  expect(row.providerLabel).toBe('Codex (Deepgram)');
  expect(row.statusTracked).toBe(false);
  expect(row.unread).toBe(false);

  // Give it a long run of frames with nobody watching, which is the shape of a
  // coder thinking. The counter must not move at all.
  await page.waitForTimeout(4000);
  await waitForRepaint(page, codexId);
  expect((await serverRows(page)).find(r => r.id === codexId).unread).toBe(false);
  await expect(anyBadge(page)).toHaveCount(0);
});

test('its row says it has no status, and the summary does not call the list quiet', async ({ pdServerClaudeStub, page }) => {
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);

  const claudeId = await activeSessionId(page);
  await newSessionWithProvider(page, 'Codex DG');
  const codexId = await activeSessionId(page);
  await switchToRow(page, 0);
  await waitForRepaint(page, codexId);

  await openSessionList(page);

  // Named for what it IS, so the tab is legible rather than a bare id.
  await expect.poll(() => rowFor(page, codexId).locator('.sl-title').textContent(), { timeout: 8000 })
    .toBe(`Codex (Deepgram) · ${codexId}`);
  await expect(rowFor(page, codexId).locator('.sl-status')).toHaveAttribute('data-state', 'opaque');
  await expect(rowFor(page, codexId).locator('.sl-status')).toContainText('Status not tracked');
  await expect(rowFor(page, codexId)).toHaveAttribute('data-unread', 'false');

  // The summary must not claim quiet over a session it cannot see, and must not
  // claim anything needs the user either. attention.js's own header forbids the
  // first: saying "all quiet" over grinding sessions is the badge defect in
  // words instead of a dot.
  await expect(summary(page)).toContainText('not tracked');
  await expect(summary(page)).not.toContainText('needs you');
  await expect(summary(page)).not.toContainText('all quiet');
});

test('the picker starts the harness its label names, and nothing else', async ({ pdServerClaudeStub, page }) => {
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);

  // All three buttons exist and say which harness/account route they start. A cycling chip would
  // carry hidden state a phone user has to read before tapping, and a mis-tap
  // starts the wrong harness on the wrong billing account.
  await openSessionList(page);
  await expect(page.getByRole('button', { name: '+ Claude', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '+ Codex DG', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '+ Codex GPT', exact: true })).toHaveCount(1);
  await page.keyboard.press('Escape');

  await newSession(page);
  const claudeTab = await activeSessionId(page);
  await newSessionWithProvider(page, 'Codex DG');
  const codexTab = await activeSessionId(page);
  await newSessionWithProvider(page, 'Codex GPT');
  const codexChatgptTab = await activeSessionId(page);

  const rows = await serverRows(page);
  expect(rows.find(r => r.id === claudeTab).provider).toBe('claude');
  expect(rows.find(r => r.id === codexTab).provider).toBe('codex');
  expect(rows.find(r => r.id === codexChatgptTab).provider).toBe('codex-chatgpt');
  expect(rows.find(r => r.id === codexChatgptTab).providerLabel).toBe('Codex (ChatGPT)');
  expect(rows.find(r => r.id === codexChatgptTab).statusTracked).toBe(false);
  // The Claude tab keeps a tracked status, so this did not flatten the list.
  expect(rows.find(r => r.id === claudeTab).statusTracked).toBe(true);
});

test('POST /sessions refuses a provider nobody recognises', async ({ pdServerClaudeStub, page }) => {
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);
  const before = (await serverRows(page)).length;

  // A provider id selects a command line, so a typo must be refused rather than
  // defaulted through to whichever harness happens to be first in the registry.
  const res = await page.evaluate(async () => {
    const r = await fetch('/sessions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ provider: 'cursor' }),
    });
    return { status: r.status, body: await r.json() };
  });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('unknown provider');
  expect((await serverRows(page)).length).toBe(before);
});
