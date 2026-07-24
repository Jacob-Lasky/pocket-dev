const fs   = require('fs');
const path = require('path');
const { SAFE_ID, UUID_RE } = require('./safeId');

// Durable record of which sessions the server is hosting, so a container
// restart brings the user's tabs back instead of dropping them to one blank
// session.
//
// WHY a file, when tmux already tracks sessions: tmux is not a source of truth
// here. Its server is a child of this container's PID namespace and dies with
// it, so after a restart there is nothing left to enumerate. The roster is
// rewritten on every create/destroy and read once at boot; server.js then
// re-creates each id, and because it spawns with `new-session -A` that same
// call REATTACHES when the tmux session did survive (node restarted, container
// did not) and creates it fresh when it did not. One code path, both cases.
//
// Alongside the roster we keep one tiny `<id>.uuid` file per session, written
// by pd-claude-session and only ever read (and deleted) here. That is the
// handoff that lets a restored tab resume its Claude conversation; see
// claudeSession.js for what we do with the uuid.
//
// EVERY failure in this module is non-fatal by design. An unwritable, missing,
// or garbage state dir must leave pocket-dev booting exactly as it did before
// this feature existed — a terminal that loses its tabs on restart is degraded,
// a terminal that will not start is broken.

const ROSTER_VERSION = 1;

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

  function sidPath(id) {
    if (!SAFE_ID.test(id)) return null;
    return path.join(sidDir, `${id}.uuid`);
  }

  // The Claude conversation id pd-claude-session recorded for this tab, or null.
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
  // so a killed tab MUST drop its uuid — otherwise the next `main-1` would
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
      out.push({ id });
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
      sessions: [...sessions].map(s => ({ id: s.id })),
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

  return { dir, file, sidPath, readSid, clearSid, load, save };
}

module.exports = { createSessionStore, nullSessionStore, ROSTER_VERSION };
