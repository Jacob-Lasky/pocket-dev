# pocket-dev

Browser-accessible terminal for Claude Code. Node + Express server (`mobile/server.js`) hosts N independent tmux sessions — each its own pty, each surfaced as its own xterm.js instance in a single browser tab. The `+New / Next / Last / Kill` toolbar row switches between them; only one is visible at a time, but each retains its own main-buffer scrollback so browser scroll (wheel + touch) never shows the wrong session's history. Runs as a Docker container on UnRAID; image is `ghcr.io/jacob-lasky/pocket-dev:latest` published from `.github/workflows/docker-publish.yml` on push to main.

## Per-session model — why it exists

An earlier architecture multiplexed everything through one tmux session, one pty, one xterm.js. Switching tmux windows (`Ctrl-b n`) painted the new window into the same xterm.js main buffer, so the browser's scrollback was the *union* of every window's output — you couldn't scroll back into "this window's history" because there was no such thing in the browser.

The fix was structural: each toolbar tab is a real isolated session with its own pty, its own tmux session (named `${TMUX_SESSION}-1`, `-2`, …), and its own xterm.js with its own main-buffer scrollback. Switching tabs is now a pure DOM toggle. The bleed is impossible because the bytes never share a buffer.

`mobile/test/e2e/sessions.spec.js` is the regression guard. If you flatten the architecture back to one xterm.js, that spec fails.

## Two layers of alt-screen — disable only the OUTER one

**This is the most non-obvious thing about this codebase. Re-read it before touching `mobile/tmux.conf` or anything serialize-related.**

There are two independent "alternate screen" mechanisms in play. They are NOT the same thing:

1. **Outer alt-screen**: tmux switching the visible buffer it shows to xterm.js when a session attaches. Tmux does this by default — it sends `\x1b[?1049h` (smcup) on attach. Result: every byte of session output lands in xterm.js's alt-buffer, which has no scrollback.

2. **Inner alt-screen**: applications running INSIDE tmux (Claude Code's TUI, vim, less, htop) using alt-screen for their own full-screen UI.

We **disable the outer** so all output lands in xterm.js's normal buffer (which the Select overlay reads by walking `term.buffer.normal`, see `view.js`; for a plain shell this is continuous scrollback, for a TUI coder it is the current frame — see "Mobile scroll + the Select overlay"). We **must NOT disable the inner** — Claude Code renders its prompt input area inside an alt-screen TUI; disabling inner alt-screen breaks input handling entirely (user can't type).

The `mobile/tmux.conf` knobs:

| Setting | Layer | Want? |
|---|---|---|
| `set -ga terminal-overrides ',xterm*:smcup@:rmcup@'` | OUTER — strips smcup/rmcup from outer terminfo, tmux can't switch buffers there | ✅ Keep |
| `setw -g alternate-screen off` | INNER — tells tmux to forbid inner apps from alt-screen | ❌ NEVER add this back |
| `set -g focus-events on` | Forwards focus events into inner apps | ✅ Keep |

`mobile/test/server/tmuxConf.test.js` has a regression-guard test that asserts `alternate-screen off` is NOT in the file. If you find yourself wanting to disable inner alt-screen, you're chasing the wrong fix.

## Test gap: cat doesn't exercise alt-screen

The E2E fixture sets `SHELL_CMD=cat` for deterministic echo behavior. **Cat doesn't use alt-screen**, so any regression that affects only TUI apps (anything with a curses-style prompt — Claude, vim, htop) won't surface in CI. The `setw alternate-screen off` mistake shipped through CI green for this reason.

To partly close this gap, `mobile/test/e2e/fixtures/claude-trust-frame.b64` is a captured real Claude TUI frame (the "trust this folder?" prompt, which positions words with CHA absolute-column moves and emits no literal spaces). `view.test.js` replays it through a real xterm to assert the View renderer reconstructs the spaces, and `view-claude-frame.spec.js` replays it through the full server (via `SHELL_CMD=bash replay-claude-frame.sh`) for a browser-level check. This covers the alt-screen render path that cat cannot.

If you change anything in the buffer / View-render / focus / alt-screen path, still manually verify against the deployed Claude before declaring success. The `mobile/MANUAL-VERIFICATION.md` checklist exists for this.

## Architecture cheat sheet

- **Server** (`mobile/server.js`): exports `buildTmuxSpawnArgs`, `buildSessionCommand`, `createApp`, `createSessionsApi`, `TMUX_CONF_PATH`, `LAUNCHER_PATH`, `SAFE_ID`. Auto-boots only when run directly (`require.main === module`); requiring it for tests does nothing.
  - **`createApp({ sessionsApi })`**: returns an Express app. Session-aware routes (`GET/POST/DELETE /sessions`, plus `/send /key /refresh`) only wire up if `sessionsApi` is passed; the static `render.spec.js` boots `createApp()` with no api on purpose to get an unwired test surface.
  - **`createSessionsApi({ store, spawnPty, projectsDir, logger })`**: stateful factory holding `Map<id, SessionState>`. Each session owns a pty, a 512 KB replay buffer, and the set of connected WebSocket clients. `attachWs(ws, sessionId)` wires an upgraded WS into the matching session and replays buffered bytes. Every option is injectable and defaults to inert or real-world: `store` defaults to `nullSessionStore` (no filesystem side effects unless asked), `spawnPty` to the real tmux spawn — tests swap both rather than mocking modules, same shape as `createApp({ sessionsApi })`.
  - **`restore()`**: re-creates the sessions in the roster, before `listen()`. See "Session restore".
  - Endpoints: `GET /sessions` (list), `POST /sessions` (create + return id), `DELETE /sessions/:id` (terminate), `POST /send { session, text }`, `POST /key { session, key }`, `POST /refresh { session }`, `/ws?session=<id>` upgrade. No `/tmux-kill` — replaced by `DELETE /sessions/:id`. No `/history` — the Select overlay replaces it client-side.
  - `SAFE_ID = /^[A-Za-z0-9._-]+$/` guards every session id that touches shell interpolation (notably `/refresh`, which lists tmux clients via shell pipe).
- **Server-side modules**: `safeId.js` (the shared `SAFE_ID` / `UUID_RE` guards — one definition, three consumers), `sessionStore.js` (the on-disk roster + per-session Claude uuid), `claudeSession.js` (read-only inspection of Claude's transcripts: find one by uuid, classify busy/idle/unknown).
- **Shell helpers shipped beside the server**: `pd-claude-session` (per-session restart loop + resume decision) and `pd-trust-workspace` (clears the workspace-trust gate at boot). Both are invoked by absolute path, so their exec bit is load-bearing and asserted in tests.
- **Client modules** (`mobile/public/js/*.js`, all ESM):
  - `clipboard.js` — `clipboardWrite` strips trailing whitespace, falls back to `document.execCommand('copy')` on HTTP where `navigator.clipboard` is unavailable.
  - `view.js` — walks the active session's `term.buffer.normal` directly to build the Select-overlay output: `renderTerminalHtml` (colour-preserving styled spans, one `<div class="vrow">` per logical line) and `renderTerminalText` (plain text for copy). `buildPalette` maps xterm colour indices to CSS; `cleanCopyText` normalises copied text; `ViewRenderer` owns only the sticky-bottom scroll + innerHTML swap. NO serialize/ansi_up (see the WHY block at the top of the file).
  - `mode.js` — `detectDefaultMode` (always `live` now — Live is the sole default on every device), `applyMode` (sets `body.dataset.mode` to `live`/`select`, toggles the Select overlay).
  - `scroll.js` — mobile Live touch-scroll helpers: `scanMouseState` (fold a WS chunk into `{track,sgr}`), `wheelSequence` (SGR/X10 wheel bytes), `wheelStepsFromDelta` (drag px → whole wheel steps). Pure; the DOM wiring lives in `index.html`'s `installTouchScroll`.
  - `keys.js` — `maybeInterceptCopyKey` for `term.attachCustomKeyEventHandler`. Selection-aware Ctrl+C + always-copy Ctrl+Shift+C.
- **`index.html`**: monolithic by design. Inline `<script type="module">` with imports; toolbar functions exposed on `window` via `Object.assign` so HTML `onclick` attrs can find them. The `mobile/test/unit/onclick-coverage.test.js` test parses the file and asserts every `onclick="X("` resolves to an exposed name — this catches the "scope-leaked-after-converting-to-module" regression class.

## Mobile scroll + the Select overlay — what the buffer actually holds

**Measured reality (verify before theorising).** With a full-screen TUI coder (Claude Code) running, xterm.js's `buffer.active` IS `buffer.normal` (the outer smcup strip means xterm never enters an alt buffer) and that buffer holds **exactly one screen — zero scrollback**. tmux flattens the coder's inner alt-screen and repaints it in place via cursor addressing, so no history accumulates in ANY browser buffer. The back-and-forth transcript lives *inside the coder* and is reached only by telling the coder to scroll. Confirmed by driving real `claude` through the pipeline and inspecting the buffer (40 rows, `baseY 0`).

Consequences that shape the UI:

- **Live is the one primary surface, and it is touch-scrollable** (`scroll.js` + the `installTouchScroll` wiring in `index.html`). A one-finger vertical drag is intercepted capture-phase and routed: if the inner app has mouse tracking on (a TUI coder) it is forwarded as SGR wheel events to the pty (the coder scrolls its own transcript — this is exactly what a desktop mouse-wheel does); if not (a plain shell) it scrolls xterm's real scrollback locally. A per-session `mouse` flag (fed by `scanMouseState` on every WS chunk) picks the branch. `tmux.conf`'s `mouse off` is load-bearing for the forward path (lets the coder's mouse tracking pass through).
- **The former "View mode" is retired** as a co-equal mode with a mobile default. It could never show the history it implied (there is none in the buffer). What survives is the opt-in **Select overlay** (`toggleSelect`, body `data-mode="select"`): `view.js` renders the active session's `term.buffer.normal` (the current screen) as wrapped, selectable HTML so a user can grab text that a mouse-tracking TUI otherwise steals from touch selection in Live. It is per-session and reflects the current screen, not a transcript.
- `renderTerminalHtml` / `renderTerminalText` read `.normal` (not `.active`) and reconstruct real spaces from cells (the #12 fix — do NOT reintroduce serialize/ansi_up). Soft-wrapped rows are rejoined so the overlay reflows to the viewport, not the host PTY width.
- Two refresh guards: `refreshViewIfActive` skips the innerHTML rebuild while a text selection is active in the overlay (a rebuild collapses the selection) and flushes on `selectionchange`; the `⟳` button calls `renderViewNow` to force a rebuild regardless.

Guard tests: `test/unit/scroll.test.js` (mouse-state scan + wheel math), `test/e2e/touch-scroll.spec.js` (drag → wheel forwarded to pty for a mouse-tracking session via `mouse-app.sh`; drag → local xterm scroll + zero wheel bytes for a plain shell). The forward path can't be exercised by the `cat` fixture (no mouse tracking) — same test-gap shape as alt-screen.

## Session restore — surviving a restart

A container restart used to cost you every tab. The roster lived only in the server process's memory, so after a restart an open browser's reconnect got a 4404 and sat on dead panes; reloading gave you one blank session. Three pieces fix that, and they are separable on purpose.

**1. The roster (`mobile/sessionStore.js`).** `$PD_STATE_DIR/sessions.json` lists the live session ids, rewritten on every create/destroy/exit. `startServer()` calls `sessionsApi.restore()` BEFORE `listen()`, so a reconnecting browser finds its ids already there instead of a 4404 it has to recover from. tmux is deliberately not the source of truth here: its server dies with the container, so after a restart there is nothing to enumerate. Every failure in the store is non-fatal — an unwritable state dir means no restore, never a server that will not boot.

The same `create()` covers both outage shapes, because `buildTmuxSpawnArgs` uses `new-session -A`: if only node died the call REATTACHES to the live tmux session (scrollback and running Claude intact); if the container died it creates a fresh one.

**2. The conversation (`mobile/pd-claude-session`).** Restoring a tab is only half of it — the tab needs the conversation it was having. The launcher binds each tab to a stable Claude uuid (`--session-id` on first run, `--resume` after a respawn), recording it in `$PD_STATE_DIR/sids/<id>.uuid`. It owns that file; the server only reads and deletes it.

The load-bearing rule is **first loop iteration resumes, later ones never do**. Iteration 1 means pocket-dev respawned the tab (the restart case, resume it); iteration 2+ means Claude exited because the user typed `/exit` (a clean slate is the point, and resuming there would trap them in a conversation they cannot leave). DO NOT collapse this to resuming unconditionally.

**3. The continue prompt (`mobile/claudeSession.js`).** A restored session that was mid-turn is asked to carry on; one that was waiting on the user is left alone, which is the whole reason to classify rather than always continue. The classifier reads the transcript tail: a completed assistant turn (`stop_reason: 'end_turn'`) or a `[Request interrupted by user` marker is idle, anything else recognisable is busy, anything unrecognisable is `unknown`. **`unknown` must never prompt** — a wrong "busy" makes Claude talk to itself.

The prompt travels as `PD_RESUME_PROMPT` (tmux `-e`) and becomes a command-line argument: `claude --resume <id> "continue please"`. **DO NOT change this to typing into the pty.** That was the first implementation and it fails live: a resuming Claude paints, pauses while it initialises, then repaints, and anything typed into that gap is swallowed with no error. There is no ready signal to wait for, so no settle timeout fixes it. As an argument it is Claude's own first message, it cannot be lost, and it survives the workspace-trust gate. Verified 2026-07-24 against the real thing, both ways round.

**Auto-continue is gated on a CLEAN shutdown, and that gate is a safety property, not a nicety.** `startServer()` registers SIGTERM/SIGINT handlers that drop a `clean-shutdown` marker in the state dir, and reads-and-clears it at boot. Marker present (a deliberate `docker restart`, stop, or image update) means an interrupted session may be told `continue please`. Marker absent covers every way a process dies without a say — SIGKILL, an OOM kill, the host losing power — and there the session is still restored and its conversation still resumed, but instead of being told to carry on it is WARNED (`PD_CRASH_NUDGE`) that the container died and that retrying may repeat whatever killed it. The reason is concrete: a Claude session can OOM the host by building something the wrong way, and "continue please" after that is an instruction to do it again. Unclean is the default, so knowing nothing gets you the cautious branch. DO NOT invert this to opt-in. The marker distinguishes clean from unclean deterministically; it does NOT identify why an unclean exit happened, and nothing readable from inside the restarted container does.

Resume is off whenever `SHELL_CMD` is set (the e2e fixture runs `cat`, which has no conversation) or `PD_RESUME=0`. The roster half still works in both cases. Note `claude --resume` is scoped to the cwd's project, which is fine because every session spawns in `$HOME`; if a resume fails anyway the loop self-heals, because iteration 2 is no longer the first and starts clean.

**4. The trust gate (`mobile/pd-trust-workspace`, called from `start.sh`).** Claude asks "do you trust this folder?" on every new session in an untrusted directory, and measured in the running container, answering it does not persist for `/home/claude`. Restored sessions would therefore all come back parked on a prompt, waiting for a keypress, which defeats restoring them. The script pre-accepts the gate at boot, before any session spawns. It grants nothing new: pocket-dev already runs `--dangerously-skip-permissions` in that exact directory. `PD_TRUST_WORKSPACE=0` opts out. It writes `~/.claude.json` in place with `cat >`, never a rename. That was originally because the path was a file-level bind mount, where a rename fails with EBUSY; the single home mount retired that specific mount, but the in-place write and the inode assertion in `test/server/trustWorkspace.test.js` are kept, because they are what makes re-introducing a file-level mount there safe and the failure is otherwise silent.

**The client half** (`index.html`). Panes reconnect on their own: `term.reset()` on every WS open makes the pane a faithful function of the server's replay buffer (it also fixes reconnects stacking a second copy of the scrollback), a 4404 triggers `resyncSessions()` instead of leaving a dead pane, and coming back to a backgrounded tab resyncs too — that is when a restart is most likely to have happened unseen.

**A pane stops following new output when the BROWSER moves it, and xterm cannot tell that from a user scrolling.** `Viewport._handleScroll` turns any `scrollTop` xterm did not itself set into `scrollLines(newRow - ydisp)`, and a negative result latches `isUserScrolling`, which stops the buffer following forever. Nothing clears that latch on its own.

Measured on webkit in CI after a node-only restart (#30), from a scroll-event trace, not from reading source: xterm syncs `scrollTop` to 32 (`ydisp 2 * 16px`) against a 671px scroll area, then a later viewport refresh shrinks the area to 639px, *exactly* `clientHeight`, leaving no scrollable range at all. The browser clamps `scrollTop` 32 -> 0 by itself. xterm reads that unflagged event as a 2-row scroll up and the pane sits 2 rows off the bottom for good, showing a window that straddles the pre-restart paint and the replayed one. Chromium and Firefox coalesce the clamp with the flagged event, which is the entire reason it read as webkit flake.

`installFollowGuard()` in `index.html` is the fix. It watches the viewport's own scroll events and **discriminates on GEOMETRY, deliberately, not on input devices**: a browser only relocates `scrollTop` on its own when the scroll area shrinks under it, so a scroll arriving with the area unchanged is the user's and is left alone, while one arriving with the area shrunk (or with no scrollable range at all) is undone. `test/e2e/follow-guard.spec.js` is the regression guard; it provokes the clamp by collapsing the scroll area rather than by assigning `scrollTop`, because the geometry change is the whole signal.

Two dead ends are recorded in the code as DO-NOTs, both of which were tried:

- **Do not track wheel/pointer/touch and treat "no gesture" as proof the browser did it.** Dragging a native scrollbar dispatches no `pointerdown` in Chrome or Firefox, so a real drag looks gestureless and the guard fights the user. The viewport has a real scrollbar; it is not styled away.
- **Do not rely on the `term.scrollToBottom()` that follows `reset()` in `ws.onopen`.** It was once believed to be the whole fix and CLAUDE.md said so; the CI trace disproves it. At that point the buffer is empty from `reset()`, so it resolves to `scrollLines(0)`: it clears the latch and moves nothing. Everything that actually unpins the pane happens *after* it. It is kept because a reattach should start following whatever the pane was doing before, not because it fixes this.

**Never assert on a marker count taken across the whole buffer, and never take it from rendered text.** Both were wrong in `restore.spec.js` and cost a day of "webkit flake". The row count is not stable across a reconnect (`fitAndResize()` runs on every WS open), and shrinking a terminal reflows lines that no longer fit into scrollback while growing it pulls them back, so a whole-buffer count taken after a restart is not comparable with one taken before it: measured 2 -> 4 -> 6 across a restart and two resizes. Rendered text additionally reflects wherever the pane happens to be scrolled. The stable measure is the bottom-anchored SCREEN (`buffer.normal` rows `baseY` .. `baseY + rows`), which held steady at 2 through every one of those steps on all three browsers.

**Where the state lives.** `PD_STATE_DIR` defaults to `/home/claude/.pocket-dev`, inside the single `Home` mount — see "The home is one mount" below. Unmounted it would survive a restart but NOT a recreate, because a recreate discards the writable layer.

**Conversation metadata** rides the same transcript read. `claudeSession.inspectTranscript` returns `{status, title, lastPrompt}` from ONE tail pass, because the session list asks for status and title together and repeatedly. Claude appends a fresh `ai-title` and `last-prompt` record on roughly every turn (98 of each in one real 11 MB transcript), so the LAST occurrence is current and we walk backwards to it; measured across six real transcripts both sit within 32 KB of EOF even at 14 MB. `GET /sessions` serves `describe()`, not `list()`: `list()` stays cheap because it is also what gets written to the roster on every create and destroy. `describe()` memoises per uuid against the transcript's mtime and size, which is sound because a transcript only ever grows.

**Test coverage** splits along the same seams: `test/e2e/restore.spec.js` drives real restarts through the browser (roster half only, since the fixture is `cat`); `test/server/sessionsRestore.test.js` injects a fake pty to cover restore, id sequencing, and every branch of the resume decision; `test/server/sessionLauncher.test.js` runs the launcher against a stub `claude` on PATH; `test/server/claudeSession.test.js` pins the transcript shapes the classifier reads; `test/server/trustWorkspace.test.js` runs the trust script for real; and `test/e2e/titles.spec.js` runs on the `pdServerClaudeStub` fixture, which leaves `SHELL_CMD` unset and shadows `claude` on PATH with `test/e2e/stub-bin/claude` so the launcher, the sid-file handoff, and titles all execute for real in a browser test. That stub derives its log path from `PD_SID_FILE` rather than its own env var, because tmux only forwards what `update-environment` names and a pty-set variable arrives only when that test happened to start the tmux server: it passed alone and failed under parallel workers. None of that substitutes for a live pass: the resume path is exactly the kind of thing that is green in CI and broken against a real Claude, which is how the typed-nudge design got caught.

## The session list — three states from two sources

`#session-list` is a full-screen overlay (NOT a swap of `#terminal-stack`'s contents: the panes underneath must keep their layout, see the `.terminal-pane` comment). It is opened by the `Sessions` button, and each row is a session with its conversation title, a preview line, and one of three states.

**Two of the three states come from the transcript; the third cannot.** `classifyTranscript` returns `busy` or `idle`, which is working-versus-finished. But **"waiting on you" and "read" are the SAME `idle` transcript state** — nothing on disk knows whether a human has looked. DO NOT go hunting for a third state in the JSONL; there isn't one.

That axis is tracked by the server, so every device agrees (read it on the phone, it is read on the desktop). It **counts output rather than timing it**: `state.outputSeq` against `state.viewedSeq`, with `POST /viewed` catching the latter up to the former. Wall-clock timestamps were the first implementation and were wrong — output landing in the same millisecond as a view compares equal and gets swallowed, and no choice of `>` or `>=` fixes it, because timestamps genuinely cannot separate "printed just before you looked" from "just after". Both counters restart with the process, so after a restart nothing is unread until a session says something new; the pty history is gone anyway, and resurfacing sessions you already dealt with would be noise. `lastOutputAt` survives only as a display value for the row's relative time.

Two rules the UI depends on: **the active session is never unread** (you are looking at it, so its output is read as it arrives), and while you sit in a session a throttled `POST /viewed` keeps the server's record in step so another device does not still think it wants you.

`busy` always wins over the read/unread axis, and everything unrecognised folds into it, so the list still works for a session with no transcript yet or a custom `SHELL_CMD` that is not Claude at all.

**A page reload cannot mark anything unread**, because the server counts only real pty output and the buffer replay it sends on attach is not that. `test/e2e/session-list.spec.js` has the regression guard.

The `Sessions` button carries a dot when a session OTHER than the active one wants attention, which is the reason the metadata poll keeps running (slowly) while you are inside a session rather than only while the list is open.

The list REPLACED the cycle row: `#btn-row-tmux` and its Next/Last buttons are gone, `Kill` moved into the session's own toolbar next to the thing it destroys, and `#session-label` became a permanent strip above the toolbar (outside `#btn-group`, so collapsing the toolbar cannot hide it — on a phone there is no browser tab title, so it is the only persistent answer to "which session am I in"). Cycling survives only as the Ctrl-B prefix keys, which need no UI.

## The home is one mount — and why that was ever hard

`/home/claude` is a single bind mount, and the only state mount the container has. Everything written to `~` persists across an image update: Claude's config and conversation ids, the `gh` token, the dgvpn registration, `~/bin`, and credentials for tools no one has added to a list (`.aws`, `.kube`, `.fly`, `.docker`).

**It was not always safe to do this, and the reason still constrains the design.** The home used to hold image artifacts and state in the same directory: `claude`, `uv` and `uvx` in `.local/bin`, the shell rc files, `.config/fish`, `.config/uv`. A mount over the home masked all of it and produced a container with no Claude in it, which is why the old template carried one mount per dotfile, and why the Dockerfile still says DO NOT mount `.local`. That list was the actual bug: anything it forgot — `~/.aws`, `~/.kube`, an installed flyctl — vanished on every recreate, and looked fine until it did.

The separation is what makes the single mount work, and all three pieces are load-bearing:

1. **The image builds its home into `/opt/pd-home`** and leaves `/home/claude` empty (`mv` at the end of the Dockerfile). Nothing image-owned may be created at `/home/claude/...` in the image — the mount masks it.
2. **Absolute symlinks are rewritten into the skeleton.** The claude installer writes `.local/bin/claude -> /home/claude/.local/share/claude/versions/<v>`, an ABSOLUTE path, so a bare `mv` leaves a link that resolves only once `entrypoint.sh` has linked `~/.local` back. That circular dependency means a container whose seeding failed has no runnable Claude and no obvious cause. `PATH` points at `/opt/pd-home/.local/bin` directly for the same reason. DO NOT drop the rewrite and lean on the seeding.
3. **`entrypoint.sh` symlinks the image-owned entries back into `$HOME`** at boot: `.bashrc`, `.zshrc`, `.profile`, `.bash_logout`, `.local`, and the two leaves `.config/fish` and `.config/uv`. **Links, never copies** — a copy freezes at first boot, so an image update would ship a `claude` no container runs. Only the leaves of `.config` are linked, because `.config/gh` holds the auth token and must persist.

Two rules that follow:

- **Session-installed CLIs go in `~/bin`** (on `PATH`, inside the mount). NOT `~/.local/bin`, which is a symlink into the image skeleton where writes are lost on the next update. This replaced `/opt/pd`, which existed only because the home was not persistent and was never actually mounted on the live container anyway.
- **`~/.cache` and `~/.npm` are relinked to `/var/tmp/pd-cache` and deliberately NOT persisted.** The home mount lands on the UnRAID array over shfs FUSE; a large write-heavy cache is the wrong traffic for it and pure bloat in appdata backups.

Guard tests: `mobile/test/server/homeMount.test.js` covers all three files (Dockerfile, `entrypoint.sh`, `pocket-dev.xml`), including an assertion that the template declares **no** mount at a path underneath `/home/claude`. A second mount under the home shadows part of it and lands state in two places at once. Every failure mode in this area is quiet — a container that boots fine with no `claude` on `PATH`, or a home that looks persistent until the update eats it — and none of it is reachable from the cat-based E2E suite, so source-level guards are the whole safety net.

## Deploy

- CI: `.github/workflows/test.yml` (vitest + playwright on PRs), `.github/workflows/docker-publish.yml` (push to GHCR on main / tags).
- Tower: `ssh tower`, `docker pull ghcr.io/jacob-lasky/pocket-dev:latest`, stop/rm/run with the canonical args. The UnRAID template at `/boot/config/plugins/dockerMan/templates-user/my-pocket-dev.xml` is the source of truth for volumes / env / `--group-add 281`.
- The package manager is **pnpm**, pinned by `packageManager` in `mobile/package.json` and read from that one place by both corepack (in the Dockerfile) and `pnpm/action-setup` (via `package_json_file` in CI). Do not repeat the version anywhere else.
- pnpm settings live in `mobile/pnpm-workspace.yaml`, NOT the `pnpm` field of `package.json`, which pnpm 11 stopped reading. The load-bearing key is **`allowBuilds`**: pnpm blocks dependency build scripts by default and node-pty ships no linux-x64 prebuild, so without it every server suite fails with "Cannot find module ./prebuilds/linux-x64//pty.node". `onlyBuiltDependencies` is pnpm 10's spelling and 11.17.0 ignores it silently — the file records the measurement.
- The runtime container does NOT include devDependencies: `pnpm install --prod --frozen-lockfile` in the Dockerfile excludes vitest/playwright/etc.
- The base stays on **Node 24**, the newest LTS, and that is also the last major that bundles corepack. Going further means reintroducing an `npm i -g pnpm` bootstrap, so newest-LTS and one-source-of-truth point the same way here.

## Deepgram tailnet access (dgvpn)

`dgvpn` gives commands selective, opt-in access to Deepgram-internal services (`.consul`, request-raid, anything on the `controlplane.deepgram.com` tailnet) without putting the whole container on the VPN. It exists so the in-container Claude can reach those services on its own:

```
dgvpn curl http://request-raid.service.awsw2.consul:9008/health   # routed via tailnet
dgvpn gh repo view ...                                            # public egress, untouched
```

- **`dgvpn <cmd>`** runs `<cmd>` with `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` pointed at the local proxy, then execs. Only hosts matching a tailnet suffix (`.consul` by default, `DGVPN_TAILNET_SUFFIXES` to extend) take the tunnel; everything else dials direct, so `dgvpn` is safe to prefix on any command.
- **`dgvpn-up`** brings the tunnel up (idempotent). Auth is interactive Keycloak SSO, valid ~24h: on first use in a window it prints a login URL to open once. `dgvpn` calls `dgvpn-up` for you and exits with code 3 (not running the command) when login is pending, so the caller authenticates and retries.
- State lives under `/home/claude/.dgvpn`. That survives a restart on its own, but survives a container RECREATE only if the `dgvpn State` volume from `pocket-dev.xml` is actually mounted on the running container. Verify with `docker inspect pocket-dev` before claiming a recreate keeps the registration: the template declaring a volume is not the same as the container having it.

**Architecture lives in `vpn/`.** A static Go binary (`dgvpn-proxy`) holds one userspace `tsnet` identity and runs a localhost HTTP CONNECT/forward proxy. `main.go` is the single-identity lifecycle (tsnet up, `RouteAll=true`, surface the SSO URL, start proxy); `proxy.go` is lifted from deephive's `services/tsnet/proxy.go`. It runs as the unprivileged `claude` user: userspace tsnet needs no TUN device and no `NET_ADMIN`. Go tests: `cd vpn && go test ./...`.

**DO NOT replace the Go sidecar with `tailscale up` / `tailscaled`.** This is the load-bearing reason the code exists. Userspace `tailscaled` cannot resolve `.consul` split-DNS for outbound connections (tailscale#16906, tailscale#4677): it answers only globally-resolvable or MagicDNS names, and `.consul` is neither. The sidecar works around this exactly as deephive did (#380), resolving names itself via the tsnet LocalAPI (`proxy.go`'s `resolveViaLocalAPI`) before dialing. Kernel-mode `tailscaled` would also need a TUN device and `NET_ADMIN`, which this unprivileged container does not have. If you "simplify" this to a stock tailscale client, `.consul` silently stops resolving.

## Common gotchas

- `<script type="module">` scopes everything inside to the module. Functions referenced from HTML `onclick="..."` attributes MUST be put on `window` explicitly. The `Object.assign(window, { ... })` block at the end of `index.html`'s script is load-bearing — `onclick-coverage.test.js` is the regression guard.
- View renders from the parsed xterm buffer, NOT from a re-serialized ANSI stream. `serialize()` encodes gaps/tabs/never-written cells as cursor-move CSI (`\x1b[NC`, `\x1b[NG`), and any ANSI->HTML converter that only handles SGR (e.g. `ansi_up`) drops those and loses the spaces. This is why `@xterm/addon-serialize` and `ansi_up` were removed. Don't add them back for the Select overlay.
- xterm.js's `copyOnSelect: true` silently no-ops on HTTP (clipboard API requires a secure context). We do explicit `term.onSelectionChange` + `clipboardWrite` (with `execCommand` fallback) instead.
