import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// pd-trust-workspace rewrites a file that is a BIND MOUNT in production, and it
// is the difference between restore being hands-free and every restored tab
// waiting on a keypress. Neither property is reachable from the browser suite,
// so the script is run for real here against a temp HOME.

const SCRIPT = path.resolve(__dirname, '../../pd-trust-workspace');

let home, config;

function run(env = {}, args = []) {
  return spawnSync('bash', [SCRIPT, ...args], {
    env: { ...process.env, HOME: home, ...env },
    encoding: 'utf8',
  });
}

const read = () => JSON.parse(fs.readFileSync(config, 'utf8'));
const trustOf = (dir) => read().projects?.[dir]?.hasTrustDialogAccepted;

beforeEach(() => {
  home   = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-trust-'));
  config = path.join(home, '.claude.json');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('pd-trust-workspace', () => {
  it('is executable — start.sh invokes it by path', () => {
    expect(fs.statSync(SCRIPT).mode & 0o111).toBeTruthy();
  });

  it('accepts the trust dialog for the session directory', () => {
    fs.writeFileSync(config, JSON.stringify({ projects: { [home]: { hasTrustDialogAccepted: false } } }));
    run();
    expect(trustOf(home)).toBe(true);
  });

  it('adds the project entry when there is not one yet', () => {
    fs.writeFileSync(config, JSON.stringify({ projects: {} }));
    run();
    expect(trustOf(home)).toBe(true);
  });

  it('seeds a config when none exists at all', () => {
    run();
    expect(trustOf(home)).toBe(true);
  });

  it('takes an explicit directory', () => {
    fs.writeFileSync(config, JSON.stringify({ projects: {} }));
    run({}, ['/workspace']);
    expect(trustOf('/workspace')).toBe(true);
  });

  it('leaves every other key in the config alone', () => {
    fs.writeFileSync(config, JSON.stringify({
      numStartups: 7,
      projects: { [home]: { allowedTools: ['Bash'], hasCompletedProjectOnboarding: true } },
      mcpServers: { foo: { command: 'bar' } },
    }));
    run();
    const after = read();
    expect(after.numStartups).toBe(7);
    expect(after.mcpServers).toEqual({ foo: { command: 'bar' } });
    expect(after.projects[home].allowedTools).toEqual(['Bash']);
    expect(after.projects[home].hasCompletedProjectOnboarding).toBe(true);
    expect(after.projects[home].hasTrustDialogAccepted).toBe(true);
  });

  it('writes in place, preserving the inode', () => {
    // Originally a guard for a file-level bind mount at ~/.claude.json, where a
    // rename fails with EBUSY. That mount is gone (the whole home is one mount
    // now), but the assertion is kept: it is what makes re-introducing a
    // file-level mount at this path safe, and that failure is silent — the trust
    // flag just stops being set and every restored tab comes back on a prompt.
    // See the comment in pd-trust-workspace.
    fs.writeFileSync(config, JSON.stringify({ projects: {} }));
    const before = fs.statSync(config).ino;
    run();
    expect(fs.statSync(config).ino).toBe(before);
    expect(trustOf(home)).toBe(true);
  });

  it('refuses to rewrite a config it cannot parse', () => {
    // Better a trust prompt than a clobbered config.
    fs.writeFileSync(config, '{ this is not json');
    const res = run();
    expect(res.status).toBe(0);
    expect(fs.readFileSync(config, 'utf8')).toBe('{ this is not json');
  });

  it('does nothing when PD_TRUST_WORKSPACE=0', () => {
    fs.writeFileSync(config, JSON.stringify({ projects: { [home]: { hasTrustDialogAccepted: false } } }));
    run({ PD_TRUST_WORKSPACE: '0' });
    expect(trustOf(home)).toBe(false);
  });

  it('is idempotent', () => {
    run(); run(); run();
    expect(trustOf(home)).toBe(true);
    expect(Object.keys(read().projects)).toEqual([home]);
  });
});

describe('start.sh', () => {
  const startSh = fs.readFileSync(path.resolve(__dirname, '../../start.sh'), 'utf8');

  it('clears the trust gate BEFORE handing off to the server', () => {
    // After `exec node` nothing else in this script runs, and the first session
    // spawns immediately, so ordering here is the whole contract.
    const trustIdx = startSh.indexOf('pd-trust-workspace');
    const execIdx  = startSh.indexOf('exec node');
    expect(trustIdx).toBeGreaterThanOrEqual(0);
    expect(execIdx).toBeGreaterThanOrEqual(0);
    expect(trustIdx).toBeLessThan(execIdx);
  });

  it('does not let a trust failure stop the server from booting', () => {
    expect(startSh).toMatch(/pd-trust-workspace \|\| true/);
  });
});
