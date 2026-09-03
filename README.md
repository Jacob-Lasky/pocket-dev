# pocket-dev

A browser-accessible terminal for [Claude Code](https://github.com/anthropics/claude-code), packaged as a Docker container for UnRAID. Open the WebUI from a desktop or phone, get a tmux-backed Claude session that survives disconnects and reconnects.

## Architecture

- `mobile/server.js` — Node + Express server. Spawns a tmux session running Claude under a restart loop, exposes the PTY over a WebSocket at `/ws`, serves a mobile-first xterm.js client at `/`.
- `mobile/public/` — the client (xterm.js for the live terminal; the wrapped View renderer walks xterm's parsed buffer directly in `js/view.js`; a small toolbar; an iOS-friendly PWA manifest).
- `Dockerfile` — `node:24-bookworm-slim` base. Ships `gh` CLI, `docker-ce-cli`, the Playwright/chromium headless runtime libs so in-container sessions can run UI probes, the [Codex](https://github.com/openai/codex) CLI so a session can consult a second lab's model without leaving the container, and [Lavish Editor](https://github.com/kunchenguid/lavish-axi) so a session can hand a generated HTML artifact to a human to annotate.

For repo orientation — particularly the two-layers-of-alt-screen gotcha around tmux + Claude's TUI — read `CLAUDE.md`. For shipping changes, see `DEPLOYMENT-GUIDE.md`.

## Install on UnRAID

1. Docker tab → Add Container.
2. Either point Template URL at the raw `pocket-dev.xml` in this repo, or drop a copy in `/boot/config/plugins/dockerMan/templates-user/`.
3. Optional: set `ANTHROPIC_API_KEY`. If you skip it, run `claude login` once the container is up.
4. Apply.

The container exposes port 7681. Click the WebUI button or hit `http://<server>:7681/` from any device on your network. The mobile UI is the same as desktop; iOS users can "Add to Home Screen" for a PWA experience.

Port 4387 is Lavish Editor's review server (see "Point at the thing" below). Set `LAVISH_AXI_LINK_HOST` to the hostname you reach this host by, or the review URLs it prints carry the container's internal bridge address and open nowhere.

## Run locally (development)

```sh
git clone https://github.com/Jacob-Lasky/pocket-dev.git
cd pocket-dev
docker compose up -d --build
# WebUI at http://localhost:7681
```

`docker-compose.yml` mirrors the UnRAID template but uses `./workspace` and `./home` as host paths so local data doesn't collide with a deployed instance. The docker socket is mounted `:ro` for safety in dev.

## Volumes (UnRAID defaults)

| Host path | Container path | Purpose |
|---|---|---|
| `/mnt/user/appdata/claude-code/workspace` | `/workspace` | Claude's working directory; persists files between container recreates |
| `/mnt/user/appdata/claude-code/home` | `/home/claude` | **The entire home, and the only state mount you need.** Claude's config and per-tab conversation ids, the `gh` token, the dgvpn registration, `~/bin` tools a session installs for itself, and credentials for anything else that writes to `~` (`aws`, `kubectl`, `fly`, `docker`). Must be owned `99:100` on the host |
| `/var/run/docker.sock` | `/var/run/docker.sock` (`:ro`) | Access to the host's docker daemon. **`:ro` does not make the API read-only** — it only marks the socket file read-only, and the daemon still honours `run` / `stop` / `rm`. Treat this mount as host root, and drop it or front it with a filtered `docker-socket-proxy` if that is not what you want |

### Why the home is one mount

There used to be a mount per dotfile — `.claude`, `.claude.json`, `.config/gh`, `.dgvpn`, `.pocket-dev`, and more. Anything not on that list silently evaporated on the next image update, which is a recreate: `~/.aws`, `~/.kube`, an installed `flyctl`. Adding a tool meant editing the template and recreating the container, and forgetting to looked exactly like everything working until the update landed.

Mounting the whole home was blocked by a real constraint: the image bakes `claude`, `uv` and `uvx` into `/home/claude/.local/bin`, so a mount over the home masks them and yields a container with no Claude in it. The fix was to stop making the home do two jobs. The image now builds its artifacts into `/opt/pd-home` and ships `/home/claude` **empty**; `entrypoint.sh` symlinks the image-owned entries (`.local`, the shell rc files, `.config/fish`, `.config/uv`) back in at boot. State and artifacts no longer share a directory, so the home can be one mount that persists tools nobody has thought of yet.

Two consequences worth knowing:

- **Install session tools into `~/bin`** (on `PATH`, inside the mount), not `~/.local/bin` — that one is a symlink into the image skeleton, and writes there are lost on the next update.
- **`~/.cache` and `~/.npm` are deliberately not persisted.** They are relinked to a container-local path, because the home mount lands on the UnRAID array over shfs FUSE and a write-heavy cache is the wrong traffic for it.

## A second model in the box

The image also ships [Codex](https://github.com/openai/codex), OpenAI's coding CLI, at `/usr/local/bin/codex`. It is not an alternative to Claude here, it is a second opinion: a model from a different lab has different blind spots, so asking it to attack a diff catches things a self-review agrees with itself about.

```sh
git diff | codex exec "Assume this contains at least one defect. Enumerate the inputs that break it and what each one causes. Do not report style." \
  -s read-only -c model_reasoning_effort="high" -o /tmp/co.txt
```

Two things about that invocation are load-bearing rather than stylistic. `-s read-only` keeps the consultant from editing the tree it is reviewing. And a **directed** prompt is what makes it useful at all: on an identical two-line diff, a bare `codex exec review --uncommitted` reported nothing while the prompt above found an unhandled `ZeroDivisionError`. Treat a clean result from an undirected run as no information.

Run it from inside a checkout. Codex refuses to start outside a git repo (`Not inside a trusted directory`), and a session's starting directory is `$HOME`, which is not one. For a question with no diff attached, pass `--skip-git-repo-check`.

**The container runs with `--security-opt seccomp=unconfined`, and codex is why.** Codex sandboxes every command it spawns with bubblewrap, which needs an unprivileged user namespace; Docker's default seccomp profile denies that, so `codex exec review` died before reading a single file while still printing "No findings were identified" with the abort tucked into the second clause. A review that never ran and a review that found nothing looked identical. The flag is a real loosening, and it is defensible here only because this container already mounts the docker socket (host-root equivalent, see the volumes table), so seccomp was never the boundary protecting the host. It also cuts the other way: it is what allows codex's own read-only sandbox to engage.

**Log in once, and it stays.** Codex writes `~/.codex/auth.json`, which is inside the home mount, so the login survives image updates and recreates with no volume of its own. The container has no browser, so use the device-code flow:

```sh
codex login --device-auth   # prints a URL and a code; open them on any other device
```

The auth is deliberately not baked into the image. Copying an `auth.json` in from another machine also works and is documented upstream, but it puts two machines on one session; the device flow gives the container its own.

## Point at the thing

The image ships [Lavish Editor](https://github.com/kunchenguid/lavish-axi) at `/usr/local/bin/lavish-axi`. A session that has generated an HTML artifact (a plan, a comparison, a diagram, a report) opens it for review; you get a URL, open it on your phone, and annotate the actual elements instead of describing them.

```sh
lavish-axi /coding/dump/plan/plan.html       # prints JSON containing the review URL
lavish-axi poll /coding/dump/plan/plan.html  # long-poll until you send feedback
```

**Two settings decide whether the URL is openable, and both fail quietly.** `LAVISH_AXI_LINK_HOST` is the hostname written into the URL: leave it blank and you get the address Lavish bound, which on the default bridge is a `172.x` address resolving nowhere outside the container, so the feature looks broken while working perfectly. `LAVISH_AXI_ALLOWED_HOSTS` adds the other names you might type for the same host (LAN IP, short hostname, Tailscale IP) to Lavish's DNS-rebinding allowlist, which otherwise answers `403` with a page naming the URL that would have worked.

The bind address is handled for you: `entrypoint.sh` resolves the container's own address at boot, because Lavish refuses a wildcard bind (`0.0.0.0` is coerced back to loopback) and a loopback listener is unreachable through a published port. That holds on a bridge network, which is what the template declares; `--network host` ignores `-p` entirely and macvlan needs no mapping, so set `LAVISH_AXI_HOST` yourself there. `CLAUDE.md` has the measurement.

**Port 4387 serves the artifact with no authentication**, and the Host allowlist is DNS-rebinding protection rather than a login: a direct client just sends an accepted `Host`. That is acceptable next to 7681, which is an unauthenticated terminal in a container holding the docker socket, so for anyone who can reach both it grants nothing new. It is still a second reachable server with its own file-read and feedback surface, and a firewall may treat the two ports differently, so publish 4387 exactly where 7681 already is and nowhere else. Sessions and queued feedback live in `~/.lavish-axi`, inside the home mount, so they survive a recreate.

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
pnpm install
pnpm test              # vitest (unit + server)
pnpm test:e2e          # Playwright on chromium + firefox + webkit
```

WebKit is in the matrix because mobile Safari's CSS engine has historically interpreted some properties (e.g. `word-break: break-word`) differently than Chromium and Firefox; without it, Safari-only mobile-UI regressions ship green.

## Tech

- Base: `node:24-bookworm-slim` (Debian Bookworm, newest LTS and the last major that bundles corepack)
- Terminal: `node-pty` + `@xterm/xterm` + `@xterm/addon-fit`
- View renderer: in-house buffer walk in `mobile/public/js/view.js` (reads xterm's parsed buffer → colour-preserving wrapped HTML; no ANSI round-trip)
- Session persistence: `tmux`, plus an on-disk roster + per-tab Claude conversation id under `PD_STATE_DIR` so sessions outlive the container
- Architectures: `linux/amd64` (pocket-dev runs only on an amd64 host; building arm64 under QEMU roughly doubled CI time for a target nothing runs)
- Container user: `claude` (uid 99, gid 100; matches UnRAID's `nobody:users`)

## License

MIT. See `LICENSE`.
