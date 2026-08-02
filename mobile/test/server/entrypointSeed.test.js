import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnEnv } from './pdEnv.js';

// entrypoint.sh RUN FOR REAL against a temp HOME and a temp skeleton.
//
// homeMount.test.js greps the source for the properties that only exist as text
// (Dockerfile ordering, template contents). This file covers the part that greps
// cannot: whether seeding actually produces a working home. A test asserting
// `ln -sfn "$src" "$dst"` appears in the file proves the string is there and
// nothing about whether `claude` ends up on PATH.
//
// Same approach as trustWorkspace.test.js: the script is pure filesystem
// manipulation parameterised by $HOME, $PD_SKEL_DIR and $PD_CACHE_DIR, so it
// runs perfectly well outside the image.

const SCRIPT = path.resolve(__dirname, '../../../entrypoint.sh');

let home, skel, cache, tmproot;

// A stand-in for the image's /opt/pd-home, including the ABSOLUTE symlink shape
// the real claude installer produces (bin/claude -> <skel>/.local/share/...).
function buildSkeleton() {
  fs.mkdirSync(path.join(skel, '.local/bin'), { recursive: true });
  fs.mkdirSync(path.join(skel, '.local/share/claude/versions'), { recursive: true });
  fs.mkdirSync(path.join(skel, '.config/fish'), { recursive: true });
  fs.mkdirSync(path.join(skel, '.config/uv'), { recursive: true });
  fs.writeFileSync(path.join(skel, '.local/share/claude/versions/9.9.9'), '#!/bin/sh\necho claude\n');
  fs.symlinkSync(
    path.join(skel, '.local/share/claude/versions/9.9.9'),
    path.join(skel, '.local/bin/claude'),
  );
  for (const rc of ['.bashrc', '.zshrc', '.profile', '.bash_logout']) {
    fs.writeFileSync(path.join(skel, rc), `# ${rc} from the image\n`);
  }
  fs.writeFileSync(path.join(skel, '.config/fish/config.fish'), '# fish\n');
}

function run(env = {}) {
  return spawnSync('bash', [SCRIPT, 'true'], {
    env: spawnEnv({
      HOME: home,
      PD_SKEL_DIR: skel,
      PD_CACHE_DIR: cache,
      ...env,
    }),
    encoding: 'utf8',
  });
}

beforeEach(() => {
  tmproot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-entry-'));
  home = path.join(tmproot, 'home');
  skel = path.join(tmproot, 'skel');
  cache = path.join(tmproot, 'cache');
  fs.mkdirSync(home);
  buildSkeleton();
});

afterEach(() => {
  fs.rmSync(tmproot, { recursive: true, force: true });
});

describe('entrypoint.sh seeding, executed', () => {
  it('exits cleanly and execs its argument', () => {
    const res = run();
    expect(res.status).toBe(0);
  });

  it('makes the image binaries reachable through $HOME', () => {
    // The whole point. If this breaks, the container boots fine and simply has
    // no claude in it.
    run();
    const claude = path.join(home, '.local/bin/claude');
    expect(fs.existsSync(claude)).toBe(true);
    expect(fs.readFileSync(claude, 'utf8')).toContain('echo claude');
  });

  it('links, never copies, the image-owned entries', () => {
    // A copy freezes at first boot and an image update would ship a claude no
    // container runs. Assert these are genuinely symlinks into the skeleton.
    run();
    for (const rel of ['.bashrc', '.zshrc', '.profile', '.bash_logout', '.local']) {
      const p = path.join(home, rel);
      expect(fs.lstatSync(p).isSymbolicLink(), `${rel} must be a symlink`).toBe(true);
      expect(fs.readlinkSync(p)).toBe(path.join(skel, rel));
    }
  });

  it('leaves .config a REAL directory with only the image leaves linked', () => {
    // gh's token lives in .config/gh. If .config itself were linked into the
    // skeleton the token would stop persisting, silently.
    run();
    expect(fs.lstatSync(path.join(home, '.config')).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(home, '.config/fish')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(home, '.config/uv')).isSymbolicLink()).toBe(true);
  });

  it('preserves an existing gh token across a re-seed', () => {
    fs.mkdirSync(path.join(home, '.config/gh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config/gh/hosts.yml'), 'token: abc123\n');
    run();
    expect(fs.readFileSync(path.join(home, '.config/gh/hosts.yml'), 'utf8')).toContain('abc123');
  });

  it('replaces a REAL directory sitting at a link destination', () => {
    // `ln -s target dir` against a real directory creates the link INSIDE it
    // (~/.local/.local) rather than replacing it, leaving claude off the path
    // with no error. This is the case that guard exists for.
    fs.mkdirSync(path.join(home, '.local/junk'), { recursive: true });
    run();
    expect(fs.lstatSync(path.join(home, '.local')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(home, '.local/.local'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.local/bin/claude'))).toBe(true);
  });

  it('is idempotent across repeated boots', () => {
    run(); run(); run();
    expect(fs.readlinkSync(path.join(home, '.local'))).toBe(path.join(skel, '.local'));
    expect(fs.existsSync(path.join(home, '.local/bin/claude'))).toBe(true);
    expect(fs.lstatSync(path.join(home, '.config')).isSymbolicLink()).toBe(false);
  });

  it('keeps caches out of the home and pointed at the cache dir', () => {
    run();
    for (const rel of ['.cache', '.npm']) {
      const p = path.join(home, rel);
      expect(fs.lstatSync(p).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(p)).toBe(path.join(cache, rel));
    }
  });

  it('creates the state dirs the server and dgvpn read', () => {
    run();
    for (const rel of ['.claude', '.pocket-dev', '.dgvpn', 'bin']) {
      expect(fs.statSync(path.join(home, rel)).isDirectory(), `${rel} must exist`).toBe(true);
    }
  });

  it('preserves user state in the home across a re-seed', () => {
    // The credentials this whole design exists to keep: nothing in seeding may
    // touch them.
    fs.mkdirSync(path.join(home, '.aws'), { recursive: true });
    fs.writeFileSync(path.join(home, '.aws/config'), '[profile staging]\n');
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, 'bin/mytool'), '#!/bin/sh\n');
    run();
    expect(fs.readFileSync(path.join(home, '.aws/config'), 'utf8')).toContain('[profile staging]');
    expect(fs.existsSync(path.join(home, 'bin/mytool'))).toBe(true);
  });

  it('leaves no write-test file behind', () => {
    run();
    expect(fs.existsSync(path.join(home, '.pd-write-test'))).toBe(false);
  });

  it('warns loudly, but still boots, when the home is not writable', () => {
    // The documented silent failure: sessionStore disables itself without a word
    // on an unwritable dir, so a root-owned mount looks identical to a working
    // one until the tabs stop coming back. Skipped as root, which can write
    // through any mode bits.
    if (process.getuid && process.getuid() === 0) return;
    fs.chmodSync(home, 0o555);
    try {
      const res = run();
      expect(res.status).toBe(0); // must NOT refuse to boot
      expect(res.stderr).toMatch(/not writable/i);
      expect(res.stderr).toMatch(/99:100/);
    } finally {
      fs.chmodSync(home, 0o755);
    }
  });
});
