FROM node:20-slim

# Install git, curl, wget, tmux, and Docker CLI
RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    tmux \
    ca-certificates \
    gnupg \
    lsb-release \
    jq \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update \
    && apt-get install -y docker-ce-cli \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install ttyd (web-based terminal)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then TTYD_ARCH="x86_64"; \
    elif [ "$ARCH" = "arm64" ]; then TTYD_ARCH="aarch64"; \
    else TTYD_ARCH="$ARCH"; fi && \
    wget -O /usr/local/bin/ttyd "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${TTYD_ARCH}" && \
    chmod +x /usr/local/bin/ttyd

# Create entrypoint script directly in the image (as root before switching users)
RUN echo '#!/bin/bash\n\
set -e\n\
# Ensure proper permissions on mounted volumes\n\
chmod 775 /home/claude/.claude 2>/dev/null || true\n\
chmod 775 /workspace 2>/dev/null || true\n\
# Execute the main command\n\
exec "$@"' > /usr/local/bin/entrypoint.sh && \
    chmod +x /usr/local/bin/entrypoint.sh

# Create docker group and user with proper permissions
RUN groupadd -g 281 docker || true && \
    useradd -m -u 99 -g 100 -G 281 claude && \
    mkdir -p /workspace /home/claude/.claude && \
    chown -R claude:users /workspace /home/claude/.claude && \
    chmod -R 775 /workspace /home/claude/.claude

# Install mobile bridge (as root, before switching users)
COPY mobile/ /mobile/
RUN cd /mobile && sed -i 's/\r//' start.sh && npm install --production && \
    chmod +x /mobile/start.sh && \
    chown -R claude:users /mobile

# Switch to claude user before installing
USER claude

# Install claude-code using native installer as the claude user
RUN curl -fsSL https://claude.ai/install.sh | bash

# Ensure claude is in user's PATH and HOME is set correctly
ENV PATH="/home/claude/.local/bin:${PATH}"
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV HOME="/home/claude"

# Set working directory
WORKDIR /workspace

# Expose ttyd and mobile bridge ports
EXPOSE 7681 7682

# Set entrypoint to fix permissions on startup
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Start mobile bridge (background) + ttyd (foreground)
CMD ["/mobile/start.sh"]
