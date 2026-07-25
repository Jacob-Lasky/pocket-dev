// Source-level guards for pnpm config that fails QUIETLY.
//
// Same rationale as tmuxConf.test.js: the real thing cannot be exercised from a
// unit test (this one needs a clean install against a cold store), and the
// failure mode is silence rather than an error, so the file itself is asserted.
//
// The measurement behind the allowBuilds guard, run against pnpm 11.17.0 with
// node-pty installed into three throwaway projects, each with its own store:
//
//   allowBuilds only            -> build/Release/pty.node BUILT
//   onlyBuiltDependencies only  -> ERR_PNPM_IGNORED_BUILDS, pty.node MISSING
//   neither (control)           -> ERR_PNPM_IGNORED_BUILDS, pty.node MISSING
//
// Both keys were present when the npm -> pnpm migration was first written, with
// the explanatory comment attached to the dead one. Anyone tidying the apparent
// duplicate would have kept the commented key and silently broken the build.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MOBILE = path.resolve(__dirname, '../..');
const workspace = fs.readFileSync(path.join(MOBILE, 'pnpm-workspace.yaml'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(MOBILE, 'package.json'), 'utf8'));

describe('pnpm-workspace.yaml', () => {
  it('grants node-pty and esbuild build permission via allowBuilds', () => {
    expect(workspace).toMatch(/^allowBuilds:/m);
    // node-pty is the one that actually breaks the server suites; esbuild is
    // vitest's bundler and fails less visibly.
    const allow = workspace.slice(workspace.indexOf('allowBuilds:'));
    expect(allow).toMatch(/^\s+node-pty:\s*true/m);
    expect(allow).toMatch(/^\s+esbuild:\s*true/m);
  });

  it('does NOT use onlyBuiltDependencies, which pnpm 11 ignores silently', () => {
    // Present as a comment (the explanation) is fine; present as a KEY is not.
    expect(workspace).not.toMatch(/^onlyBuiltDependencies:/m);
  });
});

describe('package.json', () => {
  it('pins the package manager, which corepack and CI both read', () => {
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it('carries no pnpm settings field, which pnpm 11 stopped reading', () => {
    expect(pkg.pnpm).toBeUndefined();
  });

  it('carries no npm-only allowScripts field', () => {
    // npm 12's approve-scripts equivalent. Dead once npm is gone, and a second
    // apparent source of truth for the same decision if left behind.
    expect(pkg.allowScripts).toBeUndefined();
  });
});
