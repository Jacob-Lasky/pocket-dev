# Live selection, mobile composer and reconnect rendering verification

Recorded 2026-09-09. Implementation and screenshots were exercised in isolated
local servers with real tmux, Claude Code and Codex. Production remains unchanged
until the deployment review is approved.

## Diagnosis and reproduction

- An ordinary drag over a mouse-tracking TUI selected an empty string. The same
  gesture now selects text without entering another view. The prior copy test
  called `selectAll()` and did not exercise this gesture.
- Mobile input was single-line and cleared before delivery succeeded. The new
  browser tests exercise multiline input, cursor editing, failed requests,
  drafts across switches/reloads, edits during a send, and two pending sessions.
- Live Codex exposed `0;276;0c` in the next prompt after reconnect. Replaying
  tmux's DA2 request generated a reply after the request had expired. All replay
  is now paint-only, and one connected browser answers each new live request.
- The full suite also exposed a launch failure under a pre-existing fish tmux
  server: shell startup reordered PATH and launched real Claude instead of the
  test harness. Explicit PATH forwarding and direct `/bin/bash -c` arguments
  make the intended command independent of tmux's default shell.

## Automated evidence

Local checks: `node node_modules/vitest/vitest.mjs run` and
`node node_modules/@playwright/test/cli.js test --project=chromium --project=firefox`.
Results: 478 unit/server tests passed; 147 browser tests passed, 13 skipped for
their existing browser/platform conditions.
The GitHub workflow additionally runs WebKit on Ubuntu; local Arch cannot run
that browser's bundled runtime.

Reconnect regression evidence recorded 2026-09-10:

- The final local suites passed 484 unit/server tests and 149 Chromium/Firefox
  browser tests, with 13 existing browser/platform skips. WebKit remains in the
  GitHub Actions matrix.
- The captured production replay for `main-133` was 656,731 bytes. Its retained
  suffix began in ordinary text, carried no erase-display sequence and visibly
  rebuilt duplicated, interleaved rows in a 390 px Chromium viewport.
- `sessionsRestore.test.js` failed before the fix because `attachWs` sent the
  replay without requesting a tmux refresh. It now pins replay-before-refresh
  ordering and verifies an empty session does not request a needless repaint.
- `mobile-render-order.spec.js` draws a Claude-shaped full-screen frame at the
  browser's actual mobile dimensions, evicts that base frame with more than the
  512 KB replay window of one-row differential updates, then closes the live
  socket and reconnects with the exact same terminal grid. The reconnect ends
  with one coherent frame only because the authoritative tmux repaint follows
  the context-dependent suffix.

Shared-grid regression evidence recorded 2026-09-12:

- The pre-fix server witness received only `pty:132x51`; after the change it
  receives `first:grid`, `second:grid`, then `pty:132x51`.
- All 565 unit/server tests passed. The matching Playwright 1.61.1 container
  passed 153 Chromium/Firefox browser tests with 15 expected platform skips.
- `multi-client-grid.spec.js` passed in Chromium and Firefox with a 390 px
  phone and 1100 px desktop attached to one session. Both final screenshots
  stamp the same authoritative grid on visibly different viewports.

Residual rendering follow-up recorded 2026-09-12:

- On broken `13049b0`, 252 output frames reached the browser while only one
  `term.write` was submitted when xterm's first parser timer was held. Serial
  submission behind each callback converted xterm's batched stream into one
  browser-timer turn per frame.
- Adjacent output is now submitted after one structural barrier, while reset,
  grid and resize still wait for all prior callbacks. The connected witness
  passed in Chromium and WebKit without increasing its timeout.
- A second server witness proved that any connected browser could still mutate
  the one PTY grid. The first grid-capable socket owns resize authority until a
  later active foreground client claims before every fit; later connections
  cannot steal it merely by reconnecting, stale and passive local fits are
  ignored, owner close transfers authority, and pre-grid clients retain
  compatibility.
- The combined browser witness passed three of three cases in Chromium and
  WebKit. It transfers ownership phone to desktop and back, switches sessions
  while a claim is queued, exercises two simultaneously focused devices,
  verifies claim precedes resize, and requires both exact screens to match the
  shared grid.
- The complete post-fix suite passed 567 unit and server checks plus 229 browser
  checks across Chromium, Firefox and WebKit, with 26 expected platform or
  opt-in artifact skips. The WebKit phone and desktop screenshots both show one
  exact `128 x 43` current frame with no retained rows. The focused desktop
  keeps ownership when the passive phone reconnects.

The first CI matrix passed 216 browser tests and exposed one WebKit console
error: it rejects the `interactive-widget` viewport key. That key was removed;
the existing visualViewport resize handler remains responsible for keyboard
geometry. The console-error test was kept intact.

Named bug witnesses and mutation evidence:

- `sessionsRestore.test.js` and `multi-client-grid.spec.js`: two clients at
  different viewport sizes previously retained different xterm grids while
  sharing one resized PTY, and could continue overwriting one another after
  publication was added. The server witness now requires ownership before a
  resize, grid broadcast before PTY mutation, transfer on close, and pre-grid
  compatibility. The browser witness holds xterm's parser timer across more
  than 250 old-grid chunks while a second client resizes, then requires batched
  submission, focus-driven ownership in both directions, exact coherent screens,
  and the same contract after reconnect.
- `live-selection.spec.js`: ordinary drag failed before the pointer bridge and
  passed after it. Cold review also verified that forcing Alt on Linux causes
  rectangular selection; the implementation uses Shift there and Option on Mac.
- `replay-queries.spec.js`: removing the `frame.reply` guard makes historical
  replay produce a second reply and concurrent browsers produce duplicate
  replies. Both tests failed as assertions, then passed with the guard restored.
- The reply tests use a real outer node-pty. An inner query fixture cannot prove
  this boundary because tmux answers an inner application's DA2 request itself.
- `titles.spec.js`: failed by launching the wrong real harness under fish,
  then passed in both local browsers after the PATH/direct-exec correction.

Adjacent guards cover real Chromium touch gestures and clipboard contents,
selection handles including wide characters, TUI short clicks, keyboard/paste
while a reply is pending, responder failover, unanswered offline queries,
viewport geometry and preservation of unrelated per-session behavior. Tests
for the deleted Select overlay and HTML renderer were removed with that code;
parsed-cell spacing, soft wraps, colors, Unicode and captured Claude frames
remain covered. These guards are not presented as additional baseline failures.

## Real agents and visual artifacts

- Claude Code 2.1.265 / Opus 5 accepted a multiline message and replied
  `PEACH ORBIT.`; an ordinary desktop mouse drag selected that exact response.
- Fresh Claude Code 2.1.266 / Opus 5 accepted `ORCHID` and `GARDEN` on separate
  lines after a deliberately late first attach; its actual response was
  `The ORCHID bloomed in the GARDEN.` No terminal handshake entered the prompt.
- Fresh Codex 0.153.4 / gpt-5.6-sol accepted a multiline `MELON` / `GROVE`
  message and replied `MELON GROVE.` after a late first attach, a second browser
  joining, and a reload. No terminal handshake entered the prompt.

Screenshots are kept in `mobile/test-artifacts/` and copied into the Lavish
review: `live-claude-desktop-selection.png`, `live-claude-mobile.png`,
`live-codex-mobile-reconnect.png`, `mobile-live-selection.png`,
`mobile-composer.png`, `reported-mobile-replay.png` and
`mobile-render-order-chromium.png` / `mobile-render-order-firefox.png`. They are
actual browser captures, not mockups.

## Independent review and limits

A cold same-model reviewer independently found and rechecked fixes for Alt
selection, touch clicks, Unicode handle bounds and per-session pending sends.
Its final replay probes verified silent first/offline attach, one live reply
with two browsers, responder failover, dropped replies staying dropped, and
live queries still working when history trims to an empty buffer. The same
probes failed under the deliberate mutation. A different-lab review was not
available through the installed Codex-to-Claude second-opinion workflow.

Silent tmux negotiation preserves rendering and inner DA/CPR responses. Without
a browser present at startup, focus reporting may wait for tmux's five-second
fallback. Selection tracks the current terminal screen as output changes;
it does not freeze a conversation transcript.

Physical Android/iOS keyboard behavior and long-press behavior in an actual
Firefox Android installation still need the device checklist in
`mobile/MANUAL-VERIFICATION.md`. Browser touch emulation and reduced viewports
do not prove a physical phone's keyboard or browser chrome behavior.

Senior review: approved for a draft PR. No remaining concrete DRY or correctness
finding; one live renderer replaces the second Select renderer. Added complexity
is limited to selection gestures, draft delivery and the documented input hook.
Visual evidence, named failures and mutation-verified replay guards are above.
