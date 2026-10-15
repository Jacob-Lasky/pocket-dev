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
# A REAL file or directory already at the destination is MOVED ASIDE to a dated
# `<name>.pre-image-<UTC>` sibling, never deleted, and named on stderr. Two
# reasons, both load-bearing. `ln -s target dir` against a real directory
# silently creates the link INSIDE it (~/.local/bin/bin) instead of replacing
# it, which would leave `claude` off the resolved path with no error anywhere.
# And ~/.local holds persisted tool data, so a real ~/.local/share/<x> that a
# NEWER image starts shipping under the same name is somebody's data: this
# used to be `rm -rf`, which would have deleted it. `-T` on mv and ln makes a
# directory appearing at the destination a failure rather than a nest.
#
# A failure WARNS and the boot continues, never `set -e` out of the script: a
# link that cannot be made (a root-owned ~/.local/share left by a sibling
# container, say) would otherwise crash-loop the container, while without the
# link the image binaries still resolve, because PATH names the skeleton.
link_from_image() {
  local rel="$1" src="$SKEL/$1" dst="$HOME/$1" aside
  [ -e "$src" ] || [ -L "$src" ] || return 0
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    aside="$dst.pre-image-$(date -u +%Y%m%dT%H%M%SZ)"
    if mv -T "$dst" "$aside" 2>/dev/null; then
      echo "pocket-dev: moved a real ~/$rel aside to ~/${aside#"$HOME"/} so the image's copy can be linked" >&2
    else
      aside=""
    fi
  fi
  if [ "$aside" != "" ] || [ ! -e "$dst" ] || [ -L "$dst" ]; then
    ln -sfnT "$src" "$dst" 2>/dev/null && return 0
  fi
  echo "pocket-dev: could not link ~/$rel to the image; continuing without it" >&2
}

if [ "$HOME_WRITABLE" = "1" ]; then

  for entry in .bash_logout .bashrc .profile .zshrc; do
    link_from_image "$entry"
  done

  # ~/.local is a REAL directory in the persistent home, with only what the
  # image ships linked into it: .local/bin whole, and each child of the
  # skeleton's .local/share and .local/state (today, `claude` in both).
  # Everything else under ~/.local persists, the same split as .config below.
  #
  # It used to be one link to the whole skeleton, which put every tool's
  # XDG data (~/.local/share/<tool>) in the container's writable layer, lost
  # on every recreate: OpenCode's history, uv's tools and pythons, the
  # deepgram-agents-skills link that 69 ~/.claude/skills entries point
  # through. A per-tool relink only saves the tools someone already knew to
  # list; a new tool would lose its first data at the next recreate, the
  # exact class of quiet loss the single home mount exists to end.
  #
  # DO NOT put .local back in the link list above: that would move the whole
  # persisted ~/.local aside on the next boot and replace it with the image's,
  # which is every tool's data gone from where the tools look for it.
  # homeMount.test.js guards that.
  #
  # ~/.local, ~/.local/share and ~/.local/state must each be REAL: a symlink
  # left at any of them (the old layout's ~/.local link, or a hand-made one)
  # is removed first. That is not tidiness: with ~/.local/share linked into
  # the skeleton, linking share/claude would resolve onto the skeleton's own
  # claude directory and move it aside, taking the binary with it.
  #
  # Image entries are enumerated from the skeleton rather than named, so an
  # image that adds a .local/share/<x> gets it linked without an edit here.
  # `..?*` alongside `.[!.]*` catches names starting with two dots, which the
  # usual dotfile glob skips. The `if` forms are the .config pattern: under
  # `set -e` a false `[ ]` in an `&&` list would end the boot, and a failing
  # command in a then-branch would too, hence `|| true` on every removal.
  for d in .local .local/share .local/state; do
    if [ -L "$HOME/$d" ]; then rm -f "$HOME/$d" 2>/dev/null || true; fi
  done
  if ! mkdir -p "$HOME/.local/share" "$HOME/.local/state" 2>/dev/null; then
    echo "pocket-dev: could not create ~/.local/share and ~/.local/state; tool data this boot may not persist" >&2
  fi
  link_from_image .local/bin
  for xdg in share state; do
    if [ -d "$SKEL/.local/$xdg" ]; then
      for src in "$SKEL/.local/$xdg"/* "$SKEL/.local/$xdg"/.[!.]* "$SKEL/.local/$xdg"/..?*; do
        if [ -e "$src" ] || [ -L "$src" ]; then
          link_from_image ".local/$xdg/${src##*/}"
        fi
      done
    fi
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
  mkdir -p "$HOME/.claude" "$HOME/.pocket-dev" "$HOME/.dgvpn" "$HOME/bin" "$HOME/.codex"
  chmod 775 "$HOME/.claude" "$HOME/.pocket-dev" "$HOME/.dgvpn" "$HOME/bin" "$HOME/.codex" 2>/dev/null || true

  # This is the identity of the persistent standalone install, not merely an
  # argument to its first bootstrap. Export it so Codex's in-process updater
  # uses the same launcher directory instead of defaulting to the image-owned
  # ~/.local/bin and misclassifying the existing ~/bin launcher as a conflict.
  export CODEX_INSTALL_DIR="$HOME/bin"

  # Codex removes its arg0 helper directories with their .lock files still
  # open. shfs FUSE keeps an unlinked open file as .fuse_hidden*, so rmdir
  # fails with ENOTEMPTY and each startup leaves more stale directories.
  # These are process-lifetime helpers, not persisted Codex state. Relocate
  # only tmp, before the daemon or any session starts. DO NOT run this
  # migration against active Codex processes; their PATH uses these helpers.
  mkdir -p "$CACHE/.codex-tmp"
  chmod 700 "$CACHE/.codex-tmp"
  [ -L "$HOME/.codex/tmp" ] || rm -rf "$HOME/.codex/tmp"
  ln -sfn "$CACHE/.codex-tmp" "$HOME/.codex/tmp"

  # CODEX REMOTE CONTROL, so a Codex tab is drivable from the phone the way a
  # Claude tab is. The two mechanisms are NOT alike, and that asymmetry is the
  # whole reason this lives here instead of on a command line:
  #
  #   claude  a PER-SESSION flag. server.js puts --rc on each tab's command
  #           line, so every tab is independently visible.
  #   codex   a PER-CONTAINER DAEMON. `codex remote-control start` runs one
  #           app-server that the TUI attaches to ("the shared local
  #           app-server daemon", per `codex agents --help`). There is no
  #           per-session flag to add, so it belongs here, once, at boot.
  #
  # THE STANDALONE INSTALL CANNOT BE BAKED INTO THE IMAGE, which is the
  # non-obvious half. `codex remote-control start` refuses an npm -g install:
  #   "managed standalone Codex install not found at
  #    $HOME/.codex/packages/standalone/current/codex ... the daemon starts and
  #    updates app-server from that fixed path"
  # That path is inside /home/claude, which is a BIND MOUNT at runtime, so a
  # build-time install there is MASKED the instant the container starts.
  # Runtime is the only place it can go. Once there it persists across
  # recreates and self-updates from that fixed path, which is also why this
  # subsumes the npm copy for version freshness.
  #
  # CODEX_INSTALL_DIR is $HOME/bin and NOT the installer's default
  # $HOME/.local/bin: per the comment above, .local is a symlink into the image
  # skeleton, so a launcher there lives in the container layer and dies on the
  # next recreate, while $HOME/bin is in the mount. Both resolve to the same
  # payload; only one survives. Measured 2026-09-08: after a recreate the
  # $HOME/bin launcher was still there and still pointed at a live payload.
  #
  # EVERY STEP HERE IS NON-FATAL. The image's /usr/local/bin/codex keeps
  # working with no daemon, so a network blip at boot or an unauthenticated
  # account must degrade to "no remote control" and never to "no terminal".
  # That is the same rule sessionStore states for the state dir.
  # PD_CODEX_RC=0 skips this whole block. It exists because the block is the
  # only thing in this script that reaches the NETWORK, and several suites
  # execute entrypoint.sh for real against a temp HOME. Without the skip they
  # download and install Codex on every run. test/server/pdEnv.js defaults it
  # to 0 for exactly that reason.
  #
  # EVERY MESSAGE BELOW GOES TO STDERR, like the other ten in this script.
  # entrypoint.sh execs its arguments, so STDOUT belongs to the process it
  # hands off to and lavish.test.js reads it as its assertion surface: an echo
  # on stdout here made four unrelated bind-address tests compare a log line
  # against an IP address.
  CODEX_STANDALONE="$HOME/.codex/packages/standalone/current/bin/codex"
  if [ "${PD_CODEX_RC:-1}" != "0" ] && [ ! -x "$CODEX_STANDALONE" ]; then
    # The installer inherits the exported persistent destination. pipefail
    # keeps a failed download from looking like a successful empty shell script.
    if (set -o pipefail; curl -fsSL https://chatgpt.com/codex/install.sh 2>/dev/null | sh >/dev/null 2>&1); then
      echo "pocket-dev: installed the standalone codex (remote control needs it)" >&2
    else
      echo "pocket-dev: standalone codex install failed; remote control unavailable," >&2
      echo "pocket-dev: /usr/local/bin/codex still works for everything else." >&2
    fi
  fi
  if [ "${PD_CODEX_RC:-1}" != "0" ] && [ -x "$CODEX_STANDALONE" ]; then
    # Enrollment reaches chatgpt.com and can legitimately refuse: it wants a
    # logged-in account with MFA satisfied (measured 403 "Multi-factor
    # authentication required" before MFA was enabled). A refusal must be a log
    # line, not a boot failure.
    if "$HOME/bin/codex" remote-control start >/dev/null 2>&1; then
      echo "pocket-dev: codex remote-control daemon started" >&2
    else
      echo "pocket-dev: codex remote-control did not start (needs a codex login" >&2
      echo "pocket-dev: with MFA satisfied); Codex tabs still run, just not from a phone." >&2
    fi
  fi

  # One-time move of data staged in ~/.local-persist into the real ~/.local.
  #
  # ~/.local-persist is where data was parked before ~/.local became a real
  # directory: the deploy that introduced this layout pre-copied the old
  # container layer's ~/.local/share and ~/.local/state there (a recreate
  # discards that layer, so nothing at boot could have rescued it), and the
  # brief OpenCode-only relink before this design used the same name. Each
  # child moves to the same path under ~/.local unless something already
  # occupies it (an image-owned link, or data written since), in which case
  # the staged copy is LEFT in place and named on stderr, never overwritten
  # and never deleted. Same filesystem, so each move is a rename.
  #
  # EVERY step is non-fatal: under `set -e` a failed move would otherwise
  # turn "data stays parked" into "no boot".
  for xdg in share state; do
    staged="$HOME/.local-persist/$xdg"
    if [ -d "$staged" ] && [ ! -L "$staged" ]; then
      for src in "$staged"/* "$staged"/.[!.]* "$staged"/..?*; do
        if [ -e "$src" ] || [ -L "$src" ]; then
          dst="$HOME/.local/$xdg/${src##*/}"
          if [ -e "$dst" ] || [ -L "$dst" ]; then
            echo "pocket-dev: kept $src (~/.local/$xdg/${src##*/} already exists)" >&2
          elif ! mv -T "$src" "$dst" 2>/dev/null; then
            echo "pocket-dev: could not move $src into ~/.local/$xdg; left in place" >&2
          fi
        fi
      done
      rmdir "$staged" 2>/dev/null || true
    fi
  done
  rmdir "$HOME/.local-persist" 2>/dev/null || true

  # NO config.toml SEED FOR CODEX, ON PURPOSE. An earlier version of this block
  # wrote `model = "gpt-5.6-sol"` and `model_reasoning_effort = "high"` here to
  # match cachyos-desktop. Both reasons it was removed matter:
  #
  # 1. IT BUYS NOTHING HERE. The dominant codex consumer in this container is
  #    /second-opinion, which pins `-m` and passes `-c model_reasoning_effort`
  #    on every single invocation. Interactive `codex` is rare, because the
  #    browser terminal runs claude rather than a shell. The desktop is the
  #    opposite case -- bare `codex` typed daily -- which is why the pin is
  #    correct THERE and pointless here.
  #
  # 2. ~/.codex/config.toml CARRIES A DO-NOT THAT FORBIDS IT. That file is the
  #    BASE that ~/.codex/deepgram.config.toml layers on top of, and its own
  #    header says: "DO NOT set model_provider, auth_mode, or a model here."
  #    The Deepgram-billed path is entered only via the `codex-dg` wrapper, and
  #    keeping the base minimal is what makes that split reasonable about.
  #
  # The seed was guarded `if [ ! -e ]`, so on Jake's existing home it correctly
  # did nothing -- the defect was latent and would only have fired on a fresh
  # home. DO NOT re-add it; set codex options on the command line, or in the
  # config by hand where the DO-NOT has been reconsidered.

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
# WHY the container IP works, AND THE ASSUMPTION IT RESTS ON. On a bridge
# network, Docker's published-port DNAT rewrites the destination to the
# container's own address, so a listener on eth0 receives traffic arriving at the
# host port. Verified live on Tower 2026-09-03: a container bound only to its
# eth0 IP with `-p` answered from the host's loopback, its LAN address, and its
# Tailscale address. That is the network pocket-dev.xml declares and the only one
# this reasoning covers. Under `--network host` there is no DNAT and `-p` is
# ignored, so binding one host interface is an arbitrary choice rather than the
# right one; under macvlan or a routed network the container address is reachable
# directly and no mapping is involved. Neither is a supported deployment here.
#
# This is deliberately NOT a Dockerfile ENV: the address is assigned per
# container start and is not guaranteed to be stable across recreates (Docker
# often reuses one, but nothing promises it), so the image cannot know it.
#
# The export reaches the server this script execs and everything descended from
# it. Under --init that server is NOT PID 1: tini is, and it never sees this
# export, so read the server's own environment, never /proc/1. That is NOT by
# itself enough to reach a session: tmux's server outlives its clients and
# `new-session` inherits the SERVER's environment, so a tmux server that was
# already running without this variable would hand sessions an environment
# without it. server.js closes that by forwarding every LAVISH_ variable through
# `new-session -e`; see buildTmuxSpawnArgs. It also does not reach `docker exec`,
# which builds its environment from the image's Config.Env, so a probe from
# outside has to import the server's environment (/proc/<server pid>/environ) or
# it will bind loopback and report a URL nothing can open. See CLAUDE.md.
#
# Reachability is only half of it. Lavish's DNS-rebinding guard 403s any request
# whose Host header is not one it answers to, and it answers to loopback, this
# bind address, and LAVISH_AXI_LINK_HOST. Set LAVISH_AXI_LINK_HOST to the
# hostname you actually reach this container by, or the printed URL carries the
# bind address, which on the default bridge is a 172.x address no phone can open.
# See pocket-dev.xml.
#
# An explicit LAVISH_AXI_HOST wins and is NOT filtered: an operator pinning one
# interface must be honoured, including the values this block would reject. The
# filtering below applies only to the guess.
if [ -z "${LAVISH_AXI_HOST:-}" ]; then
  # Absolute path, NOT a bare `hostname`. $PATH starts with $HOME/bin, which is
  # inside the persistent home mount and writable by the uid this runs as, so a
  # bare call lets any leftover `~/bin/hostname` decide the bind address, return
  # nothing and force loopback, or hang the boot. PD_HOSTNAME_BIN is the test
  # seam and nothing sets it in production.
  lavish_hostname="${PD_HOSTNAME_BIN:-/usr/bin/hostname}"
  lavish_addrs=()
  # `read -ra` and NOT `for addr in $(...)`. An unquoted command substitution in
  # a for-list gets pathname expansion as well as word splitting, so a `*` in the
  # output would be globbed against the working directory and a FILENAME could be
  # selected as the bind address. `read -ra` splits on IFS and never globs.
  # `|| true` because read returns nonzero at EOF with no delimiter, and `set -e`
  # would take an empty result as a boot failure.
  read -ra lavish_addrs < <("$lavish_hostname" -i 2>/dev/null) || true

  # Shape check, deliberately four dotted numbers rather than full validation:
  # `999.999.999.999` still passes and Lavish then refuses to resolve it and says
  # so, which is loud. What this DOES buy is that a hostname, an error string, a
  # literal `*` or an IPv6 form can never become a bind address.
  lavish_candidates=()
  for addr in "${lavish_addrs[@]}"; do
    case "$addr" in 127.*|0.0.0.0) continue ;; esac
    [[ $addr =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || continue
    lavish_candidates+=("$addr")
  done

  if [ "${#lavish_candidates[@]}" -eq 0 ]; then
    echo "pocket-dev: no non-loopback IPv4 found; Lavish Editor will bind" >&2
    echo "pocket-dev: 127.0.0.1 only and will not be reachable from a phone." >&2
  else
    export LAVISH_AXI_HOST="${lavish_candidates[0]}"
    # More than one means the container is on several networks and nothing here
    # can tell which one the published port forwards to, so the first is a guess.
    # Say which was picked rather than letting a wrong pick present as a port
    # that refuses connections; LAVISH_AXI_HOST in the template overrides it.
    if [ "${#lavish_candidates[@]}" -gt 1 ]; then
      echo "pocket-dev: several container IPv4 addresses (${lavish_candidates[*]});" >&2
      echo "pocket-dev: Lavish Editor bound $LAVISH_AXI_HOST. If its port refuses" >&2
      echo "pocket-dev: connections, set LAVISH_AXI_HOST to the right one." >&2
    fi
  fi
fi

# The Happier daemon supervisor (see mobile/pd-happier-supervise for why it
# exists). Started HERE, after the Lavish export and just before exec, so it and
# every session the daemon launches inherit the finished environment. Started
# in the background so it never delays the server, and it outlives the exec as
# a child of the same PID.
#
# It runs whenever the CLI is installed, signed in or not: a never-signed-in
# home costs one bash loop doing a glob check a minute, and in exchange a first
# `happier auth login` needs no daemon start by hand. That matters because a
# start typed through `docker exec` misses this script's exports. PD_HAPPIER=0
# turns it off, the same shape as PD_RESUME and PD_REMOTE_CONTROL.
# PD_HAPPIER_SUPERVISOR is the test seam that swaps in a stub; nothing sets it in
# production.
#
# stdout goes to /dev/null and NOT to whoever started us: the suites that run
# this script read stdout, and a background child holding that pipe open would
# keep their process from ever closing. stderr stays the container log.
if [ "$HOME_WRITABLE" = "1" ] && [ "${PD_HAPPIER:-1}" != "0" ] \
  && happier_bin=$(command -v happier 2>/dev/null); then
  # The image's copy is /usr/local/bin/happier. One resolving anywhere else is a
  # home copy shadowing the pinned version, because ~/bin precedes /usr/local/bin
  # on PATH. Say so, since the build log's version is then not what runs.
  case "$happier_bin" in
    /usr/local/bin/happier) ;;
    *)
      echo "pocket-dev: happier resolves to $happier_bin, not the image's" >&2
      echo "pocket-dev: /usr/local/bin/happier; remove the home copy to run the pinned one." >&2
      ;;
  esac
  "${PD_HAPPIER_SUPERVISOR:-/mobile/pd-happier-supervise}" </dev/null >/dev/null &
fi

# Execute the main command
exec "$@"
