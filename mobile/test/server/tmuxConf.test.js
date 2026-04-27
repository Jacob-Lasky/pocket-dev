import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('mobile/tmux.conf', () => {
  const confPath = path.resolve(__dirname, '../../tmux.conf');
  const contents = fs.readFileSync(confPath, 'utf8');

  it('disables alternate-screen', () => {
    expect(contents).toMatch(/^\s*setw\s+-g\s+alternate-screen\s+off\s*$/m);
  });

  it('enables focus-events', () => {
    expect(contents).toMatch(/^\s*set\s+-g\s+focus-events\s+on\s*$/m);
  });
});
