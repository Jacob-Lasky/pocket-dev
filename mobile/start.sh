#!/bin/bash
# Configure tmux history limit so Select Mode can scroll back far
mkdir -p /home/claude
echo 'set -g history-limit 100000' > /home/claude/.tmux.conf
exec node /mobile/server.js
