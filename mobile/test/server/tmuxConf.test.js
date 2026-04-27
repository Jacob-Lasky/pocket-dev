import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('mobile/tmux.conf', () => {
  const confPath = path.resolve(__dirname, '../../tmux.conf');
  const contents = fs.readFileSync(confPath, 'utf8');

  it('disables alternate-screen for inner apps', () => {
    expect(contents).toMatch(/^\s*setw\s+-g\s+alternate-screen\s+off\s*$/m);
  });

  it('disables alt-screen for the outer terminal via terminal-overrides smcup@/rmcup@', () => {
    // Without this, tmux enters \x1b[?1049h on attach and all visible
    // content lands in xterm.js's alt-buffer (invisible to our View renderer).
    expect(contents).toMatch(/^\s*set\s+-ga\s+terminal-overrides\s+',xterm\*:smcup@:rmcup@'\s*$/m);
  });

  it('enables focus-events', () => {
    expect(contents).toMatch(/^\s*set\s+-g\s+focus-events\s+on\s*$/m);
  });
});
