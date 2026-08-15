# dgvpn-proxy: a single-user userspace Tailscale identity plus a localhost HTTP
# proxy that routes only .consul/tailnet traffic through the Deepgram tailnet
# (everything else dials direct). DO NOT replace this with `tailscale up` or
# tailscaled: userspace tailscaled cannot resolve .consul split-DNS for outbound
# connections (tailscale#16906, tailscale#4677), which is the entire point here.
# The Go side in vpn/ resolves names via the tsnet LocalAPI instead. Built static
# (CGO_ENABLED=0) so it drops into the node:24-bookworm-slim final image with no runtime
# deps. Pin matches vpn/go.mod's `go 1.26`.
FROM golang:1.26-bookworm AS dgvpn-builder
WORKDIR /build/vpn
COPY vpn/go.mod vpn/go.sum* ./
# Cache mounts persist the module cache and the Go build cache across CI runs
# (the workflow's buildx gha backend stores them), so the large tailscale.com
# dependency graph is compiled incrementally instead of from scratch each build.
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY vpn/ ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -o /dgvpn-proxy -ldflags='-s -w' .

FROM node:24-bookworm-slim

# Install system dependencies
# build-essential + python3 are required to compile node-pty (native addon).
# The lib*/fonts-* group is Playwright/chromium's headless runtime — only the
# system libs, NOT the chromium binary itself. Sessions that want Playwright
# still run `npx playwright install chromium` to pull the browser; the bundled
# binary then dlopens these libs without `--with-deps` (which needs sudo apt,
# which this container does not have). Don't drop one of these on a Debian
# upgrade without checking Playwright's per-distro deps list — a missing
# libglib2 or libnss3 is what punted a prior session into asking the user to
# verify the UI manually instead of running the probe.
#
# bubblewrap is what `codex -s read-only` sandboxes itself with on Linux, and
# /second-opinion passes that flag on every consult. Codex ships a bundled bwrap
# and falls back to it, so the sandbox WORKS without this package, but every run
# then prints a "could not find bubblewrap on PATH" warning that reads exactly
# like the sandbox failing to engage. It costs ~150 KB and removes a line that
# would otherwise be re-diagnosed from scratch by every session that sees it.
RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    tmux \
    ca-certificates \
    gnupg \
    lsb-release \
    jq \
    bubblewrap \
    build-essential \
    python3 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libpango-1.0-0 \
    libcairo2 \
    libgbm1 \
    libasound2 \
    fonts-liberation \
    fonts-noto-color-emoji \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update \
    && apt-get install -y docker-ce-cli \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI via its official apt repo (amd64 + arm64).
# DO NOT go back to deriving the version from api.github.com/repos/cli/cli/
# releases/latest: that endpoint is unauthenticated-rate-limited (60/hr per IP),
# shared CI runner IPs hit it constantly, and a 403 there yields an empty
# tag_name -> a 404 download -> a failed build. The apt repo is not API-rate-
# limited and always serves the current stable gh.
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y gh \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Codex, OpenAI's coding CLI, so a session can consult a SECOND lab's model
# without leaving the container. This is what the /second-opinion skill drives,
# and that skill's whole value is decorrelated error: Claude reviewing Claude
# shares its blind spots, so a container holding only one vendor's model cannot
# produce a second opinion at all. The skill checks `command -v codex` and stops
# when it is missing rather than substituting Claude's own view, which is why
# the tool has to be present in the image and not merely available in principle.
#
# npm -g into /usr/local, NOT into $HOME. The home is a bind mount that ships
# EMPTY (see the relocation block near the end of this file), so anything
# image-owned written under /home/claude is masked at runtime. Do NOT "fix" that
# by installing into ~/bin instead: that prefix is for CLIs a SESSION installs
# for itself, it sits EARLIER on PATH than /usr/local/bin, and a stale copy left
# there would permanently shadow the image's own and never update again.
#
# Deliberately UNPINNED, the same call already made for `claude` (install.sh)
# and `gh` (apt stable): every image build takes the current release, so the
# tool tracks upstream instead of freezing at whatever was newest the day this
# line was written. `codex --version` at the end puts the resolved version in
# the build log, so a build is still self-documenting about what it shipped.
#
# Roughly 300 MB, nearly all of it two Rust binaries (258 MB codex, 50 MB
# codex-code-mode-host; measured on 0.147.0). npm resolves only the linux-x64
# optional dependency, so there are no other platforms' binaries to prune, and
# the same bytes arrive whichever install channel is used.
#
# Auth is NOT baked in and must not be: `codex login --device-auth` writes
# ~/.codex/auth.json at runtime, which is inside the home mount and therefore
# already survives image updates with no volume of its own.
RUN npm install -g --no-fund --no-audit @openai/codex \
    && npm cache clean --force \
    && codex --version

# Add claude shortcut aliases. `opus`/`sonnet` are MOVING aliases: each resolves
# to the newest model in its family at launch, by design (Jake wants these to
# track latest automatically). DO NOT pin them back to claude-opus-X-Y / a dated
# sonnet id — that freezes the shortcut to an aging model.
RUN echo '#!/bin/bash' > /usr/local/bin/cdspo \
    && echo 'exec claude --dangerously-skip-permissions --model "opus[1m]" "$@"' >> /usr/local/bin/cdspo \
    && echo '#!/bin/bash' > /usr/local/bin/cdsps \
    && echo 'exec claude --dangerously-skip-permissions --model sonnet "$@"' >> /usr/local/bin/cdsps \
    && chmod +x /usr/local/bin/cdspo /usr/local/bin/cdsps

# Create docker group and user with proper permissions.
# The per-state-dir mkdirs that used to live here (.claude, .pocket-dev) are gone:
# /home/claude is a bind mount at runtime and ships EMPTY in the image, so a dir
# created here would be masked by the mount and never seen. entrypoint.sh creates
# them inside the mounted home instead, where they persist.
RUN groupadd -g 281 docker || true && \
    useradd -m -u 99 -g 100 -G 281 claude && \
    mkdir -p /workspace && \
    chown -R claude:users /workspace && \
    chmod -R 775 /workspace

# Install pocket-dev server (as root, before switching users)
# pnpm install compiles node-pty natively here. This is an expensive layer, so it
# comes BEFORE the dgvpn block: dgvpn changes far more often than mobile/, and
# putting the frequently-changing dgvpn COPY after this keeps the node-pty
# rebuild cached on vpn-only changes.
#
# Node 24, not 20: pnpm 11 refuses to run on anything below Node 22.13, and
# Node 20 went end-of-life in April 2026. Keep this at a current LTS.
#
# The tag is bookworm-slim, NOT plain 24-slim. Plain would move the base to
# Debian trixie in the same change, and trixie renamed several of the Playwright
# runtime libs installed above to their t64 variants (libasound2, libatk1.0-0,
# libcups2, libatspi2.0-0). That is the exact breakage the apt block warns about,
# so the distro bump belongs in its own change with the deps list rechecked.
#
# pnpm comes from corepack, which Node bundles up to 24, NOT from `npm install -g`.
# corepack reads the `packageManager` pin in mobile/package.json, so the version
# lives in exactly one place and cannot drift between here, CI, and the lockfile.
# This is a second reason to hold the base at an LTS: Node 25 dropped bundled
# corepack, and moving past 24 means reintroducing an `npm i -g pnpm` bootstrap.
#
# --prod drops devDependencies (vitest, playwright) from the runtime image, and
# --frozen-lockfile makes the build fail loudly if pnpm-lock.yaml is out of step
# with package.json instead of silently resolving something else.
#
# pnpm's default symlinked node_modules is kept: server.js serves xterm's browser
# assets with express.static(__dirname + '/node_modules/@xterm/xterm'), and that
# resolves through the symlink into the .pnpm store normally. Verified by running
# the e2e suite against a pnpm install, which loads those assets over /xterm.
RUN corepack enable pnpm
COPY mobile/ /mobile/
RUN cd /mobile && sed -i 's/\r//' start.sh pd-claude-session pd-trust-workspace && \
    pnpm install --prod --frozen-lockfile && \
    chmod +x /mobile/start.sh /mobile/pd-claude-session /mobile/pd-trust-workspace && \
    chown -R claude:users /mobile

# Where the session roster and each tab's Claude conversation id live, so a
# restart brings the user's sessions back instead of one blank one. This is
# inside /home/claude, which is the single `Home` bind mount in pocket-dev.xml,
# so it survives a container RECREATE with no volume of its own.
ENV PD_STATE_DIR=/home/claude/.pocket-dev

# dgvpn: the static tsnet proxy binary plus the two wrapper commands. Installed
# as root into /usr/local/bin (on PATH for the claude user). The proxy runs as
# the unprivileged claude user at runtime: userspace tsnet needs no TUN device
# and no NET_ADMIN, so this works in the unprivileged container. State lives
# under /home/claude/.dgvpn, inside the single `Home` bind mount, so the ~24h
# Keycloak registration survives a RECREATE without a volume of its own. The dir
# is created by entrypoint.sh (inside the mount), NOT here — anything this layer
# put at that path would just be masked. Kept last (just before USER claude) so
# iterating on vpn/ does not bust the apt or npm layers above.
COPY --from=dgvpn-builder /dgvpn-proxy /usr/local/bin/dgvpn-proxy
COPY vpn/dgvpn vpn/dgvpn-up /usr/local/bin/
RUN sed -i 's/\r//' /usr/local/bin/dgvpn /usr/local/bin/dgvpn-up && \
    chmod +x /usr/local/bin/dgvpn /usr/local/bin/dgvpn-up /usr/local/bin/dgvpn-proxy
# Single source of truth for the proxy port at runtime. The Go binary and both
# wrapper scripts read DGVPN_PROXY_PORT; their in-code defaults are fallbacks
# only. Set it once here so the three never drift. Override via the template to
# move the port. DGVPN_DIR matches the persisted `dgvpn State` volume in pocket-dev.xml.
ENV DGVPN_PROXY_PORT=1055
ENV DGVPN_DIR=/home/claude/.dgvpn

# Switch to claude user before installing
USER claude

# Install claude-code and uv as the claude user
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && curl -LsSf https://astral.sh/uv/install.sh | sh

# Move the image's home OUT of /home/claude so the real home can be a single
# bind mount.
#
# WHY. /home/claude was doing two incompatible jobs: holding image artifacts
# (the claude/uv binaries, shell rc files, fish and uv configs) and holding
# every tool's state. That forced one bind mount per dotfile in the template
# (.claude, .claude.json, .config/gh, .dgvpn, .pocket-dev, .codex,
# .google_workspace_mcp) and made mounting the home wholesale forbidden, because
# a mount over /home/claude masks .local/bin and leaves a container with no
# `claude` in it. Anything the list forgot — .aws, .kube, .fly — silently
# evaporated on every image update. Separating the two jobs is what lets the
# whole home be ONE mount that persists tools nobody has thought of yet.
#
# The symlink rewrite is the load-bearing part. The claude installer writes an
# ABSOLUTE symlink (.local/bin/claude -> /home/claude/.local/share/claude/
# versions/<v>), so a bare `mv` leaves a dangling link that only resolves if
# entrypoint.sh has already linked ~/.local back. That circular dependency would
# mean a container with a failed entrypoint has no runnable Claude and no
# obvious reason why. Rewriting the links to point inside /opt/pd-home makes the
# skeleton self-contained: PATH below reaches the real binary even if no seeding
# ever runs. DO NOT drop the rewrite and rely on ~/.local being linked.
USER root
RUN mv /home/claude /opt/pd-home && \
    rm -rf /opt/pd-home/.cache /opt/pd-home/.npm && \
    find /opt/pd-home -type l | while read -r link; do \
        target="$(readlink "$link")"; \
        case "$target" in /home/claude/*) \
            ln -sfn "/opt/pd-home${target#/home/claude}" "$link" ;; \
        esac; \
    done && \
    mkdir -p /home/claude && \
    chown -R claude:users /opt/pd-home /home/claude && \
    chmod 775 /home/claude
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN sed -i 's/\r//' /usr/local/bin/entrypoint.sh && \
    chmod +x /usr/local/bin/entrypoint.sh
USER claude

# Where the image keeps its own home, and where the ephemeral caches go. These
# are the SINGLE definition of both paths: entrypoint.sh reads them rather than
# repeating the literals, so the relocation target cannot drift between the
# image and the script that depends on it. homeMount.test.js asserts the
# script's fallbacks still match these values.
ENV PD_SKEL_DIR=/opt/pd-home
ENV PD_CACHE_DIR=/var/tmp/pd-cache

# PATH points at the RELOCATED skeleton, not at ~/.local/bin, so `claude` and
# `uv` resolve even if the home mount is empty and seeding has not run.
# $HOME/bin is the prefix for CLIs a session installs for itself: it is inside
# the home mount, so it persists across recreates with no volume of its own.
# This replaces the old /opt/pd tool prefix, which existed only because the home
# was not persistent. ~/.fly/bin likewise needs no mount now.
ENV PATH="/home/claude/bin:/home/claude/.fly/bin:/opt/pd-home/.local/bin:${PATH}"
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV HOME="/home/claude"

# Set working directory
WORKDIR /workspace

# Expose web terminal port
EXPOSE 7681

# Set entrypoint to fix permissions on startup
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

CMD ["/mobile/start.sh"]
