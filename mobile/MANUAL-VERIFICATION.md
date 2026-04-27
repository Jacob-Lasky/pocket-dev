# pocket-dev — Manual Verification

Run before tagging a release. Items here can't be reliably automated.

## Real device — Pixel + Firefox
- [ ] Open pocket-dev over the LAN (HTTP, not localhost). Default mode is View.
- [ ] Long-press a word in View → drag selection handles → tap system Copy.
- [ ] Paste somewhere else: text matches what was selected, no trailing whitespace.
- [ ] Scroll View pane: smooth, native momentum scrolling. No horizontal scrollbar.
- [ ] Tap Live → terminal renders. Tap View → wrapped reading view returns.
- [ ] Type via the existing HTML input bar: keystrokes reach the inner Claude session in both modes.

## Desktop — HTTP (not localhost)
- [ ] Highlight text in Live xterm.js with mouse → release → paste in another window: copies.
- [ ] Ctrl+Shift+C copies the current selection if one exists; pass-through to terminal otherwise.
- [ ] Click 📋 toolbar button → entire scrollback copied with no trailing whitespace per line.

## Alt-screen behavior
- [ ] Run a real Claude Code session for 5+ minutes including long responses, tool calls, and exits.
- [ ] Scroll back through the session: no duplicated chunks of history.
- [ ] When Claude exits and restarts (the LOOP_CMD), the prior output stays in scrollback (alternate-screen off behavior).

## Focus events
- [ ] Switch browser tab away from pocket-dev for 30 seconds, then back.
- [ ] Claude Code's UI redraws cleanly (no stuck cursor, no stale spinner).
