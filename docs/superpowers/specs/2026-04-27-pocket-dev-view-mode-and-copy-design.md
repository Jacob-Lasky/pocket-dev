# pocket-dev — View Mode + Copy QoL Pass

**Date:** 2026-04-27
**Status:** Design approved, awaiting user review of spec
**Scope:** Quality-of-life fixes to terminal viewing, scrolling, and copying on both mobile (Firefox/Pixel) and desktop (HTTP)

## Goals

Fix four pain points in the current pocket-dev terminal experience:

1. **Trailing whitespace on copy.** Copying from Select mode pastes lines padded with trailing spaces.
2. **Mobile width.** Plaintext scrollback in the Select overlay does not wrap, forcing horizontal scrolling on mobile.
3. **Duplicated history chunks.** xterm.js scrollback occasionally shows repeated chunks of output (alternate-screen / scroll-region interaction with TUI apps like Claude Code).
4. **No top-level copy.** Copying any text requires entering the modal Select overlay first; on desktop over HTTP, even xterm.js's `copyOnSelect` silently no-ops because `navigator.clipboard` requires a secure context.

## Non-goals

- Replacing xterm.js with a different terminal library.
- Migrating to HTTPS (out of scope; would simplify some paths but is not required for this fix).
- Restructuring the existing mobile HTML typing wrapper.
- Improving touch interaction inside xterm.js itself (xterm.js touch is unusable on the user's Firefox-on-Pixel; the design routes around it rather than fixing it).

## Architecture overview

Today's UI exposes one rendering surface (xterm.js) plus a modal "Select" overlay that fetches a snapshot via `tmux capture-pane`. The new design:

- **Two co-mounted rendering surfaces** that share xterm.js as the source of truth:
  - **Live mode** — the existing xterm.js terminal (input + live render). Used as-is.
  - **View mode** — a new wrapped HTML reader. Renders xterm.js's buffer through `@xterm/addon-serialize` + `ansi_up` into a `<div>` with `white-space: pre-wrap; word-break: break-word`. Auto-updates as new output streams in.
- **Toolbar toggle** switches the visible surface. Both stay mounted; xterm.js continues to render hidden in the background so the WebSocket pipe never pauses.
- **Default mode is device-dependent:** mobile defaults to View (xterm.js touch is broken on Firefox/Pixel; the existing typing wrapper handles input); desktop defaults to Live (selection works there).
- **Copy works from both modes** via a top-level toolbar button and via native browser select/copy, falling back to `document.execCommand('copy')` on HTTP.
- **Server-side:** disable tmux's alternate-screen so scrollback is one continuous main-buffer stream — eliminates the duplicated-chunks behavior at the source.

## Components

### Client: View mode renderer

- New module in `mobile/public/index.html` (or a sibling `view.js`) that:
  - Subscribes to xterm.js data via the WebSocket (or a tap on the existing data flow into xterm.js).
  - Maintains a rolling buffer of recent ANSI bytes.
  - On render, calls `serializeAddon.serialize({ excludeAltBuffer: true })` to get clean VT bytes from xterm.js, then `ansi_up.ansi_to_html(buf)` to produce styled HTML.
  - Appends/replaces innerHTML of `#view-content` (a `<div>` styled `white-space: pre-wrap; word-break: break-word; font-family: monospace`).
  - Auto-scrolls to bottom on new content unless the user has scrolled up (sticky-bottom behavior).
- Container: `<div id="view-pane">` containing `#view-content`. `overflow-y: auto` for native browser scrolling.

### Client: Mode toggle

- Toolbar button `[ Live | View ]` (segmented control). Tap toggles `body[data-mode="live"]` ↔ `body[data-mode="view"]`.
- CSS hides the inactive surface (`display: none` for the inactive one; xterm.js stays mounted but offscreen via `visibility: hidden` if `display: none` would mess with its sizing — to verify during implementation).
- Initial mode: `view` on mobile (UA-detect or `matchMedia('(pointer: coarse)')`), `live` on desktop.

### Client: Copy actions

- Toolbar `📋 Copy` button: calls `term.selectAll()` → `clipboardWrite(term.getSelection())` → `term.clearSelection()`.
- Live mode auto-copy on selection: `term.onSelectionChange(() => { if (term.hasSelection()) clipboardWrite(term.getSelection()) })`. Replaces xterm.js's built-in `copyOnSelect: true` which silently fails on HTTP.
- Keyboard binding: Ctrl+Shift+C in Live mode → `clipboardWrite(term.getSelection())`. Ctrl+C is left alone (passes through to terminal as SIGINT).
- View mode: native browser selection + system Copy menu / Ctrl+C work without code changes (it's normal HTML).
- View mode also gets a `📋 Copy All` button that writes the full View content as plain text.

### Client: Clipboard helper

A single `clipboardWrite(text)` helper used everywhere:

```js
function clipboardWrite(text) {
  const clean = text.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n');
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(clean).catch(() => execCopy(clean));
  }
  return Promise.resolve(execCopy(clean));
}
```

The per-line trailing-whitespace strip is belt-and-suspenders: `term.getSelection()` already trims (per [xterm.js #673](https://github.com/xtermjs/xterm.js/issues/673)), but stripping again costs nothing and protects any path that might leak padding.

`execCopy` already exists in `index.html:640` — keep it.

### Server: tmux config

In `mobile/server.js:39`, the tmux spawn needs two new settings:

- `setw -g alternate-screen off` — eliminates duplicated-chunks scrollback (#3) by keeping all output in the main buffer.
- `set -g focus-events on` — forwards focus-in/focus-out escape sequences from xterm.js into Claude Code, so Claude knows when the browser tab regains focus and can redraw/refresh its UI state instead of leaving stale render. Default is `off` and Claude Code does emit focus events.

Implementation: ship a small `tmux.conf` via `-f /path/to/tmux.conf` with both settings, rather than threading them through `;` separators in the spawn args (cleaner, easier to add future settings):

```
# pocket-dev tmux config
setw -g alternate-screen off
set -g focus-events on
```

```js
const ptyProc = pty.spawn('tmux', [
  '-u',
  '-f', '/path/to/tmux.conf',
  'new-session', '-A', '-s', SESSION, LOOP_CMD,
], { ... });
```

Trade-off (alt-screen off): TUI apps inside the session lose alt-screen restore on exit (their final state stays in scrollback instead of disappearing). For pocket-dev's only use case (Claude Code), this is desired — Claude's output stays available to scroll back through.

### Server: deletions

- Delete the `/history` endpoint (`mobile/server.js:111-116`). xterm.js's serialize addon replaces it; no more `tmux capture-pane` shell-out.

### Client: deletions

- Delete the entire Select mode overlay:
  - HTML: `#select-overlay` and children (`mobile/public/index.html:272-289`)
  - CSS: rules for `.select-btn`, `#select-overlay`, `#select-topbar`, `#select-hint`, `#select-actions`, `#select-scroll`, `#select-content`
  - JS: `enterSelectMode`, `exitSelectMode`, `copyAll`, the Escape-key handler at `index.html:652-655`
- Keep `execCopy` (now used by `clipboardWrite`).

### Client: dependencies

Add two libraries to `mobile/public/`:
- `@xterm/addon-serialize` (~5KB minified) — for dumping xterm.js's buffer.
- `ansi_up` (~10KB, single ES6 file) — for ANSI → HTML conversion.

No build step. Drop into `public/` and `<script>` tag from `index.html`. Or load from a pinned CDN URL — choice deferred to plan.

xterm.js scrollback bumped to `scrollback: 10000` to make the View mode useful for long sessions.

## Data flow

```
PTY (tmux session)
  │
  ▼
ptyProc.onData ──► appendToReplay (ring buffer, existing)
  │                  │
  ├─► xterm.js term.write() ──┬─► Live mode display
  │                            └─► serialize addon (on demand)
  │                                  │
  │                                  ▼
  │                                 ansi_up.ansi_to_html()
  │                                  │
  │                                  ▼
  │                                 #view-content innerHTML
  │
  └─► WebSocket clients (existing)
```

View mode re-serializes from xterm.js on a debounced trigger (every ~100ms when new data arrives) rather than re-parsing a raw stream itself. This means xterm.js stays the single source of truth for terminal state.

## Mobile-specific behavior

- Default mode = View on first load.
- Toolbar layout: `[ Live | View ]  [📋]  [other existing buttons]`
- The existing HTML typing wrapper continues to handle input regardless of mode (it sends keystrokes to the WebSocket; doesn't depend on xterm.js focus).
- xterm.js remains mounted hidden so its buffer stays current.

## Desktop-specific behavior

- Default mode = Live.
- xterm.js `copyOnSelect: true` is **disabled**; replaced with the explicit `onSelectionChange` listener that uses the HTTP-safe `clipboardWrite` helper.
- Highlight + release → in clipboard automatically. Highlight stays visible (xterm.js default).
- Ctrl+Shift+C copies current selection. Ctrl+C still acts as SIGINT.

## Error handling

- `clipboardWrite` falls back to `execCopy` on rejection or absence of `navigator.clipboard`. If both fail, surface a toast: "Copy failed — long-press to use system copy." (Match the existing hint pattern.)
- View mode rendering errors (ansi_up exception, serialize exception): catch, log, fall back to inserting plain text via `textContent`.
- `serialize()` on a very large buffer is O(buffer size). Cap at `scrollback: 10000` and debounce re-serializes during bursty output to avoid jank.

## Testing

The project currently has no tests. This pass adds the first test infrastructure.

### Tooling

- **Vitest** for unit + server tests. Fast, ESM-native, less ceremony than Jest.
- **Supertest** for express endpoint assertions.
- **Playwright** for E2E in headless Firefox and Chromium. Firefox is primary because it's the user's mobile target; Chromium is included to catch regressions.
- All run via `npm test` from `mobile/`. CI workflow added at `.github/workflows/test.yml`.

### Unit tests (`mobile/test/unit/`)

- `clipboardWrite.test.js`
  - Strips trailing spaces and tabs per line.
  - Preserves intentional internal whitespace.
  - Calls `navigator.clipboard.writeText` when available; resolves on success.
  - Falls back to `execCopy` when `navigator.clipboard` is undefined.
  - Falls back to `execCopy` when `navigator.clipboard.writeText` rejects (HTTP / permission denied).
  - Returns `false` when both paths fail.
- `viewRenderer.test.js`
  - Given a known ANSI byte string, produces expected HTML (color spans, line breaks).
  - Empty input → empty output, no exception.
  - Buffer cap respected (does not OOM on huge input — sized down to `scrollback` cap).
  - Sticky-bottom scroll: when user has scrolled up, new output does not auto-scroll; when at bottom, new output keeps view at bottom.
- `modeDetect.test.js`
  - `matchMedia('(pointer: coarse)')` true → default mode is `view`.
  - Pointer fine → default mode is `live`.

### Server tests (`mobile/test/server/`)

- `endpoints.test.js`
  - `GET /history` returns 404 (endpoint removed).
  - `GET /` returns the index.html.
  - WebSocket upgrade succeeds and streams a known string back.
- `tmuxConfig.test.js`
  - `pty.spawn` is called with `-f` pointing at the bundled `tmux.conf`.
  - The bundled `tmux.conf` contains `setw -g alternate-screen off` and `set -g focus-events on` (literal-string check on the file).

### E2E tests (`mobile/test/e2e/`)

Run against a server started fresh per test (random port, `LOOP_CMD` set to a deterministic stub like `cat` so output is predictable).

- `smoke.spec.js`
  - Page loads; toolbar present with Live, View, and Copy buttons.
  - WebSocket connects; sending `echo hello\n` shows `hello` in Live xterm.js render.
  - Toggling to View shows `hello` in the View pane within 200ms.
  - Sending a second command updates the View pane live.
  - Long line in View pane wraps (no horizontal scrollbar on a 360px-wide viewport — emulating Pixel).
- `copy.spec.js`
  - Click Copy button → `navigator.clipboard.readText()` returns the terminal's current content with no trailing whitespace per line.
  - In Live mode (Chromium): drag-select a region → release → clipboard contains exactly the selected text, no padding.
  - HTTP fallback path: monkey-patch `navigator.clipboard.writeText` to reject; click Copy; assert `execCopy` ran (spy on `document.execCommand` calls) and the textarea trick wrote the right text.
- `firefox-mobile.spec.js`
  - Run with Playwright Firefox + Pixel 5 emulation profile.
  - Default mode is View on first load.
  - Long-press → drag → release produces a real DOM Selection over expected text (sanity check that View mode is selectable; doesn't actually copy because Playwright's mobile context doesn't expose clipboard the same way).

### Manual verification (things automated tests can't cover)

These remain in a `mobile/MANUAL-VERIFICATION.md` checklist, run before tagging a release:

1. Real Pixel + Firefox: long-press select + system Copy menu produces clean text in View mode.
2. Pocket-dev served over HTTP (not localhost) from another machine on the LAN: highlight in Live xterm.js + Ctrl+Shift+C copies on desktop.
3. Real Claude Code session for several minutes including long alt-screen-y responses: no duplicated chunks in scrollback.
4. Browser tab loses then regains focus: Claude Code redraws its UI without stale cursor or stuck spinner.

### Running locally

- `npm test` — unit + server (Vitest)
- `npm run test:e2e` — Playwright (auto-starts the server)
- `npm run test:all` — both

## Files affected

- `mobile/public/index.html` — toolbar, View pane, mode toggle, clipboard handlers, dep `<script>` tags, delete Select overlay
- `mobile/server.js` — tmux spawn args (use `-f tmux.conf`), delete `/history` endpoint; refactored so the express app and pty boot logic are exportable for tests
- `mobile/tmux.conf` — new file; sets `alternate-screen off` and `focus-events on`
- `mobile/public/` — new files: `addon-serialize.js`, `ansi_up.js` (or CDN-linked)
- `mobile/test/` — new directory: `unit/`, `server/`, `e2e/` test suites
- `mobile/MANUAL-VERIFICATION.md` — new checklist for things automated tests can't cover
- `mobile/package.json` — add `vitest`, `supertest`, `@playwright/test` as devDependencies; add `test`, `test:e2e`, `test:all` scripts
- `mobile/playwright.config.js` — new; Firefox + Chromium projects, Pixel 5 mobile profile
- `mobile/vitest.config.js` — new
- `.github/workflows/test.yml` — new; runs `npm ci && npm run test:all` on push/PR
- `Dockerfile` — copy in `mobile/tmux.conf`; verify tmux is recent enough (alt-screen and focus-events are both ancient, any modern tmux is fine). Test deps stay dev-only and don't ship to the runtime image.

## Out of scope / future work

- HTTPS support (would let us drop the `execCopy` fallback).
- Per-region copy buttons in View mode (e.g., copy a single Claude response).
- Search-in-scrollback (`Ctrl+F` over View content).
- Persisting scrollback across page reloads.
- Replacing xterm.js entirely.

## Open questions for user review

- **Default mode detection:** UA sniff or `matchMedia('(pointer: coarse)')`? Either works; the latter is more robust to future devices. Defer to plan.
- **Dep delivery:** vendored copies in `public/` or CDN? Vendoring is more reliable on the LAN; CDN is one less file to track. Defer to plan.
