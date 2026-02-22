FROM node:20-slim

# Install system dependencies
# build-essential + python3 are required to compile node-pty (native addon)
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
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update \
    && apt-get install -y docker-ce-cli \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

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
