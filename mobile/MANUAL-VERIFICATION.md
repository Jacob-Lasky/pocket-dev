# pocket-dev — Manual Verification

Run before tagging a release. Items here can't be reliably automated.

## Real device — Pixel + Firefox
- [ ] Open pocket-dev over the LAN (HTTP, not localhost). Default mode is View.
- [ ] In View, with Claude's banner/TUI on screen, words are separated by real spaces (NOT run together). This is the CHA-positioned-text fix; verify on the "trust this folder?" prompt or any boxed/indented output.
- [ ] View preserves Claude's colours (headers, diffs, syntax).
- [ ] While Claude is actively streaming a long response in View, long-press and drag to select text: the selection survives incoming output (does not keep getting wiped).
- [ ] Long-press a word in View → drag selection handles → tap system Copy. Paste elsewhere: text matches, no trailing whitespace.
- [ ] Scroll View pane: smooth, native momentum scrolling. No horizontal scrollbar.
- [ ] Tap Live → terminal renders. Tap View → wrapped reading view returns.
- [ ] If the Live terminal ever renders jumbled, it self-corrects on rotate/resize (ResizeObserver auto-refit); tapping ⟳ also fixes it.
- [ ] Type via the existing HTML input bar: keystrokes reach the inner Claude session in both modes.

## Desktop — HTTP (not localhost)
- [ ] Highlight text in Live xterm.js with mouse → release → paste in another window: copies.
- [ ] Ctrl+Shift+C copies the current selection if one exists; pass-through to terminal otherwise.
- [ ] In View, click 📋 toolbar button → only the VISIBLE window is copied (not the whole scrollback), as clean text: real spaces, no escape/cursor codes, no big runs of blank lines.
- [ ] Scroll up in View, then click 📋 → copies what's on screen at that scroll position.

## Alt-screen behavior
- [ ] Run a real Claude Code session for 5+ minutes including long responses, tool calls, and exits.
- [ ] Scroll back through the session: no duplicated chunks of history.
- [ ] When Claude exits and restarts (the LOOP_CMD), the prior output stays in scrollback (alternate-screen off behavior).

## Focus events
- [ ] Switch browser tab away from pocket-dev for 30 seconds, then back.
- [ ] Claude Code's UI redraws cleanly (no stuck cursor, no stale spinner).
