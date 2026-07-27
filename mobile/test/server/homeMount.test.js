import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// THE SINGLE-HOME-MOUNT INVARIANT, guarded across all three files that implement it.
//
// /home/claude used to hold image artifacts (the claude/uv binaries, shell rc
// files, fish and uv configs) AND every tool's state. That forced one bind mount
// per dotfile in the template and made mounting the home wholesale forbidden,
// because a mount over /home/claude masks .local/bin and leaves a container with
// no `claude` in it. Anything the mount list forgot — .aws, .kube, .fly — quietly
// evaporated on every image update.
//
// Now the image builds its home into /opt/pd-home and ships /home/claude EMPTY,
// so the whole home is one mount and state persists for tools nobody has thought
// of yet. entrypoint.sh links the image-owned entries back in at boot.
//
// Every failure mode here is quiet: a container that boots fine but has no
// `claude` on PATH, or a home that looks persistent right up until the next image
// update eats it. Nothing in the cat-based E2E suite can catch either, so these
// are source-level assertions — same rationale as tmuxConf.test.js.

const root = path.resolve(__dirname, '../../..');
const script = fs.readFileSync(path.join(root, 'entrypoint.sh'), 'utf8');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const template = fs.readFileSync(path.join(root, 'pocket-dev.xml'), 'utf8');

describe('Dockerfile: the image home is relocated out of the mount', () => {
  it('moves the image home to /opt/pd-home and leaves /home/claude empty', () => {
    // /home/claude is a bind mount at runtime. Anything the image puts there is
    // masked, so state dirs must NOT be created in the image — entrypoint.sh
    // creates them inside the mount instead.
    expect(dockerfile).toMatch(/mv \/home\/claude \/opt\/pd-home/);
    expect(dockerfile).toMatch(/mkdir -p \/home\/claude/);
    expect(dockerfile).not.toMatch(/mkdir -p .*\/home\/claude\/\.(claude|pocket-dev|dgvpn)/);
  });

  it('rewrites absolute symlinks into the relocated skeleton', () => {
    // The claude installer writes .local/bin/claude -> /home/claude/.local/share/
    // claude/versions/<v>, an ABSOLUTE path. Without this rewrite the link only
    // resolves once entrypoint.sh has linked ~/.local back — a circular dependency
    // where a failed seeding yields a container with no runnable Claude and no
    // obvious cause. DO NOT drop it and rely on ~/.local being linked.
    expect(dockerfile).toMatch(/readlink "\$link"/);
    expect(dockerfile).toMatch(/ln -sfn "\/opt\/pd-home\$\{target#\/home\/claude\}" "\$link"/);
  });

  it('puts the RELOCATED bin on PATH, not ~/.local/bin', () => {
    // Pointing PATH through $HOME would reintroduce the dependency on seeding
    // having succeeded. /opt/pd-home is self-contained after the rewrite above.
    const pathLine = dockerfile.match(/^ENV PATH="([^"]+)"/m);
    expect(pathLine).not.toBeNull();
    expect(pathLine[1]).toContain('/opt/pd-home/.local/bin');
    expect(pathLine[1]).not.toContain('/home/claude/.local/bin');
  });

  it('puts the session tool prefix inside the home mount', () => {
    // $HOME/bin persists by construction. It replaced /opt/pd, which existed only
    // because the home was not persistent — and which was never actually mounted
    // on the live container, so tools installed there vanished anyway.
    const pathLine = dockerfile.match(/^ENV PATH="([^"]+)"/m);
    expect(pathLine[1]).toContain('/home/claude/bin');
    expect(dockerfile).not.toMatch(/\/opt\/pd\/bin/);
  });

  it('copies entrypoint.sh from the repo instead of echoing it inline', () => {
    // It outgrew a `RUN echo '...\n\'` payload the moment it had a function in it.
    expect(dockerfile).toMatch(/COPY entrypoint\.sh \/usr\/local\/bin\/entrypoint\.sh/);
    expect(dockerfile).toMatch(/ENTRYPOINT \["\/usr\/local\/bin\/entrypoint\.sh"\]/);
    expect(dockerfile).not.toMatch(/RUN echo '#!\/bin\/bash\\n\\/);
  });
});

describe('entrypoint.sh: seeding the mounted home', () => {
  it('LINKS the image-owned entries rather than copying them', () => {
    // A copy is written once and never refreshed, so an image update would ship a
    // new `claude` that no container actually runs, and you would be debugging a
    // version that is not the one on disk. DO NOT switch these to cp.
    expect(script).toMatch(/ln -sfn "\$src" "\$dst"/);
    expect(script).not.toMatch(/^\s*cp\s+-[ar]/m);
  });

  it('replaces a real directory left at a link destination', () => {
    // `ln -s target dir` against a REAL directory creates the link INSIDE it
    // (~/.local/.local) instead of replacing it, which leaves `claude` off the
    // resolved path with no error anywhere. This guard is also what makes
    // re-seeding idempotent across restarts.
    expect(script).toMatch(/\[ -L "\$dst" \] \|\| rm -rf "\$dst"/);
  });

  it('links .local so the image binaries are reachable through $HOME', () => {
    expect(script).toMatch(/for entry in .*\.local(;|\s)/);
  });

  it('links only the image-owned leaves of .config, never .config itself', () => {
    // gh's auth token lives in .config/gh and MUST persist. Linking .config as a
    // whole would mask it and take the token back to vanishing on every update,
    // which is one of the exact bugs this design exists to end.
    expect(script).toMatch(/for entry in \.config\/fish \.config\/uv/);
    expect(script).toMatch(/mkdir -p "\$HOME\/\.config"/);
    const linkedTargets = [...script.matchAll(/for entry in ([^\n;]+)/g)]
      .flatMap((m) => m[1].trim().split(/\s+/));
    expect(linkedTargets).not.toContain('.config');
  });

  it('keeps caches OUT of the persisted home', () => {
    // The home mount lands on the UnRAID array over shfs FUSE. npm/uv caches are
    // large and write-heavy: wrong traffic for that filesystem and pure bloat in
    // appdata backups. They are relinked to a container-local path on purpose.
    expect(script).toMatch(/for entry in \.cache \.npm/);
  });

  it('takes both relocation paths from the Dockerfile, with matching fallbacks', () => {
    // The Dockerfile is the single definition; the script reads PD_SKEL_DIR and
    // PD_CACHE_DIR rather than repeating the literals. The fallbacks exist so the
    // script runs outside the image (entrypointSeed.test.js drives it that way),
    // and they are only safe while they agree with the image. If they drift, the
    // container and the tests are exercising two different layouts.
    for (const [envVar, shellVar] of [
      ['PD_SKEL_DIR', 'SKEL'],
      ['PD_CACHE_DIR', 'CACHE'],
    ]) {
      const fromDockerfile = dockerfile.match(new RegExp(`^ENV ${envVar}=(\\S+)`, 'm'));
      expect(fromDockerfile, `${envVar} must be set in the Dockerfile`).not.toBeNull();

      const fallback = script.match(
        new RegExp(`^${shellVar}="\\$\\{${envVar}:-([^}]+)\\}"`, 'm'),
      );
      expect(fallback, `${shellVar} must read ${envVar} with a fallback`).not.toBeNull();
      expect(fallback[1]).toBe(fromDockerfile[1]);
    }
  });

  it('relocates the image home to the path it exports as PD_SKEL_DIR', () => {
    // The `mv` target and the exported skeleton path are the same thing; if they
    // ever disagree the entrypoint links against a directory that does not exist
    // and every image-owned entry silently goes missing.
    const skel = dockerfile.match(/^ENV PD_SKEL_DIR=(\S+)/m)[1];
    expect(dockerfile).toContain(`mv /home/claude ${skel}`);
    expect(dockerfile.match(/^ENV PATH="([^"]+)"/m)[1]).toContain(`${skel}/.local/bin`);
  });

  it('degrades instead of refusing to boot on an unwritable home', () => {
    // Seeding must be skipped, not attempted, when the home cannot be written:
    // under `set -e` every failing mkdir/ln would abort the script and turn a
    // degraded boot into no boot at all. Executed coverage is in
    // entrypointSeed.test.js; this pins the structural guard that makes it work.
    expect(script).toMatch(/HOME_WRITABLE=0/);
    expect(script).toMatch(/if \[ "\$HOME_WRITABLE" = "1" \]; then/);
  });

  it('creates the state dirs the server and dgvpn expect', () => {
    // On a first boot the mounted home is empty and nothing else creates these.
    expect(script).toMatch(
      /mkdir -p "\$HOME\/\.claude" "\$HOME\/\.pocket-dev" "\$HOME\/\.dgvpn" "\$HOME\/bin"/,
    );
  });
});

describe('pocket-dev.xml: one home mount, not one per dotfile', () => {
  const targets = [...template.matchAll(/Target="([^"]+)"/g)].map((m) => m[1]);

  it('declares the whole home as a single mount', () => {
    expect(targets).toContain('/home/claude');
  });

  it('declares no per-dotfile mounts under the home', () => {
    // Every one of these is now covered by the single Home mount. Re-adding one
    // would shadow part of the home with a second host dir, which is how the two
    // diverge and how state starts landing in two places at once.
    const perDotfile = targets.filter(
      (t) => t.startsWith('/home/claude/') && t !== '/home/claude',
    );
    expect(perDotfile).toEqual([]);
  });

  it('does not declare the retired /opt/pd tool prefix', () => {
    expect(targets).not.toContain('/opt/pd');
  });

  it('keeps PD_STATE_DIR and DGVPN_DIR inside the home mount', () => {
    // Both default to paths under /home/claude in the Dockerfile. If either is
    // overridden to somewhere outside the mount, that state silently stops
    // surviving recreates while everything still looks fine.
    for (const env of ['PD_STATE_DIR', 'DGVPN_DIR']) {
      const m = dockerfile.match(new RegExp(`^ENV ${env}=(\\S+)`, 'm'));
      expect(m, `${env} must be set in the Dockerfile`).not.toBeNull();
      expect(m[1]).toMatch(/^\/home\/claude\//);
    }
    const dgvpnDir = template.match(/Target="DGVPN_DIR"[^>]*>([^<]*)</);
    if (dgvpnDir) expect(dgvpnDir[1]).toMatch(/^\/home\/claude\//);
  });
});
