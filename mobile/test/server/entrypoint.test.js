import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Script-level properties of entrypoint.sh that hold regardless of the home
// layout. The single-home-mount invariants it also enforces are guarded in
// homeMount.test.js, next to the Dockerfile and template halves of that design.
//
// Nothing in the cat-based E2E suite exercises image runtime behaviour, so these
// are source-level assertions — same rationale as tmuxConf.test.js.
describe('entrypoint.sh', () => {
  const root = path.resolve(__dirname, '../../..');
  const file = path.join(root, 'entrypoint.sh');
  const script = fs.readFileSync(file, 'utf8');

  it('is a bash script and is executable — the Dockerfile ENTRYPOINTs it directly', () => {
    expect(script).toMatch(/^#!\/bin\/bash$/m);
    expect(fs.statSync(file).mode & 0o111).toBeTruthy();
  });

  it('sets a group-writable umask (002)', () => {
    // Regression guard: the container runs as claude:users (gid 100) and writes to
    // /coding, an SMB share whose mediauser account is also gid 100. With the default
    // 022 umask everything Claude creates is 0755/0644 and same-group SMB users can't
    // write into it. DO NOT drop this line — it re-breaks two-way SMB access silently.
    expect(script).toMatch(/^\s*umask\s+002\s*$/m);
  });

  it('sets umask before exec-ing the main command', () => {
    // umask only affects files created after it runs, so it must precede `exec "$@"`
    // (which hands off to server.js → tmux → every Claude bash command).
    const umaskIdx = script.search(/^\s*umask\s+002\s*$/m);
    const execIdx = script.search(/^\s*exec\s+"\$@"\s*$/m);
    expect(umaskIdx).toBeGreaterThanOrEqual(0);
    expect(execIdx).toBeGreaterThanOrEqual(0);
    expect(umaskIdx).toBeLessThan(execIdx);
  });

  it('ends by exec-ing its arguments, so the server is PID 1', () => {
    // start.sh → node needs to receive the SIGTERM docker sends, because the
    // clean-shutdown marker that gates auto-continue is written from its handler.
    // A non-exec'd child would be killed without ever writing it, and every
    // restored session would come back with the crash warning instead.
    expect(script).toMatch(/^\s*exec\s+"\$@"\s*$/m);
  });
});
