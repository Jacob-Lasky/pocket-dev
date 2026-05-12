# pocket-dev

A browser-accessible terminal for [Claude Code](https://github.com/anthropics/claude-code), packaged as a Docker container for UnRAID. Open the WebUI from a desktop or phone, get a tmux-backed Claude session that survives disconnects and reconnects.

## Architecture

- `mobile/server.js` — Node + Express server. Spawns a tmux session running Claude under a restart loop, exposes the PTY over a WebSocket at `/ws`, serves a mobile-first xterm.js client at `/`.
- `mobile/public/` — the client (xterm.js for the live terminal, `ansi_up` for the wrapped View renderer, a small toolbar, an iOS-friendly PWA manifest).
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
| `/var/run/docker.sock` | `/var/run/docker.sock` (`:ro`) | Inspect-only access to the host's docker daemon. Read `docker ps`, `docker logs`, `docker inspect` — **not** restart / stop / run (those need `:rw`) |

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
- Terminal: `node-pty` + `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-serialize`
- View renderer: `ansi_up` (ANSI → HTML, wrapped reading layout)
- Session persistence: `tmux`
- Architectures: `linux/amd64` + `linux/arm64`
- Container user: `claude` (uid 99, gid 100; matches UnRAID's `nobody:users`)

## License

MIT. See `LICENSE`.
