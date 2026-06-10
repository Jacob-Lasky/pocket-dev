#!/usr/bin/env bash
# Live-test helper: emit the captured real Claude TUI "trust this folder?" frame
# (base64-decoded raw bytes) then idle. Used as SHELL_CMD so the View-mode e2e
# renders the exact alt-screen / CHA-positioned content that the old
# serialize()+ansi_up path mangled (words run together, spaces dropped). cat
# cannot produce this; see CLAUDE.md "Test gap: cat doesn't exercise alt-screen".
here="$(cd "$(dirname "$0")" && pwd)"
base64 -d "$here/fixtures/claude-trust-frame.b64"
sleep 600
