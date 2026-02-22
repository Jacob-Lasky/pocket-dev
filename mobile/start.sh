#!/bin/bash
# ttyd runs internally on 7682; node is the public-facing service on 7681
ttyd -p 7682 -b /ttyd -W tmux -u new-session -A -s claude "claude --dangerously-skip-permissions" &
exec node /mobile/server.js
