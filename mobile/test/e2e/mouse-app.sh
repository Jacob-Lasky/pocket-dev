#!/usr/bin/env bash
# Fixture: a mouse-tracking TUI stand-in. Enables SGR mouse tracking exactly as
# Claude Code does at its idle prompt (DECSET 1000/1002/1003 + 1006 SGR — the
# measured final state of a real capture), prints a marker, then idles. Used to
# exercise the wheel-forwarding branch of scroll.js: a session whose inner app
# "wants" mouse events, which the default `cat` fixture (no mouse tracking) can
# never produce. cat cannot exercise this, same rationale as the alt-screen gap.
printf '\033[?1000h\033[?1002h\033[?1003h\033[?1006h'
printf 'MOUSE-APP-READY\r\n'
sleep 600
