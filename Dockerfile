FROM node:20-slim

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

# Install GitHub CLI via official install script (works on amd64 + arm64)
RUN curl -fsSL https://github.com/cli/cli/releases/latest/download/gh_$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | jq -r '.tag_name' | sed 's/^v//')_linux_$(dpkg --print-architecture).tar.gz \
    | tar xz -C /usr/local --strip-components=1

# Create entrypoint script directly in the image (as root before switching users)
RUN echo '#!/bin/bash\n\
set -e\n\
# Ensure proper permissions on mounted volumes\n\
chmod 775 /home/claude/.claude 2>/dev/null || true\n\
chmod 775 /workspace 2>/dev/null || true\n\
# Execute the main command\n\
exec "$@"' > /usr/local/bin/entrypoint.sh && \
    chmod +x /usr/local/bin/entrypoint.sh

# Add claude shortcut aliases
RUN echo '#!/bin/bash' > /usr/local/bin/cdspo \
    && echo 'exec claude --dangerously-skip-permissions --model "claude-opus-4-7[1m]" "$@"' >> /usr/local/bin/cdspo \
    && echo '#!/bin/bash' > /usr/local/bin/cdsps \
    && echo 'exec claude --dangerously-skip-permissions --model claude-sonnet-4-6 "$@"' >> /usr/local/bin/cdsps \
    && chmod +x /usr/local/bin/cdspo /usr/local/bin/cdsps

# Create docker group and user with proper permissions
RUN groupadd -g 281 docker || true && \
    useradd -m -u 99 -g 100 -G 281 claude && \
    mkdir -p /workspace /home/claude/.claude && \
    chown -R claude:users /workspace /home/claude/.claude && \
    chmod -R 775 /workspace /home/claude/.claude

# Install pocket-dev server (as root, before switching users)
# npm install compiles node-pty natively here
COPY mobile/ /mobile/
RUN cd /mobile && sed -i 's/\r//' start.sh && npm install --production && \
    chmod +x /mobile/start.sh && \
    chown -R claude:users /mobile

# Switch to claude user before installing
USER claude

# Install claude-code and uv as the claude user
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && curl -LsSf https://astral.sh/uv/install.sh | sh

# Ensure claude is in user's PATH and HOME is set correctly
ENV PATH="/home/claude/.local/bin:${PATH}"
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
