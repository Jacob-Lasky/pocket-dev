# Shared helpers for the dgvpn / dgssh wrappers. SOURCED, not executed (no
# shebang, not chmod +x), so the tunnel bring-up + SSO/failure handling lives
# in ONE place and the two wrappers cannot drift on it. DO NOT inline this back
# into the wrappers: the Dockerfile already documents drift between these
# scripts as a real hazard.

# dgvpn_require_up <tool>: bring the dgvpn tunnel up (idempotent) or exit the
# calling wrapper with a <tool>-appropriate message. Mirrors dgvpn-up's exit
# codes: 3 = SSO pending (the login URL was already printed), any other
# non-zero = startup failure. On success it returns so the wrapper continues.
dgvpn_require_up() {
  local tool="$1"
  dgvpn-up
  local rc=$?
  if [ "$rc" -eq 3 ]; then
    echo "$tool: tailnet login required (see URL above). Re-run after authenticating." >&2
    exit 3
  elif [ "$rc" -ne 0 ]; then
    echo "$tool: could not bring up the tailnet proxy (rc=$rc)." >&2
    exit "$rc"
  fi
}
