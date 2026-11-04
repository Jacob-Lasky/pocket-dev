#!/bin/sh
# Throwaway: prints the pocket-dev container's pid usage, so the docs bot has a
# code change to document in the W150 live test of the docs-bot guard.
cat /sys/fs/cgroup/pids.current /sys/fs/cgroup/pids.max
