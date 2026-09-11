# pocket-dev — Manual Verification

Run before tagging a release. Items here can't be reliably automated.

## Real device — phone + Firefox (the primary target; Playwright Firefox can't emulate touch, so THIS is the only proof the mobile scroll path works on Gecko)

Live-scroll — the core of the mobile experience:
- [ ] Open pocket-dev over the LAN (HTTP, not localhost). The live terminal is the only view; there is no Select button.
- [ ] With a real Claude session on screen and a transcript longer than the viewport, **one-finger drag DOWN** → older conversation scrolls into view; **drag UP** → back toward the latest. This must feel like scrolling Claude on the desktop (it forwards wheel events to Claude; Claude shows its own `Jump to bottom` affordance).
- [ ] The drag does NOT leave stray clicks/selection in Claude, and does NOT trigger Firefox pull-to-refresh or overscroll bounce (that's what `touch-action: none` on the pane prevents — if it bounces, that setting regressed).
- [ ] A quick TAP (not drag) still lets the input bar/keyboard work; a two-finger pinch still changes font size.
- [ ] In a plain shell session (exit Claude, or a shell tab) a one-finger drag scrolls xterm's own scrollback smoothly.

Live selection + copy:
- [ ] Hold a word directly in the terminal, lift your finger, adjust both handles, tap **Copy**, then **Done**. Paste elsewhere: the selected words match. Repeat over LAN HTTP to exercise the clipboard fallback.
- [ ] Select across several rows, including indented code, wide characters and wrapped text. Verify spaces and line breaks.
- [ ] Move your finger before the long-press threshold: it scrolls without selecting. Pinch still changes font size.
- [ ] Incoming output stays live; a mouse hover does not erase selection. A grid resize dismisses handles.
- [ ] The clipboard toolbar button copies the selection, or the current screen when no text is selected.

Composer:
- [ ] Tap the message box: the keyboard opens, the composer grows with several lines, and Send stays above the keyboard. Return adds a line without submitting.
- [ ] Send two lines together to real Claude and Codex. Confirm one prompt with both lines and no premature submission.
- [ ] Type drafts in two sessions, switch back and forth, then reload: each draft stays with its session.
- [ ] Disable networking and Send: the error is visible and the message remains editable. Restore networking, check whether it arrived, then retry if needed.
- [ ] Tap the terminal after dismissing the keyboard: it must not summon a second keyboard through xterm's hidden textarea.
- [ ] If the grid renders jumbled, it self-corrects on rotate/resize; tapping Refresh also refits it.

## Desktop — Firefox, HTTP (not localhost)
- [ ] Mouse-wheel scrolls Claude's transcript. Ordinary drag selects multiple lines without a modifier; moving the pointer after release does not erase selection. Paste elsewhere to verify.
- [ ] A click still operates TUI menus. Alt-drag remains rectangular selection on Linux/Windows.
- [ ] Ctrl+C copies selected text, and interrupts when no selection exists. Ctrl+Shift+C copies without sending a terminal interrupt.
- [ ] The clipboard button copies selected text, or the current screen when nothing is selected: real spaces, no escape/cursor codes, no big runs of blank lines.
- [ ] Enter sends; Shift+Enter adds a line; arrow keys edit the message; Alt+Up/Down recalls history.

## Alt-screen / scroll behavior
- [ ] Run a real Claude Code session for 5+ minutes including long responses, tool calls, and exits.
- [ ] Scroll back through the session (drag in Live): no duplicated chunks, reaches the top of Claude's transcript, returns cleanly to the bottom.
- [ ] When Claude exits and restarts (the per-session restart loop, `loopCommand` or `pd-claude-session`), prior plain-shell output stays in xterm scrollback (outer alternate-screen-off behavior).

## Session restore across a restart (needs real providers; the e2e fixture runs `cat` and has no conversation to resume)
- [ ] Open two Claude tabs and two Codex tabs. Give every conversation a different message you can recognize. In one Claude tab, start something long-running; in another, let it finish and sit waiting on you.
- [ ] `docker restart pocket-dev` without touching the browser. Every tab comes back under the same id, and the page reconnects on its own (no reload, dots go green).
- [ ] After enough Claude or Codex output to exceed the replay window, reload a phone at the same orientation and width. The current frame remains coherent, with no duplicated banner or interleaved paragraph fragments, and switching to desktop mode is not needed to repair it.
- [ ] The tab that was mid-work resumes its conversation and picks the work back up on its own, having been asked "continue please" exactly once (it arrives as Claude's first message, not as keystrokes — check the transcript shows one such user turn, not two).
- [ ] The tab that was waiting on you resumes its conversation and just sits there. Nothing is typed into it.
- [ ] Both Codex tabs resume their own distinct conversations. Neither opens fresh and neither attaches to the other tab's conversation. Codex receives no automatic continuation prompt.
- [ ] No tab comes back sitting on "Quick safety check: is this a project you trust?" — pd-trust-workspace clears that at boot. If one does, restore still worked but every tab needs a keypress, so treat it as a regression.
- [ ] Now kill it the hard way (`docker kill pocket-dev`, or trigger a real OOM) with a session mid-task. The tab and conversation still come back, but the session is WARNED about the unexpected shutdown instead of being told to continue. This is the one that matters: auto-continuing after an OOM tells Claude to rebuild whatever took the host down.
- [ ] Type `/exit` in one restored Claude tab and one restored Codex tab. Each loop starts a NEW conversation, not the one you just left. Restart again and confirm each fresh conversation, rather than the exited one, resumes.
- [ ] Run `/clear` in a Codex tab, restart, and confirm the tab resumes the conversation it was LAUNCHED on, not the cleared one. The `/clear` `SessionStart` is a later lifecycle event in the same TUI and must NOT replace the root binding: measured 2026-09-11, later events reported ids present in neither the rollout nor the state index, and resuming one of those is a tab that comes back blank. Then check `$PD_STATE_DIR/sids` holds only `<id>.uuid` files — a leftover `*.tmp` means the publish path failed halfway.
- [ ] Kill a tab, restart the container: it stays killed, and its conversation is not resumed into a new tab.
- [ ] `docker stop` + `docker rm` + `docker run` (a recreate) with the Home mount present: tabs and both providers' conversations still come back. Without the mount they do not, as expected.

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

## Codex defaults (CI only reads `entrypoint.sh`'s source; what lands in the home is a live fact — see "Codex" in CLAUDE.md)
- [ ] Start a container against a home with NO `~/.codex/config.toml` (the fresh-home case the removed seed would have fired on) and confirm the file is still absent afterwards, while `~/.codex` itself exists and is writable by the session's uid.
- [ ] Append a line to an existing `~/.codex/config.toml`, restart the container, and confirm the line is still there — nothing in this image may rewrite that file, or `codex login` trust levels get discarded on every boot.
- [ ] A `/second-opinion` consult reports the model it passed with `-m` in codex's banner, so the flag is what decides the model and no base pin is needed.
- [ ] `command -v codex` resolves to the npm launcher or the official standalone symlink in `~/bin`, never a shell wrapper injecting bypass flags. A consult's banner says `sandbox: read-only`.
- [ ] From inside this checkout, run a consult whose prompt never mentions the rules and confirm codex reads `AGENTS.md`, follows it to `CLAUDE.md`, and obeys what it finds. CI only asserts the pointer file exists and stays a pointer; that codex FOLLOWS it is model behaviour, so re-check it after a codex major bump.
- [ ] After recreating the container on Tower, confirm `~/.codex/tmp` resolves to `/var/tmp/pd-cache/.codex-tmp`, whose mode is 700. Run `codex login status` and confirm it no longer prints the stale-arg0 cleanup warning. Confirm `auth.json` and `sessions/` remain present. The real shfs mount matters: CI can check the relink, but its filesystem does not reproduce the open-file unlink failure. Never run the migration against live Codex processes, whose PATH contains these helpers.
- [ ] Read `docker logs pocket-dev` for the standalone-codex line, then confirm `~/bin/codex` exists and its payload resolves under `~/.codex/packages/standalone/current`. An "installed the standalone codex" line with nothing in `~/bin` means the install directory reached `curl` instead of the installer shell, or a failed download exited 0 through the pipe.
- [ ] `cat /etc/codex/requirements.toml` shows the managed `SessionStart` hook, and starting Codex does NOT ask you to approve it — a hook parked behind trust simply never runs, and the only symptom is a restored tab coming back on a blank conversation. Then run a bare `codex` OUTSIDE a pocket-dev tab (e.g. `docker exec`) and confirm it writes nothing under `$PD_STATE_DIR/sids`: with no `PD_CODEX_SID_FILE` the hook must be inert.

## Provider per session (the whole point is a second harness, and CI runs one binary: no test in this repo starts codex, logs into it, or renders its TUI)
- [ ] Session list → **+ Codex** starts a tab, and it comes up in Codex's own TUI rather than an error or a bare shell. If it dies immediately, read the pane: an unrecognised flag means a Claude-only argument reached the Codex command line. **Note `--skip-git-repo-check` is NOT on the tab's command line and must not be added**: measured against codex-cli 0.151.0 it exists on `codex exec` only, and bare `codex --skip-git-repo-check` exits with `unexpected argument`. A tab starts in `$HOME`, which is not a repo, so answer Codex's own trust gate in the TUI.
- [ ] Read the model off the Codex tab's banner: it must name `gpt-5.6-sol`. The registry pins that with `-m` on the tab's command line, which is the only thing pinning it (PR #55 removed the `~/.codex/config.toml` seed, and the base config that `codex login` also writes is deliberately left alone). Inheriting the account default is NOT the fallback to want — measured 2026-09-08 it is `gpt-6-astra`, a different model family. Before bumping the pin, confirm a newer Sol EXISTS using the must-fail-control recipe in `~/.claude/skills/second-opinion/SKILL.md` `<model_choice>`: `gpt-6-sol` returns the same 400 as a deliberately bogus id. And do NOT read the banner as proof of a bump — it echoes any `-m` string without validating it, so `-m sol` prints a plausible banner for a model that does not exist.
- [ ] That tab's row reads **`Codex · main-N`** and **`Status not tracked`**, with a grey dot, no unread dot, and a relative time that still ticks. A bare `main-N` means the provider label is not reaching the row; `Waiting on you` means the opaque state is not being applied and the tab is lying about needing you.
- [ ] Leave the Codex tab THINKING (give it a long task) and watch the session list from another tab for a minute. The Sessions badge must NOT light and the row must NOT flip to `Waiting on you`. This is the one that cannot be tested here: it needs a real TUI painting real frames.
- [ ] Session list → **+ Claude** still starts Claude, still gets an AI-generated title after its first turn, and still shows `Working` / `Waiting on you` / `Read`. The Codex work must not have flattened the Claude row.
- [ ] `Ctrl-B c` and the keyboard path start a **Claude** tab (the default), silently and by design.
- [ ] `curl -X POST -H 'Content-Type: application/json' -d '{"provider":"cursor"}' localhost:7681/sessions` returns **400 `unknown provider`** and creates nothing. A 200 means an unrecognised id is being defaulted through, which is a typo starting the wrong harness.
- [ ] `docker restart pocket-dev` with one Claude tab and one Codex tab open. Both come back on their OWN harness and conversation: `docker logs pocket-dev` names the Codex one as having no transcript status, and the Codex pane is Codex and not Claude. A Codex tab that comes back running Claude means the restart loop is baking a process-wide command again.
- [ ] `cat $PD_STATE_DIR/sessions.json` shows `"version": 2` and a `provider` on every entry.
- [ ] Kill the Codex tab, then hand-edit `sessions.json` to name a provider that does not exist (`"provider": "gemini"`) and restart. The tab comes back as **Claude** with one warning in the log, rather than the server refusing to boot or dropping the tab.
- [ ] Confirm `/second-opinion` still works from inside a Claude session, and that its banner still says `sandbox: read-only`. The Codex tab's command line carries the sandbox bypass, and the thing that must remain true is that nothing on `PATH` was shadowed, so a consult is unaffected.

## Focus events
- [ ] Switch browser tab away from pocket-dev for 30 seconds, then back.
- [ ] Claude Code's UI redraws cleanly (no stuck cursor, no stale spinner).
