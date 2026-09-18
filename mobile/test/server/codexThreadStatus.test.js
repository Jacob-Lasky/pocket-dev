import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODEX_STATUS_PATH } from '../../server.js';
import { spawnEnv } from './pdEnv.js';

const THREAD_ID = '01a08f30-7695-7273-9381-94270adae10a';
const THREAD_ID_2 = '01a08f30-7695-7273-9381-94270adae10b';

let home, stubDir, requestLog;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-status-home-'));
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-status-bin-'));
  requestLog = path.join(home, 'requests.jsonl');

  const codex = path.join(stubDir, 'codex');
  fs.writeFileSync(codex, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id) fs.appendFileSync(process.env.PD_TEST_REQUEST_LOG, line + '\\n');
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
    return;
  }
  if (message.method !== 'thread/turns/list') return;
  const mode = process.env.PD_TEST_STATUS_MODE || 'completed';
  if (mode === 'hang') return;
  if (mode === 'exit') process.exit(1);
  if (mode === 'oversized') {
    process.stdout.write('x'.repeat(1024 * 1024 + 1));
    return;
  }
  if (mode === 'malformed') {
    process.stdout.write('{"thread":"' + message.params.threadId + '"\\n');
    return;
  }
  if (mode === 'stderr') {
    process.stderr.write(message.params.threadId + '\\n');
  }
  if (mode === 'error') {
    process.stdout.write(JSON.stringify({
      id: message.id,
      error: { code: -32600, message: message.params.threadId },
    }) + '\\n');
    return;
  }
  if (mode === 'by-thread-error') {
    if (message.params.threadId === ${JSON.stringify(THREAD_ID_2)}) {
      process.stdout.write(JSON.stringify({
        id: message.id,
        error: { code: -32600, message: message.params.threadId },
      }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({
        id: message.id,
        result: { data: [{ status: 'interrupted' }] },
      }) + '\\n');
    }
    return;
  }
  if (mode === 'by-thread') {
    const status = message.params.threadId === ${JSON.stringify(THREAD_ID)}
      ? 'interrupted'
      : 'failed';
    const reply = () => process.stdout.write(JSON.stringify({
      id: message.id,
      result: { data: [{ status }] },
    }) + '\\n');
    if (message.params.threadId === ${JSON.stringify(THREAD_ID)}) setTimeout(reply, 25);
    else reply();
    return;
  }
  const data = mode === 'empty' ? []
    : mode === 'multiple' ? [{ status: 'completed' }, { status: 'interrupted' }]
    : mode === 'stderr' ? [{ status: 'completed' }]
    : [{ status: mode }];
  process.stdout.write(JSON.stringify({ id: message.id, result: { data } }) + '\\n');
});
`);
  fs.chmodSync(codex, 0o755);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(stubDir, { recursive: true, force: true });
});

function run(mode = 'completed', input = THREAD_ID, timeoutMs = 1000) {
  return spawnSync(CODEX_STATUS_PATH, [], {
    env: spawnEnv({
      HOME: home,
      PATH: `${stubDir}:${process.env.PATH}`,
      PD_CODEX_STATUS_TIMEOUT_MS: String(timeoutMs),
      PD_TEST_REQUEST_LOG: requestLog,
      PD_TEST_STATUS_MODE: mode,
    }),
    input: `${input}\n`,
    encoding: 'utf8',
    timeout: 2_000,
  });
}

function runServerReader(mode = 'completed', input = THREAD_ID, { batch = false } = {}) {
  const serverPath = path.resolve(import.meta.dirname, '../../server.js');
  const script = `
    const fs = require('node:fs');
    const { readCodexTurnStatus, readCodexTurnStatuses } = require(${JSON.stringify(serverPath)});
    const ids = fs.readFileSync(0, 'utf8').split(/\\s+/).filter(Boolean);
    const result = ${batch ? 'readCodexTurnStatuses(ids)' : 'readCodexTurnStatus(ids[0])'};
    process.stdout.write(${batch ? 'JSON.stringify(result)' : 'result'});
  `;
  return spawnSync(process.execPath, ['-e', script], {
    env: spawnEnv({
      HOME: home,
      PATH: `${stubDir}:${process.env.PATH}`,
      PD_CODEX_STATUS_TIMEOUT_MS: '1000',
      PD_TEST_REQUEST_LOG: requestLog,
      PD_TEST_STATUS_MODE: mode,
    }),
    input: `${input}\n`,
    encoding: 'utf8',
    // This nests two Node launches around the fake App Server. The behavior's
    // own deadline remains 1 second; this outer limit only bounds test setup.
    timeout: 6_000,
  });
}

describe('pd-codex-thread-status', () => {
  it('is executable because server.js invokes it by path', () => {
    expect(fs.statSync(CODEX_STATUS_PATH).mode & 0o111).toBeTruthy();
  });

  it.each(['completed', 'interrupted', 'failed', 'inProgress'])(
    'preserves the supported %s status',
    (status) => {
      const result = run(status);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${status}\n`);
      expect(result.stderr).toBe('');
    },
  );

  it('uses the read-only newest-turn App Server contract', () => {
    expect(run('interrupted').stdout).toBe('interrupted\n');
    const requests = fs.readFileSync(requestLog, 'utf8').trim().split('\n').map(JSON.parse);
    expect(requests[0]).toMatchObject({
      method: 'initialize',
      params: { capabilities: { experimentalApi: true } },
    });
    expect(requests[1]).toMatchObject({
      method: 'thread/turns/list',
      params: {
        threadId: THREAD_ID,
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      },
    });
  });

  it('reads multiple statuses in input order through one initialized App Server', () => {
    const result = run('by-thread', `${THREAD_ID}\n${THREAD_ID_2}`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('interrupted\nfailed\n');
    expect(result.stderr).toBe('');

    const requests = fs.readFileSync(requestLog, 'utf8').trim().split('\n').map(JSON.parse);
    expect(requests.filter(({ method }) => method === 'initialize')).toHaveLength(1);
    expect(requests.filter(({ method }) => method === 'thread/turns/list')).toHaveLength(2);
    expect(requests.slice(1).map(({ params }) => params.threadId)).toEqual([
      THREAD_ID,
      THREAD_ID_2,
    ]);
  });

  it('preserves positions when a batch mixes valid and invalid ids', () => {
    const result = run('by-thread', `not-a-thread\n${THREAD_ID_2}\n${THREAD_ID}`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('unknown\nfailed\ninterrupted\n');
    expect(result.stderr).toBe('');
  });

  it('isolates one App Server request error from the other batch positions', () => {
    const result = run('by-thread-error', `${THREAD_ID}\n${THREAD_ID_2}`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('interrupted\nunknown\n');
    expect(result.stderr).toBe('');
  });

  it('bounds a hung batch by one aggregate deadline', () => {
    const input = [THREAD_ID, THREAD_ID_2, '01a08f30-7695-7273-9381-94270adae10c'].join('\n');
    const started = Date.now();
    const result = run('hang', input, 200);
    const elapsedMs = Date.now() - started;

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('unknown\nunknown\nunknown\n');
    expect(result.stderr).toBe('');
    expect(elapsedMs).toBeLessThan(1000);
    const requests = fs.readFileSync(requestLog, 'utf8').trim().split('\n').map(JSON.parse);
    expect(requests.filter(({ method }) => method === 'thread/turns/list')).toHaveLength(3);
  });

  it.each([
    ['interrupted', 'interrupted'],
    ['completed', 'completed'],
    ['error', 'unknown'],
  ])('wires %s through the server default as %s', (mode, expected) => {
    const result = runServerReader(mode);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(expected);
    expect(result.stderr).toBe('');
  });

  it('wires ordered batches through the server default', () => {
    const result = runServerReader('by-thread', `${THREAD_ID}\n${THREAD_ID_2}`, { batch: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('["interrupted","failed"]');
    expect(result.stderr).toBe('');
  });

  it.each(['unknownStatus', 'empty', 'multiple', 'error', 'malformed', 'hang'])(
    'fails closed without exposing the thread id for %s output',
    (mode) => {
      const result = run(mode);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('unknown\n');
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain(THREAD_ID);
      expect(result.stderr).not.toContain(THREAD_ID);
    },
  );

  it.each(['exit', 'oversized'])(
    'fails closed when App Server produces %s',
    (mode) => {
      const result = run(mode);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('unknown\n');
      expect(result.stderr).toBe('');
    },
  );

  it('does not expose an App Server stderr diagnostic containing the thread id', () => {
    const result = run('stderr');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('completed\n');
    expect(result.stderr).toBe('');
  });

  it('rejects a malformed stdin id before starting App Server', () => {
    const result = run('completed', '../not-a-thread');
    expect(result.stdout).toBe('unknown\n');
    expect(fs.existsSync(requestLog)).toBe(false);
  });
});
