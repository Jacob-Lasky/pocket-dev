import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnEnv } from './pdEnv.js';

// entrypoint.sh runs `fleet.py resume-self` once per boot, which is what
// restarts this machine's headless supervisor watcher after a recreate
// (WORK-318; the only path since WORK-689 removed Happier's daemon supervisor).
// The stub appends its argv per call (so a second run shows), waits DELAY
// seconds first (so a foreground run would hold up the boot), and exits with
// EXIT. stderr goes to a FILE, not a pipe: spawnSync waits for a piped stderr
// to close, which a background child holds open, so a pipe could not tell
// background from foreground.

const ROOT = path.resolve(__dirname, '../../..');
const ENTRYPOINT = path.join(ROOT, 'entrypoint.sh');

let tmproot, home, skel, cache, calls, log, script;

beforeEach(() => {
  tmproot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-resume-'));
  home = path.join(tmproot, 'home');
  skel = path.join(tmproot, 'skel');
  cache = path.join(tmproot, 'cache');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(skel, '.local/share'), { recursive: true });
  calls = path.join(tmproot, 'resume-calls');
  log = path.join(tmproot, 'boot-stderr');
  script = path.join(tmproot, 'fleet-stub.py');
  fs.writeFileSync(script, [
    'import os, sys, time',
    'time.sleep(float(os.environ.get("DELAY", "0")))',
    `open(${JSON.stringify(calls)}, "a").write(" ".join(sys.argv[1:]) + "\\n")`,
    'print("resumed")',
    'sys.exit(int(os.environ.get("EXIT", "0")))',
    '',
  ].join('\n'));
});

afterEach(() => {
  fs.rmSync(tmproot, { recursive: true, force: true });
});

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
function waitFor(predicate, ms = 8000) {
  const end = Date.now() + ms;
  while (!predicate() && Date.now() < end) pause(50);
  return predicate();
}

function boot(env = {}) {
  const fd = fs.openSync(log, 'w');
  const started = Date.now();
  const res = spawnSync('bash', [ENTRYPOINT, 'true'], {
    env: spawnEnv({
      HOME: home,
      PD_SKEL_DIR: skel,
      PD_CACHE_DIR: cache,
      PD_SUPERVISOR_RESUME_SCRIPT: script,
      ...env,
    }),
    stdio: ['ignore', 'ignore', fd],
  });
  fs.closeSync(fd);
  expect(res.status).toBe(0);
  return Date.now() - started;
}

describe('entrypoint.sh resumes the supervisor watcher', () => {
  it('runs resume-self once, in the background', () => {
    const elapsed = boot({ DELAY: '2' });
    expect(elapsed).toBeLessThan(2000);
    expect(read(calls)).toBe('');
    expect(waitFor(() => read(log).includes('supervisor-resume: resumed'))).toBe(true);
    pause(300);
    expect(read(calls)).toBe('resume-self --timeout 600\n');
    expect(read(log).match(/supervisor-resume: resumed/g)).toHaveLength(1);
    expect(read(log)).not.toContain('exited');
  });

  it('logs a failed run with its exit status', () => {
    boot({ EXIT: '3' });
    expect(waitFor(() => read(log).includes('supervisor-resume: exited 3;'))).toBe(true);
    expect(read(log)).toContain('supervisor-resume: resumed');
  });

  it('honours PD_SUPERVISOR_RESUME=0', () => {
    boot({ PD_SUPERVISOR_RESUME: '0' });
    pause(500);
    expect(read(calls)).toBe('');
  });

  it('does nothing when the supervisor skill is not installed', () => {
    boot({ PD_SUPERVISOR_RESUME_SCRIPT: path.join(tmproot, 'absent.py') });
    pause(500);
    expect(read(calls)).toBe('');
  });

  it('no longer depends on a Happier switch (WORK-689)', () => {
    // PD_HAPPIER used to pick between the Happier supervisor and this run.
    // It means nothing now; a leftover template value must not turn it off.
    boot({ PD_HAPPIER: '1' });
    expect(waitFor(() => read(calls) === 'resume-self --timeout 600\n')).toBe(true);
  });
});
