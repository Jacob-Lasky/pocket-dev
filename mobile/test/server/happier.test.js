import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
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

  it('keeps the PID sandbox runner executable, as CI invokes it directly', () => {
    // core.fileMode is false on Tower's shfs, so a chmod there never reaches
    // the index; a CI checkout then gets 644 and exit 126.
    expect(fs.statSync(path.join(ROOT, 'mobile/test/pid-sandbox.sh')).mode & 0o111).not.toBe(0);
    // The index check needs a git checkout; pid-sandbox.sh runs this file from a plain copy with no git,
    // where only the file mode above can be checked (CI's normal unit run still checks the index).
    const ls = spawnSync('git', ['ls-files', '-s', 'mobile/test/pid-sandbox.sh'], { cwd: ROOT, encoding: 'utf8' });
    if (ls.error || ls.status !== 0) return;
    expect(ls.stdout).toMatch(/^100755 /);
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
// `daemon start` also logs "start-saw-record" when $STUB_RECORD or its .lock
// still exists at that moment, so a test can tell cleared-before-start from after.
// A leading `--server <id>` (an extra profile) is logged as "<id>:<call>" and
// reads $STUB_STATUS_<id>, $STUB_STATUS_EXIT_<id>, $STUB_START_EXIT_<id> and
// $STUB_STOP_EXIT_<id> instead, so the default daemon's counts never include
// an extra's. Any other argument shape exits 9 and is logged as "bad-args".
// $STUB_STATUS_FILE (or $STUB_STATUS_FILE_<id>), when set, names a file whose
// CURRENT contents are the status, so a test can change it while the loop runs.
function writeStubHappier() {
  fs.mkdirSync(stubBin, { recursive: true });
  fs.writeFileSync(
    path.join(stubBin, 'happier'),
    [
      '#!/bin/bash',
      'p="" s=""',
      'if [ "${1:-}" = "--server" ] && [ $# -ge 2 ]; then p="$2:"; s="_$2"; shift 2; fi',
      'v() { local n="$1$s" f="$1_FILE$s"; if [ -n "${!f-}" ]; then cat -- "${!f}"; else printf "%s" "${!n-}"; fi; }',
      'case "$*" in',
      '  "daemon status --json") echo "${p}status" >> "$STUB_LOG"; v STUB_STATUS; e=$(v STUB_STATUS_EXIT); exit "${e:-0}" ;;',
      '  "daemon start") echo "${p}start" >> "$STUB_LOG"; [ -z "$p" ] && [ -n "${STUB_RECORD:-}" ] && { [ -e "$STUB_RECORD" ] || [ -e "$STUB_RECORD.lock" ]; } && echo start-saw-record >> "$STUB_LOG"; e=$(v STUB_START_EXIT); exit "${e:-0}" ;;',
      '  "daemon stop") echo "${p}stop" >> "$STUB_LOG"; e=$(v STUB_STOP_EXIT); exit "${e:-0}" ;;',
      '  *) echo bad-args >> "$STUB_LOG"; exit 9 ;;',
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
      // Pinned, not just defaulted from HOME: the script reads it first, and the
      // real ~/.happier must be unreachable from every test (pdEnv.js scrubs it too).
      HAPPIER_HOME_DIR: path.join(home, '.happier'),
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

// A status answer that names the profile it is about, as 0.2.20 does
// (server.activeServerId; with `--server <id>` it is that id).
const PSTATUS = (id, authenticated, running, extra = {}) =>
  JSON.stringify({ server: { activeServerId: id }, auth: { authenticated }, daemon: { running }, ...extra });

describe('pd-happier-supervise keeps extra server profiles alive', () => {
  // A daemon serves one server profile, and plain `happier daemon ...` acts on
  // the active one. PD_HAPPIER_EXTRA_SERVERS names further profiles (Tower's
  // `hypervisor` relay, #114) whose daemons the loop runs through
  // `happier --server <id> daemon ...`, with the default daemon's rules and
  // without ever touching the default daemon. The stub logs an extra's calls
  // as "<id>:<call>", so calls('start') below counts the DEFAULT daemon only.
  const HV = 'hypervisor';
  const signInExtra = (id = HV) => {
    fs.mkdirSync(path.join(home, `.happier/servers/${id}`), { recursive: true });
    fs.writeFileSync(path.join(home, `.happier/servers/${id}/access.key`), 'x');
  };
  const extra = (env = {}, opts = {}) =>
    supervise({ PD_HAPPIER_EXTRA_SERVERS: HV, STUB_STATUS: PSTATUS('tower', true, true), ...env }, opts);
  const log = () => (fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean) : []);
  const looping = { PD_HAPPIER_ONCE: '0', PD_HAPPIER_INTERVAL: '0.1' };

  beforeEach(() => {
    signIn();
    signInExtra();
  });

  it('starts a stopped extra daemon through --server, and leaves the default daemon alone', () => {
    const res = extra({ STUB_STATUS_hypervisor: PSTATUS(HV, true, false) });
    expect(calls(`${HV}:start`)).toBe(1);
    expect(starts()).toBe(0);
    expect(calls('stop')).toBe(0);
    expect(calls('bad-args')).toBe(0);
    expect(res.stderr).toContain(`happier: daemon running`);
    expect(res.stderr).toContain(`happier [${HV}]: daemon started`);
  });

  it('checks the default daemon first and does not start it on the extra\'s account', () => {
    // A stopped default daemon is still started, once, by the plain CLI.
    const res = extra({ STUB_STATUS: PSTATUS('tower', true, false), STUB_STATUS_hypervisor: PSTATUS(HV, true, true) });
    expect(log()).toEqual(['status', 'start', `${HV}:status`]);
    expect(res.stderr).toContain(`happier [${HV}]: daemon running`);
  });

  it('leaves a running extra daemon alone', () => {
    extra({ STUB_STATUS_hypervisor: PSTATUS(HV, true, true) });
    expect(calls(`${HV}:start`)).toBe(0);
    expect(calls(`${HV}:stop`)).toBe(0);
  });

  it('logs each profile\'s steady state once, even when both are in the same state', () => {
    // One "last state" shared by every profile would print the default's line
    // and swallow the extra's (same key), or alternate them on every pass.
    const res = extra({ STUB_STATUS_hypervisor: PSTATUS(HV, true, true), ...looping }, { timeout: 1500 });
    expect(calls(`${HV}:status`)).toBeGreaterThanOrEqual(3);
    expect(res.stderr.match(/happier: daemon running/g)).toHaveLength(1);
    expect(res.stderr.match(/happier \[hypervisor\]: daemon running/g)).toHaveLength(1);
  });

  it.each([
    ['unreadable status', { STUB_STATUS_hypervisor: 'not json' }],
    ['a failed status call', { STUB_STATUS_hypervisor: PSTATUS(HV, true, false), STUB_STATUS_EXIT_hypervisor: '1' }],
    ['JSON without the booleans', { STUB_STATUS_hypervisor: JSON.stringify({ server: { activeServerId: HV } }) }],
    // --server not taking (an answer about the active profile, or none named)
    // would make the "stopped" daemon the default one.
    ['an answer about another profile', { STUB_STATUS_hypervisor: PSTATUS('tower', true, false) }],
    ['an answer naming no profile', { STUB_STATUS_hypervisor: STATUS(true, false) }],
  ])('never starts an extra on %s', (_, env) => {
    const res = extra(env);
    expect(calls(`${HV}:start`)).toBe(0);
    expect(calls(`${HV}:stop`)).toBe(0);
    expect(res.stderr).toContain(`happier [${HV}]: could not read daemon status`);
  });

  it('says once that an extra with no sign-in is not signed in, and never calls the CLI for it', () => {
    fs.rmSync(path.join(home, `.happier/servers/${HV}`), { recursive: true });
    const res = extra({ STUB_STATUS_hypervisor: PSTATUS(HV, true, false), ...looping }, { timeout: 1500 });
    expect(calls('status')).toBeGreaterThanOrEqual(3);
    expect(log().filter((l) => l.startsWith(`${HV}:`))).toEqual([]);
    expect(res.stderr.match(/not signed in to server profile hypervisor/g)).toHaveLength(1);
  });

  it('says once that an extra its status calls signed out is not signed in, and never starts it', () => {
    const res = extra({ STUB_STATUS_hypervisor: PSTATUS(HV, false, false), ...looping }, { timeout: 1500 });
    expect(calls(`${HV}:status`)).toBeGreaterThanOrEqual(3);
    expect(calls(`${HV}:start`)).toBe(0);
    expect(res.stderr.match(/not signed in to server profile hypervisor/g)).toHaveLength(1);
  });

  it('reports an extra whose start fails, and retries it next pass', () => {
    const res = extra(
      { STUB_STATUS_hypervisor: PSTATUS(HV, true, false), STUB_START_EXIT_hypervisor: '1', ...looping },
      { timeout: 1500 },
    );
    expect(calls(`${HV}:start`)).toBeGreaterThanOrEqual(2);
    expect(res.stderr.match(/happier \[hypervisor\]: daemon is not running and did not start/g)).toHaveLength(1);
  });

  describe('moving an extra daemon onto a new CLI', () => {
    const CONV = (id, o) => JSON.stringify({ ...JSON.parse(CONVERGENCE(o)), server: { activeServerId: id } });

    it('stops and starts only that profile\'s daemon', () => {
      const res = extra({ STUB_STATUS_hypervisor: CONV(HV) });
      expect(calls(`${HV}:stop`)).toBe(1);
      expect(calls(`${HV}:start`)).toBe(1);
      expect(calls('stop')).toBe(0);
      expect(starts()).toBe(0);
      expect(res.stderr).toContain(`happier [${HV}]: daemon restarted onto CLI 0.2.17 (was 0.2.16)`);
    });

    it('keeps the once-per-pair rule per profile', () => {
      // Both daemons on the same old CLI: each is restarted once, and one
      // profile's completed restart does not stop the other's.
      const res = extra(
        { STUB_STATUS: CONV('tower'), STUB_STATUS_hypervisor: CONV(HV), ...looping },
        { timeout: 1500 },
      );
      expect(calls('stop')).toBe(1);
      expect(calls(`${HV}:stop`)).toBe(1);
      expect(res.stderr.match(/not restarting again/g)).toHaveLength(2);
    });

    it('never moves an extra onto an older CLI', () => {
      extra({ STUB_STATUS_hypervisor: CONV(HV, { daemon: '0.2.17', cli: '0.2.16' }) });
      expect(calls(`${HV}:stop`)).toBe(0);
    });
  });

  it('skips an extra that is the active profile: that daemon is the default one', () => {
    const res = extra({ STUB_STATUS: PSTATUS(HV, true, true), STUB_STATUS_hypervisor: PSTATUS(HV, true, false) });
    expect(log()).toEqual(['status']);
    expect(res.stderr).toContain('profile hypervisor is the active profile');
  });

  it.each([
    ['unreadable', 'not json'],
    ['naming no profile', STATUS(true, true)],
  ])('leaves every extra alone on a pass where the default status is %s', (_, status) => {
    // Without the active profile, "is this extra the default daemon" cannot be
    // answered, so nothing is done to it.
    const res = extra({ STUB_STATUS: status, STUB_STATUS_hypervisor: PSTATUS(HV, true, false) });
    expect(log()).toEqual(['status']);
    expect(res.stderr).toContain('could not tell which profile is active');
  });

  it('forgets the active profile between passes, so a stale one never vouches for an extra', () => {
    // Pass 1 learns the active profile (tower). Later passes cannot read the
    // default status, and only after that does the extra look stopped: had
    // pass 1's answer been kept, the extra would be started on a pass that
    // could not check it is not the default daemon.
    const def = path.join(tmproot, 'status-default');
    const hv = path.join(tmproot, 'status-hv');
    fs.writeFileSync(def, PSTATUS('tower', true, true));
    fs.writeFileSync(hv, PSTATUS(HV, true, true));
    const res = spawnSync(
      'bash',
      ['-c', `(sleep 0.4; printf 'not json' > "${def}"; sleep 0.6; printf '%s' '${PSTATUS(HV, true, false)}' > "${hv}") & exec bash "${SUPERVISOR}"`],
      {
        env: spawnEnv({
          HOME: home,
          HAPPIER_HOME_DIR: path.join(home, '.happier'),
          PATH: `${stubBin}:${process.env.PATH}`,
          STUB_LOG: stubLog,
          STUB_STATUS_FILE: def,
          STUB_STATUS_FILE_hypervisor: hv,
          PD_HAPPIER_EXTRA_SERVERS: HV,
          PD_HAPPIER_INTERVAL: '0.1',
        }),
        encoding: 'utf8',
        timeout: 2500,
      },
    );
    expect(calls(`${HV}:status`)).toBeGreaterThanOrEqual(1);
    expect(res.stderr).toContain('could not tell which profile is active');
    expect(calls(`${HV}:start`)).toBe(0);
  });

  it('still supervises an extra when the default profile is signed out', () => {
    extra({ STUB_STATUS: PSTATUS('tower', false, false), STUB_STATUS_hypervisor: PSTATUS(HV, true, false) });
    expect(starts()).toBe(0);
    expect(calls(`${HV}:start`)).toBe(1);
  });

  it('ignores an entry that is not a plain profile id, once, and never passes it on', () => {
    // A glob, an option, a path and a dot each must reach neither the CLI nor
    // a path under servers/. The glob would expand against the cwd if the list
    // were split by an unquoted expansion.
    fs.writeFileSync(path.join(tmproot, 'hypervisor'), '');
    const res = extra(
      { PD_HAPPIER_EXTRA_SERVERS: '* -x ../tower .. hyper/visor', STUB_STATUS_hypervisor: PSTATUS(HV, true, false), ...looping },
      { timeout: 1500, cwd: tmproot },
    );
    expect(log().filter((l) => l.includes(':'))).toEqual([]);
    expect(calls('bad-args')).toBe(0);
    for (const bad of ['*', '-x', '../tower', '..', 'hyper/visor']) {
      expect(res.stderr.split('\n').filter((l) => l.includes(`entry '${bad}'`))).toHaveLength(1);
    }
  });

  it('supervises a repeated id once, and several ids each', () => {
    signInExtra('second');
    extra({
      PD_HAPPIER_EXTRA_SERVERS: ` ${HV}\t${HV}\n second `,
      STUB_STATUS_hypervisor: PSTATUS(HV, true, true),
      STUB_STATUS_second: PSTATUS('second', true, false),
    });
    expect(log()).toEqual(['status', `${HV}:status`, 'second:status', 'second:start']);
  });

  it('clears a previous container\'s record in that profile only, and none in the default one', () => {
    const BOOT = 1_800_000_000;
    const plantIn = (id) => {
      const rec = path.join(home, `.happier/servers/${id}/daemon.state.json`);
      fs.writeFileSync(rec, JSON.stringify({ pid: NO_SUCH_PID }));
      fs.writeFileSync(`${rec}.lock`, String(NO_SUCH_PID));
      for (const f of [rec, `${rec}.lock`]) fs.utimesSync(f, BOOT - 60, BOOT - 60);
      return rec;
    };
    const towerRec = plantIn('tower');
    const hvRec = plantIn(HV);
    const res = extra({ STUB_STATUS_hypervisor: PSTATUS(HV, true, false), PD_HAPPIER_BOOT_EPOCH: String(BOOT) });
    expect(fs.existsSync(hvRec)).toBe(false);
    expect(fs.existsSync(`${hvRec}.lock`)).toBe(false);
    expect(fs.existsSync(towerRec)).toBe(true);
    expect(fs.existsSync(`${towerRec}.lock`)).toBe(true);
    expect(calls(`${HV}:start`)).toBe(1);
    expect(res.stderr).toContain(`cleared a daemon record from a previous container (${hvRec}`);
  });

  it('changes nothing when the variable is unset or blank', () => {
    for (const v of [undefined, '', '  \t ']) {
      fs.rmSync(stubLog, { force: true });
      const env = { STUB_STATUS: PSTATUS('tower', true, true), STUB_STATUS_hypervisor: PSTATUS(HV, true, false) };
      if (v !== undefined) env.PD_HAPPIER_EXTRA_SERVERS = v;
      supervise(env);
      expect(log()).toEqual(['status']);
    }
  });
});

// A record's PID, for every test that needs no real process behind it: above
// the kernel's PID_MAX_LIMIT (4194304), so no process can ever hold it, and a
// defect that signals a recorded PID cannot reach anything. DO NOT plant a real
// PID (1, a spawned child's, any live one) outside the PID sandbox below: on
// 2026-11-03 a `kill $pids` mutant plus a {"pid":1} stub record SIGTERMed
// tini and killed the live pocket-dev twice.
const NO_SUCH_PID = 4194305;

// The tests that need a LIVE process at the recorded PID run only inside a
// throwaway container started by test/pid-sandbox.sh: its PID 1 carries the
// argument "pd-pid-sandbox", which neither pocket-dev's docker-init nor a CI
// VM's systemd has, so a stray PD_PID_SANDBOX=1 is not enough on its own.
const PID_SANDBOX = (() => {
  if (process.env.PD_PID_SANDBOX !== '1') return false;
  try {
    return fs.readFileSync('/proc/1/cmdline', 'utf8').split('\0').includes('pd-pid-sandbox');
  } catch {
    return false;
  }
})();

describe('pd-happier-supervise clears a daemon record a previous container left', () => {
  // ~/.happier outlives a recreate but the PID namespace does not, so the
  // record's PID can belong to an UNRELATED live process here. Happier 0.2.17
  // then reports the daemon not running, yet `happier daemon start` dies with
  // DaemonStopIncompleteError (process_identity_unverified) and waits out its
  // 60 s budget before saying so: 2 minutes to the supervisor on 2026-11-03.
  // The loop removes such a record before the start, and nothing else.
  const BOOT = 1_800_000_000; // PD_HAPPIER_BOOT_EPOCH: when this container started
  let dir;
  beforeEach(() => {
    signIn();
    dir = path.join(home, '.happier/servers/tower');
  });

  // A daemon record (state file, its .lock, or one of them) last written at
  // `mtime` (epoch seconds), naming `pid`.
  function plant({ name = 'daemon.state.json', pid = NO_SUCH_PID, mtime = BOOT - 60, state = true, lock = true } = {}) {
    const rec = path.join(dir, name);
    if (state) {
      fs.writeFileSync(rec, JSON.stringify({ pid, httpPort: 9, startedAt: (mtime - 3600) * 1000, controlToken: 't' }));
      fs.utimesSync(rec, mtime, mtime);
    }
    if (lock) {
      fs.writeFileSync(`${rec}.lock`, String(pid));
      fs.utimesSync(`${rec}.lock`, mtime, mtime);
    }
    return rec;
  }
  const run = (env = {}, opts = {}) =>
    supervise(
      {
        STUB_STATUS: STATUS(true, false),
        PD_HAPPIER_BOOT_EPOCH: String(BOOT),
        STUB_RECORD: path.join(dir, 'daemon.state.json'),
        ...env,
      },
      opts,
    );
  const exists = (p) => fs.existsSync(p);
  const leftovers = () => fs.readdirSync(dir).filter((f) => f.includes('pd-stale'));

  it('removes a record older than this container before starting', () => {
    const rec = plant();
    const res = run();
    expect(exists(rec)).toBe(false);
    expect(exists(`${rec}.lock`)).toBe(false);
    expect(starts()).toBe(1);
    expect(calls('start-saw-record')).toBe(0);
    expect(res.stderr).toContain(`cleared a daemon record from a previous container (${rec}, PID ${NO_SUCH_PID})`);
    expect(res.stderr).toContain('daemon started');
    expect(leftovers()).toEqual([]);
  });

  it('removes a stale lock with no state file', () => {
    // Happier fails the same way on a bare lock whose PID is taken.
    const rec = plant({ state: false });
    run();
    expect(exists(`${rec}.lock`)).toBe(false);
    expect(starts()).toBe(1);
  });

  it('removes a stale state file with no lock', () => {
    const rec = plant({ lock: false });
    run();
    expect(exists(rec)).toBe(false);
  });

  it('removes the release-ring records too, in every server profile', () => {
    // daemon.preview.state.json and daemon.dev.state.json are Happier's
    // legacy per-ring names.
    const preview = plant({ name: 'daemon.preview.state.json' });
    const dev = plant({ name: 'daemon.dev.state.json' });
    const other = path.join(home, '.happier/servers/cloud');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'daemon.state.json.lock'), String(NO_SUCH_PID));
    fs.utimesSync(path.join(other, 'daemon.state.json.lock'), BOOT - 60, BOOT - 60);
    run();
    for (const rec of [preview, dev]) {
      expect(exists(rec)).toBe(false);
      expect(exists(`${rec}.lock`)).toBe(false);
    }
    expect(exists(path.join(other, 'daemon.state.json.lock'))).toBe(false);
  });

  it.each([
    ['written after this container started', BOOT + 30],
    ['written in the second it started', BOOT],
    ['written within the 2 s clock margin', BOOT - 2],
  ])('keeps a record %s', (_name, mtime) => {
    const rec = plant({ mtime });
    const res = run();
    expect(exists(rec)).toBe(true);
    expect(exists(`${rec}.lock`)).toBe(true);
    expect(starts()).toBe(1);
    expect(res.stderr).not.toContain('cleared a daemon record');
  });

  it('keeps the whole record when either half was written in this boot', () => {
    const rec = plant();
    fs.utimesSync(`${rec}.lock`, BOOT + 5, BOOT + 5);
    run();
    expect(exists(rec)).toBe(true);
    expect(exists(`${rec}.lock`)).toBe(true);
  });

  it('keeps a stale state file it cannot parse, and leaves it to Happier', () => {
    const rec = plant({ lock: false });
    fs.writeFileSync(rec, '{not json');
    fs.utimesSync(rec, BOOT - 60, BOOT - 60);
    run();
    expect(exists(rec)).toBe(true);
  });

  // A stub `node` (what reads the state file's PID) that replaces the state
  // file the way a concurrent start would (by rename: a new inode), landing
  // exactly between the check and the removal.
  const replacement = JSON.stringify({ pid: NO_SUCH_PID, replaced: true });
  function racingNode(rec) {
    const bin = path.join(tmproot, 'racebin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'node'),
      `#!/bin/bash\nfor a in "$@"; do [ "$a" = "${rec}" ] && { printf '%s' '${replacement}' > "${rec}.new"; mv -f "${rec}.new" "${rec}"; }; done\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 },
    );
    return bin;
  }

  it('puts back a file that changed under it, and leaves the record whole', () => {
    const rec = plant();
    const res = run({ PATH: `${racingNode(rec)}:${stubBin}:${process.env.PATH}` });
    expect(fs.readFileSync(rec, 'utf8')).toBe(replacement);
    // Never split: the lock of a record whose state changed stays too.
    expect(exists(`${rec}.lock`)).toBe(true);
    expect(res.stderr).toContain(`could not clear the daemon record ${rec}`);
    expect(res.stderr).not.toContain('cleared a daemon record from');
    expect(leftovers()).toEqual([]);
  });

  it('never overwrites a changed file when its name was taken again meanwhile', () => {
    // A second writer takes the name while the changed file is set aside:
    // the stub `stat`, called on the aside copy, writes a new file at the
    // original name first. Both survive; the aside copy is reported.
    const rec = plant({ lock: false });
    const bin = racingNode(rec);
    fs.writeFileSync(
      path.join(bin, 'stat'),
      `#!/bin/bash\ncase "$*" in *pd-stale.*) printf second > "${rec}" ;; esac\nexec /usr/bin/stat "$@"\n`,
      { mode: 0o755 },
    );
    const res = run({ PATH: `${bin}:${stubBin}:${process.env.PATH}` });
    expect(fs.readFileSync(rec, 'utf8')).toBe('second');
    const aside = leftovers();
    expect(aside).toHaveLength(1);
    // A fresh unique name, not one derived from the loop's PID, which a
    // previous container's leftover could already hold and `mv -f` would clobber.
    expect(aside[0]).not.toBe(`daemon.state.json.pd-stale.${res.pid}`);
    expect(aside[0]).toMatch(/^daemon\.state\.json\.pd-stale\.[A-Za-z0-9]{6}$/);
    expect(fs.readFileSync(path.join(dir, aside[0]), 'utf8')).toBe(replacement);
    expect(res.stderr).toContain(`left a changed daemon file at ${path.join(dir, aside[0])}`);
  });

  it.skipIf(process.getuid() === 0)('keeps a stale lock it cannot read', () => {
    // It could name a live daemon; unreadable is not "no PID".
    const rec = plant({ state: false });
    fs.chmodSync(`${rec}.lock`, 0o000);
    run();
    expect(exists(`${rec}.lock`)).toBe(true);
  });

  it('touches nothing else in the profile', () => {
    plant();
    const keep = ['access.key', 'connected-service-broker.state.json', 'daemon.state.json.tmp', 'daemon-notes.state.json', 'daemon.other.state.json'];
    for (const f of keep.slice(1)) {
      fs.writeFileSync(path.join(dir, f), '{}');
      fs.utimesSync(path.join(dir, f), BOOT - 60, BOOT - 60);
    }
    run();
    for (const f of keep) expect(exists(path.join(dir, f))).toBe(true);
  });

  it('skips a profile directory that is a symlink', () => {
    const elsewhere = path.join(tmproot, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(home, '.happier/servers/linked'));
    fs.writeFileSync(path.join(elsewhere, 'daemon.state.json.lock'), String(NO_SUCH_PID));
    fs.utimesSync(path.join(elsewhere, 'daemon.state.json.lock'), BOOT - 60, BOOT - 60);
    run();
    expect(exists(path.join(elsewhere, 'daemon.state.json.lock'))).toBe(true);
  });

  it('handles a Happier home whose path starts with a dash', () => {
    // A relative HAPPIER_HOME_DIR like "-h" must not reach node as an option.
    const dash = path.join(tmproot, '-h/servers/tower');
    fs.mkdirSync(dash, { recursive: true });
    fs.writeFileSync(path.join(dash, 'access.key'), 'x');
    fs.writeFileSync(path.join(dash, 'daemon.state.json'), JSON.stringify({ pid: NO_SUCH_PID }));
    fs.utimesSync(path.join(dash, 'daemon.state.json'), BOOT - 60, BOOT - 60);
    const res = run({ HAPPIER_HOME_DIR: '-h' }, { cwd: tmproot });
    expect(exists(path.join(dash, 'daemon.state.json'))).toBe(false);
    expect(res.stderr).toContain(`PID ${NO_SUCH_PID}`);
  });

  it('touches nothing while the daemon runs', () => {
    const rec = plant();
    run({ STUB_STATUS: STATUS(true, true) });
    expect(exists(rec)).toBe(true);
    expect(exists(`${rec}.lock`)).toBe(true);
  });

  it('touches nothing when status cannot be read', () => {
    const rec = plant();
    run({ STUB_STATUS: 'not json' });
    expect(exists(rec)).toBe(true);
    expect(exists(`${rec}.lock`)).toBe(true);
  });

  it.each(['', 'abc', '-5', '1e9'])('touches nothing, and still starts, when the boot time is unreadable (%j)', (epoch) => {
    const rec = plant();
    run({ PD_HAPPIER_BOOT_EPOCH: epoch });
    expect(exists(rec)).toBe(true);
    expect(starts()).toBe(1);
  });

  it('reads a zero-padded epoch as decimal, not octal', () => {
    // Bash arithmetic would read "08..." as a bad octal number and die.
    const rec = plant();
    const res = run({ PD_HAPPIER_BOOT_EPOCH: `0${BOOT}` });
    expect(res.status).toBe(0);
    expect(exists(rec)).toBe(false);
  });

  it('reads the real boot time from /proc, on both sides of the boundary', () => {
    // Oracle: procps' own reading of PID 1's start (`ps -o lstart`), not the
    // script's arithmetic. Clear 4 s before it, keep 1 s before it (inside
    // the 2 s margin, with 1 s for the oracle's own rounding).
    const lstart = spawnSync('ps', ['-o', 'lstart=', '-p', '1'], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).stdout.trim();
    const start = Math.floor(Date.parse(`${lstart} UTC`) / 1000);
    expect(Number.isFinite(start)).toBe(true);
    const old = plant({ name: 'daemon.state.json', mtime: start - 4 });
    const fresh = plant({ name: 'daemon.preview.state.json', mtime: start - 1 });
    supervise({ STUB_STATUS: STATUS(true, false) });
    expect(exists(old)).toBe(false);
    expect(exists(fresh)).toBe(true);
  });

  // Live processes at the recorded PID. PID sandbox ONLY (see PID_SANDBOX):
  // run them with `test/pid-sandbox.sh`. Belt and braces inside it too: bash's
  // builtin `kill` is disabled through BASH_ENV and a PATH `kill` only logs,
  // so the script under test cannot signal anything even there.
  if (process.env.PD_PID_SANDBOX === '1' && !PID_SANDBOX) {
    // Asked for the sandbox but PID 1 is not its sentinel: fail loudly rather
    // than skip, so a broken runner cannot pass by running nothing.
    it('runs the PID sandbox tests (PID sandbox)', () => {
      throw new Error('PD_PID_SANDBOX=1 but /proc/1/cmdline lacks "pd-pid-sandbox"; use test/pid-sandbox.sh');
    });
  }
  describe.skipIf(!PID_SANDBOX)('with a live process at the recorded PID (PID sandbox)', () => {
    let guardBin, bashEnv;
    beforeEach(() => {
      guardBin = path.join(tmproot, 'killguard');
      fs.mkdirSync(guardBin);
      fs.writeFileSync(path.join(guardBin, 'kill'), '#!/bin/sh\necho "kill $*" >> "$STUB_LOG"\nexit 0\n', { mode: 0o755 });
      bashEnv = path.join(tmproot, 'bash_env');
      fs.writeFileSync(bashEnv, 'enable -n kill\n');
    });
    const guarded = (env = {}) => run({ PATH: `${guardBin}:${stubBin}:${process.env.PATH}`, BASH_ENV: bashEnv, ...env });
    const killsAttempted = () =>
      fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8').split('\n').filter((l) => l.startsWith('kill')) : [];
    // Running or sleeping, read from /proc (not dead, a zombie or stopped):
    // a child's exitCode cannot change while spawnSync holds the event loop,
    // so it proves nothing here.
    const alive = (pid) => {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        return !'ZXxTt'.includes(stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3));
      } catch {
        return false;
      }
    };
    // Polls /proc/<pid>/cmdline until test(cmdline) holds; returns it.
    const cmdlineOf = (pid, test) => {
      let cmd = '';
      for (let i = 0; i < 100; i++) {
        cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (test(cmd)) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      return cmd;
    };

    it('removes the record of an unrelated live process, and never signals it', () => {
      const victim = spawn('sleep', ['30'], { stdio: 'ignore' });
      try {
        const rec = plant({ pid: victim.pid });
        const res = guarded();
        expect(exists(rec)).toBe(false);
        expect(res.stderr).toContain(`PID ${victim.pid}`);
        expect(killsAttempted()).toEqual([]);
        expect(alive(victim.pid)).toBe(true);
      } finally {
        victim.kill();
      }
    });

    it('keeps an old record whose PID is a live Happier daemon here', () => {
      // Cannot happen with a sane clock (that daemon would have rewritten it),
      // so it is the belt to the mtime braces: never orphan a live daemon. The
      // stand-in has the real one's argument shape: <dir>/happier daemon start-sync.
      const daemon = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '/opt/x/happier', 'daemon', 'start-sync'], { stdio: 'ignore' });
      try {
        expect(cmdlineOf(daemon.pid, (c) => c.endsWith('\0/opt/x/happier\0daemon\0start-sync\0'))).toMatch(/\0\/opt\/x\/happier\0daemon\0start-sync\0$/);
        const rec = plant({ pid: daemon.pid });
        const res = guarded();
        expect(exists(rec)).toBe(true);
        expect(exists(`${rec}.lock`)).toBe(true);
        expect(res.stderr).not.toContain('cleared a daemon record');
        expect(killsAttempted()).toEqual([]);
        expect(alive(daemon.pid)).toBe(true);
      } finally {
        daemon.kill();
      }
    });

    it('does not mistake a non-Happier process with "daemon start-sync" arguments for a daemon', () => {
      const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'daemon', 'start-sync'], { stdio: 'ignore' });
      try {
        expect(cmdlineOf(other.pid, (c) => c.endsWith('\0daemon\0start-sync\0'))).toMatch(/\0daemon\0start-sync\0$/);
        const rec = plant({ pid: other.pid });
        guarded();
        expect(exists(rec)).toBe(false);
        expect(killsAttempted()).toEqual([]);
        expect(alive(other.pid)).toBe(true);
      } finally {
        other.kill();
      }
    });

    it('does not mistake a process that only has those words in one argument for a daemon', () => {
      // Happier's classifier would not take it for one either, so the record
      // would still break the start.
      const spoof = spawn('bash', ['-c', 'exec -a "happier daemon start-sync" sleep 30'], { stdio: 'ignore' });
      try {
        expect(cmdlineOf(spoof.pid, (c) => c.startsWith('happier daemon start-sync\0'))).toMatch(/^happier daemon start-sync\0/);
        const rec = plant({ pid: spoof.pid });
        guarded();
        expect(exists(rec)).toBe(false);
        expect(killsAttempted()).toEqual([]);
        expect(alive(spoof.pid)).toBe(true);
      } finally {
        spoof.kill();
      }
    });
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
    ['running', PSTATUS('hypervisor', true, true)],
    ['just started', PSTATUS('hypervisor', true, false)],
  ])('does not run it for an extra profile\'s daemon (%s) while the default one is down', (_name, extraStatus) => {
    // The supervisor is a session on the active profile's relay; an extra
    // daemon coming up says nothing about that one.
    fs.mkdirSync(path.join(home, '.happier/servers/hypervisor'), { recursive: true });
    fs.writeFileSync(path.join(home, '.happier/servers/hypervisor/access.key'), 'x');
    supervise(
      resumeEnv({
        PD_HAPPIER_EXTRA_SERVERS: 'hypervisor',
        STUB_STATUS: PSTATUS('tower', false, false),
        STUB_STATUS_hypervisor: extraStatus,
      }),
    );
    expect(calls('hypervisor:status')).toBe(1);
    expect(resumes()).toHaveLength(0);
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
