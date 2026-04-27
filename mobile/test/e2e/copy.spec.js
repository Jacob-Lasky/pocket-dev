import { test, expect, gotoTest, waitForConnection } from './fixtures.js';

test.use({
  permissions: ['clipboard-read', 'clipboard-write'],
});

test('Copy button writes terminal output to clipboard with no trailing whitespace', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);

  await page.fill('#cmd-input', 'clipboard-test-marker');
  await page.click('#send-btn');
  await page.waitForTimeout(500);

  await page.click('#copy-btn');
  await page.waitForTimeout(200);

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('clipboard-test-marker');
  // No line should have trailing whitespace
  for (const line of clip.split('\n')) {
    expect(line).not.toMatch(/[ \t]+$/);
  }
});

test('drag-selecting in xterm.js auto-copies via onSelectionChange', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await page.fill('#cmd-input', 'drag-select-marker');
  await page.click('#send-btn');
  await page.waitForTimeout(500);

  await page.evaluate(() => window.term.selectAll());
  await page.waitForTimeout(100);

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('drag-select-marker');
});

test('HTTP fallback path: when navigator.clipboard rejects, execCommand runs', async ({ pdServer, page }) => {
  await gotoTest(page, pdServer);
  await waitForConnection(page);

  // Patch navigator.clipboard to always reject so the fallback path runs
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('simulated http')) },
      configurable: true,
    });
    window.__execCommandCalls = [];
    const orig = document.execCommand.bind(document);
    document.execCommand = (cmd) => {
      window.__execCommandCalls.push(cmd);
      return orig(cmd);
    };
  });

  await page.fill('#cmd-input', 'fallback-marker');
  await page.click('#send-btn');
  await page.waitForTimeout(500);
  await page.click('#copy-btn');
  await page.waitForTimeout(200);

  const calls = await page.evaluate(() => window.__execCommandCalls);
  expect(calls).toContain('copy');
});
