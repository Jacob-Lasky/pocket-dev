import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const helper = path.join(root, 'pd-codex-bind-current');
const CHILD_UUID = '01a08f30-7695-7273-9381-94270adae10a';
const ROOT_UUID = '01a08f62-f9f2-7c32-b621-941ca1026065';
const MIDDLE_UUID = '01a08fa1-e722-7bb1-aa9d-02604e994d5f';

let home, stubDir;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-migrate-'));
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-tmux-'));
  const tmux = path.join(stubDir, 'tmux');
  fs.writeFileSync(tmux, '#!/bin/bash\nprintf \'%s\\n\' "${PD_TEST_TMUX_SESSION:-main-1}"\n');
  fs.chmodSync(tmux, 0o755);

  const codex = path.join(stubDir, 'codex');
  fs.writeFileSync(codex, `#!/usr/bin/env node
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
  }
  if (message.method === 'thread/read') {
    if (process.env.PD_TEST_APP_SERVER_ERROR) {
      process.stdout.write(JSON.stringify({
        id: message.id,
        error: { code: -32600, message: process.env.CODEX_THREAD_ID },
      }) + '\\n');
      return;
    }
    const requestedId = message.params.threadId;
    const isRoot = requestedId === process.env.PD_TEST_ROOT_ID;
    const isMiddle = requestedId === process.env.PD_TEST_MIDDLE_ID;
    let parentThreadId = null;
    let sessionId = requestedId;
    if (!process.env.PD_TEST_NO_PARENT && !isRoot) {
      parentThreadId = isMiddle ? process.env.PD_TEST_ROOT_ID : process.env.PD_TEST_MIDDLE_ID;
      sessionId = isMiddle ? process.env.PD_TEST_ROOT_ID : process.env.PD_TEST_MIDDLE_ID;
    }
    if (process.env.PD_TEST_PARENT_CYCLE && isRoot) parentThreadId = process.env.CODEX_THREAD_ID;
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: { thread: {
        id: requestedId,
        sessionId,
        parentThreadId,
      } },
    }) + '\\n');
  }
});
`);
  fs.chmodSync(codex, 0o755);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(stubDir, { recursive: true, force: true });
});

function run(extra = {}) {
  return spawnSync(helper, [], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${stubDir}:${process.env.PATH}`,
      PD_STATE_DIR: path.join(home, '.pocket-dev'),
      CODEX_THREAD_ID: CHILD_UUID,
      PD_TEST_ROOT_ID: ROOT_UUID,
      PD_TEST_MIDDLE_ID: MIDDLE_UUID,
      ...extra,
    },
    encoding: 'utf8',
  });
}

describe('binding a pre-upgrade Codex tab', () => {
  it('walks nested subagent parents to the resumable root without printing any thread id', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(CHILD_UUID);
    expect(result.stderr).not.toContain(CHILD_UUID);
    expect(result.stdout).not.toContain(ROOT_UUID);
    expect(result.stderr).not.toContain(ROOT_UUID);
    expect(result.stdout).not.toContain(MIDDLE_UUID);
    expect(result.stderr).not.toContain(MIDDLE_UUID);
    expect(fs.readFileSync(path.join(home, '.pocket-dev', 'sids', 'main-1.uuid'), 'utf8'))
      .toBe(`${ROOT_UUID}\n`);
  });

  it('fails closed when it cannot identify the conversation or tmux tab', () => {
    expect(run({ CODEX_THREAD_ID: '' }).status).not.toBe(0);
    expect(run({ PD_TEST_TMUX_SESSION: '../escape' }).status).not.toBe(0);
    expect(fs.existsSync(path.join(home, '.pocket-dev', 'sids', 'escape.uuid'))).toBe(false);
  });

  it('keeps a root thread bound to itself', () => {
    const result = run({ CODEX_THREAD_ID: ROOT_UUID });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(home, '.pocket-dev', 'sids', 'main-1.uuid'), 'utf8'))
      .toBe(`${ROOT_UUID}\n`);
  });

  it('keeps a non-subagent fork bound to its own thread id', () => {
    const result = run({ PD_TEST_NO_PARENT: '1' });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(home, '.pocket-dev', 'sids', 'main-1.uuid'), 'utf8'))
      .toBe(`${CHILD_UUID}\n`);
  });

  it('atomically replaces a stale binding with the verified root', () => {
    const sidDir = path.join(home, '.pocket-dev', 'sids');
    fs.mkdirSync(sidDir, { recursive: true });
    fs.writeFileSync(path.join(sidDir, 'main-1.uuid'), `${MIDDLE_UUID}\n`);
    const result = run();
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(sidDir, 'main-1.uuid'), 'utf8')).toBe(`${ROOT_UUID}\n`);
  });

  it('fails closed without exposing ids when App Server cannot validate the thread', () => {
    const result = run({ PD_TEST_APP_SERVER_ERROR: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain(CHILD_UUID);
    expect(result.stderr).not.toContain(CHILD_UUID);
    expect(fs.existsSync(path.join(home, '.pocket-dev', 'sids', 'main-1.uuid'))).toBe(false);
  });

  it('refuses a parent chain that cycles instead of reaching a root', () => {
    const result = run({ PD_TEST_PARENT_CYCLE: '1' });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(home, '.pocket-dev', 'sids', 'main-1.uuid'))).toBe(false);
  });

  it('does not claim success when the binding cannot be written', () => {
    const result = run({ PD_STATE_DIR: '/dev/null' });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('ready to resume');
  });
});
