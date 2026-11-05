import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveBindHost } from '../../pd-lavish-axi.mjs';

const interfaces = (address) => ({
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  eth0: [{ address, family: 'IPv4', internal: false }],
});

describe('Lavish invocation bind address', () => {
  it('repairs an inherited address after a container IP change', () => {
    const inherited = '172.17.0.17';
    expect(resolveBindHost(inherited, interfaces(inherited))).toBe(inherited);
    expect(resolveBindHost(inherited, interfaces('172.17.0.39'))).toBe('172.17.0.39');
    expect(resolveBindHost(inherited, interfaces('172.17.0.84'))).toBe('172.17.0.84');
  });

  it('resolves the interface when docker exec has no boot export', () => {
    expect(resolveBindHost(undefined, interfaces('172.17.0.39'))).toBe('172.17.0.39');
    expect(resolveBindHost('  ', interfaces('172.17.0.39'))).toBe('172.17.0.39');
  });

  it.each(['127.0.0.1', '::1', '0.0.0.0', '::', 'custom-host'])('preserves an explicit %s pin', (host) => {
    expect(resolveBindHost(host, interfaces('172.17.0.39'))).toBe(host);
  });

  it('keeps a selected assigned interface on a multi-network container', () => {
    const two = { ...interfaces('172.17.0.39'), other: [{ address: '10.9.0.2', family: 'IPv4', internal: false }] };
    expect(resolveBindHost('10.9.0.2', two)).toBe('10.9.0.2');
  });

  it('installs the launcher over the npm CLI symlink in the image', () => {
    const dockerfile = fs.readFileSync(path.resolve(__dirname, '../../../Dockerfile'), 'utf8');
    expect(dockerfile).toContain('ln -sfn /mobile/pd-lavish-axi.mjs /usr/local/bin/lavish-axi');
    expect(dockerfile).toContain('chmod +x /mobile/pd-lavish-axi.mjs');
  });
});
