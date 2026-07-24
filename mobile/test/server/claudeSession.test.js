import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findTranscript, classifyTranscript, statusOf } from '../../claudeSession.js';

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

describe('statusOf', () => {
  it('maps a uuid straight through to its status', () => {
    writeTranscript(UUID,  [userPrompt, assistantEndTurn]);
    writeTranscript(UUID2, [userPrompt, assistantToolUse]);
    expect(statusOf(UUID,  { projectsDir })).toBe('idle');
    expect(statusOf(UUID2, { projectsDir })).toBe('busy');
  });

  it('is unknown when the conversation was never written', () => {
    expect(statusOf(UUID, { projectsDir })).toBe('unknown');
  });
});
