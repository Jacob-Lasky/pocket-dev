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

function run(env = {}, args = ['true']) {
  return spawnSync('bash', [SCRIPT, ...args], {
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
    for (const rel of ['.bashrc', '.zshrc', '.profile', '.bash_logout', '.local/bin', '.local/share/claude']) {
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
    // (~/.local/bin/bin) rather than replacing it, leaving claude off the path
    // with no error. This is the case that guard exists for.
    fs.mkdirSync(path.join(home, '.local/bin/junk'), { recursive: true });
    run();
    expect(fs.lstatSync(path.join(home, '.local/bin')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(home, '.local/bin/bin'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.local/bin/claude'))).toBe(true);
    // Moved aside, never deleted: it could be somebody's data.
    const aside = fs.readdirSync(path.join(home, '.local')).filter((n) => n.startsWith('bin.pre-image-'));
    expect(aside).toHaveLength(1);
    expect(fs.existsSync(path.join(home, '.local', aside[0], 'junk'))).toBe(true);
  });

  it('is idempotent across repeated boots', () => {
    run(); run(); run();
    expect(fs.lstatSync(path.join(home, '.local')).isSymbolicLink()).toBe(false);
    expect(fs.readlinkSync(path.join(home, '.local/bin'))).toBe(path.join(skel, '.local/bin'));
    expect(fs.existsSync(path.join(home, '.local/bin/claude'))).toBe(true);
    expect(fs.lstatSync(path.join(home, '.config')).isSymbolicLink()).toBe(false);
  });

  describe('~/.local is a real directory that keeps tool data', () => {
    // Before, ~/.local was ONE link into the image skeleton, so every tool's
    // XDG data lived in the container layer and died on recreate. These run
    // the real script; the source-level half is in homeMount.test.js.
    const local = (rel) => path.join(home, '.local', rel);

    it('is a real directory with only the image entries linked', () => {
      fs.mkdirSync(path.join(skel, '.local/state/claude'), { recursive: true });
      run();
      expect(fs.lstatSync(path.join(home, '.local')).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(local('share')).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(local('state')).isSymbolicLink()).toBe(false);
      expect(fs.readlinkSync(local('share/claude'))).toBe(path.join(skel, '.local/share/claude'));
      expect(fs.readlinkSync(local('state/claude'))).toBe(path.join(skel, '.local/state/claude'));
    });

    it('links an image entry it has never been told about', () => {
      // Enumerated from the skeleton, so a new image-owned XDG dir needs no edit.
      fs.mkdirSync(path.join(skel, '.local/share/newtool'), { recursive: true });
      run();
      expect(fs.readlinkSync(local('share/newtool'))).toBe(path.join(skel, '.local/share/newtool'));
    });

    it('keeps tool data and links across a re-seed', () => {
      run();
      fs.mkdirSync(local('share/opencode'), { recursive: true });
      fs.writeFileSync(local('share/opencode/opencode.db'), 'history');
      fs.mkdirSync(local('state/gh'), { recursive: true });
      fs.writeFileSync(local('state/gh/state.yml'), 'x');
      fs.symlinkSync('/coding/deepgram-agents', local('share/deepgram-agents-skills'));
      run();
      expect(fs.readFileSync(local('share/opencode/opencode.db'), 'utf8')).toBe('history');
      expect(fs.readFileSync(local('state/gh/state.yml'), 'utf8')).toBe('x');
      expect(fs.readlinkSync(local('share/deepgram-agents-skills'))).toBe('/coding/deepgram-agents');
    });

    it('keeps persisted data when a newer image starts shipping the same name', () => {
      // A tool's real ~/.local/share/uv must not be deleted because the image
      // grew a .local/share/uv of its own; it moves aside, intact.
      run();
      fs.mkdirSync(local('share/uv/tools'), { recursive: true });
      fs.writeFileSync(local('share/uv/tools/marker'), 'mine');
      fs.mkdirSync(path.join(skel, '.local/share/uv'), { recursive: true });
      const res = run();
      expect(fs.readlinkSync(local('share/uv'))).toBe(path.join(skel, '.local/share/uv'));
      const aside = fs.readdirSync(local('share')).filter((n) => n.startsWith('uv.pre-image-'));
      expect(aside).toHaveLength(1);
      expect(fs.readFileSync(path.join(local('share'), aside[0], 'tools/marker'), 'utf8')).toBe('mine');
      expect(res.stderr).toContain('moved a real ~/.local/share/uv aside');
    });

    it('never touches the skeleton through a symlinked ~/.local/share', () => {
      // With share linked into the skeleton, linking share/claude would resolve
      // onto the skeleton's own claude and move it aside, binary and all.
      fs.mkdirSync(path.join(home, '.local'), { recursive: true });
      fs.symlinkSync(path.join(skel, '.local/share'), local('share'));
      run();
      expect(fs.lstatSync(local('share')).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(path.join(skel, '.local/share/claude/versions/9.9.9'))).toBe(true);
      expect(fs.readdirSync(path.join(skel, '.local/share'))).toEqual(['claude']);
      expect(fs.existsSync(local('bin/claude'))).toBe(true);
    });

    it('handles names that start with two dots', () => {
      fs.mkdirSync(path.join(skel, '.local/share/..imagetool'), { recursive: true });
      fs.mkdirSync(path.join(home, '.local-persist/share/..staged'), { recursive: true });
      fs.writeFileSync(path.join(home, '.local-persist/share/..staged/f'), 'x');
      run();
      expect(fs.readlinkSync(local('share/..imagetool'))).toBe(path.join(skel, '.local/share/..imagetool'));
      expect(fs.readFileSync(local('share/..staged/f'), 'utf8')).toBe('x');
    });

    it('converts the old whole-.local link without touching the skeleton', () => {
      fs.symlinkSync(path.join(skel, '.local'), path.join(home, '.local'));
      run();
      expect(fs.lstatSync(path.join(home, '.local')).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(local('bin/claude'))).toBe(true);
      // rm -f on the link, never rm -rf through it into the image.
      expect(fs.existsSync(path.join(skel, '.local/share/claude/versions/9.9.9'))).toBe(true);
    });

    it('moves staged ~/.local-persist data into place and removes the stage', () => {
      fs.mkdirSync(path.join(home, '.local-persist/share/uv/tools'), { recursive: true });
      fs.writeFileSync(path.join(home, '.local-persist/share/uv/tools/marker'), 'uv');
      fs.symlinkSync('/coding/deepgram-agents', path.join(home, '.local-persist/share/deepgram-agents-skills'));
      fs.mkdirSync(path.join(home, '.local-persist/state/gh'), { recursive: true });
      fs.writeFileSync(path.join(home, '.local-persist/state/gh/state.yml'), 'gh');
      run();
      expect(fs.readFileSync(local('share/uv/tools/marker'), 'utf8')).toBe('uv');
      expect(fs.readlinkSync(local('share/deepgram-agents-skills'))).toBe('/coding/deepgram-agents');
      expect(fs.readFileSync(local('state/gh/state.yml'), 'utf8')).toBe('gh');
      expect(fs.existsSync(path.join(home, '.local-persist'))).toBe(false);
    });

    it('still boots, and keeps the staged data, when a move fails', () => {
      // Under `set -e` a bare failed mv would end the boot; it must warn instead.
      run();
      fs.mkdirSync(path.join(home, '.local-persist/share/opencode'), { recursive: true });
      fs.writeFileSync(path.join(home, '.local-persist/share/opencode/opencode.db'), 'history');
      fs.chmodSync(local('share'), 0o555);
      let res;
      try {
        res = run();
      } finally {
        fs.chmodSync(local('share'), 0o755);
      }
      expect(res.status).toBe(0);
      expect(res.stderr).toContain('could not move');
      // The image link inside the read-only dir cannot be refreshed either; that
      // too must warn rather than end the boot (it once exited 1 here).
      expect(res.stderr).toContain('could not link ~/.local/share/claude');
      expect(fs.readFileSync(path.join(home, '.local-persist/share/opencode/opencode.db'), 'utf8')).toBe('history');
    });

    it('never overwrites existing data or an image link with a staged copy', () => {
      run();
      fs.mkdirSync(local('share/opencode'), { recursive: true });
      fs.writeFileSync(local('share/opencode/opencode.db'), 'current');
      fs.mkdirSync(path.join(home, '.local-persist/share/opencode'), { recursive: true });
      fs.writeFileSync(path.join(home, '.local-persist/share/opencode/opencode.db'), 'stale');
      fs.mkdirSync(path.join(home, '.local-persist/share/claude'), { recursive: true });
      const res = run();
      expect(res.status).toBe(0);
      expect(fs.readFileSync(local('share/opencode/opencode.db'), 'utf8')).toBe('current');
      expect(fs.readFileSync(path.join(home, '.local-persist/share/opencode/opencode.db'), 'utf8')).toBe('stale');
      expect(fs.lstatSync(local('share/claude')).isSymbolicLink()).toBe(true);
      expect(res.stderr).toContain('kept');
    });
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

  it('relocates Codex temporary helpers while preserving credentials and sessions', () => {
    const codex = path.join(home, '.codex');
    fs.mkdirSync(path.join(codex, 'tmp/arg0/stale'), { recursive: true });
    fs.mkdirSync(path.join(codex, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(codex, 'auth.json'), 'saved auth');
    fs.writeFileSync(path.join(codex, 'sessions/saved.jsonl'), 'saved conversation');
    expect(run().status).toBe(0);
    const tmp = path.join(codex, 'tmp');
    expect(fs.lstatSync(tmp).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(tmp)).toBe(path.join(cache, '.codex-tmp'));
    expect(fs.statSync(tmp).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(path.join(tmp, 'arg0/stale'))).toBe(false);
    expect(fs.readFileSync(path.join(codex, 'auth.json'), 'utf8')).toBe('saved auth');
    expect(fs.readFileSync(path.join(codex, 'sessions/saved.jsonl'), 'utf8')).toBe('saved conversation');

    // A recreate keeps the home symlink but discards its container-local target.
    fs.rmSync(cache, { recursive: true });
    expect(run().status).toBe(0);
    expect(fs.realpathSync(tmp)).toBe(path.join(cache, '.codex-tmp'));
    expect(fs.statSync(tmp).mode & 0o777).toBe(0o700);
  });

  it('exports the persistent Codex installer destination to child processes', () => {
    const res = run({}, ['bash', '-c', 'printf %s "$CODEX_INSTALL_DIR"']);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(path.join(home, 'bin'));
  });

  it('passes the persistent launcher directory to the standalone installer', () => {
    const bin = path.join(tmproot, 'stubs');
    const installer = path.join(tmproot, 'installer.sh');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\ncat "$PD_TEST_INSTALLER"\n', { mode: 0o755 });
    fs.writeFileSync(installer, `
test "$CODEX_INSTALL_DIR" = "$HOME/bin" || exit 23
test -L "$HOME/.codex/tmp" || exit 24
mkdir -p "$HOME/.codex/packages/standalone/current/bin"
cat > "$HOME/.codex/packages/standalone/current/bin/codex" <<'CODEX'
#!/bin/sh
printf '%s\\n' "$*" > "$HOME/daemon-args"
CODEX
chmod +x "$HOME/.codex/packages/standalone/current/bin/codex"
ln -s "$HOME/.codex/packages/standalone/current/bin/codex" "$CODEX_INSTALL_DIR/codex"
`);
    const res = run({ PD_CODEX_RC: '1', PD_TEST_INSTALLER: installer, CODEX_INSTALL_DIR: '', PATH: `${bin}:${process.env.PATH}` });
    expect(res.status).toBe(0);
    expect(fs.existsSync(path.join(home, 'bin/codex'))).toBe(true);
    expect(fs.readFileSync(path.join(home, 'daemon-args'), 'utf8')).toBe('remote-control start\n');
  });

  it('reports a failed installer download while still booting the terminal', () => {
    const bin = path.join(tmproot, 'stubs');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nexit 22\n', { mode: 0o755 });
    const res = run({ PD_CODEX_RC: '1', PATH: `${bin}:${process.env.PATH}` });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('standalone codex install failed');
    expect(res.stderr).not.toContain('installed the standalone codex');
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
