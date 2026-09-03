// The Remote Control notices Claude Code writes into a conversation's own
// transcript, copied VERBATIM from the live pocket-dev container's transcripts
// on 2026-09-03 (Claude Code 2.1.259).
//
// One definition, because the exact bytes are one fact and four files assert
// against it: the detector's unit tests, the server's close tests, the e2e
// spec, and the artifact spec. Four private copies must all agree to be
// correct, and an inconsistent update to any one of them is INVISIBLE - that
// file's tests keep passing against its own stale copy, which is the clone
// class that actually produces faults.
//
// Deliberately NOT derived from claudeSession.js's matcher constants. These are
// the external wire shape and that is the thing under test; defining both from
// one source would make every assertion here agree with the matcher by
// construction and test nothing. The independence is the point.
//
// Frequencies below are from the same measurement, 30 informational records in
// total, and they are why the matcher cannot key on "(code 4090)" alone.

const base = (uuid, content) => ({
  type: 'system',
  subtype: 'informational',
  level: 'warning',
  isMeta: false,
  uuid,
  content,
});

// 24 of 30. The one that means a human is finished with the conversation.
// Bridge close 4090, reason `session_not_active`.
export const archivedNotice = (uuid) => base(uuid,
  'Remote Control disconnected — this session was ended or archived from another device or app (code 4090)');

// 1 of 30. Reason `session_not_found`. Reads the same as the server having lost
// the registration, so it is NOT treated as an instruction to close.
export const deletedNotice = (uuid) => base(uuid,
  'Remote Control disconnected — the server no longer reports this session — it may have been deleted from another device or app (code 4090)');

// Reason `superseded_by_worker`: the conversation is alive somewhere else.
export const supersededNotice = (uuid) => base(uuid,
  'Remote Control disconnected — another worker took over this session, so this one is standing down (code 4090)');

// 4 of 30. Not a 4090 at all, just the account signing out.
export const loggedOutNotice = (uuid) => base(uuid,
  'Remote Control disconnected — /login');

// The notice text as it appears when a HUMAN or a tool quotes it, which is the
// measured false positive a raw tail scan fires on. Same sentence, so any
// matcher that looks only at the text cannot tell the two apart.
export const NOTICE_TEXT = archivedNotice('x').content;
