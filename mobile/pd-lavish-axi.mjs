#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

// Lavish rejects wildcard binds. Recheck inherited IPs at invocation time:
// restored agent sessions can retain the previous container's bridge address.
export function resolveBindHost(requested, interfaces = networkInterfaces()) {
  const host = requested?.trim();
  const addresses = Object.values(interfaces).flat().filter(Boolean);
  if (host) {
    // Keep deliberate loopback, wildcard, hostname and assigned-interface pins.
    if (!isIP(host) || host === '0.0.0.0' || host === '::' || host.startsWith('127.') || host === '::1'
      || addresses.some(({ address }) => address === host)) return host;
  }
  const candidates = addresses.filter(({ family, internal }) => family === 'IPv4' && !internal);
  if (candidates.length > 1) {
    console.error(`pocket-dev: several Lavish IPv4 candidates; using ${candidates[0].address}. Set LAVISH_AXI_HOST to an assigned interface to choose another.`);
  }
  if (!candidates.length) {
    console.error('pocket-dev: no non-loopback IPv4 found; Lavish will only be reachable locally.');
  }
  return candidates[0]?.address;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = resolveBindHost(process.env.LAVISH_AXI_HOST);
  if (host) process.env.LAVISH_AXI_HOST = host;
  else delete process.env.LAVISH_AXI_HOST;
  // Import the installed package directly, avoiding recursion through our CLI
  // symlink. Its detached server inherits the refreshed environment.
  await import('/usr/local/lib/node_modules/lavish-axi/dist/cli.mjs');
}
