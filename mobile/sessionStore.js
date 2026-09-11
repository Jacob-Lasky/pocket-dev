const fs   = require('fs');
const path = require('path');
const { SAFE_ID, UUID_RE, SAFE_PROVIDER } = require('./safeId');
const { PROVIDERS, DEFAULT_PROVIDER } = require('./providers');

// Durable record of which sessions the server is hosting, so a container
// restart brings the user's tabs back instead of dropping them to one blank
// session.
//
//
// WHY a file, when tmux already tracks sessions: tmux is not a source of truth
// here. Its server is a child of this container's PID namespace and dies with
// it, so after a restart there is nothing left to enumerate. The roster is
// rewritten on every create/destroy and read once at boot; server.js then
// re-creates each id, and because it spawns with `new-session -A` that same
// call REATTACHES when the tmux session did survive (node restarted, container
// did not) and creates it fresh when it did not. One code path, both cases.
//
// Read/unread is deliberately NOT in here. It lives on the server (so every
// device agrees) but only in memory, as a counter of output against a counter
// of views: both restart with the process, and after a restart the pty history
// is gone anyway, so nothing is unread until a session says something new.
//
// Alongside the roster we keep one tiny `<id>.uuid` file per session. Each
// provider's launcher or supported lifecycle hook writes it, while the server
// reads and deletes it. That handoff lets a restored tab resume the exact
// conversation it owned without selecting a shared most-recent conversation.
//
// EVERY failure in this module is non-fatal by design. An unwritable, missing,
// or garbage state dir must leave pocket-dev booting exactly as it did before
// this feature existed — a terminal that loses its tabs on restart is degraded,
// a terminal that will not start is broken.

// Bumped to 2 when the roster started carrying each session's provider. It is
// INFORMATIONAL ONLY on write and nothing branches on it, which is deliberate:
// see load() for why a version gate would be the one failure this module is
// built to prevent.
const ROSTER_VERSION = 2;

// Marker file proving the previous process shut down on purpose. See
// markCleanShutdown/consumeCleanShutdown below for why it decides whether a
// restored session is allowed to carry on by itself.
const CLEAN_MARKER = 'clean-shutdown';

// A store that persists nothing: the default for createSessionsApi so unit
// tests and any other embedder get zero filesystem side effects unless they
// ask for them. startServer() is the one caller that wires up a real store.
const nullSessionStore = {
  dir:      null,
  file:     null,
  sidPath:  () => null,
  readSid:  () => null,
  clearSid: () => {},
  load:     () => [],
  save:     () => {},
  markCleanShutdown:    () => {},
  consumeCleanShutdown: () => false,
};

function createSessionStore({ dir, logger = console } = {}) {
  const file    = path.join(dir, 'sessions.json');
  const tmpFile = `${file}.tmp`;
  const sidDir  = path.join(dir, 'sids');
  let disabled  = false;

  // One warning per process, then silence: a broken state dir should not
  // scroll a message into the log on every keystroke-driven persist.
  function disable(err, action) {
    if (disabled) return;
    disabled = true;
    logger.warn(
      `session store disabled (${action} failed under ${dir}: ${err.message}). ` +
      'Sessions will not survive a restart.',
    );
  }

  // A roster written by a NEWER pocket-dev than this one. Logged once per
  // process, same shape and same reason as disable() above: a downgraded
  // container should say so, and should say it once rather than on every read.
  // It is a notice, not a refusal; load() explains why.
  let notedNewerRoster = false;
  function noteNewerRoster(version) {
    if (notedNewerRoster) return;
    notedNewerRoster = true;
    logger.warn(
      `session store: ${file} was written by a newer pocket-dev ` +
      `(roster version ${version}, this build understands ${ROSTER_VERSION}). ` +
      'Loading it anyway; fields this build does not know are ignored.',
    );
  }

  function sidPath(id) {
    if (!SAFE_ID.test(id)) return null;
    return path.join(sidDir, `${id}.uuid`);
  }

  // The provider conversation id recorded for this tab, or null.
  // Untrusted despite being ours: validate before handing it to anything.
  function readSid(id) {
    const p = sidPath(id);
    if (!p) return null;
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
    const uuid = raw.trim();
    return UUID_RE.test(uuid) ? uuid : null;
  }

  // Session ids are reused across restarts (`main-1` is always the first tab),
  // so a killed tab MUST drop its uuid. Otherwise the next `main-1` would
  // resume a conversation that belonged to a session the user deliberately
  // threw away.
  function clearSid(id) {
    const p = sidPath(id);
    if (!p) return;
    try { fs.rmSync(p, { force: true }); } catch { /* best effort */ }
  }

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      // ENOENT is the normal first-boot case, not a failure worth warning about.
      if (err.code !== 'ENOENT') disable(err, 'read');
      return [];
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn(`session store: ${file} is not valid JSON, starting with no sessions`);
      return [];
    }

    // NOT A VERSION GATE, AND DO NOT ADD ONE. Nothing here reads
    // parsed.version, because per-entry validation already subsumes both
    // directions of migration: a version 1 entry has no provider and gets the
    // default, and an entry from a FUTURE version naming a provider this build
    // has never heard of gets the default too. A gate that refused to load a
    // newer roster would lose every tab, which is precisely the outcome the
    // header of this module says is broken rather than merely degraded. The
    // version is noted once so a downgrade is visible in the log, and then
    // ignored.
    if (typeof parsed?.version === 'number' && parsed.version > ROSTER_VERSION) {
      noteNewerRoster(parsed.version);
    }

    const entries = parsed && Array.isArray(parsed.sessions) ? parsed.sessions : [];
    const seen = new Set();
    const out  = [];
    for (const entry of entries) {
      // The roster is attacker-adjacent input: its ids get interpolated into
      // tmux commands (see /refresh) and joined into filesystem paths, so they
      // go through the same SAFE_ID gate as anything arriving over HTTP.
      // Anything that fails is dropped, never repaired.
      const id = entry && entry.id;
      if (typeof id !== 'string' || !SAFE_ID.test(id) || seen.has(id)) continue;
      seen.add(id);
      // The provider is REPAIRED rather than dropped, unlike the id, and the
      // asymmetry is the point: a bad id has no safe interpretation, while a
      // missing or unrecognised provider has an obvious one and the tab is
      // worth more than the field. Registry membership is the real gate; the
      // pattern is the cheap pre-check that keeps a hostile value out of the
      // lookup in front of it.
      const provider = entry.provider;
      const ok = typeof provider === 'string'
        && SAFE_PROVIDER.test(provider)
        && PROVIDERS.has(provider);
      out.push({ id, provider: ok ? provider : DEFAULT_PROVIDER });
    }
    return out;
  }

  function save(sessions) {
    if (disabled) return;
    // Deliberately NOT persisting cols/rows: the browser sends a resize within
    // milliseconds of attaching, so a stored size would be stale on arrival and
    // would buy a write on every fit.
    const payload = JSON.stringify({
      version:  ROSTER_VERSION,
      sessions: [...sessions].map(s => ({
        id:       s.id,
        // Defaulted on the way out as well as on the way in, so a caller that
        // has not been taught about providers cannot write an entry that the
        // next load has to repair.
        provider: PROVIDERS.has(s.provider) ? s.provider : DEFAULT_PROVIDER,
      })),
    });
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Write-then-rename: a crash mid-write leaves the previous roster intact
      // rather than a truncated file, which would restore zero sessions — the
      // exact failure this whole module exists to prevent.
      fs.writeFileSync(tmpFile, payload);
      fs.renameSync(tmpFile, file);
    } catch (err) {
      disable(err, 'write');
    }
  }

  // Did the previous process exit on purpose?
  //
  // This gates whether a restored session is allowed to continue its work by
  // itself, and the distinction is a safety one, not a nicety. A deliberate
  // `docker restart` or image update is a fine reason to pick up where Claude
  // left off. A container that DIED is not: the most likely reason it died is
  // the work itself, an out-of-memory build being the classic, and telling
  // Claude "continue please" there is telling it to do the thing that killed
  // the box a second time.
  //
  // The mechanism is deliberately one-directional. We only ever write the
  // marker from a signal handler on the way out, so the presence of the file
  // means "we chose to stop"; its absence covers every way a process can die
  // without getting a say (SIGKILL, an OOM kill, the host losing power). That
  // makes unclean the DEFAULT — the conservative branch is the one you get when
  // you know nothing, which is the only safe way round for this decision.
  //
  // Note what this does and does not tell you: it distinguishes clean from
  // unclean deterministically. It does NOT identify why an unclean exit
  // happened; nothing readable from inside the restarted container survives to
  // say whether it was an OOM kill or a power cut.
  function markCleanShutdown() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, CLEAN_MARKER), new Date().toISOString());
    } catch { /* a missed marker just means the next boot is cautious */ }
  }

  // Read the marker and immediately clear it, so it can only ever vouch for the
  // shutdown that wrote it. Leaving it in place would let one clean stop excuse
  // every crash that followed.
  function consumeCleanShutdown() {
    const marker = path.join(dir, CLEAN_MARKER);
    let clean = false;
    try {
      clean = fs.existsSync(marker);
    } catch {
      return false;
    }
    try { fs.rmSync(marker, { force: true }); } catch { /* best effort */ }
    return clean;
  }

  return { dir, file, sidPath, readSid, clearSid, load, save, markCleanShutdown, consumeCleanShutdown };
}

module.exports = { createSessionStore, nullSessionStore, ROSTER_VERSION };
