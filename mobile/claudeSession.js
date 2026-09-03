const fs   = require('fs');
const path = require('path');
const { UUID_RE } = require('./safeId');

// Read-side knowledge of Claude Code's on-disk conversation state. Everything
// here is inspection only: pocket-dev never writes into ~/.claude/projects.
//
// It answers one question at restore time: when this tab died, was Claude
// mid-turn or was it waiting on the user? That decides whether the restored tab
// gets nudged to keep going or is left exactly as the user left it, sitting at
// the prompt with their own next move still theirs to make. Guessing "busy"
// wrongly makes Claude talk to itself; guessing "idle" wrongly just means the
// user types "continue" by hand. So UNKNOWN MUST NEVER NUDGE — when the tail is
// unreadable, unparseable, or shaped in a way we do not recognise, say so and
// let the caller do nothing.

// How much of the transcript tail to read. Records are one JSON object per
// line and a single tool_result can be very large, so this has to be generous
// enough to contain the last few of them; the files themselves run to tens of
// megabytes, so reading the whole thing is not an option.
const TAIL_BYTES = 512 * 1024;

// Find the transcript for a conversation id.
//
// Claude derives the per-project directory name from the cwd by replacing every
// non-alphanumeric character (/home/claude -> -home-claude), an internal detail
// we deliberately do NOT reimplement: we scan the project dirs for
// <uuid>.jsonl instead, so a session whose cwd moved, or a future tweak to that
// escaping rule, cannot silently break resume detection.
function findTranscript(uuid, { projectsDir }) {
  if (!UUID_RE.test(uuid || '')) return null;
  let dirents;
  try {
    dirents = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const candidate = path.join(projectsDir, dirent.name, `${uuid}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Read up to the last `bytes` of a file and return its complete lines. The
// first line of the window is dropped when we did not start at byte 0, because
// it is almost certainly a partial record.
function readTailLines(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const size  = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const len   = size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter(l => l.trim().length > 0);
  } catch {
    return [];
  } finally {
    try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

function textOf(message) {
  if (!message) return '';
  const { content } = message;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n');
}

// Tools whose result comes from the HUMAN rather than from the machine.
//
// This is the difference between "Claude is working" and "Claude is blocked on
// you", and from the outside the two look identical: both are an assistant turn
// that ended in a tool call with no result yet. Only the tool's name separates
// them. Measured across Jake's transcripts 2026-07-27: a pending
// AskUserQuestion sat unanswered for up to 39 minutes, the whole of which
// pocket-dev reported as "Working".
//
// Keep this list SHORT and keep it to tools that cannot proceed without a
// person. A tool that merely takes a long time (Bash, WebFetch, an Agent) is
// busy, not asking, and putting one in here would tell the user to go answer
// something that is going to answer itself.
//
// AskUserQuestion is measured: 12 real pending instances across six
// transcripts. ExitPlanMode is REASONED, not measured — no transcript on either
// machine contains one, because Jake's sessions run with permissions skipped
// and rarely enter plan mode. It is here because plan approval is by
// construction a decision only the user can make, so its result arrives from a
// human exactly as AskUserQuestion's does. If that is ever wrong the cost is
// small and self-clearing (a session reads as asking for the second or two the
// call is open), which is why it does not wait for a sample.
const USER_INPUT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

// Classify the state of a conversation from its transcript tail.
//
//   'idle'    Claude finished its turn and the next move is the user's.
//   'asking'  Claude put a direct question to the user and is blocked on the
//             answer. A stronger form of idle: it wants a SPECIFIC reply, so it
//             does not stop wanting one just because the user glanced at it.
//   'busy'    Claude was mid-turn: a tool call in flight, a tool result not yet
//             answered, or a user message it never got to respond to.
//   'unknown' Nothing we recognise. Caller must treat this as "do not touch".
//
// The rule is deliberately inverted — busy is the default for any recognised
// message record — because a turn that ends cleanly is the ONLY shape that
// reliably means "waiting on the human": a completed assistant turn carries
// stop_reason 'end_turn'. An interrupted stream leaves stop_reason null, a tool
// call leaves 'tool_use', and both mean work was still in flight.
function classifyTranscript(file, { tailBytes = TAIL_BYTES } = {}) {
  return classifyRecords(readTailLines(file, tailBytes));
}

function classifyRecords(lines) {
  return decide(lines).status;
}

// The record that decides the status, and its identity.
//
// `turnId` is the deciding record's own uuid, which every message record
// carries. It is what lets a caller tell "the same turn I already saw" from "a
// new one", WITHOUT comparing timestamps or file sizes: a TUI repaint does not
// touch the transcript, and the bookkeeping records Claude appends between
// turns (ai-title, last-prompt, summary) are not message records, so neither
// moves it. A genuinely new turn always does.
function decide(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let record;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue; // truncated or non-JSON line, keep walking back
    }
    if (!record || (record.type !== 'user' && record.type !== 'assistant')) continue;
    // Subagent turns run on their own branch and finish independently of the
    // main thread; hook/command output is bookkeeping, not conversation. A
    // subagent also cannot ask the user anything, so skipping it here is what
    // keeps a sidechain's tool call from reading as a question.
    if (record.isSidechain === true || record.isMeta === true) continue;

    const turnId = typeof record.uuid === 'string' ? record.uuid : null;

    if (record.type === 'assistant') {
      const stop = record.message && record.message.stop_reason;
      if (stop === 'end_turn') return { status: 'idle', turnId };
      // A tool call with no result yet. Whether that means "working" or
      // "blocked on you" is entirely a question of WHICH tool, so ask.
      //
      // Gated on stop_reason 'tool_use' on purpose: an interrupted stream
      // (stop_reason null) may carry a half-written tool_use block for a call
      // that never ran, and nobody is waiting on a question that was never put.
      if (stop === 'tool_use' && pendingUserInput(record.message)) return { status: 'asking', turnId };
      return { status: 'busy', turnId };
    }
    // A user record is normally a tool_result (Claude was working) — except the
    // interrupt marker, which means the user hit Escape on purpose. Restarting
    // work they deliberately stopped is the one nudge that would actively annoy.
    if (textOf(record.message).trimStart().startsWith('[Request interrupted by user')) {
      return { status: 'idle', turnId };
    }
    return { status: 'busy', turnId };
  }
  return { status: 'unknown', turnId: null };
}

// Does this assistant message end in a tool call that only a human can answer?
function pendingUserInput(message) {
  const content = message && message.content;
  if (!Array.isArray(content)) return false;
  return content.some(b => b && b.type === 'tool_use' && USER_INPUT_TOOLS.has(b.name));
}

// The notice Claude Code writes when the Remote Control bridge is closed
// because the conversation was archived or ended from ANOTHER device: the
// desktop app, the phone, or claude.ai/code. It is the only signal pocket-dev
// gets that the user is finished with a tab somewhere else, and it is already
// on disk, so no new watcher is needed to see it.
//
// Shape, measured against Claude Code 2.1.259 on 2026-09-03 (23 real instances
// across the container's transcripts). The bridge closes 4090 with reason
// `session_not_active`, appends this record, and then carries on as a purely
// local session, so the process does NOT exit and nothing else marks the event:
//
//   {"type":"system","subtype":"informational","level":"warning",
//    "content":"Remote Control disconnected \u2014 this session was ended or
//               archived from another device or app (code 4090)", "uuid":"..."}
//
// MATCH THE RECORD, NEVER THE RAW TAIL. A bare `line.includes(...)` scan is
// wrong, and measured wrong on this very transcript: a `type:"user"` record
// carries the sentence verbatim whenever anyone QUOTES the message, which is
// exactly what happened when this feature was requested and again when a shell
// probe printed it into a tool result. Both would have closed a live tab.
// Requiring type/subtype is what separates the notice from talk about it, and
// there is no other kind of record the notice can arrive as.
//
// The other 4090 reasons are deliberately NOT matched, because only this one
// means a human is done with the conversation:
//
//   superseded_by_worker  another worker took the session over and this one
//                         "is standing down" - the conversation is alive
//   session_not_found     "may have been deleted", which reads the same way as
//                         the server having simply lost the registration
//   epoch_stale           the worker registration went stale
//
// `Remote Control disconnected \u2014 /login` is the same record shape once
// more and only means the account signed out. Every one of these was present in
// the sample, so a match on "(code 4090)" alone is not a discriminator.
//
// Written as escapes rather than a literal em dash so the exact character is
// visible in source and cannot be normalised away by an editor or a merge.
const ARCHIVED_HEAD = 'Remote Control disconnected';
const ARCHIVED_BODY = 'ended or archived from another device';

function isArchivedNotice(record) {
  if (!record || record.type !== 'system' || record.subtype !== 'informational') return false;
  const { content } = record;
  return typeof content === 'string'
    && content.startsWith(ARCHIVED_HEAD)
    && content.includes(ARCHIVED_BODY);
}

// The uuid of the most recent archive notice in the tail, or null for none.
//
// A uuid rather than a boolean, because the caller has to tell "archived since
// I adopted this tab" from "archived at some point in a conversation I am
// holding open", and acting on the second throws away a live tmux pane. The
// conversation itself survives either way, since nothing here writes to
// ~/.claude/projects and the resume picker reads exactly these files. The
// notice sits at EOF in
// the case that matters, but it stays in the tail window while the conversation
// carries on, and it does carry on: of 23 real archive events, 4 were followed
// by more work, two of them by roughly 1450 further turns. A boolean would
// close those tabs again on every restart.
//
// A notice with no uuid answers null, which reads as "nothing archived" and so
// fails CLOSED, which is the safe direction when the alternative is killing a
// pane on a guess. It must not fall through to an older notice: the older one
// is precisely what the caller already has recorded.
function findArchivedNotice(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    // Cheap reject before parsing. The notice is rare next to the message
    // records it is interleaved with, same shape as inspectTranscript's filter.
    if (!lines[i].includes(ARCHIVED_BODY)) continue;
    let record;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!isArchivedNotice(record)) continue;
    return typeof record.uuid === 'string' ? record.uuid : null;
  }
  return null;
}

// Longest title / preview we will hand to a caller. These strings come off disk
// and end up in JSON and in the DOM, so they get a hard ceiling rather than a
// trusting pass-through. A preview is one line by construction: newlines are
// folded to spaces so a pasted multi-line prompt cannot break a list row.
const MAX_TITLE  = 200;
const MAX_PREVIEW = 240;

function cleanOneLine(value, max) {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Everything worth knowing about a conversation, from ONE read of the tail.
//
//   status      'busy' | 'idle' | 'asking' | 'unknown', as classifyTranscript
//   turnId      uuid of the record the status was decided from, so a caller can
//               tell a new turn from one it has already accounted for
//   title       Claude's own `aiTitle`, the name its resume picker shows
//   lastPrompt  the user's most recent message, for a preview line
//   archivedId  uuid of the newest Remote Control archive notice, or null
//
// Claude appends a fresh `ai-title` and `last-prompt` record on roughly every
// turn (98 of each in a single 11 MB transcript, measured 2026-07-24), so the
// LAST occurrence is the current one and we walk backwards to it. Measured
// across six real transcripts, both records sit within 32 KB of EOF even in a
// 14 MB file, comfortably inside the tail window: reading the whole file to
// find them is never necessary and would be ruinous.
//
// Reading all three in one pass is the point of this function. The session list
// asks for status and title together, repeatedly, and two passes would mean two
// reads of a half-megabyte tail per session per poll.
function inspectTranscript(file, { tailBytes = TAIL_BYTES } = {}) {
  const lines = readTailLines(file, tailBytes);
  let title = null;
  let lastPrompt = null;

  for (let i = lines.length - 1; i >= 0 && (title === null || lastPrompt === null); i--) {
    // Cheap reject before parsing: these two record types are rare next to the
    // message records they are interleaved with.
    if (!lines[i].includes('"ai-title"') && !lines[i].includes('"last-prompt"')) continue;
    let record;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!record) continue;
    if (title === null && record.type === 'ai-title') title = cleanOneLine(record.aiTitle, MAX_TITLE);
    if (lastPrompt === null && record.type === 'last-prompt') lastPrompt = cleanOneLine(record.lastPrompt, MAX_PREVIEW);
  }

  const { status, turnId } = decide(lines);
  // Same `lines`, so the archive scan costs a walk of already-read strings
  // behind a substring reject, not a second read of a half-megabyte tail.
  return { status, turnId, title, lastPrompt, archivedId: findArchivedNotice(lines) };
}

// Every status this module can emit, and the ones that mean a human has to do
// something. ONE definition, because the alternative is a bare `status ===
// 'idle' || status === 'asking'` in the server and a second copy of the same
// judgement in the browser, drifting apart the moment a fifth status appears.
// The client cannot import this (CJS server, ESM browser, JSON in between), so
// `test/unit/statusContract.test.js` asserts the two agree instead.
const STATUSES    = Object.freeze(['idle', 'asking', 'busy', 'unknown']);
const WANTS_USER  = Object.freeze(new Set(['idle', 'asking']));

// The statuses that mean nothing is in flight: the turn is over and the next
// move belongs to the user. A caller about to do something DESTRUCTIVE to a
// session asks this, and it must ask POSITIVELY rather than testing for 'busy'.
//
// `!== 'busy'` is the version that looks equivalent and is not, because it
// treats 'unknown' as safe. 'unknown' is the answer when the tail holds no
// complete message record, and one way to get there is a single tool_result
// larger than TAIL_BYTES: readTailLines drops the partial first line, so a
// window containing one huge in-flight record and nothing else classifies as
// unknown while the session is very much mid-turn. Reading it as safe kills a
// session in the middle of the largest tool call it has ever made.
//
// Identical to WANTS_USER for today's four statuses and deliberately NOT the
// same constant: that one means "a human needs to see this", this one means
// "nothing is running". A fifth status could easily be one and not the other,
// and the two readings are what would have to be untangled afterwards.
const TURN_SETTLED = Object.freeze(new Set(['idle', 'asking']));

// Deliberately NO uuid-level wrappers here. There were two (`statusOf` and
// `inspect`, each uuid -> findTranscript -> read) and the server stopped using
// both: it holds the resolved path in its own memo cache, keyed on mtime and
// size, so re-resolving per poll would undo the caching that memo exists for.
// An exported convenience whose only caller is its own test is dead weight that
// reads as API.
module.exports = {
  findTranscript, classifyTranscript, inspectTranscript,
  USER_INPUT_TOOLS, STATUSES, WANTS_USER, TURN_SETTLED,
};
