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

// Classify the state of a conversation from its transcript tail.
//
//   'idle'    Claude finished its turn and the next move is the user's.
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
  for (let i = lines.length - 1; i >= 0; i--) {
    let record;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue; // truncated or non-JSON line, keep walking back
    }
    if (!record || (record.type !== 'user' && record.type !== 'assistant')) continue;
    // Subagent turns run on their own branch and finish independently of the
    // main thread; hook/command output is bookkeeping, not conversation.
    if (record.isSidechain === true || record.isMeta === true) continue;

    if (record.type === 'assistant') {
      const stop = record.message && record.message.stop_reason;
      return stop === 'end_turn' ? 'idle' : 'busy';
    }
    // A user record is normally a tool_result (Claude was working) — except the
    // interrupt marker, which means the user hit Escape on purpose. Restarting
    // work they deliberately stopped is the one nudge that would actively annoy.
    if (textOf(record.message).trimStart().startsWith('[Request interrupted by user')) return 'idle';
    return 'busy';
  }
  return 'unknown';
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
//   status      'busy' | 'idle' | 'unknown', as classifyTranscript
//   title       Claude's own `aiTitle`, the name its resume picker shows
//   lastPrompt  the user's most recent message, for a preview line
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

  return { status: classifyRecords(lines), title, lastPrompt };
}

// Convenience wrapper: uuid -> 'busy' | 'idle' | 'unknown'.
function statusOf(uuid, { projectsDir }) {
  const file = findTranscript(uuid, { projectsDir });
  if (!file) return 'unknown';
  return classifyTranscript(file);
}

// uuid -> { status, title, lastPrompt }. A conversation with no transcript on
// disk is not an error: a session created seconds ago has not written one yet.
function inspect(uuid, { projectsDir, tailBytes = TAIL_BYTES } = {}) {
  const file = findTranscript(uuid, { projectsDir });
  if (!file) return { status: 'unknown', title: null, lastPrompt: null };
  return inspectTranscript(file, { tailBytes });
}

module.exports = { findTranscript, classifyTranscript, inspectTranscript, statusOf, inspect };
