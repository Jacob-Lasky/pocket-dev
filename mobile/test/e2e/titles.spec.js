// Conversation titles, end to end: pd-claude-session mints a uuid, the server
// reads the transcript that uuid names, and the browser labels the session with
// Claude's own title instead of an anonymous counter.
//
// This runs on the pdServerClaudeStub fixture rather than the usual `cat` one,
// because setting SHELL_CMD switches the whole conversation machinery off (see
// RESUME_ENABLED in server.js). The stub shadows `claude` on PATH instead, so
// the launcher, the sid-file handoff, and GET /sessions all run for real.

import { test, expect, gotoTest, waitForConnection } from './fixtures.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const titleRecord  = (t) => ({ type: 'ai-title', aiTitle: t });
const promptRecord = (p) => ({ type: 'last-prompt', lastPrompt: p });
const finishedTurn = { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } };
const workingTurn  = { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use' }] } };

async function sessionRows(page) {
  return page.evaluate(async () => (await (await fetch('/sessions')).json()));
}

async function openSwitcher(page) {
  // The counter and label live in the switcher row, now reached through the
  // session list. The list shows the same titles per row; this asserts the
  // older surface still carries them.
  await page.click('#sessions-btn');
  await page.click('#sl-bar >> text=Switcher');
}

test('a session is launched bound to a conversation id', async ({ pdServerClaudeStub, page }) => {
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);

  const uuid = await pdServerClaudeStub.uuidFor('pdstub-' + pdServerClaudeStub.port + '-1');
  expect(uuid).toMatch(UUID_RE);

  // The sid file is written just before claude is exec'd, so the argv log can
  // lag it by a beat.
  await expect
    .poll(async () => (await pdServerClaudeStub.claudeArgv())[0] ?? '', { timeout: 8000 })
    .toContain(`--session-id ${uuid}`);
});

test('the switcher and the browser tab show the conversation title', async ({ pdServerClaudeStub, page }) => {
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);

  const id   = 'pdstub-' + pdServerClaudeStub.port + '-1';
  const uuid = await pdServerClaudeStub.uuidFor(id);

  // Before Claude has written anything, there is no name to show and the UI
  // must not invent one.
  expect((await sessionRows(page))[0]).toMatchObject({ title: null, status: 'unknown' });
  expect(await page.title()).toBe('pocket-dev');

  await pdServerClaudeStub.writeTranscript(uuid, [
    titleRecord('Restore sessions across container restarts'),
    promptRecord('continue please'),
    finishedTurn,
  ]);

  // Opening the switcher refetches, because a conversation renames itself as
  // it goes and the page-load value goes stale.
  await openSwitcher(page);

  await expect
    .poll(() => page.textContent('#session-label'), { timeout: 8000 })
    .toContain('Restore sessions across container restarts');
  expect(await page.textContent('#session-label')).toContain('1/1');
  await expect.poll(() => page.title()).toBe('Restore sessions across container restarts · pocket-dev');
});

test('GET /sessions carries title, preview and status per session', async ({ pdServerClaudeStub, page }) => {
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);

  const id   = 'pdstub-' + pdServerClaudeStub.port + '-1';
  const uuid = await pdServerClaudeStub.uuidFor(id);
  await pdServerClaudeStub.writeTranscript(uuid, [
    titleRecord('Dispatcharr ranked matchups'),
    promptRecord('what would the llm step buy us?'),
    workingTurn,
  ]);

  await expect.poll(async () => (await sessionRows(page))[0], { timeout: 8000 }).toMatchObject({
    id,
    title: 'Dispatcharr ranked matchups',
    lastPrompt: 'what would the llm step buy us?',
    status: 'busy',
  });
});

test('a session with no transcript falls back to the counter, not a blank label', async ({ pdServerClaudeStub, page }) => {
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);
  await openSwitcher(page);
  expect((await page.textContent('#session-label')).trim()).toBe('1/1');
  expect(await page.title()).toBe('pocket-dev');
});

test('each tab gets its own conversation, and the label follows the active one', async ({ pdServerClaudeStub, page }) => {
  await gotoTest(page, pdServerClaudeStub);
  await waitForConnection(page);

  await page.click('#sessions-btn');
  await page.click('#sl-bar >> text=+ New');
  await waitForConnection(page);
  await expect.poll(async () => (await sessionRows(page)).length).toBe(2);

  const base = 'pdstub-' + pdServerClaudeStub.port;
  const uuid1 = await pdServerClaudeStub.uuidFor(`${base}-1`);
  const uuid2 = await pdServerClaudeStub.uuidFor(`${base}-2`);
  expect(uuid1).not.toBe(uuid2);   // two tabs are never the same conversation

  await pdServerClaudeStub.writeTranscript(uuid1, [titleRecord('First conversation'), finishedTurn]);
  await pdServerClaudeStub.writeTranscript(uuid2, [titleRecord('Second conversation'), workingTurn]);

  // Session 2 is active after +New.
  await openSwitcher(page);
  await expect.poll(() => page.textContent('#session-label'), { timeout: 8000 }).toContain('Second conversation');

  await page.click('#btn-row-tmux >> text=Last');
  await openSwitcher(page);
  await expect.poll(() => page.textContent('#session-label'), { timeout: 8000 }).toContain('First conversation');
});
