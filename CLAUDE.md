# pocket-dev

Browser-accessible terminal for Claude Code. Node + Express server (`mobile/server.js`) spawns a tmux session running Claude, exposes it via WebSocket to xterm.js in the browser. Runs as a Docker container on UnRAID; image is `ghcr.io/jacob-lasky/pocket-dev:latest` published from `.github/workflows/docker-publish.yml` on push to main.

## Two layers of alt-screen — disable only the OUTER one

**This is the most non-obvious thing about this codebase. Re-read it before touching `mobile/tmux.conf` or anything serialize-related.**

There are two independent "alternate screen" mechanisms in play. They are NOT the same thing:

1. **Outer alt-screen**: tmux switching the visible buffer it shows to xterm.js when a session attaches. Tmux does this by default — it sends `\x1b[?1049h` (smcup) on attach. Result: every byte of session output lands in xterm.js's alt-buffer, which has no scrollback.

2. **Inner alt-screen**: applications running INSIDE tmux (Claude Code's TUI, vim, less, htop) using alt-screen for their own full-screen UI.

We **disable the outer** so xterm.js's main buffer accumulates a continuous scrollback that View mode can read via `serialize({ excludeAltBuffer: true })`. We **must NOT disable the inner** — Claude Code renders its prompt input area inside an alt-screen TUI; disabling inner alt-screen breaks input handling entirely (user can't type).

The `mobile/tmux.conf` knobs:

| Setting | Layer | Want? |
|---|---|---|
| `set -ga terminal-overrides ',xterm*:smcup@:rmcup@'` | OUTER — strips smcup/rmcup from outer terminfo, tmux can't switch buffers there | ✅ Keep |
| `setw -g alternate-screen off` | INNER — tells tmux to forbid inner apps from alt-screen | ❌ NEVER add this back |
| `set -g focus-events on` | Forwards focus events into inner apps | ✅ Keep |

`mobile/test/server/tmuxConf.test.js` has a regression-guard test that asserts `alternate-screen off` is NOT in the file. If you find yourself wanting to disable inner alt-screen, you're chasing the wrong fix.

## Test gap: cat doesn't exercise alt-screen

The E2E fixture sets `SHELL_CMD=cat` for deterministic echo behavior. **Cat doesn't use alt-screen**, so any regression that affects only TUI apps (anything with a curses-style prompt — Claude, vim, htop) won't surface in CI. The `setw alternate-screen off` mistake shipped through CI green for this reason.

If you change anything in the buffer / serialize / focus / alt-screen path, manually verify against the deployed Claude before declaring success. The `mobile/MANUAL-VERIFICATION.md` checklist exists for this.

## Architecture cheat sheet

- **Server** (`mobile/server.js`): exports `buildTmuxSpawnArgs`, `createApp`, `TMUX_CONF_PATH`. Auto-boots only when run directly (`require.main === module`); requiring it for tests does nothing. Endpoints: `/send`, `/key`, `/tmux-kill`, `/refresh`, plus `/ws` upgrade. No `/history` endpoint — View mode replaces it client-side.
- **Client modules** (`mobile/public/js/*.js`, all ESM):
  - `clipboard.js` — `clipboardWrite` strips trailing whitespace, falls back to `document.execCommand('copy')` on HTTP where `navigator.clipboard` is unavailable.
  - `view.js` — `ViewRenderer` takes ANSI text, renders via `ansi_up` into a `pre-wrap` div with sticky-bottom scroll.
  - `mode.js` — `detectDefaultMode` (coarse-pointer → view, fine → live), `applyMode` (sets `body.dataset.mode`, hides inactive pane).
  - `keys.js` — `maybeInterceptCopyKey` for `term.attachCustomKeyEventHandler`. Selection-aware Ctrl+C + always-copy Ctrl+Shift+C.
- **`index.html`**: monolithic by design. Inline `<script type="module">` with imports; toolbar functions exposed on `window` via `Object.assign` so HTML `onclick` attrs can find them. The `mobile/test/unit/onclick-coverage.test.js` test parses the file and asserts every `onclick="X("` resolves to an exposed name — this catches the "scope-leaked-after-converting-to-module" regression class.

## View mode contract

`window.copyAllOutput` and `refreshViewIfActive` both call `serializedScrollback()`, which is `serializeAddon.serialize({ excludeAltBuffer: true })`. This deliberately reads only the main buffer:

- When Claude is in TUI mode (alt-buffer active), View shows the **main buffer scrollback** — i.e., past output from when Claude was between TUI invocations. This is the "read history" use case.
- The user's TUI is visible in **Live mode**, not View. Switching to View while Claude is mid-response shows static history, not the current TUI frame. That's intended.

If you find yourself wanting to drop `excludeAltBuffer: true`, the right move is to add a separate "live snapshot" mode — don't conflate it with the scrollback-reading View mode.

## Deploy

- CI: `.github/workflows/test.yml` (vitest + playwright on PRs), `.github/workflows/docker-publish.yml` (push to GHCR on main / tags).
- Tower: `ssh tower`, `docker pull ghcr.io/jacob-lasky/pocket-dev:latest`, stop/rm/run with the canonical args. The UnRAID template at `/boot/config/plugins/dockerMan/templates-user/my-pocket-dev.xml` is the source of truth for volumes / env / `--group-add 281`.
- The runtime container does NOT include devDependencies — `npm install --production` in the Dockerfile excludes vitest/playwright/etc.

## Common gotchas

- `<script type="module">` scopes everything inside to the module. Functions referenced from HTML `onclick="..."` attributes MUST be put on `window` explicitly. The `Object.assign(window, { ... })` block at the end of `index.html`'s script is load-bearing — `onclick-coverage.test.js` is the regression guard.
- `ansi_up` v6 is pure ESM, not UMD. Load it via `import { AnsiUp } from '/ansi-up/ansi_up.js'` inside the module script, not as a `<script src>` tag.
- `@xterm/addon-serialize` is UMD with a nested namespace: `new SerializeAddon.SerializeAddon()`, not `new SerializeAddon()`.
- xterm.js's `copyOnSelect: true` silently no-ops on HTTP (clipboard API requires a secure context). We do explicit `term.onSelectionChange` + `clipboardWrite` (with `execCommand` fallback) instead.
