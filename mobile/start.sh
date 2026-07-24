#!/bin/bash
# Point ~/.tmux.conf at mobile/tmux.conf so manual `tmux` invocations
# inside the container pick up the same settings the server spawns with.
# The server itself uses `tmux -f /mobile/tmux.conf` directly (see
# server.js → buildTmuxSpawnArgs), so this file is purely for humans.
mkdir -p /home/claude
cat > /home/claude/.tmux.conf << 'TMUXEOF'
source-file /mobile/tmux.conf
TMUXEOF

# Clear Claude's workspace-trust gate before any session spawns, otherwise every
# restored session comes back parked on a "do you trust this folder?" prompt and
# restore is not actually hands-free. See pd-trust-workspace for why this is not
# a security downgrade, and PD_TRUST_WORKSPACE=0 to skip it.
/mobile/pd-trust-workspace || true

exec node /mobile/server.js
