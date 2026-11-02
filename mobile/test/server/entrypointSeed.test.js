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
// The skeleton's claude is the image's FALLBACK: the home owns its own native
// install, so this one is never linked into ~/.local (PD_HOME_OWNED). Its stub
// `install` does what Claude's native installer does, into $HOME, so the
// bootstrap can be executed for real.
function buildSkeleton() {
  fs.mkdirSync(path.join(skel, '.local/bin'), { recursive: true });
  fs.mkdirSync(path.join(skel, '.local/share/claude/versions'), { recursive: true });
  fs.mkdirSync(path.join(skel, '.config/fish'), { recursive: true });
  fs.mkdirSync(path.join(skel, '.config/uv'), { recursive: true });
  fs.writeFileSync(
    path.join(skel, '.local/share/claude/versions/9.9.9'),
    [
      '#!/bin/sh',
      'if [ "$1" = install ]; then',
      '  [ -n "$PD_TEST_CLAUDE_INSTALL_FAIL" ] && exit 1',
      '  mkdir -p "$HOME/.local/share/claude/versions" "$HOME/.local/bin"',
      '  printf "#!/bin/sh\\necho home claude\\n" > "$HOME/.local/share/claude/versions/10.0.0"',
      '  chmod +x "$HOME/.local/share/claude/versions/10.0.0"',
      '  ln -sfn "$HOME/.local/share/claude/versions/10.0.0" "$HOME/.local/bin/claude"',
      '  exit 0',
      'fi',
      'echo claude',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  fs.symlinkSync(
    path.join(skel, '.local/share/claude/versions/9.9.9'),
    path.join(skel, '.local/bin/claude'),
  );
  fs.writeFileSync(path.join(skel, '.local/bin/uv'), '#!/bin/sh\necho uv\n', { mode: 0o755 });
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
    // no uv in it.
    run();
    const uv = path.join(home, '.local/bin/uv');
    expect(fs.existsSync(uv)).toBe(true);
    expect(fs.readFileSync(uv, 'utf8')).toContain('echo uv');
  });

  it('links, never copies, the image-owned entries', () => {
    // A copy freezes at first boot and an image update would ship a tool no
    // container runs. Assert these are genuinely symlinks into the skeleton.
    run();
    for (const rel of ['.bashrc', '.zshrc', '.profile', '.bash_logout', '.local/bin/uv']) {
      const p = path.join(home, rel);
      expect(fs.lstatSync(p).isSymbolicLink(), `${rel} must be a symlink`).toBe(true);
      expect(fs.readlinkSync(p)).toBe(path.join(skel, rel));
    }
  });

  describe('Claude is a home-owned native install', () => {
    // The image's claude is a fallback. The one that runs is ~/.local/bin/claude
    // -> ~/.local/share/claude/versions/<v>, inside the mount, which `claude
    // update` (and the Happier app's update button) keeps current. Happier
    // attributes an install to Claude's updater only when the real path is
    // under ~/.local/share/claude; anything else shows as "Installed by you".
    const local = (rel) => path.join(home, '.local', rel);

    it('never links the image claude into the home', () => {
      run();
      for (const rel of ['bin/claude', 'share/claude']) {
        const p = local(rel);
        const linked = fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink() && fs.readlinkSync(p).startsWith(skel);
        expect(linked, `${rel} must not point into the skeleton`).toBe(false);
      }
    });

    it('bootstraps with the native installer when the home has no Claude', () => {
      const res = run({ PD_CLAUDE_NATIVE: '1' });
      expect(res.status).toBe(0);
      expect(fs.realpathSync(local('bin/claude'))).toBe(fs.realpathSync(local('share/claude/versions/10.0.0')));
      expect(res.stderr).toContain('installed Claude Code natively into the home');
    });

    it('does not reach the network when PD_CLAUDE_NATIVE=0', () => {
      const res = run();
      expect(fs.existsSync(local('bin/claude'))).toBe(false);
      expect(res.stderr).not.toContain('native Claude install');
    });

    it('boots, on the image fallback, when the native install fails', () => {
      const res = run({ PD_CLAUDE_NATIVE: '1', PD_TEST_CLAUDE_INSTALL_FAIL: '1' });
      expect(res.status).toBe(0);
      expect(res.stderr).toContain('native Claude install failed');
    });

    it('links the newest home version, with no installer, when the launcher is missing', () => {
      // The first boot after ~/.local/bin stopped being a link to the skeleton:
      // versions are in the mount but the launcher was in the image layer.
      fs.mkdirSync(local('share/claude/versions'), { recursive: true });
      for (const v of ['2.1.9', '2.1.10']) {
        fs.writeFileSync(local(`share/claude/versions/${v}`), `#!/bin/sh\necho ${v}\n`, { mode: 0o755 });
      }
      const res = run({ PD_CLAUDE_NATIVE: '1', PD_TEST_CLAUDE_INSTALL_FAIL: '1' });
      expect(fs.readlinkSync(local('bin/claude'))).toBe(local('share/claude/versions/2.1.10'));
      expect(res.stderr).toContain("linked ~/.local/bin/claude to the home's Claude 2.1.10");
    });

    it('leaves a working launcher alone', () => {
      fs.mkdirSync(local('share/claude/versions'), { recursive: true });
      fs.mkdirSync(local('bin'), { recursive: true });
      fs.writeFileSync(local('share/claude/versions/3.0.0'), '#!/bin/sh\n', { mode: 0o755 });
      fs.writeFileSync(local('share/claude/versions/4.0.0'), '#!/bin/sh\n', { mode: 0o755 });
      fs.symlinkSync(local('share/claude/versions/3.0.0'), local('bin/claude'));
      run({ PD_CLAUDE_NATIVE: '1' });
      expect(fs.readlinkSync(local('bin/claude'))).toBe(local('share/claude/versions/3.0.0'));
    });

    it('removes a RELATIVE link into the skeleton too', () => {
      fs.mkdirSync(local('bin'), { recursive: true });
      fs.symlinkSync(path.relative(local('bin'), path.join(skel, '.local/bin/claude')), local('bin/claude'));
      run({ PD_CLAUDE_NATIVE: '1' });
      expect(fs.realpathSync(local('bin/claude'))).toBe(fs.realpathSync(local('share/claude/versions/10.0.0')));
    });

    it('relinks a launcher that points anywhere but the home versions', () => {
      fs.mkdirSync(local('share/claude/versions'), { recursive: true });
      fs.mkdirSync(local('bin'), { recursive: true });
      fs.writeFileSync(local('share/claude/versions/5.0.0'), '#!/bin/sh\n', { mode: 0o755 });
      fs.symlinkSync('/nonexistent/claude', local('bin/claude'));
      run();
      expect(fs.readlinkSync(local('bin/claude'))).toBe(local('share/claude/versions/5.0.0'));
    });

    it('never picks a prerelease or a non-version name over a release', () => {
      fs.mkdirSync(local('share/claude/versions'), { recursive: true });
      for (const v of ['2.1.10', '2.1.10-rc.1', 'latest', '2.1.9']) {
        fs.writeFileSync(local(`share/claude/versions/${v}`), '#!/bin/sh\n', { mode: 0o755 });
      }
      run();
      expect(fs.readlinkSync(local('bin/claude'))).toBe(local('share/claude/versions/2.1.10'));
    });

    it('leaves a real file at the launcher path alone, and says so', () => {
      fs.mkdirSync(local('bin'), { recursive: true });
      fs.writeFileSync(local('bin/claude'), '#!/bin/sh\necho mine\n', { mode: 0o755 });
      const res = run({ PD_CLAUDE_NATIVE: '1' });
      expect(fs.readFileSync(local('bin/claude'), 'utf8')).toContain('echo mine');
      expect(res.stderr).toContain("is not Claude's native launcher; leaving it");
    });

    it('bounds the native installer so a stall cannot block the boot', () => {
      const stall = path.join(skel, '.local/share/claude/versions/9.9.9');
      fs.writeFileSync(stall, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
      const started = Date.now();
      const res = run({ PD_CLAUDE_NATIVE: '1', PD_CLAUDE_INSTALL_TIMEOUT: '1' });
      expect(res.status).toBe(0);
      expect(Date.now() - started).toBeLessThan(15000);
      expect(res.stderr).toContain('native Claude install failed');
    });

    it('warns when another claude earlier on PATH shadows the native launcher', () => {
      fs.mkdirSync(local('share/claude/versions'), { recursive: true });
      fs.writeFileSync(local('share/claude/versions/5.0.0'), '#!/bin/sh\n', { mode: 0o755 });
      const stray = path.join(tmproot, 'stray');
      fs.mkdirSync(stray);
      fs.writeFileSync(path.join(stray, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
      const res = run({ PATH: `${stray}:${local('bin')}:${process.env.PATH}` });
      expect(res.stderr).toContain(`claude on PATH is ${path.join(stray, 'claude')}, which shadows`);
    });

    it('says nothing about shadowing when the native launcher is first on PATH', () => {
      fs.mkdirSync(local('share/claude/versions'), { recursive: true });
      fs.writeFileSync(local('share/claude/versions/5.0.0'), '#!/bin/sh\n', { mode: 0o755 });
      const res = run({ PATH: `${local('bin')}:${process.env.PATH}` });
      expect(res.stderr).not.toContain('shadows the native');
    });

    it('replaces the old layout\'s links into the skeleton and keeps the home install', () => {
      // The live home before this change: ~/.local/bin and share/claude and
      // state/claude were links into the image.
      fs.mkdirSync(path.join(home, '.local/share'), { recursive: true });
      fs.mkdirSync(path.join(home, '.local/state'), { recursive: true });
      fs.mkdirSync(path.join(skel, '.local/state/claude'), { recursive: true });
      fs.symlinkSync(path.join(skel, '.local/bin'), local('bin'));
      fs.symlinkSync(path.join(skel, '.local/share/claude'), local('share/claude'));
      fs.symlinkSync(path.join(skel, '.local/state/claude'), local('state/claude'));
      run({ PD_CLAUDE_NATIVE: '1' });
      expect(fs.lstatSync(local('bin')).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(local('share/claude')).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(local('state/claude'))).toBe(false);
      expect(fs.realpathSync(local('bin/claude'))).toBe(fs.realpathSync(local('share/claude/versions/10.0.0')));
      // The skeleton fallback is untouched.
      expect(fs.existsSync(path.join(skel, '.local/share/claude/versions/9.9.9'))).toBe(true);
    });
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
    // (~/.local/bin/uv/uv) rather than replacing it, leaving uv off the path
    // with no error. This is the case that guard exists for.
    fs.mkdirSync(path.join(home, '.local/bin/uv/junk'), { recursive: true });
    run();
    expect(fs.readlinkSync(path.join(home, '.local/bin/uv'))).toBe(path.join(skel, '.local/bin/uv'));
    // Moved aside, never deleted: it could be somebody's data.
    const aside = fs.readdirSync(path.join(home, '.local/bin')).filter((n) => n.startsWith('uv.pre-image-'));
    expect(aside).toHaveLength(1);
    expect(fs.existsSync(path.join(home, '.local/bin', aside[0], 'junk'))).toBe(true);
  });

  it('is idempotent across repeated boots', () => {
    run(); run(); run();
    expect(fs.lstatSync(path.join(home, '.local')).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(home, '.local/bin')).isSymbolicLink()).toBe(false);
    expect(fs.readlinkSync(path.join(home, '.local/bin/uv'))).toBe(path.join(skel, '.local/bin/uv'));
    expect(fs.lstatSync(path.join(home, '.config')).isSymbolicLink()).toBe(false);
  });

  it('keeps a tool a session installed into ~/.local/bin across a re-seed', () => {
    // .local/bin used to be a link into the skeleton, so `uv tool install` and
    // every self-updating CLI wrote into the container layer and lost it.
    run();
    fs.writeFileSync(path.join(home, '.local/bin/mytool'), '#!/bin/sh\n', { mode: 0o755 });
    run();
    // In the home mount itself, not written through a link into the image.
    expect(fs.realpathSync(path.join(home, '.local/bin/mytool'))).toBe(path.join(fs.realpathSync(home), '.local/bin/mytool'));
    expect(fs.existsSync(path.join(skel, '.local/bin/mytool'))).toBe(false);
  });

  describe('~/.local is a real directory that keeps tool data', () => {
    // Before, ~/.local was ONE link into the image skeleton, so every tool's
    // XDG data lived in the container layer and died on recreate. These run
    // the real script; the source-level half is in homeMount.test.js.
    const local = (rel) => path.join(home, '.local', rel);

    it('is a real directory with only the image entries linked', () => {
      fs.mkdirSync(path.join(skel, '.local/state/othertool'), { recursive: true });
      run();
      expect(fs.lstatSync(path.join(home, '.local')).isSymbolicLink()).toBe(false);
      for (const d of ['bin', 'share', 'state']) {
        expect(fs.lstatSync(local(d)).isSymbolicLink(), `${d} must be real`).toBe(false);
      }
      expect(fs.readlinkSync(local('bin/uv'))).toBe(path.join(skel, '.local/bin/uv'));
      expect(fs.readlinkSync(local('state/othertool'))).toBe(path.join(skel, '.local/state/othertool'));
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
      expect(fs.existsSync(local('bin/uv'))).toBe(true);
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
      expect(fs.existsSync(local('bin/uv'))).toBe(true);
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
      fs.mkdirSync(path.join(skel, '.local/share/imagetool'), { recursive: true });
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
      expect(res.stderr).toContain('could not link ~/.local/share/imagetool');
      expect(fs.readFileSync(path.join(home, '.local-persist/share/opencode/opencode.db'), 'utf8')).toBe('history');
    });

    it('never overwrites existing data or an image link with a staged copy', () => {
      fs.mkdirSync(path.join(skel, '.local/share/imagetool'), { recursive: true });
      run();
      fs.mkdirSync(local('share/opencode'), { recursive: true });
      fs.writeFileSync(local('share/opencode/opencode.db'), 'current');
      fs.mkdirSync(path.join(home, '.local-persist/share/opencode'), { recursive: true });
      fs.writeFileSync(path.join(home, '.local-persist/share/opencode/opencode.db'), 'stale');
      fs.mkdirSync(path.join(home, '.local-persist/share/imagetool'), { recursive: true });
      const res = run();
      expect(res.status).toBe(0);
      expect(fs.readFileSync(local('share/opencode/opencode.db'), 'utf8')).toBe('current');
      expect(fs.readFileSync(path.join(home, '.local-persist/share/opencode/opencode.db'), 'utf8')).toBe('stale');
      expect(fs.lstatSync(local('share/imagetool')).isSymbolicLink()).toBe(true);
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

  it('restores a lost ~/bin/codex launcher for a standalone payload that survived', () => {
    const payload = path.join(home, '.codex/packages/standalone/current/bin');
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    const res = run();
    expect(fs.readlinkSync(path.join(home, 'bin/codex'))).toBe(path.join(payload, 'codex'));
    expect(res.stderr).toContain('restored the ~/bin/codex launcher');
  });

  it('never replaces a real ~/bin/codex file', () => {
    const payload = path.join(home, '.codex/packages/standalone/current/bin');
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    fs.mkdirSync(path.join(home, 'bin'));
    fs.writeFileSync(path.join(home, 'bin/codex'), 'mine', { mode: 0o644 });
    run();
    expect(fs.readFileSync(path.join(home, 'bin/codex'), 'utf8')).toBe('mine');
  });

  it('still boots when a state dir name is taken by a regular file', () => {
    fs.writeFileSync(path.join(home, 'bin'), 'not a dir');
    const res = run();
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('could not create one of');
  });

  it('still boots when a writable test file sits in an unwritable home', () => {
    if (process.getuid && process.getuid() === 0) return;
    fs.writeFileSync(path.join(home, '.pd-write-test'), '');
    fs.chmodSync(home, 0o555);
    try {
      expect(run().status).toBe(0);
    } finally {
      fs.chmodSync(home, 0o755);
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
