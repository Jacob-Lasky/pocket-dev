#!/bin/bash
# Point ~/.tmux.conf at mobile/tmux.conf so manual `tmux` invocations
# inside the container pick up the same settings the server spawns with.
# The server itself uses `tmux -f /mobile/tmux.conf` directly (see
# server.js → buildTmuxSpawnArgs), so this file is purely for humans.
mkdir -p /home/claude
cat > /home/claude/.tmux.conf << 'TMUXEOF'
source-file /mobile/tmux.conf
TMUXEOF
exec node /mobile/server.js
