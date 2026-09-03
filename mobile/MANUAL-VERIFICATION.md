# pocket-dev — Manual Verification

Run before tagging a release. Items here can't be reliably automated.

## Real device — phone + Firefox (the primary target; Playwright Firefox can't emulate touch, so THIS is the only proof the mobile scroll path works on Gecko)

Live-scroll — the core of the mobile experience:
- [ ] Open pocket-dev over the LAN (HTTP, not localhost). Default mode is **Live** (no auto-switch to Select).
- [ ] With a real Claude session on screen and a transcript longer than the viewport, **one-finger drag DOWN** → older conversation scrolls into view; **drag UP** → back toward the latest. This must feel like scrolling Claude on the desktop (it forwards wheel events to Claude; Claude shows its own `Jump to bottom` affordance).
- [ ] The drag does NOT leave stray clicks/selection in Claude, and does NOT trigger Firefox pull-to-refresh or overscroll bounce (that's what `touch-action: none` on the pane prevents — if it bounces, that setting regressed).
- [ ] A quick TAP (not drag) still lets the input bar/keyboard work; a two-finger pinch still changes font size.
- [ ] In a plain shell session (exit Claude, or a shell tab) a one-finger drag scrolls xterm's own scrollback smoothly.

Select overlay + copy:
- [ ] Tap **Select** → the current screen renders as wrapped text; tap Select again → back to Live.
- [ ] In Select, words are separated by real spaces (NOT run together) on boxed/indented output — the CHA-positioned-text fix. Colours preserved.
- [ ] Long-press a word in Select → drag handles → system Copy → paste elsewhere: text matches, no trailing whitespace. (Over LAN HTTP the clipboard API is unavailable; the `execCommand` fallback must still copy.)
- [ ] While Claude streams, a held selection in Select survives incoming output (isn't wiped).
- [ ] Scroll the Select overlay: smooth native momentum, no horizontal scrollbar.
- [ ] 📋 in Live copies the current screen as clean text; 📋 in Select copies the visible rows.

General:
- [ ] Type via the HTML input bar: keystrokes reach Claude in both Live and Select.
- [ ] If Live ever renders jumbled, it self-corrects on rotate/resize (ResizeObserver auto-refit); tapping ⟳ also fixes it.

## Desktop — Firefox, HTTP (not localhost)
- [ ] Mouse-wheel over Live scrolls Claude's transcript (unchanged baseline).
- [ ] Highlight text in Live with the mouse → release → paste in another window: copies.
- [ ] Ctrl+Shift+C copies the current selection if one exists; pass-through to terminal otherwise.
- [ ] Tap Select, click 📋 → only the VISIBLE rows are copied, clean: real spaces, no escape/cursor codes, no big runs of blank lines.

## Alt-screen / scroll behavior
- [ ] Run a real Claude Code session for 5+ minutes including long responses, tool calls, and exits.
- [ ] Scroll back through the session (drag in Live): no duplicated chunks, reaches the top of Claude's transcript, returns cleanly to the bottom.
- [ ] When Claude exits and restarts (the LOOP_CMD), prior plain-shell output stays in xterm scrollback (outer alternate-screen-off behavior).

## Session restore across a restart (needs a real Claude; the e2e fixture runs `cat` and has no conversation to resume)
- [ ] Open two or three tabs. In one, ask Claude something long-running so it is mid-tool-call; in another, let it finish and sit waiting on you.
- [ ] `docker restart pocket-dev` without touching the browser. Every tab comes back under the same id, and the page reconnects on its own (no reload, dots go green).
- [ ] The tab that was mid-work resumes its conversation and picks the work back up on its own, having been asked "continue please" exactly once (it arrives as Claude's first message, not as keystrokes — check the transcript shows one such user turn, not two).
- [ ] The tab that was waiting on you resumes its conversation and just sits there. Nothing is typed into it.
- [ ] No tab comes back sitting on "Quick safety check: is this a project you trust?" — pd-trust-workspace clears that at boot. If one does, restore still worked but every tab needs a keypress, so treat it as a regression.
- [ ] Now kill it the hard way (`docker kill pocket-dev`, or trigger a real OOM) with a session mid-task. The tab and conversation still come back, but the session is WARNED about the unexpected shutdown instead of being told to continue. This is the one that matters: auto-continuing after an OOM tells Claude to rebuild whatever took the host down.
- [ ] Type `/exit` in a restored tab. The loop restarts Claude with a NEW conversation, not the one you just left.
- [ ] Kill a tab, restart the container: it stays killed, and its conversation is not resumed into a new tab.
- [ ] `docker stop` + `docker rm` + `docker run` (a recreate) with the `Session State` volume mounted: tabs still come back. Without the mount they do not — expected, and the reason the volume exists.

## Archived-elsewhere close (no automated test can reach this: it needs a real bridged conversation and a real archive action in another app)
- [ ] Open a fresh tab, send Claude one message so the conversation exists, and confirm the tab appears in the Remote Control list on the phone or at claude.ai/code.
- [ ] Let the turn FINISH (the tab must not be mid-work), then archive that conversation from the Claude Code desktop app.
- [ ] Within one poll (a few seconds, with the browser open) the tab disappears from the strip and the session list. No dead pane is left behind, and the pane you were on does not go blank: `4404` makes the browser re-read the roster instead of retrying.
- [ ] `docker logs pocket-dev` carries one line naming it: `[main-N] archived from another device, closing the tab`. That line is the artifact; there is no pane left to read.
- [ ] Open a new tab and run `/resume`: the archived conversation is still in the picker. Closing the tab must never cost the conversation, only its pane.
- [ ] Now archive a conversation while its tab is MID-TURN. The tab stays until the turn ends, then closes on the next poll. A tab killed mid-tool-call is the one failure mode with no record of what was lost.
- [ ] `docker restart pocket-dev` with an archived-then-continued conversation open (archive it, then send it another message so work follows the notice). It comes back and STAYS open: the notice is seeded at adopt, so a restart is not a second archive. If restarting closes tabs, the seed regressed and every restart will keep eating them.

## Lavish Editor reachability (nothing in CI starts the real CLI, binds its socket, or crosses the published port — see "Lavish Editor" in CLAUDE.md)
- [ ] In a session (NOT `docker exec` — that gets the image's env, not PID 1's, and binds loopback), run `lavish-axi` on a small HTML file. It prints JSON with `status: opened` and a URL whose host is `LAVISH_AXI_LINK_HOST`, not a `172.x` bridge address.
- [ ] Open that URL on the phone: the artifact renders, elements can be annotated, and a Mermaid diagram opens as a whiteboard.
- [ ] `lavish-axi poll <file>` in the session returns the feedback that was sent from the phone.
- [ ] Typing a host name that is NOT the link host gives Lavish's `403` page naming the URL that does work — that's the DNS-rebinding guard, not a broken mapping. Add the name to `LAVISH_AXI_ALLOWED_HOSTS` if you want it to work.
- [ ] Check the bind address is the container's own: `LAVISH_AXI_HOST` in the session's environment matches `eth0`, and it is neither `127.0.0.1` nor a wildcard. On a container attached to several networks, `entrypoint.sh` warns on stderr which one it picked — read `docker logs` before assuming the port mapping is wrong.

## Focus events
- [ ] Switch browser tab away from pocket-dev for 30 seconds, then back.
- [ ] Claude Code's UI redraws cleanly (no stuck cursor, no stale spinner).
