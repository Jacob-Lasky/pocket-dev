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
# /opt/pd-home and leaves /home/claude EMPTY, so the whole home can be one
# mount and every tool's state persists with no template change, forever. This
# script links the image-owned entries back in at boot.
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

SKEL=/opt/pd-home
CACHE=/var/tmp/pd-cache

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

for entry in .bash_logout .bashrc .profile .zshrc .local; do
  link_from_image "$entry"
done

# .config is NOT image-owned as a whole: gh's auth token lives in .config/gh and
# has to persist. Link only the two leaves the image provides.
mkdir -p "$HOME/.config"
for entry in .config/fish .config/uv; do
  link_from_image "$entry"
done

# Caches are deliberately NOT persisted. The home mount lands on the UnRAID
# array via shfs FUSE, and npm/uv caches are large and write-heavy — exactly the
# wrong traffic for that filesystem, and pure bloat in appdata backups. Losing a
# cache on recreate costs one re-download; that is what a cache is for.
mkdir -p "$CACHE/.cache" "$CACHE/.npm"
for entry in .cache .npm; do
  [ -L "$HOME/$entry" ] || rm -rf "$HOME/$entry"
  ln -sfn "$CACHE/$entry" "$HOME/$entry"
done

# State dirs that must exist before anything reads them: the server's roster
# (PD_STATE_DIR), dgvpn's registration (DGVPN_DIR), and Claude's own config dir.
# On a first boot the mounted home is empty, so nothing else creates these.
#
# $HOME/bin is the on-PATH prefix for CLIs a session installs for itself. It
# lives in the home mount, so those tools survive a recreate without a volume of
# their own — that is what retired the old /opt/pd prefix. DO NOT point tool
# installs at ~/.local/bin instead: that is a symlink into the read-mostly image
# skeleton, and writes there are lost on the next image update.
mkdir -p "$HOME/.claude" "$HOME/.pocket-dev" "$HOME/.dgvpn" "$HOME/bin"
chmod 775 "$HOME/.claude" "$HOME/.pocket-dev" "$HOME/.dgvpn" "$HOME/bin" 2>/dev/null || true
chmod 775 /workspace 2>/dev/null || true

# Execute the main command
exec "$@"
