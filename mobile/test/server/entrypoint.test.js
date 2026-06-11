import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The runtime entrypoint is generated inside the Dockerfile via `RUN echo '...'`.
// These tests parse that payload the way Docker's /bin/sh (dash) renders it and
// assert the properties we depend on at runtime. Same approach as tmuxConf.test.js:
// guard a non-obvious, easy-to-silently-drop setting with a source-level assertion,
// because nothing in the cat-based E2E suite exercises image runtime behaviour.
describe('Dockerfile entrypoint.sh', () => {
  const dockerfile = fs.readFileSync(
    path.resolve(__dirname, '../../../Dockerfile'),
    'utf8',
  );

  // Pull out the single-quoted string that becomes /usr/local/bin/entrypoint.sh,
  // then undo the Dockerfile line-continuations and dash-echo \n escapes so we get
  // the actual rendered script text.
  const payload = dockerfile.match(
    /RUN echo '([\s\S]*?)' > \/usr\/local\/bin\/entrypoint\.sh/,
  );
  const rendered = payload[1]
    .replace(/\\\n/g, '') // strip backslash-newline line continuations
    .replace(/\\n/g, '\n'); // dash echo turns \n into real newlines

  it('embeds an entrypoint payload', () => {
    expect(payload).not.toBeNull();
    expect(rendered).toMatch(/^#!\/bin\/bash$/m);
  });

  it('sets a group-writable umask (002)', () => {
    // Regression guard: the container runs as claude:users (gid 100) and writes to
    // /coding, an SMB share whose mediauser account is also gid 100. With the default
    // 022 umask everything Claude creates is 0755/0644 and same-group SMB users can't
    // write into it. DO NOT drop this line — it re-breaks two-way SMB access silently
    // (no other test exercises image runtime perms).
    expect(rendered).toMatch(/^\s*umask\s+002\s*$/m);
  });

  it('sets umask before exec-ing the main command', () => {
    // umask only affects files created after it runs, so it must precede `exec "$@"`
    // (which hands off to server.js → tmux → every Claude bash command).
    const umaskIdx = rendered.search(/^\s*umask\s+002\s*$/m);
    const execIdx = rendered.search(/^\s*exec\s+"\$@"\s*$/m);
    expect(umaskIdx).toBeGreaterThanOrEqual(0);
    expect(execIdx).toBeGreaterThanOrEqual(0);
    expect(umaskIdx).toBeLessThan(execIdx);
  });
});
