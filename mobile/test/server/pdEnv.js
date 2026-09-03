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
// Scrub whole PREFIXES rather than naming the variables each script happens to
// read today: a new knob must not be able to reintroduce this, and a test should
// only ever see the values it asked for. Overrides are applied afterwards, so a
// test that wants one of these sets it explicitly.
//
// LAVISH_ is here for the same reason and was added after the same bug: a real
// tab exports LAVISH_AXI_HOST (entrypoint.sh resolves it at boot), so inheriting
// it makes entrypoint.sh's resolution block skip entirely and every stubbed
// `hostname` case in lavish.test.js compare the live container address against
// what the test set up. Green in CI, red only inside pocket-dev, which is where
// these tests get run at least as often.
const SCRUBBED_PREFIXES = ['PD_', 'LAVISH_'];

export function spawnEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (SCRUBBED_PREFIXES.some((prefix) => key.startsWith(prefix))) delete env[key];
  }
  return Object.assign(env, overrides);
}
