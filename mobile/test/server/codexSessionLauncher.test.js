import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODEX_LAUNCHER_PATH } from '../../server.js';
import { spawnEnv } from './pdEnv.js';

const UUID_A = '01a08f30-7695-7273-9381-94270adae10a';
const UUID_B = '01a08f62-f9f2-7c32-b621-941ca1026065';
const RUN_SECONDS = '2.5s';

let home, stubDir, argvLog, sidFile;

function runLauncher(file = sidFile) {
  const env = spawnEnv({
    HOME: home,
    PATH: `${stubDir}:${process.env.PATH}`,
    PD_ARGV_LOG: argvLog,
    PD_CODEX_SID_FILE: file,
  });

  spawnSync('timeout', [
    RUN_SECONDS, CODEX_LAUNCHER_PATH,
    'codex-dg', '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-5.6-sol',
  ], { env, encoding: 'utf8' });

  return fs.readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-home-'));
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-stub-'));
  argvLog = path.join(stubDir, 'argv.log');
  sidFile = path.join(home, '.pocket-dev', 'sids', 'main-1.uuid');
  fs.writeFileSync(argvLog, '');
  const stub = path.join(stubDir, 'codex-dg');
  fs.writeFileSync(stub, '#!/bin/bash\nprintf \'%s\\n\' "$*" >> "$PD_ARGV_LOG"\nexit 0\n');
  fs.chmodSync(stub, 0o755);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(stubDir, { recursive: true, force: true });
});

describe('pd-codex-session', () => {
  it('is executable because server.js invokes it by path', () => {
    expect(fs.statSync(CODEX_LAUNCHER_PATH).mode & 0o111).toBeTruthy();
  });

  it('starts fresh when the tab has no recorded session id', () => {
    const calls = runLauncher();
    expect(calls[0]).toBe('--dangerously-bypass-approvals-and-sandbox -m gpt-5.6-sol');
    expect(calls[0]).not.toContain('resume');
  }, 15000);

  it('resumes the tab\'s explicit id on only the first launcher iteration', () => {
    fs.mkdirSync(path.dirname(sidFile), { recursive: true });
    fs.writeFileSync(sidFile, `${UUID_A}\n`);

    const calls = runLauncher();
    expect(calls[0]).toBe(`resume ${UUID_A} --dangerously-bypass-approvals-and-sandbox -m gpt-5.6-sol`);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[1]).toBe('--dangerously-bypass-approvals-and-sandbox -m gpt-5.6-sol');
    expect(calls[1]).not.toContain(UUID_A);
  }, 15000);

  it('does not let two restored tabs converge on one conversation', () => {
    const sidFileA = path.join(home, '.pocket-dev', 'sids', 'main-1.uuid');
    const sidFileB = path.join(home, '.pocket-dev', 'sids', 'main-2.uuid');
    fs.mkdirSync(path.dirname(sidFileA), { recursive: true });
    fs.writeFileSync(sidFileA, `${UUID_A}\n`);
    fs.writeFileSync(sidFileB, `${UUID_B}\n`);

    const callsA = runLauncher(sidFileA);
    fs.writeFileSync(argvLog, '');
    const callsB = runLauncher(sidFileB);

    expect(callsA[0]).toContain(`resume ${UUID_A}`);
    expect(callsA[0]).not.toContain(UUID_B);
    expect(callsB[0]).toContain(`resume ${UUID_B}`);
    expect(callsB[0]).not.toContain(UUID_A);
  }, 20000);

  it('rejects a malformed recorded id instead of handing it to codex', () => {
    fs.mkdirSync(path.dirname(sidFile), { recursive: true });
    fs.writeFileSync(sidFile, '../../not-a-session');
    const calls = runLauncher();
    expect(calls[0]).not.toContain('resume');
    expect(calls.join('\n')).not.toContain('../../not-a-session');
  }, 15000);
});
