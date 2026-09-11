import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const helper = path.join(root, 'pd-codex-bind-current');
const CHILD_UUID = '01a08f30-7695-7273-9381-94270adae10a';
const ROOT_UUID = '01a08f62-f9f2-7c32-b621-941ca1026065';

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
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: { thread: {
        id: message.params.threadId,
        sessionId: process.env.PD_TEST_ROOT_ID,
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
      ...extra,
    },
    encoding: 'utf8',
  });
}

describe('binding a pre-upgrade Codex tab', () => {
  it('records the resumable session root without printing either thread id', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(CHILD_UUID);
    expect(result.stderr).not.toContain(CHILD_UUID);
    expect(result.stdout).not.toContain(ROOT_UUID);
    expect(result.stderr).not.toContain(ROOT_UUID);
    expect(fs.readFileSync(path.join(home, '.pocket-dev', 'sids', 'main-1.uuid'), 'utf8'))
      .toBe(`${ROOT_UUID}\n`);
  });

  it('fails closed when it cannot identify the conversation or tmux tab', () => {
    expect(run({ CODEX_THREAD_ID: '' }).status).not.toBe(0);
    expect(run({ PD_TEST_TMUX_SESSION: '../escape' }).status).not.toBe(0);
    expect(fs.existsSync(path.join(home, '.pocket-dev', 'sids', 'escape.uuid'))).toBe(false);
  });

  it('does not claim success when the binding cannot be written', () => {
    const result = run({ PD_STATE_DIR: '/dev/null' });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('ready to resume');
  });
});
