import { describe, it, expect } from 'vitest';
import { buildTmuxSpawnArgs, TMUX_CONF_PATH } from '../../server.js';

describe('buildTmuxSpawnArgs', () => {
  it('sets PATH on the session rather than inheriting a pre-existing tmux server PATH', () => {
    const args = buildTmuxSpawnArgs('test', 'claude', { envSource: { PATH: '/tmp/stub-bin:/usr/bin' } });
    const i = args.indexOf('PATH=/tmp/stub-bin:/usr/bin');
    expect(i).toBeGreaterThan(0);
    expect(args[i - 1]).toBe('-e');
  });
  it('returns args that load mobile/tmux.conf via -f', () => {
    const args = buildTmuxSpawnArgs('main', "echo hi");
    const fIdx = args.indexOf('-f');
    expect(fIdx).toBeGreaterThanOrEqual(0);
    expect(args[fIdx + 1]).toBe(TMUX_CONF_PATH);
  });

  it('passes through session name and command', () => {
    const args = buildTmuxSpawnArgs('mysess', 'cmd-here');
    expect(args).toContain('-s');
    const sIdx = args.indexOf('-s');
    expect(args[sIdx + 1]).toBe('mysess');
    expect(args[args.length - 1]).toBe('cmd-here');
  });

  it('includes -u (UTF-8) and new-session -A (attach if exists)', () => {
    const args = buildTmuxSpawnArgs('main', 'cmd');
    expect(args).toContain('-u');
    expect(args).toContain('new-session');
    expect(args).toContain('-A');
  });
});
