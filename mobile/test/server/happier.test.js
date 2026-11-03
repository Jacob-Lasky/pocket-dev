import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnEnv } from './pdEnv.js';

// The Happier daemon's permanent home: the pinned image install and the
// boot-time supervisor. OpenCode's data surviving a recreate is no longer its own
// mechanism: ~/.local is a real directory in the home mount, so every tool's XDG
// data persists, and entrypointSeed.test.js covers it.
//
// None of this is reachable from the cat-based e2e suite (no Happier relay, no
// account, no daemon), so the guards are the same two kinds the rest of the
// server suite uses: source-level assertions for what only exists as text, and
// the real scripts executed against a temp HOME with a stub `happier` on PATH.

const ROOT = path.resolve(__dirname, '../../..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const ENTRYPOINT = path.join(ROOT, 'entrypoint.sh');
const SUPERVISOR = path.join(ROOT, 'mobile/pd-happier-supervise');
const TOOLS_PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent-tools/package.json'), 'utf8'));
const TOOLS_LOCK = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent-tools/package-lock.json'), 'utf8'));

describe('agent tools are pinned in exactly one place', () => {
  it('pins Happier and OpenCode to exact versions', () => {
    for (const name of ['@happier-dev/cli', '@opencode/cli']) {
      expect(TOOLS_PKG.dependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('has a lockfile that resolved exactly those versions', () => {
    // A lockfile regenerated from a different package.json would install
    // whatever IT says; npm ci trusts the lock, not the manifest.
    for (const [name, version] of Object.entries(TOOLS_PKG.dependencies)) {
      expect(TOOLS_LOCK.packages[`node_modules/${name}`].version).toBe(version);
    }
  });

  it('never repeats a pinned version in the Dockerfile', () => {
    for (const version of Object.values(TOOLS_PKG.dependencies)) {
      expect(DOCKERFILE).not.toContain(version);
    }
  });

  it('allows exactly the install scripts the CLIs need, and denies onnxruntime', () => {
    expect(TOOLS_PKG.allowScripts).toEqual({
      '@happier-dev/cli': true,
      'node-pty': true,
      '@homebridge/node-pty-prebuilt-multiarch': true,
      sharp: true,
      protobufjs: true,
      'onnxruntime-node': false,
      '@opencode/cli': true,
    });
  });
});

describe('Dockerfile install', () => {
  it('installs from the lockfile with npm ci into /opt/agent-tools', () => {
    expect(DOCKERFILE).toMatch(/COPY agent-tools\/package\.json agent-tools\/package-lock\.json \/opt\/agent-tools\//);
    expect(DOCKERFILE).toMatch(/cd \/opt\/agent-tools \\\s*\n\s*&& npm ci /);
  });

  it('puts the binaries in /usr/local/bin, never under the home mount', () => {
    for (const bin of ['happier', 'opencode', 'opencode2']) {
      expect(DOCKERFILE).toContain(`/opt/agent-tools/node_modules/.bin/${bin} /usr/local/bin/${bin}`);
    }
    expect(DOCKERFILE).not.toMatch(/\/home\/claude\/(bin|opt)\/(happier|opencode)/);
  });

  it('records both versions in the build log', () => {
    expect(DOCKERFILE).toMatch(/&& happier --version/);
    expect(DOCKERFILE).toMatch(/&& opencode --version/);
  });

  it('ships the supervisor executable', () => {
    expect(DOCKERFILE).toMatch(/sed -i 's\/\\r\/\/' [^\n]*pd-happier-supervise/);
    expect(DOCKERFILE).toMatch(/chmod \+x [^\n]*\/mobile\/pd-happier-supervise/);
    expect(fs.statSync(SUPERVISOR).mode & 0o111).not.toBe(0);
  });
});

let tmproot, home, skel, cache, stubBin, stubLog;

// A stand-in for the real CLI. `daemon status --json` records itself in
// $STUB_LOG, prints $STUB_STATUS and exits $STUB_STATUS_EXIT; `daemon start`
// and `daemon stop` record themselves and exit $STUB_START_EXIT / $STUB_STOP_EXIT.
function writeStubHappier() {
  fs.mkdirSync(stubBin, { recursive: true });
  fs.writeFileSync(
    path.join(stubBin, 'happier'),
    [
      '#!/bin/bash',
      'case "$*" in',
      '  "daemon status --json") echo status >> "$STUB_LOG"; printf "%s" "$STUB_STATUS"; exit "${STUB_STATUS_EXIT:-0}" ;;',
      '  "daemon start") echo start >> "$STUB_LOG"; exit "${STUB_START_EXIT:-0}" ;;',
      '  "daemon stop") echo stop >> "$STUB_LOG"; exit "${STUB_STOP_EXIT:-0}" ;;',
      '  *) exit 9 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  fs.chmodSync(path.join(stubBin, 'happier'), 0o755);
}

const STATUS = (authenticated, running) => JSON.stringify({ auth: { authenticated }, daemon: { running } });
// The 0.2.17 shape: the running daemon's CLI version against the CLI on PATH.
const CONVERGENCE = ({ daemon = '0.2.16', cli = '0.2.17', matches = daemon === cli, serviceManaged = false } = {}) =>
  JSON.stringify({
    auth: { authenticated: true },
    daemon: { running: true, startedWithCliVersion: daemon, serviceManaged },
    runtimeConvergence: { cliVersionMatches: matches },
    cliUpdate: { currentVersion: cli },
  });

function supervise(env, opts = {}) {
  return spawnSync('bash', [SUPERVISOR], {
    env: spawnEnv({
      HOME: home,
      PATH: `${stubBin}:${process.env.PATH}`,
      STUB_LOG: stubLog,
      PD_HAPPIER_ONCE: '1',
      ...env,
    }),
    encoding: 'utf8',
    ...opts,
  });
}

const calls = (kind) =>
  fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8').split('\n').filter((l) => l === kind).length : 0;
const starts = () => calls('start');

const signIn = () => {
  fs.mkdirSync(path.join(home, '.happier/servers/tower'), { recursive: true });
  fs.writeFileSync(path.join(home, '.happier/servers/tower/access.key'), 'x');
};

beforeEach(() => {
  tmproot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-happier-'));
  home = path.join(tmproot, 'home');
  skel = path.join(tmproot, 'skel');
  cache = path.join(tmproot, 'cache');
  stubBin = path.join(tmproot, 'bin');
  stubLog = path.join(tmproot, 'starts.log');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(skel, '.local/share'), { recursive: true });
  writeStubHappier();
});

afterEach(() => {
  fs.rmSync(tmproot, { recursive: true, force: true });
});

describe('pd-happier-supervise', () => {
  describe('signed in', () => {
    beforeEach(signIn);

    it('starts the daemon when it is not running', () => {
      const res = supervise({ STUB_STATUS: STATUS(true, false) });
      expect(res.status).toBe(0);
      expect(starts()).toBe(1);
      expect(res.stderr).toContain('daemon started');
    });

    it('leaves a running daemon alone', () => {
      const res = supervise({ STUB_STATUS: STATUS(true, true) });
      expect(starts()).toBe(0);
      expect(res.stderr).toContain('daemon running');
    });

    it('never starts a daemon for a signed-out account', () => {
      const res = supervise({ STUB_STATUS: STATUS(false, false) });
      expect(starts()).toBe(0);
      expect(res.stderr).toContain('not signed in');
    });

    it('treats unreadable status as unknown, not as a dead daemon', () => {
      // Restarting on top of a live daemon because the CLI hiccuped is the
      // failure this guards against.
      const res = supervise({ STUB_STATUS: 'not json' });
      expect(starts()).toBe(0);
      expect(res.stderr).toContain('could not read daemon status');
    });

    it('treats JSON without boolean fields as unknown, not as signed out', () => {
      const res = supervise({ STUB_STATUS: JSON.stringify({ error: 'status unavailable' }) });
      expect(starts()).toBe(0);
      expect(res.stderr).toContain('could not read daemon status');
      expect(res.stderr).not.toContain('not signed in');
    });

    it('does not trust a status call that failed, whatever it printed', () => {
      const res = supervise({ STUB_STATUS: STATUS(true, false), STUB_STATUS_EXIT: '1' });
      expect(starts()).toBe(0);
      expect(res.stderr).toContain('could not read daemon status');
    });

    it('reports a start that fails', () => {
      const res = supervise({ STUB_STATUS: STATUS(true, false), STUB_START_EXIT: '1' });
      expect(starts()).toBe(1);
      expect(res.stderr).toContain('did not start');
    });

    it('keeps checking, and logs a steady state once', () => {
      // Several passes must happen (the loop is alive), with one log line.
      const res = supervise(
        { STUB_STATUS: STATUS(true, true), PD_HAPPIER_ONCE: '0', PD_HAPPIER_INTERVAL: '0.1' },
        { timeout: 1500 },
      );
      expect(calls('status')).toBeGreaterThanOrEqual(3);
      expect(res.stderr.match(/daemon running/g)).toHaveLength(1);
    });

    // The interval the loop actually sleeps for, observed directly: a stub
    // `sleep` records its argument and ends the loop. Counting status calls
    // inside a timeout cannot tell the 60 s fallback from a value that sleeps
    // forever (both make exactly one call), and a killed loop's real `sleep`
    // would outlive the test.
    function intervalsSlept(interval) {
      const sleepBin = path.join(tmproot, 'sleepbin');
      fs.mkdirSync(sleepBin, { recursive: true });
      fs.writeFileSync(
        path.join(sleepBin, 'sleep'),
        '#!/bin/bash\necho "sleep $*" >> "$STUB_LOG"\nkill -TERM "$PPID"\n',
        { mode: 0o755 },
      );
      supervise(
        {
          STUB_STATUS: STATUS(true, true),
          PD_HAPPIER_ONCE: '0',
          PD_HAPPIER_INTERVAL: interval,
          PATH: `${sleepBin}:${stubBin}:${process.env.PATH}`,
        },
        { timeout: 5000 },
      );
      return fs.readFileSync(stubLog, 'utf8').split('\n').filter((l) => l.startsWith('sleep ')).map((l) => l.slice(6));
    }

    it.each(['0', '-5', 'abc', '', '0.0000000000000000000000000001', '0.05', '99999999999999999999', '86401'])(
      'falls back to 60s for interval %j, never a tight loop or an endless sleep',
      (interval) => {
        expect(intervalsSlept(interval)).toEqual(['60']);
      },
    );

    it.each(['0.1', '5', '90', '86400'])('sleeps for an in-range interval %j as given', (interval) => {
      expect(intervalsSlept(interval)).toEqual([interval]);
    });

    describe('moving the daemon onto a new CLI', () => {
      // `happier self update` (the Happier app's update button) restarts only a
      // service-owned daemon. This one is started by the loop, so without this
      // it would keep running the old version indefinitely.
      it('stops and starts the daemon when it runs an older CLI than PATH', () => {
        const res = supervise({ STUB_STATUS: CONVERGENCE() });
        expect(calls('stop')).toBe(1);
        expect(starts()).toBe(1);
        expect(res.stderr).toContain('daemon restarted onto CLI 0.2.17 (was 0.2.16)');
      });

      it('leaves a converged daemon alone', () => {
        const res = supervise({ STUB_STATUS: CONVERGENCE({ daemon: '0.2.17' }) });
        expect(calls('stop')).toBe(0);
        expect(starts()).toBe(0);
        expect(res.stderr).toContain('daemon running');
      });

      it('leaves a service-owned daemon to its service', () => {
        supervise({ STUB_STATUS: CONVERGENCE({ serviceManaged: true }) });
        expect(calls('stop')).toBe(0);
      });

      it('never restarts on a status without the convergence field', () => {
        // Older CLIs: unknown is not a mismatch.
        supervise({ STUB_STATUS: STATUS(true, true) });
        expect(calls('stop')).toBe(0);
      });

      it('restarts once per version pair, not in a loop, when it does not take', () => {
        const res = supervise(
          { STUB_STATUS: CONVERGENCE(), PD_HAPPIER_ONCE: '0', PD_HAPPIER_INTERVAL: '0.1' },
          { timeout: 1500 },
        );
        expect(calls('status')).toBeGreaterThanOrEqual(3);
        expect(calls('stop')).toBe(1);
        expect(res.stderr).toContain('not restarting again');
      });

      it('reports a stop that fails, starts no second daemon, and retries next pass', () => {
        const res = supervise(
          { STUB_STATUS: CONVERGENCE(), STUB_STOP_EXIT: '1', PD_HAPPIER_ONCE: '0', PD_HAPPIER_INTERVAL: '0.1' },
          { timeout: 1500 },
        );
        expect(starts()).toBe(0);
        expect(calls('stop')).toBeGreaterThanOrEqual(2);
        expect(res.stderr.match(/could not stop the daemon/g)).toHaveLength(1);
      });

      it('never moves the daemon onto an OLDER CLI', () => {
        // A missing managed launcher leaves the image's older npm copy on PATH.
        const res = supervise({ STUB_STATUS: CONVERGENCE({ daemon: '0.2.17', cli: '0.2.16' }) });
        expect(calls('stop')).toBe(0);
        expect(res.stderr).toContain('which is not newer');
      });

      it.each([
        ['x; rm -rf /', '0.2.17'],
        ['0.2.16', '0.2.18-preview.1'],
        ['1.0.0', '1.0.00'],
        [null, '0.2.17'],
      ])('does not restart when a version is not a plain release (%j -> %j)', (daemon, cli) => {
        const res = supervise({ STUB_STATUS: CONVERGENCE({ daemon, cli, matches: false }) });
        expect(calls('stop')).toBe(0);
        expect(res.stderr).toContain('not newer');
      });
    });

    it('writes nothing to stdout', () => {
      expect(supervise({ STUB_STATUS: STATUS(true, false) }).stdout).toBe('');
    });
  });

  it('waits for a sign-in without calling the CLI at all', () => {
    const res = supervise({ STUB_STATUS: STATUS(true, false) });
    expect(calls('status')).toBe(0);
    expect(starts()).toBe(0);
    expect(res.stderr).toContain('no Happier sign-in yet');
  });

  it('picks up a sign-in that happens while it runs', () => {
    // The first-login case: no restart and no hand-typed daemon start.
    fs.mkdirSync(path.join(home, '.happier/servers/tower'), { recursive: true });
    const child = spawnSync('bash', ['-c', `(sleep 0.3; touch "${path.join(home, '.happier/servers/tower/access.key')}") & exec bash "${SUPERVISOR}"`], {
      env: spawnEnv({
        HOME: home,
        PATH: `${stubBin}:${process.env.PATH}`,
        STUB_LOG: stubLog,
        STUB_STATUS: STATUS(true, false),
        PD_HAPPIER_INTERVAL: '0.1',
      }),
      encoding: 'utf8',
      timeout: 1500,
    });
    expect(child.stderr).toContain('no Happier sign-in yet');
    expect(child.stderr).toContain('daemon started');
    expect(starts()).toBeGreaterThanOrEqual(1);
  });
});

describe('pd-happier-supervise resumes the standing supervisor once per boot', () => {
  // A stand-in for ~/.claude/skills/supervisor/scripts/fleet.py: logs
  // "resume-start <argv>" and "resume-end" around an optional sleep
  // ($STUB_RESUME_SLEEP, or $STUB_RESUME_SLEEP_FIRST for the first run), prints
  // the next of the |-separated $STUB_RESUME_OUTS outcome lines (the last one
  // repeats) and exits $STUB_RESUME_EXIT ($STUB_RESUME_EXIT_FIRST for the first run).
  let script, resumeDir;
  beforeEach(() => {
    signIn();
    script = path.join(tmproot, 'fleet.py');
    resumeDir = path.join(tmproot, 'resume');
    fs.writeFileSync(
      script,
      [
        'import os, sys, time',
        'log = open(os.environ["STUB_LOG"], "a")',
        'log.write("resume-start " + " ".join(sys.argv[1:]) + "\\n"); log.flush()',
        'n = sum(1 for l in open(os.environ["STUB_LOG"]) if l.startswith("resume-start")) - 1',
        'pause = os.environ.get("STUB_RESUME_SLEEP_FIRST") if n == 0 else None',
        'time.sleep(float(pause or os.environ.get("STUB_RESUME_SLEEP", "0")))',
        'outs = os.environ.get("STUB_RESUME_OUTS", \'{"result":"already running","session":"s1"}\').split("|")',
        'print(outs[min(n, len(outs) - 1)], flush=True)',
        'log.write("resume-end\\n"); log.flush()',
        'first = os.environ.get("STUB_RESUME_EXIT_FIRST")',
        'sys.exit(int(first) if first and n == 0 else int(os.environ.get("STUB_RESUME_EXIT", "0")))',
        '',
      ].join('\n'),
    );
  });

  const resumeEnv = (env = {}) => ({
    PD_SUPERVISOR_RESUME_SCRIPT: script,
    PD_SUPERVISOR_RESUME_DIR: resumeDir,
    PD_SUPERVISOR_BOOT_KEY: '1234',
    ...env,
  });
  const resumes = () =>
    fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8').split('\n').filter((l) => l.startsWith('resume-start')) : [];

  it('runs resume-self once the daemon is up, and logs its outcome', () => {
    const res = supervise(resumeEnv({ STUB_STATUS: STATUS(true, true) }));
    expect(resumes()).toEqual(['resume-start resume-self --timeout 600']);
    expect(res.stderr).toContain('pocket-dev: supervisor-resume: {"result":"already running","session":"s1"}');
    expect(res.stdout).toBe('');
  });

  it('runs it right after starting a stopped daemon', () => {
    supervise(resumeEnv({ STUB_STATUS: STATUS(true, false) }));
    expect(starts()).toBe(1);
    expect(resumes()).toHaveLength(1);
  });

  it.each([
    ['signed out', STATUS(false, false), {}],
    ['a daemon that will not start', STATUS(true, false), { STUB_START_EXIT: '1' }],
    ['unreadable status', 'not json', {}],
  ])('does not run it before the daemon is up: %s', (_name, status, extra) => {
    supervise(resumeEnv({ STUB_STATUS: status, ...extra }));
    expect(resumes()).toHaveLength(0);
  });

  it('does not run it before a sign-in', () => {
    fs.rmSync(path.join(home, '.happier'), { recursive: true, force: true });
    supervise(resumeEnv({ STUB_STATUS: STATUS(true, true) }));
    expect(resumes()).toHaveLength(0);
  });

  it('runs it once per boot, not once per pass or per loop', () => {
    const many = { STUB_STATUS: STATUS(true, true), PD_HAPPIER_ONCE: '0', PD_HAPPIER_INTERVAL: '0.1' };
    supervise(resumeEnv(many), { timeout: 1500 });
    expect(calls('status')).toBeGreaterThanOrEqual(3);
    expect(resumes()).toHaveLength(1);
    // A second copy of the loop in the same boot finds the marker.
    const again = supervise(resumeEnv({ STUB_STATUS: STATUS(true, true) }));
    expect(resumes()).toHaveLength(1);
    expect(again.stderr).toContain('already launched this boot');
    // A new boot (docker restart: a new PID 1 start time) runs it again.
    supervise(resumeEnv({ STUB_STATUS: STATUS(true, true), PD_SUPERVISOR_BOOT_KEY: '5678' }));
    expect(resumes()).toHaveLength(2);
  });

  it('does not run it again when the daemon is restarted onto a new CLI', () => {
    supervise(resumeEnv({ STUB_STATUS: STATUS(true, true) }));
    supervise(resumeEnv({ STUB_STATUS: CONVERGENCE() }));
    expect(calls('stop')).toBe(1);
    expect(resumes()).toHaveLength(1);
  });

  it('never holds up the loop while it runs', () => {
    // resume-self can wait 600 s for the relay; passes must keep coming.
    try {
      supervise(
        resumeEnv({
          STUB_STATUS: STATUS(true, true),
          STUB_RESUME_SLEEP: '2',
          PD_HAPPIER_ONCE: '0',
          PD_HAPPIER_INTERVAL: '0.1',
        }),
        { timeout: 1000 },
      );
      const log = fs.readFileSync(stubLog, 'utf8').split('\n');
      const start = log.findIndex((l) => l.startsWith('resume-start'));
      const end = log.indexOf('resume-end');
      expect(start).toBeGreaterThanOrEqual(0);
      const during = log.slice(start, end === -1 ? undefined : end).filter((l) => l === 'status');
      expect(during.length).toBeGreaterThanOrEqual(3);
    } finally {
      // The worker outlives the killed loop and finishes on its own; wait for
      // it, pass or fail, so nothing writes into the fixture after cleanup.
      const deadline = Date.now() + 5000;
      while (!(fs.existsSync(stubLog) && fs.readFileSync(stubLog, 'utf8').includes('resume-end')) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    expect(fs.readFileSync(stubLog, 'utf8')).toContain('resume-end');
  });

  it('waits out another resume-self holding the lock without using up its retries', () => {
    // The hand-started run can hold the lock for its whole 600 s; five skips
    // in a row, more than the three runs a failure gets, then the lock frees.
    const skip = '{"result":"skipped","why":"another resume-self is running"}';
    const t0 = Date.now();
    const res = supervise(
      resumeEnv({
        STUB_STATUS: STATUS(true, true),
        STUB_RESUME_OUTS: [skip, skip, skip, skip, skip, '{"result":"already running","session":"s1"}'].join('|'),
        PD_SUPERVISOR_RESUME_RETRY: '0.1',
      }),
    );
    expect(resumes()).toHaveLength(6);
    expect(res.stderr).not.toContain('gave up');
    expect(res.stderr).not.toContain('retrying in');
    // Spaced, not a tight loop: five 0.1 s waits (spawnSync returns only when
    // the worker, which holds stderr, has finished).
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450);
  });

  it('gives a lock held after a failure its whole window, counted from the first skip', () => {
    // A failed run, then a hand-started run takes the lock; the window must
    // start at that skip, not at the worker's first run. The first run takes
    // 2.2 s against a 2 s window, so a window counted from the worker's start
    // has already closed by the first skip and the skips would use up runs.
    const skip = '{"result":"skipped","why":"another resume-self is running"}';
    const res = supervise(
      resumeEnv({
        STUB_STATUS: STATUS(true, true),
        STUB_RESUME_OUTS: ['{"result":"failed","why":"relay"}', skip, skip, skip, skip, '{"result":"resumed","session":"s1"}'].join('|'),
        STUB_RESUME_EXIT_FIRST: '1',
        STUB_RESUME_SLEEP_FIRST: '2.2',
        PD_SUPERVISOR_RESUME_LOCK_WAIT: '2',
        PD_SUPERVISOR_RESUME_RETRY: '0.1',
      }),
    );
    expect(resumes()).toHaveLength(6);
    expect(res.stderr).toContain('run 1 exited 1; retrying');
    expect(res.stderr).not.toContain('gave up');
  });

  it('treats a home with no supervisor profile as done, not as a failure', () => {
    supervise(
      resumeEnv({
        STUB_STATUS: STATUS(true, true),
        STUB_RESUME_OUTS: '{"result":"skipped","why":"no supervisor profile on this machine"}',
        PD_SUPERVISOR_RESUME_RETRY: '0.1',
      }),
    );
    expect(resumes()).toHaveLength(1);
  });

  it('still resumes when the marker cannot be written', () => {
    fs.writeFileSync(resumeDir, 'a file where the marker directory goes');
    const res = supervise(resumeEnv({ STUB_STATUS: STATUS(true, true) }));
    expect(resumes()).toHaveLength(1);
    expect(res.stderr).toContain('cannot write the marker');
    expect(res.stderr).not.toContain('already launched');
  });

  it('retries a failed run, at most three runs in all', () => {
    const res = supervise(resumeEnv({ STUB_STATUS: STATUS(true, true), STUB_RESUME_EXIT: '1', PD_SUPERVISOR_RESUME_RETRY: '0.1' }));
    expect(resumes()).toHaveLength(3);
    expect(res.stderr).toContain('run 1 exited 1; retrying in 0.1s');
    expect(res.stderr).toContain('gave up after 3 runs');
  });

  it('skips with one log line when the supervisor skill is absent', () => {
    fs.rmSync(script);
    const res = supervise(resumeEnv({ STUB_STATUS: STATUS(true, true), PD_HAPPIER_ONCE: '0', PD_HAPPIER_INTERVAL: '0.1' }), { timeout: 800 });
    expect(res.stderr.match(/no supervisor skill \(.*fleet\.py\); skipped/g)).toHaveLength(1);
    expect(fs.existsSync(resumeDir)).toBe(false);
  });

  it('honours PD_SUPERVISOR_RESUME=0', () => {
    supervise(resumeEnv({ STUB_STATUS: STATUS(true, true), PD_SUPERVISOR_RESUME: '0' }));
    expect(resumes()).toHaveLength(0);
  });

  it('keys the boot on the host boot id and PID 1\'s start time when no key is given', () => {
    // Both halves: a docker restart changes PID 1's start time, a host reboot
    // the boot id, and /tmp outlives both.
    const env = resumeEnv({ STUB_STATUS: STATUS(true, true) });
    delete env.PD_SUPERVISOR_BOOT_KEY;
    supervise(env);
    expect(resumes()).toHaveLength(1);
    const host = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = fs.readFileSync('/proc/1/stat', 'utf8');
    const starttime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    expect(fs.readdirSync(resumeDir)).toEqual([`${host}-${starttime}`]);
  });
});

describe('entrypoint.sh starts the supervisor', () => {
  // The stub supervisor drops a marker instead of looping, so a launch is
  // observable and nothing outlives the test.
  let marker, stubSupervisor;
  beforeEach(() => {
    marker = path.join(tmproot, 'launched');
    stubSupervisor = path.join(tmproot, 'supervise-stub');
    fs.writeFileSync(stubSupervisor, `#!/bin/bash\ntouch "${marker}"\n`);
    fs.chmodSync(stubSupervisor, 0o755);
  });

  function boot(env = {}) {
    const res = spawnSync('bash', [ENTRYPOINT, 'sleep', '0.3'], {
      env: spawnEnv({
        HOME: home,
        PD_SKEL_DIR: skel,
        PD_CACHE_DIR: cache,
        PATH: `${stubBin}:${process.env.PATH}`,
        PD_HAPPIER_SUPERVISOR: stubSupervisor,
        PD_HAPPIER: '1',
        ...env,
      }),
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    return { launched: fs.existsSync(marker), stderr: res.stderr };
  }

  it('launches it whenever the CLI is installed, signed in or not', () => {
    expect(boot().launched).toBe(true);
  });

  it('honours PD_HAPPIER=0', () => {
    expect(boot({ PD_HAPPIER: '0' }).launched).toBe(false);
  });

  it('does not launch it when the CLI is missing', () => {
    fs.rmSync(path.join(stubBin, 'happier'));
    // Drop every PATH dir holding a real happier too. Inside pocket-dev the
    // image's /usr/local/bin/happier is on the inherited PATH, so removing the
    // stub alone left the CLI installed and this case failed there while
    // passing in CI, which has no Happier.
    const realFree = (process.env.PATH || '').split(':')
      .filter((dir) => dir && !fs.existsSync(path.join(dir, 'happier')));
    expect(boot({ PATH: [stubBin, ...realFree].join(':') }).launched).toBe(false);
  });

  it('says nothing when the managed CLI resolves', () => {
    // ~/bin/happier -> ~/.happier/cli/versions/<v>/happier: the expected state.
    const versioned = path.join(home, '.happier/cli/versions/0.2.17');
    fs.mkdirSync(versioned, { recursive: true });
    fs.renameSync(path.join(stubBin, 'happier'), path.join(versioned, 'happier'));
    fs.symlinkSync(path.join(versioned, 'happier'), path.join(stubBin, 'happier'));
    const { stderr, launched } = boot();
    expect(launched).toBe(true);
    expect(stderr).not.toContain('not the Happier-managed install');
  });

  it('warns when a stray copy outside the managed install resolves', () => {
    const { stderr } = boot();
    expect(stderr).toContain(`happier resolves to ${path.join(stubBin, 'happier')}, not the Happier-managed install`);
  });

  it('warns when the image\'s npm fallback is what resolves', () => {
    // That copy shows in the Happier app as "Installed by you" and the app
    // cannot update it. The warning keys on the real path, the shape of the
    // image's /usr/local/bin/happier -> /opt/agent-tools/node_modules/.bin/...
    const npmBin = path.join(tmproot, 'opt/agent-tools/node_modules/.bin');
    fs.mkdirSync(npmBin, { recursive: true });
    fs.renameSync(path.join(stubBin, 'happier'), path.join(npmBin, 'happier'));
    fs.symlinkSync(path.join(npmBin, 'happier'), path.join(stubBin, 'happier'));
    const { stderr } = boot();
    expect(stderr).toContain(`happier resolves to ${path.join(stubBin, 'happier')}, not the Happier-managed install`);
  });
});
