import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-level guards for the bws (Bitwarden Secrets Manager) install. Same
// rationale as codex.test.js and lavish.test.js: CI never runs the image, and
// each way this breaks is quiet. A binary written under /home/claude is masked
// by the home mount, and an unpinned or unverified download installs whatever
// the release asset happens to be today.
describe('bws install', () => {
  const root = path.resolve(__dirname, '../../..');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  // The whole RUN block: a backslash continuation is one command over many lines.
  const block = (dockerfile.match(/^RUN curl (?:.*\\\n)*.*\/usr\/local\/bin\/bws(?:.*\\\n)*.*$/m) || [])[0];
  const arg = name => (dockerfile.match(new RegExp(`^ARG ${name}=(\\S+)$`, 'm')) || [])[1];

  it('installs bws into the image prefix, never into the home mount', () => {
    expect(block).toBeDefined();
    expect(block).toMatch(/install -m 0755 \S+ \/usr\/local\/bin\/bws/);
    expect(block).not.toMatch(/\/home\/claude|~\//);
  });

  it('pins the version and the asset digest, and verifies the digest', () => {
    expect(arg('BWS_VERSION')).toMatch(/^\d+\.\d+\.\d+$/);
    expect(arg('BWS_SHA256')).toMatch(/^[0-9a-f]{64}$/);
    expect(block).toContain('bws-v${BWS_VERSION}/bws-x86_64-unknown-linux-musl-${BWS_VERSION}.zip');
    expect(block).toMatch(/echo "\$\{BWS_SHA256\}  \/tmp\/bws\.zip" \| sha256sum -c -/);
    // The check must run before the binary is installed, or a bad asset ships.
    expect(block.indexOf('sha256sum -c')).toBeLessThan(block.indexOf('install -m'));
  });

  it('prints its version into the build log', () => {
    expect(block).toMatch(/&& bws --version\s*$/);
  });
});
