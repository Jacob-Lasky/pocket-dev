// Shared id guards.
//
// These live in their own module because several files need the identical
// definition — server.js for ids arriving over HTTP, sessionStore.js for the
// roster it reads back off disk, and provider helpers for the conversation id
// they read from the state dir. A second copy of any of these patterns is a
// security bug waiting to drift, so DO NOT re-declare them at a call site.

// tmux session names + the URL/body params we accept must match this charset.
// Lets us interpolate ids into shell strings without sanitization gymnastics.
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

// Provider conversation ids. Checked before a uuid reaches a shell command line
// or filesystem lookup: it is read back off disk, so it is untrusted input no
// matter that pocket-dev's own launcher or hook is what wrote it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Which AI harness a session runs. A short lowercase id, and a CLOSED set:
// membership of the providers.js registry is the real gate, because the id
// selects a COMMAND LINE and an unrecognised one must be REJECTED rather than
// defaulted through, or a typo silently runs the wrong harness. This pattern is
// the cheap pre-check in front of that lookup, so a hostile value from the
// roster or an HTTP body never reaches an object index or a log line.
const SAFE_PROVIDER = /^[a-z][a-z0-9-]{0,15}$/;

module.exports = { SAFE_ID, UUID_RE, SAFE_PROVIDER };
