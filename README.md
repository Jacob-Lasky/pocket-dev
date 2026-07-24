# pocket-dev

A browser-accessible terminal for [Claude Code](https://github.com/anthropics/claude-code), packaged as a Docker container for UnRAID. Open the WebUI from a desktop or phone, get a tmux-backed Claude session that survives disconnects and reconnects.

## Architecture

- `mobile/server.js` — Node + Express server. Spawns a tmux session running Claude under a restart loop, exposes the PTY over a WebSocket at `/ws`, serves a mobile-first xterm.js client at `/`.
- `mobile/public/` — the client (xterm.js for the live terminal; the wrapped View renderer walks xterm's parsed buffer directly in `js/view.js`; a small toolbar; an iOS-friendly PWA manifest).
- `Dockerfile` — `node:20-slim` base. Ships `gh` CLI, `docker-ce-cli`, and the Playwright/chromium headless runtime libs so in-container sessions can run UI probes.

For repo orientation — particularly the two-layers-of-alt-screen gotcha around tmux + Claude's TUI — read `CLAUDE.md`. For shipping changes, see `DEPLOYMENT-GUIDE.md`.

## Install on UnRAID

1. Docker tab → Add Container.
2. Either point Template URL at the raw `pocket-dev.xml` in this repo, or drop a copy in `/boot/config/plugins/dockerMan/templates-user/`.
3. Optional: set `ANTHROPIC_API_KEY`. If you skip it, run `claude login` once the container is up.
4. Apply.

The container exposes port 7681. Click the WebUI button or hit `http://<server>:7681/` from any device on your network. The mobile UI is the same as desktop; iOS users can "Add to Home Screen" for a PWA experience.

## Run locally (development)

```sh
git clone https://github.com/Jacob-Lasky/pocket-dev.git
cd pocket-dev
docker compose up -d --build
# WebUI at http://localhost:7681
```

`docker-compose.yml` mirrors the UnRAID template but uses `./workspace` and `./config` as host paths so local data doesn't collide with a deployed instance. The docker socket is mounted `:ro` for safety in dev.

## Volumes (UnRAID defaults)

| Host path | Container path | Purpose |
|---|---|---|
| `/mnt/user/appdata/claude-code/workspace` | `/workspace` | Claude's working directory; persists files between container recreates |
| `/mnt/user/appdata/claude-code/config` | `/home/claude/.claude` | Claude config + auth state |
| `/mnt/user/appdata/claude-code/claude.json` | `/home/claude/.claude.json` | MCP server configs + Claude settings (file-level mount) |
| `/mnt/user/appdata/claude-code/pocket-dev` | `/home/claude/.pocket-dev` | Open sessions + each tab's Claude conversation id, so a restart or image update restores your tabs instead of dropping them |
| `/mnt/user/appdata/claude-code/gh` | `/home/claude/.config/gh` | `gh auth login` token; without it the token dies with every image update |
| `/mnt/user/appdata/claude-code/tools` | `/opt/pd` | Writable, on-`PATH` prefix for CLIs a session installs for itself. Use this instead of mounting `/home/claude/.local`, which would mask the `claude` and `uv` binaries baked into the image |
| `/var/run/docker.sock` | `/var/run/docker.sock` (`:ro`) | Access to the host's docker daemon. **`:ro` does not make the API read-only** — it only marks the socket file read-only, and the daemon still honours `run` / `stop` / `rm`. Treat this mount as host root, and drop it or front it with a filtered `docker-socket-proxy` if that is not what you want |

## Sessions survive a restart

Each browser tab is a tmux session, and the set of them is recorded under `PD_STATE_DIR` (`/home/claude/.pocket-dev`). When the server comes back up it restores that roster before it starts listening, so an open browser reconnects into the same tabs on its own.

Each tab is also bound to a stable Claude conversation id, so a restored tab resumes the conversation it was having rather than opening a blank one. If Claude was waiting on you, it comes back and goes on waiting. Typing `/exit` still gives you a fresh conversation — only a respawn resumes.

If Claude was mid-task, what happens next depends on **how** the container went down:

- **You restarted it** (`docker restart`, a stop, an image update): the session is asked `continue please` and picks the work back up.
- **It died** (OOM kill, hard kill, power loss): the session is restored and the conversation resumed, but it is **not** told to continue. It is warned that the shutdown was unexpected and asked to check whether its own work caused it before retrying. A Claude session can take a host down by building something the wrong way, and auto-continuing there just does it again.

The difference is a `clean-shutdown` marker written by the server's signal handler on the way out, so an exit that never got a say can never look deliberate.

| Env var | Default | What it does |
|---|---|---|
| `PD_STATE_DIR` | `/home/claude/.pocket-dev` | Where the roster and per-tab conversation ids live |
| `PD_RESUME` | on | `0` disables conversation resume; the tab roster still restores |
| `PD_RESUME_NUDGE` | `continue please` | What an interrupted session is asked after a deliberate restart. Empty string sends nothing |
| `PD_CRASH_NUDGE` | a warning, see above | What it is told instead after an unexpected shutdown. Empty string sends nothing |
| `PD_TRUST_WORKSPACE` | on | `0` keeps Claude's workspace-trust prompt, which every restored tab will then wait on |

Resume applies only when pocket-dev owns the command line; setting `SHELL_CMD` turns it off, since an arbitrary command has no conversation to resume.

## Tests

The Playwright + vitest suite under `mobile/` runs on every push and PR:

```sh
cd mobile
npm ci
npm test               # vitest (unit + server)
npm run test:e2e       # Playwright on chromium + firefox + webkit
```

WebKit is in the matrix because mobile Safari's CSS engine has historically interpreted some properties (e.g. `word-break: break-word`) differently than Chromium and Firefox; without it, Safari-only mobile-UI regressions ship green.

## Tech

- Base: `node:20-slim` (Debian Bookworm)
- Terminal: `node-pty` + `@xterm/xterm` + `@xterm/addon-fit`
- View renderer: in-house buffer walk in `mobile/public/js/view.js` (reads xterm's parsed buffer → colour-preserving wrapped HTML; no ANSI round-trip)
- Session persistence: `tmux`, plus an on-disk roster + per-tab Claude conversation id under `PD_STATE_DIR` so sessions outlive the container
- Architectures: `linux/amd64` (pocket-dev runs only on an amd64 host; building arm64 under QEMU roughly doubled CI time for a target nothing runs)
- Container user: `claude` (uid 99, gid 100; matches UnRAID's `nobody:users`)

## License

MIT. See `LICENSE`.
