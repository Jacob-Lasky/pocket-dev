// The toolbar: where the session title lives, what the toolbar defaults to,
// and the two-tap guard on Kill.
//
// Kill sits on a row people thumb blindly, between Refresh and the arrow keys,
// and what it destroys is a live Claude session. A single stray tap being
// enough to do that was the complaint, so the arming step is a safety property
// and is tested as one: the negative case (one tap does NOT kill) matters more
// than the positive.

import { test, expect, gotoTest, gotoRaw, waitForConnection, openSessionList, newSession, sessionRows, waitForPanes } from './fixtures.js';

const DESKTOP = { width: 1280, height: 800 };
const PHONE   = { width: 390, height: 780 };

test('the session title sits above the terminal, not in the toolbar', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);

  // Structural, not cosmetic: inside #btn-group the title would disappear with
  // the toolbar, taking the only way into the session list with it.
  const placement = await page.evaluate(() => {
    const label = document.getElementById('session-label');
    return {
      inTopbar:  !!label.closest('#topbar'),
      inBtnGroup: !!label.closest('#btn-group'),
      inControls: !!label.closest('#controls'),
    };
  });
  expect(placement).toEqual({ inTopbar: true, inBtnGroup: false, inControls: false });

  const above = await page.evaluate(() => {
    const label = document.getElementById('session-label').getBoundingClientRect();
    const term  = document.getElementById('terminal-container').getBoundingClientRect();
    return label.bottom <= term.top + 1;
  });
  expect(above).toBe(true);
});

test('the title stays visible and clickable with the toolbar collapsed', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);

  await page.evaluate(() => {
    if (!document.getElementById('btn-group').classList.contains('collapsed')) toggleCollapse();
  });
  await expect(page.locator('#btn-group')).toHaveClass(/collapsed/);
  await expect(page.locator('#session-label')).toBeVisible();

  await page.click('#session-label');
  await expect.poll(() => page.evaluate(() => document.body.dataset.view)).toBe('list');
});

test('the toolbar starts expanded on desktop and collapsed on a phone', async ({ pdServer, browser }) => {
  for (const [name, viewport, wantCollapsed] of [['desktop', DESKTOP, false], ['phone', PHONE, true]]) {
    const ctx  = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    // gotoRaw, not gotoTest: gotoTest seeds the preference and the default only
    // applies when it is absent.
    await gotoRaw(page, pdServer);
    await waitForConnection(page);
    const collapsed = await page.evaluate(() =>
      document.getElementById('btn-group').classList.contains('collapsed'));
    expect(collapsed, `${name} default`).toBe(wantCollapsed);
    await ctx.close();
  }
});

test('an explicit collapse choice beats the per-form-factor default', async ({ pdServer, browser }) => {
  const ctx  = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  await gotoRaw(page, pdServer);
  await waitForConnection(page);
  await expect(page.locator('#btn-group')).not.toHaveClass(/collapsed/);

  await page.click('#collapse-btn');
  await expect(page.locator('#btn-group')).toHaveClass(/collapsed/);

  await page.reload();
  await waitForConnection(page);
  // Desktop would default to expanded; the stored choice has to win.
  await expect(page.locator('#btn-group')).toHaveClass(/collapsed/);
  await ctx.close();
});

test('one tap on the kill button does NOT kill the session', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await newSession(page);
  await waitForPanes(page, 2);
  await waitForConnection(page);
  expect(await sessionRows(page)).toHaveLength(2);

  const btn = page.locator('#kill-btn');
  await expect(btn).toHaveText('✕');
  await btn.click();
  await expect(btn).toHaveText('Kill?');

  // Give a kill every chance to have happened before declaring it did not.
  await page.waitForTimeout(1500);
  expect(await sessionRows(page)).toHaveLength(2);
});

test('two taps kill the session', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await newSession(page);
  await waitForPanes(page, 2);
  await waitForConnection(page);

  const btn = page.locator('#kill-btn');
  await btn.click();
  await expect(btn).toHaveText('Kill?');
  await btn.click();

  await expect.poll(async () => (await sessionRows(page)).length, { timeout: 10000 }).toBe(1);
  // And it disarms afterwards, so the next stray tap is not a second kill.
  await expect(btn).toHaveText('✕');
});

test('an armed kill does not follow you to another session', async ({ pdServer, page }) => {
  // The dangerous shape: arm on A, switch to B, tap once more. Without a
  // disarm on switch, that second tap destroys B, which the user never armed.
  //
  // Switches via the Ctrl-B n prefix, NOT the session list, on purpose.
  // openSessionList() also disarms, so a list-driven switch would pass this
  // test with the disarm in setActive() deleted, and the prefix keys are a real
  // way to change session without the list ever opening.
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await newSession(page);
  await waitForPanes(page, 2);
  await waitForConnection(page);

  const before = await page.evaluate(() =>
    document.querySelector('.terminal-pane.active')?.dataset.sessionId);

  const btn = page.locator('#kill-btn');
  const startedAt = Date.now();
  await btn.click();
  await expect(btn).toHaveText('Kill?');

  // Focus AFTER arming: clicking the button takes focus off the terminal, and
  // the prefix keys only reach maybeHandlePrefix through xterm's textarea.
  // Everything from here is kept short so the arm-to-assert window stays far
  // under KILL_ARM_MS (4000) — otherwise the auto-disarm timer fires on its
  // own and this test passes against code with the setActive disarm deleted,
  // which is exactly what happened the first time it was written.
  await page.locator('.terminal-pane.active .xterm-helper-textarea').focus();
  await page.keyboard.press('Control+b');
  await page.keyboard.press('n');

  await expect
    .poll(() => page.evaluate(() => document.querySelector('.terminal-pane.active')?.dataset.sessionId),
          { timeout: 1500 })
    .not.toBe(before);

  // The switch disarmed it, so this tap only re-arms and destroys nothing.
  // Short timeout on purpose: the default would sit here long enough for the
  // KILL_ARM_MS timer to disarm the button by itself and report a pass.
  await expect(btn).toHaveText('✕', { timeout: 1000 });
  const elapsed = Date.now() - startedAt;
  expect(elapsed, 'arm window must not have expired on its own').toBeLessThan(2500);

  await btn.click();
  await expect(btn).toHaveText('Kill?');
  await page.waitForTimeout(1000);
  expect(await sessionRows(page)).toHaveLength(2);
});

test('opening the session list also disarms a pending kill', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);

  const btn = page.locator('#kill-btn');
  await btn.click();
  await expect(btn).toHaveText('Kill?');

  await openSessionList(page);
  await expect.poll(() => page.evaluate(() => document.body.dataset.view)).toBe('list');
  await expect(btn).toHaveText('✕');
});

test('an armed kill disarms itself if you walk away', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);

  const btn = page.locator('#kill-btn');
  await btn.click();
  await expect(btn).toHaveText('Kill?');
  // KILL_ARM_MS is 4000; poll past it rather than sleeping an exact amount.
  await expect(btn).toHaveText('✕', { timeout: 8000 });
});
