# Live selection and mobile composer verification

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

Named bug witnesses and mutation evidence:

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
`mobile-composer.png`. They are actual browser captures, not mockups.

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
