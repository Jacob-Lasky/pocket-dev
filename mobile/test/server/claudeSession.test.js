import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findTranscript, classifyTranscript, inspectTranscript } from '../../claudeSession.js';
import { archivedNotice as archived, deletedNotice as deleted, supersededNotice as superseded, loggedOutNotice as loggedOut, NOTICE_TEXT } from '../fixtures/rc-notices.js';

// Record shapes below are copied from real Claude Code transcripts (structure
// only). They are the contract this classifier reads; if Claude changes them,
// these tests are what tells us before a restored session starts nudging
// itself in production.
const UUID  = '6d7657b2-2e36-4a45-a083-4c300969650d';
const UUID2 = 'c5599505-08dd-4471-801c-ad088d3e06f8';

const assistantEndTurn = { type: 'assistant', isSidechain: false, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done, over to you' }] } };
const assistantToolUse = { type: 'assistant', isSidechain: false, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } };
const userToolResult   = { type: 'user',      isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } };
const userPrompt       = { type: 'user',      isSidechain: false, message: { role: 'user', content: [{ type: 'text', text: 'please refactor this' }] } };
const userInterrupt    = { type: 'user',      isSidechain: false, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } };
// A tool call the MACHINE answers looks identical to one only a HUMAN can
// answer, apart from the name. Shape copied from a real pending question
// (measured 2026-07-27: 12 of these across six transcripts, one unanswered for
// 39 minutes, every second of which pocket-dev reported as "Working").
const assistantAsking  = { type: 'assistant', isSidechain: false, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'AskUserQuestion' }] } };
const assistantPlan    = { type: 'assistant', isSidechain: false, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'ExitPlanMode' }] } };
// Bookkeeping records Claude appends after the conversation proper.
const trailer = [{ type: 'last-prompt' }, { type: 'ai-title' }, { type: 'mode' }, { type: 'permission-mode' }];

let projectsDir;

function writeTranscript(uuid, records, { project = '-home-claude' } = {}) {
  const dir = path.join(projectsDir, project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

beforeEach(() => {
  projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-projects-'));
});

afterEach(() => {
  fs.rmSync(projectsDir, { recursive: true, force: true });
});

describe('findTranscript', () => {
  it('finds the transcript without reimplementing the cwd escaping rule', () => {
    const file = writeTranscript(UUID, [assistantEndTurn], { project: '-home-claude--claude-skills' });
    expect(findTranscript(UUID, { projectsDir })).toBe(file);
  });

  it('returns null for a uuid with no transcript', () => {
    expect(findTranscript(UUID, { projectsDir })).toBeNull();
  });

  it('returns null for a missing projects dir', () => {
    expect(findTranscript(UUID, { projectsDir: path.join(projectsDir, 'nope') })).toBeNull();
  });

  it('refuses anything that is not a uuid', () => {
    // The value is joined into a path, so path traversal must not resolve.
    for (const bad of ['', '..', '../../etc/passwd', 'main-1', null]) {
      expect(findTranscript(bad, { projectsDir })).toBeNull();
    }
  });
});

describe('classifyTranscript', () => {
  it('reads a finished turn as idle — Claude was waiting on the user', () => {
    expect(classifyTranscript(writeTranscript(UUID, [userPrompt, assistantEndTurn]))).toBe('idle');
  });

  it('reads a tool call in flight as busy', () => {
    expect(classifyTranscript(writeTranscript(UUID, [userPrompt, assistantToolUse]))).toBe('busy');
  });

  it('reads a pending question as asking, not busy — it is blocked on the user', () => {
    expect(classifyTranscript(writeTranscript(UUID, [userPrompt, assistantAsking]))).toBe('asking');
    expect(classifyTranscript(writeTranscript(UUID, [userPrompt, assistantPlan]))).toBe('asking');
  });

  it('reads an ANSWERED question as busy again', () => {
    // The answer arrives as the tool_result, and Claude is off working on it.
    expect(classifyTranscript(writeTranscript(UUID, [assistantAsking, userToolResult]))).toBe('busy');
  });

  it('does not call an ordinary long-running tool call asking', () => {
    // The whole discrimination is the tool NAME. If pendingness alone were
    // enough, every Bash command would tell the user to go answer something.
    expect(classifyTranscript(writeTranscript(UUID, [userPrompt, assistantToolUse]))).toBe('busy');
    for (const name of ['Bash', 'WebFetch', 'Agent', 'Read', undefined]) {
      const call = { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name }] } };
      expect(classifyTranscript(writeTranscript(UUID, [userPrompt, call]))).toBe('busy');
    }
  });

  it('does not call a half-streamed question asking', () => {
    // stop_reason null means the stream was cut off, so the call never ran and
    // nobody is waiting on an answer to a question that was never put.
    const partial = { type: 'assistant', message: { role: 'assistant', stop_reason: null, content: [{ type: 'tool_use', name: 'AskUserQuestion' }] } };
    expect(classifyTranscript(writeTranscript(UUID, [userPrompt, partial]))).toBe('busy');
  });

  it('ignores a question asked on a subagent branch', () => {
    // A subagent has no user to ask, and its branch finishes independently.
    const sidechainAsking = { ...assistantAsking, isSidechain: true };
    expect(classifyTranscript(writeTranscript(UUID, [assistantToolUse, sidechainAsking]))).toBe('busy');
  });

  it('reads an unanswered tool result as busy', () => {
    expect(classifyTranscript(writeTranscript(UUID, [assistantToolUse, userToolResult]))).toBe('busy');
  });

  it('reads an unanswered user message as busy', () => {
    expect(classifyTranscript(writeTranscript(UUID, [assistantEndTurn, userPrompt]))).toBe('busy');
  });

  it('reads a half-streamed assistant turn as busy', () => {
    const partial = { type: 'assistant', message: { role: 'assistant', stop_reason: null, content: [{ type: 'text', text: 'thinking out lou' }] } };
    expect(classifyTranscript(writeTranscript(UUID, [userPrompt, partial]))).toBe('busy');
  });

  it('reads a user interrupt as idle — do not restart work they stopped on purpose', () => {
    expect(classifyTranscript(writeTranscript(UUID, [assistantToolUse, userInterrupt]))).toBe('idle');
    const forToolUse = { ...userInterrupt, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } };
    expect(classifyTranscript(writeTranscript(UUID, [assistantToolUse, forToolUse]))).toBe('idle');
  });

  it('accepts string content as well as content blocks', () => {
    const stringInterrupt = { type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } };
    expect(classifyTranscript(writeTranscript(UUID, [assistantToolUse, stringInterrupt]))).toBe('idle');
  });

  it('ignores the trailing bookkeeping records Claude appends', () => {
    expect(classifyTranscript(writeTranscript(UUID, [userPrompt, assistantEndTurn, ...trailer]))).toBe('idle');
    expect(classifyTranscript(writeTranscript(UUID, [userPrompt, assistantToolUse, ...trailer]))).toBe('busy');
  });

  it('ignores subagent turns — a sidechain finishing is not the main thread finishing', () => {
    const sidechainDone = { ...assistantEndTurn, isSidechain: true };
    expect(classifyTranscript(writeTranscript(UUID, [assistantToolUse, sidechainDone]))).toBe('busy');
  });

  it('ignores meta records', () => {
    const meta = { ...userPrompt, isMeta: true };
    expect(classifyTranscript(writeTranscript(UUID, [assistantEndTurn, meta]))).toBe('idle');
  });

  it('says unknown — never busy — when there is nothing it recognises', () => {
    // 'unknown' is the caller's signal to leave the session alone, so an empty
    // or unrecognisable transcript must never fall through to a nudge.
    expect(classifyTranscript(writeTranscript(UUID, trailer))).toBe('unknown');
    expect(classifyTranscript(writeTranscript(UUID, []))).toBe('unknown');
    expect(classifyTranscript(path.join(projectsDir, 'no-such-file.jsonl'))).toBe('unknown');
  });

  it('skips unparseable lines and keeps walking back', () => {
    const file = writeTranscript(UUID, [assistantEndTurn]);
    fs.appendFileSync(file, '{"type":"assistant", truncated mid-writ\n');
    expect(classifyTranscript(file)).toBe('idle');
  });

  it('reads only the tail of a huge transcript', () => {
    // Real transcripts run to tens of megabytes; the classifier must not slurp
    // one to answer a question about its last record.
    const filler = { type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'x'.repeat(4096) }] } };
    const file = writeTranscript(UUID, [...Array(400).fill(filler), assistantEndTurn]);
    expect(fs.statSync(file).size).toBeGreaterThan(1024 * 1024);
    expect(classifyTranscript(file, { tailBytes: 64 * 1024 })).toBe('idle');
  });

  it('drops the partial first line of a tail window', () => {
    const filler = { type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', content: 'y'.repeat(2048) }] } };
    const file = writeTranscript(UUID, [...Array(50).fill(filler), assistantEndTurn]);
    expect(classifyTranscript(file, { tailBytes: 3000 })).toBe('idle');
  });
});

// turnId is what makes "has anything happened since I last looked" answerable
// without timestamps or file sizes. The server compares it per poll, so a value
// that moved when the conversation did not would put a session back into the
// unread state for no reason — the exact bug this exists to prevent.
describe('inspectTranscript turnId', () => {
  const withUuid = (record, uuid) => ({ ...record, uuid });

  it('is the deciding record own uuid', () => {
    const file = writeTranscript(UUID, [userPrompt, withUuid(assistantEndTurn, UUID2)]);
    expect(inspectTranscript(file).turnId).toBe(UUID2);
  });

  it('does not move when only bookkeeping records are appended', () => {
    // ai-title / last-prompt land between turns and are not conversation. If
    // they moved this, every title refresh would read as a new turn.
    const records = [userPrompt, withUuid(assistantEndTurn, UUID2)];
    const before = inspectTranscript(writeTranscript(UUID, records)).turnId;
    const after  = inspectTranscript(writeTranscript(UUID, [...records, title('Named later'), prompt('same turn')])).turnId;
    expect(after).toBe(before);
  });

  it('moves when a new turn finishes', () => {
    const first  = inspectTranscript(writeTranscript(UUID, [withUuid(assistantEndTurn, UUID2)]));
    const second = inspectTranscript(writeTranscript(UUID, [
      withUuid(assistantEndTurn, UUID2), userPrompt, withUuid(assistantEndTurn, '9f1c1e30-2f4d-4a1f-9a5e-1b2c3d4e5f60'),
    ]));
    expect(second.status).toBe('idle');
    expect(second.turnId).not.toBe(first.turnId);
  });

  it('is null when there is no record to decide from, or it carries no uuid', () => {
    expect(inspectTranscript(writeTranscript(UUID, trailer)).turnId).toBeNull();
    expect(inspectTranscript(writeTranscript(UUID, [assistantEndTurn])).turnId).toBeNull();
  });
});

// Claude appends a fresh ai-title and last-prompt on roughly every turn (98 of
// each in one real 11 MB transcript), so these are append-only streams where
// the LAST record is the current value, not write-once fields.
const title = (t) => ({ type: 'ai-title', aiTitle: t, sessionId: UUID });
const prompt = (p) => ({ type: 'last-prompt', lastPrompt: p, leafUuid: 'x', sessionId: UUID });

describe('inspectTranscript', () => {
  it('pulls the title and preview out alongside the status, in one pass', () => {
    const file = writeTranscript(UUID, [userPrompt, title('Restructure skills'), prompt('do the thing'), assistantEndTurn]);
    expect(inspectTranscript(file)).toEqual({
      status: 'idle',
      turnId: null,
      title: 'Restructure skills',
      lastPrompt: 'do the thing',
      archivedId: null,
    });
  });

  it('takes the LAST of each, because they are rewritten every turn', () => {
    const file = writeTranscript(UUID, [
      title('First guess at a name'), prompt('opening message'),
      userPrompt, assistantToolUse,
      title('What it actually turned into'), prompt('the newest message'),
    ]);
    const got = inspectTranscript(file);
    expect(got.title).toBe('What it actually turned into');
    expect(got.lastPrompt).toBe('the newest message');
  });

  it('returns nulls rather than guessing when a conversation has no title yet', () => {
    // A session created seconds ago is the normal case here, not an error.
    expect(inspectTranscript(writeTranscript(UUID, [userPrompt]))).toEqual({
      status: 'busy', turnId: null, title: null, lastPrompt: null, archivedId: null,
    });
  });

  it('folds a multi-line prompt into one line so a list row cannot break', () => {
    const file = writeTranscript(UUID, [prompt('first line\n\nsecond line\n   third'), assistantEndTurn]);
    expect(inspectTranscript(file).lastPrompt).toBe('first line second line third');
  });

  it('caps runaway strings', () => {
    const file = writeTranscript(UUID, [title('T'.repeat(500)), prompt('P'.repeat(900)), assistantEndTurn]);
    const got = inspectTranscript(file);
    expect(got.title.length).toBeLessThanOrEqual(200);
    expect(got.lastPrompt.length).toBeLessThanOrEqual(240);
    expect(got.title.endsWith('…')).toBe(true);
  });

  it('ignores an empty or non-string title', () => {
    for (const bad of ['', '   ', 42, null, { nope: true }]) {
      const file = writeTranscript(UUID, [{ type: 'ai-title', aiTitle: bad }, assistantEndTurn]);
      expect(inspectTranscript(file).title).toBeNull();
    }
  });

  it('finds metadata that sits tens of kilobytes back from the end', () => {
    // Measured on real transcripts: ai-title lands up to ~32 KB from EOF in a
    // 14 MB file, so the tail window has to be generous enough to catch it.
    const filler = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'z'.repeat(4096) }] } };
    const file = writeTranscript(UUID, [title('Buried but current'), ...Array(12).fill(filler), assistantEndTurn]);
    expect(inspectTranscript(file).title).toBe('Buried but current');
  });

  it('does not mistake a title for a conversation turn', () => {
    // ai-title records carry no message, so they must not affect the status.
    const file = writeTranscript(UUID, [assistantToolUse, title('Mid-flight'), prompt('go')]);
    expect(inspectTranscript(file).status).toBe('busy');
  });
});

// The Remote Control notices, copied verbatim from the live container's
// transcripts on 2026-09-03 (Claude Code 2.1.259). All four shapes below were
// present in the same sample of 30 informational records, which is why the
// matcher cannot key on "(code 4090)" and cannot key on the phrase alone.
const NOTICE_A = 'aaaa1111-1111-4111-8111-111111111111';
const NOTICE_B = 'bbbb2222-2222-4222-8222-222222222222';

describe('inspectTranscript archive notice', () => {
  it('reports the notice uuid when a conversation was archived elsewhere', () => {
    const file = writeTranscript(UUID, [userPrompt, assistantEndTurn, archived(NOTICE_A)]);
    expect(inspectTranscript(file).archivedId).toBe(NOTICE_A);
  });

  it('takes the NEWEST notice, so a second archive is a new event', () => {
    // A conversation can be archived, carried on with, and archived again. The
    // caller compares this uuid against the one it holds, so returning the
    // older notice would make the second archive invisible.
    const file = writeTranscript(UUID, [archived(NOTICE_A), userPrompt, assistantEndTurn, archived(NOTICE_B)]);
    expect(inspectTranscript(file).archivedId).toBe(NOTICE_B);
  });

  it('still reports it once the conversation has carried on past it', () => {
    // Measured: 4 of 23 real archives were followed by more work. The notice
    // does not stop being in the tail, which is exactly why the SERVER has to
    // compare uuids rather than treat any sighting as news.
    const file = writeTranscript(UUID, [archived(NOTICE_A), userPrompt, assistantEndTurn]);
    expect(inspectTranscript(file).archivedId).toBe(NOTICE_A);
  });

  it('does NOT fire on a user or tool record that quotes the message', () => {
    // This is the measured false positive, not a hypothetical one. The request
    // that built this feature pasted the notice into a prompt, and a shell
    // probe printed it into a tool result, so both shapes really are on disk in
    // Jake's transcripts. A tail scan for the phrase closes a live tab on them.
    //
    // The uuids here are load-bearing: every real record carries one, and
    // without them these fixtures get rejected for the wrong reason (no uuid to
    // return) and the test passes even with the record-shape check deleted.
    // Verified by deleting it: the case only goes red with the uuids present.
    const quoted = { type: 'user', uuid: NOTICE_A, isSidechain: false, message: { role: 'user', content: [{ type: 'text', text:
      `whenever i archive a conversation in claude code desktop, we get this message: ${NOTICE_TEXT}` }] } };
    const toolOutput = { type: 'user', uuid: NOTICE_B, isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', content:
      `grep hit: ${NOTICE_TEXT}` }] } };
    // And a system record from a DIFFERENT subtype carrying the same text, which
    // is what a /resume or slash-command echo of the message looks like.
    const otherSubtype = { ...archived(NOTICE_A), subtype: 'local_command' };
    for (const record of [quoted, toolOutput, otherSubtype]) {
      expect(inspectTranscript(writeTranscript(UUID, [record, assistantEndTurn])).archivedId).toBeNull();
    }
  });

  it('ignores the other 4090 reasons and the /login notice', () => {
    // Only the archive reason means a human is finished with the conversation.
    // superseded_by_worker means it is alive somewhere else, session_not_found
    // reads the same as the server losing the registration, and /login is an
    // auth problem. All three shipped in the same record shape.
    for (const record of [deleted(NOTICE_A), superseded(NOTICE_A), loggedOut(NOTICE_A)]) {
      expect(inspectTranscript(writeTranscript(UUID, [assistantEndTurn, record])).archivedId).toBeNull();
    }
  });

  it('fails closed on a notice with no uuid', () => {
    // Nothing to compare against means we cannot tell a new archive from the
    // one already recorded, and the action is a kill. Answering null leaves the
    // tab alone; it must NOT fall through to an older notice, which is the very
    // one the caller already holds.
    const noUuid = { ...archived(NOTICE_A) };
    delete noUuid.uuid;
    const file = writeTranscript(UUID, [archived(NOTICE_B), userPrompt, noUuid]);
    expect(inspectTranscript(file).archivedId).toBeNull();
  });

  it('does not disturb the status it is read alongside', () => {
    const file = writeTranscript(UUID, [userPrompt, assistantEndTurn, archived(NOTICE_A)]);
    expect(inspectTranscript(file).status).toBe('idle');
    expect(classifyTranscript(file)).toBe('idle');
  });
});
