import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The `cdspo` / `cdsps` claude shortcuts are generated inside the Dockerfile via
// `RUN echo '...'` (same idiom as entrypoint.sh — see entrypoint.test.js). These
// tests parse those lines and lock in the load-bearing invariant: both shortcuts
// use a MOVING model alias (`opus` / `sonnet`), never a dated/pinned id.
//
// Why guard this: the shortcuts must track the newest model in each family
// automatically. A previous version pinned cdspo to `claude-opus-4-8[1m]`; a
// well-meaning edit to a (now-deleted) duplicate script drifted silently because
// nothing enforced the Dockerfile as the single source. This assertion is that
// enforcement — nothing in the cat-based E2E suite exercises the shortcuts.
describe('Dockerfile claude shortcuts (cdspo / cdsps)', () => {
  const dockerfile = fs.readFileSync(
    path.resolve(__dirname, '../../../Dockerfile'),
    'utf8',
  );

  // Grab the `exec claude ...` payload each shortcut writes to /usr/local/bin.
  const cdspoLine = dockerfile.match(
    /echo '(exec claude[^']*)' >> \/usr\/local\/bin\/cdspo/,
  );
  const cdspsLine = dockerfile.match(
    /echo '(exec claude[^']*)' >> \/usr\/local\/bin\/cdsps/,
  );

  it('generates both shortcuts', () => {
    expect(cdspoLine).not.toBeNull();
    expect(cdspsLine).not.toBeNull();
  });

  it('cdspo uses the moving opus[1m] alias, not a dated/pinned opus id', () => {
    // DO NOT re-pin to `claude-opus-X-Y[1m]` — that freezes the shortcut to an
    // aging model. `opus[1m]` resolves to the newest Opus (1M context) at launch.
    expect(cdspoLine[1]).toContain('--model "opus[1m]"');
    expect(cdspoLine[1]).not.toMatch(/claude-opus-\d/);
  });

  it('cdsps uses the moving sonnet alias, not a dated/pinned sonnet id', () => {
    // DO NOT re-pin to `claude-sonnet-N-M` — same reason as cdspo.
    expect(cdspsLine[1]).toContain('--model sonnet');
    expect(cdspsLine[1]).not.toMatch(/claude-sonnet-\d/);
  });
});
