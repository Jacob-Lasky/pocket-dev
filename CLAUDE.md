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

Resume is off whenever `SHELL_CMD` is set (the e2e fixture runs `cat`, which has no conversation) or `PD_RESUME=0`. The roster half still works in both cases. Note `claude --resume` is scoped to the cwd's project, which is fine because every session spawns in `$HOME`; if a resume fails anyway the loop self-heals, because iteration 2 is no longer the first and starts clean.

**4. The trust gate (`mobile/pd-trust-workspace`, called from `start.sh`).** Claude asks "do you trust this folder?" on every new session in an untrusted directory, and measured in the running container, answering it does not persist for `/home/claude`. Restored sessions would therefore all come back parked on a prompt, waiting for a keypress, which defeats restoring them. The script pre-accepts the gate at boot, before any session spawns. It grants nothing new: pocket-dev already runs `--dangerously-skip-permissions` in that exact directory. `PD_TRUST_WORKSPACE=0` opts out. It writes `~/.claude.json` in place with `cat >`, never a rename, because that path is a file-level bind mount and renaming onto a mount point fails with EBUSY; `test/server/trustWorkspace.test.js` asserts the inode survives.

**The client half** (`index.html`). Panes reconnect on their own: `term.reset()` on every WS open makes the pane a faithful function of the server's replay buffer (it also fixes reconnects stacking a second copy of the scrollback), a 4404 triggers `resyncSessions()` instead of leaving a dead pane, and coming back to a backgrounded tab resyncs too — that is when a restart is most likely to have happened unseen.

**Where the state lives.** `PD_STATE_DIR` defaults to `/home/claude/.pocket-dev`. Unmounted it survives a restart but NOT a recreate, because a recreate discards the writable layer — that is the same failure that keeps eating `~/.config/gh` and `~/.fly`. The `Session State` volume in `pocket-dev.xml` is what makes it survive an image update. Never bind-mount `/home/claude/.local` to solve that class of problem: the image bakes `claude`, `uv`, and `uvx` into `/home/claude/.local/bin`, and a mount there masks them. `/opt/pd` exists as an empty, on-PATH prefix for exactly this.

**Test coverage** splits along the same seams: `test/e2e/restore.spec.js` drives real restarts through the browser (roster half only, since the fixture is `cat`); `test/server/sessionsRestore.test.js` injects a fake pty to cover restore, id sequencing, and every branch of the resume decision; `test/server/sessionLauncher.test.js` runs the launcher against a stub `claude` on PATH; `test/server/claudeSession.test.js` pins the transcript shapes the classifier reads; `test/server/trustWorkspace.test.js` runs the trust script for real. None of that substitutes for a live pass — the resume path is exactly the kind of thing that is green in CI and broken against a real Claude, which is how the typed-nudge design got caught.

## Deploy

- CI: `.github/workflows/test.yml` (vitest + playwright on PRs), `.github/workflows/docker-publish.yml` (push to GHCR on main / tags).
- Tower: `ssh tower`, `docker pull ghcr.io/jacob-lasky/pocket-dev:latest`, stop/rm/run with the canonical args. The UnRAID template at `/boot/config/plugins/dockerMan/templates-user/my-pocket-dev.xml` is the source of truth for volumes / env / `--group-add 281`.
- The runtime container does NOT include devDependencies — `npm install --production` in the Dockerfile excludes vitest/playwright/etc.

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
