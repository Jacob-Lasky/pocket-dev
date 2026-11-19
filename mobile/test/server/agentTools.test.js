import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// The image-owned agent CLIs under /opt/agent-tools (OpenCode). Source-level
// guards: the install only exists as Dockerfile text and a lockfile. The
// Happier CLI shipped here too until WORK-689 (Tower retired Happier); the
// last test keeps it from coming back by accident.

const ROOT = path.resolve(__dirname, '../../..');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const TOOLS_PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent-tools/package.json'), 'utf8'));
const TOOLS_LOCK = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent-tools/package-lock.json'), 'utf8'));

describe('agent tools are pinned in exactly one place', () => {
  it('pins OpenCode to an exact version', () => {
    expect(TOOLS_PKG.dependencies['@opencode/cli']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('has a lockfile that resolved exactly those versions', () => {
    // A lockfile regenerated from a different package.json would install
    // whatever IT says; npm ci trusts the lock, not the manifest.
    expect(TOOLS_LOCK.packages[''].dependencies).toEqual(TOOLS_PKG.dependencies);
    for (const [name, version] of Object.entries(TOOLS_PKG.dependencies)) {
      expect(TOOLS_LOCK.packages[`node_modules/${name}`].version).toBe(version);
    }
  });

  it('never repeats a pinned version in the Dockerfile', () => {
    for (const version of Object.values(TOOLS_PKG.dependencies)) {
      expect(DOCKERFILE).not.toContain(version);
    }
  });

  it('allows exactly the install scripts the CLIs need', () => {
    expect(TOOLS_PKG.allowScripts).toEqual({ '@opencode/cli': true });
    // Every package in the lock that wants an install script is named, so a
    // bump that adds one fails here instead of silently skipping its build.
    const wanting = Object.entries(TOOLS_LOCK.packages)
      .filter(([, meta]) => meta.hasInstallScript)
      .map(([key]) => key.replace(/^.*node_modules\//, ''));
    expect(wanting.sort()).toEqual(Object.keys(TOOLS_PKG.allowScripts).sort());
  });

  it('ships no Happier CLI (retired, WORK-689)', () => {
    expect(Object.keys(TOOLS_LOCK.packages).filter((key) => key.includes('@happier-dev'))).toEqual([]);
    expect(DOCKERFILE).not.toMatch(/\.bin\/happier|happier --version|pd-happier-supervise/);
    expect(fs.existsSync(path.join(ROOT, 'mobile/pd-happier-supervise'))).toBe(false);
  });
});

describe('Dockerfile install', () => {
  it('installs from the lockfile with npm ci into /opt/agent-tools', () => {
    expect(DOCKERFILE).toMatch(/COPY agent-tools\/package\.json agent-tools\/package-lock\.json \/opt\/agent-tools\//);
    expect(DOCKERFILE).toMatch(/cd \/opt\/agent-tools \\\s*\n\s*&& npm ci /);
  });

  it('puts the binaries in /usr/local/bin, never under the home mount', () => {
    for (const bin of ['opencode', 'opencode2']) {
      expect(DOCKERFILE).toContain(`/opt/agent-tools/node_modules/.bin/${bin} /usr/local/bin/${bin}`);
    }
    expect(DOCKERFILE).not.toMatch(/\/home\/claude\/(bin|opt)\/opencode/);
  });

  it('records the version in the build log', () => {
    expect(DOCKERFILE).toMatch(/&& opencode --version/);
  });

  it('keeps the PID sandbox runner executable, as CI invokes it directly', () => {
    // core.fileMode is false on Tower's shfs, so a chmod there never reaches
    // the index; a CI checkout then gets 644 and exit 126.
    expect(fs.statSync(path.join(ROOT, 'mobile/test/pid-sandbox.sh')).mode & 0o111).not.toBe(0);
    // The index check needs a git checkout; pid-sandbox.sh runs the suites from a plain copy with no git,
    // where only the file mode above can be checked (CI's normal unit run still checks the index).
    const ls = spawnSync('git', ['ls-files', '-s', 'mobile/test/pid-sandbox.sh'], { cwd: ROOT, encoding: 'utf8' });
    if (ls.error || ls.status !== 0) return;
    expect(ls.stdout).toMatch(/^100755 /);
  });
});
