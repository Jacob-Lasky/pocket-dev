// TEMPORARY PROBE, not part of the suite. Answers one question about the
// webkit-only failure of "when only the server process restarts, sessions
// reattach with their scrollback": does the marker count SETTLE at the right
// value and the assertion merely sample too early, or does it settle wrong?
//
// CI has failed this test in both directions (Received 1 on PR #18, Received 4
// on PR #23), which is the signature of sampling a moving value, but 4 is also
// exactly what a double replay would produce. Those need different fixes, so
// measure instead of guessing. Delete this file once the answer is recorded.

import { test, expect, gotoTest, waitForConnection, sendAndWaitForEcho } from './fixtures.js';

const MARK = 'survives-node-restart-ECHO';

async function markerCount(page) {
  return page.evaluate((m) => {
    const t = window.term;
    if (!t) return -1;
    const buf = t.buffer.normal;
    let n = 0;
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line && line.translateToString(true).includes(m)) n++;
    }
    return n;
  }, MARK);
}

test('PROBE: how the marker count evolves after a server restart', async ({ pdServer, page }) => {
  test.setTimeout(90000);
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await sendAndWaitForEcho(page, MARK);

  const before = await markerCount(page);

  await pdServer.restart();
  await waitForConnection(page);

  // Sample densely for 10s and report the whole series, so a transient spike is
  // distinguishable from a wrong steady state.
  const series = [];
  for (let i = 0; i < 100; i++) {
    series.push(await markerCount(page));
    await page.waitForTimeout(100);
  }

  const settled = series.slice(-20);
  const distinct = [...new Set(series)];
  console.log(`PROBE before=${before}`);
  console.log(`PROBE series=${series.join(',')}`);
  console.log(`PROBE distinct=${distinct.join(',')} settled=${[...new Set(settled)].join(',')}`);
  expect(before).toBeGreaterThan(0);
});
