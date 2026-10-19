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
// records itself and exits $STUB_START_EXIT.
function writeStubHappier() {
  fs.mkdirSync(stubBin, { recursive: true });
  fs.writeFileSync(
    path.join(stubBin, 'happier'),
    [
      '#!/bin/bash',
      'case "$*" in',
      '  "daemon status --json") echo status >> "$STUB_LOG"; printf "%s" "$STUB_STATUS"; exit "${STUB_STATUS_EXIT:-0}" ;;',
      '  "daemon start") echo start >> "$STUB_LOG"; exit "${STUB_START_EXIT:-0}" ;;',
      '  *) exit 9 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  fs.chmodSync(path.join(stubBin, 'happier'), 0o755);
}

const STATUS = (authenticated, running) => JSON.stringify({ auth: { authenticated }, daemon: { running } });

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

    it.each(['0', '-5', 'abc', ''])('falls back to 60s for interval %j instead of a tight loop', (interval) => {
      supervise(
        { STUB_STATUS: STATUS(true, true), PD_HAPPIER_ONCE: '0', PD_HAPPIER_INTERVAL: interval },
        { timeout: 1000 },
      );
      expect(calls('status')).toBe(1);
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

  it('warns when a copy outside /usr/local/bin shadows the pinned one', () => {
    // The stub lives in a temp bin dir, which is exactly the shape of a
    // leftover ~/bin/happier.
    const { stderr } = boot();
    expect(stderr).toContain(`happier resolves to ${path.join(stubBin, 'happier')}`);
  });
});
