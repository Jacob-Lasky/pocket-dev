// Environment for a test that spawns one of the repo's real shell scripts
// (pd-claude-session, pd-trust-workspace, entrypoint.sh) against a temp HOME.
//
// The scripts are configured entirely through PD_* variables, and these tests
// get run INSIDE pocket-dev at least as often as they run in CI. A real tab
// exports PD_SID_FILE, PD_STATE_DIR, PD_SKEL_DIR, PD_CACHE_DIR and
// PD_CLAUDE_PROJECTS_DIR for the session it belongs to, so a plain
// `{...process.env}` hands the script under test the developer's live
// configuration and quietly overrides whatever the test set up.
//
// That is not hypothetical. Inheriting PD_CLAUDE_PROJECTS_DIR pointed
// pd-claude-session's transcript lookup at the real transcripts instead of the
// temp HOME the test had just written one into, so no resume branch was ever
// taken and three prompt tests failed locally while CI stayed green, because
// GitHub Actions has none of these set.
//
// Scrub the whole PD_ prefix rather than naming the variables each script
// happens to read today: a new knob must not be able to reintroduce this, and a
// test should only ever see the PD_* values it asked for.
export function spawnEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PD_')) delete env[key];
  return Object.assign(env, overrides);
}
