#!/bin/bash
# Configure tmux for pocket-dev
mkdir -p /home/claude
cat > /home/claude/.tmux.conf << 'TMUXEOF'
set -g history-limit 100000
set -g status off
set -g escape-time 0
set -g mouse on
TMUXEOF

# Provider selection: claude-code (default) or codex.
# Maps the generalized API_KEY to the provider's expected env var, and picks
# sensible SHELL_CMD/RESPAWN_CMD defaults. Anything the user sets explicitly
# (ANTHROPIC_API_KEY, OPENAI_API_KEY, SHELL_CMD, RESPAWN_CMD) wins.
PROVIDER="${PROVIDER:-claude-code}"

case "$PROVIDER" in
  codex)
    : "${SHELL_CMD:=cdy}"
    : "${RESPAWN_CMD:=cdy}"
    if [ -n "$API_KEY" ] && [ -z "$OPENAI_API_KEY" ]; then
      export OPENAI_API_KEY="$API_KEY"
    fi
    ;;
  claude-code)
    # Leave SHELL_CMD/RESPAWN_CMD unset → server.js's existing defaults apply,
    # preserving the original 7681 instance behavior bit-for-bit.
    if [ -n "$API_KEY" ] && [ -z "$ANTHROPIC_API_KEY" ]; then
      export ANTHROPIC_API_KEY="$API_KEY"
    fi
    ;;
  *)
    echo "pocket-dev: unknown PROVIDER='$PROVIDER' (expected claude-code|codex); falling back to claude-code defaults" >&2
    if [ -n "$API_KEY" ] && [ -z "$ANTHROPIC_API_KEY" ]; then
      export ANTHROPIC_API_KEY="$API_KEY"
    fi
    ;;
esac

export SHELL_CMD RESPAWN_CMD
exec node /mobile/server.js
