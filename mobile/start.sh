#!/bin/bash
# Configure tmux for pocket-dev
mkdir -p /home/claude
cat > /home/claude/.tmux.conf << 'TMUXEOF'
set -g history-limit 100000
set -g status off
set -g escape-time 0
set -g mouse on
TMUXEOF
exec node /mobile/server.js
