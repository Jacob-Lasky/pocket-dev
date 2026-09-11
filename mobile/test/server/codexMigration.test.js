import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const helper = path.join(root, 'pd-codex-bind-current');
const UUID = '01a08f30-7695-7273-9381-94270adae10a';

let home, stubDir;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-migrate-'));
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-tmux-'));
  const tmux = path.join(stubDir, 'tmux');
  fs.writeFileSync(tmux, '#!/bin/bash\nprintf \'%s\\n\' "${PD_TEST_TMUX_SESSION:-main-1}"\n');
  fs.chmodSync(tmux, 0o755);
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
      CODEX_THREAD_ID: UUID,
      ...extra,
    },
    encoding: 'utf8',
  });
}

describe('binding a pre-upgrade Codex tab', () => {
  it('records its own supported thread id without printing it', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(UUID);
    expect(result.stderr).not.toContain(UUID);
    expect(fs.readFileSync(path.join(home, '.pocket-dev', 'sids', 'main-1.uuid'), 'utf8'))
      .toBe(`${UUID}\n`);
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
