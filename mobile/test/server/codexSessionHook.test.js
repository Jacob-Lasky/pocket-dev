import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODEX_HOOK_PATH } from '../../server.js';
import { spawnEnv } from './pdEnv.js';

const UUID_A = '01a08f30-7695-7273-9381-94270adae10a';
const UUID_B = '01a08f62-f9f2-7c32-b621-941ca1026065';

let home, sidDir;

function runHook({ id = UUID_A, file, event = 'SessionStart', source = 'startup' } = {}) {
  const env = spawnEnv({ HOME: home });
  if (file !== undefined) env.PD_CODEX_SID_FILE = file;
  return spawnSync(CODEX_HOOK_PATH, [], {
    env,
    input: JSON.stringify({ session_id: id, hook_event_name: event, source }),
    encoding: 'utf8',
  });
}

function runHookWithStalePidTemp(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_HOOK_PATH, [], {
      env: { ...spawnEnv({ HOME: home }), PD_CODEX_SID_FILE: file },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.${child.pid}.tmp`, 'stale');
    child.stdin.end(JSON.stringify({
      session_id: UUID_A,
      hook_event_name: 'SessionStart',
      source: 'startup',
    }));
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-hook-'));
  sidDir = path.join(home, '.pocket-dev', 'sids');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the managed Codex SessionStart hook', () => {
  it('is executable because Codex invokes it by absolute path', () => {
    expect(fs.statSync(CODEX_HOOK_PATH).mode & 0o111).toBeTruthy();
  });

  it('records the supported session id in this tab\'s file', () => {
    const file = path.join(sidDir, 'main-1.uuid');
    const result = runHook({ file });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(fs.readFileSync(file, 'utf8')).toBe(`${UUID_A}\n`);
  });

  it('keeps two tabs isolated even though they share CODEX_HOME', () => {
    const fileA = path.join(sidDir, 'main-1.uuid');
    const fileB = path.join(sidDir, 'main-2.uuid');
    expect(runHook({ id: UUID_A, file: fileA }).status).toBe(0);
    expect(runHook({ id: UUID_B, file: fileB }).status).toBe(0);
    expect(fs.readFileSync(fileA, 'utf8').trim()).toBe(UUID_A);
    expect(fs.readFileSync(fileB, 'utf8').trim()).toBe(UUID_B);
  });

  it('keeps the root binding when a later compact SessionStart reports another id', () => {
    const file = path.join(sidDir, 'main-1.uuid');
    expect(runHook({ id: UUID_A, file }).status).toBe(0);
    expect(runHook({ id: UUID_B, file, source: 'compact' }).status).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${UUID_A}\n`);
    expect(fs.readdirSync(sidDir)).toEqual(['main-1.uuid']);
  });

  it('atomically rebinds when clear intentionally starts a new conversation', () => {
    const file = path.join(sidDir, 'main-1.uuid');
    expect(runHook({ id: UUID_A, file }).status).toBe(0);
    expect(runHook({ id: UUID_B, file, source: 'clear' }).status).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${UUID_B}\n`);
  });

  it('publishes the root even when a previous container left its PID temp behind', async () => {
    const file = path.join(sidDir, 'main-1.uuid');
    const result = await runHookWithStalePidTemp(file);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(fs.readFileSync(file, 'utf8')).toBe(`${UUID_A}\n`);
  });

  it('does nothing outside a pocket-dev tab', () => {
    const result = runHook({ file: undefined });
    expect(result.status).toBe(0);
    expect(fs.existsSync(sidDir)).toBe(false);
  });

  it('rejects invalid hook input and any destination outside the state directory', () => {
    const outside = path.join(home, 'outside.uuid');
    expect(runHook({ id: 'not-a-uuid', file: path.join(sidDir, 'main-1.uuid') }).status).not.toBe(0);
    expect(runHook({ file: outside }).status).not.toBe(0);
    expect(runHook({ file: path.join(sidDir, '../escape.uuid') }).status).not.toBe(0);
    expect(runHook({ file: path.join(sidDir, 'bad name.uuid') }).status).not.toBe(0);
    expect(fs.existsSync(outside)).toBe(false);
  });
});
