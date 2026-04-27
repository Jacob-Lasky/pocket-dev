import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('mobile/tmux.conf', () => {
  const confPath = path.resolve(__dirname, '../../tmux.conf');
  const contents = fs.readFileSync(confPath, 'utf8');

  it('disables alt-screen for the OUTER terminal via terminal-overrides smcup@/rmcup@', () => {
    // Stops tmux from switching xterm.js to alt-buffer on attach so the main
    // buffer accumulates scrollback that View mode can read.
    expect(contents).toMatch(/^\s*set\s+-ga\s+terminal-overrides\s+',xterm\*:smcup@:rmcup@'\s*$/m);
  });

  it('does NOT disable alt-screen for INNER apps (Claude Code needs it for its TUI)', () => {
    // Regression guard: an earlier version had `setw -g alternate-screen off`
    // which broke Claude's prompt input. CI's cat-based tests didn't catch it
    // because cat doesn't use alt-screen. This assertion locks in the fix.
    expect(contents).not.toMatch(/^\s*setw\s+-g\s+alternate-screen\s+off\s*$/m);
  });

  it('enables focus-events', () => {
    expect(contents).toMatch(/^\s*set\s+-g\s+focus-events\s+on\s*$/m);
  });
});
