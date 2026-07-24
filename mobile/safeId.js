// Shared id guards.
//
// These live in their own module because three files need the identical
// definition — server.js for ids arriving over HTTP, sessionStore.js for the
// roster it reads back off disk, claudeSession.js for the Claude uuid it reads
// out of the state dir. A second copy of either pattern is a security bug
// waiting to drift, so DO NOT re-declare them at a call site.

// tmux session names + the URL/body params we accept must match this charset.
// Lets us interpolate ids into shell strings without sanitization gymnastics.
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

// Claude Code conversation ids. Checked before a uuid reaches a shell command
// line or a filesystem lookup: it is read back off disk, so it is untrusted
// input no matter that pocket-dev's own launcher is what wrote it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = { SAFE_ID, UUID_RE };
