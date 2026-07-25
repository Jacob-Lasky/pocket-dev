import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LAUNCHER_PATH } from '../../server.js';

// pd-claude-session decides, on every iteration of the restart loop, whether to
// resume the previous conversation or start a new one. Nothing in the browser
// suite can reach it — the e2e fixture runs `cat`, which has no conversation —
// so it is driven here directly against a stub `claude` that records its argv.
// Same rationale as tmuxConf.test.js: guard the untestable-from-the-UI path
// with a real behavioural assertion rather than trusting a read-through.

const UUID = '6d7657b2-2e36-4a45-a083-4c300969650d';

let home, stubDir, argvLog, sidFile;

// Long enough for at least two loop iterations (the launcher sleeps 1s between
// them), which is what proves the first-iteration-only resume rule.
const RUN_SECONDS = '2.5s';

function runLauncher({ withSidFile = true, resumePrompt = null } = {}) {
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${stubDir}:${process.env.PATH}`,
    PD_ARGV_LOG: argvLog,
  };
  if (withSidFile) env.PD_SID_FILE = sidFile;
  else delete env.PD_SID_FILE;
  if (resumePrompt) env.PD_RESUME_PROMPT = resumePrompt;

  spawnSync('timeout', [
    RUN_SECONDS, LAUNCHER_PATH,
    'claude', '--dangerously-skip-permissions', '--model', 'opus[1m]',
  ], { env, encoding: 'utf8' });

  return fs.readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean);
}

const uuidOf = call => (call.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [])[0];
const recordedUuid = () => fs.readFileSync(sidFile, 'utf8').trim();

function writeTranscript(uuid) {
  const dir = path.join(home, '.claude', 'projects', '-home-claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uuid}.jsonl`), '{"type":"assistant"}\n');
}

beforeEach(() => {
  home    = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-home-'));
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-stub-'));
  argvLog = path.join(stubDir, 'argv.log');
  sidFile = path.join(home, '.pocket-dev', 'sids', 'main-1.uuid');
  fs.writeFileSync(argvLog, '');
  // A `claude` that records how it was invoked and exits, so each loop
  // iteration is one line in the log.
  const stub = path.join(stubDir, 'claude');
  fs.writeFileSync(stub, '#!/bin/bash\nprintf \'%s\\n\' "$*" >> "$PD_ARGV_LOG"\nexit 0\n');
  fs.chmodSync(stub, 0o755);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(stubDir, { recursive: true, force: true });
});

describe('pd-claude-session', () => {
  it('is executable — server.js invokes it by path', () => {
    // Losing the mode bit in git would break every session in the image with a
    // permission-denied loop, and nothing else would catch it.
    expect(fs.statSync(LAUNCHER_PATH).mode & 0o111).toBeTruthy();
  });

  it('starts a fresh conversation and records its id when there is nothing to resume', () => {
    const calls = runLauncher();
    expect(calls[0]).toMatch(/--session-id [0-9a-f-]{36}$/);
    expect(calls[0]).not.toContain('--resume');
    // Each iteration mints its own conversation, and the file always names the
    // most recent one — that is what the next restart will resume.
    expect(recordedUuid()).toBe(uuidOf(calls[calls.length - 1]));
    expect(new Set(calls.map(uuidOf)).size).toBe(calls.length);
  }, 15000);

  it('resumes the recorded conversation on the first iteration after a respawn', () => {
    fs.mkdirSync(path.dirname(sidFile), { recursive: true });
    fs.writeFileSync(sidFile, `${UUID}\n`);
    writeTranscript(UUID);

    const calls = runLauncher();
    expect(calls[0]).toBe(`--dangerously-skip-permissions --model opus[1m] --resume ${UUID}`);
  }, 15000);

  it('starts clean on later iterations, because those mean Claude was exited on purpose', () => {
    // The load-bearing half of the contract: a container restart resumes, but
    // typing /exit must not reopen the same conversation forever.
    fs.mkdirSync(path.dirname(sidFile), { recursive: true });
    fs.writeFileSync(sidFile, `${UUID}\n`);
    writeTranscript(UUID);

    const calls = runLauncher();
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[1]).toContain('--session-id');
    expect(calls[1]).not.toContain('--resume');
    expect(calls[1]).not.toContain(UUID);
    // And the newest conversation becomes the one a future restart resumes.
    expect(recordedUuid()).toBe(uuidOf(calls[calls.length - 1]));
    expect(recordedUuid()).not.toBe(UUID);
  }, 15000);

  it('does not try to resume a conversation whose transcript is gone', () => {
    // `claude --resume` on an unknown id just errors, and the loop would spin
    // on it once a second forever.
    fs.mkdirSync(path.dirname(sidFile), { recursive: true });
    fs.writeFileSync(sidFile, `${UUID}\n`);   // no transcript written

    const calls = runLauncher();
    expect(calls[0]).toContain('--session-id');
    expect(calls[0]).not.toContain('--resume');
  }, 15000);

  it('runs without a state dir at all, just without resume', () => {
    const calls = runLauncher({ withSidFile: false });
    expect(calls[0]).toMatch(/--session-id [0-9a-f-]{36}$/);
  }, 15000);

  it('passes the operator-configured command through untouched', () => {
    const calls = runLauncher();
    expect(calls[0]).toContain('--dangerously-skip-permissions --model opus[1m]');
  }, 15000);

  it('hands the resume prompt to Claude as an argument, not as keystrokes', () => {
    // The whole point of the command-line route: a resuming TUI swallows typed
    // input during its startup repaint, with no ready signal to wait for.
    fs.mkdirSync(path.dirname(sidFile), { recursive: true });
    fs.writeFileSync(sidFile, `${UUID}\n`);
    writeTranscript(UUID);

    const calls = runLauncher({ resumePrompt: 'continue please' });
    expect(calls[0]).toBe(`--dangerously-skip-permissions --model opus[1m] --resume ${UUID} continue please`);
  }, 15000);

  it('does not repeat the prompt on later iterations', () => {
    // Iteration 2+ is a fresh conversation after the user exited; replaying
    // "continue please" into it would make Claude answer a question nobody
    // asked, every single time the loop turns over.
    fs.mkdirSync(path.dirname(sidFile), { recursive: true });
    fs.writeFileSync(sidFile, `${UUID}\n`);
    writeTranscript(UUID);

    const calls = runLauncher({ resumePrompt: 'continue please' });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[1]).not.toContain('continue please');
  }, 15000);

  it('does not use the prompt when it is starting fresh rather than resuming', () => {
    const calls = runLauncher({ resumePrompt: 'continue please' });
    expect(calls[0]).toContain('--session-id');
    expect(calls[0]).not.toContain('continue please');
  }, 15000);

  it('keeps a multi-word prompt as ONE argument', () => {
    // Word-splitting here would hand Claude several stray positional args.
    fs.mkdirSync(path.dirname(sidFile), { recursive: true });
    fs.writeFileSync(sidFile, `${UUID}\n`);
    writeTranscript(UUID);
    const stub = path.join(stubDir, 'claude');
    fs.writeFileSync(stub, '#!/bin/bash\nprintf \'argc=%s last=%s\\n\' "$#" "${!#}" >> "$PD_ARGV_LOG"\nexit 0\n');
    fs.chmodSync(stub, 0o755);

    const calls = runLauncher({ resumePrompt: 'please continue the work you were doing' });
    expect(calls[0]).toBe('argc=6 last=please continue the work you were doing');
  }, 15000);

  it('keeps restarting after Claude exits', () => {
    const calls = runLauncher();
    expect(calls.length).toBeGreaterThan(1);
  }, 15000);
});
