// TEMPORARY PROBE, not part of the suite. Delete once the answer is recorded.
//
// Established so far: after a server restart the marker count settles
// PERMANENTLY at 4 (sometimes 6) in CI on all three browsers, and at 2 locally
// on firefox. So it is not a sampling race and not webkit-specific; something
// about the CI environment makes the reattach paint the screen more than once.
//
// Hypothesis under test: the duplication is tmux REPAINTING on a resize. The
// server's replay buffer accumulates every byte the pty emits, so each full
// repaint appends another copy of the screen. With the `cat` fixture there is
// no cursor addressing to overwrite in place, so copies stack as plain lines.
// If so, forcing a resize after the reconnect should reproduce it locally.

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

// Record every byte the pane receives, so the repaint can be inspected as bytes
// rather than inferred from what rendered.
async function installWsRecorder(page) {
  await page.addInitScript(() => {
    window.__wsLog = [];
    const Native = window.WebSocket;
    window.WebSocket = function (...args) {
      const ws = new Native(...args);
      window.__wsLog.push({ t: Date.now(), kind: 'open-called', url: String(args[0]) });
      ws.addEventListener('message', (e) => {
        const d = e.data;
        if (typeof d === 'string') window.__wsLog.push({ t: Date.now(), kind: 'msg', text: d });
        else window.__wsLog.push({ t: Date.now(), kind: 'msg-bin', text: '' });
      });
      ws.addEventListener('close', (e) => window.__wsLog.push({ t: Date.now(), kind: 'close', code: e.code }));
      return ws;
    };
    window.WebSocket.prototype = Native.prototype;
    Object.assign(window.WebSocket, Native);
  });
}

const esc = (s) => s.replace(/\x1b/g, '<ESC>').replace(/\r/g, '<CR>').replace(/\n/g, '<LF>');

// Same count, but restricted to the rows currently ON SCREEN. Scrollback grows
// with every legitimate tmux repaint; the visible screen should not.
async function visibleMarkerCount(page) {
  return page.evaluate((m) => {
    const t = window.term;
    if (!t) return -1;
    const buf = t.buffer.normal;
    const count = (from) => {
      let n = 0;
      for (let i = from; i < from + t.rows; i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString(true).includes(m)) n++;
      }
      return n;
    };
    const dom = (document.querySelector('#terminal-container').innerText.split(m).length - 1);
    return `base=${count(buf.baseY)} viewport=${count(buf.viewportY)} dom=${dom} baseY=${buf.baseY} viewportY=${buf.viewportY} rows=${t.rows} len=${buf.length}`;
  }, MARK);
}

test('PROBE: does a resize after reconnect duplicate the screen', async ({ pdServer, page }) => {
  test.setTimeout(120000);
  await installWsRecorder(page);
  await gotoTest(page, pdServer);
  await waitForConnection(page);
  await sendAndWaitForEcho(page, MARK);
  console.log(`PROBE before scroll=${await markerCount(page)} visible=${await visibleMarkerCount(page)}`);

  await pdServer.restart();
  await waitForConnection(page);
  await page.waitForTimeout(3000);
  console.log(`PROBE afterRestart scroll=${await markerCount(page)} visible=${await visibleMarkerCount(page)}`);

  // Force a resize, which makes tmux repaint the whole screen.
  await page.setViewportSize({ width: 700, height: 900 });
  await page.waitForTimeout(2500);
  console.log(`PROBE afterResize1 scroll=${await markerCount(page)} visible=${await visibleMarkerCount(page)}`);

  await page.setViewportSize({ width: 500, height: 700 });
  await page.waitForTimeout(2500);
  console.log(`PROBE afterResize2 scroll=${await markerCount(page)} visible=${await visibleMarkerCount(page)}`);

  const log = await page.evaluate(() => window.__wsLog || []);
  const opens  = log.filter(e => e.kind === 'open-called').length;
  const closes = log.filter(e => e.kind === 'close').length;
  console.log(`PROBE sockets opened=${opens} closed=${closes}`);

  const withMark = log.filter(e => e.kind === 'msg' && e.text.includes(MARK));
  console.log(`PROBE messages containing marker=${withMark.length}`);
  withMark.slice(0, 8).forEach((e, i) => {
    console.log(`PROBE msg[${i}] len=${e.text.length} :: ${esc(e.text).slice(0, 300)}`);
  });

  expect(true).toBe(true);
});
