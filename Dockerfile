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
RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    tmux \
    ca-certificates \
    gnupg \
    lsb-release \
    jq \
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

# Create entrypoint script directly in the image (as root before switching users)
RUN echo '#!/bin/bash\n\
set -e\n\
# Group-writable umask (002). DO NOT raise back to 022. The container runs as\n\
# claude:users (uid 99, gid 100) and writes to /coding (= host /mnt/user/misc/coding,\n\
# an SMB share). The mediauser SMB account is also gid 100 (users); with the default\n\
# 022 umask, everything Claude creates is 0755/0644 and same-group SMB users cannot\n\
# write into it. 002 makes new files 0664/dirs 0775 so the shared tree is two-way\n\
# writable. Explicit chmods (ssh keys 600, etc.) are unaffected by umask.\n\
umask 002\n\
# Ensure proper permissions on mounted volumes\n\
chmod 775 /home/claude/.claude 2>/dev/null || true\n\
chmod 775 /workspace 2>/dev/null || true\n\
# Execute the main command\n\
exec "$@"' > /usr/local/bin/entrypoint.sh && \
    chmod +x /usr/local/bin/entrypoint.sh

# Add claude shortcut aliases. `opus`/`sonnet` are MOVING aliases: each resolves
# to the newest model in its family at launch, by design (Jake wants these to
# track latest automatically). DO NOT pin them back to claude-opus-X-Y / a dated
# sonnet id — that freezes the shortcut to an aging model.
RUN echo '#!/bin/bash' > /usr/local/bin/cdspo \
    && echo 'exec claude --dangerously-skip-permissions --model "opus[1m]" "$@"' >> /usr/local/bin/cdspo \
    && echo '#!/bin/bash' > /usr/local/bin/cdsps \
    && echo 'exec claude --dangerously-skip-permissions --model sonnet "$@"' >> /usr/local/bin/cdsps \
    && chmod +x /usr/local/bin/cdspo /usr/local/bin/cdsps

# Create docker group and user with proper permissions
RUN groupadd -g 281 docker || true && \
    useradd -m -u 99 -g 100 -G 281 claude && \
    mkdir -p /workspace /home/claude/.claude /home/claude/.pocket-dev && \
    chown -R claude:users /workspace /home/claude/.claude /home/claude/.pocket-dev && \
    chmod -R 775 /workspace /home/claude/.claude /home/claude/.pocket-dev

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
# pnpm is installed with `npm install -g` rather than corepack. corepack would
# read `packageManager` for us, but it was removed from Node in 26, so pinning
# the version explicitly here is the approach that survives the next base bump.
# Keep this version in step with `packageManager` in mobile/package.json.
#
# --prod drops devDependencies (vitest, playwright) from the runtime image, and
# --frozen-lockfile makes the build fail loudly if pnpm-lock.yaml is out of step
# with package.json instead of silently resolving something else.
#
# pnpm's default symlinked node_modules is kept: server.js serves xterm's browser
# assets with express.static(__dirname + '/node_modules/@xterm/xterm'), and that
# resolves through the symlink into the .pnpm store normally. Verified by running
# the e2e suite against a pnpm install, which loads those assets over /xterm.
RUN npm install -g pnpm@11.3.0
COPY mobile/ /mobile/
RUN cd /mobile && sed -i 's/\r//' start.sh pd-claude-session pd-trust-workspace && \
    pnpm install --prod --frozen-lockfile && \
    chmod +x /mobile/start.sh /mobile/pd-claude-session /mobile/pd-trust-workspace && \
    chown -R claude:users /mobile

# Where the session roster and each tab's Claude conversation id live, so a
# restart brings the user's sessions back instead of one blank one. Bind-mount
# this (the `Session State` volume in pocket-dev.xml) to survive a container
# RECREATE too — without a mount it lives in the writable layer, which an image
# update throws away.
ENV PD_STATE_DIR=/home/claude/.pocket-dev

# dgvpn: the static tsnet proxy binary plus the two wrapper commands. Installed
# as root into /usr/local/bin (on PATH for the claude user). The proxy runs as
# the unprivileged claude user at runtime: userspace tsnet needs no TUN device
# and no NET_ADMIN, so this works in the unprivileged container. State lives
# under /home/claude/.dgvpn, which survives a restart on its own but only
# survives a RECREATE when the `dgvpn State` volume is actually mounted. Kept
# last (just before USER claude) so iterating on vpn/ does not bust the apt or
# npm layers above.
COPY --from=dgvpn-builder /dgvpn-proxy /usr/local/bin/dgvpn-proxy
COPY vpn/dgvpn vpn/dgvpn-up /usr/local/bin/
RUN sed -i 's/\r//' /usr/local/bin/dgvpn /usr/local/bin/dgvpn-up && \
    chmod +x /usr/local/bin/dgvpn /usr/local/bin/dgvpn-up /usr/local/bin/dgvpn-proxy && \
    mkdir -p /home/claude/.dgvpn && chown claude:users /home/claude/.dgvpn
# Single source of truth for the proxy port at runtime. The Go binary and both
# wrapper scripts read DGVPN_PROXY_PORT; their in-code defaults are fallbacks
# only. Set it once here so the three never drift. Override via the template to
# move the port. DGVPN_DIR matches the persisted `dgvpn State` volume in pocket-dev.xml.
ENV DGVPN_PROXY_PORT=1055
ENV DGVPN_DIR=/home/claude/.dgvpn

# A writable, persistable prefix for tools a session installs for ITSELF
# (flyctl, extra CLIs). It exists because the alternative people reach for is
# bind-mounting /home/claude/.local — DO NOT do that: the image bakes `claude`,
# `uv` and `uvx` into /home/claude/.local/bin at build time, and mounting a host
# dir over it masks them and leaves a container with no Claude in it. /opt/pd is
# empty in the image, so a mount there can never hide anything.
RUN mkdir -p /opt/pd/bin && chown -R claude:users /opt/pd && chmod -R 775 /opt/pd

# Switch to claude user before installing
USER claude

# Install claude-code and uv as the claude user
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && curl -LsSf https://astral.sh/uv/install.sh | sh

# Ensure claude is in user's PATH and HOME is set correctly
ENV PATH="/opt/pd/bin:/home/claude/.fly/bin:/home/claude/.local/bin:${PATH}"
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
