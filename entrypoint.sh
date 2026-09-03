#!/bin/bash
# Runtime seeding for a HOME that is a SINGLE bind mount.
#
# WHY this file exists. /home/claude used to be two things at once: a tree of
# image artifacts (the claude/uv binaries, the shell rc files, the fish and uv
# configs) AND the place every tool writes its state. That is why the template
# grew one bind mount per dotfile — .claude, .claude.json, .config/gh, .dgvpn,
# .pocket-dev, .codex, .google_workspace_mcp — and why mounting the home
# wholesale was documented as forbidden: a mount over /home/claude masks
# .local/bin and leaves a container with no `claude` in it.
#
# The fix is to stop mixing the two. The image now builds its home into
# $PD_SKEL_DIR and leaves /home/claude EMPTY, so the whole home can be one mount
# and every tool's state persists with no template change, forever. This script
# links the image-owned entries back in at boot.
#
# DO NOT convert these links to copies. A copy is written once and then never
# updated, so an image update would ship a new `claude` that no container ever
# runs, and you would be debugging a version that is not the one on disk.
set -e

# Group-writable umask (002). DO NOT raise back to 022. The container runs as
# claude:users (uid 99, gid 100) and writes to /coding (= host
# /mnt/user/misc/coding, an SMB share). The mediauser SMB account is also gid
# 100 (users); with the default 022 umask, everything Claude creates is
# 0755/0644 and same-group SMB users cannot write into it. 002 makes new files
# 0664/dirs 0775 so the shared tree is two-way writable. Explicit chmods (ssh
# keys 600, etc.) are unaffected by umask.
umask 002

# The Dockerfile owns both paths and exports them, so the relocation target is
# defined in exactly ONE place. The fallbacks are for running this script
# outside the image (the test suite does); they are not a second source of
# truth, and homeMount.test.js asserts they still match the Dockerfile.
SKEL="${PD_SKEL_DIR:-/opt/pd-home}"
CACHE="${PD_CACHE_DIR:-/var/tmp/pd-cache}"

# An unwritable home is THE silent failure of this design: sessionStore disables
# itself without a word on a dir it cannot write, so a root-owned mount looks
# exactly like a working one until you notice the tabs stopped coming back.
# Nothing downstream complains, so complain here.
#
# Then SKIP seeding and boot anyway. Two reasons this is the right branch rather
# than an exit: a broken state dir must never be the reason the server will not
# come up (the same rule sessionStore follows), and the container stays usable
# because PATH points into the skeleton directly, so `claude` resolves with no
# seeding at all. DO NOT let the seeding below run unguarded here — every mkdir
# and ln would fail and `set -e` would turn a degraded boot into no boot, which
# is how this was written the first time and what the test caught.
HOME_WRITABLE=1
if ! mkdir -p "$HOME" 2>/dev/null || ! touch "$HOME/.pd-write-test" 2>/dev/null; then
  HOME_WRITABLE=0
  echo "pocket-dev: WARNING: $HOME is not writable by uid $(id -u):$(id -g)." >&2
  echo "pocket-dev: Session restore, gh auth and every credential under ~ will" >&2
  echo "pocket-dev: fail to persist, and this is the ONLY warning you get." >&2
  echo "pocket-dev: Fix: chown -R 99:100 the host path bound to /home/claude." >&2
  echo "pocket-dev: Booting anyway; claude still resolves from $SKEL." >&2
else
  rm -f "$HOME/.pd-write-test"
fi

# Link one image-owned entry into HOME.
#
# The `[ -L ] || rm -rf` is load-bearing, not defensive noise: `ln -s target dir`
# against a REAL directory silently creates the link INSIDE it (~/.local/.local)
# instead of replacing it, which would leave `claude` off the resolved path with
# no error anywhere. Only ever called with the fixed image-owned names below, so
# it can never reach a directory holding user state.
link_from_image() {
  local rel="$1" src="$SKEL/$1" dst="$HOME/$1"
  [ -e "$src" ] || return 0
  [ -L "$dst" ] || rm -rf "$dst"
  ln -sfn "$src" "$dst"
}

if [ "$HOME_WRITABLE" = "1" ]; then

  for entry in .bash_logout .bashrc .profile .zshrc .local; do
    link_from_image "$entry"
  done

  # .config is NOT image-owned as a whole: gh's auth token lives in .config/gh
  # and has to persist. Link only the two leaves the image provides.
  #
  # NOTE the `if`, not `[ -L ... ] && rm ...`: under `set -e` a compound whose
  # test is false returns nonzero and takes the whole script down with it. If
  # .config were itself a link, `mkdir -p` would follow it and the gh token
  # would land outside the mount — the exact class of quiet non-persistence
  # this change exists to end.
  if [ -L "$HOME/.config" ]; then rm -f "$HOME/.config"; fi
  mkdir -p "$HOME/.config"
  for entry in .config/fish .config/uv; do
    link_from_image "$entry"
  done

  # Caches are deliberately NOT persisted. The home mount lands on the UnRAID
  # array via shfs FUSE, and npm/uv caches are large and write-heavy: exactly
  # the wrong traffic for that filesystem, and pure bloat in appdata backups.
  # Losing a cache on recreate costs one re-download; that is what a cache is for.
  mkdir -p "$CACHE/.cache" "$CACHE/.npm"
  for entry in .cache .npm; do
    [ -L "$HOME/$entry" ] || rm -rf "$HOME/$entry"
    ln -sfn "$CACHE/$entry" "$HOME/$entry"
  done

  # State dirs that must exist before anything reads them: the server's roster
  # (PD_STATE_DIR), dgvpn's registration (DGVPN_DIR), and Claude's own config
  # dir. On a first boot the mounted home is empty, so nothing else creates them.
  #
  # $HOME/bin is the on-PATH prefix for CLIs a session installs for itself. It
  # lives in the home mount, so those tools survive a recreate without a volume
  # of their own — that is what retired the old /opt/pd prefix. DO NOT point
  # tool installs at ~/.local/bin instead: that is a symlink into the read-mostly
  # image skeleton, and writes there are lost on the next image update.
  mkdir -p "$HOME/.claude" "$HOME/.pocket-dev" "$HOME/.dgvpn" "$HOME/bin"
  chmod 775 "$HOME/.claude" "$HOME/.pocket-dev" "$HOME/.dgvpn" "$HOME/bin" 2>/dev/null || true

fi

chmod 775 /workspace 2>/dev/null || true

# Lavish Editor binds exactly ONE concrete address, and both obvious choices are
# wrong here, so resolve the container's own IPv4 and hand it that.
#
# WHY not the default. Unset, Lavish binds 127.0.0.1 (plus a Tailscale IPv4 when
# a `tailscale` CLI answers, which there is none of in this container: dgvpn is a
# userspace tsnet proxy, not a tailscale client, so detection returns null). A
# loopback-only listener is unreachable through a published port, which is what
# makes the review URL open on a phone.
#
# WHY not 0.0.0.0. Lavish REFUSES a wildcard: `LAVISH_AXI_HOST=0.0.0.0` is
# coerced back to loopback (isWildcardHost in its paths.js), and its listen
# helper closes any socket that reports an all-interfaces address. Setting the
# wildcard therefore looks like configuring reachability while silently keeping
# the loopback-only behaviour it was meant to fix.
#
# WHY the container IP works. Docker's published-port DNAT rewrites the
# destination to the container's own address, so a listener on eth0 receives
# traffic arriving at the host port. Verified live on Tower 2026-09-03: a
# container bound only to its eth0 IP with `-p` answered from the host's
# loopback, its LAN address, and its Tailscale address.
#
# This is deliberately NOT a Dockerfile ENV: the address is assigned per
# container start and changes on every recreate, so the image cannot know it.
# An explicit LAVISH_AXI_HOST from the template always wins.
#
# The export reaches PID 1 and everything descended from it, which is server.js,
# the tmux server it spawns, and therefore every session. It does NOT reach
# `docker exec`, which builds its environment from the image's Config.Env. A
# probe from outside the container has to import PID 1's environment
# (/proc/1/environ) or it will bind loopback and report a URL nothing can open.
# See the Lavish Editor section of CLAUDE.md for that recipe.
#
# Reachability is only half of it. Lavish's DNS-rebinding guard 403s any request
# whose Host header is not one it answers to, and it answers to loopback, this
# bind address, and LAVISH_AXI_LINK_HOST. Set LAVISH_AXI_LINK_HOST to the
# hostname you actually reach this container by, or the printed URL carries a
# 172.x bridge address no phone can open. See pocket-dev.xml.
if [ -z "${LAVISH_AXI_HOST:-}" ]; then
  lavish_host=""
  lavish_addrs=()
  # `read -ra` and NOT `for addr in $(hostname -i)`. An unquoted command
  # substitution in a for-list gets pathname expansion as well as word
  # splitting, so a `*` in the output would be globbed against the working
  # directory and a FILENAME could be selected as the bind address. `read -ra`
  # splits on IFS and never globs. `|| true` because read returns nonzero at EOF
  # with no delimiter, and `set -e` would take an empty result as a boot failure.
  read -ra lavish_addrs < <(hostname -i 2>/dev/null) || true
  for addr in "${lavish_addrs[@]}"; do
    case "$addr" in
      127.*|0.0.0.0|*:*) continue ;;
      *.*.*.*) lavish_host="$addr"; break ;;
    esac
  done
  if [ -n "$lavish_host" ]; then
    export LAVISH_AXI_HOST="$lavish_host"
  else
    echo "pocket-dev: no non-loopback IPv4 found; Lavish Editor will bind" >&2
    echo "pocket-dev: 127.0.0.1 only and will not be reachable from a phone." >&2
  fi
fi

# Execute the main command
exec "$@"
