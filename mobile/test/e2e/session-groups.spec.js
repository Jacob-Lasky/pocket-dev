// Session list groups: create, rename, drag sessions in and out, reorder
// groups, collapse, remove with Undo, and Autogroup.
//
// Drags are driven with real pointer input (mouse down, stepped moves, up) on
// the grip, because the feature IS the pointer handling: a test that called
// moveSession() directly would pass with the drag code deleted.
//
// The layout is server-side, so every arrangement is also checked after a
// reload: a drop that only changed the DOM would look right until then.

import {
  test, expect, gotoTest, waitForConnection, waitForPanes,
  openSessionList, newSession, activeSessionId,
} from './fixtures.js';

// What the list shows, top to bottom: `[name]` for a header, the session id
// for a row. Collapsed rows are not in the DOM, so they do not appear.
async function listShape(page) {
  return page.evaluate(() => [...document.querySelectorAll('#sl-rows > *')].map((el) =>
    el.classList.contains('sl-group') ? `[${el.querySelector('.sl-group-name').textContent}]` : el.dataset.sessionId));
}

async function serverLayout(page) {
  return page.evaluate(async () => (await fetch('/layout')).json());
}

// Press the grip of `from`, move in steps to just inside the top or bottom
// edge of `target` (`where` is 'above' or 'below'), release.
async function drag(page, from, where, target) {
  const grip = await from.locator('.sl-grip').first().boundingBox();
  const box = await target.boundingBox();
  const x = grip.x + grip.width / 2;
  const y = where === 'above' ? box.y + 3 : box.y + box.height - 3;
  await page.mouse.move(x, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.up();
}

const row    = (page, id)  => page.locator(`#sl-rows > .sl-item[data-session-id="${id}"]`);
const header = (page, name) => page.locator('#sl-rows > .sl-group').filter({ has: page.locator('.sl-group-name', { hasText: name }) });

async function threeSessions(page, server) {
  await gotoTest(page, server);
  await waitForConnection(page);
  await newSession(page);
  await newSession(page);
  await waitForPanes(page, 3);
  await openSessionList(page);
  const ids = await page.evaluate(() => [...document.querySelectorAll('.sl-item')].map((el) => el.dataset.sessionId));
  expect(ids).toHaveLength(3);
  return ids;
}

async function addGroup(page, name) {
  await page.click('#sl-tools >> text=+ Group');
  const input = page.locator('.sl-group-input');
  await expect(input).toBeFocused();
  await input.fill(name);
  await input.press('Enter');
  await expect(header(page, name)).toHaveCount(1);
}

test('an ungrouped list looks exactly as it did before groups existed', async ({ pdServer, page }) => {
  const ids = await threeSessions(page, pdServer);
  expect(await listShape(page)).toEqual(ids);
  await expect(page.locator('.sl-group')).toHaveCount(0);
});

test('make a group, drag sessions in and out, and it survives a reload', async ({ pdServer, page }) => {
  const [a, b, c] = await threeSessions(page, pdServer);

  await addGroup(page, 'alpha');
  expect(await listShape(page)).toEqual(['[alpha]', '[Ungrouped]', a, b, c]);

  // Into the empty group: drop just under its header.
  await drag(page, row(page, c), 'below', header(page, 'alpha'));
  await expect.poll(() => listShape(page)).toEqual(['[alpha]', c, '[Ungrouped]', a, b]);

  // A second member, dropped ABOVE the first, so order within a group counts.
  await drag(page, row(page, a), 'above', row(page, c));
  await expect.poll(() => listShape(page)).toEqual(['[alpha]', a, c, '[Ungrouped]', b]);

  await expect.poll(async () => (await serverLayout(page)).groups[0].sessions).toEqual([a, c]);

  await page.reload();
  await waitForConnection(page);
  await openSessionList(page);
  await expect.poll(() => listShape(page)).toEqual(['[alpha]', a, c, '[Ungrouped]', b]);

  // And back out to Ungrouped.
  await drag(page, row(page, c), 'below', row(page, b));
  await expect.poll(() => listShape(page)).toEqual(['[alpha]', a, '[Ungrouped]', b, c]);
  await expect(header(page, 'alpha').locator('.sl-group-count')).toHaveText('1');
});

test('groups reorder by their own grip, and stay above Ungrouped', async ({ pdServer, page }) => {
  const [a, b] = await threeSessions(page, pdServer);
  await addGroup(page, 'beta');
  await addGroup(page, 'alpha');   // new groups go on top
  await drag(page, row(page, a), 'below', header(page, 'alpha'));
  await drag(page, row(page, b), 'below', header(page, 'beta'));
  await expect.poll(() => listShape(page)).toEqual(expect.arrayContaining(['[alpha]', '[beta]']));
  const before = await listShape(page);
  expect(before.indexOf('[alpha]')).toBeLessThan(before.indexOf('[beta]'));

  // Drag alpha past the bottom of the list: it moves with its session and
  // stops above Ungrouped.
  await drag(page, header(page, 'alpha'), 'below', page.locator('#sl-rows > *').last());
  await expect.poll(async () => {
    const shape = await listShape(page);
    return shape.slice(0, shape.indexOf('[Ungrouped]'));
  }).toEqual(['[beta]', b, '[alpha]', a]);
  await expect.poll(async () => (await serverLayout(page)).groups.map((g) => g.name)).toEqual(['beta', 'alpha']);
});

test('the arrow keys on a focused grip move rows and groups, across group lines', async ({ pdServer, page }) => {
  const [a, b, c] = await threeSessions(page, pdServer);
  await addGroup(page, 'beta');
  await addGroup(page, 'alpha');
  expect(await listShape(page)).toEqual(['[alpha]', '[beta]', '[Ungrouped]', a, b, c]);

  // a climbs out of Ungrouped into beta, then into alpha.
  await row(page, a).locator('.sl-grip').focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => listShape(page)).toEqual(['[alpha]', '[beta]', a, '[Ungrouped]', b, c]);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => listShape(page)).toEqual(['[alpha]', a, '[beta]', '[Ungrouped]', b, c]);
  // Already directly under the first header: nowhere further up.
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => listShape(page)).toEqual(['[alpha]', a, '[beta]', '[Ungrouped]', b, c]);
  await expect(row(page, a).locator('.sl-grip')).toBeFocused();

  // c moves up within Ungrouped.
  await row(page, c).locator('.sl-grip').focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => listShape(page)).toEqual(['[alpha]', a, '[beta]', '[Ungrouped]', c, b]);

  // A group moves down past its neighbour, taking its row with it, and
  // never below Ungrouped.
  await header(page, 'alpha').locator('.sl-grip').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => listShape(page)).toEqual(['[beta]', '[alpha]', a, '[Ungrouped]', c, b]);
  await expect.poll(async () => (await serverLayout(page)).groups.map((g) => g.name)).toEqual(['beta', 'alpha']);
});

test('moving a row into a collapsed group opens it and keeps the keyboard on the row', async ({ pdServer, page }) => {
  const [a, b, c] = await threeSessions(page, pdServer);
  await addGroup(page, 'shut');
  await drag(page, row(page, a), 'below', header(page, 'shut'));
  await header(page, 'shut').locator('.sl-group-toggle').click();
  await expect.poll(() => listShape(page)).toEqual(['[shut]', '[Ungrouped]', b, c]);

  // b steps up past Ungrouped's header into the collapsed group.
  await row(page, b).locator('.sl-grip').focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => listShape(page)).toEqual(['[shut]', a, b, '[Ungrouped]', c]);
  await expect(row(page, b).locator('.sl-grip')).toBeFocused();
  await expect(header(page, 'shut').locator('.sl-group-toggle')).toHaveAttribute('aria-expanded', 'true');
});

test('an edit made against a list another device changed is refused, not clobbering it', async ({ pdServer, page }) => {
  const [a, b] = await threeSessions(page, pdServer);
  await addGroup(page, 'mine');
  await expect.poll(async () => (await serverLayout(page)).groups.length).toBe(1);
  // Another device saves a different arrangement behind this page's back.
  await page.evaluate(async (b) => {
    const cur = await (await fetch('/layout')).json();
    await fetch('/layout', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups: [{ id: 'g-other', name: 'theirs', sessions: [b] }], baseRev: cur.rev }),
    });
  }, b);
  // This page has not polled yet, so its drag is made against the old list.
  await drag(page, row(page, a), 'below', header(page, 'mine'));
  await expect(page.locator('#sl-tools-msg')).toHaveText(/changed on another device/);
  await expect.poll(() => listShape(page)).toEqual(expect.arrayContaining(['[theirs]', b]));
  expect((await serverLayout(page)).groups.map((g) => g.name)).toEqual(['theirs']);
});

test('the n/m counter and the list agree on order', async ({ pdServer, page }) => {
  const [, , c] = await threeSessions(page, pdServer);
  await addGroup(page, 'top');
  await drag(page, row(page, c), 'below', header(page, 'top'));
  await expect.poll(() => listShape(page)).toContain(c);
  await row(page, c).locator('.sl-row').click();
  expect(await activeSessionId(page)).toBe(c);
  // c was created last but is now shown first.
  await expect(page.locator('#session-label')).toHaveText(/^1\/3/);
});

test('collapse hides a group\'s rows; rename, remove, and Undo', async ({ pdServer, page }) => {
  const [a, b, c] = await threeSessions(page, pdServer);
  await addGroup(page, 'work');
  await drag(page, row(page, a), 'below', header(page, 'work'));
  await expect.poll(() => listShape(page)).toEqual(['[work]', a, '[Ungrouped]', b, c]);

  await header(page, 'work').locator('.sl-group-toggle').click();
  await expect.poll(() => listShape(page)).toEqual(['[work]', '[Ungrouped]', b, c]);
  await expect(header(page, 'work').locator('.sl-group-toggle')).toHaveAttribute('aria-expanded', 'false');
  await header(page, 'work').locator('.sl-group-toggle').click();
  await expect.poll(() => listShape(page)).toEqual(['[work]', a, '[Ungrouped]', b, c]);

  await header(page, 'work').locator('[aria-label="Rename group"]').click();
  await page.locator('.sl-group-input').fill('deephive');
  await page.locator('.sl-group-input').press('Enter');
  await expect(header(page, 'deephive')).toHaveCount(1);

  // Escape while renaming cancels the rename and leaves the list open.
  await header(page, 'deephive').locator('[aria-label="Rename group"]').click();
  await page.locator('.sl-group-input').fill('nope');
  await page.locator('.sl-group-input').press('Escape');
  await expect(header(page, 'deephive')).toHaveCount(1);
  expect(await page.evaluate(() => document.body.dataset.view)).toBe('list');

  await header(page, 'deephive').locator('[aria-label="Remove group"]').click();
  await expect.poll(() => listShape(page)).toEqual([a, b, c]);
  await page.click('#sl-undo');
  await expect.poll(() => listShape(page)).toEqual(['[deephive]', a, '[Ungrouped]', b, c]);
  await expect(page.locator('#sl-undo')).toBeHidden();
});

test('Autogroup asks the model through the real CLI path, and Undo puts it back', async ({ pdServerClaudeStub, page }) => {
  const ids = await threeSessions(page, pdServerClaudeStub);
  await page.click('#sl-autogroup');
  // The stub groups the first two ids it is shown; see stub-bin/claude.
  await expect.poll(() => listShape(page)).toEqual(['[stubbed]', ids[0], ids[1], '[Ungrouped]', ids[2]]);
  await expect(page.locator('#sl-tools-msg')).toHaveText('Grouped 2 sessions into 1 group.');
  await page.click('#sl-undo');
  await expect.poll(() => listShape(page)).toEqual(ids);
  await expect.poll(async () => (await serverLayout(page)).groups).toEqual([]);
});
